#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { checkAntigravityDataExists } from "./collector";
import { calculateStats } from "./stats";
import { generateImage } from "./image/generator";
import { displayInTerminal, getTerminalName } from "./terminal/display";
import { copyImageToClipboard } from "./clipboard";
import { isWrappedAvailable } from "./utils/dates";
import { formatCostFull, formatNumber, formatNumberFull } from "./utils/format";
import { getAntigravityDisplayName } from "./antigravity-models";
import type { WrappedStats } from "./types";
import { loadFonts } from "./image/fonts";
import { buildDashboardPayload, DASHBOARD_PACKAGE } from "./web/adapter";
import { openExternal, writeDashboard } from "./web/open";
import { renderDashboardHtml } from "./web/render";

const VERSION = "0.2.0";

function printHelp() {
  console.log(`
agy-wrapped v${VERSION}

Generate your Google Antigravity year in review stats card.

USAGE:
  agy-wrapped [OPTIONS]

OPTIONS:
  --year <YYYY>    Generate wrapped for a specific year (default: current year)
  --web, -w        Open an interactive dashboard in your browser instead of the card
  --help, -h       Show this help message
  --version, -v    Show version number

ENVIRONMENT:
  ANTIGRAVITY_DATA_DIR   Comma-separated data directories to read instead of ~/.gemini/antigravity*

EXAMPLES:
  agy-wrapped              # Generate current year wrapped
  agy-wrapped --year 2026  # Generate 2026 wrapped
  agy-wrapped --web        # Explore your usage in the browser
`);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      year: { type: "string", short: "y" },
      web: { type: "boolean", short: "w" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(`agy-wrapped v${VERSION}`);
    process.exit(0);
  }

  p.intro("agy wrapped");

  const requestedYear = values.year ? parseInt(values.year, 10) : new Date().getFullYear();

  const availability = isWrappedAvailable(requestedYear);
  if (!availability.available) {
    if (Array.isArray(availability.message)) {
      availability.message.forEach((line) => p.log.warn(line));
    } else {
      p.log.warn(availability.message || "Wrapped not available yet.");
    }
    p.cancel();
    process.exit(0);
  }

  const dataExists = await checkAntigravityDataExists();
  if (!dataExists) {
    p.cancel(
      "Antigravity conversation data not found in ~/.gemini/antigravity/conversations\n\nMake sure you have used Antigravity at least once, or set ANTIGRAVITY_DATA_DIR."
    );
    process.exit(0);
  }

  if (values.web) {
    await runDashboard(requestedYear);
    process.exit(0);
  }

  const spinner = p.spinner();
  spinner.start("Scanning your Antigravity history...");

  let stats: WrappedStats;
  try {
    stats = await calculateStats(requestedYear);
  } catch (error) {
    spinner.stop("Failed to collect stats");
    p.cancel(`Error: ${error}`);
    process.exit(1);
  }

  if (stats.totalSessions === 0) {
    spinner.stop("No data found");
    if (stats.encryptedConversations > 0) {
      p.log.warn(encryptedNote(stats.encryptedConversations));
    }
    p.cancel(`No readable Antigravity activity found for ${requestedYear}`);
    process.exit(0);
  }

  spinner.stop("Found your stats!");

  const row = (label: string, value: string) => `${`${label}:`.padEnd(15)}${value}`;
  const summaryLines = [
    row("Sessions", formatNumber(stats.totalSessions)),
    row("Messages", formatNumber(stats.totalMessages)),
    row("Total Tokens", formatNumber(stats.totalTokens)),
    stats.totalCachedInputTokens > 0 && row("Cache Read", formatNumber(stats.totalCachedInputTokens)),
    stats.totalCacheWriteTokens > 0 && row("Cache Write", formatNumber(stats.totalCacheWriteTokens)),
    stats.totalOutputTokens > 0 && row("Output", formatNumber(stats.totalOutputTokens)),
    stats.totalReasoningTokens > 0 && row("Reasoning", formatNumber(stats.totalReasoningTokens)),
    row("Projects", formatNumber(stats.totalProjects)),
    row("Streak", `${stats.maxStreak} days`),
    stats.hasUsageCost && row("Usage Cost", `${stats.totalCost.toFixed(2)}$`),
    stats.mostActiveDay && row("Most Active", stats.mostActiveDay.formattedDate),
  ].filter(Boolean);

  p.note(summaryLines.join("\n"), `Your ${requestedYear} in Antigravity`);

  if (stats.hasUsageCost) {
    p.log.info("Usage cost is an estimate at API list prices; Antigravity itself is billed by plan.");
  }
  if (stats.unpricedModels.length > 0) {
    const names = stats.unpricedModels.map(getAntigravityDisplayName).join(", ");
    p.log.warn(`No price known for ${names}; their tokens are counted but left out of the cost.`);
  }
  if (stats.encryptedConversations > 0) {
    p.log.warn(encryptedNote(stats.encryptedConversations));
  }

  spinner.start("Generating your wrapped image...");

  let image: { fullSize: Buffer; displaySize: Buffer };
  try {
    image = await generateImage(stats);
  } catch (error) {
    spinner.stop("Failed to generate image");
    p.cancel(`Error generating image: ${error}`);
    process.exit(1);
  }

  spinner.stop("Image generated!");

  const displayed = await displayInTerminal(image.displaySize);
  if (!displayed) {
    p.log.info(`Terminal (${getTerminalName()}) doesn't support inline images`);
  }

  const filename = `agy-wrapped-${requestedYear}.png`;
  const { success, error } = await copyImageToClipboard(image.fullSize, filename);

  if (success) {
    p.log.success("Automatically copied image to clipboard!");
  } else {
    p.log.warn(`Clipboard unavailable: ${error}`);
    p.log.info("You can save the image to disk instead.");
  }

  const defaultPath = join(process.env.HOME || "~", filename);

  const shouldSave = await p.confirm({
    message: `Save image to ~/${filename}?`,
    initialValue: true,
  });

  if (p.isCancel(shouldSave)) {
    p.outro("Cancelled");
    process.exit(0);
  }

  if (shouldSave) {
    try {
      await Bun.write(defaultPath, image.fullSize);
      p.log.success(`Saved to ${defaultPath}`);
    } catch (error) {
      p.log.error(`Failed to save: ${error}`);
    }
  }

  const shouldShare = await p.confirm({
    message: "Share on X (Twitter)? Don't forget to attach your image!",
    initialValue: true,
  });

  if (!p.isCancel(shouldShare) && shouldShare) {
    const tweetUrl = generateTweetUrl(stats);
    const opened = await openExternal(tweetUrl);
    if (opened) {
      p.log.success("Opened X in your browser.");
    } else {
      p.log.warn("Couldn't open browser. Copy this URL:");
      p.log.info(tweetUrl);
    }
    p.log.info("Press CMD / CTRL + V to paste the image.");
  }

  p.outro("Share your wrapped!");
  process.exit(0);
}

