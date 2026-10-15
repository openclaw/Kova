import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";
import { openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv } from "../openclaw-runtime.mjs";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { redactStateText } from "../../src/verify/checkpoint.mjs";
import { abortable, CallError, failure, joinOperation, parseFlags, positiveMs, readJson, serveOperation, startOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";

const filename = fileURLToPath(import.meta.url);
const allowed = ["env", "method", "params", "timeout", "out", "session-from", "merge-from", "after-ms", "from", "background", "handle", "wait"];
const fromMethods = new Set(["sessions.patchMany", "sessions.processes.stop", "sessions.search", "sessions.setInvolvement"]);
// Single-session selectors from the Gateway schemas at catalogue revision
// 7e80556f. Collection, catalog and creation-preparation methods use --params.
const keyMethods = new Set([
  "sessions.create", "sessions.describe", "sessions.get", "sessions.send", "sessions.abort",
  "sessions.patch", "sessions.delete", "sessions.reset", "sessions.assignOwner", "sessions.setInvolvement",
  "sessions.compact", "sessions.recover", "sessions.resolve", "sessions.messages.subscribe",
  "sessions.messages.unsubscribe", "sessions.files.reveal", "sessions.processes.list", "sessions.processes.stop"
]);
const sessionKeyMethods = new Set([
  "chat.send", "chat.abort", "chat.history", "chat.inject", "chat.message.get", "chat.metadata", "chat.startup",
  "progressCard.get", "progressCard.put", "progressCard.refresh",
  "session.visibility.set", "session.publicShare.set", "session.members.list", "session.members.listEvidence", "session.members.add", "session.members.remove",
  "session.suggestions.add", "session.suggestions.list", "session.suggestions.resolve",
  "sessions.branches.list", "sessions.branches.switch", "sessions.fork", "sessions.rewind", "sessions.diff",
  "sessions.files.list", "sessions.files.get", "sessions.files.set", "sessions.files.assets",
  "sessions.companion.ask", "sessions.companion.state", "sessions.companion.reset",
  "sessions.github.options", "sessions.github.status"
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallError(`${label} must be a JSON object`);
  return value;
}

function text(value) { return typeof value === "string" && value.length > 0; }

function creationFields(method, params = {}, result) {
  if (method === "sessions.create") {
    const ids = Object.hasOwn(params, "key") ? [] : [result?.key, result?.sessionId];
    if (result?.runStarted === true) ids.push(result.runId);
    return { createdIds: ids.filter(text) };
  }
  if (method === "sessions.catalog.import") return { createdIds: result?.created === true && text(result.sessionKey) ? [result.sessionKey] : [] };
  return {};
}

const publicSharingMethods = new Set(["session.publicShare.set", "session.members.list", "session.members.listEvidence"]);

function recordedFile(file, root, requestedPath) {
  if (!file || typeof file !== "object" || !Object.hasOwn(file, "content")) return file;
  if (typeof file.content !== "string") throw new CallError("invalid file content response", 1);
  const paths = [file.workspacePath, file.path, requestedPath].filter((path) => typeof path === "string");
  if (typeof root === "string") paths.push(...paths.filter((path) => !isAbsolute(path)).map((path) => resolve(root, path)));
  const encoding = file.contentEncoding ?? "utf8";
  const bytes = encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content);
  const content = redactStateText(paths, bytes);
  if (content === null) return file;
  if (!["utf8", "base64"].includes(encoding) || encoding === "base64" && bytes.toString("base64") !== file.content) throw new CallError("invalid credential file encoding", 1);
  return { ...file, content: encoding === "base64" ? Buffer.from(content).toString("base64") : content };
}

function recordedResult(method, result, params = {}) {
  if (["sessions.files.get", "sessions.files.set", "sessions.files.list"].includes(method) && result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result,
      ...(Object.hasOwn(result, "file") ? { file: recordedFile(result.file, result.root, params.path) } : {}),
      ...(Array.isArray(result.files) ? { files: result.files.map((file) => recordedFile(file, result.root)) } : {})
    };
  }
  if (!publicSharingMethods.has(method) || !result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "publicShare")) return result;
  const share = result.publicShare;
  if (!share || typeof share !== "object" || Array.isArray(share)) throw new CallError("invalid public sharing response", 1);
  return { ...result, publicShare: { ...share, ...(Object.hasOwn(share, "token") ? { token: "" } : {}) } };
}

function payload(value) {
  object(value, "input file");
  if (Object.hasOwn(value, "error") && value.error !== null) throw new CallError("input file contains an error");
  return Object.hasOwn(value, "result") ? object(value.result, "input result") : value;
}

