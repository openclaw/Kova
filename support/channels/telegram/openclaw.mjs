import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TELEGRAM_TOKEN } from "./events.mjs";

export function configureTelegramOpenClaw({ repoRoot, envName, platform, timeoutMs }) {
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

export function startTelegramOpenClaw({ repoRoot, envName, artifactDir, timeoutMs }) {
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
