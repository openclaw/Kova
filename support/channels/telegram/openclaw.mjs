import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TELEGRAM_TOKEN } from "./events.mjs";

export function configureTelegramOpenClaw({ repoRoot, envName, platform, timeoutMs }) {
  platform.repoRoot = repoRoot;
  platform.envName = envName;
  platform.timeoutMs = timeoutMs;
  return runTelegramConfigure({
    repoRoot,
    envName,
    platform,
    timeoutMs
  });
}

export function configureTelegramWorkflowCase({ workflowCase, platform }) {
  const livePreview = workflowCase?.livePreview && typeof workflowCase.livePreview === "object" && !Array.isArray(workflowCase.livePreview)
    ? workflowCase.livePreview
    : null;
  const mode = typeof livePreview?.mode === "string" && livePreview.mode.length > 0
    ? livePreview.mode
    : "partial";
  return runTelegramConfigure({
    repoRoot: platform.repoRoot,
    envName: platform.envName,
    platform,
    timeoutMs: platform.timeoutMs,
    streamingMode: mode
  });
}

function runTelegramConfigure({ repoRoot, envName, platform, timeoutMs, streamingMode = null }) {
  const args = [
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
  ];
  if (streamingMode) {
    args.push("--streaming-mode", streamingMode);
  }
  return runCommand("ocm", args, timeoutMs);
}

export async function startTelegramOpenClaw({ repoRoot, envName, artifactDir, timeoutMs }) {
  const providerAuthPrewarmMarkersBefore = countProviderAuthPrewarmMarkers(envName, timeoutMs);
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
  const providerAuthPrewarm = await waitForProviderAuthPrewarm({
    envName,
    timeoutMs: providerAuthPrewarmTimeoutMs(timeoutMs),
    previousCount: providerAuthPrewarmMarkersBefore.count
  });
  return { commandResults, providerAuthPrewarm };
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

async function waitForProviderAuthPrewarm({ envName, timeoutMs, previousCount }) {
  const startedAtEpochMs = Date.now();
  const deadline = startedAtEpochMs + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = countProviderAuthPrewarmMarkers(envName, Math.min(timeoutMs, 10000));
    if (last.status !== 0) {
      return last;
    }
    if (last.count > previousCount) {
      return {
        ...last,
        startedAtEpochMs,
        finishedAtEpochMs: Date.now(),
        durationMs: Date.now() - startedAtEpochMs
      };
    }
    await sleep(250);
  }
  return {
    command: last?.command ?? `ocm logs ${envName} --raw --tail 1000`,
    status: 1,
    signal: null,
    stdout: last?.stdout ?? "",
    stderr: last?.stderr ?? "",
    error: `provider auth prewarm marker did not appear after ${timeoutMs}ms`,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs
  };
}

function countProviderAuthPrewarmMarkers(envName, timeoutMs) {
  const result = runCommand("ocm", ["logs", envName, "--raw", "--tail", "1000"], timeoutMs);
  if (result.status !== 0) {
    return { ...result, count: 0 };
  }
  const matches = result.stdout.match(/provider auth state pre-warmed in \d+ms/g);
  return { ...result, count: matches?.length ?? 0 };
}

function providerAuthPrewarmTimeoutMs(timeoutMs) {
  const configured = Number.parseInt(process.env.KOVA_PROVIDER_PREWARM_TIMEOUT_MS ?? "", 10);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : 5000;
  return Math.min(timeoutMs, requested);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
