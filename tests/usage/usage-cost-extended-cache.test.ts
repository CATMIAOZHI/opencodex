import { describe, expect, test } from "bun:test";
import { calculateCost, estimateComboCost, normalizeCostTokens } from "../../src/usage/cost";
import type { ExpectedPriceOverlay } from "../../src/usage/expected-prices";
const RATE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/**
 * Anthropic Extended Cache TTL. The catalog publishes only the 5-minute write rate (1.25x base
 * input), so a 1-hour write has to be repriced from it at 2x. These tests pin both halves of the
 * contract: the uplift lands in the row total, and a row without a split is untouched.
 */
describe("extended cache TTL (1-hour) write pricing", () => {
  const M = 1_000_000;

  test("1-hour writes bill at 2x base input while 5-minute writes stay at 1.25x", () => {
    // RATE.cacheWrite is 3.75 = 1.25 x 3, so the 1-hour rate is exactly 6 = 2 x 3.
    expect(calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: M }, RATE).cacheWrite)
      .toBeCloseTo(3.75, 12);
    expect(calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: M, cacheWrite1h: M }, RATE).cacheWrite)
      .toBeCloseTo(6, 12);
    const mixed = calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: M, cacheWrite1h: 400_000 }, RATE);
    expect(mixed.cacheWrite).toBeCloseTo(0.6 * 3.75 + 0.4 * 6, 12);
    // The uplift rides the existing bucket, so `total` keeps its definition.
    expect(mixed.total).toBeCloseTo(mixed.input + mixed.output + mixed.cacheRead + mixed.cacheWrite, 12);
  });

  test("the uplift is derived from the effective rate, so tier multipliers are inherited", () => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: M, cacheWrite1h: M };
    const doubled = { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 };
    expect(calculateCost(tokens, doubled).cacheWrite)
      .toBeCloseTo(calculateCost(tokens, RATE).cacheWrite * 2, 12);
  });

  test("an unpublished zero write rate never invents a 1-hour charge", () => {
    const free = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    expect(calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: M, cacheWrite1h: M }, free).cacheWrite)
      .toBe(0);
  });

  test("a row whose writes are entirely 1-hour is priced, not judged impossible", () => {
    // cacheRead + cacheWrite === input with the WHOLE write total flagged 1-hour. The conservation
    // check must keep reading only the total: counting the 1-hour share again would make this
    // legitimate row look contradictory and blank its price.
    expect(normalizeCostTokens({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 40,
      cacheCreation1hInputTokens: 40,
    })).toEqual({ input: 0, output: 10, cacheRead: 60, cacheWrite: 40, cacheWrite1h: 40 });
  });

  test("the split is carried as a subset and clamped to the write total", () => {
    expect(normalizeCostTokens({
      inputTokens: 100,
      outputTokens: 5,
      cacheCreationInputTokens: 40,
      cacheCreation1hInputTokens: 25,
    })).toEqual({ input: 60, output: 5, cacheRead: 0, cacheWrite: 40, cacheWrite1h: 25 });
    // Clamped rather than rejected: an overstated split must not erase the row's price.
    expect(normalizeCostTokens({
      inputTokens: 100,
      outputTokens: 5,
      cacheCreationInputTokens: 40,
      cacheCreation1hInputTokens: 900,
    })).toEqual({ input: 60, output: 5, cacheRead: 0, cacheWrite: 40, cacheWrite1h: 40 });
  });

  test("a row with no 1-hour split is bit-for-bit identical to before the field existed", () => {
    const withoutSplit = normalizeCostTokens({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 });
    expect(withoutSplit).toEqual({ input: 60, output: 10, cacheRead: 40, cacheWrite: 0 });
    expect(Object.keys(withoutSplit!).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
    // A known-zero split is not a reason to add the key either.
    expect(normalizeCostTokens({
      inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, cacheCreation1hInputTokens: 0,
    })).toEqual(withoutSplit);
    // An unusable count must not null the row: the totals are still trustworthy, so it prices as
    // an all-5-minute write exactly as it did before.
    expect(normalizeCostTokens({
      inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 20, cacheCreation1hInputTokens: Number.NaN,
    })).toEqual({ input: 80, output: 10, cacheRead: 0, cacheWrite: 20 });

    const splitFree = { input: 10, output: 20, cacheRead: 30, cacheWrite: M };
    expect(calculateCost({ ...splitFree, cacheWrite1h: 0 }, RATE).total)
      .toBe(calculateCost(splitFree, RATE).total);
  });

  test("a combo sums the 1-hour share and keeps the 4-key shape when no attempt has one", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "pa", modelId: "ma", cost4: RATE, source: "a", verifiedAt: "2026-10-12", status: "verified" },
    ];
    const combo = estimateComboCost([
      {
        ordinal: 1, provider: "pa", model: "ma", usageStatus: "reported",
        usage: { inputTokens: 400_000, outputTokens: 0, cacheCreationInputTokens: 400_000, cacheCreation1hInputTokens: 400_000 },
      },
      {
        ordinal: 2, provider: "pa", model: "ma", usageStatus: "reported",
        usage: { inputTokens: 600_000, outputTokens: 0, cacheCreationInputTokens: 600_000, cacheCreation1hInputTokens: 200_000 },
      },
    ], overlays);
    expect(combo!.tokens.cacheWrite).toBe(1_000_000);
    expect(combo!.tokens.cacheWrite1h).toBe(600_000);
    // 0.4 * 6 (all 1-hour) + (0.4 * 3.75 + 0.2 * 6) = 2.4 + 2.7
    expect(combo!.cost.total).toBeCloseTo(5.1, 9);

    const plain = estimateComboCost([
      { ordinal: 1, provider: "pa", model: "ma", usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 } },
    ], overlays);
    expect(Object.keys(plain!.tokens).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
  });
});
