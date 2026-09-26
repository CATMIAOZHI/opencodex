/**
 * Claude Code client fingerprint profile.
 *
 * TLS / header values below were measured from the official Claude Code CLI
 * (Node.js 24.x) and are mirrored from sub2api's `tlsfingerprint` and `claude`
 * packages (LGPL-3.0). Only measured values (numbers / strings) are copied
 * here — no sub2api code. Reference captures:
 *   JA3: 44f88fca027f27bab4bb08d4af15f23e
 *   JA4: t13d1714h1_5b57614c22b0_7baf387fc6ff
 *
 * These values rot: when Anthropic ships a new CLI / Node runtime the
 * ClientHello changes. If `User-Agent` is bumped, re-verify the whole profile
 * (see tests/antidetect-profile.test.ts which cross-checks the JA3 token
 * against the arrays below).
 */

/** Cipher suites in wire order — order is critical for JA3 matching. */
export const CLAUDE_CODE_CIPHER_SUITES: number[] = [
  // TLS 1.3
  0x1301, // TLS_AES_128_GCM_SHA256
  0x1302, // TLS_AES_256_GCM_SHA384
  0x1303, // TLS_CHACHA20_POLY1305_SHA256
  // ECDHE + AES-GCM
  0xc02b, // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
  0xc02f, // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
  0xc02c, // TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
  0xc030, // TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
  // ECDHE + ChaCha20-Poly1305
  0xcca9, // TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
  0xcca8, // TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
  // ECDHE + AES-CBC-SHA (legacy fallback)
  0xc009, // TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA
  0xc013, // TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA
  0xc00a, // TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA
  0xc014, // TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA
  // RSA + AES-GCM (non-PFS)
  0x009c, // TLS_RSA_WITH_AES_128_GCM_SHA256
  0x009d, // TLS_RSA_WITH_AES_256_GCM_SHA384
  // RSA + AES-CBC-SHA (non-PFS, legacy)
  0x002f, // TLS_RSA_WITH_AES_128_CBC_SHA
  0x0035, // TLS_RSA_WITH_AES_256_CBC_SHA
];

/** Supported groups (elliptic curves) in wire order. */
export const CLAUDE_CODE_CURVES: number[] = [
  29, // X25519
  23, // secp256r1
  24, // secp384r1
];

/** EC point formats. */
export const CLAUDE_CODE_POINT_FORMATS: number[] = [0]; // uncompressed

/** Signature algorithms in wire order. */
export const CLAUDE_CODE_SIGNATURE_ALGORITHMS: number[] = [
  0x0403, // ecdsa_secp256r1_sha256
  0x0804, // rsa_pss_rsae_sha256
  0x0401, // rsa_pkcs1_sha256
  0x0503, // ecdsa_secp384r1_sha384
  0x0805, // rsa_pss_rsae_sha384
  0x0501, // rsa_pkcs1_sha384
  0x0806, // rsa_pss_rsae_sha512
  0x0601, // rsa_pkcs1_sha512
  0x0201, // rsa_pkcs1_sha1
];

/**
 * TLS extension IDs in wire order (Node.js 24.x).
 * 65037 (0xfe0d) is encrypted_client_hello sent as GREASE — this is what
 * makes the captured JA3 end in ...7baf387fc6ff rather than a bare list.
 */
export const CLAUDE_CODE_EXTENSION_ORDER: number[] = [
  0,     // server_name
  65037, // encrypted_client_hello (GREASE)
  23,    // extended_master_secret
  65281, // renegotiation_info
  10,    // supported_groups
  11,    // ec_point_formats
  35,    // session_ticket
  16,    // alpn
  5,      // status_request (OCSP)
  13,    // signature_algorithms
  18,    // signed_certificate_timestamp
  51,    // key_share
  45,    // psk_key_exchange_modes
  43,    // supported_versions
];

/** ALPN protocols offered. */
export const CLAUDE_CODE_ALPN_PROTOCOLS: string[] = ["http/1.1"];

/** Reference hashes for the profile above (informational / monitoring). */
export const CLAUDE_CODE_JA3 = "44f88fca027f27bab4bb08d4af15f23e";
export const CLAUDE_CODE_JA4 = "t13d1714h1_5b57614c22b0_7baf387fc6ff";

/**
 * JA3 token for CycleTLS (`version,ciphers,extensions,curves,pointFormats`).
 * Built from the arrays above; tests/antidetect-profile.test.ts asserts the
 * segments stay in sync with them.
 */
export const CLAUDE_CODE_JA3_TOKEN =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49161-49171-49162-49172-156-157-47-53," +
  "0-65037-23-65281-10-11-35-16-5-13-18-51-45-43," +
  "29-23-24," +
  "0";

