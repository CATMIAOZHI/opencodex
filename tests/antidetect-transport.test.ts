import { afterEach, expect, test } from "bun:test";
import {
  MimicTransportUnavailableError,
  buildSidecarInitOptions,
  fetchViaClaudeCodeMimic,
  initMimicSidecarClient,
  setMimicTransportClientForTests,
} from "../src/antidetect/cycletls-transport";
import { CLAUDE_CODE_HEADER_WIRE_ORDER, CLAUDE_CODE_JA3_TOKEN } from "../src/antidetect/claude-code-profile";
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
    { method: "POST", headers: { "user-agent": "claude-cli/2.1.258 (external, cli)" }, body: "{}" },
    { isStream: true },
  );
  const opts = calls[0].options;
  expect(opts["ja3"]).toBe(CLAUDE_CODE_JA3_TOKEN);
  // "firefox" is the GREASE-policy selector for CycleTLS's JA3 parser, not
  // the HTTP User-Agent (which stays claude-cli in headers).
  expect(opts["userAgent"]).toBe("firefox");
  expect(opts["forceHTTP1"]).toBe(true);
  expect(opts["tls13AutoRetry"]).toBe(false);
  // Headers leave the transport in exact wire casing (sub2api capture), not
  // the lowercase form the Headers object normalizes to.
  expect((opts["headers"] as Record<string, string>)["User-Agent"]).toContain("claude-cli");
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
  expect(sentHeaders["X-Claude-Code-Session-Id"]).toBe("real-session");
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
    if (p === undefined) continue; // platform without a bundled binary: mimicry unavailable
    const base = `cycletls-${process.platform}-${process.arch}`;
    // win32 also accepts the .exe spelling the build script produces.
    expect(p.endsWith(`/${base}`) || p.endsWith(`/${base}.exe`)).toBe(true);
    expect(existsSync(p)).toBe(true);
  }
});

test("missing patched sidecar throws instead of using the stock binary (risk control)", () => {
  // The client must NEVER be initialized without an explicit patched
  // executablePath: exact JA3 + wrong wire UA is a contradictory fingerprint.
  expect(() => buildSidecarInitOptions(undefined)).toThrow(MimicTransportUnavailableError);
  const opts = buildSidecarInitOptions("/patched/cycletls-linux-x64");
  expect(opts.executablePath).toBe("/patched/cycletls-linux-x64");
  expect(opts.debug).toBe(false);
  expect(opts.autoExit).toBe(true);
});

test("sidecar init wiring never reaches init without a patched executablePath", async () => {
  // Pins the getClient -> initMimicSidecarClient -> buildSidecarInitOptions
  // wiring: a future edit re-adding a silent stock fallback inside the
  // wiring would fail here instead of shipping a contradictory fingerprint.
  let initOpts: Record<string, unknown> | undefined;
  const fakeInit = async (opts?: Record<string, unknown>) => {
    initOpts = opts;
    return async () => ({ status: 200, headers: {}, data: "{}" });
  };
  await expect(
    initMimicSidecarClient(fakeInit, () => undefined, "/nonexistent/sidecar"),
  ).rejects.toThrow(MimicTransportUnavailableError);
  expect(initOpts).toBeUndefined(); // initCycleTLS was never called
  await initMimicSidecarClient(fakeInit, () => "/patched/cycletls-linux-x64");
  expect(initOpts?.["executablePath"]).toBe("/patched/cycletls-linux-x64");
});

test("Go header-phase timeout form is also a synthetic error (fail-open)", async () => {
  // cycletls Go errors.go: op == "timeout" produces this WITHOUT the
  // "Request returned a Syscall Error:" prefix.
  fakeClient(() => ({
    status: 408,
    headers: {},
    data: "Request timeout: deadline exceeded-> \ncontext deadline exceeded",
  }));
  await expect(
    fetchViaClaudeCodeMimic("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
  ).rejects.toThrow(MimicTransportUnavailableError);
});

test("sidecar timeout option is passed in seconds, not ms", async () => {
  let sentTimeout: unknown;
  fakeClient((call) => {
    sentTimeout = call.options["timeout"];
    return { status: 200, headers: {}, data: "{}" };
  });
  await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    { method: "POST", body: "{}" },
    { timeoutMs: 120_000 },
  );
  // Go interprets timeout as seconds; 120_000ms must become 120, not 120_000 (~33h).
  expect(sentTimeout).toBe(120);
});

