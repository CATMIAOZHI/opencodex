import { expect, test } from "bun:test";
import {
  applyClaudeCodeMimicHeaders,
  setClaudeCodeSessionIdFromBody,
  stripClientFingerprintHeaders,
} from "../src/antidetect/mimic-headers";
import { CLAUDE_CODE_USER_AGENT } from "../src/antidetect/claude-code-profile";

test("mimic headers force the measured CLI identity", () => {
  const headers = new Headers({
    "user-agent": "something-else/1.0",
    "x-stainless-os": "Windows",
    authorization: "Bearer sk-ant-oat01-secret",
    "anthropic-beta": "my-beta",
  });
  applyClaudeCodeMimicHeaders(headers, { isStream: false });
  expect(headers.get("user-agent")).toBe(CLAUDE_CODE_USER_AGENT);
  expect(headers.get("x-stainless-lang")).toBe("js");
  expect(headers.get("x-stainless-runtime")).toBe("node");
  expect(headers.get("x-app")).toBe("cli");
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  expect(headers.get("anthropic-version")).toBe("2023-06-01");
  // Non-identity headers survive.
  expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-secret");
  expect(headers.get("anthropic-beta")).toBe("my-beta");
});

test("streaming requests get x-stainless-helper-method, non-streaming do not", () => {
  const stream = new Headers();
  applyClaudeCodeMimicHeaders(stream, { isStream: true });
  expect(stream.get("x-stainless-helper-method")).toBe("stream");

  const plain = new Headers();
  applyClaudeCodeMimicHeaders(plain, { isStream: false });
  expect(plain.get("x-stainless-helper-method")).toBeNull();
});

test("x-client-request-id is minted once and never overwritten", () => {
  const fresh = new Headers();
  applyClaudeCodeMimicHeaders(fresh, { isStream: false });
  const minted = fresh.get("x-client-request-id")!;
  // Hyphenated, matching sub2api's uuid.NewString() and repo convention.
  expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const existing = new Headers({ "x-client-request-id": "keepme" });
  applyClaudeCodeMimicHeaders(existing, { isStream: false });
  expect(existing.get("x-client-request-id")).toBe("keepme");
});

test("strip removes fingerprint headers but keeps auth and betas", () => {
  const headers = new Headers({
    "user-agent": "x",
    "x-stainless-os": "x",
    "x-claude-code-session-id": "x",
    accept: "x",
    authorization: "Bearer tok",
    "anthropic-beta": "b1",
    "content-type": "application/json",
  });
  stripClientFingerprintHeaders(headers);
  expect(headers.get("user-agent")).toBeNull();
  expect(headers.get("x-stainless-os")).toBeNull();
  expect(headers.get("x-claude-code-session-id")).toBeNull();
  expect(headers.get("accept")).toBeNull();
  expect(headers.get("authorization")).toBe("Bearer tok");
  expect(headers.get("anthropic-beta")).toBe("b1");
  expect(headers.get("content-type")).toBe("application/json");
});

test("session id is derived from the body even when the header was stripped", () => {
  // Pipeline order: stripClientFingerprintHeaders removes any stale value,
  // then the session is re-derived from metadata.user_id.
  const headers = new Headers({ "x-claude-code-session-id": "stale" });
  stripClientFingerprintHeaders(headers);
  expect(headers.get("x-claude-code-session-id")).toBeNull();
  setClaudeCodeSessionIdFromBody(headers, JSON.stringify({ metadata: { user_id: "sess-123:extra" } }));
  expect(headers.get("x-claude-code-session-id")).toBe("sess-123");
});

test("session id set is a no-op when the body carries none", () => {
  const noBody = new Headers();
  setClaudeCodeSessionIdFromBody(noBody, JSON.stringify({}));
  expect(noBody.get("x-claude-code-session-id")).toBeNull();

  const badJson = new Headers();
  setClaudeCodeSessionIdFromBody(badJson, "not json");
  expect(badJson.get("x-claude-code-session-id")).toBeNull();
});

test("full pipeline composition: strip -> apply -> session from body", () => {
  const headers = new Headers({
    "user-agent": "curl/8.0",
    "x-claude-code-session-id": "stale",
    authorization: "Bearer tok",
  });
  const body = JSON.stringify({ metadata: { user_id: "real-session:1" }, stream: false });
  stripClientFingerprintHeaders(headers);
  applyClaudeCodeMimicHeaders(headers, { isStream: false });
  setClaudeCodeSessionIdFromBody(headers, body);
  expect(headers.get("user-agent")).toBe(CLAUDE_CODE_USER_AGENT);
  expect(headers.get("x-claude-code-session-id")).toBe("real-session");
  expect(headers.get("authorization")).toBe("Bearer tok");
});
