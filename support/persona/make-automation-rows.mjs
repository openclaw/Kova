#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import JSON5 from "json5";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { EntryError, runEntry } from "./common.mjs";
import { withSessionClient, sendSessionMessage } from "./session-content.mjs";
import { openCollectionFixture, readCollectionRows } from "./session-collections.mjs";
import { readStoredSession, requireSessionContentRuntime } from "./session-store-read.mjs";

const DAY = 86400000;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const modelRunPattern = /^agent:main:explicit:model-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hookPrefix = "hook:kova-persona-";
const configLimit = 2 * 1024 * 1024;
export const automationContent = Object.freeze({
  heartbeatKey: "agent:main:main:heartbeat",
  heartbeatBaseKey: "agent:main:main",
  heartbeatMarker: "KOVA_PERSONA_HEARTBEAT",
  modelLabel: "kova-persona-historical-model-run",
  modelMarker: "KOVA_PERSONA_HISTORICAL_MODEL_RUN",
  hookKey: "agent:main:hook:kova-persona-automation",
  hookMarker: "KOVA_PERSONA_HOOK",
});

export const automationRequests = {
  config: () => ({ method: "config.get", params: {} }),
  cronRun: (jobId) => ({ method: "cron.run", params: { id: jobId, mode: "force" } }),
  cronRuns: (jobId, runId) => ({ method: "cron.runs", params: { id: jobId, ...(runId ? { runId } : {}), limit: 20 } }),
  wake: () => ({ method: "wake", params: { mode: "now", text: `${automationContent.heartbeatMarker}: check the notebook and reply with KOVA_AGENT_OK.`, agentId: "main", sessionKey: automationContent.heartbeatBaseKey } }),
  createModelFixture: (key) => ({ method: "sessions.create", params: { key, agentId: "main", label: automationContent.modelLabel } }),
};
export const automationRequestCases = {
  config: [[]], cronRun: [["persona-cron-id"]], cronRuns: [["persona-cron-id"], ["persona-cron-id", "persona-run-id"]],
  wake: [[]], createModelFixture: [["agent:main:explicit:model-run-12345678-1234-4234-8234-123456789abc"]],
};

export function automationHookBody() {
  return {
    name: "kova-persona-automation", agentId: "main", sessionKey: "hook:kova-persona-automation",
    sessionMode: "persistent", wakeMode: "now", deliver: false, waitForCompletion: true,
    message: `${automationContent.hookMarker}: check the notebook and reply with KOVA_AGENT_OK.`,
    model: "openai/gpt-5.5", thinking: "off", timeoutSeconds: 120,
  };
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const inside = (root, path) => {
  const part = relative(root, path);
  if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error();
  return part;
};

/** Keep generated credentials in the selected environment, including atomic replacement files. */
async function hookConfigAccess(env, state) {
  if (!isAbsolute(env.root ?? "") || !isAbsolute(state ?? "") || resolve(state) !== resolve(env.stateDir ?? join(env.root, ".openclaw"))) throw new Error();
  const root = resolve(env.root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error();
  const rootReal = await realpath(root);
  const statePart = inside(root, resolve(state));
  const configured = env.configPath ?? join(state, "openclaw.json");
  if (!isAbsolute(configured)) throw new Error();
  const configPart = inside(resolve(state), resolve(configured));
  const path = join(rootReal, statePart, configPart);
  const directories = [];
  let directory = rootReal;
  for (const part of relative(rootReal, dirname(path)).split(sep)) {
    directory = join(directory, part);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    directories.push({ path: directory, dev: info.dev, ino: info.ino });
  }
  const observed = await lstat(path);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || observed.size > configLimit) throw new Error();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== observed.dev || info.ino !== observed.ino || info.size > configLimit) throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== info.size) throw new Error();
    const config = JSON5.parse(bytes.subarray(0, length).toString("utf8"));
    if (!record(config)) throw new Error();
    const assertCurrent = async () => {
      const currentRoot = await lstat(root);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino || await realpath(root) !== rootReal) throw new Error();
      for (const previous of directories) {
        const current = await lstat(previous.path);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== previous.dev || current.ino !== previous.ino) throw new Error();
      }
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw new Error();
    };
    await assertCurrent();
    return { path, config, assertCurrent };
  } finally { await file.close(); }
}

