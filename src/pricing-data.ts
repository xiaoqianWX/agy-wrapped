export interface PriceRates {
  inputCostPerMToken: number;
  cachedInputCostPerMToken: number;
  // Only Claude bills cache writes; Gemini and GPT-OSS report none.
  cacheWriteCostPerMToken?: number;
  outputCostPerMToken: number;
}

export interface PricePeriod extends PriceRates {
  // First UTC day this period applies (YYYY-MM-DD). Omitted for the earliest period.
  effectiveFrom?: string;
  // Request-scoped tier: a prompt (input + cache reads + cache writes) above the
  // threshold bills the whole request at these rates.
  longContextPricing?: PriceRates & { promptTokenThreshold: number };
}

const geminiFlash = (): PricePeriod[] => [
  // Launch prices are promotional; Google doubles them from 2027-01-01.
  { inputCostPerMToken: 0.75, cachedInputCostPerMToken: 0.075, outputCostPerMToken: 3.75 },
  {
    effectiveFrom: "2027-01-01",
    inputCostPerMToken: 1.5,
    cachedInputCostPerMToken: 0.15,
    outputCostPerMToken: 7.5,
  },
];

const gemini4 = (): PricePeriod[] => [
  { inputCostPerMToken: 2, cachedInputCostPerMToken: 0.1, outputCostPerMToken: 10 },
  {
    effectiveFrom: "2026-12-01",
    inputCostPerMToken: 4,
    cachedInputCostPerMToken: 0.2,
    outputCostPerMToken: 20,
  },
];

const geminiPro3 = (): PricePeriod[] => [
  {
    inputCostPerMToken: 2,
    cachedInputCostPerMToken: 0.2,
    outputCostPerMToken: 12,
    longContextPricing: {
      promptTokenThreshold: 200_000,
      inputCostPerMToken: 4,
      cachedInputCostPerMToken: 0.4,
      outputCostPerMToken: 18,
    },
  },
];

const claude = (input: number, cacheRead: number, cacheWrite: number, output: number): PricePeriod[] => [
  {
    inputCostPerMToken: input,
    cachedInputCostPerMToken: cacheRead,
    cacheWriteCostPerMToken: cacheWrite,
    outputCostPerMToken: output,
  },
];

// API list prices per 1M tokens (standard paid tier), used to estimate what Antigravity usage
// would cost at API rates. Antigravity itself is billed by plan, not per token.
// Gemini: https://ai.google.dev/gemini-api/docs/pricing (via aistudio.google.com/docs/pricing),
//   with retired models from models.dev. Claude: https://platform.claude.com/docs/en/about-claude/pricing
//   (5-minute cache writes). GPT-OSS: Vertex AI model-as-a-service rates.
export const LOCAL_MODEL_PRICING: Record<string, PricePeriod[]> = {
  // Gemini 4
  "gemini-4-carbon": gemini4(),
  "gemini-4-argon": gemini4(),
  "gemini-4-hydrogen": [
    { inputCostPerMToken: 1.5, cachedInputCostPerMToken: 0.075, outputCostPerMToken: 7.5 },
  ],

  // Gemini 3.x Flash. 3.7 Flash is deprecated and routed to 3.8 Flash at the same price.
  "gemini-3.8-flash": geminiFlash(),
  "gemini-3.7-flash": geminiFlash(),
  "gemini-3.6-flash": geminiFlash(),
  "gemini-3.5-flash": [
    { inputCostPerMToken: 1.5, cachedInputCostPerMToken: 0.15, outputCostPerMToken: 9 },
  ],
  "gemini-3.5-flash-lite": [
    { inputCostPerMToken: 0.3, cachedInputCostPerMToken: 0.03, outputCostPerMToken: 2.5 },
  ],
  "gemini-3.1-flash-lite": [
    { inputCostPerMToken: 0.25, cachedInputCostPerMToken: 0.025, outputCostPerMToken: 1.5 },
  ],
  "gemini-3-flash-preview": [
    { inputCostPerMToken: 0.5, cachedInputCostPerMToken: 0.05, outputCostPerMToken: 3 },
  ],

  // Gemini 3.x Pro. Antigravity calls the preview models "gemini-3.1-pro" / "gemini-3-pro".
  "gemini-3.1-pro-preview": geminiPro3(),
  "gemini-3-pro-preview": geminiPro3(),

  // Gemini 2.5
  "gemini-2.5-pro": [
    {
      inputCostPerMToken: 1.25,
      cachedInputCostPerMToken: 0.125,
      outputCostPerMToken: 10,
      longContextPricing: {
        promptTokenThreshold: 200_000,
        inputCostPerMToken: 2.5,
        cachedInputCostPerMToken: 0.25,
        outputCostPerMToken: 15,
      },
    },
  ],
  "gemini-2.5-flash": [
    { inputCostPerMToken: 0.3, cachedInputCostPerMToken: 0.03, outputCostPerMToken: 2.5 },
  ],
  "gemini-2.5-flash-lite": [
    { inputCostPerMToken: 0.1, cachedInputCostPerMToken: 0.01, outputCostPerMToken: 0.4 },
  ],

  // Claude
  "claude-opus-5-5": claude(4, 0.2, 5, 20),
  "claude-opus-5": claude(5, 0.5, 6.25, 25),
  "claude-opus-4-8": claude(5, 0.5, 6.25, 25),
  "claude-opus-4-7": claude(5, 0.5, 6.25, 25),
  "claude-opus-4-6": claude(5, 0.5, 6.25, 25),
  "claude-opus-4-5": claude(5, 0.5, 6.25, 25),
  "claude-opus-4-1": claude(15, 1.5, 18.75, 75),
  "claude-opus-4": claude(15, 1.5, 18.75, 75),
  "claude-sonnet-5-5": claude(2, 0.1, 2.5, 10),
  "claude-sonnet-5": claude(2, 0.2, 2.5, 10),
  "claude-sonnet-4-6": claude(3, 0.3, 3.75, 15),
  "claude-sonnet-4-5": claude(3, 0.3, 3.75, 15),
  "claude-sonnet-4": claude(3, 0.3, 3.75, 15),
  "claude-haiku-4-5": claude(1, 0.1, 1.25, 5),

  // GPT-OSS on Vertex AI
  "gpt-oss-120b": [
    { inputCostPerMToken: 0.09, cachedInputCostPerMToken: 0.09, outputCostPerMToken: 0.36 },
  ],
  "gpt-oss-20b": [
    { inputCostPerMToken: 0.07, cachedInputCostPerMToken: 0.007, outputCostPerMToken: 0.25 },
  ],
};

// Antigravity slugs whose API counterpart has a different ID.
export const PRICING_ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
};
