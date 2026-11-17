// Reads Antigravity conversation databases (~/.gemini/antigravity/conversations/<id>.db).
//
// Each conversation is a SQLite file whose rows hold schema-less protobuf blobs:
//   gen_metadata.data          one row per model request; usage in field 1.4, retries in 1.17[].2
//   steps.metadata             per-step metadata; usage copy in 9, retries in 28[].2, model info in 24
//   trajectory_metadata_blob   workspace URI in 1.1 and creation time in 2
// The same request is usually recorded in both gen_metadata and steps, so usages are merged by
// their response/message IDs. Older conversations were stored as encrypted <id>.pb files, which
// cannot be read.

import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import { basename, extname, join } from "node:path";

import {
  getAllBytes,
  getMessage,
  getPackedVarints,
  getString,
  getTimestampMs,
  getVarint,
  tryDecode,
  type ProtoField,
} from "./protobuf";
import { UNKNOWN_MODEL_PREFIX, modelFromId, normalizeAntigravityModel } from "./antigravity-models";
import { hasPricing } from "./pricing";

const DATA_DIR_ENV = "ANTIGRAVITY_DATA_DIR";
const DEFAULT_ROOTS = [
  ".gemini/antigravity",
  ".gemini/antigravity-cli",
  ".gemini/antigravity-ide",
  ".gemini/antigravity-backup",
  ".gemini/antigravity-acp",
  ".config/antigravity",
];
const USER_INPUT_STEP_TYPE = 14;
const SUMMARIES_FILE = "conversation_summaries.db";

export interface AntigravityUsageEvent {
  sessionId: string;
  timestamp: number;
  model: string;
  // Uncached prompt tokens; cache reads and writes are separate.
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Billed output tokens, thinking included.
  outputTokens: number;
  reasoningTokens: number;
}

export interface ConversationInfo {
  id: string;
  createdAt: number;
  // Latest step time seen (createdAt when no step has one).
  endedAt: number;
  workspace?: string;
  // From the data root's conversation_summaries.db, when present.
  title?: string;
  // Text of the earliest user message, for untitled conversations.
  firstPrompt?: string;
  userMessageTimes: number[];
  toolCalls: ToolCallInfo[];
  stepCount: number;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  timestamp: number;
}

export interface AntigravityUsageData {
  events: AntigravityUsageEvent[];
  conversations: ConversationInfo[];
  // Conversations that only exist as encrypted .pb files.
  encryptedConversations: number;
  unreadableDatabases: string[];
}

interface RawUsage {
  modelId?: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  visibleOutputTokens: number;
  messageId?: string;
  responseId?: string;
  providerMessageId?: string;
}

interface Candidate {
  event: AntigravityUsageEvent;
  identities: string[];
  // 3: the record's own timestamp, 2: its step's timestamp, 1: conversation start, 0: file mtime
  timestampRank: number;
  // 2: resolved model, 1: unresolved ID, 0: nothing known
  modelRank: number;
}

interface ParsedDatabase {
  conversation: ConversationInfo;
  candidates: Candidate[];
}

export function getDataRoots(): { roots: string[]; custom: boolean } {
  const override = process.env[DATA_DIR_ENV];
  if (override) {
    return {
      roots: override
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      custom: true,
    };
  }
  const home = os.homedir();
  return { roots: DEFAULT_ROOTS.map((root) => join(home, root)), custom: false };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listConversationFiles(): Promise<{ databases: string[]; encrypted: string[]; summaries: string[] }> {
  const { roots, custom } = getDataRoots();
  const databases: string[] = [];
  const encrypted: string[] = [];
  const summaries: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const nested = join(root, "conversations");
    let dir: string;
    if (await isDirectory(nested)) {
      dir = nested;
    } else if (custom && (await isDirectory(root))) {
      dir = root;
    } else {
      continue;
    }
    for (const candidate of new Set([join(root, SUMMARIES_FILE), join(dir, SUMMARIES_FILE)])) {
      if (await isFile(candidate)) summaries.push(candidate);
    }

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ext = extname(entry);
      if (ext !== ".db" && ext !== ".pb") continue;
      const fullPath = join(dir, entry);
      const canonical = await realpath(fullPath).catch(() => fullPath);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      (ext === ".db" ? databases : encrypted).push(fullPath);
    }
  }

  return { databases: databases.sort(), encrypted: encrypted.sort(), summaries };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Conversation titles from conversation_summaries.db (`title`, else the generated `preview`). */
