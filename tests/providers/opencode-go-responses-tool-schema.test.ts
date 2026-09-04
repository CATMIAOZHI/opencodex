import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { enrichProviderFromRegistry } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

function buildBody(
  provider: OcxProviderConfig,
  tools: unknown[],
): Record<string, unknown> {
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  return JSON.parse(adapter.buildRequest({
    modelId: "muse-spark-1.2-contributor",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "muse-spark-1.2-contributor",
      input: [],
      tools,
    },
  }, { headers: new Headers() }).body) as Record<string, unknown>;
}

describe("OpenCode Go strict Responses tool schemas", () => {
  test("registry capability reaches both saved-provider enrichment and routing", () => {
    const entry = getProviderRegistryEntry("opencode-go")!;
    expect(entry.strictResponsesToolSchemas).toBe(true);
    expect(entry.supportsResponsesCustomTools).toBe(false);
    expect(entry.modelReasoningEfforts?.["muse-spark-1.2-contributor"])
      .toEqual(["low", "medium", "high", "xhigh", "max"]);

    const saved = {
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
    } as OcxProviderConfig;
    enrichProviderFromRegistry("opencode-go", saved);
    expect(saved.strictResponsesToolSchemas).toBe(true);
    expect(saved.supportsResponsesCustomTools).toBe(false);

    const explicit = {
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      strictResponsesToolSchemas: false,
      supportsResponsesCustomTools: true,
    } as OcxProviderConfig;
    enrichProviderFromRegistry("opencode-go", explicit);
    expect(explicit.strictResponsesToolSchemas).toBe(false);
    expect(explicit.supportsResponsesCustomTools).toBe(true);

    const routed = routeModel({
      port: 0,
      defaultProvider: "opencode-go",
      providers: {
        "opencode-go": {
          adapter: entry.adapter,
          baseUrl: entry.baseUrl,
          apiKey: "test-key",
        },
      },
    } as OcxConfig, "opencode-go/muse-spark-1.2-contributor");
    expect(routed.provider.strictResponsesToolSchemas).toBe(true);
    expect(routed.provider.supportsResponsesCustomTools).toBe(false);
  });

  test("completes required arrays for every final function schema", () => {
    const body = buildBody({
      adapter: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "test-key",
      strictResponsesToolSchemas: true,
      supportsResponsesCustomTools: false,
    }, [
      {
        type: "function",
        name: "list_threads",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            options: {
              type: "object",
              properties: { offset: { type: "integer" } },
              required: [],
            },
          },
          required: [],
        },
      },
      {
        type: "function",
        name: "no_arguments",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      {
        type: "function",
        name: "schema_keyword_property",
        parameters: {
          type: "object",
          properties: {
            properties: { type: "string" },
          },
          required: [],
        },
      },
      {
        type: "namespace",
        name: "workspace",
        tools: [{
          type: "function",
          name: "search_messages",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "integer" },
            },
            required: ["query"],
          },
        }],
      },
      {
        type: "tool_search",
        execution: "client",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
    ]);
    const tools = body.tools as Array<{
      type: string;
      name?: string;
      parameters?: { properties?: Record<string, unknown>; required?: string[] };
    }>;

    const functions = tools.filter(tool => tool.type === "function");
    expect(functions.length).toBeGreaterThanOrEqual(3);
    for (const tool of functions) {
      const properties = Object.keys(tool.parameters?.properties ?? {});
      expect(tool.parameters?.required).toEqual(properties);
    }
    const listThreads = functions.find(tool => tool.name === "list_threads");
    const options = listThreads?.parameters?.properties?.options as
      | { required?: string[] }
      | undefined;
    expect(options?.required).toEqual(["offset"]);
    expect(functions.find(tool => tool.name === "no_arguments")?.parameters?.required)
      .toEqual([]);
    const keywordProperty = functions.find(tool => tool.name === "schema_keyword_property");
    expect(keywordProperty?.parameters?.required).toEqual(["properties"]);
    expect(keywordProperty?.parameters?.properties).toEqual({
      properties: { type: "string" },
    });
  });

  test("leaves lenient required arrays untouched when capability is disabled", () => {
    const body = buildBody({
      adapter: "openai-responses",
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
    }, [{
      type: "function",
      name: "list_threads",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer" } },
        required: [],
      },
    }]);
    const tools = body.tools as Array<{ parameters?: { required?: string[] } }>;
    expect(tools[0]?.parameters?.required).toEqual([]);
  });
});
