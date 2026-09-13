import { chmod, lstat, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateGate } from "../matrix/gate.mjs";
import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  resolveBaselinePath,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore,
  withBaselineStoreLock
} from "../performance/baselines.mjs";
import {
  RESOURCE_HEADLINE_CONTRACT,
  RESOURCE_MEASUREMENT_SCOPE,
  buildPerformanceSummary
} from "../performance/stats.mjs";
import { renderRunReceipt } from "../reporting/render-run-receipt.mjs";
import { renderMarkdownReport, renderReportSummary } from "../reporting/report.mjs";
import { summarizePerformanceReceipt } from "../run/options.mjs";
import { saveBaselineUpdate } from "../run/report-finalization.mjs";
import { syntheticHealthMeasurement, syntheticPerformanceRecord, syntheticPerformanceReport } from "./fixtures.mjs";
import { assertEqual, sleep } from "./harness.mjs";

export async function performanceBaselineCheck(tmp) {
  try {
    const platform = { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" };
    const targetPlan = { kind: "local-build", value: "/tmp/openclaw" };
    const baselineReport = syntheticPerformanceReport({
      runId: "baseline",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 400, resourcePeakGatewayRssMb: 400, cpuPercentMax: 20, eventLoopDelayMs: 100, agentTurnMs: 2000 }),
        syntheticPerformanceRecord(2, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1200 }), peakRssMb: 420, resourcePeakGatewayRssMb: 420, cpuPercentMax: 22, eventLoopDelayMs: 110, agentTurnMs: 2200 }),
        syntheticPerformanceRecord(3, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1100 }), peakRssMb: 410, resourcePeakGatewayRssMb: 410, cpuPercentMax: 21, eventLoopDelayMs: 105, agentTurnMs: 2100 })
      ]
    });
    baselineReport.performance = buildPerformanceSummary(baselineReport.records, { repeat: 3 });

    const baselinePath = join(tmp, "baselines.json");
    assertEqual(resolveBaselinePath("/tmp/kova-baselines.json"), "/tmp/kova-baselines.json", "POSIX absolute baseline path");
    assertEqual(resolveBaselinePath("C:\\kova\\baselines.json"), "C:\\kova\\baselines.json", "Windows drive baseline path");
    assertEqual(resolveBaselinePath("\\\\server\\share\\baselines.json"), "\\\\server\\share\\baselines.json", "Windows UNC baseline path");
    const unreviewed = reviewBaselineUpdate(baselineReport, { reviewedGood: false });
    assertEqual(unreviewed.ok, false, "baseline update requires review");
    assertEqual(unreviewed.blockers.some((blocker) => blocker.kind === "review-required"), true, "baseline review-required blocker");

    const failingReport = syntheticPerformanceReport({
      runId: "failing",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        {
          ...syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 400 }),
          status: "FAIL",
          violations: [{ message: "gateway readiness exceeded threshold" }]
        }
      ]
    });
    failingReport.performance = buildPerformanceSummary(failingReport.records, { repeat: 1 });
    const failingReview = reviewBaselineUpdate(failingReport, { reviewedGood: true });
    assertEqual(failingReview.ok, false, "failing report rejected for baseline");
    assertEqual(failingReview.blockers.some((blocker) => blocker.kind === "non-passing-records"), true, "non-passing blocker");

    const profiledReport = syntheticPerformanceReport({
      runId: "profiled",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        {
          ...syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 400 }),
          profiling: { enabled: true, interpretation: "instrumented run", baselineEligible: false }
        }
      ]
    });
    profiledReport.performance = buildPerformanceSummary(profiledReport.records, { repeat: 1 });
    const profiledReview = reviewBaselineUpdate(profiledReport, { reviewedGood: true });
    assertEqual(profiledReview.ok, false, "profiled report rejected for baseline");
    assertEqual(profiledReview.blockers.some((blocker) => blocker.kind === "profiled-run"), true, "profiled-run blocker");

    const savedStore = updateBaselineStore(await loadBaselineStore(baselinePath), baselineReport, { targetPlan, reviewedGood: true });
    await saveBaselineStore(baselinePath, savedStore);
    const loadedStore = await loadBaselineStore(baselinePath);
    assertEqual(Object.keys(loadedStore.entries).length, 1, "baseline entry count");
    assertEqual(
      Object.keys(loadedStore.entries)[0].includes("/tmp/openclaw"),
      true,
      "baseline key includes target value"
    );
    const storedAggregate = Object.values(loadedStore.entries)[0]?.aggregate;
    assertEqual(storedAggregate?.resourceMeasurementScope, RESOURCE_MEASUREMENT_SCOPE, "baseline stores resource scope");
    assertEqual(storedAggregate?.resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "baseline stores resource contract");
    const sharedBaselinePath = join(tmp, "shared-baselines.json");
    const linkedBaselinePath = join(tmp, "linked-baselines.json");
    let symlinkSupported = true;
    try {
      await symlink("shared-baselines.json", linkedBaselinePath);
    } catch (error) {
      if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
        symlinkSupported = false;
      } else {
        throw error;
      }
    }
    if (symlinkSupported) {
      await saveBaselineStore(linkedBaselinePath, savedStore);
      assertEqual((await lstat(linkedBaselinePath)).isSymbolicLink(), true, "baseline save preserves symlink");
      assertEqual(
        Object.keys((await loadBaselineStore(sharedBaselinePath)).entries).length,
        1,
        "baseline save updates symlink target"
      );
      const chainedBaselinePath = join(tmp, "chained-baselines.json");
      const missingBaselinePath = join(tmp, "missing-baselines.json");
      await rm(sharedBaselinePath);
      await symlink("missing-baselines.json", sharedBaselinePath);
      await symlink("shared-baselines.json", chainedBaselinePath);
      await saveBaselineStore(chainedBaselinePath, savedStore);
      assertEqual((await lstat(chainedBaselinePath)).isSymbolicLink(), true, "baseline save preserves symlink chain head");
      assertEqual((await lstat(sharedBaselinePath)).isSymbolicLink(), true, "baseline save preserves symlink chain");
      assertEqual(
        Object.keys((await loadBaselineStore(missingBaselinePath)).entries).length,
        1,
        "baseline save follows dangling symlink chain"
      );
    }
    if (process.platform !== "win32") {
      await chmod(baselinePath, 0o600);
      await saveBaselineStore(baselinePath, savedStore);
      assertEqual((await stat(baselinePath)).mode & 0o777, 0o600, "baseline save preserves file permissions");
      await chmod(baselinePath, 0o200);
      await saveBaselineStore(baselinePath, savedStore);
      await chmod(baselinePath, 0o600);
      assertEqual(
        Object.keys((await loadBaselineStore(baselinePath)).entries).length,
        1,
        "baseline save supports write-only files"
      );
      const lockedDirectory = join(tmp, "locked-baseline-dir");
      const lockedBaselinePath = join(lockedDirectory, "baselines.json");
      await mkdir(lockedDirectory);
      await writeFile(lockedBaselinePath, "{}\n");
      await chmod(lockedBaselinePath, 0o600);
      await chmod(lockedDirectory, 0o500);
      try {
        await saveBaselineStore(lockedBaselinePath, savedStore);
      } finally {
        await chmod(lockedDirectory, 0o700);
      }
      assertEqual(
        Object.keys((await loadBaselineStore(lockedBaselinePath)).entries).length,
        1,
        "existing baseline saves without directory create permission"
      );
    }
    const longBaselinePath = join(tmp, `${"b".repeat(240)}.json`);
    await saveBaselineStore(longBaselinePath, savedStore);
    assertEqual(
      Object.keys((await loadBaselineStore(longBaselinePath)).entries).length,
      1,
      "baseline save supports long destination names"
    );
    const failedSavePath = join(tmp, "baseline-save-target");
    await mkdir(failedSavePath);
    let failedSaveRejected = false;
    try {
      await saveBaselineStore(failedSavePath, savedStore);
    } catch {
      failedSaveRejected = true;
    }
    assertEqual(failedSaveRejected, true, "failed baseline replacement is rejected");
    assertEqual(
      (await readdir(tmp)).some((entry) => entry.startsWith(".kova-baseline-") && entry.endsWith(".tmp")),
      false,
      "failed baseline replacement removes temporary file"
    );
    const concurrentBaselinePath = join(tmp, "concurrent-baselines.json");
    const firstConcurrentReport = structuredClone(baselineReport);
    firstConcurrentReport.runId = "concurrent-a";
    const secondConcurrentReport = structuredClone(baselineReport);
    secondConcurrentReport.runId = "concurrent-b";
    await Promise.all([
      saveBaselineUpdate(firstConcurrentReport, {
        saveBaselinePath: concurrentBaselinePath,
        targetPlan: { kind: "local-build", value: "/tmp/openclaw-a" },
        reviewedGood: true
      }),
      saveBaselineUpdate(secondConcurrentReport, {
        saveBaselinePath: concurrentBaselinePath,
        targetPlan: { kind: "local-build", value: "/tmp/openclaw-b" },
        reviewedGood: true
      })
    ]);
    assertEqual(
      Object.keys((await loadBaselineStore(concurrentBaselinePath)).entries).length,
      2,
      "concurrent baseline updates preserve both entries"
    );
    const colocatedBaselinePath = join(tmp, "colocated-baselines.json");
    await withBaselineStoreLock(colocatedBaselinePath, async () => {
      const lockNames = (await readdir(tmp))
        .filter((name) => /^\.kova-baseline-[a-f0-9]{64}\.lock$/.test(name));
      assertEqual(lockNames.length, 1, "baseline lock is colocated with its store");
      if (process.platform !== "win32") {
        const lockInfo = await stat(join(tmp, lockNames[0]));
        assertEqual(
          lockInfo.mode & 0o777,
          0o644,
          "shared baseline lock metadata is readable but owner-only writable"
        );
      }
    });
    let aliasActive = 0;
    let aliasMaxActive = 0;
    await Promise.all(["Alias-Baseline.json", "alias-baseline.json"].map((name) =>
      withBaselineStoreLock(join(tmp, name), async () => {
        aliasActive += 1;
        aliasMaxActive = Math.max(aliasMaxActive, aliasActive);
        await sleep(20);
        aliasActive -= 1;
      })
    ));
    assertEqual(aliasMaxActive, 1, "case aliases share one baseline lock");
    if (symlinkSupported) {
      const canonicalBaselineDir = join(tmp, "canonical-baseline-dir");
      const aliasedBaselineDir = join(tmp, "aliased-baseline-dir");
      await mkdir(canonicalBaselineDir);
      await symlink(canonicalBaselineDir, aliasedBaselineDir);
      aliasActive = 0;
      aliasMaxActive = 0;
      await Promise.all([
        join(canonicalBaselineDir, "baselines.json"),
        join(aliasedBaselineDir, "baselines.json")
      ].map((path) => withBaselineStoreLock(path, async () => {
        aliasActive += 1;
        aliasMaxActive = Math.max(aliasMaxActive, aliasActive);
        await sleep(20);
        aliasActive -= 1;
      })));
      assertEqual(aliasMaxActive, 1, "symlinked parent aliases share one baseline lock");
    }
    const otherTargetComparison = comparePerformanceToBaseline(baselineReport, loadedStore, {
      targetPlan: { kind: "local-build", value: "/tmp/other-openclaw" }
    });
    assertEqual(otherTargetComparison.missingBaselineCount, 1, "different target value misses baseline");

    const parallelReport = {
      ...baselineReport,
      controls: { parallel: 2 },
      performance: {
        ...baselineReport.performance,
        parallel: 2,
        parallelContaminated: true
      }
    };
    const parallelReview = reviewBaselineUpdate(parallelReport, { reviewedGood: true });
    assertEqual(parallelReview.ok, false, "parallel report rejected for baseline");
    assertEqual(parallelReview.blockers.some((blocker) => blocker.kind === "parallel-performance"), true, "parallel-performance blocker");

    const staleStableCountReport = structuredClone(baselineReport);
    staleStableCountReport.performance.unstableGroupCount = 0;
    staleStableCountReport.performance.groups[0].metrics.readinessHealthReadyMs.classification = "unstable";
    const staleStableCountReview = reviewBaselineUpdate(staleStableCountReport, { reviewedGood: true });
    assertEqual(staleStableCountReview.ok, false, "derived unstable group rejects baseline despite stale count");
    assertEqual(
      staleStableCountReview.blockers.find((blocker) => blocker.kind === "unstable-performance")?.count,
      1,
      "derived unstable group count is authoritative"
    );

    const currentReport = syntheticPerformanceReport({
      runId: "current",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1800 }), peakRssMb: 500, resourcePeakGatewayRssMb: 500, cpuPercentMax: 30, eventLoopDelayMs: 180, agentTurnMs: 3000 }),
        syntheticPerformanceRecord(2, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1900 }), peakRssMb: 510, resourcePeakGatewayRssMb: 510, cpuPercentMax: 31, eventLoopDelayMs: 190, agentTurnMs: 3100 }),
        syntheticPerformanceRecord(3, { health: syntheticHealthMeasurement({ healthReadyAtMs: 2000 }), peakRssMb: 520, resourcePeakGatewayRssMb: 520, cpuPercentMax: 32, eventLoopDelayMs: 200, agentTurnMs: 3200 })
      ]
    });
    currentReport.performance = buildPerformanceSummary(currentReport.records, { repeat: 3 });
    assertEqual(currentReport.performance.resourceMeasurementScope, RESOURCE_MEASUREMENT_SCOPE, "performance resource scope");
    assertEqual(currentReport.performance.resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "performance resource contract");
    assertEqual(currentReport.performance.groups[0].resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "performance group resource contract");
    assertEqual(currentReport.performance.groups[0].metrics.readinessHealthReadyMs.median, 1900, "performance median");
    assertEqual(currentReport.performance.groups[0].metrics.readinessHealthReadyMs.p95, 1990, "performance p95");

    const comparison = comparePerformanceToBaseline(currentReport, loadedStore, {
      targetPlan,
      regressionThresholds: {
        startupRegressionPercent: 10,
        rssRegressionPercent: 10,
        cpuRegressionPercent: 10,
        eventLoopRegressionPercent: 10,
        agentLatencyRegressionPercent: 10
      }
    });
    assertEqual(comparison.ok, false, "baseline comparison regression");
    assertEqual(comparison.regressions.some((regression) => regression.metric === "readinessHealthReadyMs"), true, "startup regression present");
    assertEqual(comparison.groups[0]?.resourceComparison?.compatible, true, "matching baseline resource contract compares");
    assertEqual(comparison.groups[0]?.metricComparisons?.peakRssMb?.comparable, true, "matching baseline RSS is comparable");
    assertEqual(typeof comparison.groups[0]?.metricComparisons?.peakRssMb?.delta, "number", "matching baseline RSS delta is numeric");

    const resourceOnlyReport = syntheticPerformanceReport({
      runId: "resource-only-regression",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 600, resourcePeakGatewayRssMb: 600, cpuPercentMax: 40, eventLoopDelayMs: 100, agentTurnMs: 2000 }),
        syntheticPerformanceRecord(2, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1200 }), peakRssMb: 620, resourcePeakGatewayRssMb: 620, cpuPercentMax: 42, eventLoopDelayMs: 110, agentTurnMs: 2200 }),
        syntheticPerformanceRecord(3, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1100 }), peakRssMb: 610, resourcePeakGatewayRssMb: 610, cpuPercentMax: 41, eventLoopDelayMs: 105, agentTurnMs: 2100 })
      ]
    });
    resourceOnlyReport.performance = buildPerformanceSummary(resourceOnlyReport.records, { repeat: 3 });
    const compatibleResourceComparison = comparePerformanceToBaseline(resourceOnlyReport, loadedStore, {
      targetPlan,
      regressionThresholds: { rssRegressionPercent: 10, cpuRegressionPercent: 10 }
    });
    assertEqual(compatibleResourceComparison.ok, false, "matching contract resource regression blocks");
    assertEqual(compatibleResourceComparison.regressions.some((regression) => regression.metric === "peakRssMb"), true, "matching contract RSS regression present");

    const legacyStore = structuredClone(loadedStore);
    const legacyAggregate = Object.values(legacyStore.entries)[0].aggregate;
    legacyAggregate.resourceMeasurementScope = "harness";
    legacyAggregate.resourceHeadlineContract = "primary-role-v1";
    const mismatchComparison = comparePerformanceToBaseline(resourceOnlyReport, legacyStore, {
      targetPlan,
      regressionThresholds: { rssRegressionPercent: 10, cpuRegressionPercent: 10 }
    });
    assertEqual(mismatchComparison.ok, true, "mismatched resource-only baseline does not block");
    assertEqual(mismatchComparison.resourceContractMismatchCount, 1, "baseline resource mismatch count");
    assertEqual(mismatchComparison.skippedMetricCount, 3, "baseline skipped resource metric count");
    assertEqual(mismatchComparison.groups[0]?.resourceComparison?.compatible, false, "baseline resource comparison incompatible");
    for (const metric of ["peakRssMb", "resourcePeakGatewayRssMb", "cpuPercentMax"]) {
      assertEqual(mismatchComparison.groups[0]?.metricComparisons?.[metric]?.comparable, false, `${metric} baseline comparison skipped`);
      assertEqual(mismatchComparison.groups[0]?.metricComparisons?.[metric]?.delta, null, `${metric} baseline delta is null`);
    }

    const sparseLegacyStore = structuredClone(legacyStore);
    const sparseResourceReport = structuredClone(resourceOnlyReport);
    delete Object.values(sparseLegacyStore.entries)[0].aggregate.metrics.resourcePeakGatewayRssMb;
    delete sparseResourceReport.performance.groups[0].metrics.resourcePeakGatewayRssMb;
    const sparseMismatchComparison = comparePerformanceToBaseline(sparseResourceReport, sparseLegacyStore, {
      targetPlan,
      regressionThresholds: { rssRegressionPercent: 10, cpuRegressionPercent: 10 }
    });
    assertEqual(sparseMismatchComparison.skippedMetricCount, 2, "baseline null resource metric is not counted as skipped");
    assertEqual(
      sparseMismatchComparison.groups[0].skippedMetrics.includes("resourcePeakGatewayRssMb"),
      false,
      "baseline null resource metric is absent from skipped details"
    );

    const nonResourceRegressionReport = structuredClone(resourceOnlyReport);
    for (const [index, record] of nonResourceRegressionReport.records.entries()) {
      record.measurements.health = syntheticHealthMeasurement({ healthReadyAtMs: 2000 + (index * 100) });
    }
    nonResourceRegressionReport.performance = buildPerformanceSummary(nonResourceRegressionReport.records, { repeat: 3 });
    const nonResourceMismatchComparison = comparePerformanceToBaseline(nonResourceRegressionReport, legacyStore, {
      targetPlan,
      regressionThresholds: { startupRegressionPercent: 10, rssRegressionPercent: 10, cpuRegressionPercent: 10 }
    });
    assertEqual(nonResourceMismatchComparison.ok, false, "resource mismatch preserves non-resource blocking regression");
    assertEqual(nonResourceMismatchComparison.regressions.some((regression) => regression.metric === "readinessHealthReadyMs"), true, "non-resource startup regression remains active");

    const mismatchGate = evaluateGate({
      mode: "execution",
      controls: {},
      platform,
      baseline: { path: baselinePath, comparison: mismatchComparison },
      records: resourceOnlyReport.records
    }, {
      id: "resource-contract-gate",
      gate: { id: "resource-contract-gate", blocking: [{ scenario: "fresh-install", state: "fresh" }] }
    });
    assertEqual(mismatchGate.verdict, "SHIP", "resource-only mismatch does not block gate");
    assertEqual(mismatchGate.baseline?.resourceContractMismatchCount, 1, "gate propagates resource mismatch count");
    assertEqual(mismatchGate.baseline?.skippedMetricCount, 3, "gate propagates skipped resource metrics");
    assertEqual(mismatchGate.baseline?.resourceContractMismatches?.[0]?.resourceComparison?.compatible, false, "gate propagates resource mismatch detail");

    const mismatchReport = {
      ...resourceOnlyReport,
      summary: { total: 3, statuses: { PASS: 3 } },
      baseline: { path: baselinePath, comparison: mismatchComparison },
      gate: mismatchGate
    };
    const structuredSummary = renderReportSummary(mismatchReport, { structured: true });
    assertEqual(structuredSummary.performance?.resourceMeasurementScope, RESOURCE_MEASUREMENT_SCOPE, "structured report resource scope");
    assertEqual(structuredSummary.performance?.resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "structured report resource contract");
    assertEqual(structuredSummary.performance?.resourceContractMismatchCount, 1, "structured report resource mismatch count");
    const markdown = renderMarkdownReport(mismatchReport);
    assertEqual(markdown.includes("Resource measurement scope: product"), true, "Markdown report resource scope");
    assertEqual(markdown.includes("Resource contract mismatches: 1"), true, "Markdown report resource mismatch");
    const performanceReceipt = summarizePerformanceReceipt(resourceOnlyReport.performance, mismatchReport.baseline);
    assertEqual(performanceReceipt.resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "JSON receipt resource contract");
    assertEqual(performanceReceipt.resourceContractMismatchCount, 1, "JSON receipt resource mismatch count");
    assertEqual(performanceReceipt.skippedMetricCount, 3, "JSON receipt skipped resource metric count");
    const receipt = renderRunReceipt({ report: mismatchReport }, { color: "never" }, process.env, process.stdout);
    assertEqual(receipt.includes("resource contract"), true, "human receipt resource contract section");
    assertEqual(receipt.includes("1 baseline contract mismatch"), true, "human receipt resource mismatch count");
    const regressedReview = reviewBaselineUpdate({
      ...currentReport,
      baseline: { path: baselinePath, comparison }
    }, { reviewedGood: true });
    assertEqual(regressedReview.ok, false, "regressed current report rejected for baseline update");
    assertEqual(regressedReview.blockers.some((blocker) => blocker.kind === "baseline-regression"), true, "baseline-regression blocker");

    const gate = evaluateGate({
      mode: "execution",
      controls: {},
      platform,
      baseline: { path: baselinePath, comparison },
      records: currentReport.records
    }, {
      id: "perf-gate",
      gate: {
        id: "perf-gate",
        blocking: [{ scenario: "fresh-install", state: "fresh" }]
      }
    });
    assertEqual(gate.verdict, "DO_NOT_SHIP", "performance regression gate verdict");
    assertEqual(gate.baseline?.regressionCount, comparison.regressionCount, "gate baseline regression count");
    assertEqual(gate.baseline?.regressedGroups?.[0]?.scenario, "fresh-install", "gate baseline group scenario");
    assertEqual(gate.cards.some((card) => card.kind === "performance-regression"), true, "performance regression gate card");

    return {
      id: "performance-baseline-regression",
      status: "PASS",
      command: "evaluate synthetic repeat performance baseline",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "performance-baseline-regression",
      status: "FAIL",
      command: "evaluate synthetic repeat performance baseline",
      durationMs: 0,
      message: error.message
    };
  }
}
