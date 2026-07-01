import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { runCommand } from "./commands.mjs";
import { collectorArtifactDirs } from "./collectors/artifacts.mjs";
import { ocmServiceStatusJson } from "./ocm/commands.mjs";
import { repoRoot } from "./paths.mjs";

export const NETWORK_FRONTAGE_SCHEMA = "kova.networkFrontage.v1";
const MODES = new Set(["port", "loopback-frontage"]);

export function normalizeNetworkFrontageMode(value) {
  if (value === undefined || value === null || value === false) {
    return "port";
  }
  const text = String(value).trim();
  if (text === "" || text === "none") {
    return "port";
  }
  if (text === "loopback") {
    return "loopback-frontage";
  }
  if (!MODES.has(text)) {
    throw new Error(`--network-frontage must be one of port, loopback, loopback-frontage`);
  }
  return text;
}

export function networkFrontageControls(flags = {}) {
  const mode = normalizeNetworkFrontageMode(flags.network_frontage);
  const workerId = flags.worker_id ?? (mode === "loopback-frontage" ? process.env.KOVA_WORKER_ID : null) ?? null;
  return {
    schemaVersion: NETWORK_FRONTAGE_SCHEMA,
    mode,
    enabled: mode === "loopback-frontage",
    requested: flags.network_frontage ?? null,
    workerId: workerId === null ? null : positiveInteger(workerId, "--worker-id")
  };
}

export function plannedNetworkFrontage(context, envName) {
  const controls = context.networkFrontage;
  if (!controls?.enabled) {
    return {
      schemaVersion: NETWORK_FRONTAGE_SCHEMA,
      mode: controls?.mode ?? "port",
      enabled: false
    };
  }
  const workerId = resolveWorkerId(controls, envName);
  return {
    schemaVersion: NETWORK_FRONTAGE_SCHEMA,
    mode: controls.mode,
    enabled: true,
    status: "planned",
    workerId,
    envName,
    frontageHost: frontageHostFor(workerId),
    frontagePort: null,
    gatewayHost: "127.0.0.1",
    gatewayPort: null,
    proxyPid: null,
    proxyLogPath: null,
    validation: null,
    cleanup: null
  };
}

export function assertNetworkFrontageCommandSafe(command, context) {
  if (!context.networkFrontage?.enabled) {
    return;
  }
  const fixedLoopbackUrl = /\b(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost):\d+\b/i;
  if (fixedLoopbackUrl.test(command)) {
    throw new Error(
      "network frontage isolation forbids fixed loopback URLs in scenario commands; use OCM env metadata or support helpers that resolve the env gateway port"
    );
  }
}

export function networkFrontageCommandEnv(context) {
  const allocation = context.networkFrontageAllocation;
  if (!context.networkFrontage?.enabled || allocation?.status !== "active") {
    return {};
  }
  return {
    KOVA_NETWORK_FRONTAGE_ENABLED: "1",
    KOVA_NETWORK_FRONTAGE_HOST: allocation.frontageHost,
    KOVA_NETWORK_FRONTAGE_PORT: String(allocation.frontagePort),
    KOVA_NETWORK_FRONTAGE_HTTP_URL: `http://${allocation.frontageHost}:${allocation.frontagePort}`,
    KOVA_NETWORK_FRONTAGE_WS_URL: `ws://${allocation.frontageHost}:${allocation.frontagePort}`
  };
}

