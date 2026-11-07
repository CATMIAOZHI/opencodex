import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { applyCatalogModelMetadata } from "../../src/codex/catalog/effort";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { enrichProviderFromRegistry } from "../../src/providers/derive";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers-destination";
import { serviceTierSupportForModel } from "../../src/providers/service-tier";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { handleResponses } from "../../src/server/responses/core";
import {
  captureCodexClaudeFastControl, codexClaudeFastMode, resetCodexClaudeFastControlsForTests,
  CODEX_CLAUDE_FAST_MAX_TREES, CODEX_CLAUDE_FAST_TTL_MS,
} from "../../src/server/responses/codex-claude-fast";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const claude: OcxProviderConfig = {
  adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key",
  apiKey: "test-token", fastEnabled: true,
};
enrichProviderFromRegistry("anthropic-apikey", claude);
const gpt: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward",
};
const config: OcxConfig = {
  port: 0, defaultProvider: "anthropic-apikey",
  providers: { "anthropic-apikey": claude, openai: gpt },
};
const originalFetch = globalThis.fetch;
beforeEach(() => {
  resetCodexClaudeFastControlsForTests();
  globalThis.fetch = (() => { throw new Error("No network allowed in Fast policy tests"); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCodexClaudeFastControlsForTests();
});

function request(thread = "root", session = "session", auth = "caller", extra: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    headers: { "session-id": session, "thread-id": thread, authorization: `Bearer ${auth}`, ...extra },
  });
}

function capture(
  fast: boolean, thread = "root", session = "session", auth = "caller",
  extra: Record<string, string> = {}, options: HandleResponsesOptions = {},
) {
  return captureCodexClaudeFastControl(request(thread, session, auth, extra),
    { service_tier: fast ? "priority" : "default" }, config, options)!;
}

function root(fast: boolean, now = 0) {
  return codexClaudeFastMode(config, capture(fast), claude, "claude-opus-5-5", now);
}
function worker(fast = false, session = "session", auth = "caller", now = 0) {
  return codexClaudeFastMode(config, capture(fast, "child", session, auth,
    { "x-codex-parent-thread-id": "root" }), gpt, "gpt-6-astra", now);
}

describe("Claude picker controls only native GPT workers", () => {
  test("on/off propagates to existing workers even when their own tier is stale", () => {
    expect(root(true)).toBe(false);
    expect(worker(false)).toBe(true);
    expect(root(false)).toBe(false);
    expect(worker(true)).toBe(false);
    expect(root(true)).toBe(false);
    expect(worker(false)).toBe(true);
  });

  test("unknown trees, other callers, other sessions and third-party GPT gateways are unchanged", () => {
    expect(worker(true)).toBeUndefined();
    root(true);
    expect(worker(false, "other")).toBeUndefined();
    expect(worker(false, "session", "other")).toBeUndefined();
    expect(codexClaudeFastMode(config, capture(false, "child"),
      { ...gpt, baseUrl: "https://gateway.example.test/v1" }, "gpt-6-astra", 0)).toBeUndefined();
  });

  test("children cannot overwrite owner, including continuations without parent headers", () => {
    root(true);
    expect(codexClaudeFastMode(config, capture(false, "child"), claude, "claude-opus-5-5", 0)).toBe(false);
    expect(worker()).toBe(true);
    expect(codexClaudeFastMode(config, capture(false, "grandchild", "session", "caller",
      { "x-codex-parent-thread-id": "child" }), gpt, "gpt-6-astra", 0)).toBe(true);
  });

  test("helper provenance and late-discovered internal routes never publish", () => {
    for (const extra of [
      { "x-openai-subagent": "compact" },
      { "x-openai-subagent": "collab_spawn" },
      { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "memory_consolidation" }) },
      { "x-codex-turn-metadata": "bad JSON" },
    ]) {
      codexClaudeFastMode(config, capture(true, "root", "session", "caller", extra), claude, "claude-opus-5-5", 0);
      expect(worker()).toBeUndefined();
    }
    const options: HandleResponsesOptions = {};
    const snapshot = capture(true, "root", "session", "caller", {}, options);
    options.shadowCallIntercepted = true;
    codexClaudeFastMode(config, snapshot, claude, "claude-opus-5-5", 0);
    expect(worker()).toBeUndefined();
  });

  test("older auth-delayed requests cannot undo a newer toggle or model switch", () => {
    const older = capture(true);
    root(false);
    codexClaudeFastMode(config, older, claude, "claude-opus-5-5", 0);
    expect(worker(true)).toBe(false);
    const delayed = capture(true);
    codexClaudeFastMode(config, capture(false), gpt, "gpt-6-astra", 0);
    codexClaudeFastMode(config, delayed, claude, "claude-opus-5-5", 0);
    expect(worker()).toBeUndefined();
  });

  test("a cold-tree model switch fences the first older Claude request", () => {
    const delayed = capture(true);
    codexClaudeFastMode(config, capture(false), gpt, "gpt-6-astra", 0);
    codexClaudeFastMode(config, delayed, claude, "claude-opus-5-5", 0);
    expect(worker()).toBeUndefined();
  });

  test("a native helper with missing metadata cannot create or release a tree", () => {
    const snapshot = () => captureCodexClaudeFastControl(request(), { model: "gpt-6-luna" }, config);
    codexClaudeFastMode(config, snapshot(), gpt, "gpt-6-luna", 0);
    root(true);
    codexClaudeFastMode(config, snapshot(), gpt, "gpt-6-luna", 0);
    expect(worker()).toBe(true);
  });

  test("turn metadata is frame-local on WebSocket and input snapshots survive mutation", () => {
    const req = request("root", "session", "caller", { "x-codex-turn-metadata": "bad upgrade metadata" });
    const body = {
      service_tier: "priority",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user" }) },
    };
    const snapshot = captureCodexClaudeFastControl(req, body, config, { inboundTransport: "websocket" });
    body.service_tier = "default";
    codexClaudeFastMode(config, snapshot, claude, "claude-opus-5-5", 0);
    expect(worker()).toBe(true);
  });

  test("TTL and capacity evict old trees without leaking another tree's intent", () => {
    root(true);
    expect(worker(false, "session", "caller", CODEX_CLAUDE_FAST_TTL_MS + 1)).toBeUndefined();
    root(true);
    for (let i = 0; i < CODEX_CLAUDE_FAST_MAX_TREES; i++) {
      codexClaudeFastMode(config, capture(true, "root", `session-${i}`), claude, "claude-opus-5-5", 0);
    }
    expect(worker()).toBeUndefined();
    expect(worker(false, "session-2047")).toBe(true);
  });

  test("opt-out, Messages, absent identity and global tier precedence", () => {
    const req = request();
    expect(captureCodexClaudeFastControl(req, {}, { codexClaudeFastSubagentsOnly: false })).toBeUndefined();
    expect(captureCodexClaudeFastControl(req, {}, config, { inboundWire: "messages" })).toBeUndefined();
    expect(captureCodexClaudeFastControl(new Request(req.url), {}, config)).toBeUndefined();
    expect(codexClaudeFastMode({ fastMode: true, codexClaudeFastSubagentsOnly: false },
      capture(false), claude, "claude-opus-5-5", 0)).toBe(true);
    root(false);
    expect(codexClaudeFastMode({ fastMode: true }, capture(true, "child"), gpt, "gpt-6-astra", 0)).toBe(false);
    root(true);
    expect(codexClaudeFastMode({ fastMode: false }, capture(false, "child"), gpt, "gpt-6-astra", 0)).toBe(true);
  });
});

