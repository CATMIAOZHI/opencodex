/**
 * OpenCode Go Muse Spark 1.2 Contributor context window regression.
 *
 * Muse Spark serves a 1,048,576-token (1M) context window over /responses on Zen Go,
 * matching its 1.1 sibling. The registry declared no modelContextWindows entry, so the
 * catalog fell back to the 128k unknown-window default and the Codex app capped real
 * usable context well below what the model supports. These tests lock the declaration
 * in and prove the catalog advertises the full 1M window for Muse.
 */
import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../../src/codex/catalog";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../src/providers/registry";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const MUSE_MODEL = "muse-spark-1.2-contributor";
const MUSE_13_MODEL = "muse-spark-1.3-contributor";
const MUSE_CONTEXT = 1_048_576;

/** Seeded OpenCode Go provider config for the Muse Spark context assertions. */
function opencodeGo(): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key" };
}

describe("OpenCode Go Muse Spark context window", () => {
  test("registry declares the 1M context window for Muse", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelContextWindows?.[MUSE_MODEL]).toBe(MUSE_CONTEXT);
  });

  test("the registry seed carries the 1M context window for Muse", () => {
    const prov = opencodeGo();
    expect(prov.modelContextWindows?.[MUSE_MODEL]).toBe(MUSE_CONTEXT);
  });

  test("applyProviderConfigHints exposes the 1M context window for Muse", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.contextWindow).toBe(MUSE_CONTEXT);
  });

  test("a discovered row with no window inherits the configured 1M window", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.contextWindow).toBe(MUSE_CONTEXT);
  });

  // 1.3 is the same-shaped successor on the same Zen Go roster. Without its own
  // entry it would fall back to the 128k unknown-window default — the same
  // regression these tests exist to prevent for 1.2.
  test("Muse Spark 1.3 Contributor declares and exposes the same 1M window", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelContextWindows?.[MUSE_13_MODEL]).toBe(MUSE_CONTEXT);
    const prov = opencodeGo();
    expect(prov.modelContextWindows?.[MUSE_13_MODEL]).toBe(MUSE_CONTEXT);
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_13_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.contextWindow).toBe(MUSE_CONTEXT);
  });

  test("a partial saved context map receives runtime registry keys without persisting defaults", () => {
    const entry = getProviderRegistryEntry("opencode-go")!;
    const saved = {
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      modelContextWindows: { "kimi-k3": 300_000 },
    } as OcxProviderConfig;

    enrichProviderFromRegistry("opencode-go", saved);

    expect(saved.modelContextWindows?.["kimi-k3"]).toBe(300_000);
    expect(saved.modelContextWindows?.[MUSE_MODEL]).toBeUndefined();
    const routed = routeModel({ providers: { "opencode-go": saved } } as OcxConfig, `opencode-go/${MUSE_MODEL}`);
    expect(routed.provider.modelContextWindows?.[MUSE_MODEL]).toBe(MUSE_CONTEXT);
    expect(routed.provider.modelContextWindows?.["kimi-k3"]).toBe(300_000);
  });
});
