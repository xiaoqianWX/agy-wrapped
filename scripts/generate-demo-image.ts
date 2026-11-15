#!/usr/bin/env bun

import { generateImage } from "../src/image/generator";
import type { WrappedStats } from "../src/types";
import { join } from "node:path";

// Generate realistic sample data
function generateDemoStats(): WrappedStats {
  const year = 2026;

  // Generate daily activity data for the whole year
  const dailyActivity = new Map<string, number>();
  const startDate = new Date(year, 6, 1);
  const endDate = new Date(year, 11, 31);

  // Create realistic activity patterns
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const dayOfWeek = d.getDay();

    // Higher activity on weekdays
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const baseChance = isWeekday ? 0.75 : 0.4;

    if (Math.random() < baseChance) {
      // Generate activity count with realistic distribution
      const count = Math.floor(Math.random() * 25) + 1;
      dailyActivity.set(dateStr, count);
    }
  }

  // Create a streak period (highlight these days)
  const maxStreakDays = new Set<string>();
  const streakStart = new Date(year, 9, 1); // October
  for (let i = 0; i < 21; i++) {
    const d = new Date(streakStart);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    maxStreakDays.add(dateStr);
  }

  // Weekday activity distribution
  const weekdayCounts: [number, number, number, number, number, number, number] = [
    142, // Sunday
    287, // Monday
    312, // Tuesday
    298, // Wednesday
    305, // Thursday
    276, // Friday
    168, // Saturday
  ];

  const maxWeekdayCount = Math.max(...weekdayCounts);
  const mostActiveWeekday = weekdayCounts.indexOf(maxWeekdayCount);
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return {
    year,
    firstSessionDate: startDate,
    daysSinceFirstSession: 183,

    totalSessions: 1247,
    totalMessages: 18934,
    totalProjects: 23,

    totalInputTokens: 412_600_000,
    totalCachedInputTokens: 371_300_000,
    totalCacheWriteTokens: 0,
    totalOutputTokens: 6_900_000,
    totalReasoningTokens: 3_100_000,
    totalTokens: 419_500_000,

    totalCost: 96.12,
    hasUsageCost: true,
    unpricedModels: [],
    encryptedConversations: 0,

    topModels: [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", providerId: "google", count: 210_000_000, percentage: 50.1 },
      { id: "gemini-4-argon", name: "Gemini 4 Argon", providerId: "google", count: 131_000_000, percentage: 31.2 },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", providerId: "anthropic", count: 78_500_000, percentage: 18.7 },
    ],

    topProviders: [
      { id: "google", name: "Google", count: 341_000_000, percentage: 81.3 },
      { id: "anthropic", name: "Anthropic", count: 78_500_000, percentage: 18.7 },
    ],

    maxStreak: 21,
    currentStreak: 8,
    maxStreakDays,

    dailyActivity,

    mostActiveDay: {
      date: "2026-10-15",
      count: 47,
      formattedDate: "Oct 15",
    },

    weekdayActivity: {
      counts: weekdayCounts,
      mostActiveDay: mostActiveWeekday,
      mostActiveDayName: weekdayNames[mostActiveWeekday],
      maxCount: maxWeekdayCount,
    },
  };
}

async function main() {
  console.log("Generating demo wrapped image...");

  const stats = generateDemoStats();
  const image = await generateImage(stats);

  const outputPath = join(import.meta.dir, "..", "assets", "images", "demo-wrapped.png");
  await Bun.write(outputPath, image.fullSize);

  console.log(`Demo image saved to: ${outputPath}`);
}

main().catch(console.error);
