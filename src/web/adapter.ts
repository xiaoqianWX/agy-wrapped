// Antigravity adapter for the dashboard: turns the conversation databases into a DashboardPayload.

import { basename } from "node:path";
import logoBase64 from "../../assets/images/antigravity-logo.base64.txt" with { type: "text" };
import { getAntigravityDisplayName } from "../antigravity-models";
import { collectAntigravityUsageData, type AntigravityUsageData } from "../collector";
import { colors } from "../image/design-tokens";
import { calculateRequestCostUSD } from "../pricing";
import {
  toDayNumber,
  type DashboardPayload,
  type DashboardProject,
  type DashboardSession,
  type DashboardTheme,
  type PromptRow,
  type ToolRow,
  type UsageRow,
} from "./types";

export const DASHBOARD_PACKAGE = "agy-wrapped";

const THEME: DashboardTheme = {
  scheme: "dark",
  background: colors.background,
  surface: colors.surface,
  surfaceHover: colors.surfaceHover,
  border: colors.surfaceBorder,
  text: colors.text.primary,
  textSecondary: colors.text.secondary,
  textMuted: colors.text.muted,
  accent: colors.accent.primary,
  heatmap: [
    // The card's empty cell (#17183D) vanishes on the surface colour; lift it for the dashboard.
    "#23255A",
    colors.heatmap.level1,
    colors.heatmap.level2,
    colors.heatmap.level3,
    colors.heatmap.level4,
    colors.heatmap.level5,
    colors.heatmap.level6,
    colors.heatmap.level7,
  ],
  series: ["#A78BFA", "#22D3EE", "#F472B6", "#818CF8", "#34D399", "#5B5891"],
};

