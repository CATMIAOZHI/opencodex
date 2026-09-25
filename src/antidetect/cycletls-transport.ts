/**
 * CycleTLS-backed transport that performs the TLS handshake with the copied
 * Claude Code ClientHello profile (see ./claude-code-profile.ts).
 *
 * Node/Bun cannot craft a custom ClientHello on their own (BoringSSL exposes
 * no extension-order control), so the handshake is delegated to CycleTLS's
 * Go/uTLS sidecar — the same role sub2api's Go dialer plays, adapted for a
 * TypeScript runtime.
 *
 * Fail-open by design: any sidecar or transport failure throws
 * MimicTransportUnavailableError and callers MUST fall back to native fetch.
 * A fingerprint feature must never break the request path.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CODE_JA3_TOKEN } from "./claude-code-profile";

export class MimicTransportUnavailableError extends Error {
  override readonly name = "MimicTransportUnavailableError";
}

/**
 * CycleTLS's JA3 string parser (`StringToSpec` in its Go source) overloads the
 * `userAgent` option as a GREASE-policy selector: any UA that is not
 * chrome/firefox falls into the **chrome** branch, which unconditionally
 * prepends GREASE to the cipher suites, extensions and curves — silently
 * destroying the target JA3. There is no `disableGrease` knob on the JA3 path
 * (it only exists on the JA4r path).
 *
 * Passing "firefox" selects the no-GREASE branch, so the emitted ClientHello
 * keeps the measured cipher/extension/curve order byte-for-byte and the JA3
 * hash matches. (Verified against cycletls 2.0.5 Go source; re-verify on
 * upgrade.)
 *
 * DECOUPLING (patched sidecar): stock CycleTLS writes this same option value
 * verbatim to the wire `User-Agent` header, which made exact JA3 and the real
 * `claude-cli/...` UA structurally mutually exclusive. The bundled patched
 * sidecar (resources/cycletls-patched, built by
 * scripts/build-mimic-sidecar.sh) keeps `userAgent` as the TLS fingerprint
 * selector / fallback UA but no longer clobbers an explicitly provided
 * User-Agent header — so the wire carries the real CLI UA while the
 * ClientHello keeps the exact JA3. When the patched binary is absent (or
 * `mimicSidecarPath` points elsewhere) the stock binary is used and the old
 * limitation applies: wire UA becomes "firefox".
 */
const CYCLETLS_GREASE_POLICY_UA = "firefox";

/**
 * Prefix of every synthetic transport error the CycleTLS JS layer resolves
 * (not rejects) with — see `parseError` in its Go source. Real upstream HTTP
 * responses, including error statuses, never carry this prefix: they arrive
 * with response metadata first and their body through the stream/buffer path.
 */
const SYNTHETIC_TRANSPORT_ERROR_PREFIX = "Request returned a Syscall Error:";

/** Default sidecar timeout; the Go side treats 0/undefined as "no timeout". */
const DEFAULT_MIMIC_TIMEOUT_MS = 120_000;

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
 * The client is a singleton: the sidecar path from the first successful init
 * wins for the process lifetime.
 */
