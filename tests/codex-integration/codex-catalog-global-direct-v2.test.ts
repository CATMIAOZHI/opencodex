import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../../src/codex/catalog";

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
  };
}

describe("global Codex catalog tool policy", () => {
  test("writes direct tool mode and V2 collaboration to every generated row", () => {
    const entries = buildCatalogEntries(
      template() as Parameters<typeof buildCatalogEntries>[0],
      ["gpt-5.6-sol"],
      [
        { provider: "opencode-go", id: "deepseek-v4-flash" },
        { provider: "xai", id: "grok-4.6" },
        { provider: "opencode-go", id: "glm-5.2" },
        { provider: "opencode-go", id: "muse-spark-1.2-contributor" },
      ],
      undefined,
      false,
      "v1",
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.multi_agent_version).toBe("v2");
      expect(entry.tool_mode).toBe("direct");
    }
  });
});
