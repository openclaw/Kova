import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { runWithTargetRuntimeCleanup } from "../run/target-cleanup.mjs";
import { executeTargetSetup } from "../run/target-setup.mjs";
import { assertEqual, fileExists } from "./harness.mjs";

export async function localBuildRuntimeCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin");
  const repoDir = join(tmp, "mock-openclaw repo");
  const reportDir = join(tmp, "local-build-cleanup-report");
  const ocmLog = join(tmp, "mock-ocm.log");
  const removeCount = join(tmp, "mock-runtime-remove-count");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local) echo '{"ok":true}'; exit 0 ;;
  runtime:remove)
    count=0
    if [ -f "$KOVA_MOCK_REMOVE_COUNT" ]; then count=$(cat "$KOVA_MOCK_REMOVE_COUNT"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$KOVA_MOCK_REMOVE_COUNT"
    if [ "$count" -lt 2 ]; then echo 'runtime busy shutting down' >&2; exit 1; fi
    echo '{"removed":true}'
    exit 0
    ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:exec) exit 0 ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*) echo 'ok'; exit 0 ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs matrix run --profile smoke --target local-build:${quoteShell(repoDir)} --include scenario:fresh-install --repeat 3 --auth skip --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog,
      KOVA_MOCK_REMOVE_COUNT: removeCount
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.targetCleanup?.status, "removed", "local-build target cleanup status");
    assertEqual(report.targetCleanup?.result?.attempts?.length, 2, "local-build target cleanup retry attempts");
    if (!/runtime remove kova-local-[a-z0-9-]+ --json/.test(log)) {
      throw new Error(`runtime remove was not called; log:\n${log}`);
    }
    return {
      id: "local-build-runtime-cleanup",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-runtime-cleanup",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function localBuildRuntimeAlreadyAbsentCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin-absent-runtime");
  const repoDir = join(tmp, "mock-openclaw failed build");
  const reportDir = join(tmp, "local-build-absent-cleanup-report");
  const ocmLog = join(tmp, "mock-ocm-absent.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local) echo 'dependency install failed' >&2; exit 1 ;;
  runtime:remove) echo "ocm: runtime \\"$3\\" does not exist" >&2; exit 1 ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:destroy) echo "ocm: environment \\"$3\\" does not exist" >&2; exit 1 ;;
