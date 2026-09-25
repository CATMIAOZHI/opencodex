import { afterEach, expect, test } from "bun:test";
import {
  MimicTransportUnavailableError,
  fetchViaClaudeCodeMimic,
  setMimicTransportClientForTests,
} from "../src/antidetect/cycletls-transport";
import { CLAUDE_CODE_JA3_TOKEN } from "../src/antidetect/claude-code-profile";
import { createClaudeCodeMimicFetch } from "../src/antidetect/index";
import type { OcxConfig } from "../src/types";

afterEach(() => {
  setMimicTransportClientForTests(undefined);
});

type CapturedCall = { url: string; options: Record<string, unknown>; method?: string };

function fakeClient(respond: (call: CapturedCall) => unknown) {
  const calls: CapturedCall[] = [];
  setMimicTransportClientForTests(async (url, options, method) => {
    const call = { url, options, method };
    calls.push(call);
    return respond(call) as { status: number; headers: Record<string, unknown>; data: unknown };
  });
  return calls;
}

function fakeStream(chunks: string[]) {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      if (event === "data") {
        queueMicrotask(() => {
          for (const c of chunks) for (const cb of handlers.get("data") ?? []) cb(c);
          for (const cb of handlers.get("end") ?? []) cb();
        });
      }
      return this;
    },
  };
}

const SYNTHETIC = "Request returned a Syscall Error: Get \"https://api.anthropic.com\": uTlsConn.Handshake() error: tls: first record does not look like a TLS handshake";

test("synthetic transport errors throw MimicTransportUnavailableError (fail-open)", async () => {
  fakeClient(() => ({ status: 495, headers: {}, data: SYNTHETIC }));
  await expect(
    fetchViaClaudeCodeMimic("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
  ).rejects.toBeInstanceOf(MimicTransportUnavailableError);
});

test("stream responses bridge to a web Response", async () => {
  fakeClient(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    data: fakeStream(["data: hello\n\n"]),
  }));
  const res = await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    { method: "POST", body: "{}" },
    { isStream: true },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toBe("data: hello\n\n");
});

test("non-stream responses are buffered and surfaced as text", async () => {
  const calls = fakeClient(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ id: "msg_1" }),
  }));
  const res = await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    { method: "POST", body: "{}" },
    { isStream: false },
  );
  expect(calls[0].options["responseType"]).toBe("text");
  expect(await res.json()).toEqual({ id: "msg_1" });
});

test("transport pins the JA3 profile options (no GREASE, no H2, no token rewrite)", async () => {
  const calls = fakeClient(() => ({ status: 200, headers: {}, data: fakeStream([]) }));
  await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    { method: "POST", headers: { "user-agent": "claude-cli/2.1.63 (external, cli)" }, body: "{}" },
    { isStream: true },
  );
  const opts = calls[0].options;
  expect(opts["ja3"]).toBe(CLAUDE_CODE_JA3_TOKEN);
  // "firefox" is the GREASE-policy selector for CycleTLS's JA3 parser, not
  // the HTTP User-Agent (which stays claude-cli in headers).
  expect(opts["userAgent"]).toBe("firefox");
  expect(opts["forceHTTP1"]).toBe(true);
  expect(opts["tls13AutoRetry"]).toBe(false);
  expect((opts["headers"] as Record<string, string>)["user-agent"]).toContain("claude-cli");
});

test("a wedged sidecar times out instead of hanging forever", async () => {
  fakeClient(() => new Promise(() => {})); // never settles: dead Go process
  await expect(
    fetchViaClaudeCodeMimic(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: "{}" },
      { timeoutMs: 50 },
    ),
  ).rejects.toBeInstanceOf(MimicTransportUnavailableError);
});

test("unsupported body types fail open instead of being silently dropped", async () => {
  fakeClient(() => ({ status: 200, headers: {}, data: fakeStream([]) }));
  const form = new FormData();
  await expect(
    fetchViaClaudeCodeMimic("https://api.anthropic.com/v1/messages", { method: "POST", body: form }),
  ).rejects.toBeInstanceOf(MimicTransportUnavailableError);
});

test("pipeline falls back to native fetch when the mimic transport fails", async () => {
  fakeClient(() => ({ status: 495, headers: {}, data: SYNTHETIC }));
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ fallback: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const config = { claudeCode: {} } as OcxConfig;
    const mimicFetch = createClaudeCodeMimicFetch(
      "https://api.anthropic.com/v1/messages",
      new Headers({ authorization: "Bearer tok" }),
      config,
    )!;
    const res = await mimicFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({ model: "x", stream: false }),
    });
    expect(seen).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(await res.json()).toEqual({ fallback: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("pipeline derives the session header from the body after stripping", async () => {
  let sentHeaders: Record<string, string> = {};
  fakeClient((call) => {
    sentHeaders = call.options["headers"] as Record<string, string>;
    return { status: 200, headers: {}, data: fakeStream([]) };
  });
  const config = { claudeCode: {} } as OcxConfig;
  const mimicFetch = createClaudeCodeMimicFetch(
    "https://api.anthropic.com/v1/messages",
    new Headers({ authorization: "Bearer tok" }),
    config,
  )!;
  await mimicFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: new Headers({
      authorization: "Bearer tok",
      "x-claude-code-session-id": "stale-client-value",
    }),
    body: JSON.stringify({ metadata: { user_id: "real-session:99" }, stream: true }),
  });
  expect(sentHeaders["x-claude-code-session-id"]).toBe("real-session");
});

test("resolveMimicSidecarPath prefers an explicit existing path", async () => {
  const { resolveMimicSidecarPath } = await import("../src/antidetect/cycletls-transport");
  const tmp = `${import.meta.dir}/../resources/cycletls-patched/cycletls-linux-x64`;
  // Use a temp file so the test does not depend on the bundled binary.
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const probe = `${tmp}.probe`;
  writeFileSync(probe, "x");
  try {
    expect(resolveMimicSidecarPath(probe)).toBe(probe);
  } finally {
    unlinkSync(probe);
  }
});

test("resolveMimicSidecarPath falls back to bundled binary or undefined", async () => {
  const { resolveMimicSidecarPath } = await import("../src/antidetect/cycletls-transport");
  const { existsSync } = await import("node:fs");
  for (const p of [resolveMimicSidecarPath(), resolveMimicSidecarPath("/nonexistent/sidecar")]) {
    if (p === undefined) continue; // platform without a bundled binary: stock fallback
    expect(p.endsWith(`cycletls-${process.platform}-${process.arch}`)).toBe(true);
    expect(existsSync(p)).toBe(true);
  }
});
