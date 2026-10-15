import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDirectGatewayRpcClient } from "../openclaw-runtime.mjs";
import { abortable, CallError, readJson, readOperation } from "./background.mjs";
import { requestGatewayLifecycle, withGatewayLifecycleRequest } from "./gateway-fixture-client.mjs";
import { disposableEnv } from "./helper.mjs";
import { entrypoint, nonempty, positiveInteger } from "./script.mjs";
import { hasExactActiveRun } from "./turn.mjs";

export const restartEmpty = () => ({ sessionKey: null, sessionId: null, runId: null, previousPid: null, pid: null, drainMs: null, interrupted: false, ready: false, elapsedMs: 0 });

export function restartFailure(error, startedAt = Date.now()) {
  return { output: { ...restartEmpty(), elapsedMs: Date.now() - startedAt, error: error?.message ?? String(error) }, exitCode: error?.exitCode ?? (error?.name === "TimeoutError" ? 3 : 1) };
}

export async function submittedTurn(path, env, signal) {
  const operation = await abortable(readOperation(path), signal);
  if (operation.entry !== "chat-send" || operation.method !== "chat-send" || operation.env !== env || !operation.handle || operation.handle.env !== env || !Number.isSafeInteger(Date.parse(operation.expiresAt)) || Date.parse(operation.expiresAt) <= Date.now()) throw new CallError("--from must identify this environment's live chat-send operation");
  try { await readFile(join(operation.directory, "result.json"), { signal }); throw new CallError("submitted turn has already completed"); }
  catch (error) { signal?.throwIfAborted(); if (error.code !== "ENOENT") throw error; }
  let record;
  try { record = JSON.parse(await readFile(join(operation.directory, "submitted-turn.json"), { encoding: "utf8", signal })); }
  catch (error) { signal?.throwIfAborted(); throw new CallError(`submitted turn has no recorded receipt: ${error.message}`); }
  if (record.operationId !== operation.id || record.env !== env || record.entry !== "chat-send" || !nonempty(record.sessionKey) || !nonempty(record.runId)) throw new CallError("submitted turn receipt does not match its operation");
  return record;
}

export async function restartChildren(options, source, signal) {
  const paths = [options["child-from"], options["second-child-from"]];
  if (paths.every((path) => path === undefined)) return [];
  if (paths.some((path) => !nonempty(path))) throw new CallError("both --child-from and --second-child-from are required");
  const children = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    let record;
    try { record = await readJson(path, { signal }); }
    catch (error) { signal?.throwIfAborted(); throw new CallError(`cannot read child spawn result: ${error.message}`); }
    const spawned = record?.toolResult?.details;
    if (record?.error !== null || record.toolCall?.name !== "sessions_spawn" || !nonempty(record.toolCall.id) || (record.toolResult?.toolCallId ?? record.toolResult?.tool_call_id) !== record.toolCall.id || record.toolResult.isError === true || spawned?.status !== "accepted" || !nonempty(record.callerSessionKey) || !nonempty(spawned.childSessionKey) || !nonempty(spawned.runId) || record.sessionKey !== spawned.childSessionKey || !Array.isArray(record.createdIds) || record.createdIds.length !== 2 || !record.createdIds.includes(spawned.childSessionKey) || !record.createdIds.includes(spawned.runId)) throw new CallError("child input must contain a successful fresh sessions_spawn result");
    children.push({ callerSessionKey: record.callerSessionKey, sessionKey: spawned.childSessionKey, runId: spawned.runId });
  }
  if (children[0].callerSessionKey !== children[1].callerSessionKey || new Set(children.map((child) => child.sessionKey)).size !== 2 || new Set(children.map((child) => child.runId)).size !== 2 || children.some((child) => child.sessionKey === child.callerSessionKey || child.sessionKey === source.sessionKey || child.runId === source.runId)) throw new CallError("restart requires two distinct fresh children of the same caller");
  return children;
}

const terminalChildStatuses = new Set(["done", "failed", "interrupted", "killed", "timeout"]);

function childObservationMatches(observed, child) {
  return observed?.callerSessionKey === child.callerSessionKey && observed.sessionKey === child.sessionKey && observed.runId === child.runId && nonempty(observed.sessionId) && observed.lastRunId === child.runId && terminalChildStatuses.has(observed.status) && Number.isFinite(observed.endedAt);
}

