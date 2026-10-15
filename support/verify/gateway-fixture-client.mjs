import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicJson, CallError, positiveMs, readOperation } from "./background.mjs";
import { disposableEnv } from "./helper.mjs";

export const gatewayFixtureCleanupMs = 150000;
export const gatewayLifecycleRestoreMs = 30000;
export const gatewayLifecycleStopMs = 7000;

export function gatewayLifecycleStartupTimeout(request, maximum) {
  const remaining = request.options.overallExpiresAt - Date.now() - gatewayLifecycleStopMs;
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new CallError("Gateway restoration timeout", 3);
  return Math.min(maximum, remaining);
}

async function optionalRecord(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function withGatewayLifecycleRequest(request, context, callback) {
  disposableEnv(request.options);
  if (!Number.isSafeInteger(request.options?.overallExpiresAt) || request.expiresAt > request.options.overallExpiresAt - gatewayLifecycleRestoreMs) throw new CallError("request must reserve time for Gateway restoration");
  const cancelled = new AbortController();
  const signal = AbortSignal.any([context.signal, cancelled.signal]);
  const checkCancellation = async () => {
    try {
      if (await optionalRecord(join(context.operation.directory, `fixture-cancel-${request.id}.json`))) cancelled.abort(new CallError("Gateway request interrupted", 1));
    } catch (error) { cancelled.abort(error); }
  };
  const timer = setTimeout(() => cancelled.abort(new CallError("Gateway request timeout", 3)), Math.max(1, request.expiresAt - Date.now()));
  const poll = setInterval(checkCancellation, 50);
  const controls = {
    signal,
    remaining() {
      signal.throwIfAborted();
      if (Date.now() >= request.expiresAt) throw new CallError("Gateway request timeout", 3);
      return Math.max(1, request.expiresAt - Date.now());
    }
  };
  try { await checkCancellation(); controls.remaining(); return await callback(controls); }
  catch (error) { throw signal.aborted ? signal.reason : error; }
  finally { clearTimeout(timer); clearInterval(poll); }
}

// Unlike fixture replacement, these calls keep restoration inside the caller's
// total timeout. The foreground owner retains the request until it has resumed
// or has confirmed that its child stopped after a failed startup.
export async function requestGatewayLifecycle(options, { signal, now = Date.now } = {}) {
  disposableEnv(options);
  const stateRequest = ["pause", "resume"].includes(options.operation);
  if (!stateRequest && !["doctor-repair", "restart-during-turn"].includes(options.operation)) throw new CallError("unsupported Gateway lifecycle request");
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || operation.env !== options.env || !operation.handle) throw new CallError("request requires the selected environment's foreground Gateway handle");
  if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway operation has already ended");
  const overallExpiresAt = Math.min(Date.parse(operation.expiresAt), now() + options.timeoutMs) - 1000;
  const expiresAt = overallExpiresAt - (stateRequest ? gatewayLifecycleStopMs : gatewayLifecycleRestoreMs);
  if (!Number.isSafeInteger(overallExpiresAt) || expiresAt - now() <= (stateRequest ? 0 : gatewayLifecycleStopMs) + (options.drainMs ?? 0)) throw new CallError("insufficient timeout for Gateway interruption and restoration", 3);
  const id = randomUUID();
  const resultPath = join(operation.directory, `fixture-result-${id}.json`);
  const cancel = () => atomicJson(join(operation.directory, `fixture-cancel-${id}.json`), { cancelled: true });
  signal?.throwIfAborted();
  try {
    await atomicJson(join(operation.directory, "fixture-request.json"), { id, options: { ...options, overallExpiresAt }, expiresAt }, { exclusive: true });
  } catch (error) { if (error.code === "EEXIST") throw new CallError("another fixture request is pending"); throw error; }
  let completed = false, cancellation;
  try {
    for (;;) {
      const result = await optionalRecord(resultPath);
      if (result) {
        completed = true;
        await unlink(resultPath);
        if (cancellation || signal?.aborted) {
          const error = cancellation ?? signal.reason;
          error.operationResult = result;
          throw error;
        }
        return result;
      }
      if (signal?.aborted && !cancellation) {
        cancellation = signal.reason ?? new CallError("Gateway request interrupted", 1);
        await cancel();
      }
      if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway ended before the request result", 1);
      if (now() >= overallExpiresAt) throw new CallError("Gateway request timeout; owner cleanup was not confirmed", 3);
      await sleep(50);
    }
  } finally { if (!completed) await cancel(); }
}

export async function requestGatewayFixture(options, { signal } = {}) {
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || operation.env !== options.env || !operation.handle) throw new CallError("fixture requires the selected environment's foreground Gateway handle");
  const ownerExpiry = typeof operation.expiresAt === "string" ? Date.parse(operation.expiresAt) : NaN;
  if (!Number.isFinite(ownerExpiry)) throw new CallError("Gateway operation requires a valid expiry");
  const timeoutMs = positiveMs(options.timeoutMs, 120000);
  if (Date.now() >= ownerExpiry) throw new CallError("Gateway operation has expired", 3);
  if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway operation has already ended");
  const id = randomUUID();
  const path = join(operation.directory, "fixture-request.json");
  const resultPath = join(operation.directory, `fixture-result-${id}.json`);
  let complete = false;
  let cancelled = false;
  let cancellation;
  let deadline = Date.now() + timeoutMs + gatewayFixtureCleanupMs;
  signal?.throwIfAborted();
  try { await atomicJson(path, { id, options: { ...options, timeoutMs }, expiresAt: Date.now() + timeoutMs }, { exclusive: true }); }
  catch (error) { if (error.code === "EEXIST") throw new CallError("another fixture request is pending"); throw error; }
  try {
    while (true) {
      const result = await optionalRecord(resultPath);
      if (result) {
        complete = true;
        if (cancelled) { cancellation.operationResult = result; throw cancellation; }
        return result;
      }
      if (signal?.aborted && !cancelled) {
        cancelled = true;
        cancellation = signal.reason ?? new CallError("fixture request interrupted", 1);
        deadline = Math.min(deadline, Date.now() + gatewayFixtureCleanupMs);
        await atomicJson(join(operation.directory, `fixture-cancel-${id}.json`), { cancelled: true });
      }
      if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway ended before the fixture result", 1);
      // The worker owns rollback and restart after the request deadline.
      if (Date.now() >= deadline || Date.now() >= ownerExpiry) throw new CallError("fixture preparation cleanup timeout", 3);
      await sleep(50);
    }
  } finally {
    if (!complete) await atomicJson(join(operation.directory, `fixture-cancel-${id}.json`), { cancelled: true });
    else if (!cancelled) await unlink(resultPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