function readTitles(paths: string[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const path of paths) {
    try {
      const db = new Database(path, { readonly: true });
      try {
        if (!tableExists(db, "conversation_summaries")) continue;
        const rows = db.query("SELECT conversation_id AS id, title, preview FROM conversation_summaries").all() as Array<{
          id: unknown;
          title: unknown;
          preview: unknown;
        }>;
        for (const row of rows) {
          if (typeof row.id !== "string" || titles.has(row.id)) continue;
          const title = [row.title, row.preview].find((value) => typeof value === "string" && value.trim() !== "");
          if (typeof title === "string") titles.set(row.id, title.trim());
        }
      } finally {
        db.close();
      }
    } catch {
      // Optional metadata; ignore unreadable or locked files.
    }
  }
  return titles;
}

export async function checkAntigravityDataExists(): Promise<boolean> {
  const { databases, encrypted } = await listConversationFiles();
  return databases.length > 0 || encrypted.length > 0;
}

export async function collectAntigravityUsageData(): Promise<AntigravityUsageData> {
  const { databases, encrypted, summaries } = await listConversationFiles();
  const candidates: Candidate[] = [];
  const conversations = new Map<string, ConversationInfo>();
  const unreadableDatabases: string[] = [];

  for (const path of databases) {
    let parsed: ParsedDatabase | null;
    try {
      parsed = await parseConversationDatabase(path);
    } catch {
      unreadableDatabases.push(path);
      continue;
    }
    if (!parsed) continue;
    candidates.push(...parsed.candidates);
    mergeConversation(conversations, parsed.conversation);
  }

  const titles = readTitles(summaries);
  for (const conversation of conversations.values()) {
    conversation.title = titles.get(conversation.id) ?? conversation.title;
  }

  const readableIds = new Set(conversations.keys());
  for (const path of databases) {
    readableIds.add(basename(path, ".db"));
  }
  const encryptedIds = new Set(
    encrypted.map((path) => basename(path, ".pb")).filter((id) => !readableIds.has(id))
  );

  return {
    events: deduplicate(candidates),
    conversations: Array.from(conversations.values()),
    encryptedConversations: encryptedIds.size,
    unreadableDatabases,
  };
}

function mergeConversation(map: Map<string, ConversationInfo>, next: ConversationInfo) {
  const existing = map.get(next.id);
  if (!existing) {
    map.set(next.id, next);
    return;
  }
  // The same conversation can be copied into several data roots; keep the most complete copy.
  const keep = next.stepCount > existing.stepCount ? next : existing;
  map.set(next.id, {
    ...keep,
    createdAt: Math.min(existing.createdAt, next.createdAt),
    endedAt: Math.max(existing.endedAt, next.endedAt),
    workspace: keep.workspace ?? existing.workspace ?? next.workspace,
    firstPrompt: keep.firstPrompt ?? existing.firstPrompt ?? next.firstPrompt,
  });
}

// ---------------------------------------------------------------------------
// Database parsing
// ---------------------------------------------------------------------------

async function parseConversationDatabase(path: string): Promise<ParsedDatabase | null> {
  try {
    const db = new Database(path, { readonly: true });
    try {
      return await readConversation(db, path);
    } finally {
      db.close();
    }
  } catch (error) {
    // A database with an unmerged write-ahead log can refuse read-only access; read a copy.
    return readFromCopy(path, error);
  }
}

