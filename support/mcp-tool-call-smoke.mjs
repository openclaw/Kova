#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";

const SCHEMA_VERSION = "kova.mcpToolCallSmoke.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = positiveInt(args["timeout-ms"] ?? 30000, "timeout-ms");
assertKovaEnvName(envName);

const startedAtEpochMs = Date.now();
const summary = {
  schemaVersion: SCHEMA_VERSION,
  env: envName,
  startedAt: new Date(startedAtEpochMs).toISOString(),
  finishedAt: null,
  durationMs: null,
  gateway: null,
  initializeMs: null,
  toolsListMs: null,
  toolsCallMs: null,
  invalidToolsCallMs: null,
  shutdownMs: null,
  toolCount: null,
  toolNames: [],
  safeToolName: null,
  safeToolSucceeded: false,
  safeToolResultSnippet: "",
  invalidToolErrorAttributed: false,
  processExited: false,
  exitStatus: null,
  exitSignal: null,
  bridgeAttempts: [],
  errors: [],
  stderrSnippet: "",
  transcript: []
};

let child;
let tokenFile;
let tokenTempDir;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupTokenSync();
    if (child && !summary.processExited) {
      child.kill(signal);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  const envInfo = await readOcmEnvInfo(envName, timeoutMs);
  const config = JSON.parse(await readFile(envInfo.configPath, "utf8"));
  const token = config?.gateway?.auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`gateway.auth.token missing in ${envInfo.configPath}`);
  }

  tokenTempDir = await mkdtemp(join(tmpdir(), "kova-mcp-token-"));
  tokenFile = join(tokenTempDir, "gateway-token");
  await writeFile(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenFile, 0o600);
  await mkdir(artifactDir, { recursive: true });

  const gateway = resolveGatewayEndpoint(envInfo, config, { protocol: "ws" });
  const gatewayUrl = gateway.url;
  summary.gateway = { source: gateway.source, host: gateway.host, port: gateway.port, url: gatewayUrl };
  const maxBridgeAttempts = 3;
  for (let attempt = 1; attempt <= maxBridgeAttempts; attempt += 1) {
    const attemptSummary = {
      attempt,
      startedAt: new Date().toISOString(),
      status: null,
      error: null,
      stderrSnippet: ""
    };
    try {
      await waitForGateway(envName, Math.min(timeoutMs, 12000));
      await runMcpBridgeAttempt(gatewayUrl, tokenFile, token);
      attemptSummary.status = "pass";
      summary.bridgeAttempts.push(attemptSummary);
      break;
    } catch (error) {
      attemptSummary.status = "fail";
      attemptSummary.error = formatError(error);
      attemptSummary.stderrSnippet = child?.stderrText?.slice(-2000) ?? "";
      summary.bridgeAttempts.push(attemptSummary);
      await terminateBridgeProcess();
      child = undefined;
      if (attempt >= maxBridgeAttempts || !isTransientMcpBridgeFailure(error, attemptSummary.stderrSnippet)) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }
} catch (error) {
  summary.errors.push(formatError(error));
  await terminateBridgeProcess();
} finally {
  if (child?.stderrText) {
    summary.stderrSnippet = child.stderrText.slice(-4000);
  }
  if (tokenFile) {
    await rm(tokenFile, { force: true });
  }
  if (tokenTempDir) {
    await rm(tokenTempDir, { recursive: true, force: true });
  }
  const finishedAtEpochMs = Date.now();
  summary.finishedAt = new Date(finishedAtEpochMs).toISOString();
  summary.durationMs = finishedAtEpochMs - startedAtEpochMs;
  await writeFile(join(artifactDir, "mcp-tool-call-smoke.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

process.exit(summary.errors.length === 0 && summary.processExited ? 0 : 1);

async function runMcpBridgeAttempt(gatewayUrl, gatewayTokenFile, gatewayToken) {
  summary.processExited = false;
  summary.exitStatus = null;
  summary.exitSignal = null;

  child = spawn("ocm", [
    `@${envName}`,
    "--",
    "mcp",
    "serve",
    "--url",
    gatewayUrl,
    "--token-file",
    gatewayTokenFile,
    "--claude-channel-mode",
    "off"
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: process.env
  });

  const transport = createJsonLineTransport(child, summary.transcript);
  await transport.waitForSpawn();

  const initializeStarted = Date.now();
  await transport.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kova-mcp-tool-call-smoke", version: "1.0.0" }
  }, timeoutMs);
  summary.initializeMs = Date.now() - initializeStarted;

  transport.notify("notifications/initialized", {});

  const listStarted = Date.now();
  const tools = await transport.request("tools/list", {}, timeoutMs);
  summary.toolsListMs = Date.now() - listStarted;
  const toolList = Array.isArray(tools?.tools) ? tools.tools : [];
  summary.toolCount = toolList.length;
  summary.toolNames = toolList.map((tool) => tool?.name).filter((name) => typeof name === "string").sort();
  const safeToolCall = selectSafeToolCall(summary.toolNames, gatewayUrl, gatewayToken);
  summary.safeToolName = safeToolCall?.name ?? null;
  if (!safeToolCall) {
    throw new Error(`MCP bridge did not expose a deterministic safe tool; tools=${summary.toolNames.join(",")}`);
  }

  const callStarted = Date.now();
  const callResult = await transport.request("tools/call", {
    name: summary.safeToolName,
    arguments: safeToolCall.arguments
  }, timeoutMs);
  summary.toolsCallMs = Date.now() - callStarted;
  summary.safeToolSucceeded = callResult?.isError !== true && Array.isArray(callResult?.content);
  summary.safeToolResultSnippet = JSON.stringify(callResult ?? {}).slice(0, 4000);
  if (!summary.safeToolSucceeded) {
    throw new Error(`MCP tools/call ${summary.safeToolName} did not return a successful tool result`);
  }

  const invalidStarted = Date.now();
  try {
    const invalidResult = await transport.request("tools/call", {
      name: "kova_missing_tool_for_error_attribution",
      arguments: {}
    }, timeoutMs);
    summary.invalidToolsCallMs = Date.now() - invalidStarted;
    summary.invalidToolErrorAttributed = invalidResult?.isError === true ||
      /unknown|missing|not found|invalid/i.test(JSON.stringify(invalidResult ?? {}));
  } catch (error) {
    summary.invalidToolsCallMs = Date.now() - invalidStarted;
    summary.invalidToolErrorAttributed = /unknown|missing|not found|invalid|tool/i.test(formatError(error));
  }
  if (!summary.invalidToolErrorAttributed) {
    throw new Error("invalid MCP tools/call was not attributed as a tool error");
  }

  const shutdownStarted = Date.now();
  child.stdin.end();
  const exit = await waitForExit(child, Math.min(timeoutMs, 5000));
  summary.shutdownMs = Date.now() - shutdownStarted;
  summary.processExited = true;
  summary.exitStatus = exit.status;
  summary.exitSignal = exit.signal;
  if (exit.status !== 0 || exit.signal !== null) {
    throw new Error(`MCP bridge did not exit cleanly (status=${exit.status ?? "null"}, signal=${exit.signal ?? "none"})`);
  }
}

function selectSafeToolCall(toolNames, gatewayUrl, gatewayToken) {
  if (toolNames.includes("cron")) {
    return {
      name: "cron",
      arguments: {
        action: "status",
        gatewayUrl,
        gatewayToken
      }
    };
  }
  if (toolNames.includes("conversations_list")) {
    return {
      name: "conversations_list",
      arguments: {
        limit: 1,
        includeLastMessage: false,
        includeDerivedTitles: false
      }
    };
  }
  if (toolNames.includes("events_poll")) {
    return {
      name: "events_poll",
      arguments: {
        after_cursor: 0,
        limit: 1
      }
    };
  }
  if (toolNames.includes("permissions_list_open")) {
    return {
      name: "permissions_list_open",
      arguments: {}
    };
  }
  return null;
}

function createJsonLineTransport(processHandle, transcript) {
  let nextId = 1;
  let stdout = "";
  const pending = new Map();
  let spawnError;
  let spawned = false;

  processHandle.stderrText = "";

  processHandle.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      transcript.push({ direction: "in", message: redactMessage(message) });
      const waiter = pending.get(message.id);
      if (!waiter) {
        continue;
      }
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  processHandle.stderr.on("data", (chunk) => {
    processHandle.stderrText += chunk.toString("utf8");
  });
  processHandle.stdin.on("error", (error) => {
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  processHandle.on("spawn", () => {
    spawned = true;
  });
  processHandle.on("error", (error) => {
    spawnError = error;
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });
  processHandle.on("exit", (status, signal) => {
    const error = new Error(`MCP bridge exited before reply (status=${status ?? "null"}, signal=${signal ?? "none"})`);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  return {
    async waitForSpawn() {
      const deadline = Date.now() + 5000;
      while (!spawned) {
        if (spawnError) {
          throw spawnError;
        }
        if (Date.now() >= deadline) {
          throw new Error("MCP bridge process did not spawn");
        }
        await sleep(25);
      }
    },
    request(method, params, requestTimeoutMs) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: "2.0", id, method, params };
      transcript.push({ direction: "out", message: redactMessage(payload) });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
        processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    },
    notify(method, params) {
      const payload = { jsonrpc: "2.0", method, params };
      transcript.push({ direction: "out", message: redactMessage(payload) });
      processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  };
}

async function readOcmEnvInfo(env, requestTimeoutMs) {
  const result = await runProcess("ocm", ["env", "show", env, "--json"], requestTimeoutMs);
  if (result.status !== 0) {
    throw new Error(`ocm env show failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.status}`);
  }
  return JSON.parse(result.stdout);
}

async function waitForGateway(env, requestTimeoutMs) {
  const deadline = Date.now() + requestTimeoutMs;
  let last = null;
  let consecutiveOk = 0;
  while (Date.now() < deadline) {
    last = await runProcess("ocm", [`@${env}`, "--", "status"], Math.min(5000, Math.max(1000, deadline - Date.now())));
    if (last.status === 0) {
      consecutiveOk += 1;
      if (consecutiveOk >= 3) {
        await sleep(1000);
        return;
      }
    } else {
      consecutiveOk = 0;
    }
    await sleep(500);
  }
  throw new Error(`gateway status did not become available before MCP bridge start: ${firstLine(last?.stderr) || firstLine(last?.stdout) || "timed out"}`);
}

function runProcess(command, args, requestTimeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, requestTimeoutMs);
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

function waitForExit(child, requestTimeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ status: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${requestTimeoutMs}ms`)), requestTimeoutMs);
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });
}

async function terminateBridgeProcess() {
  if (!child || summary.processExited) {
    return;
  }
  child.kill("SIGTERM");
  try {
    const exit = await waitForExit(child, 3000);
    summary.processExited = true;
    summary.exitStatus = exit.status;
    summary.exitSignal = exit.signal;
  } catch {
    child.kill("SIGKILL");
  }
}

function isTransientMcpBridgeFailure(error, stderr) {
  return /ECONNREFUSED|connection refused|gateway closed|not yet ready|abnormal closure|MCP bridge exited before reply|MCP server failed to start/i
    .test(`${formatError(error)}\n${stderr ?? ""}`);
}

function redactMessage(message) {
  return JSON.parse(JSON.stringify(message, (key, value) => {
    if (/token/i.test(key) && typeof value === "string") {
      return "<redacted>";
    }
    return value;
  }));
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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTokenSync() {
  if (tokenFile) {
    try {
      rmSync(tokenFile, { force: true });
    } catch {}
  }
  if (tokenTempDir) {
    try {
      rmSync(tokenTempDir, { recursive: true, force: true });
    } catch {}
  }
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
