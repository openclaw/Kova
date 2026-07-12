import { runCleanupCommand } from "../cleanup.mjs";
import { ocmRuntimeRemoveJson } from "../ocm/commands.mjs";
import { isMissingOcmResource } from "../ocm/missing-resource.mjs";

export async function cleanupTargetRuntimeIfNeeded(targetPlan, records, options) {
  if (targetPlan.kind !== "local-build") {
    return null;
  }

  const command = ocmRuntimeRemoveJson(targetPlan.runtimeName);
  if (options.execute !== true) {
    return {
      status: "planned",
      runtimeName: targetPlan.runtimeName,
      command
    };
  }

  if (options.retainOnError === true) {
    return {
      status: "retained",
      runtimeName: targetPlan.runtimeName,
      command,
      reason: "run failed and env retention was requested"
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
  const cleanupStatus = classifyTargetRuntimeCleanup(result, targetPlan.runtimeName);
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

export async function runWithTargetRuntimeCleanup(targetPlan, options, run) {
  let records = [];
  let primaryError = null;
  try {
    records = await run();
  } catch (error) {
    primaryError = error;
  }

  let targetCleanup = null;
  try {
    targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
      ...options,
      retainOnError: primaryError !== null && options.retainOnError === true
    });
  } catch (cleanupError) {
    if (primaryError === null) {
      throw cleanupError;
    }
    throw new AggregateError(
      [primaryError, cleanupError],
      `${primaryError.message}; target runtime cleanup also failed: ${cleanupError.message}`,
      { cause: primaryError }
    );
  }

  if (primaryError !== null) {
    if (targetCleanup?.status === "remove-failed") {
      const cleanupError = targetRuntimeCleanupError(targetCleanup);
      throw new AggregateError(
        [primaryError, cleanupError],
        `${primaryError.message}; target runtime cleanup also failed: ${cleanupError.message}`,
        { cause: primaryError }
      );
    }
    throw primaryError;
  }
  return { records, targetCleanup };
}

function targetRuntimeCleanupError(targetCleanup) {
  const detail = targetCleanup.result?.stderr?.trim() ||
    targetCleanup.result?.stdout?.trim() ||
    `exit ${targetCleanup.result?.status ?? "unknown"}`;
  return new Error(detail);
}

function classifyTargetRuntimeCleanup(result, runtimeName) {
  if (result.status === 0) {
    return { status: "removed" };
  }

  if (isMissingOcmResource(result, "runtime", runtimeName)) {
    return {
      status: "already-absent",
      reason: "target runtime was not present when cleanup ran"
    };
  }

  return { status: "remove-failed" };
}