// The same foreground owner stops its child, allows only the requested drain
// interval, confirms process cleanup, then starts the replacement. This requires
// no service operation or session-store mutation.
export const definition = {
  id: "restart-during-turn", url: import.meta.url,
  cancellationExitCode: 3,
  flags: ["env", "gateway-handle", "from", "drain-ms", "out", "timeout", "child-from", "second-child-from"],
  empty: restartEmpty,
  validate(options) {
    disposableEnv(options);
    for (const flag of ["gateway-handle", "from", "drain-ms", "out", "timeout"]) if (!options[flag]) throw new CallError(`--${flag} is required`);
    if (Boolean(options["child-from"]) !== Boolean(options["second-child-from"])) throw new CallError("both --child-from and --second-child-from are required");
    for (const flag of ["child-from", "second-child-from"]) if (options[flag]) options[flag] = resolve(options[flag]);
    options.drainMs = positiveInteger(options["drain-ms"], undefined);
  },
  async run(options, context) {
    const source = await submittedTurn(options.from, options.env, context.signal);
    const children = await restartChildren(options, source, context.signal);
    const result = await (context.requestLifecycle ?? requestGatewayLifecycle)({
      env: options.env, "gateway-handle": options["gateway-handle"], operation: "restart-during-turn",
      from: options.from, source, drainMs: options.drainMs, timeoutMs: context.remaining(),
      ...(children.length ? { "child-from": options["child-from"], "second-child-from": options["second-child-from"], children } : {})
    }, { signal: context.signal });
    if (result.exitCode !== 0 || result.output?.error !== null) throw new CallError(result.output?.error ?? "Gateway restart failed", result.exitCode || 1);
    const value = result.output;
    if (value.sessionKey !== source.sessionKey || value.runId !== source.runId || !nonempty(value.sessionId) || value.interrupted !== true || value.ready !== true || value.drainMs !== options.drainMs || !Number.isSafeInteger(value.previousPid) || !Number.isSafeInteger(value.pid) || value.previousPid === value.pid) throw new Error("Gateway restart observation does not match the submitted turn");
    if (children.length && (!Array.isArray(value.children) || value.children.length !== 2 || children.some((child, index) => !childObservationMatches(value.children[index], child)))) throw new Error("Gateway restart did not confirm both exact child outcomes");
    context.remaining();
    return value;
  }
};

