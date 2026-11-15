import type { ModelStats, ProviderStats, WeekdayActivity, WrappedStats } from "./types";
import { collectAntigravityUsageData, type AntigravityUsageData, type AntigravityUsageEvent } from "./collector";
import { calculateRequestCostUSD } from "./pricing";
import { getAntigravityDisplayName } from "./antigravity-models";

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  unknown: "Unknown",
};

export async function calculateStats(year: number): Promise<WrappedStats> {
  return calculateStatsFromData(await collectAntigravityUsageData(), year);
}

export function calculateStatsFromData(data: AntigravityUsageData, year: number): WrappedStats {
  const inYear = (timestamp: number) => new Date(timestamp).getFullYear() === year;
  const events = data.events.filter((event) => inYear(event.timestamp));

  // Activity is counted in user messages per local day.
  const dailyActivity = new Map<string, number>();
  const weekdayCounts: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0];
  const activeSessions = new Set<string>();
  const projects = new Set<string>();
  let totalMessages = 0;

  const sessionsWithEvents = new Set(events.map((event) => event.sessionId));
  for (const conversation of data.conversations) {
    const messageTimes = conversation.userMessageTimes.filter(inYear);
    if (messageTimes.length === 0 && !sessionsWithEvents.has(conversation.id)) continue;

    activeSessions.add(conversation.id);
    if (conversation.workspace) projects.add(conversation.workspace);
    totalMessages += messageTimes.length;
    for (const time of messageTimes) {
      const date = new Date(time);
      const key = formatDateKey(date);
      dailyActivity.set(key, (dailyActivity.get(key) || 0) + 1);
      weekdayCounts[date.getDay()] += 1;
    }
  }

  let totalInputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCost = 0;
  const unpriced = new Set<string>();
  const modelTokens = new Map<string, number>();

  for (const event of events) {
    const eventTotal = getEventTotal(event);
    totalInputTokens += event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens;
    totalCachedInputTokens += event.cacheReadTokens;
    totalCacheWriteTokens += event.cacheWriteTokens;
    totalOutputTokens += event.outputTokens;
    totalReasoningTokens += event.reasoningTokens;

    const cost = calculateRequestCostUSD(event.model, event.timestamp, event);
    if (cost === null) {
      if (eventTotal > 0) unpriced.add(event.model);
    } else if (Number.isFinite(cost)) {
      totalCost += cost;
    }

    if (event.model !== "unknown") {
      modelTokens.set(event.model, (modelTokens.get(event.model) || 0) + eventTotal);
    }
  }
  const totalTokens = totalInputTokens + totalOutputTokens;

  const providerCounts = new Map<string, number>();
  const modelStats: ModelStats[] = [];
  for (const [modelId, tokens] of modelTokens) {
    if (tokens <= 0) continue;
    const providerId = resolveProviderId(modelId);
    providerCounts.set(providerId, (providerCounts.get(providerId) || 0) + tokens);
    modelStats.push({
      id: modelId,
      name: getAntigravityDisplayName(modelId),
      providerId,
      count: tokens,
      percentage: 0,
    });
  }

  const denominator = totalTokens > 0 ? totalTokens : modelStats.reduce((sum, model) => sum + model.count, 0);
  const topModels = modelStats
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((model) => ({ ...model, percentage: denominator > 0 ? (model.count / denominator) * 100 : 0 }));

  const topProviders: ProviderStats[] = Array.from(providerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => ({
      id,
      name: PROVIDER_NAMES[id] ?? id,
      count,
      percentage: denominator > 0 ? (count / denominator) * 100 : 0,
    }));

  const { maxStreak, currentStreak, maxStreakDays } = calculateStreaks(dailyActivity, year);
  const mostActiveDay = findMostActiveDay(dailyActivity);
  const weekdayActivity = buildWeekdayActivity(weekdayCounts);

  const firstSessionTime = data.conversations.reduce(
    (min, conversation) => Math.min(min, conversation.createdAt),
    Number.POSITIVE_INFINITY
  );
  const firstSessionDate = Number.isFinite(firstSessionTime) ? new Date(firstSessionTime) : new Date();
  const daysSinceFirstSession = Math.floor((Date.now() - firstSessionDate.getTime()) / (1000 * 60 * 60 * 24));

  return {
    year,
    firstSessionDate,
    daysSinceFirstSession,
    totalSessions: activeSessions.size,
    totalMessages,
    totalProjects: projects.size,
    totalInputTokens,
    totalCachedInputTokens,
    totalCacheWriteTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalTokens,
    totalCost,
    hasUsageCost: totalCost > 0,
    unpricedModels: Array.from(unpriced).sort(),
    encryptedConversations: data.encryptedConversations,
    topModels,
    topProviders,
    maxStreak,
    currentStreak,
    maxStreakDays,
    dailyActivity,
    mostActiveDay,
    weekdayActivity,
  };
}

