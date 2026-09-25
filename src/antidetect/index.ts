/**
 * Public surface of the Claude Code anti-detection stack.
 *
 * Pipeline for one upstream request (OAuth subscription path only):
 *   1. normalizeDatelineBody — erase steganographic dateline variants
 *   2. stripClientFingerprintHeaders + applyClaudeCodeMimicHeaders — force the
 *      measured CLI identity headers, never passthrough the client's
 *   3. setClaudeCodeSessionIdFromBody — header/body session agreement
 *      (derived from the body; the strip in step 2 removes any stale value)
 *   4. fetchViaClaudeCodeMimic — TLS handshake with the copied ClientHello
 *      profile via the CycleTLS sidecar (fail-open to native fetch)
 *
 * Steps 1–3 are pure and always safe; step 4 degrades to native fetch when
 * the sidecar cannot start, so a fingerprint feature can never break the
 * request path.
 */
import type { OcxConfig } from "../types";
import { normalizeDatelineBody } from "./dateline";
import {
  applyClaudeCodeMimicHeaders,
  setClaudeCodeSessionIdFromBody,
  stripClientFingerprintHeaders,
} from "./mimic-headers";
import {
  MimicTransportUnavailableError,
  fetchViaClaudeCodeMimic,
} from "./cycletls-transport";

export { normalizeDatelineBody } from "./dateline";
export {
  applyClaudeCodeMimicHeaders,
  setClaudeCodeSessionIdFromBody,
  stripClientFingerprintHeaders,
} from "./mimic-headers";
export { MimicTransportUnavailableError } from "./cycletls-transport";

/** Kill switch: `claudeCode.fingerprintMimic: false` disables the whole stack. */
export function isClaudeCodeMimicEnabled(config: OcxConfig): boolean {
  // Config is JSON: tolerate the string form users hand-write as "false",
  // even though the type is boolean.
  const raw: unknown = config.claudeCode?.fingerprintMimic;
  return raw !== false && raw !== "false";
}

function isAnthropicDefaultHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function isOAuthBearer(headers: Headers): boolean {
  const auth = headers.get("authorization") ?? "";
  return /^Bearer\s+\S+/i.test(auth.trim());
}

/**
 * True when this upstream request should go through the mimic pipeline:
 * subscription-OAuth (Bearer) traffic to api.anthropic.com with the feature
 * enabled. API-key traffic (x-api-key) is meant for programmatic use and is
 * left on the native stack; custom enterprise base URLs are out of scope.
 */
export function shouldMimicClaudeCodeUpstream(
  url: string,
  headers: Headers,
  config: OcxConfig,
): boolean {
  return (
    isClaudeCodeMimicEnabled(config) &&
    isAnthropicDefaultHost(url) &&
    isOAuthBearer(headers)
  );
}

function isStreamBody(body: string): boolean {
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/** Wire order for the mimic headers; remaining headers follow afterwards. */
const MIMIC_HEADER_ORDER = [
  "host",
  "connection",
  "content-length",
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
  "x-stainless-timeout",
  "x-stainless-helper-method",
  "x-app",
  "anthropic-dangerous-direct-browser-access",
  "accept",
  "content-type",
  "x-client-request-id",
  "x-claude-code-session-id",
];

/**
 * The fetch-shaped function the mimic pipeline exposes. Deliberately NOT
 * `typeof fetch`: we don't implement the `preconnect` hint API, and claiming
 * the full type would be dishonest. Callers that need `typeof fetch` cast at
 * the boundary (see claude-messages.ts).
 */
export type MimicFetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Builds a fetch-compatible function implementing the mimic pipeline, or
 * returns null when the request should stay on the native stack.
 * The returned function fails open: TLS-mimic transport errors fall back to
 * native fetch with the already-normalized body and headers.
 */
export function createClaudeCodeMimicFetch(
  url: string,
  headers: Headers,
  config: OcxConfig,
): MimicFetchFn | null {
  if (!shouldMimicClaudeCodeUpstream(url, headers, config)) return null;

  const mimicFetch: MimicFetchFn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // 1. Dateline normalization on the final JSON body.
    let bodyString = typeof init.body === "string" ? init.body : "";
    if (bodyString) {
      const normalized = normalizeDatelineBody(bodyString);
      if (normalized.changed) bodyString = normalized.body;
    }
    const isStream = isStreamBody(bodyString);

    // 2–3. Header mimicry on a copy (never mutate the caller's Headers).
    const outHeaders = new Headers(init.headers);
    stripClientFingerprintHeaders(outHeaders);
    applyClaudeCodeMimicHeaders(outHeaders, { isStream });
    // The strip above removes any client-supplied session id; re-derive it
    // from the request body so header and body agree (the CLI binds them).
    if (bodyString) setClaudeCodeSessionIdFromBody(outHeaders, bodyString);

    const headerOrder = [
      ...MIMIC_HEADER_ORDER,
      ...[...outHeaders.keys()].filter((k) => !MIMIC_HEADER_ORDER.includes(k)),
    ];

    const mimicInit: RequestInit = { ...init, headers: outHeaders, body: bodyString || init.body };

    // 4. TLS-mimicked transport, fail-open to native fetch.
    try {
      return await fetchViaClaudeCodeMimic(target, mimicInit, {
        headerOrder,
        isStream,
        timeoutMs: config.connectTimeoutMs,
        sidecarPath: config.claudeCode?.mimicSidecarPath,
      });
    } catch (err) {
      if (err instanceof MimicTransportUnavailableError) {
        return fetch(target, mimicInit);
      }
      throw err;
    }
  };

  return mimicFetch;
}
