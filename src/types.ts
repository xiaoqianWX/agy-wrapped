// Types for Antigravity Wrapped

export interface ModelStats {
  id: string;
  name: string;
  providerId: string;
  count: number;
  percentage: number;
}

export interface ProviderStats {
  id: string;
  name: string;
  count: number;
  percentage: number;
}

export interface WrappedStats {
  year: number;

  // Time-based
  firstSessionDate: Date;
  daysSinceFirstSession: number;

  // Counts
  totalSessions: number;
  totalMessages: number;
  totalProjects: number;

  // Tokens. Input is the full prompt (uncached input + cache reads + cache writes).
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;

  // Estimated cost at API list prices
  totalCost: number;
  hasUsageCost: boolean;
  // Models with token usage but no known price (excluded from cost)
  unpricedModels: string[];

  // Conversations stored only in Antigravity's older encrypted format
  encryptedConversations: number;

  // Models (sorted by usage)
  topModels: ModelStats[];

  // Providers (sorted by usage)
  topProviders: ProviderStats[];

  // Streak
  maxStreak: number;
  currentStreak: number;
  maxStreakDays: Set<string>; // Days that form the max streak (for heatmap highlighting)

  // Activity heatmap (for the year)
  dailyActivity: Map<string, number>; // "2025-01-15" -> count

  // Most active day
  mostActiveDay: {
    date: string;
    count: number;
    formattedDate: string;
  } | null;

  // Weekday activity distribution (0=Sunday, 6=Saturday)
  weekdayActivity: WeekdayActivity;
}

export interface WeekdayActivity {
  counts: [number, number, number, number, number, number, number];
  mostActiveDay: number;
  mostActiveDayName: string;
  maxCount: number;
}