function resolveProviderId(modelId: string): string {
  if (modelId.startsWith("gemini") || modelId.startsWith("gemma")) return "google";
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt")) return "openai";
  return "unknown";
}

function getEventTotal(event: AntigravityUsageEvent): number {
  return event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens + event.outputTokens;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calculateStreaks(
  dailyActivity: Map<string, number>,
  year: number
): { maxStreak: number; currentStreak: number; maxStreakDays: Set<string> } {
  const activeDates = Array.from(dailyActivity.keys())
    .filter((date) => date.startsWith(String(year)))
    .sort();

  if (activeDates.length === 0) {
    return { maxStreak: 0, currentStreak: 0, maxStreakDays: new Set() };
  }

  let maxStreak = 1;
  let tempStreak = 1;
  let tempStreakStart = 0;
  let maxStreakStart = 0;
  let maxStreakEnd = 0;

  for (let i = 1; i < activeDates.length; i++) {
    const diffDays = Math.round(
      (new Date(activeDates[i]).getTime() - new Date(activeDates[i - 1]).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diffDays === 1) {
      tempStreak++;
      if (tempStreak > maxStreak) {
        maxStreak = tempStreak;
        maxStreakStart = tempStreakStart;
        maxStreakEnd = i;
      }
    } else {
      tempStreak = 1;
      tempStreakStart = i;
    }
  }

  const maxStreakDays = new Set<string>();
  for (let i = maxStreakStart; i <= maxStreakEnd; i++) {
    maxStreakDays.add(activeDates[i]);
  }

  const today = formatDateKey(new Date());
  const yesterday = formatDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const currentStreak = dailyActivity.has(today)
    ? countStreakBackwards(dailyActivity, new Date())
    : dailyActivity.has(yesterday)
    ? countStreakBackwards(dailyActivity, new Date(Date.now() - 24 * 60 * 60 * 1000))
    : 0;

  return { maxStreak, currentStreak, maxStreakDays };
}

/** Count consecutive days with activity going backwards from startDate (inclusive) */
function countStreakBackwards(dailyActivity: Map<string, number>, startDate: Date): number {
  let streak = 1;
  let checkDate = new Date(startDate);
  while (true) {
    checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
    if (!dailyActivity.has(formatDateKey(checkDate))) break;
    streak++;
  }
  return streak;
}

function findMostActiveDay(
  dailyActivity: Map<string, number>
): { date: string; count: number; formattedDate: string } | null {
  let maxDate = "";
  let maxCount = 0;
  for (const [date, count] of dailyActivity.entries()) {
    if (count > maxCount) {
      maxCount = count;
      maxDate = date;
    }
  }
  if (!maxDate) return null;

  const [year, month, day] = maxDate.split("-").map(Number);
  const dateObj = new Date(year, month - 1, day);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    date: maxDate,
    count: maxCount,
    formattedDate: `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}`,
  };
}

function buildWeekdayActivity(counts: [number, number, number, number, number, number, number]): WeekdayActivity {
  const WEEKDAY_NAMES_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let mostActiveDay = 0;
  let maxCount = 0;
  for (let i = 0; i < 7; i++) {
    if (counts[i] > maxCount) {
      maxCount = counts[i];
      mostActiveDay = i;
    }
  }
  return {
    counts,
    mostActiveDay,
    mostActiveDayName: WEEKDAY_NAMES_FULL[mostActiveDay],
    maxCount,
  };
}
