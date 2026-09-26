import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CLAUDE_CODE_CIPHER_SUITES,
  CLAUDE_CODE_CURVES,
  CLAUDE_CODE_EXTENSION_ORDER,
  CLAUDE_CODE_HEADER_WIRE_CASING,
  CLAUDE_CODE_HEADER_WIRE_ORDER,
  CLAUDE_CODE_JA3,
  CLAUDE_CODE_JA3_TOKEN,
  CLAUDE_CODE_POINT_FORMATS,
} from "../src/antidetect/claude-code-profile";
import {
  createClaudeCodeMimicFetch,
  isClaudeCodeMimicEnabled,
  shouldMimicClaudeCodeUpstream,
} from "../src/antidetect/index";
import type { OcxConfig } from "../src/types";

const cfg = (claudeCode?: OcxConfig["claudeCode"]) =>
  ({ claudeCode } as OcxConfig);

test("JA3 token segments stay in sync with the profile arrays", () => {
  const [version, ciphers, extensions, curves, pointFormats] = CLAUDE_CODE_JA3_TOKEN.split(",");
  expect(version).toBe("771");
  expect(ciphers).toBe(CLAUDE_CODE_CIPHER_SUITES.map((c) => String(c)).join("-"));
  expect(extensions).toBe(CLAUDE_CODE_EXTENSION_ORDER.map((e) => String(e)).join("-"));
  expect(curves).toBe(CLAUDE_CODE_CURVES.map((c) => String(c)).join("-"));
  expect(pointFormats).toBe(CLAUDE_CODE_POINT_FORMATS.map((p) => String(p)).join("-"));
});

test("profile has the expected shape (17 ciphers, 14 extensions, 3 curves)", () => {
  expect(CLAUDE_CODE_CIPHER_SUITES).toHaveLength(17);
  expect(CLAUDE_CODE_EXTENSION_ORDER).toHaveLength(14);
  expect(CLAUDE_CODE_CURVES).toHaveLength(3);
  // Cipher order is JA3-significant: TLS 1.3 suites first.
  expect(CLAUDE_CODE_CIPHER_SUITES.slice(0, 3)).toEqual([0x1301, 0x1302, 0x1303]);
});

test("md5 of the JA3 token equals the measured JA3 hash", () => {
  // Tripwire against accidental token edits: the whole point of the mimic
  // stack is emitting this exact ClientHello.
  const digest = createHash("md5").update(CLAUDE_CODE_JA3_TOKEN, "utf8").digest("hex");
  expect(digest).toBe(CLAUDE_CODE_JA3);
});

const bearerHeaders = () =>
  new Headers({ authorization: "Bearer sk-ant-oat01-secret", "content-type": "application/json" });

test("mimic applies to OAuth Bearer traffic on api.anthropic.com", () => {
  expect(
    shouldMimicClaudeCodeUpstream("https://api.anthropic.com/v1/messages", bearerHeaders(), cfg({})),
  ).toBe(true);
});

test("mimic is skipped for API-key traffic", () => {
  const headers = new Headers({ "x-api-key": "sk-ant-api03-secret" });
  expect(
    shouldMimicClaudeCodeUpstream("https://api.anthropic.com/v1/messages", headers, cfg({})),
  ).toBe(false);
});

test("mimic is skipped for custom base URLs", () => {
  expect(
    shouldMimicClaudeCodeUpstream("https://gateway.example.com/v1/messages", bearerHeaders(), cfg({})),
  ).toBe(false);
});

test("fingerprintMimic:false disables the stack", () => {
  const config = cfg({ fingerprintMimic: false });
  expect(isClaudeCodeMimicEnabled(config)).toBe(false);
  expect(
    shouldMimicClaudeCodeUpstream("https://api.anthropic.com/v1/messages", bearerHeaders(), config),
  ).toBe(false);
  expect(createClaudeCodeMimicFetch("https://api.anthropic.com/v1/messages", bearerHeaders(), config)).toBeNull();
});

test("mimic is enabled by default", () => {
  expect(isClaudeCodeMimicEnabled(cfg({}))).toBe(true);
  expect(isClaudeCodeMimicEnabled(cfg(undefined))).toBe(true);
});

test('string "false" also disables the stack (hand-edited JSON)', () => {
  const config = cfg({ fingerprintMimic: "false" } as unknown as OcxConfig["claudeCode"]);
  expect(isClaudeCodeMimicEnabled(config)).toBe(false);
});

test("wire header order matches the sub2api capture exactly", () => {
  // Sequence verbatim from sub2api's headerWireOrder (real Claude CLI packet
  // capture), with Host leading (Node writes it first; sub2api's Go server
  // parses it out of the header map so it is absent from their list).
  // Per-entry casing follows CLAUDE_CODE_HEADER_WIRE_CASING (the exact wire
  // casing from sub2api's headerWireCasing), not the order list's own
  // spelling -- order matching is case-insensitive on both sides, so e.g.
  // "Accept-Encoding" here vs lowercase "accept-encoding" in their list is
  // irrelevant to placement.
  expect(CLAUDE_CODE_HEADER_WIRE_ORDER).toEqual([
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
  ]);
});

test("every wire-order header has a casing-map entry that round-trips", () => {
  for (const wire of CLAUDE_CODE_HEADER_WIRE_ORDER) {
    const mapped = CLAUDE_CODE_HEADER_WIRE_CASING[wire.toLowerCase()];
    expect(mapped).toBe(wire);
  }
  // Spot-check the non-obvious casings from the capture: lowercase where Go
  // would canonicalize, Title-Case where the CLI really sends it.
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["x-app"]).toBe("x-app");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["anthropic-version"]).toBe("anthropic-version");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["authorization"]).toBe("authorization");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["x-stainless-os"]).toBe("X-Stainless-OS");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["x-stainless-helper-method"]).toBe("x-stainless-helper-method");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["x-claude-code-session-id"]).toBe("X-Claude-Code-Session-Id");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["content-length"]).toBe("content-length");
  expect(CLAUDE_CODE_HEADER_WIRE_CASING["user-agent"]).toBe("User-Agent");
});