async function readHookConfig(state, env) {
  try { return (await hookConfigAccess(env, state)).config.hooks; }
  catch { throw new Error("could not read the selected environment's hook configuration"); }
}

export function automationHookConfiguration(config, newToken = () => randomBytes(32).toString("hex")) {
  if (!record(config) || (config.gateway?.bind !== undefined && config.gateway.bind !== "loopback")) throw new Error("persona hooks require the existing loopback Gateway configuration");
  const pending = [config];
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "$include")) throw new Error("persona hook configuration must not use included configuration files");
      pending.push(...Object.values(value));
    }
  }
  const hooks = config.hooks ?? {};
  if (!record(hooks)) throw new Error("existing hook configuration is not the bounded persona policy");
  const allowed = new Set(["internal", "enabled", "path", "token", "defaultSessionKey", "allowRequestSessionKey", "allowedSessionKeyPrefixes", "allowedAgentIds"]);
  if (Object.keys(hooks).some((key) => !allowed.has(key))) throw new Error("existing hook configuration is not the bounded persona policy");
  if (hooks.token !== undefined) {
    if (typeof hooks.token !== "string" || !/^[a-zA-Z0-9_-]{32,256}$/.test(hooks.token) || hooks.enabled !== true || (hooks.path !== undefined && hooks.path !== "/hooks") || hooks.defaultSessionKey !== "hook:kova-persona-automation" || hooks.allowRequestSessionKey !== true || !Array.isArray(hooks.allowedSessionKeyPrefixes) || hooks.allowedSessionKeyPrefixes.length !== 1 || hooks.allowedSessionKeyPrefixes[0] !== hookPrefix || !Array.isArray(hooks.allowedAgentIds) || hooks.allowedAgentIds.length !== 1 || hooks.allowedAgentIds[0] !== "main") throw new Error("existing hook configuration is not the bounded persona policy");
    return config;
  }
  if (Object.keys(hooks).some((key) => key !== "internal" && !(key === "enabled" && hooks.enabled === false))) throw new Error("existing hook configuration is not the bounded persona policy");
  const token = newToken();
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new Error("could not generate the persona hook credential");
  return { ...config, hooks: { ...hooks, enabled: true, path: "/hooks", token, defaultSessionKey: "hook:kova-persona-automation", allowRequestSessionKey: true, allowedSessionKeyPrefixes: [hookPrefix], allowedAgentIds: ["main"] } };
}

async function assertStoppedHookGateway(port) {
  for (const host of ["127.0.0.1", "::1"]) await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.once("connect", () => finish(new Error("persona Gateway is running")));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" || (host === "::1" && error.code === "EADDRNOTAVAIL") ? undefined : new Error("persona Gateway stop could not be established")));
    socket.setTimeout(2000, () => finish(new EntryError("persona Gateway stop could not be established", 3)));
  });
}

