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
 * User-Agent we claim on the mimic path. Kept identical to the UA opencodex
 * already uses for Claude quota probes (src/providers/quota.ts) so the whole
 * stack tells one story. Bump together with the TLS profile when the real CLI
 * moves.
 */
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.63 (external, cli)";

/**
 * Default request headers of the real Claude Code CLI (measured). Forced onto
 * the wire on the OAuth mimic path regardless of what the inbound client sent —
 * a mismatched x-stainless-* / x-app / user-agent tuple is exactly what gets
 * flagged as third-party.
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
    "X-App": "cli",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
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

