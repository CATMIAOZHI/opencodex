import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
/**
 * useAnthropicResetGrants — reads and spends Claude usage-limit reset grants for
 * Anthropic OAuth accounts through `GET /api/anthropic/reset-grants` and
 * `POST /api/anthropic/reset-grants/consume`.
 *
 * Same read discipline as useGrokResetCoupons: one read per account, at most
 * three in flight, a roster epoch plus a per-account token so one row's retry
 * never discards a sibling's read.
 *
 * Spend truth is the settled `code` in a 200 body, never the HTTP status alone.
 * Every answer that leaves the outcome open (transport failure, 502
 * `unknown_outcome`, 500 `journal_write_failed`, 409 `in_flight`) is reported as
 * `unknown` so the dialog keeps the operation id and can only retry that same id.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createBoundedFetch } from "../bounded-fetch";

export type AnthropicResetWindow = "five_hour" | "seven_day" | "seven_day_overage_included";

export interface AnthropicResetGrant {
  id: string;
  label: string;
  resetsTotal: number;
  resetsLeft: number;
  startsAt: string | null;
  endsAt: string | null;
  clears: AnthropicResetWindow[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  percentUsed: Partial<Record<AnthropicResetWindow, number>>;
}

export interface AnthropicPendingOperation {
  operationId: string;
  grantId: string;
  retryableUntil: number;
}

/**
 * Why the 5-hour-only (`juniper_tide`) program offered no ticket, straight from
 * upstream (`not_at_wall`, `tenure`, …). `null` in the snapshot means the probe
 * gave no answer at all, which is not the same as "not eligible".
 */
export interface AnthropicJuniperOffer {
  reason: string | null;
  fiveHourPercent: number | null;
}

export interface AnthropicResetGrantSnapshot {
  eligible: boolean;
  atLimit: boolean;
  grants: AnthropicResetGrant[];
  juniperOffer: AnthropicJuniperOffer | null;
  pendingOperation: AnthropicPendingOperation | null;
  journalAvailable: boolean;
}

export type AnthropicGrantEntry =
  | { status: "loading" }
  | { status: "ready"; snapshot: AnthropicResetGrantSnapshot }
  | { status: "error"; reason: "auth" | "upstream" };

export type AnthropicSpendOutcome =
  | { kind: "settled"; code: string; replayed: boolean; resetsLeft: number | null }
  | { kind: "unknown"; code: string }
  | { kind: "refused"; code: string };

export interface AnthropicResetGrantController {
  entries: Record<string, AnthropicGrantEntry>;
  /**
   * `silent` re-reads in place: no `loading` entry, and a transient failure (5xx,
   * dropped socket, abort) keeps the previous answer instead of replacing it with
   * an error. Definitive answers still replace it — 4xx codes, and a 2xx body this
   * client cannot read. The dialog's open-time re-read uses it so a hiccup cannot
   * clear a known-good snapshot or hide a server-held pending operation.
   */
  refresh: (accountId: string, options?: { silent?: boolean }) => Promise<void>;
  spend: (accountId: string, request: { grantId: string; operationId: string }) => Promise<AnthropicSpendOutcome>;
}

