import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { authReportSummary, resolveRunAuthContext } from "../auth.mjs";
import { required, resolveFromCwd } from "../cli.mjs";
import {
  cleanupTargetRuntimeIfNeeded,
  loadRegressionThresholds,
  positiveIntegerFlag,
  positiveIntegerValue,
  profileIntegerFlag,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "./run-support.mjs";
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
import { reportsDir } from "../paths.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadProfile } from "../registries/profiles.mjs";
import { validateScenarioRun } from "../registries/scenarios.mjs";
import { renderMarkdownReport, summarizeRecords } from "../reporting/report.mjs";
import { bundleReport, retainGateArtifacts } from "../reporting/artifacts.mjs";
import { buildDryRunRecord, buildSkippedRecord, createRunId, executeScenario } from "../runner.mjs";
import { resolveTarget } from "../targets.mjs";

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
  const targetSetup = { completed: false };
  const runEntry = async (entry) => {
    const context = {
      target,
      targetPlan,
      profile,
      from: flags.from,
      fromPlan,
      state: entry.state,
      sourceEnv: flags.source_env,
      runId,
      controls,
      execute: flags.execute === true,
      keepEnv: flags.keep_env === true,
      retainOnFailure: flags.retain_on_failure === true,
      timeoutMs: resolveEntryTimeout(entry, flags),
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
      targetSetup,
      auth
    };

    if (entry.skipReason) {
      return buildRepeatRecords(entry, context, (iterationContext) => buildSkippedRecord(entry.scenario, iterationContext, entry.skipReason));
    }

    return buildRepeatRecords(entry, context, async (iterationContext) =>
      iterationContext.execute
        ? executeScenario(entry.scenario, iterationContext)
        : buildDryRunRecord(entry.scenario, iterationContext)
    );
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
    regressionThresholds
  });
  const platform = platformInfo();
  const reportBase = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    outputPaths: {
      markdown: reportPath,
      json: jsonPath
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

  console.log(`Kova matrix ${report.mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova matrix ${report.mode} data written: ${relative(process.cwd(), jsonPath)}`);
  console.log(`Kova matrix bundle written: ${relative(process.cwd(), bundle.outputPath)}`);
  if (retainedGateArtifacts) {
    console.log(`Kova failed gate artifacts retained: ${relative(process.cwd(), retainedGateArtifacts.outputDir)}`);
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
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const retained = await retainGateArtifacts(jsonPath, bundle);
  report.retainedGateArtifacts = retained;
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
    throw new Error(`gate outcome: ${gate.outcome ?? gate.verdict}`);
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
      if (controls.failFast && entryRecords.some((record) => record.status === "FAIL" || record.status === "BLOCKED")) {
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
