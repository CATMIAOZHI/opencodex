/**
 * Claude Code CLI header mimicry for the OAuth upstream path.
 *
 * Mirrors sub2api's applyClaudeCodeMimicHeaders / applyClaudeOAuthHeaderDefaults
 * strategy (LGPL-3.0): on the subscription-OAuth path the gateway must NOT
 * passthrough arbitrary client headers — an inconsistent x-stainless-* /
 * user-agent / x-claude-code-session-id tuple is what gets judged
 * third-party. Instead the CLI fingerprint headers are force-set to the
 * measured values in ./claude-code-profile.ts.
 *
 * Deliberate deviation from sub2api: the caller's anthropic-beta is left
 * verbatim (opencodex's passthrough philosophy). Only identity headers are
 * force-set; feature betas stay the client's own.
 */
import {
  CLAUDE_CODE_FINGERPRINT_HEADER_NAMES,
  claudeCodeDefaultHeaders,
} from "./claude-code-profile";

export const ANTHROPIC_VERSION = "2023-06-01";

function randomRequestId(): string {
  // crypto.randomUUID is available in Bun and modern Node.
  return crypto.randomUUID().replace(/-/g, "");
}

export interface MimicHeaderOptions {
  /** true for streaming (SSE) requests. */
  isStream: boolean;
}

/**
 * Removes client-supplied fingerprint identity headers so the mimic set below
 * cannot conflict with them. Non-identity headers (incl. anthropic-beta,
 * authorization) are preserved.
 */
export function stripClientFingerprintHeaders(headers: Headers): void {
  for (const name of CLAUDE_CODE_FINGERPRINT_HEADER_NAMES) {
    headers.delete(name);
  }
}

/**
 * Force-applies the measured Claude Code CLI fingerprint headers.
 * The real CLI sends Accept: application/json even for streaming, emits
 * x-stainless-helper-method: stream on streams, and mints a fresh UUID per
 * request for x-client-request-id (missing or duplicated values feed the
 * third-party classifier).
 */
export function applyClaudeCodeMimicHeaders(headers: Headers, opts: MimicHeaderOptions): void {
  const defaults = claudeCodeDefaultHeaders();
  for (const [name, value] of Object.entries(defaults)) {
    headers.set(name, value);
  }
  // Real Claude CLI uses Accept: application/json even for streaming.
  headers.set("Accept", "application/json");
  if (opts.isStream) {
    headers.set("x-stainless-helper-method", "stream");
  }
  if (!headers.get("x-client-request-id")) {
    headers.set("x-client-request-id", randomRequestId());
  }
  if (!headers.get("anthropic-version")) {
    headers.set("anthropic-version", ANTHROPIC_VERSION);
  }
  if (!headers.get("content-type")) {
    headers.set("content-type", "application/json");
  }
}

/**
 * Syncs X-Claude-Code-Session-Id with the session id carried in the request
 * body's metadata.user_id (format "<session_id>:..."), mirroring the real
 * CLI where header and body always agree. No-op when either side is absent.
 */
export function syncClaudeCodeSessionId(headers: Headers, bodyJson: string): void {
  if (!headers.get("x-claude-code-session-id")) return;
  let sessionId = "";
  try {
    const parsed = JSON.parse(bodyJson) as { metadata?: { user_id?: unknown } };
    const userId = parsed?.metadata?.user_id;
    if (typeof userId === "string") {
      const idx = userId.indexOf(":");
      sessionId = idx >= 0 ? userId.slice(0, idx) : userId;
    }
  } catch {
    return;
  }
  if (sessionId) headers.set("x-claude-code-session-id", sessionId);
}
