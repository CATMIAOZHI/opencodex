/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import { useAnthropicResetGrants } from "../src/hooks/useAnthropicResetGrants";
import { AnthropicGrantBadge, AnthropicResetGrantModal } from "../src/components/provider-workspace/AnthropicResetGrants";

// The dialog's one irreversible action: after a claim with an unknown outcome it
// must keep the operation id and retry only that id, never mint a new one.

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let testWindow: Window;

const SNAPSHOT = {
  accountId: "acct-1",
  eligible: true,
  ineligibleReason: null,
  atLimit: false,
  grants: [{
    id: "opus55-launch-promax-20260921",
    label: "Launch reset",
    resetsTotal: 1,
    resetsLeft: 1,
    startsAt: "2026-09-22T16:00:00+00:00",
    endsAt: "2099-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day"],
    paused: false,
    usableNow: true,
    useRequiresLimit: false,
    percentUsed: { five_hour: 3, seven_day: 14 },
  }],
  nextGrantId: "opus55-launch-promax-20260921",
  pendingOperation: null,
  journalAvailable: true,
};

test("switching pools rejects stale equal-ID reset reads and sends the selected provider", async () => {
  const { createRoot } = await import("react-dom/client");
  let controller!: ReturnType<typeof useAnthropicResetGrants>;
  const reads: Array<{ provider: string; resolve: (response: Response) => void }> = [];
  let spendBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST") {
      spendBody = JSON.parse(String(init.body));
      return Response.json({ provider: "anthropic", code: "consumed", resetsLeft: 0 });
    }
    return new Promise<Response>(resolve => reads.push({ provider: url.searchParams.get("provider") ?? "anthropic", resolve }));
  }) as typeof fetch;
  function PoolHarness({ provider }: { provider: "anthropic" | "anthropic2" }) {
    const current = useAnthropicResetGrants({ apiBase: "", provider, accountIds: ["acct-1"], enabled: true });
    useLayoutEffect(() => { controller = current; }, [current]);
    return null;
  }
  const host = testWindow.document.createElement("div");
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<PoolHarness provider="anthropic2" />); });
    expect(reads[0]?.provider).toBe("anthropic2");
    await act(async () => { root.render(<PoolHarness provider="anthropic" />); });
    expect(reads[1]?.provider).toBe("anthropic");
    await act(async () => {
      reads[1]!.resolve(Response.json({ ...SNAPSHOT, provider: "anthropic" }));
      await Promise.resolve();
    });
    await act(async () => {
      reads[0]!.resolve(Response.json({ ...SNAPSHOT, provider: "anthropic2", atLimit: true }));
      await Promise.resolve();
    });
    const current = controller.entries["acct-1"];
    expect(current?.status).toBe("ready");
    if (current?.status === "ready") expect(current.snapshot.atLimit).toBe(false);
    await act(async () => { root.render(<PoolHarness provider="anthropic2" />); });
    const outcome = await controller.spend("acct-1", { grantId: "fixture-grant", operationId: "11111111-1111-4111-8111-111111111111" });
    expect(spendBody?.provider).toBe("anthropic2");
    // A response cannot settle B's irreversible operation, even when the IDs match.
    expect(outcome.kind).toBe("unknown");
  } finally {
    reads.forEach(read => read.resolve(Response.json({ ...SNAPSHOT, provider: read.provider })));
    await act(async () => { root.unmount(); });
  }
});

