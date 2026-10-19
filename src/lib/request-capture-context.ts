/** Transport-owned slot: no config, filesystem, logger or application imports. */
import { AsyncLocalStorage } from "node:async_hooks";

export interface FullRequestCaptureContext { directory: string; sequence: number }
export const fullRequestCaptureContext = new AsyncLocalStorage<FullRequestCaptureContext>();
type HttpHook = (
  input: Parameters<typeof fetch>[0], init: RequestInit,
  send: (init: RequestInit) => Promise<Response>,
) => Promise<Response>;
let httpHook: HttpHook | undefined;

export function installFullRequestCaptureHttpHook(hook: HttpHook): void { httpHook = hook; }

export function observeFullRequestHttp(
  input: Parameters<typeof fetch>[0], init: RequestInit, send: (init: RequestInit) => Promise<Response>,
): Promise<Response> {
  return fullRequestCaptureContext.getStore() && httpHook ? httpHook(input, init, send) : send(init);
}

/** Lazy stream pulls execute in their creator's scope, not the downstream reader's. */
export function bindFullRequestCapture<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const capture = fullRequestCaptureContext.getStore();
  return capture ? (...args) => fullRequestCaptureContext.run(capture, () => callback(...args)) : callback;
}
