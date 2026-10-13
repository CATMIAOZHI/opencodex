/**
 * Anthropic `juniper_tide` usage-limit reset — the 5-hour session window ONLY.
 *
 * Why this file exists next to `anthropic-reset-grants.ts`: that module owns the
 * `cedar_ember` program, whose grant clears the 5-hour window AND the weekly one
 * (see `ANTHROPIC_RESET_WINDOWS`). `juniper_tide` is a different upstream program
 * that clears `five_hour` only and is offered at most once per week, at the 5-hour
 * wall. Keeping the two programs in separate modules makes "cedar behaviour is
 * byte-identical to before" a property of the file list, not of a careful diff.
 *
 * Wire contract, read from two independent implementations (2026-10-13):
 *   oh-my-pi  packages/ai/src/usage/claude-reset.ts      (JUNIPER_PROGRAM, parseJuniperStatus)
 *   OmniRoute  open-sse/services/claudeLimitReset.ts      (CLAUDE_LIMIT_RESET_PROGRAM)
 *
 *   read:  GET  /api/oauth/usage?at_wall=1&skip_spend=1
 *          -> body.juniper_tide = { eligible, ineligible_reason, in_experiment,
 *                                   arm: "control"|"reset", available,
 *                                   next_available_at, weekly_resets_at, resets_per_week }
 *   claim: POST /api/organizations/{org}/reset_rate_limits
 *          body {"program":"juniper_tide"}   <- no grant_id / request_id
 *          -> { result: "reset"|"already_used"|"not_limited"|"ineligible"|"unavailable",
 *               next_available_at, weekly_resets_at }
 *
 * Three rules this module holds itself to:
 *
 * 1. `juniper_tide: null` (or an absent key) means "upstream did not evaluate this
 *    program for this request" — the plain `/usage` body leaves every promo program
 *    null. It is NEVER an error and never "no eligibility".
 * 2. The probe is an optional entitlement read bolted onto the cedar one, so a
 *    transport failure degrades to "cedar only" instead of failing the dashboard.
 *    A block that IS present but malformed fails closed: no offer is produced.
 * 3. Spendability is decided by the upstream's own `available` flag, never by a
 *    local re-derivation from the cedar `at_limit` bit. Those two are unrelated:
 *    unioning them would light up a cedar grant the server would refuse.
 */
import { CLAUDE_CLI_USER_AGENT } from "./claude-cli-identity";
import {
  ANTHROPIC_API_ORIGIN,
  ANTHROPIC_RESET_GRANT_REDEEM_TIMEOUT_MS,
  ANTHROPIC_RESET_RESULTS,
  ANTHROPIC_RESET_WINDOWS,
  AnthropicResetGrantError,
  AnthropicResetGrantUnknownOutcome,
  type AnthropicAccountRequestOptions,
  type AnthropicResetClaimAnswer,
  type AnthropicResetGrant,
  type AnthropicResetGrantStatus,
  type AnthropicResetUpstreamResult,
  type AnthropicResetWindow,
} from "./anthropic-reset-grants";

export const ANTHROPIC_JUNIPER_RESET_PROGRAM = "juniper_tide";
export const ANTHROPIC_JUNIPER_STATUS_PATH = "/api/oauth/usage?at_wall=1&skip_spend=1";
/**
 * Synthetic grant id offered to the dashboard. It is not an upstream grant id:
 * juniper has none. It satisfies `ANTHROPIC_RESET_GRANT_ID_RE`, which both the
 * management route and the GUI parser validate against.
 */
export const ANTHROPIC_JUNIPER_GRANT_ID = "juniper_tide";

/**
 * Shorter than the cedar read's own 12 s. The dashboard's read budget for this
 * route is 20 s and the two reads on the read path are serial, so a second 12 s
 * probe could time out the whole dashboard poll. A probe that misses this bound
 * reads as "no offer", which is the same answer as a program the account does
 * not have.
 */
const PROBE_TIMEOUT_MS = 5_000;
const ORGANIZATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM_VALUES = new Set(["control", "reset"]);

export interface AnthropicJuniperStatus {
  eligible: boolean;
  available: boolean;
  arm: "control" | "reset" | null;
  ineligibleReason: string | null;
  weeklyResetsAt: string | null;
}

/** The juniper block plus the 5-hour percentage that arrived in the same body. */
export interface AnthropicJuniperProbe {
  status: AnthropicJuniperStatus | null;
  fiveHourPercent: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined || value === null) return fallback;
  return typeof value === "boolean" ? value : undefined;
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/**
 * Same headers the cedar path sends (`accountHeaders` in
 * `anthropic-reset-grants.ts`), duplicated rather than exported so that module
 * stays untouched. Upstream gates the promo blocks on the CLI user-agent form;
 * `claude-code/<ver>` is answered with `surface` instead of the CLI surface.
 */
