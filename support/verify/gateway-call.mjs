import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv } from "../openclaw-runtime.mjs";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { abortable, atomicJson, CallError, failure, joinOperation, parseFlags, positiveMs, readJson, serveOperation, startOperation } from "./background.mjs";

const filename = fileURLToPath(import.meta.url);
const allowed = ["env", "method", "params", "timeout", "out", "session-from", "merge-from", "after-ms", "from", "background", "handle", "wait"];
// Session selectors follow the Gateway parameter schemas; collection methods
// have no single-session selector and must receive their parameters explicitly.
const keyMethods = new Set([
  "sessions.create", "sessions.describe", "sessions.get", "sessions.send", "sessions.abort",
  "sessions.patch", "sessions.delete", "sessions.reset", "sessions.assignOwner", "sessions.setInvolvement",
  "sessions.compact", "sessions.recover", "sessions.resolve", "sessions.messages.subscribe",
  "sessions.messages.unsubscribe", "sessions.files.reveal", "sessions.processes.list", "sessions.processes.stop"
]);
const sessionKeyMethods = new Set([
  "chat.send", "chat.abort", "chat.history", "progressCard.get", "progressCard.put", "progressCard.delete",
  "session.visibility.set", "session.publicShare.set", "session.members.list", "session.member.add", "session.member.remove",
  "sessions.branches.list", "sessions.branches.switch", "sessions.fork", "sessions.rewind", "sessions.diff",
  "sessions.files.list", "sessions.files.get", "sessions.files.set", "sessions.files.assets",
  "sessions.companion.ask", "sessions.companion.state", "sessions.companion.reset"
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallError(`${label} must be a JSON object`);
  return value;
}

function text(value) { return typeof value === "string" && value.length > 0; }

function payload(value) {
  object(value, "input file");
  if (Object.hasOwn(value, "error") && value.error !== null) throw new CallError("input file contains an error");
  return Object.hasOwn(value, "result") ? object(value.result, "input result") : value;
}

export function parseGatewayCallArgs(argv) {
  const options = parseFlags(argv, ["background"]);
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new CallError(`unknown flag: --${name}`);
  options.timeoutMs = positiveMs(options.timeout, 120000);
  options.afterMs = options["after-ms"] === undefined ? 0 : Number(options["after-ms"]);
  if (!Number.isSafeInteger(options.afterMs) || options.afterMs < 0 || options.afterMs > 2147483647 - options.timeoutMs) throw new CallError("--after-ms must be a nonnegative number of milliseconds within the timer range");
  if (options.wait) {
    for (const name of ["params", "session-from", "merge-from", "after-ms", "from", "background", "handle"]) {
      if (options[name] !== undefined) throw new CallError(`--wait cannot be combined with --${name}`);
    }
  } else {
    if (!text(options.env) || !text(options.method)) throw new CallError("--env and --method are required");
    if (Boolean(options.background) !== Boolean(options.handle)) throw new CallError("--background and --handle are required together");
    try { options.params = object(JSON.parse(options.params ?? "{}"), "--params"); }
    catch (error) { throw new CallError(error.message); }
    if (options.from && !["sessions.processes.stop", "sessions.setInvolvement"].includes(options.method)) throw new CallError("--from is unsupported for this method");
  }
  for (const key of ["wait", "handle", "out", "session-from", "merge-from", "from"]) if (options[key]) options[key] = resolve(options[key]);
  return options;
}

export async function resolveGatewayParams(options, { signal } = {}) {
  let params = { ...options.params };
  if (options["merge-from"]) params = { ...payload(await readJson(options["merge-from"], { signal })), ...params };
  if (options["session-from"]) {
    const source = payload(await readJson(options["session-from"], { signal }));
    const keys = [...new Set([source.key, source.sessionKey, source.session?.key, source.session?.sessionKey].filter(text))];
    if (keys.length !== 1) throw new CallError("--session-from requires exactly one session key");
    const field = keyMethods.has(options.method) ? "key" : sessionKeyMethods.has(options.method) ? "sessionKey" : null;
    if (!field) throw new CallError("--session-from has no single-session selector for this method; use --params");
    if (params[field] !== undefined && params[field] !== keys[0]) throw new CallError("--session-from conflicts with --params");
    params[field] = keys[0];
  }
  if (options.from) {
    const record = await readJson(options.from, { signal });
    const source = payload(record);
    if (options.method === "sessions.processes.stop") {
      if (record.method !== "sessions.processes.list" || !text(params.sessionId) || source.sessionId !== params.sessionId || !text(params.processId)) throw new CallError("--from does not identify this session and process");
      const matches = Array.isArray(source.processes) ? source.processes.filter((row) => row.processId === params.processId) : [];
      if (matches.length !== 1 || !text(matches[0].instanceId)) throw new CallError("--from requires exactly one process instance");
      if (params.instanceId !== undefined && params.instanceId !== matches[0].instanceId) throw new CallError("--from conflicts with instanceId");
      params.instanceId = matches[0].instanceId;
    } else if (options.method === "sessions.setInvolvement") {
      const key = source.key ?? source.session?.key;
      if (record.method !== "sessions.describe" || !text(params.key) || key !== params.key || !text(source.session?.sessionId)) throw new CallError("--from does not describe this session");
      if (params.expectedSessionId !== undefined && params.expectedSessionId !== source.session.sessionId) throw new CallError("--from conflicts with expectedSessionId");
      params.expectedSessionId = source.session.sessionId;
    } else throw new CallError("--from is unsupported for this method");
  }
  return params;
}

export async function executeGatewayCall(options, { signal, prepare = prepareOpenClawRuntimeFromOcmEnv, connect = openDirectGatewayRpcClient } = {}) {
  const startedAt = Date.now();
  let client;
  let deadlineSignal;
  let deadline;
  try {
    if (options.afterMs) await sleep(options.afterMs, undefined, { signal });
    deadline = Date.now() + options.timeoutMs;
    deadlineSignal = AbortSignal.timeout(options.timeoutMs);
    const activeSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    let params;
    try { params = await resolveGatewayParams(options, { signal: activeSignal }); } catch (error) { throw new CallError(error.message); }
    const remaining = () => {
      activeSignal.throwIfAborted();
      if (Date.now() >= deadline) throw new CallError("Gateway call timeout", 3);
      return Math.max(1, deadline - Date.now());
    };
    const runtime = prepare(options.env, { timeoutMs: remaining() });
    const opening = connect(runtime, { timeoutMs: remaining() });
    opening.then((connection) => { if (activeSignal.aborted) connection.client.close(); }, () => {});
    ({ client } = await abortable(opening, activeSignal));
    const result = await abortable(client.request(options.method, params, { timeoutMs: remaining() }), activeSignal, () => client.close());
    return { output: { method: options.method, result: result ?? null, error: null, elapsedMs: Date.now() - startedAt }, exitCode: 0 };
  } catch (error) {
    if (deadlineSignal?.aborted || (deadline !== undefined && Date.now() >= deadline) || /^gateway direct RPC (connect|request) timeout /i.test(error?.message ?? "")) return failure(options.method, new CallError("Gateway call timeout", 3), startedAt);
    return failure(options.method, signal?.aborted ? signal.reason : error, startedAt);
  } finally { client?.close(); }
}

export async function gatewayCallMain(argv, { signal } = {}) {
  let options;
  let result;
  try {
    options = parseGatewayCallArgs(argv);
    if (options.wait) result = await joinOperation(options.wait, { timeoutMs: options.timeoutMs, method: options.method, env: options.env });
    else if (options.background) {
      const handle = await startOperation(filename, options, {
        entry: `gateway-${options.method.replaceAll(".", "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
        method: options.method, lifetimeMs: options.afterMs + options.timeoutMs + 1000, signal
      });
      return { output: handle, exitCode: 0 };
    } else result = await executeGatewayCall(options, { signal });
    if (options.out) await atomicJson(options.out, result.output);
    return result;
  } catch (error) { return failure(options?.method, error); }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") {
    await serveOperation(async (options, context) => {
      await context.publish({ method: options.method, pid: process.pid });
      const result = await executeGatewayCall(options, { signal: context.signal });
      if (options.out) await atomicJson(options.out, result.output);
      return result;
    });
  } else {
    const result = await runWithShutdownScope((signal) => gatewayCallMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }
}