const READ_TIMEOUT_MS = 20_000;
/** Upstream claim bound (25 s) plus the profile and gate reads in front of it. */
const SPEND_TIMEOUT_MS = 60_000;
const MAX_READS_IN_FLIGHT = 3;
const NO_ENTRIES: Record<string, AnthropicGrantEntry> = {};
const WINDOWS: readonly AnthropicResetWindow[] = ["five_hour", "seven_day", "seven_day_overage_included"];
const UNKNOWN_CODES = new Set(["unknown_outcome", "journal_write_failed", "in_flight"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function parseGrant(value: unknown): AnthropicResetGrant | null {
  if (!isRecord(value)) return null;
  const { id, label, resetsTotal, resetsLeft, paused, usableNow, useRequiresLimit } = value;
  const startsAt = nullableString(value.startsAt);
  const endsAt = nullableString(value.endsAt);
  if (typeof id !== "string" || id === "" || typeof label !== "string"
    || typeof resetsTotal !== "number" || typeof resetsLeft !== "number"
    || typeof paused !== "boolean" || typeof usableNow !== "boolean" || typeof useRequiresLimit !== "boolean"
    || startsAt === undefined || endsAt === undefined || !Array.isArray(value.clears)) return null;
  const percentUsed: Partial<Record<AnthropicResetWindow, number>> = {};
  if (isRecord(value.percentUsed)) {
    for (const window of WINDOWS) {
      const percent = value.percentUsed[window];
      if (typeof percent === "number") percentUsed[window] = percent;
    }
  }
  return {
    id, label, resetsTotal, resetsLeft, startsAt, endsAt, paused, usableNow, useRequiresLimit, percentUsed,
    clears: WINDOWS.filter(window => (value.clears as unknown[]).includes(window)),
  };
}

/** One malformed grant rejects the snapshot: the dialog spends from this list. */
export function parseAnthropicGrantSnapshot(value: unknown): AnthropicResetGrantSnapshot | null {
  if (!isRecord(value) || typeof value.eligible !== "boolean" || !Array.isArray(value.grants)) return null;
  const grants: AnthropicResetGrant[] = [];
  for (const raw of value.grants) {
    const grant = parseGrant(raw);
    if (!grant) return null;
    grants.push(grant);
  }
  let pendingOperation: AnthropicPendingOperation | null = null;
  const pending = value.pendingOperation;
  if (isRecord(pending) && typeof pending.operationId === "string" && typeof pending.grantId === "string"
    && typeof pending.retryableUntil === "number") {
    pendingOperation = { operationId: pending.operationId, grantId: pending.grantId, retryableUntil: pending.retryableUntil };
  }
  // Optional: a proxy that predates the field simply offers no explanation.
  let juniperOffer: AnthropicJuniperOffer | null = null;
  if (isRecord(value.juniperOffer)) {
    const percent = value.juniperOffer.fiveHourPercent;
    juniperOffer = {
      reason: typeof value.juniperOffer.reason === "string" ? value.juniperOffer.reason : null,
      fiveHourPercent: typeof percent === "number" && Number.isFinite(percent) ? percent : null,
    };
  }
  return {
    eligible: value.eligible,
    atLimit: value.atLimit === true,
    grants,
    juniperOffer,
    pendingOperation,
    journalAvailable: value.journalAvailable !== false,
  };
}

/** Resets still unspent across grants; what the badge counts. */
export function unspentResets(snapshot: AnthropicResetGrantSnapshot): number {
  if (!snapshot.eligible) return 0;
  return snapshot.grants.reduce((total, grant) => total + grant.resetsLeft, 0);
}

/** The grant a spend would use: the first one the server's gate would accept now. */
export function spendableGrant(snapshot: AnthropicResetGrantSnapshot): AnthropicResetGrant | undefined {
  if (!snapshot.eligible || !snapshot.journalAvailable) return undefined;
  return snapshot.grants.find(grant => !grant.paused && grant.usableNow && grant.resetsLeft > 0
    && (!grant.useRequiresLimit || snapshot.atLimit));
}

function errorCode(value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" && value.error.code !== "") {
    return value.error.code;
  }
  return "failed";
}

export function useAnthropicResetGrants({ apiBase, provider = "anthropic", accountIds, enabled }: {
  apiBase: string;
  provider?: AnthropicInstanceId;
  accountIds: string[];
  enabled: boolean;
}): AnthropicResetGrantController {
  const namespace = `${apiBase}\0${provider}`;
  // Entries are stored with the pool namespace that produced them. A render for another
  // namespace treats them as absent, so equal account IDs in A and B never share a row.
  const [store, setStore] = useState<{ namespace: string; entries: Record<string, AnthropicGrantEntry> }>(
    () => ({ namespace, entries: {} }),
  );
  const epoch = useRef(0);
  const tokens = useRef(new Map<string, number>());
  /** Per-account start order of reads, and the order that last wrote the store. */
  const readSeq = useRef(new Map<string, number>());
  const appliedSeq = useRef(new Map<string, number>());
  const gate = useRef<{ active: number; waiting: Array<() => void> }>({ active: 0, waiting: [] });
  const identity = accountIds.join("\u0000");
  useLayoutEffect(() => {
    epoch.current += 1;
    tokens.current.clear();
    readSeq.current.clear();
    appliedSeq.current.clear();
    // A stalled read from the previous pool must not occupy this pool's read slots. Reads
    // already running settle against the queue they captured; queued ones are released and
    // return at their epoch check without sending.
    const previous = gate.current;
    gate.current = { active: 0, waiting: [] };
    for (const release of previous.waiting.splice(0)) release();
    return () => { epoch.current += 1; };
  }, [namespace]);

  const setEntry = useCallback((accountId: string, entry: AnthropicGrantEntry) => {
    setStore(current => ({
      namespace,
      entries: { ...(current.namespace === namespace ? current.entries : {}), [accountId]: entry },
    }));
  }, [namespace]);

  const read = useCallback(async (accountId: string, rosterEpoch: number, keepOnFailure = false) => {
    if (epoch.current !== rosterEpoch) return;
    // A silent read joins the account's current generation instead of minting one:
    // an earlier read still in flight (the post-spend re-read, say) may carry the
    // answer this one is about to miss, and a failed silent read must not discard it.
    const previous = tokens.current.get(accountId);
    const token = keepOnFailure && previous !== undefined ? previous : (previous ?? 0) + 1;
    if (token !== previous) tokens.current.set(accountId, token);
    const startSeq = (readSeq.current.get(accountId) ?? 0) + 1;
    readSeq.current.set(accountId, startSeq);
    const queue = gate.current;
    if (queue.active >= MAX_READS_IN_FLIGHT) {
      await new Promise<void>(resolve => queue.waiting.push(resolve));
    }
    queue.active += 1;
    const current = () => epoch.current === rosterEpoch && tokens.current.get(accountId) === token;
    /**
     * Answers land in start order, not arrival order. A slower older read must not
     * overwrite a newer one, and a failed silent read must not suppress an older
     * read that is about to succeed — so only an answer started after the last
     * applied one may write.
     */
    const apply = (entry: AnthropicGrantEntry) => {
      if (startSeq < (appliedSeq.current.get(accountId) ?? 0)) return;
      appliedSeq.current.set(accountId, startSeq);
      setEntry(accountId, entry);
    };
    const bounded = createBoundedFetch(READ_TIMEOUT_MS);
    try {
      if (!current()) return;
      const response = await fetch(
        `${apiBase}/api/anthropic/reset-grants?accountId=${encodeURIComponent(accountId)}${provider === "anthropic" ? "" : `&provider=${encodeURIComponent(provider)}`}`,
        { signal: bounded.signal },
      );
      let raw: unknown = null;
      let bodyFailed = false;
      try {
        raw = await response.json();
      } catch {
        bodyFailed = true;
      }
      const ownsResponse = response.ok && !bodyFailed && isRecord(raw)
        && (raw.provider === provider || (provider === "anthropic" && raw.provider === undefined));
      const snapshot = ownsResponse ? parseAnthropicGrantSnapshot(raw) : null;
      if (!current()) return;
      if (snapshot) { apply({ status: "ready", snapshot }); return; }
      // A 4xx is the management API answering (bad account, auth, bad request), and a
      // 2xx we cannot read is an answer we cannot use: keeping an older ticket over
      // either would show a reset the server no longer offers. Only 5xx, transport
      // failures and an abort (including our own body-read deadline) are transient.
      const definitive = !bounded.signal.aborted && (response.ok || response.status < 500);
      const auth = definitive && errorCode(raw) === "auth_failed";
      if (definitive || !keepOnFailure) apply({ status: "error", reason: auth ? "auth" : "upstream" });
    } catch {
      if (!current()) return;
      if (!keepOnFailure) apply({ status: "error", reason: "upstream" });
    } finally {
      bounded.clear();
      queue.active -= 1;
      queue.waiting.shift()?.();
    }
  }, [apiBase, provider, setEntry]);

  useEffect(() => {
    if (!enabled || identity === "") return;
    const rosterEpoch = ++epoch.current;
    void Promise.resolve().then(() => {
      for (const accountId of identity.split("\u0000")) void read(accountId, rosterEpoch);
    });
    return () => { epoch.current += 1; };
  }, [enabled, identity, read]);

  const refresh = useCallback(async (accountId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) setEntry(accountId, { status: "loading" });
    await read(accountId, epoch.current, silent);
  }, [read, setEntry]);

  const spend = useCallback(async (
    accountId: string,
    request: { grantId: string; operationId: string },
  ): Promise<AnthropicSpendOutcome> => {
    const spendEpoch = epoch.current;
    const bounded = createBoundedFetch(SPEND_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/api/anthropic/reset-grants/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(provider === "anthropic" ? {} : { provider }), accountId, grantId: request.grantId, operationId: request.operationId }),
        signal: bounded.signal,
      });
      if (!response.ok) {
        const code = errorCode(await response.json().catch(() => null));
        return UNKNOWN_CODES.has(code) ? { kind: "unknown", code } : { kind: "refused", code };
      }
      const data = await response.json().catch(() => null) as unknown;
      if (!isRecord(data) || typeof data.code !== "string"
        || (data.provider !== provider && !(provider === "anthropic" && data.provider === undefined))) return { kind: "unknown", code: "unknown_outcome" };
      if (spendEpoch === epoch.current) void read(accountId, spendEpoch);
      return {
        kind: "settled",
        code: data.code,
        replayed: data.replayed === true,
        resetsLeft: typeof data.resetsLeft === "number" ? data.resetsLeft : null,
      };
    } catch {
      // Delivery may have happened: the caller keeps the id and may only retry it.
      return { kind: "unknown", code: "aborted" };
    } finally {
      bounded.clear();
    }
  }, [apiBase, provider, read]);

  return { entries: store.namespace === namespace ? store.entries : NO_ENTRIES, refresh, spend };
}
