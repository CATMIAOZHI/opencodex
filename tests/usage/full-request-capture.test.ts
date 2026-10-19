import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { captureHttpSend, captureInboundRequest, captureRequestResult, flushFullRequestCapturesForTests, withFullRequestCapture } from "../../src/usage/full-request-capture";
import { bridgeToResponsesSSE } from "../../src/bridge/sse";
import type { AdapterEvent } from "../../src/types";
import { clearDebugSettings, setDebugSettings } from "../../src/lib/debug-settings";
import { readJsonRequestBody } from "../../src/server/request-decompress";
import { sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let oldHome: string | undefined;
let oldDebug: string | undefined;
beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  oldDebug = process.env.OPENCODEX_FULL_REQUEST_DEBUG;
  home = mkdtempSync(join(tmpdir(), "ocx-full-capture-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_FULL_REQUEST_DEBUG;
  clearDebugSettings();
});
afterEach(async () => {
  await flushFullRequestCapturesForTests();
  clearDebugSettings();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  if (oldDebug === undefined) delete process.env.OPENCODEX_FULL_REQUEST_DEBUG;
  else process.env.OPENCODEX_FULL_REQUEST_DEBUG = oldDebug;
  removeTreeWithRetry(home);
});
const url = "https://api.anthropic.com/v1/messages";
const ok = async () => new Response("ok");
function folders() {
  return readdirSync(join(home, "request-captures")).map(name => join(home, "request-captures", name));
}
function read(dir: string, file: string) { return readFileSync(join(dir, file), "utf8"); }

test("disabled creates no files and does not change the request or response", async () => {
  const init = { method: "POST", body: '{"hello":"world"}' };
  await withFullRequestCapture({}, () => captureHttpSend(url, init, async actual => {
    expect(actual).toBe(init);
    return ok();
  }));
  expect(existsSync(join(home, "request-captures"))).toBe(false);
});

test("decoded ingress preserves all original JSON text; egress keeps complete images and masks headers", async () => {
  setDebugSettings({ requests: true });
  const text = '{\n "model":"claude-opus-5-5", "input": "' + "a".repeat(2 * 1024 * 1024) + '"\n}';
  const body = JSON.stringify({ messages: [{ content: [{ type: "image", source: { data: "b".repeat(3 * 1024 * 1024) } }] }] });
  await withFullRequestCapture({}, async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-encoding": "gzip", authorization: "Bearer fake-inbound-secret" },
      body: gzipSync(text),
    });
    await readJsonRequestBody(req, undefined, undefined, decoded => captureInboundRequest(req, decoded));
    await captureHttpSend(url, {
      method: "POST", body, headers: { authorization: "Bearer fake-outbound-secret", cookie: "fake-cookie",
        "anthropic-beta": "oauth-2025-04-20", "x-api-key": "fake-key" },
    }, async actual => { expect(actual.body).toBe(body); return ok(); });
  });
  await flushFullRequestCapturesForTests();
  const dir = folders()[0]!;
  expect(read(dir, "0001-inbound.json")).toBe(text);
  expect(read(dir, "0002-outbound.json")).toBe(body);
  const metadata = read(dir, "0001-inbound.meta.json") + read(dir, "0002-outbound.meta.json");
  for (const secret of ["fake-inbound-secret", "fake-outbound-secret", "fake-cookie", "fake-key"]) {
    expect(metadata).not.toContain(secret);
  }
  expect(metadata).toContain("oauth-2025-04-20");
  expect(JSON.parse(read(dir, "0002-outbound.meta.json")).complete).toBe(true);
});

test("physical retry bodies are separate, nested dispatch is recorded only once, concurrent requests stay isolated", async () => {
  setDebugSettings({ requests: true });
  const owners = [{}, {}];
  await Promise.all(owners.map((owner, i) => withFullRequestCapture(owner, async () => {
    const transport = (async (_input, init) => {
      expect(init?.body).toContain(`request-${i}`);
      return ok();
    }) as typeof fetch;
    const nested = ((input, init) => sendWithConnectionPolicy(transport, input, init)) as typeof fetch;
    await sendWithConnectionPolicy(nested, url, { method: "POST", body: `{"id":"request-${i}","retry":0}` });
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 4 : 1));
    await sendWithConnectionPolicy(nested, url, { method: "POST", body: `{"id":"request-${i}","retry":1}` });
  })));
  await flushFullRequestCapturesForTests();
  expect(folders()).toHaveLength(2);
  for (const dir of folders()) {
    const bodies = readdirSync(dir).filter(name => /^\d+-outbound\.json$/.test(name));
    expect(bodies).toHaveLength(2);
    const first = JSON.parse(read(dir, bodies[0]!));
    const second = JSON.parse(read(dir, bodies[1]!));
    expect(first.id).toBe(second.id);
    expect([first.retry, second.retry]).toEqual([0, 1]);
  }
});

test("off stops subsequent bodies, result joins usage by request ID, transport error is unchanged", async () => {
  setDebugSettings({ requests: true });
  const owner = {};
  const error = new Error("transport failed");
  await withFullRequestCapture(owner, async () => {
    await expect(captureHttpSend(url, { body: "{}" }, async () => { throw error; })).rejects.toBe(error);
    setDebugSettings({ requests: false });
    await captureHttpSend(url, { body: '{"not":"recorded"}' }, ok);
  });
  captureRequestResult(owner, "ocx-test-request", 200, { cacheReadInputTokens: 123, cacheCreation1hInputTokens: 4 });
  await flushFullRequestCapturesForTests();
  const dir = folders()[0]!;
  expect(readdirSync(dir).filter(name => /^result-.*\.json$/.test(name)).length).toBe(1);
  const resultFile = readdirSync(dir).find(name => /^result-.*\.json$/.test(name))!;
  expect(JSON.parse(read(dir, resultFile))).toMatchObject({
    requestId: "ocx-test-request", usage: { cacheReadInputTokens: 123, cacheCreation1hInputTokens: 4 },
  });
  expect(readdirSync(dir).filter(name => /^\d+-outbound\.json$/.test(name))).toHaveLength(1);
});

test("unwritable capture destination does not prevent a physical send", async () => {
  setDebugSettings({ requests: true });
  writeFileSync(join(home, "request-captures"), "not a directory");
  let sends = 0;
  const response = await withFullRequestCapture({}, () =>
    captureHttpSend(url, { body: "{}" }, async () => { sends++; return ok(); }));
  expect(sends).toBe(1);
  expect(await response.text()).toBe("ok");
});

test("late SSE continuation keeps capture context when the stream is consumed outside ingress", async () => {
  setDebugSettings({ requests: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "first" };
    await gate;
    await sendWithConnectionPolicy((async () => ok()) as typeof fetch, url, {
      method: "POST", body: '{"late":"continuation"}',
    });
    yield { type: "done", stopReason: "stop" };
  }
  const stream = withFullRequestCapture({}, () => bridgeToResponsesSSE(events(), "claude-opus-5-5"));
  release();
  const output = await new Response(stream).text();
  expect(output).toContain("response.completed");
  await flushFullRequestCapturesForTests();
  expect(read(folders()[0]!, "0001-outbound.json")).toBe('{"late":"continuation"}');
});
