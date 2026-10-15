#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createdSession(record, flag) {
  if (!object(record) || record.error !== null || record.method !== "sessions.create" ||
      !object(record.result) || typeof record.result.key !== "string" || !record.result.key.trim()) {
    throw new Error(`${flag} must contain a successful sessions.create result with a key`);
  }
  return record.result.key;
}

export function projectSessionStatusCursor(source, caller, target) {
  const callerKey = createdSession(caller, "--session-from");
  const targetKey = createdSession(target, "--target-from");
  if (!object(source) || source.error !== null) {
    throw new Error("--from must contain a successful agent-tool-turn result");
  }
  if (source.callerSessionKey !== callerKey || source.toolCall?.name !== "session_status" ||
      source.toolCall?.args?.sessionKey !== targetKey) {
    throw new Error("session_status result does not match the caller and watched session");
  }
  const result = source.toolResult;
  if (!object(result) || (result.isError !== undefined && result.isError !== false) || !object(result.details)) {
    throw new Error("session_status must have successful tool result details");
  }
  const version = result.details.stateVersion;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("session_status stateVersion must be a nonnegative safe integer");
  }
  return { sessionKey: targetKey, changesSince: version };
}

async function readInput(path, flag) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${flag} must name a readable JSON file`);
  }
}

export async function sessionStatusCursorMain(argv) {
  const flags = ["from", "session-from", "target-from", "out"];
  const { values, tokens } = parseArgs({
    args: argv,
    options: Object.fromEntries(flags.map((name) => [name, { type: "string" }])),
    strict: true,
    allowPositionals: false,
    tokens: true
  });
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`repeated flag: --${token.name}`);
    seen.add(token.name);
  }
  for (const flag of flags) {
    if (!values[flag]?.trim()) throw new Error(`--${flag} requires a value`);
  }
  const inputs = await Promise.all(flags.slice(0, 3).map((flag) => readInput(values[flag], `--${flag}`)));
  const output = `${JSON.stringify(projectSessionStatusCursor(...inputs))}\n`;
  const out = resolve(values.out);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, output, { flag: "wx", mode: 0o600 });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(await sessionStatusCursorMain(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.code === "EEXIST" ? "--out already exists" : error.message}\n`);
    process.exitCode = 2;
  }
}