beforeEach(() => {
  testWindow = new Window({ url: "http://localhost/" });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
  testWindow.close();
});

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function Harness() {
  const t = useT();
  const controller = useAnthropicResetGrants({ apiBase: "", accountIds: ["acct-1"], enabled: true });
  const [open, setOpen] = useState(false);
  return (
    <>
      <AnthropicGrantBadge entry={controller.entries["acct-1"]} t={t} onClick={() => setOpen(true)} />
      {open && (
        <AnthropicResetGrantModal accountId="acct-1" accountLabel="acct-1" entry={controller.entries["acct-1"]}
          controller={controller} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  await tick();
  await tick();
  return { container, root };
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  const target = container.querySelector(selector) as HTMLButtonElement | null;
  expect(target).not.toBeNull();
  await act(async () => { target!.click(); });
  await tick();
  await tick();
}

test("the badge counts unspent resets and the dialog retries an unknown outcome with the same id", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) return Response.json(SNAPSHOT);
    if (url === "/api/anthropic/reset-grants/consume") {
      posts.push(JSON.parse(String(init?.body)));
      if (posts.length === 1) throw new TypeError("connection reset");
      return Response.json({ code: "reset", replayed: false, resetsLeft: 0, operationId: posts[1].operationId });
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;

  const { container, root } = await mount();
  const badge = container.querySelector("[data-anthropic-grant-badge]");
  expect(badge?.getAttribute("data-anthropic-grant-badge")).toBe("1");
  expect(badge?.className).toContain("badge-amber");

  await click(container, "[data-anthropic-grant-badge]");
  expect(container.textContent).toContain("Launch reset");
  expect(container.textContent).toContain("1 of 1 left");

  await click(container, "[data-anthropic-grant-use]");
  expect(posts).toHaveLength(0);
  await click(container, "[data-anthropic-grant-confirm]");
  expect(posts).toHaveLength(1);
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  expect(container.textContent).toContain("outcome is unknown");

  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({ accountId: "acct-1", grantId: "opus55-launch-promax-20260921" });
  expect(String(posts[0].operationId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(container.textContent).toContain("Limits reset. 0 reset(s) left.");

  await act(async () => { root.unmount(); });
});

test("a pending attempt held by the server is resumed instead of starting a new one", async () => {
  const pendingId = "5c1f7a55-9b1e-4d8e-a0c4-2f5b3c9d7e61";
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) {
      return Response.json({ ...SNAPSHOT, pendingOperation: { operationId: pendingId, grantId: SNAPSHOT.grants[0].id, createdAt: Date.now(), retryableUntil: Date.now() + 60_000 } });
    }
    posts.push(JSON.parse(String(init?.body)));
    return Response.json({ code: "already_used", replayed: false, resetsLeft: 0 });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toEqual([{ accountId: "acct-1", grantId: SNAPSHOT.grants[0].id, operationId: pendingId }]);
  await act(async () => { root.unmount(); });
});

test("a refused same-id retry keeps holding the attempt instead of offering a new id", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) return Response.json(SNAPSHOT);
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length === 1) throw new TypeError("connection reset");
    return Response.json({ error: { code: "ledger_busy", message: "busy" } }, { status: 503 });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(container.querySelector("[data-anthropic-grant-retry]")).not.toBeNull();
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  expect(container.textContent).toContain("journal is busy");
  await act(async () => { root.unmount(); });
});

test("a replayed refusal reads as that refusal, not as a success", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) return Response.json(SNAPSHOT);
    return Response.json({ code: "rate_limited", replayed: true, resetsLeft: null });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  expect(container.textContent).toContain("Too many requests. Nothing was used");
  expect(container.textContent).not.toContain("already settled earlier");
  expect(container.querySelector(".pws-status-warn")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("an account short of its 5-hour wall says so, and the dialog can re-read it", async () => {
  const shortOfWall = {
    ...SNAPSHOT,
    eligible: false,
    ineligibleReason: "tenure",
    atLimit: false,
    grants: [],
    nextGrantId: null,
    juniperOffer: { reason: "not_at_wall", fiveHourPercent: 20 },
  };
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    reads += 1;
    // The roster read and the read the dialog performs on open both see the
    // shortfall; the 5-hour wall is only reached by the time it is re-read.
    return Response.json(reads < 3 ? shortOfWall : SNAPSHOT);
  }) as typeof fetch;

  const { container, root } = await mount();
  // Nothing to spend yet: the badge is a muted zero, and the dialog explains why.
  expect(container.querySelector("[data-anthropic-grant-badge]")?.getAttribute("data-anthropic-grant-badge")).toBe("0");

  await click(container, "[data-anthropic-grant-badge]");
  expect(container.textContent).toContain("Usable once this account hits a limit");
  expect(container.textContent).toContain("5-hour 20%");
  expect(container.textContent).not.toContain("This account is not eligible for usage resets right now.");

  await click(container, "[data-anthropic-grant-reread]");
  expect(container.textContent).toContain("Launch reset");
  expect(container.querySelector("[data-anthropic-grant-use]")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("a failed open-time re-read keeps the known-good snapshot instead of an error", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    reads += 1;
    // The roster read succeeds; every read the dialog performs on open fails.
    if (reads > 1) return Response.json({ error: { code: "upstream_unavailable" } }, { status: 502 });
    return Response.json(SNAPSHOT);
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  // The ticket is still offered: a transient failure must not erase what we knew.
  expect(reads).toBe(2);
  expect(container.textContent).toContain("Launch reset");
  expect(container.querySelector("[data-anthropic-grant-use]")).not.toBeNull();
  expect(container.textContent).not.toContain("Could not read usage resets for this account.");
  await act(async () => { root.unmount(); });
});

test("a silent re-read refused for authentication stops offering the stale ticket", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    reads += 1;
    // A 401 is a definitive answer: the credential is gone, so the old ticket must go.
    if (reads > 1) return Response.json({ error: { code: "auth_failed" } }, { status: 401 });
    return Response.json(SNAPSHOT);
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(reads).toBe(2);
  expect(container.textContent).toContain("Sign in to this Anthropic account again to read its resets.");
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("an eligible account with an empty list still explains a 5-hour shortfall", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    return Response.json({
      ...SNAPSHOT,
      eligible: true,
      ineligibleReason: null,
      grants: [],
      nextGrantId: null,
      juniperOffer: { reason: "not_at_wall", fiveHourPercent: 40 },
    });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.textContent).toContain("Usable once this account hits a limit");
  expect(container.textContent).toContain("5-hour 40%");
  expect(container.querySelector("[data-anthropic-grant-reread]")).not.toBeNull();
  // The "no resets at all" line would contradict the explanation above it.
  expect(container.textContent).not.toContain("This account has no usage resets.");
  await act(async () => { root.unmount(); });
});

