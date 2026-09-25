/**
 * CycleTLS-backed transport that performs the TLS handshake with the copied
 * Claude Code ClientHello profile (see ./claude-code-profile.ts).
 *
 * Node/Bun cannot craft a custom ClientHello on their own (BoringSSL exposes
 * no extension-order control), so the handshake is delegated to CycleTLS's
 * Go/uTLS sidecar — the same role sub2api's Go dialer plays, adapted for a
 * TypeScript runtime.
 *
 * Fail-open by design: if the sidecar cannot start (binary missing, download
 * blocked, platform unsupported) every entry point throws
 * MimicTransportUnavailableError and callers MUST fall back to native fetch.
 * A fingerprint feature must never break the request path.
 */
import { CLAUDE_CODE_JA3_TOKEN, CLAUDE_CODE_USER_AGENT } from "./claude-code-profile";

export class MimicTransportUnavailableError extends Error {
  override readonly name = "MimicTransportUnavailableError";
}

interface CycleTLSStreamLike {
  on(event: "data", cb: (chunk: unknown) => void): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
}

interface CycleTLSResponseLike {
  status: number;
  headers: Record<string, unknown>;
  data: unknown;
}

type CycleTLSClientLike = (
  url: string,
  options: Record<string, unknown>,
  method?: string,
) => Promise<CycleTLSResponseLike>;

let clientPromise: Promise<CycleTLSClientLike> | undefined;

/**
 * Lazily starts the CycleTLS sidecar (dynamic import: the `cycletls`
 * dependency stays off the startup path). autoExit ties the Go child process
 * to our own lifetime so no shutdown-hook wiring is needed.
 */
async function getClient(): Promise<CycleTLSClientLike> {
  if (!clientPromise) {
    clientPromise = (async () => {
      let initCycleTLS: (opts?: Record<string, unknown>) => Promise<CycleTLSClientLike>;
      try {
        const mod = await import("cycletls") as {
          default?: (opts?: Record<string, unknown>) => Promise<CycleTLSClientLike>;
        };
        if (typeof mod.default !== "function") {
          throw new Error("cycletls default export is not a function");
        }
        initCycleTLS = mod.default;
      } catch (err) {
        throw new MimicTransportUnavailableError(
          `cycletls module could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        // debug=false keeps the sidecar quiet; a random free port is chosen
        // when `port` is omitted.
        return await initCycleTLS({ debug: false, autoExit: true });
      } catch (err) {
        throw new MimicTransportUnavailableError(
          `cycletls sidecar failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    // A failed start must not be cached forever — a later request may succeed
    // (e.g. transient download failure of the Go binary).
    clientPromise.catch(() => { clientPromise = undefined; });
  }
  return clientPromise;
}

/** For tests: drop the cached client so the next call re-initializes. */
export function resetMimicTransportForTests(): void {
  clientPromise = undefined;
}

function isStreamLike(v: unknown): v is CycleTLSStreamLike {
  return (
    !!v && typeof v === "object" &&
    typeof (v as Record<string, unknown>).on === "function"
  );
}

/**
 * Bridges an EventEmitter-style byte stream to a Web ReadableStream without
 * assuming it is a node:stream Readable.
 */
function toWebStream(source: CycleTLSStreamLike, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      const onAbort = () => {
        controller.error(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      source.on("data", (chunk) => {
        try {
          if (typeof chunk === "string") {
            controller.enqueue(new TextEncoder().encode(chunk));
          } else if (chunk instanceof Uint8Array) {
            controller.enqueue(chunk);
          } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) {
            controller.enqueue(new Uint8Array(chunk));
          }
        } catch (err) {
          controller.error(err);
        }
      });
      source.on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        controller.close();
      });
      source.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        controller.error(err instanceof Error ? err : new Error(String(err)));
      });
    },
  });
}

function toHeaders(raw: Record<string, unknown>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, String(v));
    } else if (value !== undefined && value !== null) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

export interface MimicFetchOptions {
  /** Request timeout in ms for the sidecar call. */
  timeoutMs?: number;
  /** Preserve the caller's header order on the wire when set. */
  headerOrder?: string[];
}

/**
 * fetch-compatible POST/GET via the mimicked TLS stack. The body must already
 * be final (dateline-normalized) and headers already mimic-applied by the
 * caller — this function only owns the transport.
 */
export async function fetchViaClaudeCodeMimic(
  input: string,
  init: RequestInit,
  opts: MimicFetchOptions = {},
): Promise<Response> {
  const client = await getClient(); // throws MimicTransportUnavailableError
  const headers: Record<string, string> = {};
  const src = new Headers(init.headers);
  src.forEach((value, key) => { headers[key] = value; });

  const method = (init.method ?? "GET").toLowerCase();
  const body = init.body;
  const bodyString =
    typeof body === "string" ? body
    : body instanceof URLSearchParams ? body.toString()
    : undefined;

  let upstream: CycleTLSResponseLike;
  try {
    upstream = await client(input, {
      headers,
      body: bodyString,
      responseType: "stream",
      ja3: CLAUDE_CODE_JA3_TOKEN,
      disableGrease: true,
      userAgent: CLAUDE_CODE_USER_AGENT,
      headerOrder: opts.headerOrder,
      orderAsProvided: opts.headerOrder !== undefined,
      timeout: opts.timeoutMs,
      forceHTTP1: false,
    }, method);
  } catch (err) {
    if (err instanceof MimicTransportUnavailableError) throw err;
    throw new MimicTransportUnavailableError(
      `cycletls request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Always stream: works for SSE and buffered bodies alike.
  const webStream = isStreamLike(upstream.data)
    ? toWebStream(upstream.data, init.signal)
    : new ReadableStream<Uint8Array>({
      start(controller) {
        if (typeof upstream.data === "string") {
          controller.enqueue(new TextEncoder().encode(upstream.data));
        }
        controller.close();
      },
    });

  return new Response(webStream, {
    status: upstream.status,
    headers: toHeaders(upstream.headers ?? {}),
  });
}
