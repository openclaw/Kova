import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authReportSummary, resolveRunAuthContext } from "../auth.mjs";
import { required, resolveFromCwd } from "../cli.mjs";
import {
  cleanupTargetRuntimeIfNeeded,
  loadRegressionThresholds,
  positiveIntegerFlag,
  positiveIntegerValue,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "./run-support.mjs";
import { buildRunContext } from "../run/context.mjs";
import { applyMatrixControls, expandProfile } from "../matrix/expand.mjs";
import { evaluateGate, preflightGateRun } from "../matrix/gate.mjs";
import { matrixControlSummary } from "../matrix/controls.mjs";
import { profileSummary, validateProfileTarget } from "../matrix/profile.mjs";
import { assertResolvedCoverageIsRunnable, resolveCoverageObligations } from "../matrix/resolver.mjs";
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
import { isNonPassingExecutionStatus } from "../statuses.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadProfile } from "../registries/profiles.mjs";
import { validateScenarioRun } from "../registries/scenarios.mjs";
import { buildReportSummary, renderMarkdownReport, summarizeRecords } from "../reporting/report.mjs";
import { bundleReport, retainGateArtifacts } from "../reporting/artifacts.mjs";
import { buildDryRunRecord, buildSkippedRecord, createRunId, executeScenario } from "../runner.mjs";
import { resolveTarget } from "../targets.mjs";
import { createRunProgress } from "../reporting/render-run-progress.mjs";
import { renderMatrixRunReceipt } from "../reporting/render-run-receipt.mjs";

const reportSchemaVersion = "kova.report.v1";

export async function runMatrixRun(flags) {
  const registry = await loadRegistryContext();
  const profile = await loadProfile(required(flags.profile, "--profile"));
  validateProfileExecutionFlags(profile, flags);
  const target = required(flags.target, "--target");
  validateBaselineExecutionFlags(flags);
  const targetPlan = resolveTarget(target, "target");
  validateProfileTarget(profile, targetPlan);
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const entries = applyMatrixControls(await expandProfile(profile), flags, platformInfo());
  const resolvedCoverage = resolveCoverageObligations({
    profile,
    entries,
    surfaces: registry.surfaces,
    targetPlan
  });
  assertResolvedCoverageIsRunnable(resolvedCoverage);
  const controls = matrixControlSummary(flags, targetPlan);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  preflightGateRun({ entries, flags });
  for (const entry of entries.filter((item) => !item.skipReason)) {
    validateScenarioRun(entry.scenario, flags, { targetPlan, fromPlan });
  }
  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}-${profile.id}.md`);
  const jsonPath = join(reportRoot, `${runId}-${profile.id}.json`);
  const summaryPath = join(reportRoot, `${runId}-${profile.id}.summary.json`);
  const targetSetup = { completed: false };
  const progress = createRunProgress({ flags, mode: flags.execute === true ? "execution" : "dry-run" });
  progress.runStart({
    scenarioCount: entries.length * (controls.repeat ?? 1),
    mode: flags.execute === true ? "execution" : "dry-run",
    target,
    profile: profile.id,
  });
  const runEntry = async (entry) => {
    const context = buildRunContext({
      flags,
      registry,
      target,
      targetPlan,
      profile,
      fromPlan,
      state: entry.state,
      runId,
      controls,
      auth,
      targetSetup,
      timeoutMs: resolveEntryTimeout(entry, flags)
    });

    if (entry.skipReason) {
      return buildRepeatRecords(entry, context, (iterationContext) => {
        const rec = buildSkippedRecord(entry.scenario, iterationContext, entry.skipReason);
        progress.scenarioEnd({
          scenarioId: entry.scenario.id,
          stateId: entry.state?.id,
          iteration: iterationContext.repeat,
          status: rec.status,
          skipReason: entry.skipReason,
        });
        return rec;
      });
    }

    return buildRepeatRecords(entry, context, async (iterationContext) => {
      progress.scenarioStart({
        scenarioId: entry.scenario.id,
        stateId: entry.state?.id,
        iteration: iterationContext.repeat,
      });
      iterationContext.onPhase = (title) => progress.phase({ title });
      const rec = iterationContext.execute
        ? await executeScenario(entry.scenario, iterationContext)
        : buildDryRunRecord(entry.scenario, iterationContext);
      progress.scenarioEnd({
        scenarioId: entry.scenario.id,
        stateId: entry.state?.id,
        iteration: iterationContext.repeat,
        status: rec.status,
        skipReason: rec.skipReason,
      });
      return rec;
    });
  };

  const records = flags.execute === true
    ? await runMatrixEntries(entries, runEntry, controls)
    : (await Promise.all(entries.map((entry) => runEntry(entry)))).flat();
  const targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
    execute: flags.execute === true,
    timeoutMs: positiveIntegerFlag(flags, "timeout_ms", 120000)
  });
  const performance = buildPerformanceSummary(records, {
    repeat: controls.repeat,
    parallel: controls.parallel,
    regressionThresholds
  });
  const platform = platformInfo();
  const reportBase = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    outputPaths: {
      markdown: reportPath,
      json: jsonPath,
      summary: summaryPath
    },
    mode: flags.execute === true ? "execution" : "dry-run",
    profile: profileSummary(profile),
    target,
    from: flags.from ?? null,
    controls,
    auth: authReportSummary(auth),
    state: null,
    platform,
    targetCleanup,
    performance,
    baseline: null,
    gate: null,
    summary: summarizeRecords(records),
    records
  };
  const baselineComparison = comparePerformanceToBaseline(reportBase, baselineStore, { targetPlan, regressionThresholds });
  if (baselineComparison) {
    reportBase.baseline = {
      path: baselinePath,
      comparison: baselineComparison
    };
  }
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

  await mkdir(reportRoot, { recursive: true });
  const report = {
    ...reportBase,
    gate
  };
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
  const bundle = await bundleReport(jsonPath, { outputDir: reportRoot });
  const retainedGateArtifacts = gate && gate.verdict !== "SHIP"
    ? await retainFailedGateArtifacts(report, reportPath, jsonPath, bundle)
    : null;

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.matrix.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode: report.mode,
      runId,
      profile: profileSummary(profile),
      reportPath,
      jsonPath,
      summaryPath,
      bundlePath: bundle.outputPath,
      checksumPath: bundle.checksumPath,
      retainedGateArtifacts,
      gate: summarizeGateReceipt(gate),
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
      reportPath,
      jsonPath,
      summaryPath,
      bundlePath: bundle.outputPath,
      retainedGateArtifacts,
    }, flags));
    failGateIfNeeded(gate);
    return;
  }

  console.log(`Kova matrix ${report.mode} report written: ${displayPath(reportPath)}`);
  console.log(`Kova matrix ${report.mode} data written: ${displayPath(jsonPath)}`);
  console.log(`Kova matrix bundle written: ${displayPath(bundle.outputPath)}`);
  if (retainedGateArtifacts) {
    console.log(`Kova failed gate artifacts retained: ${displayPath(retainedGateArtifacts.outputDir)}`);
  }
  if (gate) {
    console.log(`Kova gate outcome: ${gate.outcome ?? gate.verdict}`);
  }
  failGateIfNeeded(gate);
}

function validateProfileExecutionFlags(profile, flags) {
  if (flags.execute === true && profile.id === "exhaustive" && flags.allow_exhaustive !== true) {
    throw new Error("executing profile 'exhaustive' requires --allow-exhaustive");
  }
}

async function retainFailedGateArtifacts(report, reportPath, jsonPath, bundle) {
  report.retainedGateArtifacts = {
    status: "pending"
  };
  const summaryPath = report.outputPaths?.summary ?? jsonPath.replace(/\.json$/, ".summary.json");
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(buildReportSummary(report), null, 2)}\n`, "utf8");
  const retained = await retainGateArtifacts(jsonPath, bundle);
  report.retainedGateArtifacts = retained;
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(buildReportSummary(report), null, 2)}\n`, "utf8");
  await retainGateArtifacts(jsonPath, bundle, { outputDir: retained.outputDir });
  return retained;
}

function resolveEntryTimeout(entry, flags) {
  return positiveIntegerValue(flags.timeout_ms ?? entry.timeoutMs ?? entry.scenario.timeoutMs ?? 120000, "--timeout-ms");
}

async function buildRepeatRecords(entry, context, callback) {
  const total = positiveIntegerValue(context.controls?.repeat ?? 1, "repeat");
  const records = [];
  for (let index = 1; index <= total; index += 1) {
    records.push(await callback({
      ...context,
      repeat: {
        index,
        total
      }
    }));
  }
  return records;
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
    missingBaselineCount: gate.baseline?.missingBaselineCount ?? null
  };
}

async function runMatrixEntries(entries, runEntry, controls) {
  if (controls.parallel <= 1) {
    const records = [];
    for (const entry of entries) {
      const entryRecords = await runEntry(entry);
      records.push(...entryRecords);
      if (controls.failFast && entryRecords.some((record) => isNonPassingExecutionStatus(record.status))) {
        break;
      }
    }
    return records;
  }

  const records = new Array(entries.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      records[index] = await runEntry(entries[index]);
    }
  }

  await Promise.all(Array.from({ length: controls.parallel }, () => worker()));
  return records.filter(Boolean).flat();
}