function mergeSessionDescription(method, params, description) {
  const session = object(description.session, "--merge-from sessions.describe session");
  if (!text(session.key) || !text(session.sessionId)) throw new CallError("--merge-from requires a described session key and sessionId");
  const identity = { key: session.key, expectedSessionId: session.sessionId };
  if (session.agentId !== undefined) {
    if (!text(session.agentId)) throw new CallError("--merge-from contains an invalid session agentId");
    identity.agentId = session.agentId;
  }
  if (method === "sessions.patch" && session.lifecycleRevision !== undefined) {
    if (!text(session.lifecycleRevision)) throw new CallError("--merge-from contains an invalid session lifecycleRevision");
    identity.expectedLifecycleRevision = session.lifecycleRevision;
  }
  for (const field of ["key", "agentId", "expectedSessionId", "expectedLifecycleRevision"]) {
    if (params[field] !== undefined && params[field] !== identity[field]) throw new CallError(`--merge-from conflicts with ${field}`);
  }
  return { ...params, ...identity };
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
    if (options.from && !fromMethods.has(options.method)) throw new CallError("--from is unsupported for this method");
  }
  for (const key of ["wait", "handle", "out", "session-from", "merge-from", "from"]) if (options[key]) options[key] = resolve(options[key]);
  return options;
}

export async function resolveGatewayParams(options, { signal } = {}) {
  let params = { ...options.params };
  let description;
  if (options["merge-from"]) {
    const record = await readJson(options["merge-from"], { signal });
    const source = payload(record);
    if (record.method === "sessions.describe" && ["sessions.patch", "sessions.reset"].includes(options.method)) description = source;
    else params = { ...source, ...params };
  }
  if (options["session-from"]) {
    const source = payload(await readJson(options["session-from"], { signal }));
    const keys = [...new Set([source.key, source.sessionKey, source.session?.key, source.session?.sessionKey].filter(text))];
    if (keys.length !== 1) throw new CallError("--session-from requires exactly one session key");
    const field = keyMethods.has(options.method) ? "key" : sessionKeyMethods.has(options.method) ? "sessionKey" : null;
    if (!field) throw new CallError("--session-from has no single-session selector for this method; use --params");
    if (params[field] !== undefined && params[field] !== keys[0]) throw new CallError("--session-from conflicts with --params");
    params[field] = keys[0];
  }
  if (description) params = mergeSessionDescription(options.method, params, description);
  if (options.from) {
    const record = await readJson(options.from, { signal });
    const source = payload(record);
    if (fromMethods.has(options.method) && options.method !== "sessions.setInvolvement" && (record.error !== null || !Object.hasOwn(record, "result"))) throw new CallError("--from requires an error-free Gateway result");
    if (options.method === "sessions.processes.stop") {
      if (record.method !== "sessions.processes.list" || !text(params.sessionId) || source.sessionId !== params.sessionId) throw new CallError("--from does not identify this session");
      if (Object.hasOwn(params, "processId") || Object.hasOwn(params, "instanceId")) throw new CallError("--from refuses prefilled processId or instanceId");
      if (source.truncated !== false) throw new CallError("--from requires a non-truncated process list");
      const matches = Array.isArray(source.processes) ? source.processes.filter((row) => row?.status === "running" && row.canStop === true) : [];
      if (matches.length !== 1 || !text(matches[0].processId) || !text(matches[0].instanceId)) throw new CallError("--from requires exactly one process with status running and canStop true, including processId and instanceId");
      params.processId = matches[0].processId;
      params.instanceId = matches[0].instanceId;
    } else if (options.method === "sessions.patchMany") {
      const session = source.session;
      if (record.method !== "sessions.describe" || !text(session?.key) || !text(session?.sessionId)) throw new CallError("--from requires a described session key and sessionId");
      const matches = Array.isArray(params.targets) ? params.targets.filter((target) => target?.key === session.key) : [];
      if (matches.length !== 1) throw new CallError("--from requires exactly one matching target");
      const target = matches[0];
      if (target.expectedSessionId !== undefined && target.expectedSessionId !== session.sessionId) throw new CallError("--from conflicts with expectedSessionId");
      if (target.agentId !== undefined && target.agentId !== session.agentId) throw new CallError("--from conflicts with agentId");
      params.targets = params.targets.map((row) => row === target ? { ...row, expectedSessionId: session.sessionId } : row);
    } else if (options.method === "sessions.search") {
      if (!["sessions.create", "sessions.catalog.import"].includes(record.method)) throw new CallError("--from requires a sessions.create or sessions.catalog.import result");
      const keys = [...new Set([source.key, source.sessionKey].filter(text))];
      if (keys.length !== 1) throw new CallError("--from requires exactly one session key");
      if (Object.hasOwn(params, "scope")) throw new CallError("--from cannot be combined with scope");
      if (Object.hasOwn(params, "key") || Object.hasOwn(params, "sessionKey") || (params.sessionKeys !== undefined && (!Array.isArray(params.sessionKeys) || params.sessionKeys.length !== 1 || params.sessionKeys[0] !== keys[0]))) throw new CallError("--from conflicts with session selectors");
      params.sessionKeys = keys;
    } else if (options.method === "sessions.setInvolvement") {
      const key = source.key ?? source.session?.key;
      if (record.method !== "sessions.describe" || !text(params.key) || key !== params.key || !text(source.session?.sessionId)) throw new CallError("--from does not describe this session");
      if (params.expectedSessionId !== undefined && params.expectedSessionId !== source.session.sessionId) throw new CallError("--from conflicts with expectedSessionId");
      params.expectedSessionId = source.session.sessionId;
    } else throw new CallError("--from is unsupported for this method");
  }
  return params;
}

