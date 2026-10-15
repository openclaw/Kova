#!/usr/bin/env node
import { parseArgs, requiredArg, positiveInt, assertKovaEnvName } from "./cli-args.mjs";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";
import { helperCancellation } from "./helper-cancellation.mjs";

const SCHEMA_VERSION = "kova.cronRuntimeSmoke.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = positiveInt(args["timeout-ms"] ?? 90000, "timeout-ms");
const cancellation = helperCancellation(args["cleanup-deadline-ms"]);
assertKovaEnvName(envName);
const commandGroups = new Set();
const killCommandGroups = () => {
  for (const child of commandGroups) signalCommand(child, "SIGKILL");
};
if (cancellation.enabled) process.on("exit", killCommandGroups);

let redactionValues = [];
let ownedGateway;
let registrationAttempted = false;
let registrationUncertain = false;
let jobName;

const startedAtEpochMs = Date.now();
const summary = {
  schemaVersion: SCHEMA_VERSION,
  env: envName,
  startedAt: new Date(startedAtEpochMs).toISOString(),
  finishedAt: null,
  durationMs: null,
  cronStatusMs: null,
  cronRegisterMs: null,
  cronRunMs: null,
  cronRunsMs: null,
  cronRunCompleted: false,
  cronRunTimedOut: false,
  cronTriggerAttributed: false,
  gateway: null,
  cronId: null,
  runId: null,
  runStatus: null,
  commands: [],
  errors: []
};