async function getClient(sidecarPath?: string): Promise<CycleTLSClientLike> {
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
        // when `port` is omitted. executablePath selects the patched sidecar
        // (decoupled JA3 selector / wire UA) when available; omitted it falls
        // back to the stock npm-shipped binary.
        const executablePath = resolveMimicSidecarPath(sidecarPath);
        return await initCycleTLS(
          executablePath
            ? { debug: false, autoExit: true, executablePath }
            : { debug: false, autoExit: true },
        );
      } catch (err) {
        throw new MimicTransportUnavailableError(
          `cycletls sidecar failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    // A failed start must not be cached forever — a later request may succeed
    // (e.g. transient failure spawning the Go binary).
    clientPromise.catch(() => { clientPromise = undefined; });
  }
  return clientPromise;
}

/** For tests: drop the cached client so the next call re-initializes. */
export function resetMimicTransportForTests(): void {
  clientPromise = undefined;
}

/** For tests: inject a fake sidecar client and skip real initialization. */
export function setMimicTransportClientForTests(client: CycleTLSClientLike | undefined): void {
  clientPromise = client ? Promise.resolve(client) : undefined;
}

function isStreamLike(v: unknown): v is CycleTLSStreamLike {
  return (
    !!v && typeof v === "object" &&
    typeof (v as Record<string, unknown>).on === "function"
  );
}

/**
 * Rejects with MimicTransportUnavailableError if `promise` does not settle
 * within `ms`. The sidecar request itself is not cancellable (Go side keeps
 * running until its own timeout), so this only frees OUR await — the design
 * stays fail-open: the caller falls back to native fetch.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MimicTransportUnavailableError(
        `mimic transport timed out after ${ms}ms`,
      ));
    }, ms);
    // Don't keep the process alive for a wedged sidecar.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * CycleTLS resolves (never rejects) transport failures — TLS handshake
 * errors, refused connections, timeouts, DNS failures — with a synthetic
 * response whose `data` is the Go error message. Without this check those
 * would be proxied to our caller as upstream 4xx/5xx responses instead of
 * failing open to native fetch.
 */
function isSyntheticTransportError(data: unknown): data is string {
  return typeof data === "string" && data.startsWith(SYNTHETIC_TRANSPORT_ERROR_PREFIX);
}

/**
 * Bridges an EventEmitter-style byte stream to a Web ReadableStream without
 * assuming it is a node:stream Readable.
 *
 * Known limitation: if the sidecar's connection drops mid-body, CycleTLS
 * closes the stream gracefully with no error signal, so a truncated SSE
 * stream looks complete. Non-streaming callers use the buffered path below
 * precisely so truncation surfaces as a synthetic error and fails open.
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
      // Note: aborting only stops our consumption — the Go sidecar request
      // keeps running until its own timeout. Bounded by timeoutMs, no leak.
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
  /** Request timeout in ms for the sidecar call. Default 120_000. */
  timeoutMs?: number;
  /** Preserve the caller's header order on the wire when set. */
  headerOrder?: string[];
  /**
   * True for SSE/streaming responses (live stream). False buffers the whole
   * body so a mid-body transport failure surfaces as a synthetic error and
   * fails open instead of delivering a truncated stream.
   */
  isStream?: boolean;
  /**
   * Path to the CycleTLS sidecar binary. When set (or when the bundled
   * patched binary exists), it is passed as `executablePath` so the patched
   * sidecar — which decouples the JA3 selector from the wire User-Agent —
   * is used instead of the stock npm-shipped binary.
   */
  sidecarPath?: string;
}

/**
 * Resolve which sidecar binary to spawn:
 * 1. explicit `sidecarPath` (config `claudeCode.mimicSidecarPath`),
 * 2. the bundled patched binary for this platform
 *    (resources/cycletls-patched/cycletls-<platform>-<arch>),
 * 3. undefined — the stock npm-shipped binary (known UA limitation).
 * A missing explicit path is NOT an error: it fails open to (2)/(3), and a
 * sidecar that fails to start fails open to native fetch downstream.
 */
export function resolveMimicSidecarPath(explicitPath?: string): string | undefined {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const bundled = join(
    import.meta.dir,
    "..",
    "..",
    "resources",
    "cycletls-patched",
    `cycletls-${process.platform}-${process.arch}`,
  );
  if (existsSync(bundled)) return bundled;
  return undefined;
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
  const client = await getClient(opts.sidecarPath); // throws MimicTransportUnavailableError
  const headers: Record<string, string> = {};
  const src = new Headers(init.headers);
  src.forEach((value, key) => { headers[key] = value; });

  const method = (init.method ?? "GET").toLowerCase();
  const body = init.body;
  // The Go side only accepts a string body; anything else would be silently
  // dropped, so fail open loudly instead of sending a truncated request.
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof URLSearchParams)) {
    throw new MimicTransportUnavailableError(
      `unsupported body type for mimic transport: ${Object.prototype.toString.call(body)}`,
    );
  }
  const bodyString =
    typeof body === "string" ? body
    : body instanceof URLSearchParams ? body.toString()
    : undefined;

  const isStream = opts.isStream ?? false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MIMIC_TIMEOUT_MS;

  let upstream: CycleTLSResponseLike;
  try {
    // JS-side timeout: the sidecar resolves transport failures, but a dead or
    // wedged Go process leaves this promise unsettled forever — without the
    // race the request would hang instead of failing open to native fetch.
    // (The caller's AbortSignal only stops our stream consumption, not the
    // sidecar; the timeout is the backstop for both.)
    upstream = await withTimeout(
      client(input, {
        headers,
        body: bodyString,
        // Streaming stays live; everything else is buffered so transport
        // failures surface as synthetic errors (fail-open) rather than
        // truncated bodies.
        responseType: isStream ? "stream" : "text",
        ja3: CLAUDE_CODE_JA3_TOKEN,
        disableGrease: true, // honored on non-JA3 paths; kept for intent
        userAgent: CYCLETLS_GREASE_POLICY_UA,
        headerOrder: opts.headerOrder,
        orderAsProvided: opts.headerOrder !== undefined,
        timeout: timeoutMs,
        // Pin the measured profile: no H2 upgrade. tls13AutoRetry is pinned
        // off so a future default change can't rewrite the 771 token.
        forceHTTP1: true,
        tls13AutoRetry: false,
      }, method),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof MimicTransportUnavailableError) throw err;
    throw new MimicTransportUnavailableError(
      `cycletls request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Transport failures resolve (not reject) with a synthetic error payload —
  // this is what makes fail-open actually work.
  if (isSyntheticTransportError(upstream.data)) {
    throw new MimicTransportUnavailableError(`mimic transport failed: ${upstream.data}`);
  }

  const webStream = isStream && isStreamLike(upstream.data)
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