function accountHeaders(accessToken: string, json: boolean): Record<string, string> {
  return {
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
    "User-Agent": CLAUDE_CLI_USER_AGENT,
    "anthropic-beta": "oauth-2025-04-20",
    Authorization: `Bearer ${accessToken}`,
  };
}

function readSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Parses the `juniper_tide` block.
 *
 * `null` in, `null` out: the key is absent or null when upstream did not evaluate
 * the program, which is not an error. A block that is present but not shaped like
 * an answer throws `AnthropicResetGrantError("malformed")`, and every caller turns
 * that into "no offer" — never into "not eligible" and never into a claim.
 */
export function parseAnthropicJuniperStatus(block: unknown): AnthropicJuniperStatus | null {
  if (block === undefined || block === null) return null;
  if (!isRecord(block) || typeof block.eligible !== "boolean") {
    throw new AnthropicResetGrantError("malformed");
  }
  const rawArm = block.arm;
  if (rawArm !== undefined && rawArm !== null && !ARM_VALUES.has(String(rawArm))) {
    throw new AnthropicResetGrantError("malformed");
  }
  const available = optionalBoolean(block.available, false);
  const weeklyResetsAt = optionalTimestamp(block.weekly_resets_at);
  const reason = block.ineligible_reason;
  if (available === undefined || weeklyResetsAt === undefined
    || (reason !== undefined && reason !== null && typeof reason !== "string")) {
    throw new AnthropicResetGrantError("malformed");
  }
  return {
    eligible: block.eligible,
    available,
    arm: rawArm === "control" || rawArm === "reset" ? rawArm : null,
    ineligibleReason: typeof reason === "string" ? reason : null,
    weeklyResetsAt,
  };
}

function percentInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // The CLI DTO validates percentUsed as an int 0..100, so round and clamp here.
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Reads the at-wall usage body and extracts the juniper offer.
 *
 * Returns `null` when the probe itself could not be trusted (transport failure,
 * 4xx/5xx, unreadable body): the caller then keeps the cedar-only answer. A
 * successful read always returns a probe, whose `status` may be `null` (upstream
 * did not evaluate juniper) — see `parseAnthropicJuniperStatus`.
 */
