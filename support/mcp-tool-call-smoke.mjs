#!/usr/bin/env node
import { runProcess } from "./process.mjs";
import { createJsonLineTransport, waitForExit } from "./mcp-json-line-transport.mjs";
import { parseArgs, requiredArg, positiveInt, assertKovaEnvName } from "./cli-args.mjs";

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";
import { resolveGatewayAuthReference } from "./openclaw-runtime.mjs";

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
let redactionValues = [];

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
  const configuredToken = config?.gateway?.auth?.token;
  const token = configuredToken && typeof configuredToken === "object"
    ? resolveGatewayAuthReference({ envName }, "auth")
    : configuredToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`gateway.auth.token missing in ${envInfo.configPath}`);
  }
  redactionValues = [token];

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

  const transport = createJsonLineTransport(child, (direction, message) => {
    summary.transcript.push({ direction, message: redactMessage(message) });
  });
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
  summary.safeToolResultSnippet = redactText(JSON.stringify(callResult ?? {})).slice(0, 4000);
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
    if (typeof value === "string") {
      return redactText(value);
    }
    return value;
  }));
}

function redactText(value) {
  let text = String(value ?? "");
  for (const secret of redactionValues) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.replaceAll(secret, "<redacted>");
    }
  }
  return text;
}

function formatError(error) {
  return redactText(error instanceof Error ? error.message : String(error));
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
