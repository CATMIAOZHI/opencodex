import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota } from "../../src/codex/quota";
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  fetchProviderQuotaReportsBounded,
  resetProviderQuotaProbeDeadlineForTests,
  resetProviderQuotaResponseDeadlineForTests,
  setProviderQuotaProbeDeadlineForTests,
  setProviderQuotaResponseDeadlineForTests,
} from "../../src/providers/quota";
import { setProviderQuotaReportCache } from "../../src/providers/quota/report-cache";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome = "";

function a6apiConfig(): OcxConfig {
  return {
    defaultProvider: "a6api",
    providers: {
      a6api: { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.a6api.com/v1", apiKey: "a6api-secret" },
    },
  } as OcxConfig;
}

/** A quota body that only the A6API reader understands; both of its endpoints share it. */
function a6apiBody(url: string): string {
  return JSON.stringify(url.includes("subscription")
    ? { data: { hard_limit_usd: 10 } }
    : { data: { total_granted: 100, total_used: 20, total_available: 80 } });
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-deadline-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearAccountQuota();
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetProviderQuotaProbeDeadlineForTests();
  resetProviderQuotaResponseDeadlineForTests();
  clearAccountQuota();
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
});

describe("bounded provider quota fan-out", () => {
  test("a stalled provider probe cannot hold the fan-out past its deadline", async () => {
    let stalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (stalled) return await new Promise<Response>(() => {});
      return new Response(a6apiBody(String(input)), { status: 200 });
    }) as typeof fetch;
    const config = a6apiConfig();
    const valid = await fetchProviderQuotaReports(config, true);
    expect(valid.reports).toHaveLength(1);

    stalled = true;
    setProviderQuotaProbeDeadlineForTests(50);
    const started = Date.now();
    const timedOut = await fetchProviderQuotaReports(config, true);

    // The dashboard aborts at 20s; one stalled provider must not consume that budget.
    expect(Date.now() - started).toBeLessThan(5_000);
    // A probe that told us nothing keeps the last-good row instead of dropping it.
    expect(timedOut.reports).toEqual(valid.reports);
  });

  test("the bounded dashboard read answers on time with the last-good rows", async () => {
    let stalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (stalled) return await new Promise<Response>(() => {});
      return new Response(a6apiBody(String(input)), { status: 200 });
    }) as typeof fetch;
    const config = a6apiConfig();
    const valid = await fetchProviderQuotaReports(config, true);
    expect(valid.reports).toHaveLength(1);
    const live = valid.reports[0]!;

    // The Codex pool snapshot read happens before any probe timeout applies, so the read as a
    // whole needs its own budget. Seed a retired row beside the live one to prove the fallback
    // never resurrects a provider this config no longer has.
    stalled = true;
    setProviderQuotaResponseDeadlineForTests(60);
    setProviderQuotaReportCache({
      key: "seeded",
      ts: Date.now(),
      response: {
        generatedAt: Date.now(),
        reports: [live, { ...live, provider: "retired-provider" }],
      },
    });
    const started = Date.now();
    const bounded = await fetchProviderQuotaReportsBounded(config, true);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(bounded.reports.map(report => report.provider)).toEqual([live.provider]);
  });
});
