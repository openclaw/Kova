#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";

const startedAtEpochMs = Date.now();

try {
  const args = parseArgs(process.argv.slice(2));
  const envName = required(args, "env");
  const timeoutMs = positiveInteger(args["timeout-ms"] ?? "120000", "--timeout-ms");
  const intervalMs = positiveInteger(args["interval-ms"] ?? "500", "--interval-ms");
  const artifactDir = args["artifact-dir"] ?? "";

  assertSafeKovaEnv(envName);
  const summary = await ensureGatewayRunning({ envName, timeoutMs, intervalMs });
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "gateway-ready.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(publicSummary(summary), null, 2)}\n`);
  process.exit(summary.ok ? 0 : 1);
} catch (error) {
  const summary = {
    schemaVersion: "kova.ensureGatewayRunning.v1",
    ok: false,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs,
    error: error instanceof Error ? error.message : String(error),
    attempts: [],
    commands: []
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${summary.error}\n`);
  process.exit(2);
}

async function ensureGatewayRunning({ envName, timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  const commands = [];
  let lastStartAt = 0;

  while (Date.now() <= deadline) {
    const status = await serviceStatus(envName);
    commands.push(status.command);
    const health = await gatewayHealth(status.value);
    attempts.push({
      atEpochMs: Date.now(),
      running: status.value?.running === true,
      desiredRunning: status.value?.desiredRunning ?? null,
      gatewayPort: status.value?.gatewayPort ?? null,
      issue: status.value?.issue ?? null,
      healthOk: health.ok,
      healthStatus: health.status,
      healthError: health.error ?? null
    });

    if (status.value?.running === true && health.ok === true) {
      return {
        schemaVersion: "kova.ensureGatewayRunning.v1",
        ok: true,
        envName,
        startedAtEpochMs,
        finishedAtEpochMs: Date.now(),
        durationMs: Date.now() - startedAtEpochMs,
        attempts,
        commands,
        finalStatus: compactStatus(status.value)
      };
    }

    if (status.value?.running !== true && Date.now() - lastStartAt >= Math.max(1000, intervalMs * 2)) {
      const start = await runJson("ocm", ["start", envName, "--json"], { timeoutMs: 30000 });
      commands.push(start.command);
      lastStartAt = Date.now();
    }

    await sleep(intervalMs);
  }

  const finalStatus = await serviceStatus(envName);
  commands.push(finalStatus.command);
  return {
    schemaVersion: "kova.ensureGatewayRunning.v1",
    ok: false,
    envName,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs,
    attempts,
    commands,
    finalStatus: compactStatus(finalStatus.value),
    error: "gateway did not become healthy before timeout"
  };
}

async function serviceStatus(envName) {
  const result = await runJson("ocm", ["service", "status", envName, "--json"], { timeoutMs: 10000 });
  return {
    command: result,
    value: result.status === 0 ? result.json : null
  };
}

async function gatewayHealth(status) {
  const port = status?.gatewayPort;
  if (status?.running !== true || typeof port !== "number") {
    return { ok: false, status: null, error: "gateway is not running" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const gateway = resolveGatewayEndpoint({ gatewayPort: port }, { gateway: { port } }, { protocol: "http" });
  try {
    const response = await fetch(`${gateway.url}/health`, { signal: controller.signal });
    return {
      ok: response.ok,
      status: response.status,
      gateway: { source: gateway.source, host: gateway.host, port: gateway.port, url: gateway.url }
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      gateway: { source: gateway.source, host: gateway.host, port: gateway.port, url: gateway.url },
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function runJson(command, args, { timeoutMs }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({
        id: `${command} ${args.join(" ")}`,
        command: `${command} ${args.join(" ")}`,
        status,
        signal,
        timedOut: signal === "SIGTERM",
        durationMs: Date.now() - started,
        stdoutSnippet: stdout.slice(0, 2000),
        stderrSnippet: stderr.slice(0, 2000),
        json
      });
    });
  });
}

function publicSummary(summary) {
  return {
    schemaVersion: summary.schemaVersion,
    ok: summary.ok,
    envName: summary.envName,
    durationMs: summary.durationMs,
    attemptCount: summary.attempts?.length ?? 0,
    startCommandCount: (summary.commands ?? []).filter((command) => command.command?.startsWith("ocm start ")).length,
    finalStatus: summary.finalStatus ?? null,
    error: summary.error ?? null
  };
}

function compactStatus(status) {
  if (!status) {
    return null;
  }
  return {
    running: status.running ?? null,
    desiredRunning: status.desiredRunning ?? null,
    gatewayPort: status.gatewayPort ?? null,
    childPid: status.childPid ?? null,
    issue: status.issue ?? null
  };
}

function parseArgs(argv) {
  const args = {};
  const allowed = new Set(["env", "artifact-dir", "timeout-ms", "interval-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function assertSafeKovaEnv(value) {
  if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`refusing to manage non-Kova env '${value}'`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
