import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CLAUDE_CODE_CIPHER_SUITES,
  CLAUDE_CODE_CURVES,
  CLAUDE_CODE_EXTENSION_ORDER,
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
