#!/usr/bin/env node
import { runProcess } from "./process.mjs";

const separator = process.argv.indexOf("--");
const options = parseArgs(separator >= 0 ? process.argv.slice(2, separator) : process.argv.slice(2));
const command = separator >= 0 ? process.argv.slice(separator + 1) : [];

if (command.length === 0) {
  console.error("usage: assert-command-output.mjs --contains <text> [--expect-status <code>] [--retries <n>] [--delay-ms <n>] -- <command> [args...]");
  process.exit(2);
}

let result;
let matchedLine = null;
let attempts = 0;

while (attempts < options.retries) {
  attempts += 1;
  result = await runProcess(command[0], command.slice(1));
  const combined = `${result.stdout}\n${result.stderr}`;
  matchedLine = result.status === options.expectStatus
    ? lineContaining(combined, options.expectedText)
    : null;
  if (matchedLine !== null) {
    break;
  }
  if (attempts < options.retries) {
    await sleep(options.delayMs);
  }
}

if (matchedLine === null) {
  process.stdout.write(result?.stdout ?? "");
  process.stderr.write(result?.stderr ?? "");
  if (result?.status !== options.expectStatus) {
    console.error(`expected command status ${options.expectStatus}, got ${result?.status ?? "unknown"}`);
  } else {
    console.error(`expected command output to contain ${JSON.stringify(options.expectedText)}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({
  schemaVersion: "kova.commandOutputAssertion.v2",
  command: command.join(" "),
  status: result.status,
  expectedText: options.expectedText,
  attempts,
  matched: true,
  matchedLine
}, null, 2));

function parseArgs(args) {
  const options = {
    expectedText: null,
    expectStatus: 0,
    retries: 1,
    delayMs: 500
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--contains" || arg === "--expect-status" || arg === "--retries" || arg === "--delay-ms") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--contains") options.expectedText = value;
      if (arg === "--expect-status") options.expectStatus = parseInteger(value);
      if (arg === "--retries") options.retries = parseInteger(value);
      if (arg === "--delay-ms") options.delayMs = parseInteger(value);
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.expectedText) throw new Error("--contains is required");
  if (!Number.isInteger(options.expectStatus)) throw new Error("--expect-status must be an integer");
  if (!Number.isInteger(options.retries) || options.retries <= 0) throw new Error("--retries must be a positive integer");
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) throw new Error("--delay-ms must be a non-negative integer");
  return options;
}

function parseInteger(value) {
  return /^[+-]?\d+$/.test(value) ? Number(value) : NaN;
}

function lineContaining(value, expectedText) {
  const expected = expectedText.toLowerCase();
  return String(value ?? "").split(/\r?\n/).find((line) => {
    return line.toLowerCase().includes(expected);
  }) ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
