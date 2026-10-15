import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EntryError } from "./common.mjs";
import { redactLogText } from "../../src/collectors/logs.mjs";
import { sendSessionMessage, sessionRequests } from "./session-content.mjs";
import { readStoredSession, requireSessionContentRuntime } from "./session-store-read.mjs";
import { probeRequestSchemas, validateProbeRequest } from "../plugins/kova-channel-probe/protocol.js";

export { probeRequestSchemas };
export const channelContent = Object.freeze({
  channel: "kova-channel-probe", account: "default", mainKey: "agent:main:main",
  mainLabel: "kova-persona-main", mainPeer: "dm:kova-probe-user-persona-main",
  groupLabel: "kova-persona-group", groupPeer: "group:kova-probe-group-persona", human: "kova-persona-human",
  threadLabel: "kova-persona-thread", pairA: "agent:main:verify-watch-a",
  pairBLabel: "kova-persona-watch-b", pairPeer: "dm:kova-probe-user-persona-watch-b",
  parent: "agent:main:verify-parent"
});
export const channelSessionKinds = ["session-main-rolling", "session-group-watched", "session-thread-bound", "session-orchestrator-idle", "session-pair-watched"];
export const channelRequests = {
  chat: (key, message, idempotencyKey) => ({ method: "chat.send", params: { sessionKey: key, message, idempotencyKey } }),
  status: () => ({ method: "kova.channelProbe.status", params: {} }),
  bindings: (targetSessionKey) => ({ method: "kova.channelProbe.bindings", params: targetSessionKey ? { targetSessionKey } : {} }),
  inject: (params) => ({ method: "kova.channelProbe.inject", params: validateProbeRequest("kova.channelProbe.inject", params) })
};
export const channelRequestCases = {
  chat: [["agent:main:main", "Notebook entry.", "persona-channel-input"]],
  status: [[]], bindings: [[], ["agent:main:subagent:11111111-1111-4111-8111-111111111111"]],
  inject: [
    [{ message: "Notebook entry.", targetId: channelContent.mainPeer, inboundEventId: "persona-channel-input", senderId: channelContent.human, chatType: "direct" }],
    [{ message: "Group entry.", targetId: channelContent.groupPeer, inboundEventId: "persona-group-input", senderId: channelContent.human, chatType: "group", wasMentioned: true }],
    [{ message: "Group chatter.", targetId: channelContent.groupPeer, chatType: "group", wasMentioned: false }],
    [{ message: "Thread entry.", targetId: channelContent.groupPeer, threadId: "kova-thread-11111111-1111-4111-8111-111111111111", chatType: "group", wasMentioned: true }]
  ]
};

const keyPattern = /^agent:[a-z0-9][a-z0-9_-]*:[^\s\u0000-\u001f\u007f]+$/;
const toolPrompt = (name, args) => `KOVA_TOOL_CALL ${JSON.stringify({ name, arguments: args })}`;
const text = (message) => typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part) => part?.text ?? "").join("\n") : "";
const messages = (stored) => stored.events.filter(({ event }) => event.type === "message").map(({ event }) => event.message);
const origin = (entry) => entry.delivery?.kind === "external" ? entry.delivery.origin : entry.origin;

export function requireChannelReceiptPath(path) {
  if (path !== undefined && !isAbsolute(path)) throw new EntryError("a receipt path must be absolute", 2);
}

export async function writeChannelReceipt(path, value) {
  requireChannelReceiptPath(path);
  if (path) await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  return value;
}

export async function readChannelReceipt(path) {
  requireChannelReceiptPath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new EntryError("invalid channel receipt file", 2);
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new EntryError("invalid channel receipt JSON", 2); }
  if (!keyPattern.test(value?.key ?? "")) throw new EntryError("channel receipt has no session key", 2);
  return value;
}

function toolReceipt(message, name) {
  if (message?.role !== "toolResult") return undefined;
  if (message.toolName === name && message.details && typeof message.details === "object") return message.details;
  if (message.toolName === "tool_call" && message.details?.tool?.name === name) return message.details.result?.details;
  return undefined;
}

export function findToolReceipt(stored, name, runId) {
  const results = messages(stored).filter((message) => message.__openclaw?.runId === runId).map((message) => toolReceipt(message, name)).filter(Boolean);
  if (results.length !== 1) throw new Error(`accepted turn has no unique ${name} receipt`);
  return results[0];
}