try {
  await mkdir(artifactDir, { recursive: true });
  const gateway = await resolveExplicitGateway(envName, timeoutMs);
  ownedGateway = gateway;
  const gatewayArgs = gateway.args;
  const gatewayEnv = gateway.env;
  summary.gateway = gateway.summary ?? null;
  const approvalGatewayArgs = omitGatewayOverrideArgs(gatewayArgs);

  const status = await retryOcm(["@", "--", "cron", "status", ...gatewayArgs, "--json"], Math.min(timeoutMs, 15000), {
    attempts: 6,
    delayMs: 1000,
    label: "cron status",
    env: gatewayEnv
  });
  summary.cronStatusMs = status.durationMs;
  recordCommand("cron status", status);
  if (status.status !== 0) {
    throw new Error(`cron status failed: ${firstLine(status.stderr) || firstLine(status.stdout) || status.status}`);
  }

  cancellation.check();
  const name = jobName = `kova-cron-runtime-${Date.now()}${cancellation.enabled ? `-${randomUUID()}` : ""}`;
  registrationAttempted = true;
  const register = await retryOcm([
    "@",
    "--",
    "cron",
    "add",
    "--name",
    name,
    "--at",
    "1m",
    "--system-event",
    "KOVA_CRON_RUNTIME_OK",
    "--delete-after-run",
    ...gatewayArgs,
    "--json"
  ], Math.min(timeoutMs, 30000), {
    attempts: 3,
    delayMs: 1000,
    label: "cron add",
    approveScopeUpgrade: true,
    gatewayArgs: approvalGatewayArgs,
    gateway,
    env: gatewayEnv
  });
  summary.cronRegisterMs = register.durationMs;
  recordCommand("cron add", register);
  if (register.status !== 0) {
    throw new Error(`cron add failed: ${firstLine(register.stderr) || firstLine(register.stdout) || register.status}`);
  }

  const registerJson = parseJsonOutput(register.stdout);
  summary.cronId = findFirstString(registerJson, ["id", "cronId", "jobId", "scheduleId"]);
  if (!summary.cronId) {
    throw new Error("cron add did not return a cron id");
  }

  try {
    cancellation.check();
    const run = await retryOcm([
      "@",
      "--",
      "cron",
      "run",
      summary.cronId,
      "--wait",
      "--wait-timeout",
      "60s",
      "--poll-interval",
      "1s",
      ...gatewayArgs
    ], Math.min(timeoutMs, 75000), {
      attempts: 2,
      delayMs: 1000,
      label: "cron run",
      approveScopeUpgrade: true,
      gatewayArgs: approvalGatewayArgs,
      gateway,
      env: gatewayEnv
    });
    summary.cronRunMs = run.durationMs;
    summary.cronRunTimedOut = run.timedOut === true;
    recordCommand("cron run", run);
    const runJson = parseJsonOutput(run.stdout);
    summary.runId = findFirstString(runJson, ["runId", "id", "sessionId"]);
    summary.runStatus = findFirstString(runJson, ["status", "state", "result"]);
    summary.cronRunCompleted = run.status === 0 && !run.timedOut;
    summary.cronTriggerAttributed = hasCronAttribution(runJson, summary.cronId);
    if (run.status !== 0) {
      throw new Error(`cron run failed: ${firstLine(run.stderr) || firstLine(run.stdout) || run.status}`);
    }
  } finally {
    if (!cancellation.cancelled) {
      const runs = await timedOcm(["@", "--", "cron", "runs", "--id", summary.cronId, "--limit", "5", ...gatewayArgs], 15000, gatewayEnv);
      summary.cronRunsMs = runs.durationMs;
      recordCommand("cron runs", runs);
      const runsJson = parseJsonOutput(runs.stdout);
      summary.runId ||= findFirstString(runsJson, ["runId", "id", "sessionId"]);
      summary.runStatus ||= findFirstString(runsJson, ["status", "state", "result"]);
      summary.cronTriggerAttributed ||= hasCronAttribution(runsJson, summary.cronId);
    }

    if (!cancellation.enabled) {
      const rm = await timedOcm(["@", "--", "cron", "rm", summary.cronId, ...gatewayArgs, "--json"], 15000, gatewayEnv);
      recordCommand("cron rm", rm);
    }
  }
} catch (error) {
  summary.errors.push(formatError(error));
} finally {
  if (cancellation.enabled) {
    let cleanupError = null;
    try { if (registrationAttempted) await removeOwnedJobs(); }
    catch (error) { cleanupError = formatError(error); summary.errors.push(cleanupError); }
    Object.assign(summary, { cancelled: cancellation.cancelled, cleanupComplete: !cleanupError, cleanupError });
  }
  const finishedAtEpochMs = Date.now();
  summary.finishedAt = new Date(finishedAtEpochMs).toISOString();
  summary.durationMs = finishedAtEpochMs - startedAtEpochMs;
  await writeFile(join(artifactDir, "cron-runtime-smoke.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  cancellation.close();
}

process.exit(summary.errors.length === 0 && summary.cronRunCompleted ? 0 : 1);

async function removeOwnedJobs() {
  const removedIds = new Set();
  const errors = [];
  const remove = async (id) => {
    if (removedIds.has(id)) return;
    const removed = await timedOcm(["@", "--", "cron", "rm", id, ...ownedGateway.args, "--json"], 15000, ownedGateway.env, true);
    recordCommand("cron rm", removed);
    if (removed.status !== 0) throw new Error(`cron cleanup failed: ${firstLine(removed.stderr) || removed.status}`);
    removedIds.add(id);
  };
  if (summary.cronId) {
    try { await remove(summary.cronId); }
    catch (error) { errors.push(formatError(error)); }
  }
  // A cancelled registration can have committed before its response was read.
  // The random invocation suffix lets the same owner recover only its own jobs.
  if (cancellation.cancelled || registrationUncertain || !summary.cronId) {
    try {
      const listed = await timedOcm(["@", "--", "cron", "list", "--all", ...ownedGateway.args, "--json"], Math.max(1, Math.floor(cancellation.limit(15000, true) / 2)), ownedGateway.env, true);
      recordCommand("cron cleanup list", listed);
      const value = parseJsonOutput(listed.stdout);
      if (listed.status !== 0 || !Array.isArray(value?.jobs)) throw new Error("could not resolve owned cron jobs during cleanup");
      for (const job of value.jobs) {
        if (job.name !== jobName) continue;
        if (typeof job.id !== "string" || !job.id) throw new Error("owned cron job has no removable id");
        try { await remove(job.id); }
        catch (error) { errors.push(formatError(error)); }
      }
    } catch (error) { errors.push(formatError(error)); }
  }
  if (errors.length) throw new Error(errors.join("; "));
}

async function resolveExplicitGateway(env, requestTimeoutMs) {
  const envInfo = await readOcmEnvInfo(env, requestTimeoutMs);
  const config = JSON.parse(await readFile(envInfo.configPath, "utf8"));
  const token = config?.gateway?.auth?.token ?? config?.gateway?.remote?.token;
  if (typeof token !== "string" || token.length === 0) {
    return { args: [], summary: null, direct: null, env: {} };
  }
  redactionValues = [token];
  const gateway = resolveGatewayEndpoint(envInfo, config, { protocol: "ws" });
  const url = gateway.url;
  return {
    args: ["--url", url, "--token", token],
    summary: { source: gateway.source, host: gateway.host, port: gateway.port, url },
    direct: { url, token },
    env: { OPENCLAW_GATEWAY_TOKEN: token }
  };
}

function omitGatewayOverrideArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--url" || args[index] === "--token" || args[index] === "--password") {
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  return out;
}

async function readOcmEnvInfo(env, requestTimeoutMs) {
  const result = await runProcess("ocm", ["env", "show", env, "--json"], requestTimeoutMs);
  if (result.status !== 0) {
    throw new Error(`ocm env show failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.status}`);
  }
  return JSON.parse(result.stdout);
}

async function timedOcm(args, commandTimeoutMs, envOverrides = {}, cleanup = false) {
  const actualArgs = args.map((arg) => arg === "@" ? `@${envName}` : arg);
  const started = Date.now();
  const result = await runProcess("ocm", actualArgs, commandTimeoutMs, envOverrides, cleanup);
  if (cancellation.enabled && args[3] === "add" && result.status !== 0 && !findScopeUpgradeRequestId(`${result.stderr}\n${result.stdout}`)) registrationUncertain = true;
  return { ...result, durationMs: Date.now() - started };
}

async function retryOcm(args, commandTimeoutMs, options) {
  const attempts = options.attempts ?? 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    cancellation.check();
    last = await timedOcm(args, commandTimeoutMs, options.env);
    if (last.status === 0) {
      return last;
    }
    cancellation.check();
    if (options.approveScopeUpgrade) {
      const approved = await approveScopeUpgradeIfNeeded(last, options.gatewayArgs ?? [], options.gateway, options.env);
      if (approved) {
        await sleep(options.delayMs ?? 500);
        last = await timedOcm(args, commandTimeoutMs, options.env);
        if (last.status === 0) {
          return last;
        }
      }
    }
    if (!isTransientGatewayFailure(last)) {
      return last;
    }
    if (attempt < attempts) {
      recordCommand(`${options.label} transient retry ${attempt}`, last);
      await sleep(options.delayMs ?? 500);
    }
  }
  return last;
}

