import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTelegramObservations } from "./normalize.mjs";
import {
  TELEGRAM_TOKEN,
  telegramBotEchoUpdate,
  telegramInboundForCase
} from "./events.mjs";

export async function startPlatform({ repoRoot, artifactDir, timeoutMs }) {
  const platformDir = join(artifactDir, "telegram-platform");
  await mkdir(platformDir, { recursive: true });
  const stdoutFd = openSync(join(platformDir, "server.log"), "a");
  const stderrFd = openSync(join(platformDir, "server.err"), "a");
  const child = spawn(process.execPath, [
    join(repoRoot, "support/channels/telegram/platform-shim.mjs"),
    "--dir", platformDir,
    "--token", TELEGRAM_TOKEN
  ], {
    stdio: ["ignore", stdoutFd, stderrFd],
    env: process.env
  });
  const portPath = join(platformDir, "port");
  const port = await waitForPortFile(portPath, timeoutMs);
  const apiRoot = `http://127.0.0.1:${port}`;
  await waitForHttpOk(`${apiRoot}/health`, timeoutMs);
  return {
    channelId: "telegram",
    artifactDir: platformDir,
    apiRoot,
    token: TELEGRAM_TOKEN,
    port,
    portPath,
    callsPath: join(platformDir, "calls.jsonl"),
    process: child,
    stdoutFd,
    stderrFd,
    currentInbound: null,
    driver: null
  };
}

export function configureOpenClaw({ repoRoot, envName, platform, timeoutMs }) {
  return runCommand("ocm", [
    "env",
    "exec",
    envName,
    "--",
    "node",
    join(repoRoot, "support/channels/telegram/configure-openclaw.mjs"),
    "--port-file",
    platform.portPath,
    "--token",
    TELEGRAM_TOKEN
  ], timeoutMs);
}

export function startOpenClaw({ repoRoot, envName, artifactDir, timeoutMs }) {
  const commandResults = [
    runCommand("ocm", ["service", "install", envName, "--json"], timeoutMs),
    runCommand("ocm", ["service", "start", envName, "--json"], timeoutMs),
    runCommand(process.execPath, [
      join(repoRoot, "support/ensure-gateway-running.mjs"),
      "--env",
      envName,
      "--artifact-dir",
      artifactDir,
      "--timeout-ms",
      String(Math.min(timeoutMs, 120000))
    ], timeoutMs)
  ];
  const failed = commandResults.find((result) => result.status !== 0);
  if (failed) {
    throw new Error(`telegram OpenClaw startup command failed: ${failed.command}`);
  }
  return { commandResults };
}

export async function enqueueUserEvent({ workflowCase, platform }) {
  const inbound = telegramInboundForCase(workflowCase);
  platform.currentInbound = inbound;
  await postJson(`${platform.apiRoot}/__kova/enqueue-update`, { update: inbound.native.update });
  return inbound;
}

export async function enqueueBotEcho({ workflowCase, platform, inbound, observations }) {
  await postJson(`${platform.apiRoot}/__kova/enqueue-update`, {
    update: telegramBotEchoUpdate({ workflowCase, inbound, observations })
  });
}

export async function readPlatformCalls({ platform }) {
  const result = await getJson(`${platform.apiRoot}/__kova/calls`);
  return Array.isArray(result.result) ? result.result : [];
}

export async function normalizeObservations({ workflowCase, inbound, calls }) {
  return normalizeTelegramObservations({
    workflowCase,
    inbound,
    calls
  });
}

export async function stopPlatform({ platform }) {
  if (platform?.process && !platform.process.killed) {
    platform.process.kill("SIGTERM");
  }
  closeFd(platform?.stdoutFd);
  closeFd(platform?.stderrFd);
}

function runCommand(command, args, timeoutMs) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null
  };
}

async function waitForPortFile(path, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return port;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for Telegram shim port file ${path}`);
}

async function waitForHttpOk(url, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

function closeFd(fd) {
  if (typeof fd === "number") {
    try {
      closeSync(fd);
    } catch {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