test("transport hands exact wire casing to the sidecar (no content-length entry)", async () => {
  // NOTE: this asserts the TS -> sidecar handoff object, not the wire itself.
  // Wire casing is established by source inspection of the patched sidecar
  // (direct header-map assignment instead of Header.Set) against fhttp.
  const calls = fakeClient(() => ({ status: 200, headers: {}, data: fakeStream([]) }));
  const body = JSON.stringify({ model: "x", hello: "世界" });
  await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "accept": "application/json",
        "x-stainless-os": "Linux",
        "x-app": "cli",
        "anthropic-version": "2023-06-01",
        "authorization": "Bearer t",
        "x-client-request-id": "id-1",
        "accept-encoding": "gzip",
      },
      body,
    },
    { isStream: false },
  );
  const sent = calls[0].options["headers"] as Record<string, string>;
  // Exact wire casing per the sub2api capture (not Go-canonical, not lowercase).
  expect(sent["Accept"]).toBe("application/json");
  expect(sent["X-Stainless-OS"]).toBe("Linux");
  expect(sent["x-app"]).toBe("cli");
  expect(sent["anthropic-version"]).toBe("2023-06-01");
  expect(sent["authorization"]).toBe("Bearer t");
  expect(sent["x-client-request-id"]).toBe("id-1");
  expect(sent["Accept-Encoding"]).toBe("gzip");
  // No lowercase/canonical duplicates of the same headers.
  expect(sent["accept"]).toBeUndefined();
  expect(sent["X-App"]).toBeUndefined();
  expect(sent["Anthropic-Version"]).toBeUndefined();
  // No content-length entry in ANY casing: fhttp's transferWriter auto-adds a
  // single canonical "Content-Length" (its Get-based presence check cannot see
  // a lowercase map key, so a manual lowercase entry would duplicate it on
  // the wire). The case-insensitive HeaderOrderKey matcher still places the
  // auto-added header at the captured position from our order list.
  expect(sent["content-length"]).toBeUndefined();
  expect(sent["Content-Length"]).toBeUndefined();
});

test("transport strips a caller-supplied content-length (P0 defense in depth)", async () => {
  const calls = fakeClient(() => ({ status: 200, headers: {}, data: fakeStream([]) }));
  await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "accept": "application/json", "content-length": "999" },
      body: "{}",
    },
    { isStream: false },
  );
  const sent = calls[0].options["headers"] as Record<string, string>;
  // A stale/mismatched caller value must never reach the sidecar: fhttp
  // computes the single canonical Content-Length from the actual body.
  expect(sent["content-length"]).toBeUndefined();
  expect(sent["Content-Length"]).toBeUndefined();
});

test("transport omits content-length when there is no body", async () => {
  const calls = fakeClient(() => ({ status: 200, headers: {}, data: fakeStream([]) }));
  await fetchViaClaudeCodeMimic(
    "https://api.anthropic.com/v1/messages",
    { method: "GET", headers: { "accept": "application/json" } },
    { isStream: false },
  );
  const sent = calls[0].options["headers"] as Record<string, string>;
  expect(sent["content-length"]).toBeUndefined();
  expect(sent["Content-Length"]).toBeUndefined();
});

test("mimic pipeline passes the exact wire header order to the sidecar", async () => {
  const calls = fakeClient(() => ({ status: 200, headers: {}, data: fakeStream([]) }));
  const mimicFetch = createClaudeCodeMimicFetch(
    "https://api.anthropic.com/v1/messages",
    new Headers({ authorization: "Bearer t", "content-type": "application/json" }),
    { claudeCode: { fingerprintMimic: true } } as OcxConfig,
  );
  expect(mimicFetch).not.toBeNull();
  await mimicFetch!("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: false }),
  });
  const order = calls[0].options["headerOrder"] as string[];
  // The sidecar's order list starts with the exact captured wire order;
  // any extra headers are appended after, never interleaved.
  expect(order.slice(0, CLAUDE_CODE_HEADER_WIRE_ORDER.length)).toEqual(CLAUDE_CODE_HEADER_WIRE_ORDER);
});
