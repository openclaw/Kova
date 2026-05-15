#!/usr/bin/env node

import { writeOpenClawStateSnapshot } from "../src/collectors/openclaw-state.mjs";

const flags = parseArgs(process.argv.slice(2));

try {
  const snapshot = await writeOpenClawStateSnapshot({
    home: flags.home ?? process.env.OPENCLAW_HOME,
    label: flags.label ?? "openclaw-state",
    outputPath: flags.output,
    runtime: {
      targetKind: flags.targetKind,
      targetValue: flags.targetValue,
      runtimeName: flags.runtimeName
    },
    service: {
      desired: flags.serviceDesired,
      state: flags.serviceState,
      pid: flags.servicePid,
      port: flags.servicePort,
      restartCount: flags.serviceRestartCount,
      readiness: flags.serviceReadiness
    },
    cleanup: {
      expected: flags.cleanupExpected,
      state: flags.cleanupState,
      reason: flags.cleanupReason
    },
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
    } else if (arg === "--target-kind") {
      flags.targetKind = requireValue(args, index);
      index += 1;
    } else if (arg === "--target-value") {
      flags.targetValue = requireValue(args, index);
      index += 1;
    } else if (arg === "--runtime-name") {
      flags.runtimeName = requireValue(args, index);
      index += 1;
    } else if (arg === "--service-desired") {
      flags.serviceDesired = requireValue(args, index);
      index += 1;
    } else if (arg === "--service-state") {
      flags.serviceState = requireValue(args, index);
      index += 1;
    } else if (arg === "--service-pid") {
      flags.servicePid = parseNonNegativeInteger(requireValue(args, index), "service-pid");
      index += 1;
    } else if (arg === "--service-port") {
      flags.servicePort = parseNonNegativeInteger(requireValue(args, index), "service-port");
      index += 1;
    } else if (arg === "--service-restart-count") {
      flags.serviceRestartCount = parseNonNegativeInteger(requireValue(args, index), "service-restart-count");
      index += 1;
    } else if (arg === "--service-readiness") {
      flags.serviceReadiness = requireValue(args, index);
      index += 1;
    } else if (arg === "--cleanup-expected") {
      flags.cleanupExpected = true;
    } else if (arg === "--cleanup-state") {
      flags.cleanupState = requireValue(args, index);
      index += 1;
    } else if (arg === "--cleanup-reason") {
      flags.cleanupReason = requireValue(args, index);
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

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}