export function requireAcceptedSpawn(receipt, description) {
  if (receipt?.status === "accepted" && keyPattern.test(receipt.childSessionKey ?? "") && typeof receipt.runId === "string" && receipt.runId.length > 0) return receipt;
  const status = ["accepted", "error", "forbidden"].includes(receipt?.status) ? receipt.status : "invalid";
  const reason = typeof receipt?.error === "string"
    ? redactLogText(receipt.error.slice(0, 8192)).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 512)
    : "The tool result is missing an accepted child session and run identity.";
  throw new Error(`${description}: sessions_spawn status=${status}; ${reason}`);
}

export async function readChannelState(state, { watcher, target, parent } = {}) {
  requireSessionContentRuntime();
  for (const key of [watcher, target, parent].filter(Boolean)) if (!keyPattern.test(key)) throw new Error("a canonical session key is required");
  if ((!watcher || !target) && !parent) throw new Error("a watch or parent selection is required");
  if (!isAbsolute(state)) throw new Error("an absolute task environment state directory is required");
  const root = await realpath(state);
  let path = root;
  for (const [index, part] of ["state", "openclaw.sqlite"].entries()) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (index === 0 ? !info.isDirectory() : !info.isFile())) throw new Error("shared database must be a regular task environment file");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { const info = await lstat(`${path}${suffix}`); if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid shared database sidecar"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    const watches = watcher && target ? db.prepare("SELECT watcher_session_key, target_session_key, provenance FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?").all(watcher, target) : [];
    const rows = parent ? db.prepare(`SELECT run_id, child_session_key, requester_session_key,
      length(CAST(payload_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(payload_json AS BLOB)) <= 2097152 THEN payload_json END AS payload_json
      FROM subagent_runs WHERE requester_session_key = ? ORDER BY created_at LIMIT 17`).all(parent) : [];
    if (rows.length > 16) throw new Error("persona child count exceeds its bounded check");
    const children = rows.map((row) => {
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 2 || row.bytes > 2097152) throw new Error("saved child record exceeds its read limit");
      const decoded = JSON.parse(row.payload_json);
      const value = decoded?.parentCompletion?.completionTarget === "parent" ? decoded.parentCompletion : decoded;
      if (value?.runId !== row.run_id || value?.childSessionKey !== row.child_session_key || value?.requesterSessionKey !== row.requester_session_key) throw new Error("saved child identity differs from its index");
      return value;
    });
    return { watches, children };
  } finally { db.close(); }
}

async function waitFor(operation, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await operation();
    if (result) return result;
    if (Date.now() >= deadline) throw new EntryError(`timed out waiting for ${description}`, 3);
    await sleep(100);
  }
}

export async function waitForDmScope(rpc, expected, { timeoutMs = 30000 } = {}) {
  if (!["main", "isolated"].includes(expected)) throw new EntryError("unsupported direct-message scope requirement", 2);
  const scopes = expected === "main" ? ["main"] : ["per-peer", "per-channel-peer", "per-account-channel-peer"];
  return waitFor(async () => {
    const status = await rpc(channelRequests.status());
    return status?.ok === true && status.channelId === channelContent.channel && status.accountId === channelContent.account && scopes.includes(status.dmScope) ? status : false;
  }, `${expected} direct-message routing`, timeoutMs);
}

async function waitRun(rpc, runId) {
  if (typeof runId !== "string" || !runId) throw new Error("channel input returned no accepted run identity");
  const result = await rpc(sessionRequests.wait(runId));
  if (result?.runId !== runId || (result.terminalReceipt && result.terminalReceipt.runId !== runId)) throw new Error("channel completion does not match its accepted run");
  if (result.status !== "ok") throw new EntryError(`channel input did not complete: ${result.status ?? "missing status"}`, result.status === "timeout" ? 3 : 1);
}

export async function injectChannelMessage(rpc, { peer, message, chatType = "direct", wasMentioned, threadId, sender = channelContent.human, onRun }) {
  const inboundEventId = `kova-persona-${randomUUID()}`;
  const result = await rpc(channelRequests.inject({ message, targetId: peer, inboundEventId, senderId: sender, senderName: "Notebook participant", chatType, ...(wasMentioned === undefined ? {} : { wasMentioned }), ...(threadId ? { threadId } : {}) }));
  const observed = result?.observation;
  if (result?.ok !== true || observed?.inboundEvent?.id !== inboundEventId || observed.dispatched !== true || !keyPattern.test(observed.routeSessionKey ?? "")) throw new Error("channel input did not reach its routed session");
  await waitRun(rpc, observed.runId);
  onRun?.(observed.runId);
  return observed.routeSessionKey;
}

