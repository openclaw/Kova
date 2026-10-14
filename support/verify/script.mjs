import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareOpenClawRuntimeFromOcmEnv } from "../openclaw-runtime.mjs";
import { executeGatewayCall } from "./gateway-call.mjs";
import { CallError, joinOperation, parseFlags, positiveMs, readJson, serveOperation, startOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { runWithShutdownScope } from "../../src/commands.mjs";

export const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
export function object(value, label = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallError(`${label} must be a JSON object`);
  return value;
}
export function jsonObject(value, label) {
  try { return object(JSON.parse(value), label); }
  catch (error) { throw new CallError(`${label}: ${error.message}`); }
}
export function positiveInteger(value, fallback, maximum = 2147483647) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new CallError(`expected an integer from 1 to ${maximum}`);
  return n;
}
export function payload(record) {
  object(record, "input file");
  if (record.error !== undefined && record.error !== null) throw new CallError("input file contains an error");
  return Object.hasOwn(record, "result") ? object(record.result, "input result") : record;
}
export async function sessionKey(options, context) {
  let key = options["session-key"];
  if (options["session-from"]) {
    const source = payload(await context.read(options["session-from"]));
    const keys = [...new Set([source.key, source.sessionKey, source.session?.key].filter(nonempty))];
    if (keys.length !== 1 || key !== undefined && key !== keys[0]) throw new CallError("--session-from requires one nonconflicting session key");
    [key] = keys;
  }
  if (!nonempty(key)) throw new CallError("a session key is required");
  return key;
}

export function parseScriptArgs(definition, argv) {
  const options = parseFlags(argv, definition.booleans ?? []);
  for (const flag of Object.keys(options)) if (!definition.flags.includes(flag)) throw new CallError(`unknown flag: --${flag}`);
  options.timeoutMs = positiveMs(options.timeout, definition.timeoutMs ?? 120000);
  for (const flag of ["wait", "handle", "out", "from", "session-from", "merge-from", "handoff-from", "url-from", "incognito-handle", "gateway-handle", "fixture"]) {
    if (options[flag]) options[flag] = resolve(options[flag]);
  }
  if (options.wait) {
    for (const flag of Object.keys(options)) if (!["wait", "env", "timeout", "timeoutMs", "out"].includes(flag)) throw new CallError(`--wait cannot be combined with --${flag}`);
  } else {
    if (!nonempty(options.env)) throw new CallError("--env is required");
    if (Boolean(options.background) !== Boolean(options.handle)) throw new CallError("--background and --handle are required together");
    definition.validate?.(options);
  }
  return options;
}

export async function executeScript(definition, options, dependencies = {}) {
  const startedAt = Date.now();
  let deadline, timeout;
  let signal = dependencies.signal;
  let runtime;
  const output = { ...definition.empty(), error: null };
  const context = {
    get signal() { return signal; },
    record(value) { for (const [key, data] of Object.entries(value)) if (Object.hasOwn(output, key)) output[key] = data; },
    remaining() {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new CallError("verification timeout", 3);
      return Math.max(1, deadline - Date.now());
    },
    runtime() { return runtime ??= (dependencies.prepare ?? prepareOpenClawRuntimeFromOcmEnv)(options.env, { timeoutMs: context.remaining() }); },
    async read(path) {
      try { return await readJson(path, { signal }); }
      catch (error) { if (signal.aborted) throw signal.reason; throw new CallError(`cannot read input JSON: ${error.message}`); }
    },
    async pause(ms) { context.remaining(); await sleep(ms, undefined, { signal }); },
    async rpc(method, params) {
      context.remaining();
      if (dependencies.rpc) return await dependencies.rpc(method, params, context);
      const result = await executeGatewayCall({ env: options.env, method, params, timeoutMs: context.remaining() }, { signal, prepare: () => context.runtime() });
      if (result.exitCode) throw new CallError(result.output.error, result.exitCode);
      return result.output.result;
    },
    ...dependencies.context
  };
  try {
    if (options.afterMs) await sleep(options.afterMs, undefined, { signal });
    signal?.throwIfAborted();
    deadline = Date.now() + options.timeoutMs;
    timeout = AbortSignal.timeout(options.timeoutMs);
    signal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    Object.assign(output, await definition.run(options, context));
    if (Object.hasOwn(output, "elapsedMs")) output.elapsedMs = Date.now() - startedAt;
    return { output, exitCode: 0 };
  } catch (error) {
    if (Object.hasOwn(output, "elapsedMs")) output.elapsedMs = Date.now() - startedAt;
    Object.assign(output, error?.output);
    const reason = dependencies.signal?.aborted ? dependencies.signal.reason : error;
    const timedOut = timeout?.aborted || deadline !== undefined && Date.now() >= deadline;
    output.error = timedOut ? "verification timeout" : String(reason?.message ?? reason);
    return { output, exitCode: timedOut ? 3 : reason?.exitCode ?? 1 };
  }
}

export async function scriptMain(definition, argv, dependencies = {}) {
  let options;
  try {
    options = parseScriptArgs(definition, argv);
    if (options.out) await validateGatewayOutput(options);
    let result;
    if (options.wait) result = await joinOperation(options.wait, { method: definition.id, env: options.env, timeoutMs: options.timeoutMs, signal: dependencies.signal });
    else if (options.background) {
      return { output: await startOperation(fileURLToPath(definition.url), options, { entry: definition.id, method: definition.id, lifetimeMs: (options.afterMs ?? 0) + options.timeoutMs + 1000, signal: dependencies.signal }), exitCode: 0 };
    } else result = await executeScript(definition, options, dependencies);
    if (options.out) await writeGatewayOutput(options, result.output);
    return result;
  } catch (error) { return { output: { ...definition.empty(), error: String(error?.message ?? error) }, exitCode: error?.exitCode ?? 1 }; }
}

export async function entrypoint(definition) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(definition.url)) return;
  if (process.argv[2] === "--worker" && process.connected) {
    await serveOperation(async (options, context) => {
      await context.publish({ pid: process.pid });
      const result = await executeScript(definition, options, { signal: context.signal });
      if (options.out) await writeGatewayOutput(options, result.output);
      return result;
    });
  } else {
    const result = await runWithShutdownScope((signal) => scriptMain(definition, process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }
}
