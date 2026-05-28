#!/usr/bin/env node
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
const options = parseArgs(separator >= 0 ? process.argv.slice(2, separator) : process.argv.slice(2));
const command = separator >= 0 ? process.argv.slice(separator + 1) : [];

if (command.length === 0) {
  console.error("usage: assert-command-output.mjs --pattern <regex> [--expect-status <code>] -- <command> [args...]");
  process.exit(2);
}

const result = await runProcess(command[0], command.slice(1));
const combined = `${result.stdout}\n${result.stderr}`;
const pattern = new RegExp(options.pattern, options.flags);

if (result.status !== options.expectStatus) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error(`expected command status ${options.expectStatus}, got ${result.status}`);
  process.exit(1);
}

const match = combined.match(pattern);
if (!match) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error(`expected command output to match /${options.pattern}/${options.flags}`);
  process.exit(1);
}

console.log(JSON.stringify({
  schemaVersion: "kova.commandOutputAssertion.v1",
  command: command.join(" "),
  status: result.status,
  pattern: options.pattern,
  matched: true,
  matchedLine: lineContaining(combined, match[0])
}, null, 2));

function parseArgs(args) {
  const options = {
    pattern: null,
    flags: "i",
    expectStatus: 0
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pattern" || arg === "--flags" || arg === "--expect-status") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--pattern") options.pattern = value;
      if (arg === "--flags") options.flags = value;
      if (arg === "--expect-status") options.expectStatus = Number.parseInt(value, 10);
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.pattern) throw new Error("--pattern is required");
  if (!Number.isInteger(options.expectStatus)) throw new Error("--expect-status must be an integer");
  return options;
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

function lineContaining(value, match) {
  return String(value ?? "").split(/\r?\n/).find((line) => line.includes(match)) ?? match;
}