async function saved(rpc, state, key, readSession) {
  const { session } = await rpc(sessionRequests.describe(key));
  if (session?.key !== key || !session.sessionId) throw new Error("saved channel session is absent");
  if (["running", "queued"].includes(session.status)) throw new Error("channel session still has active work");
  const history = await rpc(sessionRequests.history(key));
  if (history?.inFlightRun || history?.pendingInputs?.items?.some((item) => item.queued || ["queued", "running"].includes(item.state))) throw new Error("channel session still has active or queued work");
  const stored = await readSession(state, key);
  if (stored.sessionId !== session.sessionId) throw new Error("channel session changed during its content check");
  return stored;
}

async function keyFor(rpc, key, label) {
  const selected = key ?? (await rpc(sessionRequests.resolveLabel(label))).key;
  if (!keyPattern.test(selected ?? "")) throw new Error("saved channel label did not resolve");
  return selected;
}

export async function fillMainSession({ rpc, ingress, turns = 45 }) {
  if (!["direct", "ui"].includes(ingress)) throw new EntryError("expected direct or ui main-session ingress", 2);
  await waitForDmScope(rpc, "main");
  for (let index = 0; index < turns; index++) {
    const message = `KOVA_NOTEBOOK_${ingress === "ui" ? "UI" : "DM"}_${index * 2 + (ingress === "ui" ? 2 : 1)}: Keep the shared notebook current. Reply with KOVA_AGENT_OK.`;
    if (ingress === "ui") {
      const sent = await rpc(channelRequests.chat(channelContent.mainKey, message, `kova-persona-${randomUUID()}`));
      await waitRun(rpc, sent?.runId);
    } else {
      const key = await injectChannelMessage(rpc, { peer: channelContent.mainPeer, message });
      if (key !== channelContent.mainKey) throw new Error("main notebook requires direct messages routed to the main session");
    }
  }
  return { key: channelContent.mainKey, peer: channelContent.mainPeer };
}

export async function fillGroupSession({ rpc, turns = 40 }) {
  let key;
  for (let index = 0; index < turns; index++) {
    const current = await injectChannelMessage(rpc, { peer: channelContent.groupPeer, chatType: "group", wasMentioned: true, message: `KOVA_GROUP_NOTE_${index + 1}: Add the group observation. Reply with KOVA_AGENT_OK.` });
    if (key && current !== key) throw new Error("group route changed while filling its history");
    key = current;
  }
  return { key, peer: channelContent.groupPeer };
}

export async function fillPairSession({ rpc }) {
  await waitForDmScope(rpc, "isolated");
  const key = await injectChannelMessage(rpc, { peer: channelContent.pairPeer, message: "KOVA_WATCHED_PEER: Keep this notebook separate. Reply with KOVA_AGENT_OK." });
  if (key === channelContent.mainKey || key === channelContent.pairA) throw new Error("watched peer requires isolated direct-message routing");
  return { key, peer: channelContent.pairPeer };
}

export async function watchPairSession({ rpc, state, watcher, target, readSession = readStoredSession }) {
  if (!keyPattern.test(watcher ?? "") || !keyPattern.test(target ?? "") || watcher === target) throw new EntryError("watching requires two distinct session keys", 2);
  const runId = await sendSessionMessage(rpc, watcher, toolPrompt("sessions_send", { sessionKey: target, message: "Reply with KOVA_AGENT_OK.", watch: true, timeoutSeconds: 0 }));
  const receipt = findToolReceipt(await readSession(state, watcher), "sessions_send", runId);
  if (receipt.watched !== true || receipt.sessionKey !== target || !["accepted", "ok"].includes(receipt.status)) throw new Error("watching turn did not admit the requested peer input");
  await waitRun(rpc, receipt.runId);
  await waitFor(async () => {
    for (const key of [watcher, target]) {
      const { session } = await rpc(sessionRequests.describe(key));
      const history = await rpc(sessionRequests.history(key));
      if (!session || ["running", "queued"].includes(session.status) || history.inFlightRun) return false;
    }
    return true;
  }, "watched peer completion");
  return { keyA: watcher, keyB: target };
}

