import { runCleanupCommand } from "../cleanup.mjs";
import { ocmRuntimeRemoveJson } from "../ocm/commands.mjs";
export {
  loadRegressionThresholds,
  positiveIntegerFlag,
  positiveIntegerValue,
  profileIntegerFlag,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "../run/options.mjs";

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
