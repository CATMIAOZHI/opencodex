import { useEffect, useState } from "react";
import { useI18n } from "../i18n/shared";
import { formatEstimatedUsdValue } from "../intl-formatters";
import { selectCostDays, costModelOptions, costModelKey, type CostDay } from "../usage-cost-days";
import { formatProviderDisplayName } from "../provider-icons";

export default function UsageDailyCosts({ days, loadDays }: {
  days: CostDay[];
  loadDays?: (startTime: number, endTime: number, signal: AbortSignal) => Promise<CostDay[]>;
}) {
  const { t } = useI18n();
  const dates = days.map(day => day.date).sort();
  const min = dates[0] ?? "";
  const max = dates.at(-1) ?? "";
  const [selection, setSelection] = useState({ start: "", end: "" });
  const [model, setModel] = useState("");
  const models = costModelOptions(days);
  const activeModel = models.some(row => costModelKey(row) === model) ? model : "";
  // Clamp held selections when the report range or source changes.
  const clamp = (value: string, fallback: string) => value
    ? (value < `${min}T00:00` ? `${min}T00:00` : value > `${max}T23:59` ? `${max}T23:59` : value)
    : fallback;
  const start = clamp(selection.start, `${max}T00:00`);
  const end = clamp(selection.end, `${max}T23:59`);
  const queryKey = `${start}/${end}`;
  const [remote, setRemote] = useState<{ key: string; days?: CostDay[]; error?: boolean } | null>(null);
  useEffect(() => {
    if (!loadDays || !max || start > end) return;
    const controller = new AbortController();
    // Editing a date/time may emit several intermediate values; scan only after it settles.
    const timer = setTimeout(() => {
      loadDays(new Date(start).getTime(), new Date(end).getTime() + 60_000, controller.signal)
        .then(rows => { if (!controller.signal.aborted) setRemote({ key: queryKey, days: rows }); })
        .catch(() => { if (!controller.signal.aborted) setRemote({ key: queryKey, error: true }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [start, end, max, queryKey, loadDays]);
  const ready = !loadDays || remote?.key === queryKey;
  const failed = ready && remote?.error;
  const selected = loadDays
    ? selectCostDays(remote?.key === queryKey ? remote.days ?? [] : [], "", "\uffff", activeModel)
    : selectCostDays(days, start.slice(0, 10), end.slice(0, 10), activeModel);
  const known = selected.every(day => Number.isFinite(day.estimatedCostUsd));
  const total = selected.reduce((sum, day) => sum + (day.estimatedCostUsd ?? 0), 0);
  return (
    <section className="usw-section" aria-labelledby="usage-daily-title">
      <h3 id="usage-daily-title">{t("usage.daily.title")}</h3>
      {days.length === 0 ? <p className="muted">{t("usage.empty")}</p> : <>
        <p className="muted">{t("usage.daily.window", { start: min, end: max })}</p>
        <p className="muted">{t("usage.daily.timezone", { zone: new Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>
        <div className="usage-date-controls">
          <label>{t("usage.section.models")}<select value={activeModel} onChange={event => setModel(event.target.value)}>
            <option value="">{t("sub.workspace.allModels")}</option>
            {models.map(row => <option key={costModelKey(row)} value={costModelKey(row)}>{`${row.model} · ${formatProviderDisplayName(row.provider, t)}`}</option>)}
          </select></label>
          <label>{t("usage.daily.start")}<input type="datetime-local" step={60} min={`${min}T00:00`} max={end} value={start}
            onChange={event => setSelection({ start: event.target.value, end })} /></label>
          <label>{t("usage.daily.end")}<input type="datetime-local" step={60} min={start} max={`${max}T23:59`} value={end}
            onChange={event => setSelection({ start, end: event.target.value })} /></label>
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setSelection({ start: `${min}T00:00`, end: `${max}T23:59` })}>{t("usage.daily.full")}</button>
        </div>
        {start > end ? <p role="alert">{t("usage.daily.invalid")}</p> : !ready ? <p role="status">{t("common.loading")}</p> : failed ? <p role="alert">{t("usage.loadError")}</p> : <>
          <p className="usage-date-total" aria-live="polite">{t("usage.daily.total")} <strong>{known ? formatEstimatedUsdValue(total) : "—"}</strong></p>
          <p className="muted">{t("usage.daily.note")}</p>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>{t("usage.daily.date")}</th><th>{t("usage.daily.requests")}</th><th>{t("usage.daily.amount")}</th></tr></thead>
            <tbody>{selected.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.requests}</td><td>{Number.isFinite(day.estimatedCostUsd) ? formatEstimatedUsdValue(day.estimatedCostUsd!) : "—"}</td></tr>)}</tbody>
          </table></div>
        </>}
      </>}
    </section>
  );
}
