import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { abortable, CallError, readJson, readOperation } from "./background.mjs";
import { nonempty } from "./script.mjs";

export async function history(context, key) {
  const pages = [];
  const messages = [];
  let cursor, offset = 0, sessionId;
  for (;;) {
    const page = await context.rpc("chat.history", { sessionKey: key, limit: 100, ...(cursor === undefined ? offset ? { offset } : {} : { cursor }) });
    if (sessionId !== undefined && page?.sessionId !== sessionId) throw new Error("session changed while reading history");
    sessionId ??= page?.sessionId;
    pages.push(page);
    messages.push(...(Array.isArray(page?.messages) ? page.messages : []));
    if (page?.hasMore !== true) break;
    if (pages.length >= 1000) throw new Error("history exceeded the bounded page count");
    if (nonempty(page.olderCursor)) {
      if (page.olderCursor === cursor) throw new Error("Gateway history cursor did not advance");
      cursor = page.olderCursor;
    } else {
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Gateway history offset did not advance");
      offset = page.nextOffset;
    }
  }
  return { pages, messages };
}

export function boundMessages(messages, runId) {
  return messages.filter((message) => message?.__openclaw?.runId === runId || (message?.__openclaw?.idempotencyKey ?? message?.idempotencyKey) === runId);
}

export async function sendTurn(context, key, message, { method = "chat.send", params = {}, onSubmitted, waitForTerminal = false } = {}) {
  const submittedAtMs = Date.now();
  const receipt = await context.rpc(method, {
    ...(method === "sessions.send" ? { key } : { sessionKey: key }), message,
    idempotencyKey: randomUUID(), ...params
  });
  if (!nonempty(receipt?.runId)) return { receipt, reply: null, messages: [], createdIds: [] };
  context.record?.({ receipt, createdIds: [receipt.runId] });
  await context.submittedTurn?.(key, receipt);
  await onSubmitted?.(receipt, { submittedAtMs });
  let completion;
  for (;;) {
    completion = await context.rpc("agent.wait", { runId: receipt.runId, timeoutMs: context.remaining() });
    if (completion?.runId && completion.runId !== receipt.runId) throw new Error("Gateway completion returned a different run id");
    context.record?.({ receipt: { ...receipt, completion } });
    if (completion?.status !== "pending") break;
    await context.pause(Math.min(250, context.remaining()));
  }
  // A product timeout is recorded as its result; our own deadline remains exit 3.
  const observed = await history(context, key);
  const messages = boundMessages(observed.messages, receipt.runId);
  return { receipt: { ...receipt, completion }, reply: messages.filter((row) => row.role === "assistant"), messages, createdIds: [receipt.runId] };
}

export async function readTurnFile(context, path) {
  context.remaining();
  try {
    const record = await readJson(path, { signal: context.signal });
    context.signal?.throwIfAborted();
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("turn record must be a JSON object");
    return record;
  }
  catch (error) {
    context.signal?.throwIfAborted();
    if (error.code === "ENOENT") return null;
    throw new CallError(`cannot read turn receipt: ${error.message}`);
  }
}

export async function recordedTurn(context, path, env, key, { entries = ["chat-send", "session-turn-hold"], live = true, waitForReceipt = true } = {}) {
  context.remaining();
  let operation;
  try { operation = await abortable(readOperation(path), context.signal); }
  catch (error) { context.signal?.throwIfAborted(); throw new CallError(`cannot read turn handle: ${error.message}`); }
  if (!entries.includes(operation.entry) || operation.method !== operation.entry || operation.env !== env || !operation.handle || operation.handle.env !== env || !nonempty(operation.id)) throw new CallError("turn handle does not match this environment and command");
  const expiresAtMs = Date.parse(operation.expiresAt);
  if (!Number.isSafeInteger(expiresAtMs)) throw new CallError("turn handle has no valid expiry");
  for (;;) {
    context.remaining();
    if (live && (Date.now() >= expiresAtMs || await readTurnFile(context, join(operation.directory, "result.json")))) throw new CallError("submitted turn has already completed or expired");
    const record = await readTurnFile(context, join(operation.directory, "submitted-turn.json"));
    if (record) {
      if (record.operationId !== operation.id || record.entry !== operation.entry || record.env !== env || record.sessionKey !== key || !nonempty(record.runId)) throw new CallError("submitted turn receipt does not match the selected session and operation");
      return { path, operation, record, expiresAtMs };
    }
    if (!waitForReceipt) throw new CallError("turn handle has no submitted receipt");
    await context.pause(Math.min(50, context.remaining()));
  }
}

async function currentTurn(context, source) {
  const current = await recordedTurn(context, source.path, source.record.env, source.record.sessionKey, { entries: [source.record.entry], waitForReceipt: false });
  if (current.operation.id !== source.operation.id || current.record.runId !== source.record.runId) throw new CallError("submitted turn changed during observation");
  return current;
}

export async function hasExactActiveRun(context, row, runId) {
  if (row.hasActiveRun !== true || row.status !== "running") return false;
  if (row.activeRunIds !== undefined) return Array.isArray(row.activeRunIds) && row.activeRunIds.includes(runId);
  // Embedded ownership can omit the complete set while exposing its scoped run.
  const page = await context.rpc("chat.history", { sessionKey: row.key, sessionId: row.sessionId, limit: 1 });
  return page?.sessionKey === row.key && page.sessionId === row.sessionId && page.inFlightRun?.runId === runId;
}

export async function runningTurn(context, source, { sessionId, wait = false } = {}) {
  for (;;) {
    await currentTurn(context, source);
    const row = (await context.rpc("sessions.describe", { key: source.record.sessionKey }))?.session;
    if (row?.key !== source.record.sessionKey || !nonempty(row.sessionId) || sessionId !== undefined && row.sessionId !== sessionId) throw new CallError("submitted turn no longer identifies the selected physical session");
    const active = await hasExactActiveRun(context, row, source.record.runId);
    await currentTurn(context, source);
    if (active) return row;
    if (!wait) throw new CallError("submitted turn is not the active running turn");
    await context.pause(Math.min(100, context.remaining()));
  }
}

export async function inputReceipt(context, key, sessionId, runId) {
  const page = await context.rpc("chat.history", { sessionKey: key, sessionId, inputRunIds: [runId], limit: 1 });
  if (page?.sessionKey !== key || page.sessionId !== sessionId || !Array.isArray(page.inputReceipts)) throw new CallError("Gateway input receipts do not match the selected physical session");
  if (page.inputReceipts.some((row) => row?.runId !== runId) || page.inputReceipts.length > 1) throw new CallError("Gateway returned an unrelated or ambiguous input receipt");
  return page.inputReceipts[0] ?? null;
}