export async function buildDashboardPayload(defaultYear: number, data?: AntigravityUsageData): Promise<DashboardPayload> {
  const { events, conversations } = data ?? (await collectAntigravityUsageData());

  const activeIds = new Set<string>(events.map((event) => event.sessionId));
  for (const conversation of conversations) {
    if (conversation.userMessageTimes.length > 0) activeIds.add(conversation.id);
  }

  // Session span covers every timestamp we know of for the conversation.
  const spans = new Map<string, { start: number; end: number }>();
  const widen = (id: string, time: number) => {
    const span = spans.get(id);
    if (!span) spans.set(id, { start: time, end: time });
    else {
      if (time < span.start) span.start = time;
      if (time > span.end) span.end = time;
    }
  };
  for (const event of events) widen(event.sessionId, event.timestamp);

  const projectIndex = new Map<string, number>();
  const projects: DashboardProject[] = [];
  const sessions: DashboardSession[] = [];
  const sessionIndex = new Map<string, number>();

  const ordered = conversations.filter((c) => activeIds.has(c.id)).sort((a, b) => a.createdAt - b.createdAt);
  for (const conversation of ordered) {
    widen(conversation.id, conversation.createdAt);
    widen(conversation.id, conversation.endedAt);
    for (const time of conversation.userMessageTimes) widen(conversation.id, time);

    let project = -1;
    const path = conversation.workspace ? workspacePath(conversation.workspace) : null;
    if (path) {
      project = projectIndex.get(path) ?? -1;
      if (project < 0) {
        project = projects.length;
        projectIndex.set(path, project);
        projects.push({ path, name: basename(path) || path });
      }
    }
    const span = spans.get(conversation.id)!;
    sessionIndex.set(conversation.id, sessions.length);
    sessions.push({
      id: conversation.id,
      title: conversation.title ?? (conversation.firstPrompt ? shortTitle(conversation.firstPrompt) : null),
      project,
      start: span.start,
      end: span.end,
      branch: null,
    });
  }
  // Events whose database was unreadable still count; give them a bare session.
  for (const id of activeIds) {
    if (sessionIndex.has(id)) continue;
    const span = spans.get(id)!;
    sessionIndex.set(id, sessions.length);
    sessions.push({ id, title: null, project: -1, start: span.start, end: span.end, branch: null });
  }
  disambiguateProjectNames(projects);

  const modelIndex = new Map<string, number>();
  const modelIds: string[] = [];
  const modelPriced: boolean[] = [];
  const usageRows = new Map<string, UsageRow>();
  let hasReasoning = false;

  for (const event of events) {
    const s = sessionIndex.get(event.sessionId)!;
    let m = modelIndex.get(event.model);
    if (m === undefined) {
      m = modelIds.length;
      modelIndex.set(event.model, m);
      modelIds.push(event.model);
      modelPriced.push(false);
    }
    const cost = calculateRequestCostUSD(event.model, event.timestamp, event);
    if (cost !== null && Number.isFinite(cost)) modelPriced[m] = true;
    if (event.reasoningTokens > 0) hasReasoning = true;

    const date = new Date(event.timestamp);
    const day = toDayNumber(date);
    const hour = date.getHours();
    const key = `${s}|${day}|${hour}|${m}`;
    const row = usageRows.get(key) ?? ([s, day, hour, m, 0, 0, 0, 0, 0, 0, 0] as UsageRow);
    row[4] += 1;
    row[5] += event.inputTokens;
    row[6] += event.outputTokens;
    row[7] += event.cacheReadTokens;
    row[8] += event.cacheWriteTokens;
    row[9] += event.reasoningTokens;
    row[10] += cost !== null && Number.isFinite(cost) ? cost : 0;
    usageRows.set(key, row);
  }

  const promptRows = new Map<string, PromptRow>();
  const toolIndex = new Map<string, number>();
  const tools: string[] = [];
  const toolRows = new Map<string, ToolRow>();
  for (const conversation of ordered) {
    const s = sessionIndex.get(conversation.id)!;
    for (const time of conversation.userMessageTimes) {
      const date = new Date(time);
      const day = toDayNumber(date);
      const hour = date.getHours();
      const key = `${s}|${day}|${hour}`;
      const row = promptRows.get(key) ?? ([s, day, hour, 0] as PromptRow);
      row[3] += 1;
      promptRows.set(key, row);
    }
    const seen = new Set<string>();
    for (const call of conversation.toolCalls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      let t = toolIndex.get(call.name);
      if (t === undefined) {
        t = tools.length;
        toolIndex.set(call.name, t);
        tools.push(call.name);
      }
      const day = toDayNumber(new Date(call.timestamp));
      const key = `${s}|${day}|${t}`;
      const row = toolRows.get(key) ?? ([s, day, t, 0] as ToolRow);
      row[3] += 1;
      toolRows.set(key, row);
    }
  }

  return {
    version: 1,
    product: {
      name: "Antigravity",
      url: "antigravity.google",
      logo: `data:image/png;base64,${logoBase64.trim()}`,
      command: "npx agy-wrapped",
    },
    theme: THEME,
    generatedAt: Date.now(),
    defaultYear,
    costNote: "Estimated at API list prices; Antigravity itself is billed by plan",
    hasCacheWrite: true,
    hasReasoning,
    models: modelIds.map((id, i) => ({ id, name: getAntigravityDisplayName(id), priced: modelPriced[i] })),
    projects,
    sessions,
    tools,
    usage: [...usageRows.values()].map(roundCost),
    prompts: [...promptRows.values()],
    toolCalls: [...toolRows.values()],
  };
}

/** file:// workspace URIs → local paths; other URIs are kept as written. */
export function workspacePath(uri: string): string {
  let path = uri.trim();
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
      // file:///C:/x → C:/x
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      path = path.slice("file://".length);
    }
  }
  return path.replace(/[\\/]+$/, "") || path;
}

function shortTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

function disambiguateProjectNames(projects: DashboardProject[]) {
  const byName = new Map<string, DashboardProject[]>();
  for (const project of projects) byName.set(project.name, [...(byName.get(project.name) ?? []), project]);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const project of group) {
      const parts = project.path.split(/[\\/]/).filter(Boolean);
      project.name = parts.slice(-2).join("/") || project.path;
    }
  }
}

function roundCost(row: UsageRow): UsageRow {
  row[10] = Math.round(row[10] * 1e6) / 1e6;
  return row;
}
