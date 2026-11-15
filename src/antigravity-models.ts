// Antigravity logs models three ways: API-style slugs ("gemini-3.7-flash", "claude-opus-5-5-high"),
// UI labels ("Gemini 4 Carbon (High)"), and numeric internal enum IDs, some of which appear as
// "MODEL_PLACEHOLDER_M<id - 1000>". Everything is normalized to a base model slug here; effort
// levels and plan variants are dropped because they share one price.
//
// ID and alias mappings come from Antigravity logs plus the mappings collected by ccusage's
// Antigravity adapter (github.com/ccusage/ccusage, rust/adapters/antigravity).

const MODEL_ID_TABLE: Array<[number, number, string]> = [
  // [first id, last id, base model]
  [246, 246, "gemini-2.5-pro"],
  [312, 313, "gemini-2.5-flash"],
  [329, 329, "gemini-2.5-flash"],
  [330, 330, "gemini-2.5-flash-lite"],
  [281, 282, "claude-sonnet-4"],
  [290, 291, "claude-opus-4"],
  [333, 334, "claude-sonnet-4-5"],
  [340, 341, "claude-haiku-4-5"],
  [342, 342, "gpt-oss-120b"],
  [1016, 1016, "gemini-3.1-pro"],
  [1018, 1018, "gemini-3-flash-preview"],
  [1020, 1020, "gemini-3.5-flash"],
  [1026, 1026, "claude-opus-4-6"],
  [1035, 1035, "claude-sonnet-4-6"],
  [1036, 1037, "gemini-3.1-pro"],
  [1047, 1047, "gemini-3-flash-preview"],
  [1050, 1050, "gemini-3.1-flash-lite"],
  [1071, 1073, "gemini-3.6-flash"],
  [1084, 1084, "gemini-3-flash-preview"],
  [1132, 1133, "gemini-3.5-flash"],
  [1187, 1187, "gemini-3.5-flash"],
  [1298, 1300, "gemini-3.7-flash"],
  [1318, 1320, "gemini-3.8-flash"],
  [1402, 1402, "claude-opus-5-5"],
  [1417, 1419, "gemini-4-argon"],
  [1427, 1427, "gemini-4-carbon"],
];

// Internal names that are not API slugs.
const MODEL_ALIASES: Record<string, string> = {
  "gemini-pro-default": "gemini-3.1-pro",
  "gemini-pro-agent": "gemini-3.1-pro",
  "gemini-3-flash-agent": "gemini-3.5-flash",
  "gemini-3-flash-agent-a": "gemini-3.5-flash",
  "gemini-3-flash-agent-b": "gemini-3.5-flash",
  "gemini-3-flash-a": "gemini-3.5-flash",
  "gemini-3-flash-b": "gemini-3.5-flash",
  "gemini-3-flash-c": "gemini-3-flash-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "model-openai-gpt-oss-120b-medium": "gpt-oss-120b",
  "model-openai-gpt-oss-120b": "gpt-oss-120b",
};

// Effort levels, thinking toggles and plan/rollout tags appended to slugs.
const VARIANT_SUFFIX = /-(thinking|extra-low|low|medium|high|max|trial|tiered|customtools|maas)$/;
const PREFIXES = [
  "publishers/google/models/",
  "models/",
  "google/",
  "vertex_ai/",
  "anthropic/",
  "openai/",
  "antigravity-",
];

export const UNKNOWN_MODEL_PREFIX = "antigravity-model-";

export function modelFromId(id: number | undefined): string | undefined {
  if (id === undefined || id <= 0) return undefined;
  for (const [first, last, model] of MODEL_ID_TABLE) {
    if (id >= first && id <= last) return model;
  }
  return undefined;
}

export function isKnownModel(model: string): boolean {
  return !model.startsWith(UNKNOWN_MODEL_PREFIX);
}

/** Normalizes any model string Antigravity writes; undefined when it is empty or unresolvable. */
export function normalizeAntigravityModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim().toLowerCase();
  if (!value) return undefined;

  // UI labels: "Gemini 4 Carbon (High)", "Claude Opus 5.5 (Max)", "GPT-OSS 120B (Medium)".
  value = value.replace(/\s*\(.*?\)\s*/g, " ").trim().replace(/[\s_]+/g, "-");
  value = value.replace(/@.*$/, "");

  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length);
        changed = true;
      }
    }
  }

  const placeholder = value.match(/^model-placeholder-m(\d+)$/);
  if (placeholder) {
    return modelFromId(1000 + Number(placeholder[1]));
  }
  if (/^model-placeholder-/.test(value)) return undefined;

  // Older proxies spelled Claude as "gemini-claude-sonnet-4-5".
  value = value.replace(/^gemini-claude-/, "claude-");

  if (MODEL_ALIASES[value]) return MODEL_ALIASES[value];
  while (VARIANT_SUFFIX.test(value)) {
    value = value.replace(VARIANT_SUFFIX, "");
    if (MODEL_ALIASES[value]) return MODEL_ALIASES[value];
  }

  if (value.startsWith("claude-")) {
    value = normalizeClaude(value);
  }

  return value || undefined;
}

function normalizeClaude(value: string): string {
  // "claude-4.5-sonnet" / "claude-4-opus" -> "claude-sonnet-4-5" / "claude-opus-4".
  const versionFirst = value.match(/^claude-(\d+(?:[.-]\d+)?)-(opus|sonnet|haiku|fable|mythos)$/);
  if (versionFirst) {
    value = `claude-${versionFirst[2]}-${versionFirst[1]}`;
  }
  // UI labels use dots ("claude-opus-5.5"); Anthropic IDs use dashes. Drop snapshot dates.
  return value.replace(/\./g, "-").replace(/-\d{8}$/, "");
}

const DISPLAY_NAMES: Record<string, string> = {
  "gemini-4-carbon": "Gemini 4 Carbon",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.1-ultra": "Gemini 3.1 Ultra",
  "gemini-3-pro": "Gemini 3 Pro",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gpt-oss-120b": "GPT-OSS 120B",
  "gpt-oss-20b": "GPT-OSS 20B",
};

export function getAntigravityDisplayName(model: string): string {
  if (DISPLAY_NAMES[model]) return DISPLAY_NAMES[model];
  if (model.startsWith(UNKNOWN_MODEL_PREFIX)) {
    return `Unknown model #${model.slice(UNKNOWN_MODEL_PREFIX.length)}`;
  }
  if (model.startsWith("claude-")) {
    // claude-opus-5-5 -> Claude Opus 5.5
    const match = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
    if (match) {
      const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      return `Claude ${family} ${match[3] ? `${match[2]}.${match[3]}` : match[2]}`;
    }
  }
  return model
    .split("-")
    .map((part) => {
      if (part === "gpt") return "GPT";
      if (/^\d/.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
