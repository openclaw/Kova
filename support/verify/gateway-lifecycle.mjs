import { createWriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess, runWithShutdownScope } from "../../src/commands.mjs";
import { ocmInvocation } from "../../src/ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";
import { openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv } from "../openclaw-runtime.mjs";
import { personaGatewayEnvironment } from "../persona/environment-content.mjs";
import { abortable, atomicJson, CallError, cleanupGatewayHandle, failure, joinOperation, parseFlags, positiveMs, readOperation, serveOperation, startOperation } from "./background.mjs";

export { cleanupGatewayHandle } from "./background.mjs";
export { requestGatewayFixture } from "./gateway-fixture-client.mjs";
export const gatewayMaximumLifetimeMs = 6 * 60 * 60 * 1000;
const filename = fileURLToPath(import.meta.url);

async function requireUnusedPort(port, timeoutMs) {
  await new Promise((accept, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error) => { socket.destroy(); error ? reject(error) : accept(); };
    socket.once("connect", () => finish(new CallError(`Gateway port ${port} already has a listener`, 1)));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? null : error));
    socket.setTimeout(Math.min(2000, timeoutMs), () => finish(new CallError("Gateway port check timeout", 3)));
  });
}

export function parseGatewayLifecycleArgs(argv) {
  const [action, ...args] = argv;
  if (!["start", "stop"].includes(action)) throw new CallError("expected start or stop");
  const options = parseFlags(args, ["background"]);
  const allowed = action === "start" ? ["env", "handle", "timeout", "background", "wait"] : ["wait", "timeout"];
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new CallError(`unknown flag: --${name}`);
  if (action === "start") {
    if (options.wait) {
      for (const name of ["env", "handle", "background"]) if (options[name] !== undefined) throw new CallError(`--wait cannot be combined with --${name}`);
    } else if (!options.env || !options.handle) throw new CallError("start requires --env and --handle");
  }
  if (action === "stop" && !options.wait) throw new CallError("stop requires --wait");
  options.timeoutMs = positiveMs(options.timeout, 120000);
  if (options.handle) options.handle = resolve(options.handle);
  if (options.wait) options.wait = resolve(options.wait);
  return { ...options, action };
}