export async function maybeStartNetworkFrontage(context, envName, artifactDir) {
  if (!context.networkFrontage?.enabled) {
    return null;
  }
  if (context.networkFrontageAllocation?.status === "active" || context.networkFrontageAllocation?.status === "BLOCKED") {
    return context.networkFrontageAllocation;
  }

  const serviceResult = await runCommand(ocmServiceStatusJson(envName), {
    timeoutMs: Math.min(context.timeoutMs ?? 10000, 10000),
    maxOutputChars: 12000
  });
  const allocation = plannedNetworkFrontage(context, envName);
  allocation.statusCommand = compactResult(serviceResult);
  if (serviceResult.status !== 0) {
    allocation.status = "pending";
    allocation.reason = "service status unavailable";
    context.networkFrontageAllocation = allocation;
    return allocation;
  }

  let service;
  try {
    service = JSON.parse(serviceResult.stdout);
  } catch (error) {
    allocation.status = "pending";
    allocation.reason = `service status JSON parse failed: ${error.message}`;
    context.networkFrontageAllocation = allocation;
    return allocation;
  }

  const gatewayPort = Number(service.gatewayPort);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) {
    allocation.status = "pending";
    allocation.reason = "gateway port not available yet";
    context.networkFrontageAllocation = allocation;
    return allocation;
  }

  allocation.gatewayPort = gatewayPort;
  allocation.frontagePort = gatewayPort;
  allocation.runtime = {
    releaseVersion: service.runtimeReleaseVersion ?? null,
    releaseChannel: service.runtimeReleaseChannel ?? null,
    gatewayState: service.gatewayState ?? null,
    running: service.running ?? null,
    childPid: service.childPid ?? null
  };
  if (!(service.running === true || service.gatewayState === "running" || service.childPid)) {
    allocation.status = "pending";
    allocation.reason = "gateway service is not running yet";
    context.networkFrontageAllocation = allocation;
    return allocation;
  }

  const artifactRoot = collectorArtifactDirs(artifactDir).collectors;
  const proxyDir = join(artifactRoot, "network-frontage");
  await mkdir(proxyDir, { recursive: true });
  allocation.proxyLogPath = join(proxyDir, "proxy.log");

  try {
    allocation.loopbackAlias = await ensureLoopbackAlias(allocation.frontageHost, context);
    context.networkFrontageAllocation = allocation;
    const proxy = await startProxy(allocation);
    allocation.proxyPid = proxy.pid;
    allocation.status = "active";
    context.networkFrontageProxy = proxy;
    context.networkFrontageAllocation = allocation;
    allocation.validation = await validateFrontage(allocation);
    if (allocation.validation.status !== "PASS") {
      throw new Error(allocation.validation.error ?? "network frontage validation failed");
    }
    return allocation;
  } catch (error) {
    await stopNetworkFrontage(context);
    allocation.status = "BLOCKED";
    allocation.blocker = error.message;
    context.networkFrontageAllocation = allocation;
    throw error;
  }
}

export async function stopNetworkFrontage(context) {
  const allocation = context.networkFrontageAllocation;
  const proxy = context.networkFrontageProxy;
  if (!allocation || (!proxy && !allocation.loopbackAlias?.createdByKova)) {
    return null;
  }

  const startedAtEpochMs = Date.now();
  let status = 0;
  let stderr = "";
  if (proxy) {
    try {
      proxy.child.kill("SIGTERM");
      await Promise.race([
        proxy.closed,
        new Promise((resolve) => setTimeout(resolve, 1500, "timeout"))
      ]).then((value) => {
        if (value === "timeout") {
          proxy.child.kill("SIGKILL");
        }
      });
    } catch (error) {
      status = 1;
      stderr = error.message;
    }
  }
  const aliasCleanup = await cleanupLoopbackAlias(allocation, context);
  if (aliasCleanup && aliasCleanup.status !== 0) {
    status = 1;
    stderr = [stderr, aliasCleanup.stderr || aliasCleanup.stdout || "loopback alias cleanup failed"].filter(Boolean).join("\n");
  }

  const finishedAtEpochMs = Date.now();
  const result = {
    command: `kova network frontage stop ${allocation.frontageHost}:${allocation.frontagePort}`,
    status,
    signal: null,
    timedOut: false,
    startedAt: new Date(startedAtEpochMs).toISOString(),
    startedAtEpochMs,
    finishedAt: new Date(finishedAtEpochMs).toISOString(),
    finishedAtEpochMs,
    durationMs: finishedAtEpochMs - startedAtEpochMs,
    stdout: status === 0 ? "network frontage proxy stopped" : "",
    stderr,
    aliasCleanup,
    measurementScope: "cleanup",
    driverKind: "kova"
  };
  allocation.cleanup = {
    status: status === 0 ? "stopped" : "stop-failed",
    result
  };
  allocation.status = status === 0 ? "stopped" : "stop-failed";
  context.networkFrontageProxy = null;
  return result;
}