async function readFromCopy(path: string, originalError: unknown): Promise<ParsedDatabase | null> {
  const tempDir = await mkdtemp(join(os.tmpdir(), "agy-wrapped-"));
  try {
    const copyPath = join(tempDir, basename(path));
    await copyFile(path, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(`${path}${suffix}`, `${copyPath}${suffix}`).catch(() => undefined);
    }
    const db = new Database(copyPath);
    try {
      return await readConversation(db, path);
    } finally {
      db.close();
    }
  } catch {
    throw originalError;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function tableExists(db: Database, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

async function readConversation(db: Database, path: string): Promise<ParsedDatabase | null> {
  const hasGenerations = tableExists(db, "gen_metadata");
  const hasSteps = tableExists(db, "steps");
  if (!hasGenerations && !hasSteps) return null;

  const sessionId = basename(path, ".db");
  const fileTime = (await stat(path)).mtimeMs;

  let createdAt: number | undefined;
  let workspace: string | undefined;
  if (tableExists(db, "trajectory_metadata_blob")) {
    const row = db.query("SELECT data FROM trajectory_metadata_blob ORDER BY rowid LIMIT 1").get() as
      | { data: unknown }
      | null;
    const fields = tryDecode(toBytes(row?.data));
    createdAt = getTimestampMs(getMessage(fields, 2));
    workspace = getString(getMessage(fields, 1) ?? [], 1) ?? getString(fields, 7);
  }
  const fallbackTime = createdAt ?? fileTime;
  const fallbackRank = createdAt ? 1 : 0;

  const candidates: Candidate[] = [];
  const stepTimes = new Map<number, number>();
  const userMessageTimes: number[] = [];
  let stepCount = 0;

  type StepRow = { idx: number; step_type: number; metadata: unknown; payload?: unknown };
  const hasPayload =
    hasSteps && (db.query("PRAGMA table_info(steps)").all() as Array<{ name: string }>).some((c) => c.name === "step_payload");
  const stepRows = hasSteps
    ? (db
        .query(
          hasPayload
            ? `SELECT idx, step_type, metadata, CASE WHEN step_type = ${USER_INPUT_STEP_TYPE} THEN step_payload END AS payload FROM steps ORDER BY idx`
            : "SELECT idx, step_type, metadata FROM steps ORDER BY idx"
        )
        .all() as StepRow[])
    : [];
  const toolCalls: ToolCallInfo[] = [];
  let firstPrompt: { time: number; text: string } | undefined;

  type GenRow = { idx: number; data: unknown };
  const genRows = hasGenerations
    ? (db.query("SELECT idx, data FROM gen_metadata ORDER BY idx").all() as GenRow[])
    : [];

  // Step timestamps first, so generation rows can borrow them.
  const decodedSteps = stepRows.map((row) => {
    const fields = tryDecode(toBytes(row.metadata));
    const time = getTimestampMs(getMessage(fields, 1)) ?? getTimestampMs(getMessage(fields, 8));
    if (time !== undefined) stepTimes.set(row.idx, time);
    return { row, fields, time };
  });

  // Fallback for step usages that carry no model at all.
  let conversationModel: string | undefined;
  for (const row of genRows) {
    const chat = getMessage(tryDecode(toBytes(row.data)), 1) ?? [];
    const model =
      normalizeAntigravityModel(getString(chat, 19) ?? getString(chat, 21)) ?? modelFromId(getVarint(chat, 3));
    if (model) conversationModel = model;
  }

  for (const { row, fields, time } of decodedSteps) {
    stepCount++;
    if (row.step_type === USER_INPUT_STEP_TYPE) {
      userMessageTimes.push(time ?? fallbackTime);
      // The typed text is in payload field 19.2 (19.3.1 holds a copy).
      const input = getMessage(tryDecode(toBytes(row.payload)), 19) ?? [];
      const text = (getString(input, 2) ?? getString(getMessage(input, 3) ?? [], 1))?.trim();
      if (text && (!firstPrompt || (time ?? fallbackTime) < firstPrompt.time)) firstPrompt = { time: time ?? fallbackTime, text };
    }
    // Tool steps carry the call in metadata field 4: {1: call id, 2: tool name}.
    const call = getMessage(fields, 4);
    const toolName = call ? getString(call, 2) : undefined;
    if (call && toolName) {
      toolCalls.push({ id: getString(call, 1) ?? `step:${row.idx}`, name: toolName, timestamp: time ?? fallbackTime });
    }

    const info = getMessage(fields, 24) ?? [];
    const rowModelName = getString(info, 12) ?? getString(info, 8);
    const rowModelId = getVarint(info, 1) || undefined;
    const usages = collectUsages(getMessage(fields, 9), getAllBytes(fields, 28));

    usages.forEach((usage, i) => {
      addCandidate(candidates, usage, {
        sessionId,
        rowModelName,
        rowModelId,
        conversationModel,
        time: time ?? fallbackTime,
        timeRank: time !== undefined ? 3 : fallbackRank,
        fallbackIdentities: i === 0 ? [`step:${sessionId}:${row.idx}`] : [],
      });
    });
  }

  for (const row of genRows) {
    const root = tryDecode(toBytes(row.data));
    const chat = getMessage(root, 1) ?? [];
    const rowModelName = getString(chat, 19) ?? getString(chat, 21);
    const rowModelId = getVarint(chat, 3) || undefined;
    const stepIndices = getPackedVarints(root, 2);
    const ownTime = getTimestampMs(getMessage(getMessage(chat, 9) ?? [], 4));
    const stepTime = stepIndices.map((idx) => stepTimes.get(idx)).find((value) => value !== undefined);
    const [time, timeRank] =
      ownTime !== undefined
        ? [ownTime, 3]
        : stepTime !== undefined
        ? [stepTime, 2]
        : [fallbackTime, fallbackRank];

    const usages = collectUsages(getMessage(chat, 4), getAllBytes(chat, 17));
    const primaryIdentities =
      stepIndices.length > 0
        ? stepIndices.map((idx) => `step:${sessionId}:${idx}`)
        : [`gen:${sessionId}:${row.idx}`];

    usages.forEach((usage, i) => {
      addCandidate(candidates, usage, {
        sessionId,
        rowModelName,
        rowModelId,
        conversationModel,
        time,
        timeRank,
        fallbackIdentities: i === 0 ? primaryIdentities : [],
      });
    });
  }

  const started = createdAt ?? stepTimes.get(0) ?? fileTime;
  return {
    conversation: {
      id: sessionId,
      createdAt: started,
      endedAt: Array.from(stepTimes.values()).reduce((max, value) => Math.max(max, value), started),
      workspace,
      firstPrompt: firstPrompt?.text,
      userMessageTimes,
      toolCalls,
      stepCount,
    },
    candidates,
  };
}

function parseUsage(fields: ProtoField[]): RawUsage {
  return {
    modelId: getVarint(fields, 1) || undefined,
    inputTokens: getVarint(fields, 2) ?? 0,
    outputTokens: getVarint(fields, 3) ?? 0,
    cacheWriteTokens: getVarint(fields, 4) ?? 0,
    cacheReadTokens: getVarint(fields, 5) ?? 0,
    messageId: getString(fields, 7),
    reasoningTokens: getVarint(fields, 9) ?? 0,
    visibleOutputTokens: getVarint(fields, 10) ?? 0,
    responseId: getString(fields, 11),
    providerMessageId: getString(fields, 12),
  };
}

function isTokenBearing(usage: RawUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.visibleOutputTokens > 0
  );
}

function identityKeys(usage: RawUsage): string[] {
  const keys: string[] = [];
  if (usage.responseId) keys.push(`response:${usage.responseId}`);
  if (usage.providerMessageId) keys.push(`provider:${usage.providerMessageId}`);
  if (usage.messageId) keys.push(`message:${usage.messageId}`);
  return keys;
}

function sameCounts(a: RawUsage, b: RawUsage): boolean {
  return (
    a.modelId === b.modelId &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.visibleOutputTokens === b.visibleOutputTokens
  );
}

/** Primary usage first, then any retry attempts. Retry lists repeat the primary once; that copy is dropped. */
function collectUsages(primaryFields: ProtoField[] | undefined, retryBlobs: Uint8Array[]): RawUsage[] {
  const primary = primaryFields ? parseUsage(primaryFields) : undefined;
  const retries = retryBlobs
    .map((blob) => getMessage(tryDecode(blob), 2))
    .filter((fields): fields is ProtoField[] => fields !== undefined)
    .map(parseUsage);

  if (primary) {
    const primaryKeys = identityKeys(primary);
    const mirror = retries.findIndex(
      (retry) => sameCounts(retry, primary) && identityKeys(retry).every((key) => primaryKeys.includes(key))
    );
    if (mirror !== -1) retries.splice(mirror, 1);
  }

  return [primary, ...retries].filter((usage): usage is RawUsage => !!usage && isTokenBearing(usage));
}

interface CandidateContext {
  sessionId: string;
  rowModelName?: string;
  rowModelId?: number;
  conversationModel?: string;
  time: number;
  timeRank: number;
  fallbackIdentities: string[];
}

function resolveModel(usage: RawUsage, context: CandidateContext): [string, number] {
  // A row's model name describes the request only when the usage came from that same model;
  // a retry may have been served by another one.
  const rowMatches =
    context.rowModelId === undefined || usage.modelId === undefined || context.rowModelId === usage.modelId;
  const fromName = rowMatches ? normalizeAntigravityModel(context.rowModelName) : undefined;
  const fromId = modelFromId(usage.modelId) ?? (rowMatches ? modelFromId(context.rowModelId) : undefined);

  if (fromName && hasPricing(fromName)) return [fromName, 2];
  if (fromId) return [fromId, 2];
  if (fromName) return [fromName, 2];

  const id = usage.modelId ?? context.rowModelId;
  if (id !== undefined) return [`${UNKNOWN_MODEL_PREFIX}${id}`, 1];
  if (context.conversationModel) return [context.conversationModel, 1];
  return ["unknown", 0];
}

function addCandidate(candidates: Candidate[], usage: RawUsage, context: CandidateContext) {
  const [model, modelRank] = resolveModel(usage, context);
  const outputTokens = Math.max(usage.outputTokens, usage.visibleOutputTokens + usage.reasoningTokens);
  const identities = identityKeys(usage);

  candidates.push({
    event: {
      sessionId: context.sessionId,
      timestamp: context.time,
      model,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens,
      reasoningTokens: usage.reasoningTokens,
    },
    identities: identities.length > 0 ? identities : context.fallbackIdentities,
    timestampRank: context.timeRank,
    modelRank,
  });
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

function mergeInto(target: Candidate, duplicate: Candidate) {
  const a = target.event;
  const b = duplicate.event;
  a.inputTokens = Math.max(a.inputTokens, b.inputTokens);
  a.cacheReadTokens = Math.max(a.cacheReadTokens, b.cacheReadTokens);
  a.cacheWriteTokens = Math.max(a.cacheWriteTokens, b.cacheWriteTokens);
  a.outputTokens = Math.max(a.outputTokens, b.outputTokens);
  a.reasoningTokens = Math.max(a.reasoningTokens, b.reasoningTokens);

  if (duplicate.modelRank > target.modelRank) {
    a.model = b.model;
    target.modelRank = duplicate.modelRank;
  }
  if (
    duplicate.timestampRank > target.timestampRank ||
    (duplicate.timestampRank === target.timestampRank && b.timestamp < a.timestamp)
  ) {
    a.timestamp = b.timestamp;
    target.timestampRank = duplicate.timestampRank;
  }
  for (const identity of duplicate.identities) {
    if (!target.identities.includes(identity)) target.identities.push(identity);
  }
}

export function deduplicate(candidates: Candidate[]): AntigravityUsageEvent[] {
  const slots: Array<Candidate | null> = [];
  const byIdentity = new Map<string, number>();

  for (const candidate of candidates) {
    const matches = Array.from(
      new Set(
        candidate.identities
          .map((identity) => byIdentity.get(identity))
          .filter((index): index is number => index !== undefined)
      )
    ).sort((x, y) => x - y);

    if (matches.length === 0) {
      const index = slots.length;
      slots.push(candidate);
      for (const identity of candidate.identities) byIdentity.set(identity, index);
      continue;
    }

    const targetIndex = matches[0];
    const target = slots[targetIndex]!;
    for (const index of matches.slice(1)) {
      const other = slots[index];
      if (other) {
        mergeInto(target, other);
        slots[index] = null;
      }
    }
    mergeInto(target, candidate);
    for (const identity of target.identities) byIdentity.set(identity, targetIndex);
  }

  return slots
    .filter((slot): slot is Candidate => slot !== null)
    .map((slot) => slot.event)
    .sort((x, y) => x.timestamp - y.timestamp);
}

export type { Candidate as UsageCandidate };