function encryptedNote(count: number): string {
  const noun = count === 1 ? "conversation is" : "conversations are";
  return `${count} older ${noun} stored in Antigravity's encrypted format and can't be counted.`;
}

function generateTweetUrl(stats: WrappedStats): string {
  const lines: string[] = [];
  lines.push(`Antigravity Wrapped ${stats.year}`);
  lines.push("");
  lines.push(`Total Tokens: ${formatNumberFull(stats.totalTokens)}`);
  lines.push(`Total Messages: ${formatNumberFull(stats.totalMessages)}`);
  lines.push(`Total Sessions: ${formatNumberFull(stats.totalSessions)}`);
  lines.push("");
  lines.push(`Longest Streak: ${stats.maxStreak} days`);
  lines.push(`Top model: ${stats.topModels[0]?.name ?? "N/A"}`);
  lines.push(`Total Estimated Cost: ${stats.hasUsageCost ? formatCostFull(stats.totalCost) : "N/A"}`);
  lines.push("");
  lines.push("Get yours: npx agy-wrapped");
  lines.push("");
  lines.push("(Paste Image Stats with CMD / CTRL + V)");

  const url = new URL("https://x.com/intent/tweet");
  url.searchParams.set("text", lines.join("\n"));
  return url.toString();
}

async function runDashboard(year: number) {
  const spinner = p.spinner();
  spinner.start("Scanning your Antigravity history...");
  let html: string;
  try {
    const payload = await buildDashboardPayload(year);
    if (payload.usage.length === 0 && payload.prompts.length === 0) {
      spinner.stop("No data found");
      p.cancel("No Antigravity activity found in your conversation databases.");
      return;
    }
    const fonts = (await loadFonts()).map((font) => ({ weight: Number(font.weight), data: font.data as ArrayBuffer }));
    html = renderDashboardHtml(payload, fonts);
    spinner.stop(`Found ${formatNumber(payload.sessions.length)} conversations`);
  } catch (error) {
    spinner.stop("Failed to build the dashboard");
    p.cancel(`Error: ${error}`);
    process.exit(1);
  }

  const path = await writeDashboard(DASHBOARD_PACKAGE, year, html);
  p.log.success(`Dashboard saved to ${path}`);
  const opened = await openExternal(path);
  p.outro(opened ? "Opened in your browser." : "Open that file in your browser.");
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
