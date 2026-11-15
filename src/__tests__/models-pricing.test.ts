import { describe, expect, test } from "bun:test";

import { getAntigravityDisplayName, modelFromId, normalizeAntigravityModel } from "../antigravity-models";
import { calculateRequestCostUSD, getPricePeriod, hasPricing } from "../pricing";

describe("normalizeAntigravityModel", () => {
  test.each([
    ["gemini-3.7-flash", "gemini-3.7-flash"],
    ["Gemini 3.7 Flash (High)", "gemini-3.7-flash"],
    ["Gemini 4 Carbon (Medium)", "gemini-4-carbon"],
    ["gemini-4-argon-trial", "gemini-4-argon"],
    ["gemini-4-carbon-high", "gemini-4-carbon"],
    ["gemini-3.7-flash-tiered", "gemini-3.7-flash"],
    ["gemini-3.5-flash-extra-low", "gemini-3.5-flash"],
    ["gemini-3.1-pro-low-thinking", "gemini-3.1-pro"],
    ["gemini-3-pro-high", "gemini-3-pro"],
    ["gemini-pro-agent", "gemini-3.1-pro"],
    ["gemini-3-flash-agent-a", "gemini-3.5-flash"],
    ["gemini-3-flash", "gemini-3-flash-preview"],
    ["MODEL_PLACEHOLDER_M298", "gemini-3.7-flash"],
    ["MODEL_PLACEHOLDER_M187", "gemini-3.5-flash"],
    ["claude-opus-5-5-max", "claude-opus-5-5"],
    ["Claude Sonnet 5.5 (High)", "claude-sonnet-5-5"],
    ["claude-sonnet-4-5-thinking", "claude-sonnet-4-5"],
    ["gemini-claude-opus-4-5-thinking", "claude-opus-4-5"],
    ["claude-4.5-sonnet", "claude-sonnet-4-5"],
    ["antigravity-claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["gpt-oss-120b-medium", "gpt-oss-120b"],
    ["openai/gpt-oss-120b-maas", "gpt-oss-120b"],
    ["MODEL_OPENAI_GPT_OSS_120B_MEDIUM", "gpt-oss-120b"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeAntigravityModel(raw)).toBe(expected);
  });

  test("unresolvable placeholders and blanks return undefined", () => {
    expect(normalizeAntigravityModel("MODEL_PLACEHOLDER_M999")).toBeUndefined();
    expect(normalizeAntigravityModel("  ")).toBeUndefined();
    expect(normalizeAntigravityModel(undefined)).toBeUndefined();
  });

  test("maps internal model IDs", () => {
    expect(modelFromId(1298)).toBe("gemini-3.7-flash");
    expect(modelFromId(1418)).toBe("gemini-4-argon");
    expect(modelFromId(1427)).toBe("gemini-4-carbon");
    expect(modelFromId(1050)).toBe("gemini-3.1-flash-lite");
    expect(modelFromId(9999)).toBeUndefined();
  });

  test("display names", () => {
    expect(getAntigravityDisplayName("gemini-3.7-flash")).toBe("Gemini 3.7 Flash");
    expect(getAntigravityDisplayName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(getAntigravityDisplayName("claude-sonnet-4")).toBe("Claude Sonnet 4");
    expect(getAntigravityDisplayName("gpt-oss-120b")).toBe("GPT-OSS 120B");
    expect(getAntigravityDisplayName("antigravity-model-1999")).toBe("Unknown model #1999");
  });
});

describe("pricing", () => {
  const nov = Date.UTC(2026, 10, 15);
  const dec = Date.UTC(2026, 11, 1);
  const jan27 = Date.UTC(2027, 0, 1);

  test("every normalized Antigravity model in the ID table has a price", () => {
    for (const id of [246, 312, 330, 281, 290, 333, 340, 342, 1016, 1018, 1020, 1026, 1035, 1050, 1071, 1132, 1298, 1318, 1402, 1417, 1427]) {
      expect(hasPricing(modelFromId(id)!)).toBe(true);
    }
  });

  test("applies dated price changes", () => {
    expect(getPricePeriod("gemini-4-carbon", nov)?.inputCostPerMToken).toBe(2);
    expect(getPricePeriod("gemini-4-carbon", dec)?.inputCostPerMToken).toBe(4);
    expect(getPricePeriod("gemini-3.8-flash", Date.UTC(2026, 11, 31, 23))?.outputCostPerMToken).toBe(3.75);
    expect(getPricePeriod("gemini-3.8-flash", jan27)?.outputCostPerMToken).toBe(7.5);
  });

  test("bills the whole request at long-context rates above the threshold", () => {
    const small = calculateRequestCostUSD("gemini-3.1-pro", nov, {
      inputTokens: 100_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    expect(small).toBeCloseTo((100_000 * 2 + 100_000 * 0.2 + 1_000 * 12) / 1e6, 12);

    const large = calculateRequestCostUSD("gemini-3.1-pro", nov, {
      inputTokens: 100_000,
      cacheReadTokens: 100_001,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    expect(large).toBeCloseTo((100_000 * 4 + 100_001 * 0.4 + 1_000 * 18) / 1e6, 12);
  });

  test("charges Claude cache writes", () => {
    const cost = calculateRequestCostUSD("claude-opus-5-5", nov, {
      inputTokens: 1_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo((1_000 * 4 + 10_000 * 0.2 + 2_000 * 5 + 500 * 20) / 1e6, 12);
  });

  test("unknown models are unpriced", () => {
    expect(calculateRequestCostUSD("gemini-3.1-ultra", nov, {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
    })).toBeNull();
  });
});
