import { authReportSummary, resolveRunAuthContext } from "../auth.mjs";
import { resolveFromCwd } from "../cli.mjs";
import { buildRunContext } from "../run/context.mjs";
import {
  loadRegressionThresholds,
  positiveIntegerFlag,
  positiveIntegerValue,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "../run/options.mjs";
import { cleanupTargetRuntimeIfNeeded } from "../run/target-cleanup.mjs";
import { evaluateGate, preflightGateRun } from "../matrix/gate.mjs";
import { resolveMatrixPlan, validateMatrixScenarioRuns } from "../matrix/plan-resolution.mjs";
import { profileSummary } from "../matrix/profile.mjs";
import {
  loadBaselineStore,
  resolveBaselinePath,
} from "../performance/baselines.mjs";
import { buildPerformanceSummary } from "../performance/stats.mjs";
import { reportsDir, displayPath } from "../paths.mjs";
import { networkFrontageControls, summarizeNetworkFrontage } from "../network-frontage.mjs";
import { bundleReport, retainGateArtifacts } from "../reporting/artifacts.mjs";
import { runEntries, runScenarioRepeats } from "../run/engine.mjs";
import { allocateReportOutputPaths, releaseReportOutputLock, writeReportOutputs } from "../run/report-output.mjs";
import { attachBaselineComparison, buildRunReport, saveBaselineUpdate } from "../run/report-finalization.mjs";
import { createRunProgress } from "../reporting/render-run-progress.mjs";
import { renderMatrixRunReceipt } from "../reporting/render-run-receipt.mjs";

export async function runMatrixRun(flags) {
  validateBaselineExecutionFlags(flags);
  const {
    registry,
    profile,
    target,
    targetPlan,
    fromPlan,
    platform,
    entries,
    resolvedCoverage,
    controls
  } = await resolveMatrixPlan(flags, {
    validateProfile: validateProfileExecutionFlags,
    validateEntries: false
  });
  const auth = await resolveRunAuthContext(flags);
  const targetSelector = targetPlan.selector ?? target;
  const fromSelector = fromPlan?.selector ?? flags.from ?? null;
  const regressionThresholds = await loadRegressionThresholds(flags);
  const networkFrontage = networkFrontageControls(flags);
  validateNetworkFrontageParallelism(networkFrontage, controls);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  preflightGateRun({ entries, flags });
  validateMatrixScenarioRuns(entries, flags, { targetPlan, fromPlan });
  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const { runId, outputPaths, lockPath } = await allocateReportOutputPaths(reportRoot, profile.id);
  try {
  const targetSetup = { completed: false, failed: false, results: [], inFlight: null };
  const progress = createRunProgress({ flags, mode: flags.execute === true ? "execution" : "dry-run" });
  progress.runStart({
    scenarioCount: entries.length * (controls.repeat ?? 1),
    mode: flags.execute === true ? "execution" : "dry-run",
    target: targetSelector,
    profile: profile.id,
  });
  const runEntry = async (entry) => {
    const context = buildRunContext({
      flags,
      registry,
      target: targetSelector,
      targetPlan,
      profile,
      fromPlan,
      from: fromSelector,
      state: entry.state,
      runId,
      controls: {
        ...controls,
        networkFrontage
      },
      auth,
      targetSetup,
      timeoutMs: resolveEntryTimeout(entry, flags)
    });

    return runScenarioRepeats({
      scenario: entry.scenario,
      context,
      repeat: controls.repeat,
      progress,
      skipReason: entry.skipReason
    });
  };

  const records = await runEntries({
    entries,
    runEntry,
    execute: flags.execute === true,
    controls
  });
  const targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
    execute: flags.execute === true,
    timeoutMs: positiveIntegerFlag(flags, "timeout_ms", 120000)
  });
  const performance = buildPerformanceSummary(records, {
    repeat: controls.repeat,
    parallel: controls.parallel,
    regressionThresholds
  });
  const reportBase = buildRunReport({
    runId,
    outputPaths,
    mode: flags.execute === true ? "execution" : "dry-run",
    profile: profileSummary(profile),
    target: targetSelector,
    from: fromSelector,
    controls: {
      ...controls,
      networkFrontage
    },
    auth: authReportSummary(auth),
    state: null,
    platform,
    targetCleanup,
    networkFrontage: summarizeNetworkFrontage(records, networkFrontage),
    performance,
    gate: null,
    records
  });
  attachBaselineComparison(reportBase, baselineStore, { baselinePath, targetPlan, regressionThresholds });
  const gate = flags.gate === true
    ? evaluateGate({
      mode: flags.execute === true ? "execution" : "dry-run",
      controls,
      performance,
      baseline: reportBase.baseline,
      platform: reportBase.platform,
      records
    }, profile, { resolvedCoverage })
    : null;

  const report = {
    ...reportBase,
    gate
  };
  await saveBaselineUpdate(report, {
    saveBaselinePath,
    targetPlan,
    reviewedGood: flags.reviewed_good === true
  });
  await writeReportOutputs(reportRoot, report);
  const bundle = await bundleReport(outputPaths.json, { outputDir: reportRoot });
  const retainedGateArtifacts = gate && gate.verdict !== "SHIP"
    ? await retainFailedGateArtifacts(report, reportRoot, bundle)
    : null;

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.matrix.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode: report.mode,
      runId,
      profile: profileSummary(profile),
      reportPath: outputPaths.markdown,
      jsonPath: outputPaths.json,
      summaryPath: outputPaths.summary,
      bundlePath: bundle.outputPath,
      checksumPath: bundle.checksumPath,
      retainedGateArtifacts,
      gate: summarizeGateReceipt(gate),
      networkFrontage: report.networkFrontage,
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    failGateIfNeeded(gate);
    return;
  }

  progress.runFinish({ total: report.summary?.total ?? 0, statuses: report.summary?.statuses ?? {} });

  if (!flags.plain) {
    console.log(renderMatrixRunReceipt({
      report,
      reportPath: outputPaths.markdown,
      jsonPath: outputPaths.json,
      summaryPath: outputPaths.summary,
      bundlePath: bundle.outputPath,
      retainedGateArtifacts,
    }, flags));
    failGateIfNeeded(gate);
    return;
  }

  console.log(`Kova matrix ${report.mode} report written: ${displayPath(outputPaths.markdown)}`);
  console.log(`Kova matrix ${report.mode} data written: ${displayPath(outputPaths.json)}`);
  console.log(`Kova matrix bundle written: ${displayPath(bundle.outputPath)}`);
  if (retainedGateArtifacts) {
    console.log(`Kova failed gate artifacts retained: ${displayPath(retainedGateArtifacts.outputDir)}`);
  }
  if (gate) {
    console.log(`Kova gate outcome: ${gate.outcome ?? gate.verdict}`);
  }
  failGateIfNeeded(gate);
  } finally {
    await releaseReportOutputLock(lockPath);
  }
}

