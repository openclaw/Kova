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
import { abortable, atomicJson, backgroundStartupCleanupMs, CallError, cleanupGatewayHandle, failure, joinOperation, parseFlags, positiveMs, readOperation, serveOperation, startOperation } from "./background.mjs";
import { gatewayLifecycleStartupTimeout, requestGatewayLifecycle, withGatewayLifecycleRequest } from "./gateway-fixture-client.mjs";
import { runPausedDoctor } from "./doctor-repair.mjs";
import { prepareRestartDuringTurn, restartEmpty, restartFailure } from "./restart-during-turn.mjs";

export { cleanupGatewayHandle } from "./background.mjs";
export { requestGatewayFixture } from "./gateway-fixture-client.mjs";
export const gatewayMaximumLifetimeMs = 6 * 60 * 60 * 1000;
const gatewayStartupExtraMs = 1000;
export const gatewayStartupReserveMs = gatewayStartupExtraMs + backgroundStartupCleanupMs;
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
  if (!["start", "stop", "pause", "resume"].includes(action)) throw new CallError("expected start, stop, pause or resume");
  const options = parseFlags(args, ["background", "expect-refusal"]);
  const stateRequest = action === "pause" || action === "resume";
  const allowed = stateRequest ? ["env", "gateway-handle", "timeout", ...(action === "resume" ? ["expect-refusal"] : [])] : action === "start" ? ["env", "handle", "timeout", "background", "wait"] : ["wait", "timeout"];
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new CallError(`unknown flag: --${name}`);
  if (action === "start") {
    if (options.wait) {
      for (const name of ["env", "handle", "background"]) if (options[name] !== undefined) throw new CallError(`--wait cannot be combined with --${name}`);
    } else if (!options.env || !options.handle) throw new CallError("start requires --env and --handle");
  }
  if (action === "stop" && !options.wait) throw new CallError("stop requires --wait");
  if (stateRequest && (!options.env || !options["gateway-handle"])) throw new CallError(`${action} requires --env and --gateway-handle`);
  options.timeoutMs = positiveMs(options.timeout, 120000);
  if (options.handle) options.handle = resolve(options.handle);
  if (options.wait) options.wait = resolve(options.wait);
  if (options["gateway-handle"]) options["gateway-handle"] = resolve(options["gateway-handle"]);
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
  let recoveryPending;
  let lifecyclePending;
  let statePending;
  let explicitlyPaused = false;
  let previousPid = null;
  const stateRequest = (request) => ["pause", "resume"].includes(request?.options?.operation);
  const stateResult = (request, values = {}, error = null) => ({
    output: { method: `gateway.${request.options.operation}`, result: { paused: explicitlyPaused, ready: !explicitlyPaused, refused: false, pid: null, previousPid, port: runtime?.gatewayPort ?? null, ownerPid: process.pid, ...values }, error: error?.message ?? null, elapsedMs: Math.max(0, Date.now() - (request.options.startedAt ?? Date.now())) },
    exitCode: error?.exitCode ?? (error ? 1 : 0)
  });
  const markPaused = async (value, pid = null) => {
    explicitlyPaused = value;
    const operation = await readOperation(context.operation.handlePath);
    await atomicJson(context.operation.handlePath, { ...operation.handle, ref: { ...operation.handle.ref, lifecycleState: value ? "paused" : "running", pid, previousPid } });
  };
  const lifecycleRequest = (request) => ["doctor-repair", "restart-during-turn"].includes(request?.options?.operation);
  const lifecycleFailure = (request, error) => request.options.operation === "restart-during-turn" ? restartFailure(error) : { output: { repairs: null, error: error.message }, exitCode: error.exitCode ?? 1 };
  const prepare = dependencies.prepare ?? prepareOpenClawRuntimeFromOcmEnv;
  const recovery = async () => dependencies.recovery ?? await import("./restart-for-recovery.mjs");
  const finishRequest = async (request, result, recoveryComplete = false) => {
    const { restart, prepared, ...publicResult } = result;
    const operation = await readOperation(context.operation.handlePath);
    if (recoveryComplete !== null) await atomicJson(context.operation.handlePath, { ...operation.handle, ref: { ...operation.handle.ref, fixtureRecoveryComplete: recoveryComplete } });
    await unlink(join(context.operation.directory, "fixture-request.json"));
    await unlink(join(context.operation.directory, `fixture-cancel-${request.id}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await atomicJson(join(context.operation.directory, `fixture-result-${request.id}.json`), publicResult);
  };
  const requestInterruption = async (request) => {
    if (Date.now() >= request.expiresAt) return new CallError("fixture preparation timeout", 3);
    if (await optionalRecord(join(context.operation.directory, `fixture-cancel-${request.id}.json`))) return new CallError("fixture request interrupted", 1);
    return null;
  };
  const validateRequest = (request) => {
    if (typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id) || request.options?.env !== options.env || !Number.isSafeInteger(request.expiresAt)) throw new CallError("invalid fixture request");
    return request;
  };
  const waitWhileStopped = async (explicit = false) => {
    while (!context.signal.aborted) {
      const request = await optionalRecord(join(context.operation.directory, "fixture-request.json"));
      if (request) {
        validateRequest(request);
        if (explicit && (stateRequest(request) || request.options.operation === "doctor-repair")) return request;
        if (stateRequest(request)) {
          await finishRequest(request, stateResult(request, { paused: true, ready: false }, new CallError("complete fixture restoration before changing Gateway state")), null);
          continue;
        }
        if (lifecycleRequest(request)) {
          await finishRequest(request, lifecycleFailure(request, new CallError("request requires a running Gateway; complete fixture restoration first")), null);
          continue;
        }
        if (request.options.operation !== "restart-for-recovery") return request;
        const execute = await recovery();
        await finishRequest(request, execute.recoveryFailure(new CallError("restart recovery requires a running Gateway; complete fixture restoration first", 2)));
        continue;
      }
      await sleep(50);
    }
    return null;
  };
  const stoppedResult = () => ({ output: { method: "gateway.stop", result: { stopped: true }, error: null, elapsedMs: 0 }, exitCode: 0, cleanupComplete: true });
  while (true) {
    if (explicitlyPaused) {
      const request = await waitWhileStopped(true);
      if (!request) return stoppedResult();
      const interruption = await requestInterruption(request);
      if (interruption) {
        await finishRequest(request, stateRequest(request) ? stateResult(request, {}, interruption) : lifecycleFailure(request, interruption), null);
        continue;
      }
      if (request.options.operation === "pause") {
        await finishRequest(request, stateResult(request), null);
        continue;
      }
      if (request.options.operation === "resume") statePending = request;
      else if (request.options.operation === "doctor-repair") {
        const completed = await runPausedDoctor(request, context, dependencies);
        if (completed.output.repairs) completed.output.repairs.gateway = { previousPid, stopped: true, pid: null, ready: false };
        lifecyclePending = { request, result: completed };
      } else {
        await finishRequest(request, { output: { error: "resume the paused Gateway before this request" }, exitCode: 2 }, null);
        continue;
      }
    }
    const paused = new AbortController();
    const signal = AbortSignal.any([context.signal, paused.signal]);
    let request;
    let recoveryPrepared;
    let lifecyclePrepared;
    let preparation;
    let checking = false;
    let running = false;
    const poll = context.operation && setInterval(async () => {
      if (checking || signal.aborted) return;
      checking = true;
      try {
        if (statePending) {
          const interruption = await requestInterruption(statePending);
          if (interruption) paused.abort(interruption);
          return;
        }
        if (pending && !pending.recovering) {
          const interruption = await requestInterruption(pending.request);
          if (interruption) paused.abort(interruption);
          return;
        }
        if (!running || recoveryPending || lifecyclePending) return;
        const candidate = await optionalRecord(join(context.operation.directory, "fixture-request.json"));
        if (candidate) {
          validateRequest(candidate);
          if (stateRequest(candidate)) {
            const interruption = await requestInterruption(candidate);
            if (interruption || candidate.options.operation === "resume") {
              await finishRequest(candidate, stateResult(candidate, {}, interruption ?? new CallError("Gateway is already running")), null);
              return;
            }
            request = candidate;
            paused.abort(new CallError("Gateway paused by request", 1));
            return;
          }
          if (lifecycleRequest(candidate)) {
            preparation = (async () => {
              try {
                if (candidate.options.operation === "restart-during-turn") lifecyclePrepared = await prepareRestartDuringTurn(candidate, runtime, { ...context, signal }, dependencies);
                else await withGatewayLifecycleRequest(candidate, { ...context, signal }, async () => {});
                signal.throwIfAborted();
                lifecyclePrepared?.beginInterruption();
                request = candidate;
                const reason = new CallError("Gateway paused for owned request", 1);
                if (candidate.options.operation === "restart-during-turn") reason.drainMs = candidate.options.drainMs;
                paused.abort(reason);
              } catch (error) {
                lifecyclePrepared?.close();
                await finishRequest(candidate, lifecycleFailure(candidate, error), null);
              }
            })();
            await preparation;
            return;
          }
          if (candidate.options.operation === "restart-for-recovery") {
            const execute = await recovery();
            preparation = (async () => {
              try { recoveryPrepared = await execute.prepareRecoveryRequest(candidate, runtime, { ...context, signal }, dependencies); }
              catch (error) {
                if (error.prepared) recoveryPrepared = { ...error.prepared, preparationError: error };
                else {
                  await finishRequest(candidate, execute.recoveryFailure(error, Date.now() - (error.output?.elapsedMs ?? 0), error.output?.createdIds));
                  return;
                }
              }
              request = candidate;
              paused.abort(new CallError("Gateway paused for recovery preparation", 1));
            })();
            await preparation;
            return;
          }
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
      let startupOptions = options;
      if (statePending) startupOptions = { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, statePending.expiresAt - Date.now())), observeLegacyRefusal: true };
      if (lifecyclePending) {
        try { startupOptions = { ...options, timeoutMs: gatewayLifecycleStartupTimeout(lifecyclePending.request, options.timeoutMs) }; }
        catch (error) {
          const failed = lifecyclePending.result;
          failed.output.error = [failed.output.error, error.message].filter(Boolean).join("; ");
          failed.exitCode = error.exitCode ?? 1;
          await finishRequest(lifecyclePending.request, failed, null);
          return { ...failure("gateway.start", error), cleanupComplete: true };
        }
      }
      if (recoveryPending) {
        const execute = await recovery();
        try { startupOptions = { ...options, timeoutMs: execute.recoveryStartupTimeout(recoveryPending.request, options.timeoutMs) }; }
        catch (error) {
          const previous = recoveryPending.result;
          await finishRequest(recoveryPending.request, execute.recoveryFailure(error, previous.prepared.startedAt, previous.prepared.createdIds));
          recoveryPending = undefined;
          return { ...failure("gateway.start", error), cleanupComplete: true };
        }
      }
      result = await runForegroundGatewayProcess(startupOptions, {
        ...context, signal, appendLogs: published,
        async publish(ref) {
          if (statePending?.options["expect-refusal"]) throw new CallError("Gateway became ready instead of refusing legacy session storage", 1);
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
          if (explicitlyPaused) await markPaused(false, ref.pid);
          if (statePending) {
            await finishRequest(statePending, stateResult(statePending, { paused: false, ready: true, pid: ref.pid }), null);
            statePending = undefined;
          }
          if (pending) {
            if (!pending.recovering) {
              const interruption = await requestInterruption(pending.request);
              if (interruption) throw interruption;
              signal.throwIfAborted();
            }
            pending.result.output.started = true;
            await finishRequest(pending.request, pending.result, true);
            pending = undefined;
          }
          if (recoveryPending) {
            const execute = await recovery();
            const completed = await execute.finishRecoveryRequest(recoveryPending.request, recoveryPending.result, runtime, context, dependencies);
            await finishRequest(recoveryPending.request, completed, true);
            recoveryPending = undefined;
          }
          if (lifecyclePending) {
            const { request, result: completed } = lifecyclePending;
            if (request.options.operation === "doctor-repair") {
              if (completed.output.repairs) completed.output.repairs.gateway = { ...completed.output.repairs.gateway, pid: ref.pid, ready: true };
            } else if (completed.exitCode === 0) {
              completed.output.pid = ref.pid;
              completed.output.ready = true;
            }
            await finishRequest(request, completed, null);
            lifecyclePending = undefined;
          }
          running = true;
        }
      }, { ...dependencies, prepare(...args) { runtime = prepare(...args); return runtime; } });
    } finally {
      if (poll) clearInterval(poll);
      // Preparation can be observing the held reply when the owner is stopped.
      if (preparation && !signal.aborted) paused.abort(new Error("Gateway stopped during recovery preparation"));
      await preparation?.catch(() => {});
    }
    if (statePending) {
      const current = statePending;
      statePending = undefined;
      if (result.cleanupComplete === false || !result.stopObservation) {
        await finishRequest(current, stateResult(current, { paused: false, ready: false }, new CallError(result.cleanupError ?? "Gateway cleanup was not confirmed", 1)), null);
        return result;
      }
      try { await (dependencies.requireUnusedPort ?? requireUnusedPort)(runtime.gatewayPort, Math.max(1, current.options.overallExpiresAt - Date.now())); }
      catch (error) { await finishRequest(current, stateResult(current, { ready: false }, error), null); return result; }
      await markPaused(true);
      const interruption = await requestInterruption(current);
      const expected = current.options["expect-refusal"] && result.startupRefusal === "legacy-session-store" && !interruption && !context.signal.aborted;
      const error = expected ? null : interruption ?? context.signal.reason ?? new CallError(result.output.error ?? "Gateway failed to resume", result.exitCode || 1);
      await finishRequest(current, stateResult(current, { refused: expected }, error), null);
      if (context.signal.aborted) return stoppedResult();
      continue;
    }
    if (lifecyclePending) {
      const failed = lifecyclePending.result;
      failed.output.error = [failed.output.error, result.output.error ?? "Gateway failed to resume"].filter(Boolean).join("; ");
      failed.exitCode = failed.exitCode === 3 ? 3 : result.exitCode || 1;
      await finishRequest(lifecyclePending.request, failed, null);
      if (explicitlyPaused && result.cleanupComplete !== false) { lifecyclePending = undefined; continue; }
      return result;
    }
    if (recoveryPending) {
      const execute = await recovery();
      const previous = recoveryPending.result;
      await finishRequest(recoveryPending.request, execute.recoveryFailure(
        new CallError([previous.output.error, result.output.error ?? "restored Gateway failed to start"].filter(Boolean).join("; "), previous.exitCode === 3 ? 3 : result.exitCode || 1),
        previous.prepared.startedAt, previous.prepared.createdIds
      ));
      return result;
    }
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
    if (request?.options.operation === "pause") {
      try {
        if (result.cleanupComplete === false || !result.stopObservation) throw new CallError(result.cleanupError ?? "Gateway cleanup was not confirmed", 1);
        await (dependencies.requireUnusedPort ?? requireUnusedPort)(runtime.gatewayPort, Math.max(1, request.options.overallExpiresAt - Date.now()));
        previousPid = result.stopObservation.pid;
        await markPaused(true);
        await finishRequest(request, stateResult(request, {}, await requestInterruption(request)), null);
      } catch (error) { await finishRequest(request, stateResult(request, { ready: false }, error), null); return result; }
      continue;
    }
    if (lifecycleRequest(request)) {
      let completed;
      try {
        if (context.signal.aborted) throw context.signal.reason;
        if (result.cleanupComplete === false || !result.stopObservation) throw new Error(result.cleanupError ?? "Gateway cleanup could not be confirmed");
        await (dependencies.requireUnusedPort ?? requireUnusedPort)(runtime.gatewayPort, Math.max(1, request.options.overallExpiresAt - Date.now()));
        if (request.options.operation === "doctor-repair") {
          completed = await runPausedDoctor(request, context, dependencies);
          if (completed.output.repairs) completed.output.repairs.gateway = { previousPid: result.stopObservation.pid, stopped: true, pid: null, ready: false };
        } else {
          if (lifecyclePrepared.completed()) throw new CallError("submitted turn completed before Gateway interruption", 1);
          completed = { output: { ...restartEmpty(), sessionKey: lifecyclePrepared.source.sessionKey, sessionId: lifecyclePrepared.sessionId, runId: lifecyclePrepared.source.runId, previousPid: result.stopObservation.pid, drainMs: request.options.drainMs, interrupted: true, elapsedMs: Date.now() - lifecyclePrepared.startedAt, error: null }, exitCode: 0 };
        }
      } catch (error) { completed = lifecycleFailure(request, error); }
      finally { lifecyclePrepared?.close(); }
      if (!context.signal.aborted && result.cleanupComplete !== false) {
        lifecyclePending = { request, result: completed };
        continue;
      }
      await finishRequest(request, completed, null);
      return result;
    }
    if (request?.options.operation === "restart-for-recovery") {
      const execute = await recovery();
      if (context.signal.aborted || result.cleanupComplete === false) {
        await finishRequest(request, execute.recoveryFailure(context.signal.reason ?? new Error(result.cleanupError ?? "Gateway cleanup could not be confirmed"), recoveryPrepared.startedAt, recoveryPrepared.createdIds));
        return result;
      }
      const recovered = recoveryPrepared.preparationError
        ? { ...execute.recoveryFailure(recoveryPrepared.preparationError, recoveryPrepared.startedAt, recoveryPrepared.createdIds), prepared: recoveryPrepared, restart: true }
        : await execute.runRecoveryRequest(request, recoveryPrepared, runtime, context, async (recoverySignal, observe) =>
        await runForegroundGatewayProcess({ ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, request.expiresAt - Date.now())) }, {
          ...context, signal: recoverySignal, appendLogs: true,
          async publish(ref) {
            const operation = await readOperation(context.operation.handlePath);
            await atomicJson(context.operation.handlePath, { ...operation.handle, ref: { ...operation.handle.ref, ...ref } });
            await observe();
          }
        }, dependencies), dependencies);
      if (!context.signal.aborted && recovered.restart) {
        recoveryPending = { request, result: recovered };
        continue;
      }
      await finishRequest(request, recovered);
      return { ...result, cleanupComplete: recovered.restart, ...(recovered.restart ? {} : { cleanupError: recovered.output.error }) };
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
  let startupRefusal;
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
    if (options.observeLegacyRefusal) {
      for (const stream of [owned.child.stdout, owned.child.stderr]) {
        let recent = "";
        stream.on("data", (chunk) => {
          recent = (recent + chunk.toString("utf8")).slice(-65536);
          const plain = recent.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
          const match = /Legacy session store requires migration: (.+?)\. Run "openclaw(?: --profile \S+)? doctor --fix" against the same state\/config before starting OpenClaw\./.exec(plain);
          if (match && (match[1].startsWith(`${runtime.root}/`) || match[1].startsWith(`${resolve(runtime.root)}/`))) startupRefusal = "legacy-session-store";
        });
      }
    }
    owned.closed.then((value) => { ended = value; });
    while (true) {
      remaining();
      if (logError) throw logError;
      if (startupRefusal) throw new CallError("Gateway refused legacy session storage", 1);
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
    let forceTimer;
    try {
      const drainMs = context.signal.reason?.drainMs;
      let forceError;
      if (owned && Number.isSafeInteger(drainMs)) forceTimer = setTimeout(() => {
        try {
          if (dependencies.signalOwnedProcess) dependencies.signalOwnedProcess(owned.child, "SIGKILL");
          else if (process.platform === "win32") owned.child.kill("SIGKILL");
          else process.kill(-owned.child.pid, "SIGKILL");
        } catch (error) { if (error.code !== "ESRCH") forceError = error; }
      }, drainMs);
      await owned?.stop();
      if (forceError) throw forceError;
      if (owned) result.stopObservation = { pid: owned.child.pid };
    }
    catch (error) { result = { ...failure("gateway.stop", error, startedAt), cleanupComplete: false, cleanupError: error.message }; }
    finally { clearTimeout(forceTimer); }
    for (const stream of [output, errorOutput]) {
      if (!stream) continue;
      stream.end();
      try { await finished(stream); } catch (error) { result = { ...result, ...failure("gateway.stop", error, startedAt) }; }
    }
  }
  if (startupRefusal && result.exitCode !== 3) result.startupRefusal = startupRefusal;
  return result;
}

export async function gatewayLifecycleMain(argv, { signal } = {}) {
  let options;
  try {
    options = parseGatewayLifecycleArgs(argv);
    if (options.action === "pause" || options.action === "resume") {
      return await requestGatewayLifecycle({ ...options, operation: options.action, startedAt: Date.now() }, { signal });
    }
    if (options.action === "stop") {
      return await cleanupGatewayHandle(options.wait, { timeoutMs: options.timeoutMs }) ?? failure("gateway.stop", new CallError("Gateway handle is absent"));
    }
    if (options.wait) return await joinOperation(options.wait, { timeoutMs: options.timeoutMs, method: "gateway.start", signal });
    const handle = await startOperation(filename, { ...options, startupTimeoutMs: options.timeoutMs + gatewayStartupExtraMs }, {
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
