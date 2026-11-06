import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { LanguageProvider } from "../src/i18n/provider";
import UsageDailyCosts from "../src/pages/UsageDailyCosts";
import { selectCostDays, costModelKey, costModelOptions, type CostDay } from "../src/usage-cost-days";

const days = [
  { date: "2026-09-07", requests: 2, estimatedCostUsd: 1.25 },
  { date: "2026-09-08", requests: 3, estimatedCostUsd: 2.5 },
  { date: "2026-09-09", requests: 4, estimatedCostUsd: 4 },
];

test("model filtering isolates providers and preserves unavailable prices", () => {
  const model = { model: "same", provider: "one", requests: 2, estimatedCostUsd: 3 };
  const rows: CostDay[] = [
    { date: "2026-09-07", requests: 5, estimatedCostUsd: 9, models: [model, { ...model, provider: "two", requests: 3, estimatedCostUsd: 6 }] },
    { date: "2026-09-08", requests: 1, models: [{ ...model, requests: 1, estimatedCostUsd: undefined }] },
    { date: "2026-09-09", requests: 0, estimatedCostUsd: 0, models: [] },
  ];
  expect(costModelOptions(rows)).toHaveLength(2);
  const filtered = selectCostDays(rows, "2026-09-07", "2026-09-09", costModelKey(model));
  expect(filtered.map(row => [row.requests, row.estimatedCostUsd])).toEqual([[0, 0], [1, undefined], [2, 3]]);
});

test("daily cost selection includes both boundaries without converting proxy dates", () => {
  expect(selectCostDays(days, "2026-09-07", "2026-09-08").map(d => d.date)).toEqual(["2026-09-08", "2026-09-07"]);
  expect(selectCostDays(days, "2026-09-08", "2026-09-08")).toEqual([days[1]]);
  expect(selectCostDays(days, "2026-09-09", "2026-09-07")).toEqual([]);
});

test("daily report defaults to latest day, totals available dates and clamps on range change", async () => {
  const keys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  const win = new Window({ url: "http://localhost/" });
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, key) });
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const render = async (rows: CostDay[], loadDays?: (start: number, end: number, signal: AbortSignal) => Promise<CostDay[]>) => {
    await act(async () => { root.render(createElement(LanguageProvider, null, createElement(UsageDailyCosts, { days: rows, loadDays }))); });
  };
  try {
    await render(days);
    expect(container.querySelector("tbody")?.textContent).toContain("2026-09-09");
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect(container.querySelector("strong")?.textContent).toBe("~$4.0000");
    await act(async () => { (container.querySelector("button") as unknown as HTMLButtonElement).click(); });
    expect(container.querySelectorAll("tbody tr").length).toBe(3);
    expect(container.querySelector("strong")?.textContent).toBe("~$7.7500");
    await render([days[2]]);
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect(container.querySelector("strong")?.textContent).toBe("~$4.0000");
    await render([{ date: "2026-09-09", requests: 2 }]);
    expect(container.querySelector("strong")?.textContent).toBe("—");
    await render([]);
    expect(container.querySelector("table")).toBeNull();
    let bounds: number[] = [];
    const modelRows = [{ ...days[2], models: [{ model: "test-model", provider: "one", requests: 1, estimatedCostUsd: 0.5 }] }];
    await render(modelRows, async (start, end) => { bounds = [start, end]; return modelRows; });
    expect(container.querySelector("strong")).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(bounds).toEqual([new Date("2026-09-09T00:00").getTime(), new Date("2026-09-10T00:00").getTime()]);
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = costModelKey(modelRows[0].models[0]);
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    expect(container.querySelector("strong")?.textContent).toBe("~$0.5000");
    await render(modelRows, async () => { throw new Error("offline"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    win.close();
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  }
});
