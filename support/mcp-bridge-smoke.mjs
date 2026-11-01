#!/usr/bin/env node
import { runProcess } from "./process.mjs";
import { createJsonLineTransport, waitForExit } from "./mcp-json-line-transport.mjs";
import { parseArgs, requiredArg, positiveInt, assertKovaEnvName } from "./cli-args.mjs";

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";

const SCHEMA_VERSION = "kova.mcpBridgeSmoke.v1";

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
  shutdownMs: null,
  toolCount: null,
  toolNames: [],
  processExited: false,
  exitStatus: null,
  exitSignal: null,
  errors: [],
  stderrSnippet: ""
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

  const gateway = resolveGatewayEndpoint(envInfo, config, { protocol: "ws" });
  const gatewayUrl = gateway.url;
  summary.gateway = { source: gateway.source, host: gateway.host, port: gateway.port, url: gatewayUrl };

  child = spawn("ocm", [
    `@${envName}`,
    "--",
    "mcp",
    "serve",
    "--url",
    gatewayUrl,
    "--token-file",
    tokenFile,
    "--claude-channel-mode",
    "off"
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: process.env
  });

  const transport = createJsonLineTransport(child);
  await transport.waitForSpawn();

  const initializeStarted = Date.now();
  await transport.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kova-mcp-bridge-smoke", version: "1.0.0" }
  }, timeoutMs);
  summary.initializeMs = Date.now() - initializeStarted;

  transport.notify("notifications/initialized", {});

  const listStarted = Date.now();
  const tools = await transport.request("tools/list", {}, timeoutMs);
  summary.toolsListMs = Date.now() - listStarted;
  const toolList = Array.isArray(tools?.tools) ? tools.tools : [];
  summary.toolCount = toolList.length;
  summary.toolNames = toolList.map((tool) => tool?.name).filter((name) => typeof name === "string").sort();

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
} catch (error) {
  summary.errors.push(formatError(error));
  if (child && !summary.processExited) {
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
  console.log(JSON.stringify(summary, null, 2));
}

process.exit(summary.errors.length === 0 && summary.processExited ? 0 : 1);

async function readOcmEnvInfo(env, timeoutMs) {
  const result = await runProcess("ocm", ["env", "show", env, "--json"], timeoutMs);
  if (result.status !== 0) {
    throw new Error(`ocm env show failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.status}`);
  }
  return JSON.parse(result.stdout);
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
