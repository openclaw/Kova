import { authReportSummary, resolveRunAuthContext } from "../auth.mjs";
import { required, resolveFromCwd } from "../cli.mjs";
import { buildRunContext } from "../run/context.mjs";
import {
  loadRegressionThresholds,
  positiveIntegerFlag,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "../run/options.mjs";
import { runWithTargetRuntimeCleanup } from "../run/target-cleanup.mjs";
import {
  loadBaselineStore,
  resolveBaselinePath,
} from "../performance/baselines.mjs";
import { buildPerformanceSummary } from "../performance/stats.mjs";
import { reportsDir, displayPath } from "../paths.mjs";
import { networkFrontageControls, summarizeNetworkFrontage } from "../network-frontage.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadScenarios, validateScenarioRun } from "../registries/scenarios.mjs";
import { loadState } from "../registries/states.mjs";
import { runScenarioRepeats } from "../run/engine.mjs";
import { allocateReportOutputPaths, releaseReportOutputLock, writeReportOutputs } from "../run/report-output.mjs";
import { attachBaselineComparison, buildRunReport, saveBaselineUpdate } from "../run/report-finalization.mjs";
import { resolveTarget } from "../targets.mjs";
import { createRunProgress } from "../reporting/render-run-progress.mjs";
import { renderRunReceipt } from "../reporting/render-run-receipt.mjs";

export async function runScenarioCommand(flags) {
  const registry = await loadRegistryContext();
  const target = required(flags.target, "--target");
  if (flags.execute === true && !flags.scenario) {
    throw new Error("--execute requires --scenario so real runs stay deliberate");
  }
  validateBaselineExecutionFlags(flags);

  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const targetSelector = targetPlan.selector ?? target;
  const fromSelector = fromPlan?.selector ?? flags.from ?? null;
  const state = await loadState(flags.state ?? "fresh");
  const scenarios = await loadScenarios(flags.scenario);
  for (const scenario of scenarios) {
    validateExplicitScenarioState(scenario, state, flags);
    validateScenarioRun(scenario, flags, { targetPlan, fromPlan });
  }

  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const { runId, outputPaths, lockPath } = await allocateReportOutputPaths(reportRoot);
  try {
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const networkFrontage = networkFrontageControls(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  const context = buildRunContext({
    flags,
    registry,
    target: targetSelector,
    targetPlan,
    fromPlan,
    from: fromSelector,
    state,
    runId,
    auth,
    controls: { networkFrontage },
    timeoutMs: resolveRunTimeout(scenarios, flags)
  });
  const progress = createRunProgress({ flags, mode: context.execute ? "execution" : "dry-run" });
  progress.runStart({
    scenarioCount: scenarios.length * repeat,
    mode: context.execute ? "execution" : "dry-run",
    target: targetSelector,
  });

  const { records, targetCleanup } = await runWithTargetRuntimeCleanup(targetPlan, {
    execute: context.execute,
    timeoutMs: context.timeoutMs,
    retainOnError: context.keepEnv || context.retainOnFailure
  }, async (onRecord) => {
    const runRecords = [];
    for (const scenario of scenarios) {
      runRecords.push(...await runScenarioRepeats({
        scenario,
        context,
        repeat,
        progress,
        onRecord
      }));
    }
    return runRecords;
  });
  const performance = buildPerformanceSummary(records, { repeat, regressionThresholds });

  const report = buildRunReport({
    runId,
    outputPaths,
    mode: context.execute ? "execution" : "dry-run",
    target: targetSelector,
    from: fromSelector,
    state: {
      id: state.id,
      title: state.title,
      objective: state.objective
    },
    targetCleanup,
    auth: authReportSummary(auth),
    controls: {
      repeat,
      baseline: baselinePath,
      saveBaseline: saveBaselinePath,
      auth: auth.requestedMode,
      networkFrontage
    },
    networkFrontage: summarizeNetworkFrontage(records, networkFrontage),
    performance,
    records
  });
  attachBaselineComparison(report, baselineStore, { baselinePath, targetPlan, regressionThresholds });
  await saveBaselineUpdate(report, {
    saveBaselinePath,
    targetPlan,
    reviewedGood: flags.reviewed_good === true
  });
  await writeReportOutputs(reportRoot, report);

  progress.runFinish({ total: report.summary?.total ?? records.length, statuses: report.summary?.statuses ?? {} });

  const mode = context.execute ? "execution" : "dry-run";
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode,
      runId,
      reportPath: outputPaths.markdown,
      jsonPath: outputPaths.json,
      summaryPath: outputPaths.summary,
      networkFrontage: report.networkFrontage,
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    return;
  }

  if (!flags.plain) {
    console.log(renderRunReceipt({
      report,
      reportPath: outputPaths.markdown,
      jsonPath: outputPaths.json,
      summaryPath: outputPaths.summary
    }, flags));
    return;
  }

  console.log(`Kova ${mode} report written: ${displayPath(outputPaths.markdown)}`);
  console.log(`Kova ${mode} data written: ${displayPath(outputPaths.json)}`);
  } finally {
    await releaseReportOutputLock(lockPath);
  }
}

function validateExplicitScenarioState(scenario, state, flags) {
  if (!flags.state || (scenario.states ?? []).length === 0) {
    return;
  }
  if (scenario.states.includes(state.id)) {
    return;
  }

  throw new Error(
    `scenario '${scenario.id}' supports only states: ${scenario.states.join(", ")}; got '${state.id}'. ` +
    `Use --state ${scenario.states[0]}, or omit --state to use the default fresh state.`
  );
}

function resolveRunTimeout(scenarios, flags) {
  if (flags.timeout_ms !== undefined) {
    return positiveIntegerFlag(flags, "timeout_ms", 120000);
  }
  const scenarioTimeouts = scenarios
    .map((scenario) => scenario.timeoutMs)
    .filter((timeout) => typeof timeout === "number");
  return scenarioTimeouts.length === 0 ? 120000 : Math.max(...scenarioTimeouts);
}