async function ensureLoopbackAlias(host, context) {
  if (process.platform !== "darwin" || host === "127.0.0.1") {
    return {
      required: false,
      createdByKova: false,
      reason: process.platform === "darwin" ? "primary loopback" : "platform does not require explicit 127/8 alias"
    };
  }
  const present = await runCommand(`ifconfig lo0 | grep -q ${shellQuote(host)}`, {
    timeoutMs: Math.min(context.timeoutMs ?? 10000, 10000),
    maxOutputChars: 4000
  });
  if (present.status === 0) {
    return {
      required: true,
      createdByKova: false,
      status: "already-present",
      check: compactResult(present)
    };
  }
  const add = await runCommand(`ifconfig lo0 alias ${shellQuote(host)}`, {
    timeoutMs: Math.min(context.timeoutMs ?? 10000, 10000),
    maxOutputChars: 4000
  });
  if (add.status !== 0) {
    throw new Error(`failed to create loopback alias ${host}: ${add.stderr || add.stdout || `exit ${add.status}`}`);
  }
  return {
    required: true,
    createdByKova: true,
    status: "created",
    result: compactResult(add)
  };
}

async function cleanupLoopbackAlias(allocation, context) {
  if (!allocation.loopbackAlias?.createdByKova) {
    return null;
  }
  return runCommand(`ifconfig lo0 -alias ${shellQuote(allocation.frontageHost)}`, {
    timeoutMs: Math.min(context.timeoutMs ?? 10000, 10000),
    maxOutputChars: 4000
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function summarizeNetworkFrontage(records = [], controls = null) {
  const allocations = records
    .map((record) => record.networkFrontage)
    .filter((allocation) => allocation?.enabled);
  return {
    schemaVersion: NETWORK_FRONTAGE_SCHEMA,
    mode: controls?.mode ?? allocations[0]?.mode ?? "port",
    enabled: controls?.enabled ?? allocations.length > 0,
    allocations
  };
}

function startProxy(allocation) {
  const childArgs = [
    join(repoRoot, "support", "network-frontage-proxy.mjs"),
    "--listen-host", allocation.frontageHost,
    "--listen-port", String(allocation.frontagePort),
    "--target-host", allocation.gatewayHost,
    "--target-port", String(allocation.gatewayPort)
  ];
  const log = createWriteStream(allocation.proxyLogPath, { flags: "a" });
  const child = spawn(process.execPath, childArgs, {
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.pipe(log);
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return waitForTcp(allocation.frontageHost, allocation.frontagePort, 1500, child)
    .then(() => ({ child, pid: child.pid, closed }));
}

async function validateFrontage(allocation) {
  const startedAtEpochMs = Date.now();
  try {
    await waitForTcp(allocation.frontageHost, allocation.frontagePort, 2000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("frontage health probe timed out")), 2000);
    let response;
    try {
      response = await fetch(`http://${allocation.frontageHost}:${allocation.frontagePort}/health`, {
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`frontage health probe returned HTTP ${response.status}`);
    }
    return {
      status: "PASS",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtEpochMs,
      expectedGateway: `${allocation.gatewayHost}:${allocation.gatewayPort}`,
      frontage: `${allocation.frontageHost}:${allocation.frontagePort}`,
      healthStatus: response.status
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtEpochMs,
      expectedGateway: `${allocation.gatewayHost}:${allocation.gatewayPort}`,
      frontage: `${allocation.frontageHost}:${allocation.frontagePort}`,
      error: error.message
    };
  }
}

export function waitForTcp(host, port, timeoutMs, child = null) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child && child.exitCode !== null) {
        reject(new Error(`network frontage proxy exited before binding (${child.exitCode})`));
        return;
      }
      const socket = net.connect({ host, port });
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (!error) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(error);
        } else {
          setTimeout(attempt, 50);
        }
      };
      socket.setTimeout(250);
      socket.once("connect", () => done(null));
      socket.once("timeout", () => done(new Error(`timed out connecting to ${host}:${port}`)));
      socket.once("error", (error) => done(error));
    };
    attempt();
  });
}

function compactResult(result) {
  return {
    command: result.command,
    status: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function resolveWorkerId(controls, envName) {
  if (controls.workerId !== null && controls.workerId !== undefined) {
    return controls.workerId;
  }
  let hash = 0;
  for (const ch of String(envName)) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 200;
  }
  return hash + 1;
}

function frontageHostFor(workerId) {
  return `127.0.1.${10 + (Number(workerId) % 200)}`;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}