export async function readAnthropicJuniperStatus(
  options: AnthropicAccountRequestOptions,
): Promise<AnthropicJuniperProbe | null> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.origin ?? ANTHROPIC_API_ORIGIN}${ANTHROPIC_JUNIPER_STATUS_PATH}`, {
      method: "GET",
      headers: accountHeaders(options.accessToken, false),
      signal: readSignal(options.signal, PROBE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  let status: AnthropicJuniperStatus | null;
  try {
    status = parseAnthropicJuniperStatus(body[ANTHROPIC_JUNIPER_RESET_PROGRAM]);
  } catch {
    // Fail closed: an unreadable block yields no offer, never a guess.
    status = null;
  }
  const fiveHour = body.five_hour;
  return {
    status,
    fiveHourPercent: isRecord(fiveHour) ? percentInteger(fiveHour.utilization) : null,
  };
}

/**
 * The grant row the dashboard would offer, or null when juniper has nothing to
 * spend right now.
 *
 * Spendability mirrors the upstream's own answer: `eligible` plus `available`.
 * oh-my-pi additionally requires `arm === "reset"`; we only refuse an explicit
 * `"control"` arm, because a live probe on this deployment returned `arm: null`
 * with `in_experiment: false`, and an unreported arm must not hide a genuinely
 * spendable offer. A wrong guess here cannot spend anything: the claim itself is
 * still gated by the upstream, which answers `not_limited` / `ineligible` without
 * consuming the weekly chance.
 *
 * `useRequiresLimit` is false on purpose: the 5-hour-wall condition is already
 * inside `available`, and the cedar-wide `atLimit` bit says nothing about juniper.
 */
export function juniperSpendableGrant(
  probe: AnthropicJuniperProbe | null | undefined,
): AnthropicResetGrant | null {
  const status = probe?.status;
  if (!status || !status.eligible || !status.available || status.arm === "control") return null;
  const percentUsed: Partial<Record<AnthropicResetWindow, number>> = {};
  if (probe?.fiveHourPercent !== null && probe?.fiveHourPercent !== undefined) {
    percentUsed.five_hour = probe.fiveHourPercent;
  }
  return {
    id: ANTHROPIC_JUNIPER_GRANT_ID,
    // Upstream sends no label for juniper; the dashboard renders `label || id`.
    label: "Claude 5-hour session reset",
    resetsTotal: 1,
    resetsLeft: 1,
    startsAt: null,
    endsAt: status.weeklyResetsAt,
    clears: ["five_hour"],
    paused: false,
    usableNow: true,
    useRequiresLimit: false,
    percentUsed,
  };
}

/**
 * The first cedar grant the management route's own gate would accept right now —
 * the predicate the GUI's `spendableGrant()` applies, minus its `journalAvailable`
 * term, which is unknown on this side and only ever hides buttons. Exported so the
 * read path skips the extra juniper probe whenever cedar already has an offer.
 *
 * The `eligible` term is load-bearing: the route applies the same wall bit to every
 * grant, so an ineligible cedar block that happens to carry a spendable-looking grant
 * offers the dashboard nothing. Skipping the probe on that shape would hide a juniper
 * offer the account really has.
 */
export function spendableAnthropicResetGrant(
  status: AnthropicResetGrantStatus,
): AnthropicResetGrant | undefined {
  if (!status.eligible) return undefined;
  return status.grants.find(grant => !grant.paused && grant.usableNow && grant.resetsLeft > 0
    && (!grant.useRequiresLimit || status.atLimit));
}

/**
 * Folds a juniper offer into the cedar status.
 *
 * Invariants, in order of importance:
 *   * `atLimit`, `weeklyResetsAt` and `cooldownUntil` keep the cedar value: the
 *     route and the GUI both apply `atLimit` to EVERY grant, so widening it here
 *     would make a cedar grant spendable that upstream has already refused.
 *   * `ineligibleReason` keeps the cedar value unless juniper alone is spendable,
 *     in which case it becomes null. Upstream reasons (`not_at_wall` among them)
 *     are not a subset of the CLI DTO's closed enum.
 *   * juniper is appended, so a spendable cedar grant stays first — that order is
 *     what the GUI's `spendableGrant()` and the CLI's `nextGrantId` both read.
 */
export function mergeAnthropicResetStatus(
  cedar: AnthropicResetGrantStatus,
  probe: AnthropicJuniperProbe | null | undefined,
): AnthropicResetGrantStatus {
  const grant = juniperSpendableGrant(probe);
  if (!grant) return cedar;
  const cedarSpendable = spendableAnthropicResetGrant(cedar);
  return {
    ...cedar,
    eligible: true,
    ineligibleReason: null,
    grants: [...cedar.grants, grant],
    nextGrantId: cedarSpendable ? cedar.nextGrantId : grant.id,
  };
}

/**
 * Files the juniper claim. Exactly one POST leaves this function, and its body
 * carries only `program` — there is no grant id and no request id to send.
 *
 * Terminal answers resolve. Anything that could mean "the claim may have run but
 * we cannot read the outcome" (transport error, timeout, 5xx, unreadable body,
 * unknown `result`) throws `AnthropicResetGrantUnknownOutcome`, which the route
 * reports as an unknown outcome instead of retrying: a second POST cannot be
 * de-duplicated upstream, and its only protection is the server's own once-a-week
 * budget answering `already_used`.
 */
export async function claimAnthropicJuniperReset(
  options: AnthropicAccountRequestOptions & { organizationUuid: string },
): Promise<AnthropicResetClaimAnswer> {
  if (!ORGANIZATION_UUID_RE.test(options.organizationUuid)) {
    throw new AnthropicResetGrantError("malformed");
  }
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const url = `${options.origin ?? ANTHROPIC_API_ORIGIN}`
    + `/api/organizations/${encodeURIComponent(options.organizationUuid)}/reset_rate_limits`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: accountHeaders(options.accessToken, true),
      body: JSON.stringify({ program: ANTHROPIC_JUNIPER_RESET_PROGRAM }),
      signal: readSignal(options.signal, ANTHROPIC_RESET_GRANT_REDEEM_TIMEOUT_MS),
    });
  } catch {
    throw new AnthropicResetGrantUnknownOutcome();
  }
  // Refusals that prove the claim did not run.
  if (response.status === 429) return { code: "rate_limited", resetsLeft: null, cleared: [] };
  if (response.status === 401 || response.status === 403) {
    return { code: "auth_error", resetsLeft: null, cleared: [] };
  }
  if (!response.ok) throw new AnthropicResetGrantUnknownOutcome();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AnthropicResetGrantUnknownOutcome();
  }
  if (!isRecord(body) || typeof body.result !== "string"
    || !(ANTHROPIC_RESET_RESULTS as readonly string[]).includes(body.result)) {
    throw new AnthropicResetGrantUnknownOutcome();
  }
  const code = body.result as AnthropicResetUpstreamResult;
  // juniper answers `reset` without a `cleared` list; a successful claim clears the
  // 5-hour window and nothing else, so say so rather than reporting an empty set.
  const cleared: AnthropicResetWindow[] = code === "reset"
    ? parseWindows(body.cleared) ?? ["five_hour"]
    : [];
  return { code, resetsLeft: code === "reset" ? 0 : null, cleared };
}

function parseWindows(value: unknown): AnthropicResetWindow[] | null {
  if (!Array.isArray(value)) return null;
  const windows = ANTHROPIC_RESET_WINDOWS.filter(window => value.includes(window));
  return windows.length > 0 ? windows : null;
}