function validateProfileExecutionFlags(profile, flags) {
  if (flags.execute === true && profile.id === "exhaustive" && flags.allow_exhaustive !== true) {
    throw new Error("executing profile 'exhaustive' requires --allow-exhaustive");
  }
}

function validateNetworkFrontageParallelism(networkFrontage, controls) {
  if (networkFrontage.enabled && (controls.parallel ?? 1) > 1) {
    throw new Error("--network-frontage loopback cannot be combined with matrix --parallel > 1; run sequentially or use separate workers with distinct --worker-id values");
  }
}

async function retainFailedGateArtifacts(report, reportRoot, bundle) {
  report.retainedGateArtifacts = {
    status: "pending"
  };
  await writeReportOutputs(reportRoot, report);
  const retained = await retainGateArtifacts(report.outputPaths.json, bundle);
  report.retainedGateArtifacts = retained;
  await writeReportOutputs(reportRoot, report);
  await retainGateArtifacts(report.outputPaths.json, bundle, { outputDir: retained.outputDir });
  return retained;
}

function resolveEntryTimeout(entry, flags) {
  return positiveIntegerValue(flags.timeout_ms ?? entry.timeoutMs ?? entry.scenario.timeoutMs ?? 120000, "--timeout-ms");
}

function failGateIfNeeded(gate) {
  if (gate && gate.verdict !== "SHIP") {
    process.exitCode = 1;
  }
}

function summarizeGateReceipt(gate) {
  if (!gate) {
    return null;
  }
  return {
    schemaVersion: gate.schemaVersion,
    enabled: gate.enabled,
    profileId: gate.profileId,
    policyId: gate.policyId,
    purpose: gate.purpose ?? null,
    verdict: gate.verdict,
    outcome: gate.outcome ?? null,
    ok: gate.ok,
    complete: gate.complete,
    partial: gate.partial,
    missingRequiredCount: gate.missingRequiredCount,
    blockingCount: gate.blockingCount,
    warningCount: gate.warningCount,
    infoCount: gate.infoCount,
    subsystemCount: gate.subsystems?.length ?? 0,
    fixerSummaryCount: gate.fixerSummaries?.length ?? 0,
    baselineRegressionCount: gate.baseline?.regressionCount ?? null,
    missingBaselineCount: gate.baseline?.missingBaselineCount ?? null,
    skippedMetricCount: gate.baseline?.skippedMetricCount ?? null,
    resourceMeasurementScope: gate.baseline?.resourceMeasurementScope ?? null,
    resourceHeadlineContract: gate.baseline?.resourceHeadlineContract ?? null,
    resourceContractMismatchCount: gate.baseline?.resourceContractMismatchCount ?? null
  };
}
