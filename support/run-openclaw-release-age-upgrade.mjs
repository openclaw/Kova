#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isKovaEnvName } from "../src/safety.mjs";
import { quoteShell } from "../src/commands.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!isKovaEnvName(options.env)) {
    throw new Error(`refusing to upgrade non-Kova env '${options.env}'`);
  }
  const version = await resolveVersion(options);
  if (!/^\d{4}\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*$/.test(version)) {
    throw new Error(`resolved unsafe OpenClaw version: ${JSON.stringify(version)}`);
  }
  const startedAt = new Date().toISOString();
  const result = await runOcmUpgrade(options.env, version);
  if (options.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.openclawReleaseAgeUpgrade.v1",
      env: options.env,
      age: options.age ?? null,
      days: options.days ?? null,
      version,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: `ocm upgrade ${quoteShell(options.env)} --version ${quoteShell(version)} --json`,
      status: result.status,
      ocm: {
        stdout: result.stdout,
        stderr: result.stderr,
        json: parseJsonOrNull(result.stdout)
      }
    }, null, 2));
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.status;
    return;
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.status;
}

function parseArgs(args) {
  const options = {
    env: null,
    age: null,
    days: null,
    json: false,
    resolverArgs: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--env" || arg === "--age" || arg === "--days" || arg === "--now" || arg === "--time-file" || arg === "--registry-url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--env") {
        options.env = value;
      } else {
        options.resolverArgs.push(arg, value);
        if (arg === "--age") options.age = value;
        if (arg === "--days") options.days = value;
      }
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.env) {
    throw new Error("--env is required");
  }
  if (!options.resolverArgs.some((arg) => arg === "--age" || arg === "--days")) {
    throw new Error("--age or --days is required");
  }
  return options;
}

async function resolveVersion(options) {
  const result = await runProcess(process.execPath, [
    new URL("./resolve-openclaw-release-age.mjs", import.meta.url).pathname,
    ...options.resolverArgs
  ]);
  if (result.status !== 0) {
    throw new Error(`release age resolver failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.status}`);
  }
  return firstLine(result.stdout);
}

function runOcmUpgrade(envName, version) {
  return runProcess("ocm", ["upgrade", envName, "--version", version, "--json"]);
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ status: 127, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

function firstLine(value) {
  return String(value ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function parseJsonOrNull(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(`kova rolling upgrade: ${error.message}`);
  process.exitCode = 1;
});
