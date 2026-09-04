import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, mergeCatalogEntriesFromObservedState } from "../../src/codex/catalog";
import { UPSTREAM_NATIVE_ENTRIES } from "../../src/codex/catalog/metadata";
import { applyDeepSeekV4CodexProfiles } from "../../src/codex/catalog/parsing";

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, an agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex." },
    tool_mode: "code",
    use_responses_lite: true,
  };
}

function expectDeepSeekV4Profile(entry: Record<string, unknown>): void {
  const promptSource = UPSTREAM_NATIVE_ENTRIES.get("gpt-5.6-sol")!;
  expect(entry.model_messages).toEqual(promptSource.model_messages);
  expect(entry.base_instructions).toEqual(promptSource.base_instructions);
  expect(entry.tool_mode).toBe("direct");
  expect(entry.multi_agent_version).toBe("v2");
  expect(entry.use_responses_lite).toBe(false);
  expect(entry.include_skills_usage_instructions).toBe(false);
  expect(entry.include_plugin_usage_instructions).toBe(false);
  expect(entry.include_apps_usage_instructions).toBe(false);
}

describe("DeepSeek V4 Codex catalog profile", () => {
  test("copies prompt fields from the pinned native Sol snapshot, not a same-slug alias", () => {
    const shadowingAlias = {
      slug: "gpt-5.6-sol",
      owned_by: "combo",
      base_instructions: "shadowing alias base prompt",
      model_messages: {
        instructions_template: "shadowing alias model prompt",
      },
    };
    const routed: Record<string, unknown> = { slug: "opencode-go/deepseek-v4-flash" };

    applyDeepSeekV4CodexProfiles([shadowingAlias, routed]);

    const promptSource = UPSTREAM_NATIVE_ENTRIES.get("gpt-5.6-sol")!;
    expect(routed.base_instructions).toBe(promptSource.base_instructions);
    expect(routed.model_messages).toEqual(promptSource.model_messages);
    expect(routed.base_instructions).not.toBe(shadowingAlias.base_instructions);
  });

  test("profiles both native-id and vendor-qualified DeepSeek routes", () => {
    const entries = buildCatalogEntries(
      template() as Parameters<typeof buildCatalogEntries>[0],
      [],
      [
        { provider: "opencode-go", id: "deepseek-v4-pro" },
        { provider: "opencode-go", id: "deepseek-v4-flash" },
        { provider: "commandcode", id: "deepseek/deepseek-v4-pro" },
        { provider: "commandcode", id: "deepseek/deepseek-v4-flash" },
        { provider: "opencode-go", id: "glm-5.2" },
      ],
      undefined,
      false,
      "v1",
    ) as Array<Record<string, unknown>>;
    const bySlug = new Map(entries.map(entry => [entry.slug, entry]));

    for (const slug of [
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4-flash",
      "commandcode/deepseek-deepseek-v4-pro",
      "commandcode/deepseek-deepseek-v4-flash",
    ]) {
      expectDeepSeekV4Profile(bySlug.get(slug)!);
    }

    const ordinaryRouted = bySlug.get("opencode-go/glm-5.2")!;
    expect(ordinaryRouted.tool_mode).toBe("direct");
    expect(ordinaryRouted.multi_agent_version).toBe("v2");
  });

  test("reapplies the profile to retained routed rows after merge processing", () => {
    const merged = mergeCatalogEntriesFromObservedState({
      catalogModels: [],
      baselineCatalogModels: [],
      routedEntries: [{
        slug: "opencode-go/deepseek-v4-flash",
        description: "Routed via opencodex.",
        visibility: "list",
        base_instructions: "stale prompt",
        model_messages: { instructions_template: "stale prompt" },
        tool_mode: "code_mode_only",
        multi_agent_version: "v1",
        use_responses_lite: true,
      }],
      baseline: new Map(),
      featured: [],
      wsEnabled: false,
      template: null,
      disabledModels: new Set(),
      selectedModelsByProvider: new Map(),
      gatheredProviderNames: new Set(["opencode-go"]),
      degradedProviderNames: new Set(),
      legacyCustomModelSlugs: new Set(),
      multiAgentMode: "v1",
      multiAgentV2Enabled: false,
      exactComboSlugs: new Set(),
      hasPhysicalComboProvider: false,
      includeNativeOpenAi: false,
      accountBoundEntries: [],
      policy: {
        nativeBackfillSlugs: [],
        unsupportedNativeEntries: "drop",
        warningPolicy: "suppress",
      },
    });

    expectDeepSeekV4Profile(
      merged.find(entry => entry.slug === "opencode-go/deepseek-v4-flash")!,
    );
  });
});
