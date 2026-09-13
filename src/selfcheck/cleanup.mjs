import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCleanupCommand } from "../cleanup.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
import { assertEqual, fileExists } from "./harness.mjs";

export async function cleanupArtifactsCheck(tmp) {
  const home = join(tmp, "artifact-cleanup-home");
  const staleDir = join(home, "artifacts", "kova-2000-01-01t000000z");
  const keepDir = join(home, "artifacts", "not-a-kova-run");
  await mkdir(staleDir, { recursive: true });
  await mkdir(keepDir, { recursive: true });
  await writeFile(join(staleDir, "sample.txt"), "stale artifact\n", "utf8");
  const oldDate = new Date("2000-01-01T00:00:00.000Z");
  await utimes(staleDir, oldDate, oldDate);

  const dryRun = await runCommand(
    `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs cleanup artifacts --older-than-days 1 --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  if (dryRun.status !== 0) {
    return {
      id: "cleanup-artifacts",
      status: "FAIL",
      command: dryRun.command,
      durationMs: dryRun.durationMs,
      message: dryRun.stderr.trim() || dryRun.stdout.trim()
    };
  }
  const dryRunJson = JSON.parse(dryRun.stdout);
  assertEqual(dryRunJson.schemaVersion, "kova.cleanup.artifacts.v1", "cleanup artifacts schema");
  assertEqual(dryRunJson.execute, false, "cleanup artifacts dry-run");
  assertEqual(dryRunJson.candidates.length, 1, "cleanup artifacts candidate count");
  assertEqual(dryRunJson.candidates[0].name, "kova-2000-01-01t000000z", "cleanup artifacts candidate name");

  const execute = await runCommand(
    `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs cleanup artifacts --older-than-days 1 --execute --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  if (execute.status !== 0) {
    return {
      id: "cleanup-artifacts",
      status: "FAIL",
      command: execute.command,
      durationMs: execute.durationMs,
      message: execute.stderr.trim() || execute.stdout.trim()
    };
  }
  const executeJson = JSON.parse(execute.stdout);
  assertEqual(executeJson.execute, true, "cleanup artifacts execute");
  assertEqual(executeJson.results.length, 1, "cleanup artifacts result count");
  let staleStillExists = true;
  try {
    await stat(staleDir);
  } catch (error) {
    staleStillExists = error.code !== "ENOENT";
  }
  assertEqual(staleStillExists, false, "stale artifact directory removed");
  assertEqual((await stat(keepDir)).isDirectory(), true, "non-kova artifact directory retained");

  return {
    id: "cleanup-artifacts",
    status: "PASS",
    command: "node bin/kova.mjs cleanup artifacts --older-than-days 1 --execute --json",
    durationMs: dryRun.durationMs + execute.durationMs
  };
}

export async function cleanupRetryCheck(tmp) {
  const counterPath = join(tmp, "cleanup-retry-count");
  const command = `node -e 'const fs=require("fs"); const p=${JSON.stringify(counterPath)}; const n=Number(fs.existsSync(p)?fs.readFileSync(p,"utf8"):0)+1; fs.writeFileSync(p,String(n)); if(n<2){console.error("gateway still shutting down"); process.exit(1)} console.log("destroyed")'`;
  const result = await runCleanupCommand(command, {
    timeoutMs: 30000,
    retryDelaysMs: [0, 0, 0]
  });
  try {
    assertEqual(result.status, 0, "cleanup retry final status");
    assertEqual(result.attempts?.length, 2, "cleanup retry attempts");
    assertEqual(result.attempts?.[0]?.status, 1, "first cleanup attempt failed");
    assertEqual(result.attempts?.[1]?.status, 0, "second cleanup attempt passed");
    return {
      id: "cleanup-retry-contract",
      status: "PASS",
      command: "evaluate retryable cleanup command",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "cleanup-retry-contract",
      status: "FAIL",
      command: "evaluate retryable cleanup command",
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function cleanupEnvSafetyCheck(tmp) {
  const home = join(tmp, "cleanup-env-safety-home");
  const binDir = join(tmp, "cleanup-env-safety-bin");
  const reports = join(home, "reports");
  const destroyLog = join(tmp, "cleanup-env-destroy.log");
  const recentMarker = join(tmp, "cleanup-env-recent.marker");
  const retentionReport = join(reports, "late-retained.json");
  const ocmPath = join(binDir, "ocm");
  const old = "2020-01-01T00:00:00Z";
  const recent = new Date().toISOString();
  await mkdir(reports, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(reports, "retained.json"), `${JSON.stringify({
    records: [{ envName: "kova-retained", cleanup: "retained" }]
  })}\n`, "utf8");
  await writeFile(ocmPath, `#!/bin/sh
case "$1:$2:$3" in
  env:list:--json)
    if [ "$KOVA_INVALID_ENV_INVENTORY" = "1" ]; then
      echo '[{"name":"kova-stale","createdAt":"${old}","lastUsedAt":null}]'
      exit 0
    fi
    stale_last_used=null
    if [ -n "$KOVA_RECENT_MARKER" ] && [ -f "$KOVA_RECENT_MARKER" ]; then
      stale_last_used='"${recent}"'
    fi
    cat <<JSON
[
  {"name":"kova-stale","createdAt":"${old}","lastUsedAt":$stale_last_used,"protected":false},
  {"name":"kova-recent","createdAt":"${recent}","lastUsedAt":"${recent}","protected":false},
  {"name":"kova-protected","createdAt":"${old}","lastUsedAt":null,"protected":true},
  {"name":"kova-retained","createdAt":"${old}","lastUsedAt":null,"protected":false},
  {"name":"kova-active","createdAt":"${old}","lastUsedAt":null,"protected":false},
  {"name":"kova-issue","createdAt":"${old}","lastUsedAt":null,"protected":false},
  {"name":"kova-unknown","createdAt":"${old}","lastUsedAt":null,"protected":false},
  {"name":"durable-user-env","createdAt":"${old}","lastUsedAt":null,"protected":false}
]
JSON
    exit 0
    ;;
  service:status:--all)
    if [ "$KOVA_INVALID_SERVICE_INVENTORY" = "1" ]; then
      echo '{"services":[{"envName":"kova-stale","gatewayState":"stopped"}]}'
      exit 0
    fi
    cat <<'JSON'
{"services":[
  {"envName":"kova-stale","installed":false,"desiredRunning":false,"running":false,"gatewayState":"stopped","childPid":null},
  {"envName":"kova-recent","installed":false,"desiredRunning":false,"running":false,"gatewayState":"stopped","childPid":null},
  {"envName":"kova-protected","installed":false,"desiredRunning":false,"running":false,"gatewayState":"stopped","childPid":null},
  {"envName":"kova-retained","installed":false,"desiredRunning":false,"running":false,"gatewayState":"stopped","childPid":null},
  {"envName":"kova-active","installed":true,"desiredRunning":true,"running":true,"gatewayState":"healthy","childPid":123},
  {"envName":"kova-issue","installed":false,"desiredRunning":false,"running":false,"gatewayState":"stopped","childPid":null,"issue":"status incomplete"}
]}
JSON
    exit 0
    ;;
  env:destroy:*)
    if [ "$4" = "--json" ] && [ -z "$5" ]; then
      if [ "$KOVA_REVALIDATE_RECENT" = "1" ]; then
        : > "$KOVA_RECENT_MARKER"
      fi
      if [ "$KOVA_REVALIDATE_RETAINED" = "1" ]; then
        printf '{"records":[{"envName":"%s","cleanup":"retained"}]}\\n' "$3" > "$KOVA_RETENTION_REPORT"
      fi
      if [ "$KOVA_PREVIEW_MALFORMED" = "1" ]; then
        printf '{"stateToken":"v1:%s","serviceInstalled":true,"serviceLoaded":false,"serviceRunning":false,"processCount":0,"blockers":[],"steps":[null]}\\n' "$3"
        exit 0
      fi
      if [ "$KOVA_PREVIEW_ACTIVE" = "1" ]; then
        printf '{"stateToken":"v1:%s","serviceInstalled":true,"serviceLoaded":true,"serviceRunning":true,"processCount":1,"blockers":[],"steps":[{"kind":"service","description":"disable service"},{"kind":"processes","description":"terminate processes"}]}\\n' "$3"
      else
        printf '{"stateToken":"v1:%s","serviceInstalled":true,"serviceLoaded":false,"serviceRunning":false,"processCount":0,"blockers":[],"steps":[{"kind":"service","description":"disable service"}]}\\n' "$3"
      fi
      exit 0
    fi
    if [ "$KOVA_TOKEN_MISMATCH" = "1" ]; then
      printf '{"code":"state_changed","removed":false,"stateToken":"test-token-placeholder"}\\n'
      exit 1
    fi
    if [ "$KOVA_PARTIAL_APPLY" = "1" ]; then
      printf '%s\\n' "$3" >> "$KOVA_DESTROY_LOG"
      printf '{"code":"partial_apply","removed":false,"serviceUninstalled":true,"processesTerminated":0,"stateToken":"v1:%s"}\\n' "$3"
      exit 1
    fi
    printf '%s\\n' "$3" >> "$KOVA_DESTROY_LOG"
    echo '{"destroyed":true}'
    exit 0
    ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    KOVA_HOME: home,
    KOVA_DESTROY_LOG: destroyLog,
    KOVA_RECENT_MARKER: recentMarker,
    KOVA_RETENTION_REPORT: retentionReport
  };
  const run = (args, envOverrides = {}) => runCommand(`node bin/kova.mjs cleanup envs ${args} --json`, {
    env: { ...env, ...envOverrides },
    timeoutMs: 30000,
    maxOutputChars: 1000000
  });

  try {
    const dry = await run("");
    assertEqual(dry.status, 0, "cleanup safety dry-run exit");
    const plan = JSON.parse(dry.stdout);
    assertEqual(plan.candidates.join(","), "kova-stale", "only inactive stale env eligible");
    assertEqual(plan.envs.every((item) => typeof item === "string"), true, "cleanup v1 envs remain names");
    assertEqual(plan.classifications.find((item) => item.name === "kova-recent")?.reasons.includes("too-recent"), true, "recent env skipped");
    assertEqual(plan.classifications.find((item) => item.name === "kova-protected")?.reasons.includes("protected"), true, "protected env skipped");
    assertEqual(plan.classifications.find((item) => item.name === "kova-retained")?.reasons.includes("retained-by-run"), true, "retained env skipped");
    assertEqual(plan.classifications.find((item) => item.name === "kova-active")?.reasons.includes("active-service"), true, "active env skipped");
    assertEqual(plan.classifications.find((item) => item.name === "kova-issue")?.reasons.includes("unknown-service-state"), true, "service issue env skipped");
    assertEqual(plan.classifications.find((item) => item.name === "kova-unknown")?.reasons.includes("unknown-service-state"), true, "unknown service env skipped");

    const malformedReport = join(reports, "malformed.json");
    await writeFile(malformedReport, "{not-json\n", "utf8");
    const unknownRetention = await run("");
    assertEqual(unknownRetention.status, 0, "unknown retention dry-run exit");
    const unknownRetentionPlan = JSON.parse(unknownRetention.stdout);
    assertEqual(unknownRetentionPlan.retentionInventory?.ok, false, "malformed report fails retention inventory");
    assertEqual(unknownRetentionPlan.candidates.length, 0, "unknown retention state blocks cleanup");
    assertEqual(
      unknownRetentionPlan.classifications.every((item) => item.reasons.includes("unknown-retention-state")),
      true,
      "unknown retention state is recorded for every env"
    );
    const unknownRetentionExecute = await run("--execute");
    assertEqual(unknownRetentionExecute.status !== 0, true, "unknown retention execute exits nonzero");
    assertEqual(JSON.parse(unknownRetentionExecute.stdout).results.length, 0, "unknown retention executes no destroys");
    assertEqual(await fileExists(destroyLog), false, "unknown retention execute performs no teardown");
    await rm(malformedReport);

    const invalidShapeReport = join(reports, "invalid-shape.json");
    await writeFile(invalidShapeReport, '{"records":"retained"}\n', "utf8");
    const invalidShapeRetention = await run("");
    assertEqual(invalidShapeRetention.status, 0, "invalid retention shape dry-run exit");
    const invalidShapePlan = JSON.parse(invalidShapeRetention.stdout);
    assertEqual(invalidShapePlan.retentionInventory?.ok, false, "invalid report shape fails retention inventory");
    assertEqual(invalidShapePlan.candidates.length, 0, "invalid retention shape blocks cleanup");
    await rm(invalidShapeReport);

    const invalidServiceInventory = await run("", { KOVA_INVALID_SERVICE_INVENTORY: "1" });
    assertEqual(invalidServiceInventory.status, 0, "invalid service inventory dry-run exit");
    const invalidServicePlan = JSON.parse(invalidServiceInventory.stdout);
    assertEqual(invalidServicePlan.serviceInventory?.ok, false, "invalid service shape fails inventory");
    assertEqual(invalidServicePlan.candidates.length, 0, "invalid service shape blocks cleanup");
    const invalidServiceExecute = await run("--execute", { KOVA_INVALID_SERVICE_INVENTORY: "1" });
    assertEqual(invalidServiceExecute.status !== 0, true, "invalid service execute exits nonzero");
    assertEqual(JSON.parse(invalidServiceExecute.stdout).results.length, 0, "invalid service executes no destroys");
    assertEqual(await fileExists(destroyLog), false, "invalid service execute performs no teardown");
    const forcedInvalidService = await run("--execute --force", {
      KOVA_INVALID_SERVICE_INVENTORY: "1"
    });
    assertEqual(forcedInvalidService.status, 0, "force overrides invalid service inventory");
    assertEqual(
      JSON.parse(forcedInvalidService.stdout).results.length,
      7,
      "forced invalid service inventory destroys every Kova env"
    );
    await rm(destroyLog, { force: true });

    const invalidEnvInventory = await run("", { KOVA_INVALID_ENV_INVENTORY: "1" });
    assertEqual(invalidEnvInventory.status !== 0, true, "invalid env inventory exits nonzero");
    assertEqual(
      `${invalidEnvInventory.stdout}\n${invalidEnvInventory.stderr}`.includes("missing protected state"),
      true,
      "invalid env protection state is rejected"
    );

    const falseExecute = await run("--execute=false");
    assertEqual(falseExecute.status, 0, "non-boolean execute exit");
    assertEqual(JSON.parse(falseExecute.stdout).execute, false, "execute string does not authorize cleanup");
    assertEqual(await fileExists(destroyLog), false, "execute string did not destroy envs");

    const stateChanged = await run("--execute", { KOVA_TOKEN_MISMATCH: "1" });
    assertEqual(stateChanged.status !== 0, true, "state-changed cleanup receipt exit");
    const stateChangedReceipt = JSON.parse(stateChanged.stdout);
    assertEqual(stateChangedReceipt.results[0]?.status, 1, "state token mismatch blocks destroy");
    assertEqual(stateChangedReceipt.results[0]?.stage, "destroy", "state token mismatch occurs at guarded destroy");
    assertEqual(
      stateChangedReceipt.results[0]?.command.includes("--if-state-token 'v1:kova-stale'"),
      true,
      "cleanup applies the preview state token"
    );
    assertEqual(await fileExists(destroyLog), false, "state token mismatch performs no teardown");

    const activePreview = await run("--execute", { KOVA_PREVIEW_ACTIVE: "1" });
    assertEqual(activePreview.status !== 0, true, "active preview cleanup receipt exit");
    const activePreviewReceipt = JSON.parse(activePreview.stdout);
    assertEqual(activePreviewReceipt.results[0]?.status, 1, "active destroy preview blocks destroy");
    assertEqual(activePreviewReceipt.results[0]?.stage, "precondition", "active preview fails precondition");
    assertEqual(await fileExists(destroyLog), false, "active preview performs no teardown");

    const malformedPreview = await run("--execute", { KOVA_PREVIEW_MALFORMED: "1" });
    assertEqual(malformedPreview.status !== 0, true, "malformed preview cleanup receipt exit");
    const malformedPreviewReceipt = JSON.parse(malformedPreview.stdout);
    assertEqual(malformedPreviewReceipt.results[0]?.code, "unsafe_preview", "malformed preview is unsafe");
    assertEqual(malformedPreviewReceipt.results[0]?.stage, "precondition", "malformed preview stops before apply");
    assertEqual(await fileExists(destroyLog), false, "malformed preview performs no teardown");

    const recentlyUsed = await run("--execute", { KOVA_REVALIDATE_RECENT: "1" });
    assertEqual(recentlyUsed.status !== 0, true, "recent eligibility refresh exits nonzero");
    const recentlyUsedReceipt = JSON.parse(recentlyUsed.stdout);
    assertEqual(recentlyUsedReceipt.results[0]?.code, "eligibility_changed", "recent env fails refreshed eligibility");
    assertEqual(recentlyUsedReceipt.results[0]?.stage, "precondition", "recent env stops before guarded destroy");
    assertEqual(await fileExists(destroyLog), false, "recent eligibility refresh performs no teardown");
    await rm(recentMarker, { force: true });

    const newlyRetained = await run("--execute", { KOVA_REVALIDATE_RETAINED: "1" });
    assertEqual(newlyRetained.status !== 0, true, "retention refresh exits nonzero");
    const newlyRetainedReceipt = JSON.parse(newlyRetained.stdout);
    assertEqual(newlyRetainedReceipt.results[0]?.code, "eligibility_changed", "new retention fails refreshed eligibility");
    assertEqual(await fileExists(destroyLog), false, "retention refresh performs no teardown");
    await rm(retentionReport, { force: true });

    const partialApply = await run("--execute", { KOVA_PARTIAL_APPLY: "1" });
    assertEqual(partialApply.status !== 0, true, "partial apply exits nonzero");
    const partialApplyReceipt = JSON.parse(partialApply.stdout);
    assertEqual(partialApplyReceipt.results[0]?.code, "partial_apply", "partial apply code preserved");
    assertEqual(partialApplyReceipt.results[0]?.stage, "partial-apply", "partial apply has distinct stage");
    assertEqual(partialApplyReceipt.results[0]?.attempts?.length, 1, "partial apply is not retried");
    assertEqual((await readFile(destroyLog, "utf8")).trim(), "kova-stale", "partial apply executes once");
    await rm(destroyLog, { force: true });

    const forcedPartialApply = await run("--execute --force", { KOVA_PARTIAL_APPLY: "1" });
    assertEqual(forcedPartialApply.status !== 0, true, "forced partial apply exits nonzero");
    const forcedPartialReceipt = JSON.parse(forcedPartialApply.stdout);
    assertEqual(
      forcedPartialReceipt.results.every((result) =>
        result.code === "partial_apply" &&
        result.stage === "partial-apply" &&
        result.attempts?.length === 1
      ),
      true,
      "forced partial apply is structured and never retried"
    );
    await rm(destroyLog, { force: true });

    const execute = await run("--execute");
    assertEqual(execute.status, 0, "cleanup safety execute exit");
    assertEqual((await readFile(destroyLog, "utf8")).trim(), "kova-stale", "default cleanup destroys only eligible env");

    await rm(destroyLog, { force: true });
    const forced = await run("--execute --force");
    assertEqual(forced.status, 0, "forced cleanup exit");
    const forcedReceipt = JSON.parse(forced.stdout);
    assertEqual(forcedReceipt.candidates.length, 7, "force overrides cleanup safeguards");
    assertEqual(
      forcedReceipt.results.every((result) => result.command.endsWith("--yes --force")),
      true,
      "force is forwarded to OCM destroy"
    );
    assertEqual((await readFile(destroyLog, "utf8")).trim().split("\n").length, 7, "force destroys every Kova env");

    return {
      id: "cleanup-env-safety",
      status: "PASS",
      command: "exercise cleanup env eligibility, execute guard, and force override",
      durationMs: dry.durationMs + unknownRetention.durationMs +
        unknownRetentionExecute.durationMs + invalidShapeRetention.durationMs +
        invalidServiceInventory.durationMs + invalidServiceExecute.durationMs +
        forcedInvalidService.durationMs + invalidEnvInventory.durationMs + falseExecute.durationMs +
        stateChanged.durationMs + activePreview.durationMs + recentlyUsed.durationMs +
        malformedPreview.durationMs + newlyRetained.durationMs +
        partialApply.durationMs + forcedPartialApply.durationMs +
        execute.durationMs + forced.durationMs
    };
  } catch (error) {
    return {
      id: "cleanup-env-safety",
      status: "FAIL",
      command: "exercise cleanup env eligibility, execute guard, and force override",
      durationMs: 0,
      message: error.message
    };
  }
}
