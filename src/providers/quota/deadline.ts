import type { OcxConfig } from "../../types";
import {
  getProviderQuotaReportCache, isProviderQuotaReportCurrent, LAST_GOOD_MAX_AGE_MS,
  providerQuotaCacheMatchesConfig, type ProviderQuotaProbeResult, type ProviderQuotaResponse,
} from "./report-cache";

/** Bound chained refresh/probe requests before the dashboard's 20-second timeout. */
export const PROVIDER_QUOTA_PROBE_DEADLINE_MS = 12_000;
export const PROVIDER_QUOTA_RESPONSE_DEADLINE_MS = 15_000;
let probeDeadlineMs = PROVIDER_QUOTA_PROBE_DEADLINE_MS;
let responseDeadlineMs = PROVIDER_QUOTA_RESPONSE_DEADLINE_MS;

export function setProviderQuotaProbeDeadlineForTests(ms: number): void { probeDeadlineMs = ms; }
export function resetProviderQuotaProbeDeadlineForTests(): void { probeDeadlineMs = PROVIDER_QUOTA_PROBE_DEADLINE_MS; }
export function setProviderQuotaResponseDeadlineForTests(ms: number): void { responseDeadlineMs = ms; }
export function resetProviderQuotaResponseDeadlineForTests(): void { responseDeadlineMs = PROVIDER_QUOTA_RESPONSE_DEADLINE_MS; }

async function beforeDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T | null> {
  if (!(deadlineMs > 0)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function boundedQuotaProbe(probe: Promise<ProviderQuotaProbeResult>): Promise<ProviderQuotaProbeResult> {
  return beforeDeadline(probe, probeDeadlineMs);
}

/** Let timed-out fan-out finish/cache in the background; serve only existing live rows. */
export async function boundProviderQuotaResponse(
  config: OcxConfig,
  fanOut: Promise<ProviderQuotaResponse>,
  deadlineMs = responseDeadlineMs,
): Promise<ProviderQuotaResponse> {
  const response = await beforeDeadline(fanOut.catch(() => null), deadlineMs);
  if (response) return response;
  const live = new Set(Object.entries(config.providers)
    .filter(([, provider]) => provider.disabled !== true).map(([name]) => name));
  const cache = getProviderQuotaReportCache();
  const now = Date.now();
  const reports = cache && providerQuotaCacheMatchesConfig(cache.key, config) ? cache.response.reports : [];
  return {
    generatedAt: now,
    reports: reports.filter(report => live.has(report.provider)
      && report.aggregation === undefined
      && (report.observed === true || now - report.updatedAt < LAST_GOOD_MAX_AGE_MS)
      && isProviderQuotaReportCurrent(report)),
  };
}