async function normalized(model: string, tier: string | undefined, thread = "root") {
  const req = request(thread, "wire-session", "caller", thread === "root" ? {} : { "x-codex-parent-thread-id": "root" });
  const body = { model, input: "hi", stream: false, reasoning: { effort: "high" }, service_tier: tier };
  const control = captureCodexClaudeFastControl(req, body, config);
  const parsed = parseRequest(body);
  const route = routeModel(config, model);
  await applyFinalRouteRequestNormalization({
    parsed, route, config, req, logCtx: { model, provider: route.providerName }, inboundWire: "responses",
    codexFastControl: control,
  });
  return { parsed, route };
}

test("real normalization and serializers keep Claude standard and switch native GPT wire tiers", async () => {
  for (const enabled of [true, false, true]) {
    const parent = await normalized("anthropic-apikey/claude-opus-5-5", enabled ? "priority" : undefined);
    const outbound = await withTestTranslatorBudget(createAnthropicAdapter(parent.route.provider)).buildRequest(parent.parsed);
    expect(JSON.parse(String(outbound.body)).speed).toBeUndefined();
    expect(outbound.headers["anthropic-beta"] ?? "").not.toContain("fast-mode-2026-02-01");
    expect(parent.parsed.options.reasoning).toBe("high");
    expect(parent.parsed.options.tierObservation?.demandDecision).toBe("force-default");
    const child = await normalized("gpt-6-astra", enabled ? undefined : "priority", "child");
    const native = await withTestTranslatorBudget(createResponsesPassthroughAdapter(child.route.provider)).buildRequest(child.parsed);
    expect(JSON.parse(String(native.body)).service_tier).toBe(enabled ? "priority" : undefined);
  }
  const entry: RawEntry = {};
  applyCatalogModelMetadata(entry, {
    id: "claude-opus-5-5", provider: "anthropic-apikey",
    supportsServiceTier: serviceTierSupportForModel(claude, "claude-opus-5-5", "anthropic-apikey"),
  });
  expect(entry.service_tiers).toContainEqual(expect.objectContaining({ id: "priority", name: "Fast" }));
});

test("Responses ingress captures root intent before dropping the Claude outbound tier", async () => {
  const release = acquireOwnedSpendHome();
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: "msg-test", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, speed: "standard" },
    });
  }) as typeof fetch;
  try {
    for (const enabled of [true, false]) {
      const req = new Request(request("root", "wire-session"), {
        method: "POST", body: JSON.stringify({
          model: "anthropic-apikey/claude-opus-5-5", input: "hi", stream: false,
          ...(enabled ? { service_tier: "priority" } : {}),
        }),
      });
      const response = await handleResponses(req, config, { model: "", provider: "" }, {});
      await response.text();
      expect(response.status).toBe(200);
      expect(bodies.at(-1)?.speed).toBeUndefined();
      const child = await normalized("gpt-6-astra", enabled ? undefined : "priority", "child");
      expect(child.parsed.options.tierDecision).toEqual(enabled ? { kind: "set", value: "priority" } : { kind: "drop" });
      if (enabled) {
        const helperConfig = { ...config, shadowCallIntercept: {
          enabled: true, sourceModels: ["gpt-6-luna"], model: "anthropic-apikey/claude-opus-5-5",
        } };
        const helper = await handleResponses(new Request(request("root", "wire-session"), {
          method: "POST", body: JSON.stringify({ model: "gpt-6-luna", input: "title", stream: false }),
        }), helperConfig, { model: "", provider: "" }, {});
        await helper.text();
        expect(helper.status).toBe(200);
        const afterHelper = await normalized("gpt-6-astra", undefined, "child");
        expect(afterHelper.parsed.options.tierDecision).toEqual({ kind: "set", value: "priority" });
      }
    }
    expect(bodies).toHaveLength(3);
  } finally {
    release();
  }
});