export async function spawnThreadSubagent({ rpc, state, parent, toolModel, readSession = readStoredSession }) {
  const status = await rpc(channelRequests.status());
  if (status?.threadBindings !== true) throw new Error("conformance channel has no durable child-thread support");
  parent = await keyFor(rpc, parent, channelContent.groupLabel);
  let parentRunId;
  const routed = await injectChannelMessage(rpc, {
    peer: channelContent.groupPeer, chatType: "group", wasMentioned: true,
    onRun: (runId) => { parentRunId = runId; },
    message: toolPrompt("sessions_spawn", { task: "Reply with KOVA_AGENT_OK.", label: channelContent.threadLabel, model: toolModel, thread: true, mode: "session", cleanup: "keep", context: "isolated" })
  });
  if (routed !== parent) throw new Error("thread spawn did not run in its requested parent session");
  const receipt = requireAcceptedSpawn(findToolReceipt(await readSession(state, parent), "sessions_spawn", parentRunId), "thread spawn");
  await waitRun(rpc, receipt.runId);
  const binding = await waitFor(async () => {
    const { bindings } = await rpc(channelRequests.bindings());
    return bindings?.find((value) => value.targetSessionKey === receipt.childSessionKey && value.metadata?.label === channelContent.threadLabel);
  }, "child-thread binding");
  await waitFor(async () => {
    const { session } = await rpc(sessionRequests.describe(binding.targetSessionKey));
    return session && !["running", "queued"].includes(session.status);
  }, "thread child completion");
  return { key: binding.targetSessionKey, peer: `${binding.conversation.parentConversationId}/thread:${binding.conversation.conversationId}` };
}

export async function fillBoundThread({ rpc, key }) {
  const { bindings } = await rpc(channelRequests.bindings(key));
  const selected = bindings?.filter((value) => value.targetSessionKey === key && value.targetKind === "subagent" && value.status === "active" && value.conversation?.channel === channelContent.channel && value.conversation.accountId === channelContent.account);
  if (selected?.length !== 1 || selected[0].conversation.parentConversationId !== channelContent.groupPeer) throw new Error("bound child has no unique active conversation");
  const [binding] = selected;
  const childKey = await injectChannelMessage(rpc, { peer: binding.conversation.parentConversationId, threadId: binding.conversation.conversationId, chatType: "group", wasMentioned: true, message: "KOVA_BOUND_THREAD: Continue this thread notebook. Reply with KOVA_AGENT_OK." });
  if (childKey !== binding.targetSessionKey) throw new Error("bound thread did not route to its child session");
  return { key: childKey, peer: `${binding.conversation.parentConversationId}/thread:${binding.conversation.conversationId}` };
}

export async function spawnChild({ rpc, state, parent, toolModel, yielded = false, readSession = readStoredSession, readState = readChannelState }) {
  const label = yielded ? "kova-persona-yield-history" : "kova-persona-finished";
  const task = yielded ? toolPrompt("sessions_yield", { waitFor: "message", message: "Waiting for the next notebook instruction." }) : "Reply with KOVA_AGENT_OK.";
  const runId = await sendSessionMessage(rpc, parent, toolPrompt("sessions_spawn", { task, label, model: toolModel, mode: "run", cleanup: "keep", context: "isolated" }));
  const receipt = requireAcceptedSpawn(findToolReceipt(await readSession(state, parent), "sessions_spawn", runId), "root spawn");
  const child = await waitFor(async () => {
    const { children } = await readState(state, { parent });
    return children.find((value) => value.runId === receipt.runId && value.childSessionKey === receipt.childSessionKey && value.label === label && (value.pauseReason === "sessions_yield" || value.execution?.status === "terminal"));
  }, "saved child completion");
  if (yielded && child.pauseReason !== "sessions_yield") throw new Error("child did not yield for a continuation");
  return { key: child.childSessionKey };
}

export async function resumeChild({ rpc, key }) {
  await sendSessionMessage(rpc, key, "KOVA_CHILD_RESUMED: Continue and finish the notebook. Reply with KOVA_AGENT_OK.");
  return { key };
}

