/** Explicitly opted-in local request bodies. Never exposed through dashboard log APIs. */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { isFullRequestDebugEnabled } from "../lib/debug-settings";
import {
  fullRequestCaptureContext as active, installFullRequestCaptureHttpHook,
  type FullRequestCaptureContext as Capture,
} from "../lib/request-capture-context";

const owners = new WeakMap<object, Capture>();
const headerSalt = randomBytes(32);
const CAPTURED_SEND = Symbol("full-request-captured-send");
const MAX_PENDING_BYTES = 512 * 1024 * 1024;
const MAX_PENDING_WRITES = 64;
const pending = new Set<Promise<void>>();
let pendingBytes = 0;
let warned = false;

function warn(): void {
  if (warned) return;
  warned = true;
  console.warn("[opencodex] Full request capture incomplete: local write failed, queue full, or body representation unsupported.");
}

/** Do not include disk latency in model send/header deadlines. Drop whole records, never truncate. */
function enqueue(bytes: number, write: () => Promise<void>): boolean {
  if (pending.size >= MAX_PENDING_WRITES || pendingBytes + bytes > MAX_PENDING_BYTES) {
    warn();
    return false;
  }
  pendingBytes += bytes;
  const task = Promise.resolve().then(write).catch(warn).finally(() => {
    pendingBytes -= bytes;
    pending.delete(task);
  });
  pending.add(task);
  return true;
}

export async function flushFullRequestCapturesForTests(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** Atomic files: readers never mistake a partial write for a complete body. */
async function save(capture: Capture, name: string, data: string | Uint8Array): Promise<boolean> {
  const target = join(capture.directory, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(capture.directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    return true;
  } catch {
    await unlink(temporary).catch(() => {});
    warn();
    return false;
  }
}

function headersForCapture(headers: Headers): Record<string, unknown> {
  // Only protocol/cache parameters are readable. Unknown headers (including credentials,
  // account IDs and network addresses) retain equality tags, never their original values.
  const readable = new Set([
    "content-type", "content-encoding", "anthropic-version", "anthropic-beta",
    "accept", "connection", "user-agent",
  ]);
  return Object.fromEntries([...headers].map(([key, value]) => [
    key, readable.has(key) ? value : {
      redacted: true,
      tag: createHmac("sha256", headerSalt).update(key).update("\0").update(value).digest("hex"),
    },
  ]));
}

function endpoint(input: string | URL | Request): string {
  try { return new URL(input instanceof Request ? input.url : String(input)).pathname; }
  catch { return "(unavailable)"; }
}

export function withFullRequestCapture<T>(owner: object, run: () => T): T {
  if (!isFullRequestDebugEnabled()) return run();
  const capture = owners.get(owner) ?? {
    directory: join(getConfigDir(), "request-captures", `${Date.now()}-${randomUUID()}`),
    sequence: 0,
  };
  owners.set(owner, capture);
  return active.run(capture, run);
}

/** Called on decoded JSON text BEFORE request normalization, preserving whitespace too. */
export async function captureInboundRequest(req: Request, text: string): Promise<void> {
  const capture = active.getStore();
  if (!capture || !isFullRequestDebugEnabled()) return;
  const name = `${String(++capture.sequence).padStart(4, "0")}-inbound`;
  const bytes = Buffer.byteLength(text, "utf8");
  const metadata = {
    at: Date.now(), phase: "inbound", method: req.method, endpoint: endpoint(req),
    headers: headersForCapture(req.headers), bodyFile: `${name}.json`,
    bytes, representation: "decoded-utf8-json",
  };
  enqueue(bytes + 16_384, async () => {
    const complete = await save(capture, `${name}.json`, text);
    await save(capture, `${name}.meta.json`, JSON.stringify({ ...metadata, complete }, null, 2));
  });
}

/** Wrap the final HTTP executor, including credential rebuilds and 413/transient retries. */
export async function captureHttpSend(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  send: (init: RequestInit) => Promise<Response>,
): Promise<Response> {
  const capture = active.getStore();
  if (!capture || !isFullRequestDebugEnabled()
    || (init as Record<symbol, unknown>)[CAPTURED_SEND]) return send(init);
  const marked = { ...init, [CAPTURED_SEND]: true };
  const name = `${String(++capture.sequence).padStart(4, "0")}-outbound`;
  const body = init.body;
  // Never clone/consume a streaming Request for diagnostics. Claude's serializer uses a
  // string; the native large-upload boundary can supply a Uint8Array instead.
  const size = typeof body === "string" ? Buffer.byteLength(body, "utf8")
    : body instanceof Uint8Array || body instanceof ArrayBuffer ? body.byteLength : undefined;
  const meta = {
    at: Date.now(), phase: "outbound", method: init.method ?? (input instanceof Request ? input.method : "GET"),
    endpoint: endpoint(input), headers: headersForCapture(new Headers(init.headers)),
    bodyFile: size !== undefined ? `${name}.json` : null, bytes: size,
    complete: size !== undefined,
  };
  // Reserve before copying mutable buffers. Strings already are immutable snapshots.
  let snapshot: string | Uint8Array | undefined;
  const queued = enqueue((size ?? 0) + 16_384, async () => {
    if (snapshot !== undefined) meta.complete = await save(capture, `${name}.json`, snapshot);
    else warn();
    await save(capture, `${name}.meta.json`, JSON.stringify(meta, null, 2));
  });
  if (queued) {
    snapshot = typeof body === "string" ? body
      : body instanceof Uint8Array ? Uint8Array.from(body)
        : body instanceof ArrayBuffer ? new Uint8Array(body.slice(0)) : undefined;
  }
  // Capture failures must never suppress a send, and transport errors retain their identity.
  try {
    const response = await send(marked);
    const data = JSON.stringify({
      at: Date.now(), status: response.status,
    });
    enqueue(data.length, async () => { await save(capture, `${name}.response.json`, data); });
    return response;
  } catch (error) {
    enqueue(128, async () => {
      await save(capture, `${name}.response.json`, JSON.stringify({ at: Date.now(), transportError: true }));
    });
    throw error;
  }
}

/** Join to usage.jsonl by requestId; never retain prompt bodies on the log context. */
export function captureRequestResult(
  owner: object, requestId: string, status: number, usage: unknown,
): void {
  const capture = owners.get(owner);
  if (!capture) return;
  const data = JSON.stringify({
    requestId, at: Date.now(), status, usage,
  }, null, 2);
  enqueue(Buffer.byteLength(data), async () => { await save(capture, `result-${randomUUID()}.json`, data); });
}

installFullRequestCaptureHttpHook(captureHttpSend);