test("a silent re-read answered 400 stops offering the ticket", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    reads += 1;
    // A 4xx is the API answering: the ticket on screen no longer exists.
    if (reads > 1) return Response.json({ error: { code: "no_account" } }, { status: 400 });
    return Response.json(SNAPSHOT);
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(reads).toBe(2);
  expect(container.textContent).toContain("Could not read usage resets for this account.");
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("an eligible account with an empty list and no juniper answer states no verdict", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    return Response.json({
      ...SNAPSHOT, eligible: true, ineligibleReason: null,
      grants: [], nextGrantId: null, juniperOffer: null,
    });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  // An empty cedar list says nothing about the 5-hour program.
  expect(container.textContent).toContain("This account's reset eligibility could not be confirmed right now.");
  expect(container.textContent).not.toContain("This account has no usage resets.");
  await act(async () => { root.unmount(); });
});

test("an offer the proxy could not explain does not read as 'not eligible'", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    return Response.json({
      ...SNAPSHOT, eligible: false, ineligibleReason: "no_grant", atLimit: false,
      grants: [], nextGrantId: null, juniperOffer: null,
    });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.textContent).toContain("This account's reset eligibility could not be confirmed right now.");
  expect(container.textContent).not.toContain("This account is not eligible for usage resets right now.");
  expect(container.querySelector("[data-anthropic-grant-reread]")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("a slower older read cannot overwrite a newer silent answer", async () => {
  const { createRoot } = await import("react-dom/client");
  let controller!: ReturnType<typeof useAnthropicResetGrants>;
  const pending: Array<{ resolve: (response: Response) => void }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    return new Promise<Response>(resolve => pending.push({ resolve }));
  }) as typeof fetch;
  function HookHarness() {
    const current = useAnthropicResetGrants({ apiBase: "", accountIds: ["acct-1"], enabled: true });
    useLayoutEffect(() => { controller = current; }, [current]);
    return null;
  }
  const host = testWindow.document.createElement("div");
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<HookHarness />); });
    expect(pending).toHaveLength(1);
    const older = pending[0]!;
    await act(async () => { void controller.refresh("acct-1", { silent: true }); });
    expect(pending).toHaveLength(2);
    const newer = pending[1]!;
    await act(async () => {
      newer.resolve(Response.json(SNAPSHOT));
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(controller.entries["acct-1"]?.status).toBe("ready");
    // The older read started first and fails last; its answer is already superseded.
    await act(async () => {
      older.resolve(Response.json({ error: { code: "upstream_unavailable" } }, { status: 502 }));
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(controller.entries["acct-1"]?.status).toBe("ready");
  } finally {
    await act(async () => { root.unmount(); });
  }
});
