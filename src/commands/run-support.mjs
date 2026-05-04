import { readFile } from "node:fs/promises";
import { runCleanupCommand } from "../cleanup.mjs";
import { resolveFromCwd } from "../cli.mjs";
import { ocmRuntimeRemoveJson } from "../ocm/commands.mjs";

export async function loadRegressionThresholds(flags) {
  if (!flags.regression_thresholds) {
    return null;
  }
  if (flags.regression_thresholds === true) {
    throw new Error("--regression-thresholds requires a JSON file path");
  }
  return JSON.parse(await readFile(resolveFromCwd(String(flags.regression_thresholds)), "utf8"));
}

export function validateBaselineExecutionFlags(flags) {
  if ((flags.baseline || flags.save_baseline) && flags.execute !== true) {
    throw new Error("--baseline and --save-baseline require --execute so baseline evidence comes from real OpenClaw runs");
  }
  if (flags.save_baseline && flags.reviewed_good !== true) {
    throw new Error("--save-baseline requires --reviewed-good after reviewing a passing, stable execution report");
  }
}

export async function cleanupTargetRuntimeIfNeeded(targetPlan, records, options) {
  if (targetPlan.kind !== "local-build") {
    return null;
  }

  const command = ocmRuntimeRemoveJson(targetPlan.runtimeName);
  if (!options.execute) {
    return {
      status: "planned",
      runtimeName: targetPlan.runtimeName,
      command
    };
  }

  if (records.some((record) => record.cleanup === "retained")) {
    return {
      status: "retained",
      runtimeName: targetPlan.runtimeName,
      command,
      reason: "one or more envs were retained"
    };
  }

  const result = await runCleanupCommand(command, { timeoutMs: options.timeoutMs });
  const cleanupStatus = classifyTargetRuntimeCleanup(result);
  return {
    status: cleanupStatus.status,
    runtimeName: targetPlan.runtimeName,
    command,
    reason: cleanupStatus.reason,
    result: {
      status: result.status,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      attempts: result.attempts ?? []
    }
  };
}

function classifyTargetRuntimeCleanup(result) {
  if (result.status === 0) {
    return { status: "removed" };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bruntime\b[\s\S]*\bdoes not exist\b/i.test(output) || /\bnot found\b/i.test(output)) {
    return {
      status: "already-absent",
      reason: "target runtime was not present when cleanup ran"
    };
  }

  return { status: "remove-failed" };
}

export function positiveIntegerFlag(flags, key, defaultValue) {
  if (flags[key] === undefined) {
    return defaultValue;
  }
  return positiveIntegerValue(flags[key], `--${key.replaceAll("_", "-")}`);
}

export function profileIntegerFlag(flags, key, defaultValue) {
  return positiveIntegerFlag(flags, key, defaultValue);
}

export function positiveIntegerValue(raw, label) {
  if (raw === true) {
    throw new Error(`${label} requires a positive integer value`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function summarizePerformanceReceipt(performance, baseline) {
  if (!performance) {
    return null;
  }
  return {
    schemaVersion: performance.schemaVersion,
    repeat: performance.repeat,
    groupCount: performance.groupCount,
    unstableGroupCount: performance.unstableGroupCount,
    profiledRunCount: performance.profiledRunCount ?? 0,
    baselineRegressionCount: baseline?.comparison?.regressionCount ?? null,
    missingBaselineCount: baseline?.comparison?.missingBaselineCount ?? null,
    baselineReviewOk: baseline?.review?.ok ?? null,
    baselineReviewBlockerCount: baseline?.review?.blockerCount ?? null,
    savedBaselinePath: baseline?.saved?.path ?? null
  };
}