async function optionalRecord(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function runForegroundGateway(options, context, dependencies = {}) {
  let published = false;
  let runtime;
  let pending;
  const prepare = dependencies.prepare ?? prepareOpenClawRuntimeFromOcmEnv;
  const finishRequest = async (request, result) => {
    const { restart, ...publicResult } = result;
    await unlink(join(context.operation.directory, "fixture-request.json"));
    await unlink(join(context.operation.directory, `fixture-cancel-${request.id}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await atomicJson(join(context.operation.directory, `fixture-result-${request.id}.json`), publicResult);
  };
  const requestInterruption = async (request) => {
    if (Date.now() >= request.expiresAt) return new CallError("fixture preparation timeout", 3);
    if (await optionalRecord(join(context.operation.directory, `fixture-cancel-${request.id}.json`))) return new CallError("fixture request interrupted", 1);
    return null;
  };
  const waitWhileStopped = async () => {
    while (!context.signal.aborted) {
      const request = await optionalRecord(join(context.operation.directory, "fixture-request.json"));
      if (request) return request;
      await sleep(50);
    }
    return null;
  };
  const stoppedResult = () => ({ output: { method: "gateway.stop", result: { stopped: true }, error: null, elapsedMs: 0 }, exitCode: 0, cleanupComplete: true });
  while (true) {
    const paused = new AbortController();
    const signal = AbortSignal.any([context.signal, paused.signal]);
    let request;
    let checking = false;
    let running = false;
    const poll = context.operation && setInterval(async () => {
      if (checking || signal.aborted) return;
      checking = true;
      try {
        if (pending && !pending.recovering) {
          const interruption = await requestInterruption(pending.request);
          if (interruption) paused.abort(interruption);
          return;
        }
        if (!running) return;
        const candidate = await optionalRecord(join(context.operation.directory, "fixture-request.json"));
        if (candidate) {
          if (typeof candidate.id !== "string" || !/^[a-f0-9-]{36}$/.test(candidate.id) || candidate.options?.env !== options.env || !Number.isSafeInteger(candidate.expiresAt)) throw new CallError("invalid fixture request");
          request = candidate;
          paused.abort(new CallError("Gateway paused for fixture preparation", 1));
        }
      } catch (error) { paused.abort(error); }
      finally { checking = false; }
    }, 50);
    let result;
    try {
      if (pending && !pending.recovering) {
        const interruption = await requestInterruption(pending.request);
        if (interruption) paused.abort(interruption);
      }
      result = await runForegroundGatewayProcess(options, {
        ...context, signal, appendLogs: published,
        async publish(ref) {
          if (pending && !pending.recovering) {
            const interruption = await requestInterruption(pending.request);
            if (interruption) throw interruption;
            signal.throwIfAborted();
          }
          if (!published) {
            await context.publish(ref);
            published = true;
          } else {
            const operation = await readOperation(context.operation.handlePath);
            await atomicJson(context.operation.handlePath, { ...operation.handle, ref: { ...operation.handle.ref, ...ref } });
          }
          if (pending) {
            if (!pending.recovering) {
              const interruption = await requestInterruption(pending.request);
              if (interruption) throw interruption;
              signal.throwIfAborted();
            }
            pending.result.output.started = true;
            await finishRequest(pending.request, pending.result);
            pending = undefined;
          }
          running = true;
        }
      }, { ...dependencies, prepare(...args) { runtime = prepare(...args); return runtime; } });
    } finally { if (poll) clearInterval(poll); }
    if (pending) {
      let restoreFailed = false;
      pending.result.output.error = [pending.result.output.error, result.output.error].filter(Boolean).join("; ");
      pending.result.exitCode = pending.result.exitCode === 3 ? 3 : result.exitCode || 1;
      if (!context.signal.aborted && result.cleanupComplete !== false && pending.result.output.staged?.restored === false) {
        const execute = dependencies.fixture ?? (await import("./stage-session-store-fixture.mjs")).executePausedFixture;
        let restored;
        try { restored = await execute({ ...pending.request.options, fixture: undefined, restore: true }, runtime, { signal: context.signal, expiresAt: Date.now() + 30000 }); }
        catch (error) { restored = { output: { error: error.message }, restart: false }; }
        if (restored.restart && restored.output.staged?.restored) {
          pending.result.output.staged = restored.output.staged;
          pending.recovering = true;
          continue;
        }
        pending.result.output.error += `; restore failed: ${restored.output.error}`;
        restoreFailed = true;
      } else if (!context.signal.aborted && result.cleanupComplete !== false && !pending.recovering && paused.signal.aborted && pending.result.output.staged?.restored === true) {
        // Restoration is already complete; finish restarting the original files
        // even though this request's deadline or caller has ended.
        pending.recovering = true;
        continue;
      }
      await finishRequest(pending.request, pending.result);
      pending = undefined;
      if (!restoreFailed || context.signal.aborted) return result;
      request = await waitWhileStopped();
      if (!request) return stoppedResult();
    }
    if (!request || context.signal.aborted || result.cleanupComplete === false) return result;
    while (request) {
      let prepared;
      const cancelled = new AbortController();
      const cancelPath = join(context.operation.directory, `fixture-cancel-${request.id}.json`);
      const checkCancellation = async () => {
        try { if (await optionalRecord(cancelPath)) cancelled.abort(new CallError("fixture request interrupted", 1)); }
        catch (error) { cancelled.abort(error); }
      };
      await checkCancellation();
      const cancelPoll = setInterval(checkCancellation, 50);
      try {
        const execute = dependencies.fixture ?? (await import("./stage-session-store-fixture.mjs")).executePausedFixture;
        prepared = await execute(request.options, runtime, { signal: AbortSignal.any([context.signal, cancelled.signal]), expiresAt: request.expiresAt });
      } catch (error) {
        prepared = { output: { staged: null, doctor: null, started: false, error: error.message }, exitCode: error.exitCode ?? 1, restart: false };
      } finally {
        clearInterval(cancelPoll);
      }
      if (!context.signal.aborted && prepared.restart !== false) {
        pending = { request, result: prepared, recovering: prepared.exitCode !== 0 };
        break;
      }
      await finishRequest(request, prepared);
      // A failed restore retains both the backup and the stopped owner, allowing
      // another restore request or the ordinary final stop on the same handle.
      request = await waitWhileStopped();
      if (!request) return stoppedResult();
    }
  }
}

async function runForegroundGatewayProcess(options, context, dependencies = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const prepare = dependencies.prepare ?? prepareOpenClawRuntimeFromOcmEnv;
  const connect = dependencies.connect ?? openDirectGatewayRpcClient;
  const spawn = dependencies.spawn ?? spawnOwnedProcess;
  const available = dependencies.requireUnusedPort ?? requireUnusedPort;
  const fetchReady = dependencies.fetch ?? fetch;
  let owned;
  let connection;
  let ended;
  let output;
  let errorOutput;
  let published = false;
  let port;
  let result;
  const remaining = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new CallError("Gateway start timeout", 3);
    return Math.max(1, deadline - Date.now());
  };
  try {
    const runtime = prepare(options.env, { timeoutMs: remaining() });
    port = runtime.gatewayPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CallError("invalid Gateway port");
    await available(port, remaining());
    const expectedPath = resolve(runtime.configPath ?? join(runtime.root, ".openclaw", "openclaw.json"));
    const endpoint = resolveGatewayEndpoint(runtime, null, { protocol: "http" });
    const stdoutPath = join(context.operation.directory, "stdout.log");
    const stderrPath = join(context.operation.directory, "stderr.log");
    output = createWriteStream(stdoutPath, { flags: context.appendLogs ? "a" : "wx", mode: 0o600 });
    errorOutput = createWriteStream(stderrPath, { flags: context.appendLogs ? "a" : "wx", mode: 0o600 });
    let logError;
    output.on("error", (error) => { logError = error; });
    errorOutput.on("error", (error) => { logError = error; });
    remaining();
    const invocation = (dependencies.invocation ?? ocmInvocation)([`@${options.env}`, "--", "gateway", "run", "--port", String(port)]);
    owned = spawn(invocation.file, invocation.args, { env: { ...invocation.env, ...await personaGatewayEnvironment(runtime) } });
    owned.child.stdout.pipe(output);
    owned.child.stderr.pipe(errorOutput);
    owned.closed.then((value) => { ended = value; });
    while (true) {
      remaining();
      if (logError) throw logError;
      if (ended) throw new CallError(`Gateway exited during startup: ${ended.error?.message ?? ended.status ?? ended.signal}`, 1);
      let healthy = false;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(2000, remaining()))]);
      try {
        const response = await fetchReady(`${endpoint.url}/readyz`, { signal });
        await response.body?.cancel();
        healthy = response.ok;
      } catch { context.signal.throwIfAborted(); }
      if (healthy) {
        const opening = connect(runtime, { timeoutMs: remaining(), authFromRuntimeConfig: true });
        opening.then((value) => { if (context.signal.aborted) value.client.close(); }, () => {});
        connection = await abortable(opening, context.signal);
        const snapshot = await abortable(connection.client.request("config.get", {}, { timeoutMs: Math.min(5000, remaining()) }), context.signal, () => connection.client.close());
        if (typeof snapshot?.path !== "string" || !isAbsolute(snapshot.path) || resolve(snapshot.path) !== expectedPath) throw new CallError("Gateway config path does not match the selected environment", 1);
        if (ended || owned.child.exitCode !== null || owned.child.signalCode !== null) throw new CallError("Gateway exited during identity check", 1);
        remaining();
        await context.publish({ pid: owned.child.pid, ownerPid: process.pid, port, stdoutPath, stderrPath, root: runtime.root, configPath: expectedPath });
        published = true;
        connection.client.close();
        connection = undefined;
        break;
      }
      await sleep(Math.min(100, remaining()), undefined, { signal: context.signal });
    }
    await abortable(owned.closed, context.signal);
    throw new CallError(`Gateway exited before stop: ${ended?.error?.message ?? ended?.status ?? ended?.signal}`, 1);
  } catch (error) {
    if (published && context.signal.aborted && context.signal.reason?.message === "background operation stopped") {
      result = { output: { method: "gateway.stop", result: { pid: owned.child.pid, port, stopped: true }, error: null, elapsedMs: Date.now() - startedAt }, exitCode: 0 };
    } else if (!published && Date.now() >= deadline) {
      result = failure("gateway.start", new CallError("Gateway start timeout", 3), startedAt);
    } else result = failure("gateway.start", context.signal.aborted ? context.signal.reason : error, startedAt);
  } finally {
    connection?.client.close();
    try { await owned?.stop(); }
    catch (error) { result = { ...failure("gateway.stop", error, startedAt), cleanupComplete: false, cleanupError: error.message }; }
    for (const stream of [output, errorOutput]) {
      if (!stream) continue;
      stream.end();
      try { await finished(stream); } catch (error) { result = { ...result, ...failure("gateway.stop", error, startedAt) }; }
    }
  }
  return result;
}

export async function gatewayLifecycleMain(argv, { signal } = {}) {
  let options;
  try {
    options = parseGatewayLifecycleArgs(argv);
    if (options.action === "stop") {
      return await cleanupGatewayHandle(options.wait, { timeoutMs: options.timeoutMs }) ?? failure("gateway.stop", new CallError("Gateway handle is absent"));
    }
    if (options.wait) return await joinOperation(options.wait, { timeoutMs: options.timeoutMs, method: "gateway.start", signal });
    const handle = await startOperation(filename, { ...options, startupTimeoutMs: options.timeoutMs + 1000 }, {
      entry: "foreground-gateway-start", method: "gateway.start", lifetimeMs: gatewayMaximumLifetimeMs, signal
    });
    return { output: handle, exitCode: 0 };
  } catch (error) { return failure(`gateway.${options?.action ?? "start"}`, error); }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") {
    await runWithShutdownScope((signal) => serveOperation(runForegroundGateway, { signal }));
  } else {
    const result = await runWithShutdownScope((signal) => gatewayLifecycleMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }
}
