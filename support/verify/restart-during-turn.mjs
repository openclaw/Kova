import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDirectGatewayRpcClient } from "../openclaw-runtime.mjs";
import { abortable, CallError, readOperation } from "./background.mjs";
import { requestGatewayLifecycle, withGatewayLifecycleRequest } from "./gateway-fixture-client.mjs";
import { disposableEnv } from "./helper.mjs";
import { entrypoint, nonempty, positiveInteger } from "./script.mjs";

export const restartEmpty = () => ({ sessionKey: null, sessionId: null, runId: null, previousPid: null, pid: null, drainMs: null, interrupted: false, ready: false, elapsedMs: 0 });

export function restartFailure(error, startedAt = Date.now()) {
  return { output: { ...restartEmpty(), elapsedMs: Date.now() - startedAt, error: error?.message ?? String(error) }, exitCode: error?.exitCode ?? (error?.name === "TimeoutError" ? 3 : 1) };
}

export async function submittedTurn(path, env) {
  const operation = await readOperation(path);
  if (operation.entry !== "chat-send" || operation.method !== "chat-send" || operation.env !== env || !operation.handle || operation.handle.env !== env || !Number.isSafeInteger(Date.parse(operation.expiresAt)) || Date.parse(operation.expiresAt) <= Date.now()) throw new CallError("--from must identify this environment's live chat-send operation");
  try { await readFile(join(operation.directory, "result.json")); throw new CallError("submitted turn has already completed"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let record;
  try { record = JSON.parse(await readFile(join(operation.directory, "submitted-turn.json"), "utf8")); }
  catch (error) { throw new CallError(`submitted turn has no recorded receipt: ${error.message}`); }
  if (record.operationId !== operation.id || record.env !== env || record.entry !== "chat-send" || !nonempty(record.sessionKey) || !nonempty(record.runId)) throw new CallError("submitted turn receipt does not match its operation");
  return record;
}

// The same foreground owner stops its child, allows only the requested drain
// interval, confirms process cleanup, then starts the replacement. This requires
// no service operation or session-store mutation.
export const definition = {
  id: "restart-during-turn", url: import.meta.url,
  cancellationExitCode: 3,
  flags: ["env", "gateway-handle", "from", "drain-ms", "out", "timeout"],
  empty: restartEmpty,
  validate(options) {
    disposableEnv(options);
    for (const flag of ["gateway-handle", "from", "drain-ms", "out", "timeout"]) if (!options[flag]) throw new CallError(`--${flag} is required`);
    options.drainMs = positiveInteger(options["drain-ms"], undefined);
  },
  async run(options, context) {
    const source = await submittedTurn(options.from, options.env);
    const result = await (context.requestLifecycle ?? requestGatewayLifecycle)({
      env: options.env, "gateway-handle": options["gateway-handle"], operation: "restart-during-turn",
      from: options.from, source, drainMs: options.drainMs, timeoutMs: context.remaining()
    }, { signal: context.signal });
    if (result.exitCode !== 0 || result.output?.error !== null) throw new CallError(result.output?.error ?? "Gateway restart failed", result.exitCode || 1);
    const value = result.output;
    if (value.sessionKey !== source.sessionKey || value.runId !== source.runId || !nonempty(value.sessionId) || value.interrupted !== true || value.ready !== true || value.drainMs !== options.drainMs || !Number.isSafeInteger(value.previousPid) || !Number.isSafeInteger(value.pid) || value.previousPid === value.pid) throw new Error("Gateway restart observation does not match the submitted turn");
    context.remaining();
    return value;
  }
};

export async function prepareRestartDuringTurn(request, runtime, context, dependencies = {}) {
  return await withGatewayLifecycleRequest(request, context, async (controls) => {
    disposableEnv(request.options);
    positiveInteger(request.options.drainMs, undefined);
    const source = await submittedTurn(request.options.from, request.options.env);
    if (JSON.stringify(source) !== JSON.stringify(request.options.source)) throw new CallError("submitted turn receipt changed before interruption");
    const opening = (dependencies.connect ?? openDirectGatewayRpcClient)(runtime, { timeoutMs: controls.remaining(), authFromRuntimeConfig: true });
    opening.then((value) => { if (controls.signal.aborted) value.client.close(); }, () => {});
    const connection = await abortable(opening, controls.signal);
    let completed = false, interrupting = false;
    const observe = (event) => {
      if (typeof event.data !== "string") return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === "event" && frame.event === "chat" && frame.payload?.sessionKey === source.sessionKey && frame.payload.runId === source.runId && (frame.payload.state === "final" || !interrupting && ["error", "aborted"].includes(frame.payload.state))) completed = true;
    };
    if (!connection.client.ws?.addEventListener) { connection.client.close(); throw new Error("Gateway connection does not expose streaming events"); }
    connection.client.ws.addEventListener("message", observe);
    try {
      await abortable(connection.client.request("sessions.messages.subscribe", { key: source.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal);
      const row = (await abortable(connection.client.request("sessions.describe", { key: source.sessionKey }, { timeoutMs: controls.remaining() }), controls.signal))?.session;
      if (row?.key !== source.sessionKey || !nonempty(row.sessionId) || row.hasActiveRun !== true || row.status !== "running" || !Array.isArray(row.activeRunIds) || !row.activeRunIds.includes(source.runId)) throw new CallError("submitted turn is not the active running turn");
      const current = await submittedTurn(request.options.from, request.options.env);
      if (current.operationId !== source.operationId || current.runId !== source.runId || completed) throw new CallError("submitted turn completed or changed before interruption");
      controls.remaining();
      return {
        source, sessionId: row.sessionId, startedAt: Date.now(), completed: () => completed,
        beginInterruption() { if (completed) throw new CallError("submitted turn completed before interruption"); interrupting = true; },
        close() { connection.client.ws.removeEventListener("message", observe); connection.client.close(); }
      };
    } catch (error) { connection.client.ws.removeEventListener("message", observe); connection.client.close(); throw error; }
  });
}

await entrypoint(definition);