async function isolatedGatewayRequest(runtime, method, params, timeoutMs, signal) {
  signal.throwIfAborted();
  // Native WebSocket close is a handshake, so an uncooperative peer can keep
  // its thread alive. Termination joins all connection resources on every exit.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: "gateway-request", runtime, method, params, timeoutMs }, execArgv: []
  });
  try {
    const completed = new Promise((resolve, reject) => {
      worker.once("message", (message) => message.ok ? resolve(message.result) : reject(new Error(message.error)));
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Gateway request worker exited before its result (${code})`)));
    });
    return await abortable(completed, signal);
  } finally { await worker.terminate(); }
}

export async function executeGatewayCall(options, { signal, prepare = prepareOpenClawRuntimeFromOcmEnv, connect } = {}) {
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
    let result;
    if (connect) {
      const opening = connect(runtime, { timeoutMs: remaining(), authFromRuntimeConfig: true });
      opening.then((connection) => { if (activeSignal.aborted) connection.client.close(); }, () => {});
      ({ client } = await abortable(opening, activeSignal));
      result = await abortable(client.request(options.method, params, { timeoutMs: remaining() }), activeSignal, () => client.close());
    } else result = await isolatedGatewayRequest(runtime, options.method, params, remaining(), activeSignal);
    return { output: { method: options.method, result: recordedResult(options.method, result ?? null, params), error: null, elapsedMs: Date.now() - startedAt, ...creationFields(options.method, params, result) }, exitCode: 0 };
  } catch (error) {
    const timedOut = deadlineSignal?.aborted || (deadline !== undefined && Date.now() >= deadline) || /^gateway direct RPC (connect|request) timeout /i.test(error?.message ?? "");
    const result = failure(options.method, timedOut ? new CallError("Gateway call timeout", 3) : signal?.aborted ? signal.reason : error, startedAt);
    Object.assign(result.output, creationFields(options.method));
    return result;
  } finally { client?.close(); }
}

export async function gatewayCallMain(argv, { signal } = {}) {
  let options;
  let result;
  try {
    options = parseGatewayCallArgs(argv);
    if (options.out) options.out = await validateGatewayOutput(options);
    if (options.wait) {
      result = await joinOperation(options.wait, { timeoutMs: options.timeoutMs, method: options.method, env: options.env, signal });
      result = { ...result, output: { ...result.output, result: recordedResult(result.output.method, result.output.result) } };
    }
    else if (options.background) {
      const handle = await startOperation(filename, options, {
        entry: `gateway-${options.method.replaceAll(".", "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
        method: options.method, lifetimeMs: options.afterMs + options.timeoutMs + 1000, signal
      });
      return { output: handle, exitCode: 0 };
    } else result = await executeGatewayCall(options, { signal });
    if (options.out) await writeGatewayOutput(options, result.output);
    return result;
  } catch (error) { return failure(options?.method, error); }
}

if (!isMainThread && workerData?.kind === "gateway-request") {
  let client;
  try {
    const { runtime, method, params, timeoutMs } = workerData;
    ({ client } = await openDirectGatewayRpcClient(runtime, { timeoutMs, authFromRuntimeConfig: true }));
    parentPort.postMessage({ ok: true, result: await client.request(method, params, { timeoutMs }) });
  } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
  finally { client?.close(); }
} else if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") {
    await serveOperation(async (options, context) => {
      await context.publish({ method: options.method, pid: process.pid });
      const result = await executeGatewayCall(options, { signal: context.signal });
      if (options.out) await writeGatewayOutput(options, result.output);
      return result;
    });
  } else {
    const result = await runWithShutdownScope((signal) => gatewayCallMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }
}