async function approveScopeUpgradeIfNeeded(result, gatewayArgs, gateway, envOverrides = {}) {
  const requestId = findScopeUpgradeRequestId(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
  if (!requestId) {
    return false;
  }
  if (gateway?.direct) {
    const direct = await timedDirectGatewayApproval(gateway.direct, requestId);
    recordCommand(`scope upgrade direct approve ${requestId}`, direct);
    if (direct.status === 0) {
      return true;
    }
  }
  const approval = await timedOcm([
    "@",
    "--",
    "devices",
    "approve",
    requestId,
    ...gatewayArgs,
    "--json"
  ], 30000, envOverrides);
  recordCommand(`scope upgrade approve ${requestId}`, approval);
  return approval.status === 0;
}

async function timedDirectGatewayApproval(gateway, requestId) {
  const started = Date.now();
  try {
    const payload = await approvePairingOverDirectGateway(gateway, requestId);
    return {
      status: 0,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - started,
      stdout: JSON.stringify(payload),
      stderr: ""
    };
  } catch (error) {
    return {
      status: 1,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: formatError(error)
    };
  }
}

async function approvePairingOverDirectGateway(gateway, requestId) {
  const client = await createDirectGatewayClient(gateway);
  try {
    return await client.request("device.pair.approve", { requestId }, 15000);
  } finally {
    client.close();
  }
}

async function createDirectGatewayClient(gateway) {
  cancellation.check();
  const ws = new WebSocket(gateway.url);
  let nextId = 1;
  let connected = false;
  const pending = new Map();
  const cancel = () => {
    rejectPending(pending, cancellation.signal.reason);
    try { ws.close(); } catch {}
  };

  const request = (method, params, requestTimeoutMs = 15000) => {
    requestTimeoutMs = cancellation.limit(requestTimeoutMs);
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("direct gateway socket is not open");
    }
    const id = `kova-cron-${nextId}`;
    nextId += 1;
    const frame = { type: "req", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`direct gateway request ${method} timed out`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
    });
    ws.send(JSON.stringify(frame));
    return promise;
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("direct gateway connect timed out"));
    }, cancellation.limit(15000));
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      cancellation.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); cancel(); reject(cancellation.signal.reason); };
    const onError = () => {
      cleanup();
      reject(new Error("direct gateway socket error before connect"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("direct gateway socket closed before connect"));
    };
    const onMessage = (event) => {
      void handleDirectGatewayMessage(event.data, pending)
        .then((frame) => {
          if (frame?.type !== "event" || frame.event !== "connect.challenge" || connected) {
            return;
          }
          connected = true;
          void request("connect", {
            minProtocol: 3,
            maxProtocol: 4,
            client: {
              id: "gateway-client",
              displayName: "Kova Cron Runtime",
              version: "kova",
              platform: process.platform,
              mode: "backend",
              instanceId: `kova-cron-${Date.now()}`
            },
            caps: [],
            role: "operator",
            scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
            auth: {
              token: gateway.token
            }
          }, 15000)
            .then(() => {
              cleanup();
              ws.addEventListener("message", (messageEvent) => {
                void handleDirectGatewayMessage(messageEvent.data, pending);
              });
              ws.addEventListener("close", () => rejectPending(pending, new Error("direct gateway socket closed")));
              ws.addEventListener("error", () => rejectPending(pending, new Error("direct gateway socket error")));
              resolve();
            })
            .catch((error) => {
              cleanup();
              reject(error);
            });
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    cancellation.signal?.addEventListener("abort", onAbort, { once: true });
  });
  cancellation.signal?.addEventListener("abort", cancel, { once: true });

  return {
    request,
    close() {
      cancellation.signal?.removeEventListener("abort", cancel);
      rejectPending(pending, new Error("direct gateway client closed"));
      try {
        ws.close();
      } catch {}
    }
  };
}

async function handleDirectGatewayMessage(data, pending) {
  const raw = await readWebSocketData(data);
  const frame = JSON.parse(raw);
  if (frame?.type !== "res") {
    return frame;
  }
  const waiter = pending.get(frame.id);
  if (!waiter) {
    return frame;
  }
  pending.delete(frame.id);
  clearTimeout(waiter.timer);
  if (frame.ok) {
    waiter.resolve(frame.payload);
  } else {
    waiter.reject(new Error(frame.error?.message ?? `${waiter.method} failed`));
  }
  return frame;
}

async function readWebSocketData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

function rejectPending(pending, error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}

function findScopeUpgradeRequestId(text) {
  if (!/scope upgrade pending approval|pairing required/i.test(text ?? "")) {
    return null;
  }
  const match = String(text ?? "").match(/requestId:\s*([0-9a-f-]{12,})/i) ??
    String(text ?? "").match(/"requestId"\s*:\s*"([^"]+)"/i);
  return match?.[1] ?? null;
}

