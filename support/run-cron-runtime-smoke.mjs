#!/usr/bin/env node
import { runProcess } from "./process.mjs";
import { DirectGatewayRpcClient } from "./openclaw-runtime.mjs";
import { parseArgs, requiredArg, positiveInt, assertKovaEnvName } from "./cli-args.mjs";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";

class CronGatewayRpcClient extends DirectGatewayRpcClient {
  buildConnectParams() {
    const params = super.buildConnectParams();
    return {
      ...params,
      minProtocol: 3,
      client: {
        ...params.client,
        displayName: "Kova Cron Runtime",
        instanceId: `kova-cron-${Date.now()}`
      },
      scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"]
    };
  }
}

const SCHEMA_VERSION = "kova.cronRuntimeSmoke.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = positiveInt(args["timeout-ms"] ?? 90000, "timeout-ms");
assertKovaEnvName(envName);

let redactionValues = [];

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
    const runs = await timedOcm(["@", "--", "cron", "runs", "--id", summary.cronId, "--limit", "5", ...gatewayArgs], 15000, gatewayEnv);
    summary.cronRunsMs = runs.durationMs;
    recordCommand("cron runs", runs);
    const runsJson = parseJsonOutput(runs.stdout);
    summary.runId ||= findFirstString(runsJson, ["runId", "id", "sessionId"]);
    summary.runStatus ||= findFirstString(runsJson, ["status", "state", "result"]);
    summary.cronTriggerAttributed ||= hasCronAttribution(runsJson, summary.cronId);

    const rm = await timedOcm(["@", "--", "cron", "rm", summary.cronId, ...gatewayArgs, "--json"], 15000, gatewayEnv);
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

async function timedOcm(args, commandTimeoutMs, envOverrides = {}) {
  const actualArgs = args.map((arg) => arg === "@" ? `@${envName}` : arg);
  const started = Date.now();
  const result = await runProcess("ocm", actualArgs, commandTimeoutMs, envOverrides);
  return { ...result, durationMs: Date.now() - started };
}

async function retryOcm(args, commandTimeoutMs, options) {
  const attempts = options.attempts ?? 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await timedOcm(args, commandTimeoutMs, options.env);
    if (last.status === 0) {
      return last;
    }
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
  const client = new CronGatewayRpcClient(gateway);
  try {
    await client.connect();
    return await client.request("device.pair.approve", { requestId }, { timeoutMs: 15000 });
  } finally {
    client.close();
  }
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}
