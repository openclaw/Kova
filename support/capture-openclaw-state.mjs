#!/usr/bin/env node

import { writeOpenClawStateSnapshot } from "../src/collectors/openclaw-state.mjs";

const flags = parseArgs(process.argv.slice(2));

try {
  const snapshot = await writeOpenClawStateSnapshot({
    home: flags.home ?? process.env.OPENCLAW_HOME,
    label: flags.label ?? "openclaw-state",
    outputPath: flags.output,
    limits: {
      maxFileBytes: flags.maxFileBytes
    }
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--home") {
      flags.home = requireValue(args, index);
      index += 1;
    } else if (arg === "--label") {
      flags.label = requireValue(args, index);
      index += 1;
    } else if (arg === "--output") {
      flags.output = requireValue(args, index);
      index += 1;
    } else if (arg === "--max-file-bytes") {
      flags.maxFileBytes = parsePositiveInteger(requireValue(args, index), "max-file-bytes");
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return flags;
}

function requireValue(args, index) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
