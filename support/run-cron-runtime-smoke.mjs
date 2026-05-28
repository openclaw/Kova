#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "kova.cronRuntimeSmoke.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = positiveInt(args["timeout-ms"] ?? 90000, "timeout-ms");
assertKovaEnvName(envName);

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
  cronId: null,
  runId: null,
  runStatus: null,
  commands: [],
  errors: []
};

try {
  await mkdir(artifactDir, { recursive: true });
  const gateway = await resolveExplicitGateway(envName, timeoutMs);
  const gatewayArgs = gateway.args;
  const approvalGatewayArgs = omitGatewayUrlArg(gatewayArgs);

  const status = await retryOcm(["@", "--", "cron", "status", ...gatewayArgs, "--json"], Math.min(timeoutMs, 15000), {
    attempts: 6,
    delayMs: 1000,
    label: "cron status"
  });
  summary.cronStatusMs = status.durationMs;
  recordCommand("cron status", status);
  if (status.status !== 0) {
    throw new Error(`cron status failed: ${firstLine(status.stderr) || firstLine(status.stdout) || status.status}`);
  }

  const name = `kova-cron-runtime-${Date.now()}`;
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
    gateway
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
      gateway
    });
    summary.cronRunMs = run.durationMs;
    summary.cronRunTimedOut = run.timedOut === true;
    recordCommand("cron run", run);
    const runJson = parseJsonOutput(run.stdout);
    summary.runId = findFirstString(runJson, ["runId", "id", "sessionId"]);
    summary.runStatus = findFirstString(runJson, ["status", "state", "result"]);
    summary.cronRunCompleted = run.status === 0 && !run.timedOut;
    summary.cronTriggerAttributed = hasCronAttribution(runJson, summary.cronId, summary.runId);
    if (run.status !== 0) {
      throw new Error(`cron run failed: ${firstLine(run.stderr) || firstLine(run.stdout) || run.status}`);
    }
  } finally {
    const runs = await timedOcm(["@", "--", "cron", "runs", "--id", summary.cronId, "--limit", "5", ...gatewayArgs], 15000);
    summary.cronRunsMs = runs.durationMs;
    recordCommand("cron runs", runs);
    const runsJson = parseJsonOutput(runs.stdout);
    summary.runId ||= findFirstString(runsJson, ["runId", "id", "sessionId"]);
    summary.runStatus ||= findFirstString(runsJson, ["status", "state", "result"]);
    summary.cronTriggerAttributed ||= hasCronAttribution(runsJson, summary.cronId, summary.runId);

    const rm = await timedOcm(["@", "--", "cron", "rm", summary.cronId, ...gatewayArgs, "--json"], 15000);
    recordCommand("cron rm", rm);
  }
} catch (error) {
  summary.errors.push(formatError(error));
} finally {
  const finishedAtEpochMs = Date.now();
  summary.finishedAt = new Date(finishedAtEpochMs).toISOString();
  summary.durationMs = finishedAtEpochMs - startedAtEpochMs;
  await writeFile(join(artifactDir, "cron-runtime-smoke.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

process.exit(summary.errors.length === 0 && summary.cronRunCompleted ? 0 : 1);

async function resolveExplicitGateway(env, requestTimeoutMs) {
  const envInfo = await readOcmEnvInfo(env, requestTimeoutMs);
  const config = JSON.parse(await readFile(envInfo.configPath, "utf8"));
  const token = config?.gateway?.auth?.token ?? config?.gateway?.remote?.token;
  const gatewayPort = Number(envInfo.gatewayPort ?? config?.gateway?.port);
  if (typeof token !== "string" || token.length === 0) {
    return { args: [], direct: null };
  }
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) {
    return { args: ["--token", token], direct: null };
  }
  const url = `ws://127.0.0.1:${gatewayPort}`;
  return {
    args: ["--url", url, "--token", token],
    direct: { url, token }
  };
}

function omitGatewayUrlArg(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--url") {
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

async function timedOcm(args, commandTimeoutMs) {
  const actualArgs = args.map((arg) => arg === "@" ? `@${envName}` : arg);
  const started = Date.now();
  const result = await runProcess("ocm", actualArgs, commandTimeoutMs);
  return { ...result, durationMs: Date.now() - started };
}

async function retryOcm(args, commandTimeoutMs, options) {
  const attempts = options.attempts ?? 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await timedOcm(args, commandTimeoutMs);
    if (last.status === 0) {
      return last;
    }
    if (options.approveScopeUpgrade) {
      const approved = await approveScopeUpgradeIfNeeded(last, options.gatewayArgs ?? [], options.gateway);
      if (approved) {
        if (attempt < attempts) {
          await sleep(options.delayMs ?? 500);
          continue;
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

async function approveScopeUpgradeIfNeeded(result, gatewayArgs, gateway) {
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
  ], 30000);
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
  const ws = new WebSocket(gateway.url);
  let nextId = 1;
  let connected = false;
  const pending = new Map();

  const request = (method, params, requestTimeoutMs = 15000) => {
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
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
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
  });

  return {
    request,
    close() {
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

function runProcess(command, args, commandTimeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, commandTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, signal: null, timedOut, stdout, stderr: error.message });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? 124 : (status ?? 1), signal, timedOut, stdout, stderr });
    });
  });
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

function hasCronAttribution(value, cronId, runId) {
  const text = JSON.stringify(value ?? {});
  return /cron/i.test(text) || (typeof cronId === "string" && text.includes(cronId)) ||
    (typeof runId === "string" && text.includes(runId));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`unexpected positional argument '${value}'`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredArg(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return value;
}

function positiveInt(value, key) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return number;
}

function assertKovaEnvName(value) {
  if (!/^kova-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`unsafe Kova env name '${value}'`);
  }
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function trimSnippet(value) {
  return String(value ?? "").slice(-4000);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTransientGatewayFailure(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /gateway closed|not yet ready|ECONNREFUSED|connection refused|abnormal closure/i.test(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