function recordCommand(label, result) {
  summary.commands.push({
    label,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutSnippet: trimSnippet(result.stdout),
    stderrSnippet: trimSnippet(result.stderr)
  });
}

function runProcess(command, args, commandTimeoutMs, envOverrides = {}, cleanup = false) {
  commandTimeoutMs = cancellation.limit(commandTimeoutMs, cleanup);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...envOverrides }, detached: cancellation.enabled && process.platform !== "win32" });
    if (cancellation.enabled && child.pid) commandGroups.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    const stop = () => {
      timedOut = true;
      signalCommand(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalCommand(child, "SIGKILL"), cancellation.enabled ? 100 : 3000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, commandTimeoutMs);
    const signal = cleanup ? null : cancellation.signal;
    signal?.addEventListener("abort", stop, { once: true });
    const finished = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop); };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finished();
      if (child.pid) signalCommand(child, "SIGKILL");
      commandGroups.delete(child);
      resolve({ status: 127, signal: null, timedOut, stdout, stderr: error.message });
    });
    child.on("close", async (status, signal) => {
      if (cancellation.enabled && child.pid) {
        signalCommand(child, "SIGKILL");
        const until = Math.min(cancellation.deadline - 50, Date.now() + 1000);
        while (commandGroupAlive(child) && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
        if (commandGroupAlive(child)) {
          timedOut = true;
          stderr += "\nhelper command processes did not finish";
        } else commandGroups.delete(child);
      }
      finished();
      resolve({ status: timedOut ? 124 : (status ?? 1), signal, timedOut, stdout, stderr });
    });
  });
}

function signalCommand(child, signal) {
  try {
    if (cancellation.enabled && process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}

function commandGroupAlive(child) {
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function parseJsonOutput(text) {
  const jsonStart = String(text ?? "").indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(jsonStart));
  } catch {
    return null;
  }
}

function findFirstString(value, keys) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const queue = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    for (const key of keys) {
      const candidate = current[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
    for (const nested of Object.values(current)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }
  return null;
}

function hasCronAttribution(value, cronId) {
  return findCronAttribution(value, cronId) !== null;
}

function findCronAttribution(value, cronId) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const queue = [{ key: "", value }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current.value !== "object" || current.value === null) {
      continue;
    }
    for (const [key, nested] of Object.entries(current.value)) {
      if (nested && typeof nested === "object") {
        queue.push({ key, value: nested });
        continue;
      }
      if (typeof nested !== "string" || nested.length === 0) {
        continue;
      }
      if (typeof cronId === "string" && nested === cronId) {
        return { key, value: nested };
      }
      if (/(^|[-_])(cron|schedule|trigger|systemEvent|event)([-_]|$)/i.test(key)) {
        return { key, value: nested };
      }
      if (/KOVA_CRON_RUNTIME_OK/.test(nested)) {
        return { key, value: nested };
      }
    }
  }
  return null;
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function trimSnippet(value) {
  return redactText(String(value ?? "")).slice(-4000);
}

function redactText(value) {
  let text = String(value ?? "");
  for (const secret of redactionValues) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("<redacted>");
    }
  }
  return text;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTransientGatewayFailure(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /gateway closed|not yet ready|ECONNREFUSED|connection refused|abnormal closure/i.test(text);
}

function sleep(ms) {
  if (cancellation.enabled) return cancellation.pause(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
