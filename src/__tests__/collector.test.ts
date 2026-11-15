import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { collectAntigravityUsageData } from "../collector";
import { calculateStatsFromData } from "../stats";
import { encode, packed, timestamp, usage, type Field } from "./proto-builder";

const T0 = Date.UTC(2026, 7, 14, 12, 0, 0); // 2026-08-14 12:00 UTC
const minutes = (n: number) => T0 + n * 60_000;

let root: string;
let previousEnv: string | undefined;

function createConversation(dir: string, id: string, build: (db: Database) => void) {
  const db = new Database(join(dir, `${id}.db`), { create: true });
  db.run("CREATE TABLE trajectory_metadata_blob (id text, data blob)");
  db.run(
    "CREATE TABLE steps (idx integer primary key, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob)"
  );
  db.run("CREATE TABLE gen_metadata (idx integer primary key, data blob, size integer NOT NULL DEFAULT 0)");
  build(db);
  db.close();
}

function addTrajectory(db: Database, workspace: string | null, createdMs: number) {
  const fields: Field[] = [];
  if (workspace) fields.push({ n: 1, msg: [{ n: 1, str: workspace }] });
  fields.push({ n: 2, msg: timestamp(createdMs) });
  db.query("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(encode(fields));
}

function addStep(db: Database, idx: number, stepType: number, ms: number, extra: Field[] = []) {
  const metadata = encode([{ n: 1, msg: timestamp(ms) }, ...extra]);
  db.query("INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)").run(idx, stepType, metadata);
}

function addGeneration(db: Database, idx: number, stepIndices: number[], chat: Field[]) {
  const data = encode([{ n: 1, msg: chat }, { n: 2, bytes: packed(stepIndices) }]);
  db.query("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(idx, data);
}

beforeAll(() => {
  root = mkdtempSync(join(os.tmpdir(), "agy-wrapped-test-"));
  const conversations = join(root, "antigravity", "conversations");
  const backup = join(root, "antigravity-backup", "conversations");
  mkdirSync(conversations, { recursive: true });
  mkdirSync(backup, { recursive: true });

  createConversation(conversations, "conv-a", (db) => {
    addTrajectory(db, "file:///Users/me/project-a", minutes(0));
    addStep(db, 0, 14, minutes(0)); // user message
    const flashUsage = usage({
      modelId: 1298,
      input: 1000,
      cacheRead: 20_000,
      output: 300,
      thinking: 200,
      visible: 100,
      responseId: "resp-1",
    });
    // Step copy of the request (no model name), plus a step-only background call.
    addStep(db, 1, 15, minutes(1), [{ n: 9, msg: flashUsage }]);
    addStep(db, 2, 15, minutes(2), [{ n: 9, msg: usage({ modelId: 1050, input: 100, output: 5, responseId: "bg-1" }) }]);
    addStep(db, 3, 14, minutes(3)); // second user message
    addStep(db, 4, 15, minutes(4));

    // Generation copy of resp-1: retry list repeats the primary once (dropped).
    addGeneration(db, 0, [1], [
      { n: 3, varint: 1298 },
      { n: 4, msg: flashUsage },
      { n: 17, msg: [{ n: 2, msg: flashUsage }] },
      { n: 19, str: "gemini-3.7-flash" },
      { n: 21, str: "Gemini 3.7 Flash (High)" },
    ]);
    // A generation with no own timestamp borrows step 4's; its failed first attempt also counts.
    addGeneration(db, 1, [4], [
      { n: 3, varint: 1427 },
      { n: 4, msg: usage({ modelId: 1427, input: 500, cacheRead: 1000, output: 50, responseId: "resp-2" }) },
      { n: 17, msg: [{ n: 2, msg: usage({ modelId: 1427, input: 500, output: 10, responseId: "resp-2-retry" }) }] },
      { n: 17, msg: [{ n: 2, msg: usage({ modelId: 1427, input: 500, cacheRead: 1000, output: 50, responseId: "resp-2" }) }] },
      { n: 19, str: "gemini-4-carbon" },
    ]);
    // Zero-usage generation is ignored.
    addGeneration(db, 2, [], [{ n: 21, str: "Gemini 3.7 Flash (High)" }]);
  });

  // A copy of conv-a in another data root must not double count.
  createConversation(backup, "conv-a", (db) => {
    addTrajectory(db, "file:///Users/me/project-a", minutes(0));
    addStep(db, 0, 14, minutes(0));
    addGeneration(db, 0, [1], [
      { n: 4, msg: usage({ modelId: 1298, input: 1000, cacheRead: 20_000, output: 300, thinking: 200, visible: 100, responseId: "resp-1" }) },
      { n: 19, str: "gemini-3.7-flash" },
    ]);
  });

  // Placeholder names, unknown IDs and a different year.
  createConversation(conversations, "conv-b", (db) => {
    addTrajectory(db, null, Date.UTC(2025, 11, 30));
    addStep(db, 0, 14, Date.UTC(2025, 11, 30, 10));
    addGeneration(db, 0, [], [
      { n: 4, msg: usage({ modelId: 1417, input: 10, output: 10, responseId: "old" }) },
      { n: 9, msg: [{ n: 4, msg: timestamp(Date.UTC(2025, 11, 30, 10, 5)) }] },
      { n: 19, str: "gemini-4-argon-trial" },
    ]);
    addStep(db, 1, 14, Date.UTC(2026, 0, 2, 10));
    addGeneration(db, 1, [], [
      { n: 4, msg: usage({ modelId: 1999, input: 40, output: 4, responseId: "mystery" }) },
      { n: 9, msg: [{ n: 4, msg: timestamp(Date.UTC(2026, 0, 2, 10, 1)) }] },
    ]);
  });

  // Encrypted legacy conversation, plus one that also has a readable copy.
  writeFileSync(join(conversations, "legacy.pb"), new Uint8Array([1, 2, 3]));
  writeFileSync(join(conversations, "conv-b.pb"), new Uint8Array([1, 2, 3]));

  previousEnv = process.env.ANTIGRAVITY_DATA_DIR;
  process.env.ANTIGRAVITY_DATA_DIR = [join(root, "antigravity"), join(root, "antigravity-backup")].join(",");
});

afterAll(() => {
  if (previousEnv === undefined) delete process.env.ANTIGRAVITY_DATA_DIR;
  else process.env.ANTIGRAVITY_DATA_DIR = previousEnv;
  rmSync(root, { recursive: true, force: true });
});

describe("collectAntigravityUsageData", () => {
  test("merges duplicate records and keeps retries and step-only calls", async () => {
    const data = await collectAntigravityUsageData();
    const byModel = (model: string) => data.events.filter((event) => event.model === model);

    const flash = byModel("gemini-3.7-flash");
    expect(flash).toHaveLength(1);
    expect(flash[0]).toMatchObject({
      inputTokens: 1000,
      cacheReadTokens: 20_000,
      outputTokens: 300,
      reasoningTokens: 200,
      timestamp: minutes(1),
    });

    expect(byModel("gemini-3.1-flash-lite")).toHaveLength(1);

    const carbon = byModel("gemini-4-carbon");
    expect(carbon).toHaveLength(2);
    expect(carbon.every((event) => event.timestamp === minutes(4))).toBe(true);
    expect(carbon.map((event) => event.outputTokens).sort((a, b) => a - b)).toEqual([10, 50]);

    expect(byModel("gemini-4-argon")).toHaveLength(1);
    expect(byModel("antigravity-model-1999")).toHaveLength(1);
    expect(data.events).toHaveLength(6);
  });

  test("reads conversations, workspaces and encrypted leftovers", async () => {
    const data = await collectAntigravityUsageData();
    const convA = data.conversations.find((conversation) => conversation.id === "conv-a");
    expect(convA?.workspace).toBe("file:///Users/me/project-a");
    expect(convA?.userMessageTimes).toEqual([minutes(0), minutes(3)]);
    expect(data.conversations).toHaveLength(2);
    expect(data.encryptedConversations).toBe(1);
    expect(data.unreadableDatabases).toEqual([]);
  });
});

describe("calculateStatsFromData", () => {
  test("filters by year and prices known models", async () => {
    const data = await collectAntigravityUsageData();
    const stats = calculateStatsFromData(data, 2026);

    expect(stats.totalSessions).toBe(2);
    expect(stats.totalMessages).toBe(3);
    expect(stats.totalProjects).toBe(1);
    expect(stats.totalCachedInputTokens).toBe(21_000);
    expect(stats.totalOutputTokens).toBe(300 + 5 + 50 + 10 + 4);
    expect(stats.totalReasoningTokens).toBe(200);
    expect(stats.unpricedModels).toEqual(["antigravity-model-1999"]);
    expect(stats.topModels[0]?.name).toBe("Gemini 3.7 Flash");

    const expectedCost =
      (1000 * 0.75 + 20_000 * 0.075 + 300 * 3.75) / 1e6 + // gemini-3.7-flash
      (100 * 0.25 + 5 * 1.5) / 1e6 + // gemini-3.1-flash-lite
      (500 * 2 + 1000 * 0.1 + 50 * 10) / 1e6 + // gemini-4-carbon
      (500 * 2 + 10 * 10) / 1e6; // gemini-4-carbon retry
    expect(stats.totalCost).toBeCloseTo(expectedCost, 12);

    const previousYear = calculateStatsFromData(data, 2025);
    expect(previousYear.totalSessions).toBe(1);
    expect(previousYear.topModels[0]?.id).toBe("gemini-4-argon");
  });
});