export async function configureAutomationHook({ env, state, assertStopped = assertStoppedHookGateway, newToken }) {
  let temporary;
  try {
    if (!/^[a-z][a-z0-9-]{0,39}-[a-z0-9]+-[a-f0-9]{32}$/.test(env.name ?? "") || env.protected !== false || env.serviceEnabled !== false || env.serviceRunning !== false) throw new Error();
    const port = Number(env.gatewayPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    await assertStopped(port);
    const access = await hookConfigAccess(env, state);
    const next = automationHookConfiguration(access.config, newToken);
    if (next === access.config) return {};
    temporary = `${access.path}.kova-${randomUUID()}`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(`${JSON.stringify(next, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await assertStopped(port);
    await access.assertCurrent();
    await rename(temporary, access.path);
    temporary = undefined;
    return {};
  } catch (error) {
    throw new EntryError("could not configure the mutable stopped persona's local hook", error?.exitCode === 3 ? 3 : 1);
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

function text(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
}

export function hasCompletedAutomationContent(stored, marker, afterSeq = -1) {
  let input = marker === undefined;
  for (const { event, seq } of stored.events) {
    if (seq <= afterSeq) continue;
    if (event.type !== "message") continue;
    const message = event.message;
    if (message?.role === "user" && text(message).includes(marker)) input = true;
    if (input && message?.role === "assistant" && text(message).trim() === "KOVA_AGENT_OK" && message.stopReason === "stop") return true;
  }
  return false;
}

async function waitFor(read, description, { timeoutMs = 120000, now = Date.now, pause = sleep } = {}) {
  const deadline = now() + timeoutMs;
  do {
    const result = await read();
    if (result) return result;
    if (now() >= deadline) break;
    await pause(200);
  } while (now() < deadline);
  throw new EntryError(`timed out waiting for ${description}`, 3);
}

function assertStored(stored, key, sessionId) {
  if (stored?.key !== key || typeof stored.sessionId !== "string" || !stored.sessionId || stored.entry?.sessionId !== stored.sessionId || (sessionId !== undefined && stored.sessionId !== sessionId)) throw new Error("automation session has no matching persisted identity");
}

async function previousSession(readSession, state, key) {
  try { return await readSession(state, key); }
  catch (error) { if (error.message === "stored session is absent") return undefined; throw error; }
}

function lastSequence(before, stored) {
  return before?.sessionId === stored.sessionId ? before.events.reduce((maximum, { seq }) => Math.max(maximum, seq), -1) : -1;
}

export async function runAutomationHook({ env, state, readSession = readStoredSession, readConfig = readHookConfig, send = fetch }) {
  const hooks = await readConfig(state, env);
  if (hooks?.enabled !== true || typeof hooks.token !== "string" || !hooks.token.trim() || hooks.allowRequestSessionKey !== true || (hooks.path !== undefined && hooks.path !== "/hooks") || !hooks.allowedSessionKeyPrefixes?.some((prefix) => typeof prefix === "string" && "hook:kova-persona-automation".startsWith(prefix))) throw new Error("automation hook requires the configured persona hook credential and session policy");
  const port = Number(env.gatewayPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("automation hook requires the selected environment's Gateway port");
  const before = await previousSession(readSession, state, automationContent.hookKey);
  let result;
  try {
    const response = await send(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(130000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hooks.token}` },
      body: JSON.stringify(automationHookBody()),
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new Error();
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    result = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) {
    throw new EntryError("persona hook request failed", ["TimeoutError", "AbortError"].includes(error?.name) ? 3 : 1);
  }
  if (result?.ok !== true || typeof result.runId !== "string" || !result.runId || result.completion?.status !== "ok") throw new Error("persona hook did not report completed execution");
  const current = await readSession(state, automationContent.hookKey);
  assertStored(current, automationContent.hookKey);
  if (current.entry.hookExternalContentSource !== "webhook" || !hasCompletedAutomationContent(current, automationContent.hookMarker, lastSequence(before, current))) throw new Error("persona hook has no newly completed persisted content");
  return { key: current.key, sessionId: current.sessionId, runId: result.runId };
}

function cronIdentity(run, jobId, runId) {
  if (run?.jobId !== jobId || (runId !== undefined && run.runId !== runId)) throw new Error("cron completion belongs to another run");
  if (run.action !== "finished" || run.status !== "ok" || run.deliveryStatus !== "delivered") throw new Error("automation cron run did not finish with local conformance delivery");
  if (typeof run.runId !== "string" || !run.runId || typeof run.sessionId !== "string" || !run.sessionId || !run.sessionKey?.startsWith(`agent:main:cron:${jobId}:run:`)) throw new Error("cron completion has no exact persisted run identity");
  // Completed run aliases are removed after their transcript is retained by
  // the stable job row. That surviving row is the durable persona content.
  return { key: `agent:main:cron:${jobId}`, sessionId: run.sessionId, runId: run.runId };
}

export async function runAutomationCron({ rpc, state, jobId, readSession = readStoredSession, waitOptions }) {
  if (!idPattern.test(jobId ?? "")) throw new EntryError("a valid --job-id is required", 2);
  const accepted = await rpc(automationRequests.cronRun(jobId));
  if (accepted?.ok !== true || accepted.enqueued !== true || typeof accepted.runId !== "string" || !accepted.runId) throw new Error("cron run was not enqueued with an identity");
  const run = await waitFor(async () => {
    const page = await rpc(automationRequests.cronRuns(jobId, accepted.runId));
    if (!Array.isArray(page.entries)) throw new Error("cron run history is absent");
    const matches = page.entries.filter((entry) => entry.runId === accepted.runId);
    if (matches.length > 1) throw new Error("cron run identity is duplicated");
    return matches[0];
  }, "the accepted cron run", waitOptions);
  const identity = cronIdentity(run, jobId, accepted.runId);
  const stored = await readSession(state, identity.key);
  assertStored(stored, identity.key, identity.sessionId);
  if (!hasCompletedAutomationContent(stored)) throw new Error("cron run has no completed mock reply");
  return identity;
}

export async function runAutomationHeartbeat({ rpc, state, readSession = readStoredSession, waitOptions }) {
  const { config } = await rpc(automationRequests.config());
  const heartbeat = { ...config?.agents?.defaults?.heartbeat, ...config?.agents?.entries?.main?.heartbeat };
  if (heartbeat?.every !== "1m" || heartbeat.isolatedSession !== true || (heartbeat.session && !["main", automationContent.heartbeatBaseKey].includes(heartbeat.session))) throw new Error("automation heartbeat requires the one-minute isolated main-session configuration");
  const before = await previousSession(readSession, state, automationContent.heartbeatKey);
  const response = await rpc(automationRequests.wake());
  if (response?.ok !== true) throw new Error("heartbeat wake was not accepted");
  return waitFor(async () => {
    let stored;
    try { stored = await readSession(state, automationContent.heartbeatKey); }
    catch (error) { if (error.message === "stored session is absent") return null; throw error; }
    assertStored(stored, automationContent.heartbeatKey);
    if (stored.entry.heartbeatIsolatedBaseSessionKey !== automationContent.heartbeatBaseKey) throw new Error("heartbeat row is not owned by the isolated heartbeat runner");
    if (!hasCompletedAutomationContent(stored, undefined, lastSequence(before, stored))) return null;
    return { key: stored.key, sessionId: stored.sessionId };
  }, "completed isolated heartbeat content", waitOptions);
}

export async function createModelRunFixture({ rpc, uuid = randomUUID }) {
  const key = `agent:main:explicit:model-run-${uuid()}`;
  if (!modelRunPattern.test(key)) throw new Error("model-run fixture requires a UUIDv4 identity");
  const result = await rpc(automationRequests.createModelFixture(key));
  if (result?.key !== key || typeof result.sessionId !== "string" || !result.sessionId) throw new Error("historical model-run fixture creation returned no identity");
  return { key, sessionId: result.sessionId };
}

async function modelFixture(state, readRows = readCollectionRows) {
  const matches = [...await readRows(state, "main")].filter(([key, entry]) => modelRunPattern.test(key) && entry.label === automationContent.modelLabel);
  if (matches.length !== 1) throw new Error("historical model-run fixture is absent or duplicated");
  return { key: matches[0][0], entry: matches[0][1] };
}

export async function populateModelRunFixture({ rpc, state, readRows = readCollectionRows }) {
  const { key, entry } = await modelFixture(state, readRows);
  const runId = await sendSessionMessage(rpc, key, `${automationContent.modelMarker}: historical saved probe content. Reply with KOVA_AGENT_OK.`);
  return { key, sessionId: entry.sessionId, runId };
}

export async function ageModelRunFixture({ rpc, state, writeFixture, readRows = readCollectionRows, readSession = readStoredSession, now = Date.now() }) {
  const { config } = await rpc(automationRequests.config());
  if (config?.session?.maintenance?.mode !== "warn") throw new Error("historical model-run fixture requires warning maintenance mode");
  const { key, entry } = await modelFixture(state, readRows);
  const stored = await readSession(state, key);
  assertStored(stored, key, entry.sessionId);
  if (!hasCompletedAutomationContent(stored, automationContent.modelMarker)) throw new Error("historical model-run fixture has no completed content");
  const old = now - 60 * DAY;
  await writeFixture({ agentId: "main", key, sessionId: entry.sessionId, fields: { updatedAt: old, lastInteractionAt: old, lastActivityAt: old, sessionStartedAt: old }, maintenanceConfig: { mode: "warn", maxEntries: 5000, pruneAfterMs: 30 * DAY, modelRunPruneAfterMs: DAY, preserveRecentMs: null } });
  return { key, sessionId: entry.sessionId };
}

export async function checkAutomationRows({ rpc, state, jobId, readRows = readCollectionRows, readSession = readStoredSession, now = Date.now() }) {
  const page = await rpc(automationRequests.cronRuns(jobId));
  if (!Array.isArray(page.entries) || !page.entries.length) throw new Error("automation cron history is absent");
  const run = page.entries.find((entry) => entry.status === "ok" && entry.deliveryStatus === "delivered");
  const cron = cronIdentity(run, jobId);
  const cronStored = await readSession(state, cron.key);
  assertStored(cronStored, cron.key, cron.sessionId);
  if (!hasCompletedAutomationContent(cronStored)) throw new Error("automation cron content is absent");
  const heartbeat = await readSession(state, automationContent.heartbeatKey);
  assertStored(heartbeat, automationContent.heartbeatKey);
  if (heartbeat.entry.heartbeatIsolatedBaseSessionKey !== automationContent.heartbeatBaseKey || !hasCompletedAutomationContent(heartbeat)) throw new Error("completed isolated heartbeat content is absent");
  const fixture = await modelFixture(state, readRows);
  const model = await readSession(state, fixture.key);
  assertStored(model, fixture.key, fixture.entry.sessionId);
  if (!Number.isSafeInteger(model.entry.updatedAt) || model.entry.updatedAt >= now - 30 * DAY || model.entry.archivedAt !== undefined || !hasCompletedAutomationContent(model, automationContent.modelMarker)) throw new Error("historical model-run fixture content or age differs");
  const hook = await readSession(state, automationContent.hookKey);
  assertStored(hook, automationContent.hookKey);
  if (hook.entry.hookExternalContentSource !== "webhook" || !hasCompletedAutomationContent(hook, automationContent.hookMarker)) throw new Error("completed hook content is absent");
  return {};
}

async function main() {
  const argv = process.argv.slice(2);
  const operation = argv.shift();
  // Keep informational SDK logs out of this command's JSON output.
  if (operation === "age-model-run-fixture") process.env.OPENCLAW_LOG_LEVEL = "warn";
  const operations = ["configure-hook", "cron", "hook", "heartbeat", "create-model-run-fixture", "populate-model-run-fixture", "age-model-run-fixture", "check"];
  await runEntry({ "job-id": { type: "string", pattern: idPattern } }, async ({ args, env, state }) => {
    if (operation === "configure-hook") return configureAutomationHook({ env, state });
    if (operation === "hook") return runAutomationHook({ env, state });
    const writeFixture = operation === "age-model-run-fixture" ? await openCollectionFixture(env, state) : undefined;
    return withSessionClient(env, (rpc) => {
      const options = { rpc, state, jobId: args["job-id"], writeFixture };
      if (operation === "cron") return runAutomationCron(options);
      if (operation === "heartbeat") return runAutomationHeartbeat(options);
      if (operation === "create-model-run-fixture") return createModelRunFixture(options);
      if (operation === "populate-model-run-fixture") return populateModelRunFixture(options);
      if (operation === "age-model-run-fixture") return ageModelRunFixture(options);
      return checkAutomationRows(options);
    });
  }, argv, (args) => {
    if (!operations.includes(operation)) throw new EntryError(`expected ${operations.join(", ")}`, 2);
    if (["cron", "check"].includes(operation) !== (args["job-id"] !== undefined)) throw new EntryError("--job-id is required only for cron and check", 2);
    requireSessionContentRuntime();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
