export interface CostModel {
  model: string;
  provider: string;
  requests: number;
  estimatedCostUsd?: number;
}

export const costModelKey = (model: Pick<CostModel, "model" | "provider">) => JSON.stringify([model.provider, model.model]);

export function costModelOptions(days: CostDay[]) {
  return [...new Map(days.flatMap(day => (day.models ?? []).map(model => [costModelKey(model), model] as const))).values()]
    .sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
}

export interface CostDay {
  date: string;
  requests: number;
  estimatedCostUsd?: number;
  models?: CostModel[];
}

export function selectCostDays(days: CostDay[], start: string, end: string, modelKey = "") {
  return days.filter(day => day.date >= start && day.date <= end)
    .map(day => {
      if (!modelKey) return day;
      const model = day.models?.find(row => costModelKey(row) === modelKey);
      return {
        ...day,
        requests: model?.requests ?? 0,
        // A missing model on a known day is zero activity, not missing pricing.
        estimatedCostUsd: model ? model.estimatedCostUsd : day.models ? 0 : undefined,
      };
    }).toSorted((a, b) => b.date.localeCompare(a.date));
}