esac
case "$1" in
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs matrix run --profile smoke --target local-build:${quoteShell(repoDir)} --include scenario:fresh-install --repeat 3 --auth skip --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const summaryResult = await runCommand(`node bin/kova.mjs report summarize ${quoteShell(receipt.jsonPath)} --json`, {
      timeoutMs: 30000,
      maxOutputChars: 1000000
    });
    if (summaryResult.status !== 0) {
      throw new Error(summaryResult.stderr.trim() || summaryResult.stdout.trim() || `summary exit ${summaryResult.status}`);
    }
    const summary = JSON.parse(summaryResult.stdout);
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.summary?.statuses?.BLOCKED, 3, "failed local-build repeat statuses");
    assertEqual(report.records?.every((record) => record.cleanup === "already-absent"), true, "already absent env cleanup statuses");
    assertEqual(
      report.records?.slice(1).every((record) =>
        record.phases?.find((phase) => phase.id === "target-setup")?.results?.[0]?.cached === true
      ),
      true,
      "failed target setup result reused after first attempt"
    );
    assertEqual(report.targetCleanup?.status, "already-absent", "already absent local-build target cleanup status");
    assertEqual(summary.scenarios?.[0]?.failureReason, "dependency install failed", "summary failure reason");
    assertEqual(
      log.split("\n").filter((line) => line.startsWith("runtime build-local ")).length,
      1,
      "failed local-build target setup executes once per matrix"
    );
    if (!/runtime remove kova-local-[a-z0-9-]+ --json/.test(log)) {
      throw new Error(`runtime remove was not called after failed build; log:\n${log}`);
    }
    return {
      id: "local-build-runtime-already-absent-cleanup",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-runtime-already-absent-cleanup",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function localBuildRuntimeExceptionCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin-runtime-exception");
  const removeLog = join(tmp, "mock-runtime-exception-remove.log");
  const ocmPath = join(binDir, "ocm");
  await mkdir(binDir, { recursive: true });
  await writeFile(ocmPath, `#!/bin/sh
case "$1:$2" in
  runtime:remove)
    printf '%s\\n' "$*" >> "$KOVA_MOCK_REMOVE_LOG"
    if [ "$KOVA_MOCK_REMOVE_FAIL" = "1" ]; then
      echo "runtime removal failed" >&2
      exit 2
    fi
    echo '{"removed":true}'
    exit 0
    ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const previousPath = process.env.PATH;
  const previousLog = process.env.KOVA_MOCK_REMOVE_LOG;
  const previousRemoveFail = process.env.KOVA_MOCK_REMOVE_FAIL;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.KOVA_MOCK_REMOVE_LOG = removeLog;
  const targetPlan = {
    kind: "local-build",
    runtimeName: "kova-local-exception"
  };

  try {
    let original;
    try {
      await runWithTargetRuntimeCleanup(targetPlan, {
        execute: true,
        timeoutMs: 30000,
        retainOnError: false
      }, async () => {
        throw new Error("original run failure");
      });
    } catch (error) {
      original = error;
    }
    assertEqual(original?.message, "original run failure", "target cleanup preserves original error");
    assertEqual((await readFile(removeLog, "utf8")).trim().split("\n").length, 1, "target runtime removed exactly once");

    await rm(removeLog, { force: true });
    let retainedError;
    try {
      await runWithTargetRuntimeCleanup(targetPlan, {
        execute: true,
        timeoutMs: 30000,
        retainOnError: true
      }, async () => {
        throw new Error("retained run failure");
      });
    } catch (error) {
      retainedError = error;
    }
    assertEqual(retainedError?.message, "retained run failure", "retained target preserves original error");
    assertEqual(await fileExists(removeLog), false, "retention flags keep target runtime after exception");

    let partialRetainedError;
    try {
      await runWithTargetRuntimeCleanup(targetPlan, {
        execute: true,
        timeoutMs: 30000,
        retainOnError: false
      }, async (onRecord) => {
        onRecord({ cleanup: "retained" });
        throw new Error("failure after retained record");
      });
    } catch (error) {
      partialRetainedError = error;
    }
    assertEqual(
      partialRetainedError?.message,
      "failure after retained record",
      "partial retained record preserves original error"
    );
    assertEqual(await fileExists(removeLog), false, "partial retained record keeps target runtime");

    process.env.KOVA_MOCK_REMOVE_FAIL = "1";
    let combinedError;
    try {
      await runWithTargetRuntimeCleanup(targetPlan, {
        execute: true,
        timeoutMs: 30000,
        retainOnError: false
      }, async () => {
        throw new Error("primary run failure");
      });
    } catch (error) {
      combinedError = error;
    }
    assertEqual(combinedError instanceof AggregateError, true, "run and cleanup failures are aggregated");
    assertEqual(
      combinedError?.message,
      "primary run failure; target runtime cleanup also failed: runtime removal failed",
      "combined failure names the primary and cleanup errors"
    );
    assertEqual(combinedError?.errors?.[0]?.message, "primary run failure", "aggregate preserves primary error");
    assertEqual(combinedError?.errors?.[1]?.message, "runtime removal failed", "aggregate exposes cleanup error");

    return {
      id: "local-build-runtime-exception-cleanup",
      status: "PASS",
      command: "exercise exception-safe target runtime cleanup",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "local-build-runtime-exception-cleanup",
      status: "FAIL",
      command: "exercise exception-safe target runtime cleanup",
      durationMs: 0,
      message: error.message
    };
  } finally {
    process.env.PATH = previousPath;
    if (previousLog === undefined) {
      delete process.env.KOVA_MOCK_REMOVE_LOG;
    } else {
      process.env.KOVA_MOCK_REMOVE_LOG = previousLog;
    }
    if (previousRemoveFail === undefined) {
      delete process.env.KOVA_MOCK_REMOVE_FAIL;
    } else {
      process.env.KOVA_MOCK_REMOVE_FAIL = previousRemoveFail;
    }
  }
}

export async function localBuildProfileEnvCheck(tmp, scope) {
  const binDir = join(tmp, "mock-bin-local-build-profile");
  const buildProfileLog = join(tmp, "mock-local-build-profile.log");
  await mkdir(binDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s' "$OPENCLAW_OCM_RUNTIME_BUILD_PROFILE" > "$KOVA_MOCK_BUILD_PROFILE_LOG"
echo '{"ok":true}'
`, "utf8");
  await chmod(ocmPath, 0o755);

  try {
    const results = await executeTargetSetup({
      targetPlan: {
        kind: "local-build",
        runtimeName: scope.runtimeName,
        repoPath: "/tmp/openclaw"
      },
      profile: {
        localBuildProfile: "sourcePerformance"
      },
      timeoutMs: 30000,
      resourceSampling: false,
      commandEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        KOVA_MOCK_BUILD_PROFILE_LOG: buildProfileLog
      },
      targetSetup: { completed: false, failed: false, results: [], inFlight: null }
    }, scope.envName, tmp);
    assertEqual(results.length, 1, "local build profile target setup result count");
    assertEqual(results[0]?.status, 0, "local build profile target setup status");
    assertEqual(
      await readFile(buildProfileLog, "utf8"),
      "sourcePerformance",
      "local build profile forwarded to OCM"
    );
    return {
      id: "local-build-profile-env",
      status: "PASS",
      command: "execute target setup with diagnostic local build profile",
      durationMs: results[0]?.durationMs ?? 0
    };
  } catch (error) {
    return {
      id: "local-build-profile-env",
      status: "FAIL",
      command: "execute target setup with diagnostic local build profile",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function localBuildParallelSingleFlightCheck(tmp) {
  const binDir = join(tmp, "mock-bin-parallel-local-build");
  const repoDir = join(tmp, "mock-openclaw parallel local build");
  const reportDir = join(tmp, "local-build-parallel-report");
  const ocmLog = join(tmp, "mock-ocm-parallel.log");
  const buildActive = join(tmp, "mock-ocm-build-active");
  const buildOverlap = join(tmp, "mock-ocm-build-overlap");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local)
    if [ -f "$KOVA_MOCK_BUILD_ACTIVE" ]; then
      : > "$KOVA_MOCK_BUILD_OVERLAP"
    fi
    : > "$KOVA_MOCK_BUILD_ACTIVE"
    sleep 1
    rm -f "$KOVA_MOCK_BUILD_ACTIVE"
    echo '{"ok":true}'
    exit 0
    ;;
  runtime:remove) echo '{"removed":true}'; exit 0 ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped","runDir":"/tmp/kova-mock"}'; exit 0 ;;
  service:install|service:start|service:restart|service:stop) echo '{"ok":true}'; exit 0 ;;
  env:exec) exit 0 ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*) echo 'ok'; exit 0 ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs matrix run --profile smoke --target local-build:${quoteShell(repoDir)} --include scenario:fresh-install,scenario:bundled-runtime-deps,scenario:bundled-plugin-startup --parallel 3 --auth skip --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog,
      KOVA_MOCK_BUILD_ACTIVE: buildActive,
      KOVA_MOCK_BUILD_OVERLAP: buildOverlap
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.controls?.requestedParallel, 3, "local-build requested parallelism");
    assertEqual(report.controls?.parallel, 3, "local-build effective parallelism");
    assertEqual(report.controls?.parallelAdjusted, false, "local-build parallelism is not adjusted");
    assertEqual(
      log.split("\n").filter((line) => line.startsWith("runtime build-local ")).length,
      1,
      "parallel local-build target setup executes once per matrix"
    );
    assertEqual(
      report.records?.filter((record) => record.phases?.some((phase) => phase.id === "target-setup")).length,
      1,
      "parallel local-build target setup is recorded once"
    );
    let overlapDetected = true;
    try {
      await stat(buildOverlap);
    } catch {
      overlapDetected = false;
    }
    assertEqual(overlapDetected, false, "parallel local-build target setup does not overlap");
    return {
      id: "local-build-parallel-single-flight",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-parallel-single-flight",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}
