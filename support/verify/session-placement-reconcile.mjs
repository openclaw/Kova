#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import JSON5 from "json5";
import { conditionMain } from "./condition.mjs";

const warning = "worker placement session evidence resolution failed; treating all as unknown";
const maxLogBytes = 8 * 1024 * 1024;

async function inspectFile(path, { optional = false } = {}) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("placement evidence requires a regular clone file without aliases");
    return stat;
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}

async function placementDatabasePath(ctx, state) {
  // Check every component and sidecar before opening SQLite for fixture writes.
  const directory = await ctx.ownedPath(join(state, "state"), { directory: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("state database directory must belong to the clone");
  const path = await ctx.ownedPath(join(directory, "openclaw.sqlite"));
  await inspectFile(path);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await ctx.ownedPath(`${path}${suffix}`, { optional: true });
    await inspectFile(sidecar, { optional: true });
  }
  return path;
}

async function appendedWarnings(path, before) {
  const after = await inspectFile(path, { optional: true });
  if (!after) return { status: "unavailable", reason: "log file is absent", count: null };
  if (before && (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size)) {
    return { status: "unavailable", reason: "log file rotated during observation", count: null };
  }
  const offset = before?.size ?? 0;
  const length = after.size - offset;
  if (length > maxLogBytes) return { status: "unavailable", reason: "log growth exceeded the observation limit", count: null };
  const handle = await open(path, "r");
  try {
    const current = await handle.stat();
    if (current.dev !== after.dev || current.ino !== after.ino) return { status: "unavailable", reason: "log file changed before reading", count: null };
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const chunk = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { status: "observed", count: text.split("\n").filter((line) => line.includes(warning)).length };
  } finally {
    await handle.close();
  }
}

export async function runPlacementReconcile(ctx) {
  const duration = ctx.options["wait-ms"] ?? "85000";
  if (!/^\d+$/.test(duration) || !Number.isSafeInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 300000) {
    throw new Error("--wait-ms must be between 1 and 300000 milliseconds");
  }
  const waitMs = Number(duration);
  const state = await ctx.ownedPath(ctx.runtime.stateDir ?? join(ctx.runtime.root, ".openclaw"), { directory: true });
  const stateInfo = await lstat(state);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error("placement state must be a clone directory without aliases");
  const configPath = await ctx.ownedPath(ctx.runtime.configPath ?? join(state, "openclaw.json"));
  const config = JSON5.parse(await readFile(configPath, "utf8"));
  if (config.session?.store) throw new Error("placement fixtures require the clone's default session store");
  if (typeof config.logging?.file !== "string" || !config.logging.file) throw new Error("placement observation requires a clone-owned logging.file");
  const logPath = await ctx.ownedPath(config.logging.file, { optional: true });
  const databasePath = await placementDatabasePath(ctx, state);

  const client = await ctx.connect();
  const created = await client.request("sessions.create", { agentId: "main", incognito: true }, { timeoutMs: Math.min(30000, ctx.remaining()) });
  if (!/^agent:main:.*\bincognito-[^\s]+$/.test(created?.key ?? "") || typeof created.sessionId !== "string" || !created.sessionId) {
    throw new Error("sessions.create did not return an Incognito session identity");
  }
  const { key: sessionKey, sessionId } = created;
  ctx.cleanup(() => client.request("sessions.delete", { key: sessionKey, expectedSessionId: sessionId, deleteTranscript: true }, { timeoutMs: 10000 }));
  const createdIds = [sessionKey, sessionId];
  const sent = await client.request("chat.send", { sessionKey, message: "Reply with exact ASCII text KOVA_AGENT_OK only.", idempotencyKey: randomUUID() }, { timeoutMs: Math.min(30000, ctx.remaining()) });
  if (typeof sent?.runId !== "string" || !sent.runId) throw new Error("live Incognito control did not return a run id");
  createdIds.push(sent.runId);
  const control = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 30000 }, { timeoutMs: Math.min(35000, ctx.remaining()) });
  if (control?.status !== "ok") throw new Error("live Incognito control did not complete successfully");
  if (ctx.remaining() < waitMs + 10000) throw new Error("remaining timeout cannot cover the placement observation window");

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { allowExtension: false });
  ctx.cleanup(() => db.close());
  db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
  const selectLive = db.prepare("SELECT session_id, agent_id, session_key, state, transition_generation FROM worker_session_placements WHERE session_id = ? AND agent_id = 'main' AND session_key = ?");
  const liveBefore = selectLive.get(sessionId, sessionKey);
  if (!liveBefore) throw new Error("live Incognito control has no placement row");

  const invalidAgent = `kova-placement-${randomUUID()}`;
  const agents = await ctx.ownedPath(join(state, "agents"), { directory: true });
  const invalidDirectory = await ctx.ownedPath(join(agents, invalidAgent), { optional: true, directory: true });
  await mkdir(invalidDirectory);
  const invalidIdentity = await lstat(invalidDirectory);
  ctx.cleanup(async () => {
    const current = await lstat(invalidDirectory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!current) return;
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== invalidIdentity.dev || current.ino !== invalidIdentity.ino) {
      throw new Error("refusing to remove a replaced placement fixture directory");
    }
    await rm(invalidDirectory, { recursive: true });
  });
  await mkdir(join(invalidDirectory, "agent"));
  await mkdir(join(invalidDirectory, "agent", "openclaw-agent.sqlite"));

  const invalid = { sessionId: randomUUID(), agentId: invalidAgent, key: `agent:${invalidAgent}:probe` };
  const absent = { sessionId: randomUUID(), agentId: "main", key: `agent:main:dashboard:incognito-kova-placement-${randomUUID()}` };
  const fixtures = [invalid, absent];
  const timestamp = Date.now();
  let inserted = false;
  ctx.cleanup(() => {
    if (!inserted) return;
    const remove = db.prepare("DELETE FROM worker_session_placements WHERE session_id = ? AND agent_id = ? AND session_key = ? AND created_at_ms = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const fixture of fixtures) remove.run(fixture.sessionId, fixture.agentId, fixture.key, timestamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  const logBefore = await inspectFile(logPath, { optional: true });
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare("INSERT INTO worker_session_placements (session_id, agent_id, session_key, execution_mode, state, transition_generation, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES (?, ?, ?, NULL, 'local', 0, ?, ?, ?)");
    for (const fixture of fixtures) insert.run(fixture.sessionId, fixture.agentId, fixture.key, timestamp, timestamp, timestamp);
    db.exec("COMMIT");
    inserted = true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  createdIds.push(invalidAgent, ...fixtures.flatMap((fixture) => [fixture.sessionId, fixture.key]));
  const select = db.prepare("SELECT session_id, agent_id, session_key, state, transition_generation FROM worker_session_placements WHERE session_id IN (?, ?) ORDER BY CASE session_id WHEN ? THEN 0 ELSE 1 END");
  const rows = () => select.all(invalid.sessionId, absent.sessionId, invalid.sessionId);
  const before = rows();
  let after = before;
  const started = Date.now();
  while (after.some((row) => row.session_id === absent.sessionId) && Date.now() - started < waitMs) {
    await sleep(Math.max(1, Math.min(1000, waitMs - (Date.now() - started))), undefined, { signal: ctx.signal });
    after = rows();
  }
  const elapsedMs = Date.now() - started;
  const logs = await appendedWarnings(logPath, logBefore);
  const history = await ctx.observe(client, "chat.history", { sessionKey, limit: 10 }, { timeoutMs: 10000 });
  const messages = history.result?.messages;
  const liveAfter = selectLive.get(sessionId, sessionKey) ?? null;
  return {
    status: "observed", createdIds, sessionKey, sessionId, before, after, liveBefore, liveAfter,
    observationMs: elapsedMs,
    absentRetired: !after.some((row) => row.session_id === absent.sessionId),
    invalidRetained: after.some((row) => row.session_id === invalid.sessionId),
    liveRetained: liveAfter !== null,
    liveHistory: history.status === "completed" ? {
      status: history.status, elapsedMs: history.elapsedMs,
      sessionIdMatches: history.result?.sessionId === sessionId,
      userCount: Array.isArray(messages) ? messages.filter((entry) => entry.role === "user").length : 0,
      assistantCount: Array.isArray(messages) ? messages.filter((entry) => entry.role === "assistant").length : 0,
    } : history,
    broadWarnings: logs.count, logs,
  };
}

await conditionMain(import.meta.url, { id: "session-placement-reconcile", flags: ["wait-ms"], required: [], cleanupMs: 15000, timeoutMs: 180000 }, runPlacementReconcile);
