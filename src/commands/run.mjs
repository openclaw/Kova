import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { authReportSummary, resolveRunAuthContext } from "../auth.mjs";
import { required, resolveFromCwd } from "../cli.mjs";
import {
  cleanupTargetRuntimeIfNeeded,
  loadRegressionThresholds,
  positiveIntegerFlag,
  profileIntegerFlag,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "./run-support.mjs";
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
import { reportsDir } from "../paths.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadScenarios, validateScenarioRun } from "../registries/scenarios.mjs";
import { loadState } from "../registries/states.mjs";
import { renderMarkdownReport, summarizeRecords } from "../reporting/report.mjs";
import { buildDryRunRecord, createRunId, executeScenario } from "../runner.mjs";
import { resolveTarget } from "../targets.mjs";

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
    validateScenarioRun(scenario, flags, { targetPlan, fromPlan });
  }

  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}.md`);
  const jsonPath = join(reportRoot, `${runId}.json`);
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  const context = {
    target,
    targetPlan,
    from: flags.from,
    fromPlan,
    state,
    sourceEnv: flags.source_env,
    runId,
    execute: flags.execute === true,
    keepEnv: flags.keep_env === true,
    retainOnFailure: flags.retain_on_failure === true,
    timeoutMs: resolveRunTimeout(scenarios, flags),
    healthSamples: profileIntegerFlag(flags, "health_samples", flags.deep_profile === true ? 10 : 3),
    healthIntervalMs: positiveIntegerFlag(flags, "health_interval_ms", 250),
    readinessIntervalMs: profileIntegerFlag(flags, "readiness_interval_ms", flags.deep_profile === true ? 100 : 250),
    heapSnapshot: flags.heap_snapshot === true || flags.deep_profile === true,
    diagnosticReport: flags.deep_profile === true,
    nodeProfile: flags.node_profile === true || flags.deep_profile === true,
    deepProfile: flags.deep_profile === true,
    profileOnFailure: flags.profile_on_failure === true,
    resourceSampleIntervalMs: profileIntegerFlag(flags, "resource_sample_interval_ms", flags.deep_profile === true ? 250 : 1000),
    processRoles: registry.processRoles,
    surfacesById: Object.fromEntries(registry.surfaces.map((surface) => [surface.id, surface])),
    targetSetup: { completed: false },
    auth
  };
  const records = [];

  for (const scenario of scenarios) {
    for (let index = 1; index <= repeat; index += 1) {
      const iterationContext = {
        ...context,
        repeat: {
          index,
          total: repeat
        }
      };
      if (iterationContext.execute) {
        records.push(await executeScenario(scenario, iterationContext));
      } else {
        records.push(buildDryRunRecord(scenario, iterationContext));
      }
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

  const mode = context.execute ? "execution" : "dry-run";
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode,
      runId,
      reportPath,
      jsonPath,
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    return;
  }

  console.log(`Kova ${mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova ${mode} data written: ${relative(process.cwd(), jsonPath)}`);
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
