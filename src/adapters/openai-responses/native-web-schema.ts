import { isPlainObject } from "./internal";

/**
 * The native Sol 6.2 backend rejects the Desktop's optional literature-search
 * extension to its reserved web.run schema. A 2026-11-18 paired request verified
 * that removing this property alone changes the response from 400 to 200.
 */
function normalizeWebNamespace(value: unknown): unknown {
  if (!isPlainObject(value) || value.type !== "namespace"
    || value.name !== "web" || !Array.isArray(value.tools)) return value;
  let changed = false;
  const tools = value.tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "function" || tool.name !== "run"
      || !isPlainObject(tool.parameters) || !isPlainObject(tool.parameters.properties)
      || !Object.hasOwn(tool.parameters.properties, "literature_search_query")
      || (Array.isArray(tool.parameters.required)
        && tool.parameters.required.includes("literature_search_query"))) return tool;
    const { literature_search_query: _unsupported, ...properties } = tool.parameters.properties;
    changed = true;
    return { ...tool, parameters: { ...tool.parameters, properties } };
  });
  return changed ? { ...value, tools } : value;
}

function normalizeCatalog(tools: unknown[]): unknown[] {
  let changed = false;
  const normalized = tools.map(tool => {
    const next = normalizeWebNamespace(tool);
    changed ||= next !== tool;
    return next;
  });
  return changed ? normalized : tools;
}

/** Called only for canonical ChatGPT forwarding, before HTTP/WS serialization. */
export function normalizeNativeSolWebSchema(body: unknown): unknown {
  if (!isPlainObject(body) || body.model !== "gpt-6.2-sol") return body;
  const tools = Array.isArray(body.tools) ? normalizeCatalog(body.tools) : body.tools;
  let input = body.input;
  if (Array.isArray(body.input)) {
    let changed = false;
    const normalized = body.input.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const next = normalizeCatalog(item.tools);
      if (next === item.tools) return item;
      changed = true;
      return { ...item, tools: next };
    });
    if (changed) input = normalized;
  }
  if (tools === body.tools && input === body.input) return body;
  return {
    ...body,
    ...(tools !== body.tools ? { tools } : {}),
    ...(input !== body.input ? { input } : {}),
  };
}