export async function prepareRestartDuringTurn(request, runtime, context, dependencies = {}) {
  return await withGatewayLifecycleRequest(request, context, async (controls) => {
    disposableEnv(request.options);
    positiveInteger(request.options.drainMs, undefined);
    const source = await submittedTurn(request.options.from, request.options.env, controls.signal);
    if (JSON.stringify(source) !== JSON.stringify(request.options.source)) throw new CallError("submitted turn receipt changed before interruption");
    const children = await restartChildren(request.options, source, controls.signal);
    if (children.length && JSON.stringify(children) !== JSON.stringify(request.options.children)) throw new CallError("child spawn results changed before interruption");
    const opening = (dependencies.connect ?? openDirectGatewayRpcClient)(runtime, { timeoutMs: controls.remaining(), authFromRuntimeConfig: true });
    opening.then((value) => { if (controls.signal.aborted) value.client.close(); }, () => {});
    const connection = await abortable(opening, controls.signal);
    const rpc = (method, params) => abortable(connection.client.request(method, params, { timeoutMs: controls.remaining() }), controls.signal);
    let completed = false, interrupting = false, childCompleted = false;
    const observe = (event) => {
      if (typeof event.data !== "string") return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === "event" && frame.event === "chat" && frame.payload?.sessionKey === source.sessionKey && frame.payload.runId === source.runId && (frame.payload.state === "final" || !interrupting && ["error", "aborted"].includes(frame.payload.state))) completed = true;
      if (!interrupting && frame.type === "event" && frame.event === "chat" && ["final", "error", "aborted"].includes(frame.payload?.state) && children.some((child) => child.sessionKey === frame.payload.sessionKey && child.runId === frame.payload.runId)) childCompleted = true;
    };
    if (!connection.client.ws?.addEventListener) { connection.client.close(); throw new Error("Gateway connection does not expose streaming events"); }
    connection.client.ws.addEventListener("message", observe);
    try {
      await abortable(connection.client.request("sessions.messages.subscribe", { key: source.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal);
      for (const child of children) await abortable(connection.client.request("sessions.messages.subscribe", { key: child.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal);
      const row = (await abortable(connection.client.request("sessions.describe", { key: source.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal))?.session;
      const parentActive = row?.key === source.sessionKey && nonempty(row.sessionId) && (children.length
        ? await hasExactActiveRun({ rpc }, row, source.runId)
        : row.hasActiveRun === true && row.status === "running" && Array.isArray(row.activeRunIds) && row.activeRunIds.includes(source.runId));
      if (!parentActive) throw new CallError("submitted turn is not the active running turn");
      const activeChildren = [];
      for (const child of children) {
        const active = (await abortable(connection.client.request("sessions.describe", { key: child.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal))?.session;
        if (active?.key !== child.sessionKey || !nonempty(active.sessionId) || ![active.spawnedBy, active.parentSessionKey].includes(child.callerSessionKey) || !await hasExactActiveRun({ rpc }, active, child.runId)) throw new CallError("spawned child is not the exact active run of its caller");
        activeChildren.push({ ...child, sessionId: active.sessionId });
      }
      if (children.length) {
        const active = (await abortable(connection.client.request("sessions.describe", { key: source.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal))?.session;
        if (active?.key !== source.sessionKey || active.sessionId !== row.sessionId || !await hasExactActiveRun({ rpc }, active, source.runId)) throw new CallError("parent turn changed while observing child activity");
      }
      const current = await submittedTurn(request.options.from, request.options.env, controls.signal);
      if (current.operationId !== source.operationId || current.runId !== source.runId || completed || childCompleted) throw new CallError("submitted turn or child completed or changed before interruption");
      controls.remaining();
      return {
        source, sessionId: row.sessionId, children: activeChildren, startedAt: Date.now(), completed: () => completed || childCompleted,
        beginInterruption() { if (completed || childCompleted) throw new CallError("submitted turn or child completed before interruption"); interrupting = true; },
        close() { connection.client.ws.removeEventListener("message", observe); connection.client.close(); }
      };
    } catch (error) { connection.client.ws.removeEventListener("message", observe); connection.client.close(); throw error; }
  });
}

export async function finishRestartChildren(request, prepared, runtime, context, dependencies = {}) {
  if (!prepared.children?.length) return [];
  return await withGatewayLifecycleRequest(request, context, async (controls) => {
    const opening = (dependencies.connect ?? openDirectGatewayRpcClient)(runtime, { timeoutMs: controls.remaining(), authFromRuntimeConfig: true });
    opening.then((value) => { if (controls.signal.aborted) value.client.close(); }, () => {});
    const connection = await abortable(opening, controls.signal);
    try {
      const observations = [];
      for (const child of prepared.children) {
        for (;;) {
          const row = (await abortable(connection.client.request("sessions.describe", { key: child.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal))?.session;
          if (row?.key !== child.sessionKey || row.sessionId !== child.sessionId || ![row.spawnedBy, row.parentSessionKey].includes(child.callerSessionKey)) throw new CallError("child session identity changed across Gateway restart", 1);
          if (row.lastRunId !== undefined && row.lastRunId !== child.runId) throw new CallError("child terminal outcome belongs to another run", 1);
          if (row.hasActiveRun === false && (row.activeRunIds === undefined || Array.isArray(row.activeRunIds) && row.activeRunIds.length === 0) && row.lastRunId === child.runId && terminalChildStatuses.has(row.status) && Number.isFinite(row.endedAt) && row.endedAt >= prepared.startedAt) {
            observations.push({ ...child, lastRunId: row.lastRunId, status: row.status, endedAt: row.endedAt });
            break;
          }
          await sleep(Math.min(100, controls.remaining()), undefined, { signal: controls.signal });
        }
      }
      controls.remaining();
      return observations;
    } finally { connection.client.close(); }
  });
}

await entrypoint(definition);
