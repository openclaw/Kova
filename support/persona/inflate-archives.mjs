#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import { zstdDecompressSync } from "node:zlib";
import { lstat, mkdir, open, readFile, readdir, realpath, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { readStoredSession, resolveSessionDatabasePath } from "./session-store-read.mjs";
import { openCollectionFixture, readCollectionRows, collectionPolicy } from "./session-collections.mjs";
import { savedContent } from "./environment-content.mjs";

const DAY = 86400000;
export const archiveKeys = Object.freeze(Object.fromEntries(["reset", "deleted", "history", "cap", "victim"].map((kind) => [kind, `agent:main:kova-persona-budget-${kind}`])));
export const archiveRequests = {
  describe: (key) => ({ method: "sessions.describe", params: { key } }),
  delete: (key, sessionId) => ({ method: "sessions.delete", params: { key, expectedSessionId: sessionId, deleteTranscript: true } }),
};
export const archiveRequestCases = { describe: [[archiveKeys.deleted]], delete: [[archiveKeys.deleted, "saved-session-id"]] };

async function directory(state, { create = false } = {}) {
  await resolveSessionDatabasePath(state, "main");
  const path = join(await realpath(state), "agents", "main", "sessions");
  if (create) await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("archive directory must belong to the selected environment");
  return path;
}

async function policy(state) {
  const config = JSON5.parse(await readFile(join(state, "openclaw.json"), "utf8"));
  const value = config.session?.maintenance;
  if (value?.mode !== "warn" || value.preserveRecent !== false) throw new Error("archive fixtures require warning maintenance and preserveRecent=false");
  return value;
}

function owned(rows, kind) {
  const entry = rows.get(archiveKeys[kind]);
  if (!entry?.sessionId || entry.label !== `kova-persona-budget-${kind}`) throw new Error(`archive ${kind} session identity is absent`);
  return entry;
}

export async function writeResetArchive({ state, mb = 8 }) {
  if (!Number.isInteger(mb) || mb < 1 || mb > 64) throw new EntryError("archive size must be 1 to 64 MiB", 2);
  await policy(state);
  const session = await readStoredSession(state, archiveKeys.reset, { maxEvents: 100, maxBytes: 4 * 1024 * 1024 });
  if (session.entry.label !== "kova-persona-budget-reset") throw new Error("reset archive source differs");
  const old = Date.now() - 60 * DAY;
  const stamp = new Date(old).toISOString().replaceAll(":", "-");
  const path = join(await directory(state, { create: true }), `${session.sessionId}.jsonl.reset.${stamp}`);
  const file = await open(path, "wx", 0o600);
  try {
    let bytes = 0;
    const append = async (value) => { const line = JSON.stringify(value) + "\n"; await file.write(line); bytes += Buffer.byteLength(line); };
    await append(session.events.find(({ event }) => event.type === "session")?.event ?? { type: "session", version: 3, id: session.sessionId, timestamp: new Date(old).toISOString(), cwd: state });
    for (const { event } of session.events) if (event.type !== "session") await append(event);
    let parentId = session.events.at(-1)?.event?.id ?? null;
    for (let index = 0; bytes < mb * 1024 * 1024; index++) {
      const id = `kova-archive-${index}`;
      await append({ type: "message", id, parentId, timestamp: new Date(old).toISOString(), message: { role: "user", content: [{ type: "text", text: "KOVA_RETAINED_NOTE ".repeat(2048) }] } });
      parentId = id;
    }
    await file.sync();
  } finally { await file.close(); }
  await utimes(path, new Date(old), new Date(old));
  return {};
}

export async function deleteArchiveSession({ rpc, state }) {
  const { session } = await rpc(archiveRequests.describe(archiveKeys.deleted));
  if (session?.key !== archiveKeys.deleted || !session.sessionId || session.label !== "kova-persona-budget-deleted") throw new Error("delete archive source differs");
  const result = await rpc(archiveRequests.delete(session.key, session.sessionId));
  if (result?.ok !== true || result.deleted !== true || !Array.isArray(result.archived) || !result.archived.length) throw new Error("session deletion produced no archive");
  await savedContent(state, "deleted-archive.json", { sessionId: session.sessionId });
  return {};
}

export async function patchArchiveSession({ env, state, kind, writeFixture = openCollectionFixture }) {
  if (!["history", "cap", "victim"].includes(kind)) throw new EntryError("unknown archive metadata fixture", 2);
  const maintenance = await policy(state), resolved = collectionPolicy({ session: { maintenance } });
  const maintenanceConfig = { mode: "warn", maxEntries: resolved.maxEntries, pruneAfterMs: resolved.pruneAfter, archiveDashboardAfterMs: resolved.dashboardAfter, modelRunPruneAfterMs: DAY, preserveRecentMs: null, resetArchiveRetentionMs: null, maxDiskBytes: null, highWaterBytes: null };
  const entry = owned(await readCollectionRows(state, "main"), kind);
  const update = await writeFixture(env, state);
  const old = Date.now() - 90 * DAY;
  const fields = { updatedAt: old, lastInteractionAt: old, lastActivityAt: old, sessionStartedAt: old };
  if (kind === "cap") Object.assign(fields, { archivedAt: old, archiveReason: "active-session-cap" });
  if (kind === "history") Object.assign(fields, { previousSessionId: undefined, usageFamilySessionIds: undefined, compactionCheckpoints: undefined });
  const nextSessionId = kind === "history" ? randomUUID() : undefined;
  await update({ agentId: "main", key: archiveKeys[kind], sessionId: entry.sessionId, fields, maintenanceConfig, nextSessionId });
  if (nextSessionId) {
    await savedContent(state, "unreferenced-history.json", { key: archiveKeys.history, previousId: entry.sessionId, sessionId: nextSessionId });
    return { sessionId: nextSessionId };
  }
  return {};
}

function bytes(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const matched = typeof value === "string" && /^(\d+)\s*(kb|mb|gb)$/i.exec(value);
  if (!matched) throw new Error("disk budget must be a positive byte size");
  return Number(matched[1]) * ({ kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[matched[2].toLowerCase()];
}

async function readReceipt(state, name) {
  const root = await realpath(state), dir = join(root, "kova-persona"), path = join(dir, name);
  const parent = await lstat(dir), file = await lstat(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 4096) throw new Error("invalid archive receipt");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function checkArchiveContent({ state }) {
  const config = await policy(state), budget = bytes(config.maxDiskBytes);
  const rows = await readCollectionRows(state, "main");
  const reset = owned(rows, "reset"), victim = owned(rows, "victim"), cap = owned(rows, "cap"), history = owned(rows, "history");
  if (rows.has(archiveKeys.deleted) || !Number.isFinite(cap.archivedAt) || cap.archiveReason !== "active-session-cap" || victim.archivedAt !== undefined || victim.pinnedAt !== undefined || victim.updatedAt > Date.now() - 60 * DAY) throw new Error("disk budget cleanup candidates differ");
  const deleted = await readReceipt(state, "deleted-archive.json"), unreferenced = await readReceipt(state, "unreferenced-history.json");
  if (unreferenced.key !== archiveKeys.history || history.sessionId !== unreferenced.sessionId || [...rows.values()].some((row) => [row.sessionId, row.previousSessionId, ...(row.usageFamilySessionIds ?? []), ...(row.compactionCheckpoints ?? []).flatMap((point) => [point.sessionId, point.preCompaction?.sessionId, point.postCompaction?.sessionId])].includes(unreferenced.previousId))) throw new Error("historical transcript remains referenced");
  const database = await resolveSessionDatabasePath(state, "main");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    if (!db.prepare("SELECT 1 FROM session_windows WHERE session_id = ? AND session_key = ?").get(unreferenced.sessionId, archiveKeys.history) || !db.prepare("SELECT 1 FROM session_windows WHERE session_id = ? AND session_key = ?").get(unreferenced.previousId, archiveKeys.history) || !db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ? LIMIT 1").get(unreferenced.previousId)) throw new Error("unreferenced transcript history is absent");
  } finally { db.close(); }
  const dir = await directory(state), files = await readdir(dir);
  const archive = async (id, reason) => {
    const matches = files.filter((name) => name.startsWith(`${id}.jsonl.${reason}.`) && /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:\.\d{3})?Z(?:\.[a-f0-9]{32})?(?:\.zst)?$/.test(name.slice(`${id}.jsonl.${reason}.`.length)));
    if (!matches.length) throw new Error(`retained ${reason} archive is absent`);
    let total = 0;
    for (const name of matches) {
      const info = await lstat(join(dir, name));
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 65 * 1024 * 1024) throw new Error("invalid retained archive");
      const raw = await readFile(join(dir, name));
      const content = name.endsWith(".zst") ? zstdDecompressSync(raw, { maxOutputLength: 65 * 1024 * 1024 }) : raw;
      const lines = new TextDecoder("utf-8", { fatal: true }).decode(content).trimEnd().split("\n");
      if (lines.length > 10000) throw new Error("retained archive exceeds its event limit");
      const events = lines.map((line) => JSON.parse(line));
      if (events[0]?.type !== "session" || events[0].id !== id || !events.some((event) => event.type === "message" && event.message?.role === "user") || !events.some((event) => event.type === "message" && event.message?.role === "assistant")) throw new Error("retained archive has no complete session history");
      total += info.size;
    }
    return total;
  };
  // A durable subset above the budget proves the full physical usage is above it,
  // including after export checkpoints have removed the WAL.
  const durableBytes = (await lstat(database)).size + await archive(reset.sessionId, "reset") + await archive(deleted.sessionId, "deleted");
  if (durableBytes <= budget) throw new Error("durable session bytes do not exceed the disk budget");
  return { victimKey: archiveKeys.victim, victimSessionId: victim.sessionId };
}

async function main() {
  const argv = process.argv.slice(2), operation = argv.shift();
  if (["history", "cap", "victim"].includes(operation)) process.env.OPENCLAW_LOG_LEVEL = "warn";
  await runEntry({ mb: { type: "string", pattern: /^\d+$/ } }, async (context) => {
    if (operation === "reset") return writeResetArchive({ ...context, mb: Number(context.args.mb ?? 8) });
    if (operation === "delete") return withSessionClient(context.env, (rpc) => deleteArchiveSession({ ...context, rpc }));
    if (operation === "check") return checkArchiveContent(context);
    return patchArchiveSession({ ...context, kind: operation });
  }, argv, (args) => {
    if (!["reset", "delete", "history", "cap", "victim", "check"].includes(operation)) throw new EntryError("unknown archive operation", 2);
    if (args.mb !== undefined && (operation !== "reset" || Number(args.mb) < 1 || Number(args.mb) > 64)) throw new EntryError("--mb is only valid for a 1 to 64 MiB reset archive", 2);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