export async function checkChannelSessions({ rpc, state, kind, key, readSession = readStoredSession, readState = readChannelState }) {
  if (!channelSessionKinds.includes(kind)) throw new EntryError("unknown channel session content", 2);
  if (kind === "session-pair-watched") {
    const keyA = channelContent.pairA;
    const keyB = await keyFor(rpc, undefined, channelContent.pairBLabel);
    if (keyB === keyA || keyB === channelContent.mainKey || !keyB.startsWith("agent:main:")) throw new Error("watched sessions are not distinct same-agent peers");
    await saved(rpc, state, keyA, readSession);
    const storedB = await saved(rpc, state, keyB, readSession);
    const peer = origin(storedB.entry);
    if (peer?.provider !== channelContent.channel || peer?.chatType !== "direct" || peer?.to !== channelContent.pairPeer) throw new Error("watched session has no saved direct-channel peer");
    const { watches } = await readState(state, { watcher: keyA, target: keyB });
    if (!watches.some((watch) => watch.watcher_session_key === keyA && watch.target_session_key === keyB && watch.provenance === "explicit")) throw new Error("explicit session watch is absent");
    return { keyA, keyB, peerB: peer.to, sessionIdB: storedB.sessionId };
  }
  const labels = { "session-main-rolling": channelContent.mainLabel, "session-group-watched": channelContent.groupLabel, "session-thread-bound": channelContent.threadLabel };
  key = await keyFor(rpc, key ?? (kind === "session-orchestrator-idle" ? channelContent.parent : undefined), labels[kind]);
  const stored = await saved(rpc, state, key, readSession);
  const savedMessages = messages(stored);
  if (kind === "session-main-rolling") {
    const peer = origin(stored.entry);
    if (peer?.provider !== channelContent.channel || peer?.chatType !== "direct" || peer?.to !== channelContent.mainPeer) throw new Error("main session has no saved direct-channel peer");
    const notes = savedMessages.filter((message) => message.role === "user" && /KOVA_NOTEBOOK_(DM|UI)_\d+:/.test(text(message)));
    if (key !== channelContent.mainKey || notes.length < 90 || !notes.some((message) => text(message).includes("KOVA_NOTEBOOK_DM_")) || !notes.some((message) => text(message).includes("KOVA_NOTEBOOK_UI_"))) throw new Error("main session lacks its completed direct and UI notebook history");
    if (savedMessages.filter((message) => message.role === "assistant" && text(message).includes("KOVA_AGENT_OK")).length < 90) throw new Error("main notebook replies are incomplete");
    return { key, peer: peer.to };
  }
  if (kind === "session-group-watched") {
    const peer = origin(stored.entry);
    if (peer?.provider !== channelContent.channel || peer?.chatType !== "group" || peer?.to !== channelContent.groupPeer || savedMessages.filter((message) => message.role === "user" && text(message).includes("KOVA_GROUP_NOTE_")).length < 40) throw new Error("group session lacks its human channel history");
    if (savedMessages.filter((message) => message.role === "assistant" && text(message).includes("KOVA_AGENT_OK")).length < 40) throw new Error("group notebook replies are incomplete");
    const { watches } = await readState(state, { watcher: channelContent.mainKey, target: key });
    if (!watches.some((watch) => watch.watcher_session_key === channelContent.mainKey && watch.target_session_key === key && watch.provenance === "ambient-group")) throw new Error("main session does not watch the group");
    return { key, peer: peer.to };
  }
  if (kind === "session-thread-bound") {
    const result = await rpc(channelRequests.bindings(key));
    const bindings = result.bindings?.filter((binding) => binding.targetSessionKey === key && binding.targetKind === "subagent" && binding.status === "active" && binding.conversation?.channel === channelContent.channel && binding.conversation?.accountId === channelContent.account);
    if (bindings?.length !== 1 || bindings[0].conversation.parentConversationId !== channelContent.groupPeer || !savedMessages.some((message) => message.role === "user" && text(message).includes("KOVA_BOUND_THREAD"))) throw new Error("saved child-thread binding or routed history is absent");
    const parent = await keyFor(rpc, undefined, channelContent.groupLabel);
    if (stored.entry.spawnedBy !== parent || stored.entry.parentSessionKey !== parent) throw new Error("bound child has no saved parent relationship");
    const parentStored = await readSession(state, parent, { allWindows: true });
    const spawnReceipts = messages(parentStored).map((message) => toolReceipt(message, "sessions_spawn")).filter((receipt) => receipt?.status === "accepted" && receipt.childSessionKey === key && receipt.mode === "session" && typeof receipt.runId === "string" && receipt.runId.length > 0);
    if (spawnReceipts.length !== 1) throw new Error("bound child has no unique saved session-mode spawn receipt");
    return { key, peer: `${bindings[0].conversation.parentConversationId}/thread:${bindings[0].conversation.conversationId}` };
  }
  const { children } = await readState(state, { parent: key });
  const selected = ["kova-persona-finished", "kova-persona-yield-history"].map((label) => children.find((child) => child.label === label));
  if (selected.some((child) => !child || child.requesterSessionKey !== key || child.execution?.status !== "terminal" || child.execution?.outcome?.status !== "ok" || child.pauseReason === "sessions_yield")) throw new Error("root session lacks its completed child history");
  for (const child of selected) await saved(rpc, state, child.childSessionKey, readSession);
  const yielded = await readSession(state, selected[1].childSessionKey);
  if (!messages(yielded).some((message) => message.role === "toolResult" && message.toolName === "sessions_yield" && message.details?.status === "yielded") || !messages(yielded).some((message) => message.role === "user" && text(message).includes("KOVA_CHILD_RESUMED"))) throw new Error("saved child has no completed yield and continuation history");
  return { key };
}
