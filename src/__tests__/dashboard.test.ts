import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { collectAntigravityUsageData, type AntigravityUsageData } from "../collector";
import { buildDashboardPayload, workspacePath } from "../web/adapter";
import { renderDashboardHtml, serializeForScript } from "../web/render";
import { toDayNumber, type DashboardPayload } from "../web/types";
import { encode, timestamp, usage, type Field } from "./proto-builder";

const T0 = new Date(2026, 9, 27, 23, 30).getTime(); // local late evening
const minutes = (n: number) => T0 + n * 60_000;

let root: string;
let previousEnv: string | undefined;
let data: AntigravityUsageData;
let payload: DashboardPayload;

function createConversation(dir: string, id: string, workspace: string | null, build: (db: Database) => void) {
  const db = new Database(join(dir, `${id}.db`), { create: true });
  db.run("CREATE TABLE trajectory_metadata_blob (id text, data blob)");
  db.run(
    "CREATE TABLE steps (idx integer primary key, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob)"
  );
  db.run("CREATE TABLE gen_metadata (idx integer primary key, data blob, size integer NOT NULL DEFAULT 0)");
  const fields: Field[] = [];
  if (workspace) fields.push({ n: 1, msg: [{ n: 1, str: workspace }] });
  fields.push({ n: 2, msg: timestamp(minutes(0)) });
  db.query("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(encode(fields));
  build(db);
  db.close();
}

function addStep(db: Database, idx: number, stepType: number, ms: number, extra: Field[] = [], payload?: Field[]) {
  const metadata = encode([{ n: 1, msg: timestamp(ms) }, ...extra]);
  db.query("INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)").run(
    idx,
    stepType,
    metadata,
    payload ? encode(payload) : null
  );
}

const userPayload = (text: string): Field[] => [{ n: 1, varint: 14 }, { n: 19, msg: [{ n: 2, str: text }, { n: 3, msg: [{ n: 1, str: text }] }] }];
const toolCall = (id: string, name: string): Field[] => [{ n: 4, msg: [{ n: 1, str: id }, { n: 2, str: name }, { n: 9, str: name }] }];

beforeAll(async () => {
  root = mkdtempSync(join(os.tmpdir(), "agy-dash-test-"));
  const conversations = join(root, "antigravity", "conversations");
  const backup = join(root, "antigravity-backup", "conversations");
  mkdirSync(conversations, { recursive: true });
  mkdirSync(backup, { recursive: true });

  createConversation(conversations, "conv-a", "file:///Users/me/My%20Project", (db) => {
    addStep(db, 0, 14, minutes(0), [], userPayload("Plot the dropsonde profiles"));
    addStep(db, 1, 8, minutes(1), toolCall("call_1", "view_file"));
    addStep(db, 2, 15, minutes(2), [{ n: 9, msg: usage({ modelId: 1298, input: 1000, cacheRead: 5000, output: 300, thinking: 200, visible: 100, responseId: "r1" }) }]);
    addStep(db, 3, 14, minutes(40), [], userPayload("now label the axes")); // next local day
    addStep(db, 4, 132, minutes(41), toolCall("call_2", "run_command"));
    addStep(db, 5, 15, minutes(42), [{ n: 9, msg: usage({ modelId: 9999, input: 50, output: 5, responseId: "r2" }) }]);
  });
  // A copy of the same conversation in another data root must not double count.
  copyFileSync(join(conversations, "conv-a.db"), join(backup, "conv-a.db"));

  createConversation(conversations, "conv-b", null, (db) => {
    addStep(db, 0, 14, minutes(100), [], userPayload("  what is\nthe   erosion rate of ceramic TPS tiles at Mach 25 during reentry, roughly, and why does it matter?  "));
    addStep(db, 1, 15, minutes(101), [{ n: 9, msg: usage({ modelId: 1298, input: 10, output: 20, responseId: "r3" }) }]);
  });

  const summaries = new Database(join(root, "antigravity", "conversation_summaries.db"), { create: true });
  summaries.run(
    "CREATE TABLE conversation_summaries (conversation_id text primary key, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '')"
  );
  summaries.query("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run("conv-a", "", "</script>Dropsonde $& plots");
  summaries.query("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run("conv-b", "", "");
  summaries.close();

  previousEnv = process.env.ANTIGRAVITY_DATA_DIR;
  process.env.ANTIGRAVITY_DATA_DIR = [join(root, "antigravity"), join(root, "antigravity-backup")].join(",");
  data = await collectAntigravityUsageData();
  payload = await buildDashboardPayload(2026, data);
});

afterAll(() => {
  if (previousEnv === undefined) delete process.env.ANTIGRAVITY_DATA_DIR;
  else process.env.ANTIGRAVITY_DATA_DIR = previousEnv;
  rmSync(root, { recursive: true, force: true });
});

describe("collector extensions", () => {
  test("records first prompt, tool calls, end time and summary titles", () => {
    const a = data.conversations.find((c) => c.id === "conv-a")!;
    expect(a.firstPrompt).toBe("Plot the dropsonde profiles");
    expect(a.toolCalls.map((c) => [c.id, c.name])).toEqual([
      ["call_1", "view_file"],
      ["call_2", "run_command"],
    ]);
    expect(a.endedAt).toBe(minutes(42));
    expect(a.title).toBe("</script>Dropsonde $& plots"); // empty title falls back to preview
    expect(data.conversations.find((c) => c.id === "conv-b")!.title).toBeUndefined();
  });
});

describe("dashboard adapter", () => {
  test("maps events, prompts and tools to conversations without double counting", () => {
    expect(payload.sessions.map((s) => s.id)).toEqual(["conv-a", "conv-b"]);
    const sum = (k: number) => payload.usage.reduce((s, r) => s + r[k], 0);
    expect(sum(4)).toBe(3);
    expect(sum(5)).toBe(1060);
    expect(payload.prompts.reduce((s, r) => s + r[3], 0)).toBe(3);
    expect(payload.toolCalls.reduce((s, r) => s + r[3], 0)).toBe(2);
    expect(payload.tools.sort()).toEqual(["run_command", "view_file"]);
    for (const row of payload.usage) expect(payload.sessions[row[0]].id).toBe(row[5] === 10 ? "conv-b" : "conv-a");
  });

  test("uses local calendar days and hours", () => {
    const day0 = toDayNumber(new Date(T0));
    const a = payload.prompts.filter((r) => r[0] === 0).sort((x, y) => x[1] - y[1]);
    expect(a.map((r) => [r[1], r[2]])).toEqual([
      [day0, 23],
      [day0 + 1, 0],
    ]);
  });

  test("workspace URIs become project paths; titles fall back to the first prompt", () => {
    expect(payload.projects).toEqual([{ path: "/Users/me/My Project", name: "My Project" }]);
    expect(payload.sessions[0].project).toBe(0);
    expect(payload.sessions[1].project).toBe(-1);
    expect(payload.sessions[0].title).toBe("</script>Dropsonde $& plots");
    expect(payload.sessions[1].title).toBe("what is the erosion rate of ceramic TPS tiles at Mach 25 during reentry, roughl…");
    expect(payload.sessions[1].title!.length).toBe(80);
  });

  test("unpriced models are flagged and add no cost", () => {
    const unknown = payload.models.find((m) => m.id === "antigravity-model-9999")!;
    expect(unknown.priced).toBe(false);
    expect(payload.models.find((m) => m.id === "gemini-3.7-flash")!.priced).toBe(true);
    const idx = payload.models.indexOf(unknown);
    expect(payload.usage.filter((r) => r[3] === idx).every((r) => r[10] === 0)).toBe(true);
    expect(payload.hasReasoning).toBe(true);
  });

  test("workspacePath decodes file URIs", () => {
    expect(workspacePath("file:///C:/Users/me/a%20b/")).toBe("C:/Users/me/a b");
    expect(workspacePath("vscode-remote://ssh-remote+box/home/me")).toBe("vscode-remote://ssh-remote+box/home/me");
  });
});

describe("dashboard render", () => {
  test("inlines data safely and fills every placeholder", () => {
    const html = renderDashboardHtml(payload, [{ weight: 400, data: new Uint8Array([1, 2, 3]).buffer }]);
    for (const token of ["__DATA__", "/*__THEME__*/", "/*__FONTS__*/", "__TITLE__"]) expect(html).not.toContain(token);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("color-scheme:dark;");
    const start = html.indexOf('type="application/json">') + 24;
    const json = JSON.parse(html.slice(start, html.indexOf("</script>", start)));
    expect(json.sessions[0].title).toBe("</script>Dropsonde $& plots");
    expect(json.product.name).toBe("Antigravity");
  });

  test("serializeForScript escapes markup and line separators", () => {
    expect(serializeForScript({ a: "<&>\u2028\u2029" })).toBe('{"a":"\\u003c\\u0026\\u003e\\u2028\\u2029"}');
  });
});
