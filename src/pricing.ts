import { LOCAL_MODEL_PRICING, PRICING_ALIASES, type PricePeriod, type PriceRates } from "./pricing-data";

export interface RequestUsage {
  // Uncached prompt tokens (Antigravity reports cache reads and writes separately).
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Billed output, thinking included.
  outputTokens: number;
}

const MILLION = 1_000_000;

export function hasPricing(model: string): boolean {
  return resolvePricingKey(model) !== undefined;
}

/** Returns the price period in effect for `model` at `timestampMs`, or null if unpriced. */
export function getPricePeriod(model: string, timestampMs: number): PricePeriod | null {
  const key = resolvePricingKey(model);
  if (!key) return null;
  const periods = LOCAL_MODEL_PRICING[key];
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  let current = periods[0];
  for (const period of periods) {
    if (!period.effectiveFrom || period.effectiveFrom <= day) {
      current = period;
    }
  }
  return current ?? null;
}

/** Cost of one request in USD, or null when the model has no known price. */
export function calculateRequestCostUSD(model: string, timestampMs: number, usage: RequestUsage): number | null {
  const period = getPricePeriod(model, timestampMs);
  if (!period) return null;

  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const longContext = period.longContextPricing;
  const rates: PriceRates =
    longContext && promptTokens > longContext.promptTokenThreshold ? longContext : period;

  return (
    (usage.inputTokens * rates.inputCostPerMToken +
      usage.cacheReadTokens * rates.cachedInputCostPerMToken +
      usage.cacheWriteTokens * (rates.cacheWriteCostPerMToken ?? 0) +
      usage.outputTokens * rates.outputCostPerMToken) /
    MILLION
  );
}

function resolvePricingKey(model: string): string | undefined {
  if (LOCAL_MODEL_PRICING[model]) return model;
  const alias = PRICING_ALIASES[model];
  if (alias && LOCAL_MODEL_PRICING[alias]) return alias;
  // Preview builds share the GA price ("gemini-3.8-flash-preview" -> "gemini-3.8-flash").
  const withoutPreview = model.replace(/-preview(-\d{2}-\d{4})?$/, "");
  if (withoutPreview !== model && LOCAL_MODEL_PRICING[withoutPreview]) return withoutPreview;
  return undefined;
}
