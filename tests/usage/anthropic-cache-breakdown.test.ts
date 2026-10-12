import { describe, expect, test } from "bun:test";
import { anthropicCacheCreation1hTokens } from "../../src/usage/anthropic-cache-breakdown";

/**
 * The split decides whether a whole row's cache writes bill at 1.25x or 2x base input, so every
 * unusable shape has to fail closed to `undefined` — i.e. "no split", which leaves the caller on
 * the pre-existing 5-minute path rather than repricing on numbers we could not verify.
 */
describe("anthropic cache-creation 1-hour breakdown", () => {
  test("reads the 1-hour share out of the split", () => {
    expect(anthropicCacheCreation1hTokens(
      { cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 } },
      6,
    )).toBe(4);
    // The 5-minute sibling is optional: a 1-hour-only breakdown is still usable.
    expect(anthropicCacheCreation1hTokens({ cache_creation: { ephemeral_1h_input_tokens: 4 } }, 6)).toBe(4);
    // Present-and-zero is a known zero, not an absence.
    expect(anthropicCacheCreation1hTokens(
      { cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 0 } },
      6,
    )).toBe(0);
  });

  test("returns undefined when the upstream reported no usable split", () => {
    expect(anthropicCacheCreation1hTokens(undefined, 6)).toBeUndefined();
    expect(anthropicCacheCreation1hTokens(null, 6)).toBeUndefined();
    expect(anthropicCacheCreation1hTokens([], 6)).toBeUndefined();
    expect(anthropicCacheCreation1hTokens({}, 6)).toBeUndefined();
    expect(anthropicCacheCreation1hTokens({ cache_creation: null }, 6)).toBeUndefined();
    expect(anthropicCacheCreation1hTokens({ cache_creation: { ephemeral_5m_input_tokens: 2 } }, 6)).toBeUndefined();
  });

  test("discards a block that carries an unusable count instead of trusting half of it", () => {
    for (const bad of ["4", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(anthropicCacheCreation1hTokens({ cache_creation: { ephemeral_1h_input_tokens: bad } }, 6)).toBeUndefined();
      expect(anthropicCacheCreation1hTokens(
        { cache_creation: { ephemeral_5m_input_tokens: bad, ephemeral_1h_input_tokens: 4 } },
        6,
      )).toBeUndefined();
    }
  });

  test("discards a split that does not add up to the row's write total", () => {
    expect(anthropicCacheCreation1hTokens(
      { cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 4 } },
      6,
    )).toBeUndefined();
    // Exactly the total is fine: 5-minute + 1-hour may legitimately account for every write.
    expect(anthropicCacheCreation1hTokens(
      { cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 } },
      6,
    )).toBe(4);
  });

  test("never reports more 1-hour tokens than the write total", () => {
    // A 1-hour-only breakdown that overstates the total is clamped: the row's own write counter is
    // what the rest of the accounting is built from, so the share can only be a subset of it.
    expect(anthropicCacheCreation1hTokens({ cache_creation: { ephemeral_1h_input_tokens: 900 } }, 6)).toBe(6);
    expect(anthropicCacheCreation1hTokens(
      { cache_creation: { ephemeral_1h_input_tokens: 4 } },
      Number.NaN,
    )).toBeUndefined();
  });
});
