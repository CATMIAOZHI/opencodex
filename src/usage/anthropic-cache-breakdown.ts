/**
 * Anthropic prompt-cache write split (5-minute vs 1-hour ephemeral TTL).
 *
 * Anthropic reports `usage.cache_creation_input_tokens` as the TOTAL cache-write count and, beside
 * it, `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` as the split.
 * The two TTLs are priced differently (5-minute writes bill at 1.25x base input, 1-hour writes at
 * 2x), so the split is the only way to bill a 1-hour write at its real rate. Without it every
 * write is repriced at the 5-minute rate and a `cacheRetention: "long"` deployment silently
 * under-reports spend.
 *
 * Deliberately import-free: three parse sites consume it — the anthropic adapter
 * (adapters/anthropic.ts), the inbound /v1/messages route (server/claude-messages.ts) and the
 * coding-agent protocol (adapters/coding-agent/protocol.ts) — and an adapter -> server import
 * would close a cycle.
 *
 * Fail closed to `undefined`. A partially trusted breakdown would reprice a whole row on numbers
 * we could not verify, so a malformed 5-minute sibling discards the block rather than keeping the
 * half that happens to parse. `undefined` means "no usable split" (the caller must then behave
 * exactly as it did before this field existed); a returned `0` means "the split is known and
 * carries no 1-hour tokens".
 */

type CountRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "value"; value: number };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): CountRead {
  if (value === undefined) return { kind: "absent" };
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { kind: "value", value };
  }
  return { kind: "invalid" };
}

/**
 * 1-hour cache-write tokens from an Anthropic-shaped usage object, or `undefined` when the
 * upstream usage carries no usable split.
 *
 * @param totalWriteTokens the caller's already-validated `cache_creation_input_tokens` total. The
 *   result never exceeds it: a breakdown claiming more 1-hour tokens than the row's own write
 *   total would double-charge, so it is clamped to the total the rest of the row is built from.
 */
export function anthropicCacheCreation1hTokens(
  usage: unknown,
  totalWriteTokens: number,
): number | undefined {
  if (!Number.isFinite(totalWriteTokens) || totalWriteTokens < 0) return undefined;
  if (!isPlainRecord(usage)) return undefined;
  const cacheCreation = usage.cache_creation;
  if (!isPlainRecord(cacheCreation)) return undefined;
  const oneHour = readCount(cacheCreation.ephemeral_1h_input_tokens);
  // Absent is "upstream told us nothing about TTLs"; invalid is "upstream told us something we
  // cannot trust". Both must leave the caller on its pre-existing path, so neither yields a value.
  if (oneHour.kind !== "value") return undefined;
  const fiveMinute = readCount(cacheCreation.ephemeral_5m_input_tokens);
  if (fiveMinute.kind === "invalid") return undefined;
  // A split that does not add up to the reported total is not a split we can bill against.
  if (fiveMinute.kind === "value" && fiveMinute.value + oneHour.value > totalWriteTokens) {
    return undefined;
  }
  return Math.min(oneHour.value, totalWriteTokens);
}