/**
 * User-Agent we claim on the mimic path. Aligned with sub2api's current
 * constants (CLICurrentVersion = "2.1.258"); the Stainless/Node tuple below
 * is aligned with sub2api's current constants too. These values are each
 * confirmed in sub2api's source, but there is no evidence the 2.1.81 header
 * capture and the 2.1.258 version constant came from the same capture --
 * treat them as separately-sourced alignment points, not one measured set.
 * (opencodex's quota probes in src/providers/quota.ts still use 2.1.63 --
 * bumping those is a separate, upstream-scoped decision.)
 */
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.258 (external, cli)";

/**
 * Exact wire order of request headers sent by the real Claude Code CLI,
 * captured from HTTPS traffic to api.anthropic.com and mirrored from
 * sub2api's `headerWireOrder` (backend/internal/service/header_util.go).
 * "Host" is not in sub2api's list (their Go server parses it into req.Host)
 * but Node's HTTP client writes it first on the wire, so it leads here.
 * Everything after Host follows the capture's sequence verbatim, including
 * the content-length / x-stainless-helper-method tail; per-entry casing
 * follows sub2api's headerWireCasing (e.g. "Accept-Encoding" here vs
 * lowercase "accept-encoding" in their order list -- order matching is
 * case-insensitive, so placement is unaffected).
 */
export const CLAUDE_CODE_HEADER_WIRE_ORDER: string[] = [
  "Host",
  "Accept",
  "X-Stainless-Retry-Count",
  "X-Stainless-Timeout",
  "X-Stainless-Lang",
  "X-Stainless-Package-Version",
  "X-Stainless-OS",
  "X-Stainless-Arch",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "authorization",
  "x-app",
  "User-Agent",
  "X-Claude-Code-Session-Id",
  "content-type",
  "anthropic-beta",
  "x-client-request-id",
  "accept-language",
  "sec-fetch-mode",
  "Accept-Encoding",
  "content-length",
  "x-stainless-helper-method",
];

/**
 * Exact wire casing per header name (lowercase key -> wire spelling),
 * mirrored from sub2api's `headerWireCasing` (same capture as above).
 * Note the mixed casing: X-Stainless-* and a few others are Title-Case,
 * while x-app / anthropic-* / authorization / content-type /
 * x-client-request-id / x-stainless-helper-method / accept-language /
 * sec-fetch-mode / content-length go out lowercase. Canonicalizing any of
 * these (as Go's Header.Set would) is itself a fingerprint signal, so the
 * transport applies this map and the sidecar assigns headers to the map
 * directly instead of via Header.Set.
 */
export const CLAUDE_CODE_HEADER_WIRE_CASING: Record<string, string> = {
  "host": "Host",
  "accept": "Accept",
  "x-stainless-retry-count": "X-Stainless-Retry-Count",
  "x-stainless-timeout": "X-Stainless-Timeout",
  "x-stainless-lang": "X-Stainless-Lang",
  "x-stainless-package-version": "X-Stainless-Package-Version",
  "x-stainless-os": "X-Stainless-OS",
  "x-stainless-arch": "X-Stainless-Arch",
  "x-stainless-runtime": "X-Stainless-Runtime",
  "x-stainless-runtime-version": "X-Stainless-Runtime-Version",
  "x-stainless-helper-method": "x-stainless-helper-method",
  "anthropic-dangerous-direct-browser-access": "anthropic-dangerous-direct-browser-access",
  "anthropic-version": "anthropic-version",
  "anthropic-beta": "anthropic-beta",
  "x-app": "x-app",
  "content-type": "content-type",
  "accept-language": "accept-language",
  "sec-fetch-mode": "sec-fetch-mode",
  "accept-encoding": "Accept-Encoding",
  "authorization": "authorization",
  "x-claude-code-session-id": "X-Claude-Code-Session-Id",
  "x-client-request-id": "x-client-request-id",
  "content-length": "content-length",
  "user-agent": "User-Agent",
};

/**
 * Default request headers of the real Claude Code CLI (measured). Forced onto
 * the wire on the OAuth mimic path regardless of what the inbound client sent —
 * a mismatched x-stainless-* / x-app / user-agent tuple is exactly what gets
 * flagged as third-party. Keys use the exact wire casing from the capture
 * (see CLAUDE_CODE_HEADER_WIRE_CASING); values mirror sub2api's
 * DefaultHeaders: js / 0.94.0 / Linux / arm64 / node / v24.3.0 / 0 / 600 /
 * cli / true.
 */
export function claudeCodeDefaultHeaders(): Record<string, string> {
  return {
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-OS": "Linux",
    "X-Stainless-Arch": "arm64",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v24.3.0",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": "600",
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Header names that identify the client fingerprint (force-set, never passthrough). */
export const CLAUDE_CODE_FINGERPRINT_HEADER_NAMES = [
  "user-agent",
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
  "x-client-request-id",
  "x-claude-code-session-id",
  "anthropic-dangerous-direct-browser-access",
  "accept",
] as const;

