import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { normalizeNativeSolWebSchema } from "../../src/adapters/openai-responses/native-web-schema";
import { parseRequest } from "../../src/responses/parser";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

function webNamespace() {
  return {
    type: "namespace", name: "web", description: "Web tools",
    tools: [{
      type: "function", name: "run", strict: false, description: "Search the web",
      parameters: {
        type: "object",
        properties: {
          search_query: { type: "array", items: { type: "object", properties: { q: { type: "string" } } } },
          literature_search_query: { type: "array", items: { type: "object" } },
          response_length: { type: "string", enum: ["short", "medium", "long"] },
        },
      },
    }],
  };
}

function body(model = "gpt-6.2-sol") {
  return {
    model, stream: true, tool_choice: "auto", store: false,
    tools: [webNamespace()],
    input: [
      { type: "additional_tools", role: "developer", id: "tools_snapshot", tools: [webNamespace()] },
      { role: "user", content: "Reply OK" },
    ],
  };
}

describe("native Sol reserved web.run compatibility", () => {
  test("normalizes top-level and additional tool catalogs without changing the caller", () => {
    const original = body();
    const before = JSON.stringify(original);
    const normalized = normalizeNativeSolWebSchema(original) as ReturnType<typeof body>;
    expect(normalized.tools[0]!.tools[0]!.parameters.properties).toEqual({
      search_query: original.tools[0]!.tools[0]!.parameters.properties.search_query,
      response_length: original.tools[0]!.tools[0]!.parameters.properties.response_length,
    });
    expect(normalized.input[0]!.tools![0]!.tools[0]!.parameters.properties)
      .not.toHaveProperty("literature_search_query");
    expect(normalized.input[0]).toMatchObject({ id: "tools_snapshot", role: "developer" });
    expect(normalized.tools[0]!.tools[0]).toMatchObject({ name: "run", strict: false, description: "Search the web" });
    expect(JSON.stringify(original)).toBe(before);
    expect(normalizeNativeSolWebSchema(normalized)).toBe(normalized);
  });

  test("keeps other models, namespaces, methods and required extensions unchanged", () => {
    for (const model of ["gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol-custom"]) {
      const original = body(model);
      expect(normalizeNativeSolWebSchema(original)).toBe(original);
    }
    for (const change of [
      (web: ReturnType<typeof webNamespace>) => { web.name = "custom_web"; },
      (web: ReturnType<typeof webNamespace>) => { web.tools[0]!.name = "custom_run"; },
      (web: ReturnType<typeof webNamespace>) => {
        Object.assign(web.tools[0]!.parameters, { required: ["literature_search_query"] });
      },
    ]) {
      const web = webNamespace();
      change(web);
      const original = { model: "gpt-6.2-sol", tools: [web] };
      expect(normalizeNativeSolWebSchema(original)).toBe(original);
    }
  });

  test("the production adapter applies it only on canonical forwarding and restores no tool aliases", () => {
    const original = body();
    const native = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses", authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }));
    const forwarded = JSON.parse(native.buildRequest(parseRequest(original), { headers: new Headers() }).body);
    expect(forwarded.tools[0].name).toBe("web");
    expect(forwarded.tools[0].tools[0].name).toBe("run");
    expect(forwarded.tools[0].tools[0].parameters.properties).not.toHaveProperty("literature_search_query");
    expect(forwarded.input[0].tools[0].tools[0].parameters.properties).not.toHaveProperty("literature_search_query");

    const custom = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses", authMode: "key", apiKey: "fixture",
      baseUrl: "https://gateway.example.invalid/v1",
    }));
    const routed = JSON.parse(custom.buildRequest(parseRequest(original), { headers: new Headers() }).body);
    expect(routed.tools.find((tool: { name: string }) => tool.name === "web__run").parameters.properties)
      .toHaveProperty("literature_search_query");
  });
});
