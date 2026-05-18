import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authReportSummary, resolveRunAuthContext } from "../auth.mjs";
import { required, resolveFromCwd } from "../cli.mjs";
import {
  cleanupTargetRuntimeIfNeeded,
  loadRegressionThresholds,
  positiveIntegerFlag,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "./run-support.mjs";
import { buildRunContext } from "../run/context.mjs";
import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  resolveBaselinePath,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore
} from "../performance/baselines.mjs";
import { buildPerformanceSummary } from "../performance/stats.mjs";
import { platformInfo } from "../platform.mjs";
import { reportsDir, displayPath } from "../paths.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadScenarios, validateScenarioRun } from "../registries/scenarios.mjs";
import { loadState } from "../registries/states.mjs";
import { buildReportSummary, renderMarkdownReport, summarizeRecords } from "../reporting/report.mjs";
import { buildDryRunRecord, createRunId, executeScenario } from "../runner.mjs";
import { resolveTarget } from "../targets.mjs";
import { createRunProgress } from "../reporting/render-run-progress.mjs";
import { renderRunReceipt } from "../reporting/render-run-receipt.mjs";

const reportSchemaVersion = "kova.report.v1";

export async function runScenarioCommand(flags) {
  const registry = await loadRegistryContext();
  const target = required(flags.target, "--target");
  if (flags.execute === true && !flags.scenario) {
    throw new Error("--execute requires --scenario so real runs stay deliberate");
  }
  validateBaselineExecutionFlags(flags);

  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const state = await loadState(flags.state ?? "fresh");
  const scenarios = await loadScenarios(flags.scenario);
  for (const scenario of scenarios) {
    validateExplicitScenarioState(scenario, state, flags);
    validateScenarioRun(scenario, flags, { targetPlan, fromPlan });
  }

  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}.md`);
  const jsonPath = join(reportRoot, `${runId}.json`);
  const summaryPath = join(reportRoot, `${runId}.summary.json`);
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  const context = buildRunContext({
    flags,
    registry,
    target,
    targetPlan,
    fromPlan,
    state,
    runId,
    auth,
    timeoutMs: resolveRunTimeout(scenarios, flags)
  });
  const records = [];
  const progress = createRunProgress({ flags, mode: context.execute ? "execution" : "dry-run" });
  progress.runStart({
    scenarioCount: scenarios.length * repeat,
    mode: context.execute ? "execution" : "dry-run",
    target,
  });

  for (const scenario of scenarios) {
    for (let index = 1; index <= repeat; index += 1) {
      const iterationContext = {
        ...context,
        repeat: {
          index,
          total: repeat
        }
      };
      const iteration = { index, total: repeat };
      progress.scenarioStart({ scenarioId: scenario.id, stateId: state.id, iteration });
      iterationContext.onPhase = (title) => progress.phase({ title });
      const record = iterationContext.execute
        ? await executeScenario(scenario, iterationContext)
        : buildDryRunRecord(scenario, iterationContext);
      records.push(record);
      progress.scenarioEnd({ scenarioId: scenario.id, stateId: state.id, iteration, status: record.status, skipReason: record.skipReason });
    }
  }
  const targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
    execute: context.execute,
    timeoutMs: context.timeoutMs
  });
  const performance = buildPerformanceSummary(records, { repeat, regressionThresholds });

  await mkdir(reportRoot, { recursive: true });
  const report = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    outputPaths: {
      markdown: reportPath,
      json: jsonPath,
      summary: summaryPath
    },
    mode: context.execute ? "execution" : "dry-run",
    target,
    from: flags.from ?? null,
    state: {
      id: state.id,
      title: state.title,
      objective: state.objective
    },
    platform: platformInfo(),
    targetCleanup,
    auth: authReportSummary(auth),
    controls: {
      repeat,
      baseline: baselinePath,
      saveBaseline: saveBaselinePath,
      auth: auth.requestedMode
    },
    performance,
    baseline: null,
    summary: summarizeRecords(records),
    records
  };
  const baselineComparison = comparePerformanceToBaseline(report, baselineStore, { targetPlan, regressionThresholds });
  if (baselineComparison) {
    report.baseline = {
      path: baselinePath,
      comparison: baselineComparison
    };
  }
  if (saveBaselinePath) {
    const existingStore = await loadBaselineStore(saveBaselinePath);
    const review = reviewBaselineUpdate(report, { reviewedGood: flags.reviewed_good === true });
    const updatedStore = updateBaselineStore(existingStore, report, { targetPlan, reviewedGood: flags.reviewed_good === true });
    report.baseline = {
      ...(report.baseline ?? {}),
      review,
      saved: await saveBaselineStore(saveBaselinePath, updatedStore)
    };
  }
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(buildReportSummary(report), null, 2)}\n`, "utf8");

  progress.runFinish({ total: report.summary?.total ?? records.length, statuses: report.summary?.statuses ?? {} });

  const mode = context.execute ? "execution" : "dry-run";
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode,
      runId,
      reportPath,
      jsonPath,
      summaryPath,
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    return;
  }

  if (!flags.plain) {
    console.log(renderRunReceipt({ report, reportPath, jsonPath, summaryPath }, flags));
    return;
  }

  console.log(`Kova ${mode} report written: ${displayPath(reportPath)}`);
  console.log(`Kova ${mode} data written: ${displayPath(jsonPath)}`);
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
