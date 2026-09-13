import { pickAffectedScenarios, rollupScenarios, scenarioMetricRows } from "../reporting/compare-aggregate.mjs";
import { compareReports, renderCompareSummary } from "../reporting/compare.mjs";
import { renderCompareAssessment } from "../reporting/render-compare.mjs";
import { syntheticCompareReport, syntheticPerformanceRecord, syntheticPerformanceReport } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function compareRepeatAggregationCheck() {
  try {
    const baseline = syntheticPerformanceReport({
      runId: "baseline-repeat",
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "npm:2026.5.12",
      records: [
        syntheticPerformanceRecord(1, { peakRssMb: 1000 }),
        syntheticPerformanceRecord(2, { peakRssMb: 1100 }),
        syntheticPerformanceRecord(3, { peakRssMb: 1200 })
      ]
    });
    const current = syntheticPerformanceReport({
      runId: "current-repeat",
      platform: baseline.platform,
      target: "npm:2026.5.18",
      records: [
        syntheticPerformanceRecord(1, { peakRssMb: 900 }),
        syntheticPerformanceRecord(2, { peakRssMb: 1000 }),
        syntheticPerformanceRecord(3, {
          peakRssMb: 1350,
          resourcePeakTrackedRssMb: 1350
        })
      ]
    });
    baseline.records[0].status = "FAIL";
    baseline.records[0].violations = [{
      kind: "threshold",
      metric: "peakRssMb",
      expected: "<= 900",
      actual: 1000,
      message: "gateway peak RSS 1000 MB exceeded threshold 900 MB"
    }];
    current.records[2].status = "FAIL";
    current.records[2].violations = [{
      kind: "threshold",
      metric: "peakRssMb",
      expected: "<= 900",
      actual: 1350,
      message: "gateway peak RSS 1350 MB exceeded threshold 900 MB"
    }];
    const comparison = compareReports(baseline, current, { thresholds: { peakRssMb: 100 } });
    const scenario = comparison.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(scenario.metrics.peakRssMb.baseline, 1100, "repeat compare uses baseline median");
    assertEqual(scenario.metrics.peakRssMb.current, 1000, "repeat compare uses current median");
    assertEqual(scenario.metrics["peakRssMb.max"].baseline, 1200, "repeat compare tracks baseline max");
    assertEqual(scenario.metrics["peakRssMb.max"].current, 1350, "repeat compare tracks current max");
    assertEqual(scenario.regressions.some((regression) => regression.metric === "peakRssMb"), false, "improved median is not a regression");
    assertEqual(scenario.regressions.some((regression) => regression.metric === "peakRssMb.max"), true, "worse max is explicit max regression");
    assertEqual(comparison.findingChanges.new.length, 0, "same metric finding is not new just because value changed");
    assertEqual(comparison.findingChanges.resolved.length, 0, "same metric finding is not resolved just because value changed");
    return {
      id: "compare-repeat-aggregation",
      status: "PASS",
      command: "evaluate repeated-run compare aggregation",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-repeat-aggregation",
      status: "FAIL",
      command: "evaluate repeated-run compare aggregation",
      durationMs: 0,
      message: error.message
    };
  }
}

export function compareMetricOrderingCheck() {
  try {
    const rows = scenarioMetricRows({
      scenario: "gateway-performance",
      state: "fresh",
      regressions: [
        { kind: "metric", metric: "postReadyHealthFailures.max", baseline: 0, current: 3, delta: 3, tolerance: 0 }
      ],
      metrics: {
        cpuPercentMax: { baseline: 100, current: 123, tolerance: 25 },
        "postReadyHealthFailures.max": { baseline: 0, current: 3, tolerance: 0 },
        modelsListMs: { baseline: 1034, current: 2496 },
        readinessHealthReadyMs: { baseline: 2342, current: 1859 },
        gatewayRestartCount: { baseline: 6, current: 6 }
      }
    }, { limit: Infinity });
    assertEqual(rows.map((row) => row.status).join(","), "OVER,WATCH,PASS,PASS", "compare rows sort by status class");
    assertEqual(rows.map((row) => row.id).join(","), "postReadyHealthFailures.max,modelsListMs,cpuPercentMax,readinessHealthReadyMs", "compare rows omit unchanged rows");
    assertEqual(rows.find((row) => row.id === "cpuPercentMax").threshold, 25, "within-tolerance metric retains tolerance");
    assertEqual(rows.find((row) => row.id === "cpuPercentMax").status, "PASS", "within-tolerance worse metric passes");
    assertEqual(rows.find((row) => row.id === "postReadyHealthFailures.max").absoluteDelta, 3, "zero-baseline count delta retained");
    return {
      id: "compare-metric-ordering",
      status: "PASS",
      command: "evaluate compare metric row ordering",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-metric-ordering",
      status: "FAIL",
      command: "evaluate compare metric row ordering",
      durationMs: 0,
      message: error.message
    };
  }
}

export function compareIdentityAndRollupCheck() {
  try {
    const findingRecord = (violations) => ({
      scenario: "finding-identity",
      surface: "finding-identity",
      title: "Finding Identity",
      state: { id: "fresh" },
      status: "FAIL",
      likelyOwner: "OpenClaw",
      phases: [],
      measurements: {},
      violations
    });
    const repeatedFailure = {
      kind: "threshold",
      metric: "agentTurnMs",
      message: "agent turn latency exceeded the configured threshold at 1200 ms"
    };
    const distinctFailure = {
      kind: "threshold",
      metric: "agentTurnMs",
      message: "agent turn returned duplicate visible output after 1300 ms"
    };
    const baseline = syntheticPerformanceReport({
      runId: "finding-baseline",
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "runtime:stable",
      records: [findingRecord([repeatedFailure])]
    });
    const current = syntheticPerformanceReport({
      runId: "finding-current",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([repeatedFailure, repeatedFailure, distinctFailure])]
    });
    const comparison = compareReports(baseline, current);
    assertEqual(comparison.findingChanges.unchangedCount, 1, "finding compare preserves one matching occurrence");
    assertEqual(comparison.findingChanges.new.length, 2, "finding compare preserves repeated and distinct additions");
    assertEqual(
      comparison.findingChanges.new.some((finding) => finding.summary.includes("duplicate visible output")),
      true,
      "finding compare uses semantic message identity"
    );
    const categoricalBaseline = syntheticPerformanceReport({
      runId: "categorical-baseline",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([{
        kind: "protocol",
        metric: "providerResponse",
        expected: "<= 0",
        message: "provider returned HTTP 401"
      }])]
    });
    const categoricalCurrent = syntheticPerformanceReport({
      runId: "categorical-current",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([{
        kind: "protocol",
        metric: "providerResponse",
        expected: "<= 0",
        message: "provider returned HTTP 500"
      }])]
    });
    const categoricalComparison = compareReports(categoricalBaseline, categoricalCurrent);
    assertEqual(categoricalComparison.findingChanges.new.length, 1, "categorical numeric finding is new");
    assertEqual(categoricalComparison.findingChanges.resolved.length, 1, "categorical numeric finding is resolved");
    const percentageBaseline = syntheticPerformanceReport({
      runId: "percentage-baseline",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([{
        kind: "threshold",
        metric: "errorRate",
        expected: "<= 4",
        message: "error rate 5% exceeded threshold 4%"
      }])]
    });
    const percentageCurrent = syntheticPerformanceReport({
      runId: "percentage-current",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([{
        kind: "threshold",
        metric: "errorRate",
        expected: "<= 4",
        message: "error rate 6% exceeded threshold 4%"
      }])]
    });
    const percentageComparison = compareReports(percentageBaseline, percentageCurrent);
    assertEqual(percentageComparison.findingChanges.new.length, 0, "percentage measurement remains same finding");
    assertEqual(percentageComparison.findingChanges.resolved.length, 0, "percentage measurement is not resolved");
    const countBaseline = syntheticPerformanceReport({
      runId: "count-baseline",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([{
        kind: "threshold",
        metric: "toolCallCount",
        actual: 5,
        expected: "<= 3",
        message: "tool call count 5 exceeded limit 3"
      }])]
    });
    const countCurrent = syntheticPerformanceReport({
      runId: "count-current",
      platform: baseline.platform,
      target: "runtime:stable",
      records: [findingRecord([{
        kind: "threshold",
        metric: "toolCallCount",
        actual: 6,
        expected: "<= 3",
        message: "tool call count 6 exceeded limit 3"
      }])]
    });
    const countComparison = compareReports(countBaseline, countCurrent);
    assertEqual(countComparison.findingChanges.new.length, 0, "count measurement remains same finding");
    assertEqual(countComparison.findingChanges.resolved.length, 0, "count measurement is not resolved");

    const rollupInput = {
      scenarios: [{
        scenario: "rollup-status",
        status: "OK",
        baselineStatus: "PASS",
        currentStatus: "BLOCKED",
        currentSampleCount: 1,
        currentStatuses: { BLOCKED: 1 },
        regressions: []
      }, {
        scenario: "rollup-status",
        status: "REGRESSED",
        baselineStatus: "BLOCKED",
        currentStatus: "FAIL",
        currentSampleCount: 1,
        currentStatuses: { FAIL: 1 },
        regressions: [{ kind: "status", message: "status regressed" }]
      }]
    };
    for (const scenarios of [rollupInput.scenarios, [...rollupInput.scenarios].reverse()]) {
      const rollup = rollupScenarios({ scenarios })[0];
      assertEqual(rollup.baselineStatus, "BLOCKED", "rollup retains worst baseline status");
      assertEqual(rollup.currentStatus, "FAIL", "rollup retains worst current status");
      assertEqual(rollup.failedSamples, 2, "rollup counts all non-passing samples");
      assertEqual(rollup.passedSamples, 0, "rollup counts passed samples explicitly");
    }
    const mixedExecutionStates = [{
      scenario: "mixed-execution",
      status: "OK",
      baselineStatus: "PASS",
      currentStatus: "PASS",
      currentSampleCount: 1,
      currentStatuses: { PASS: 1 },
      regressions: []
    }, {
      scenario: "mixed-execution",
      status: "OK",
      baselineStatus: "PASS",
      currentStatus: "DRY-RUN",
      currentSampleCount: 1,
      currentStatuses: { "DRY-RUN": 1 },
      regressions: []
    }];
    for (const scenarios of [mixedExecutionStates, [...mixedExecutionStates].reverse()]) {
      const rollup = rollupScenarios({ scenarios })[0];
      assertEqual(rollup.currentStatus, "DRY-RUN", "rollup dry-run outranks pass deterministically");
    }
    const mixedVerdictStates = [{
      scenario: "mixed-verdict",
      status: "BLOCKED",
      currentSampleCount: 1,
      currentStatuses: { BLOCKED: 1 },
      regressions: []
    }, {
      scenario: "mixed-verdict",
      status: "FAIL",
      currentSampleCount: 1,
      currentStatuses: { FAIL: 1 },
      regressions: []
    }];
    for (const scenarios of [mixedVerdictStates, [...mixedVerdictStates].reverse()]) {
      const rollup = rollupScenarios({ scenarios })[0];
      assertEqual(rollup.verdict, "FAIL", "compare rollup FAIL outranks BLOCKED");
    }
    const blockedAndRegressedStates = [{
      scenario: "blocked-and-regressed",
      status: "BLOCKED",
      baselineStatus: "BLOCKED",
      currentStatus: "BLOCKED",
      currentSampleCount: 1,
      currentStatuses: { BLOCKED: 1 },
      regressions: []
    }, {
      scenario: "blocked-and-regressed",
      status: "REGRESSED",
      baselineStatus: "PASS",
      currentStatus: "FAIL",
      currentSampleCount: 1,
      currentStatuses: { FAIL: 1 },
      regressions: [{ kind: "status", message: "status regressed from PASS to FAIL" }]
    }];
    for (const scenarios of [blockedAndRegressedStates, [...blockedAndRegressedStates].reverse()]) {
      const rollup = rollupScenarios({ scenarios })[0];
      assertEqual(rollup.verdict, "REGRESSED", "compare rollup regression outranks blocked evidence");
      assertEqual(rollup.currentStatus, "FAIL", "compare rollup retains regressed failure status");
    }

    const improved = {
      baseline: { target: "runtime:old", runId: "old" },
      current: { target: "runtime:new", runId: "new" },
      regressionCount: 0,
      improvementCount: 1,
      scenarios: [{
        scenario: "rollup-status",
        status: "IMPROVED",
        baselineStatus: "FAIL",
        currentStatus: "PASS",
        baselineSampleCount: 1,
        currentSampleCount: 1,
        currentStatuses: { PASS: 1 },
        regressions: [],
        metrics: {}
      }],
      statusChanges: { changes: [], improvements: [], regressions: [] },
      findingChanges: { new: [], resolved: [], unchangedCount: 0 }
    };
    const rendered = renderCompareAssessment(
      improved,
      { color: "never" },
      process.env,
      process.stdout
    );
    assertEqual(rendered.includes("-0"), false, "improved compare avoids negative zero");
    return {
      id: "compare-identity-rollup",
      status: "PASS",
      command: "evaluate finding identity and status rollups",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-identity-rollup",
      status: "FAIL",
      command: "evaluate finding identity and status rollups",
      durationMs: 0,
      message: error.message
    };
  }
}

export function compareGatewayRssDedupeCheck() {
  try {
    const baseline = syntheticPerformanceReport({
      runId: "baseline-gateway-rss",
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "npm:2026.5.12",
      records: [
        syntheticPerformanceRecord(1, {
          peakRssMb: 640,
          resourcePeakGatewayRssMb: 640,
          resourcePeakTrackedRssMb: 1100,
          resourcePrimaryRole: "gateway",
          resourceGateKind: "role"
        })
      ]
    });
    const current = syntheticPerformanceReport({
      runId: "current-gateway-rss",
      platform: baseline.platform,
      target: "npm:2026.5.18",
      records: [
        syntheticPerformanceRecord(1, {
          peakRssMb: 660,
          resourcePeakGatewayRssMb: 660,
          resourcePeakTrackedRssMb: 1200,
          resourcePrimaryRole: "gateway",
          resourceGateKind: "role"
        })
      ]
    });
    const comparison = compareReports(baseline, current, {
      thresholds: { peakRssMb: 100, resourcePeakGatewayRssMb: 100, resourcePeakTrackedRssMb: 100 }
    });
    const scenario = comparison.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(Boolean(scenario.metrics.peakRssMb), true, "primary gateway rss retained");
    assertEqual(Boolean(scenario.metrics.resourcePeakGatewayRssMb), false, "duplicate role gateway rss hidden");
    assertEqual(Boolean(scenario.metrics.resourcePeakTrackedRssMb), true, "tracked total rss remains available");
    assertEqual(scenario.regressions.some((regression) => regression.metric === "resourcePeakGatewayRssMb"), false, "duplicate gateway rss threshold not evaluated");
    return {
      id: "compare-gateway-rss-dedupe",
      status: "PASS",
      command: "evaluate compare gateway RSS dedupe",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-gateway-rss-dedupe",
      status: "FAIL",
      command: "evaluate compare gateway RSS dedupe",
      durationMs: 0,
      message: error.message
    };
  }
}

export function resourceContractCompareCheck() {
  try {
    const report = (runId, offset) => syntheticPerformanceReport({
      runId,
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "runtime:stable",
      records: [0, 10, 20].map((spread, index) => syntheticPerformanceRecord(index + 1, {
        peakRssMb: 400 + offset + spread,
        cpuPercentMax: 20 + offset + spread,
        resourcePeakCommandTreeRssMb: 450 + offset + spread,
        resourcePeakGatewayRssMb: 350 + offset + spread,
        resourcePeakTrackedRssMb: 500 + offset + spread,
        resourceCpuPercentMaxTracked: 30 + offset + spread,
        resourceSampleCount: 10 + offset + spread,
        modelsListMs: 100 + offset + spread
      }))
    });
    const baseline = report("resource-contract-baseline", 0);
    const current = report("resource-contract-current", 200);
    const thresholds = {
      peakRssMb: 10,
      cpuPercentMax: 10,
      resourcePeakCommandTreeRssMb: 10,
      resourcePeakGatewayRssMb: 10,
      resourcePeakTrackedRssMb: 10,
      resourceCpuPercentMaxTracked: 10,
      resourceSampleCount: 10,
      modelsListMs: 10
    };

    const compatible = compareReports(baseline, current, { thresholds });
    const compatibleScenario = compatible.scenarios.find((item) => item.key === "fresh-install:fresh");
    for (const metric of [
      "peakRssMb",
      "peakRssMb.max",
      "peakRssMb.p95",
      "resourceSampleCount",
      "resourceSampleCount.max",
      "resourceSampleCount.p95"
    ]) {
      assertEqual(compatibleScenario.metrics[metric]?.comparable, true, `${metric} comparable under matching contract`);
      assertEqual(typeof compatibleScenario.metrics[metric]?.delta, "number", `${metric} has numeric matching-contract delta`);
    }
    assertEqual(
      compatibleScenario.regressions.some((regression) => regression.metric === "peakRssMb.p95"),
      true,
      "matching contract retains repeated resource p95 regression"
    );

    const legacyBaseline = structuredClone(baseline);
    for (const record of legacyBaseline.records) {
      record.measurements.resourceHeadlineContract = "primary-role-v1";
    }
    const mismatched = compareReports(legacyBaseline, current, { thresholds });
    const mismatchedScenario = mismatched.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(mismatched.resourceContractMismatchCount, 1, "modern compare resource mismatch count");
    assertEqual(mismatched.skippedMetricCount > 0, true, "modern compare skipped resource metric count");
    for (const metric of [
      "peakRssMb",
      "peakRssMb.max",
      "peakRssMb.p95",
      "resourceSampleCount",
      "resourceSampleCount.max",
      "resourceSampleCount.p95"
    ]) {
      assertEqual(mismatchedScenario.metrics[metric]?.comparable, false, `${metric} skipped under mismatched contract`);
      assertEqual(mismatchedScenario.metrics[metric]?.delta, null, `${metric} mismatched delta is null`);
      assertEqual(mismatchedScenario.skippedMetrics.includes(metric), true, `${metric} appears in skipped metrics`);
    }
    assertEqual(
      mismatchedScenario.regressions.some((regression) => /^(?:peakRssMb|cpuPercentMax|resource(?:Peak|Cpu|Sample))/.test(regression.metric)),
      false,
      "mismatched resource regressions are omitted"
    );
    assertEqual(
      mismatchedScenario.regressions.some((regression) => regression.metric === "modelsListMs"),
      true,
      "mismatched resource contract preserves non-resource regression"
    );
    const rows = scenarioMetricRows(mismatchedScenario, { limit: Infinity });
    const skippedRow = rows.find((row) => row.id === "peakRssMb.p95");
    assertEqual(skippedRow?.status, "SKIPPED", "aggregate rows retain incomparable resource metrics as skipped");
    assertEqual(skippedRow?.comparable, false, "aggregate skipped row remains incomparable");
    assertEqual(skippedRow?.delta, null, "aggregate skipped row has no percent delta");
    assertEqual(skippedRow?.absoluteDelta, null, "aggregate skipped row has no absolute delta");
    assertEqual(typeof skippedRow?.baseline, "number", "aggregate skipped row retains raw baseline");
    assertEqual(typeof skippedRow?.current, "number", "aggregate skipped row retains raw current");
    assertEqual(rows.some((row) => row.id === "modelsListMs"), true, "aggregate rows retain non-resource metrics");
    assertEqual(renderCompareSummary(mismatched).includes("Resource contract mismatches: 1"), true, "plain compare summary shows mismatch");
    const rendered = renderCompareAssessment(mismatched, { color: "never", full: true }, process.env, process.stdout);
    assertEqual(rendered.includes("resource contracts"), true, "default compare UI shows resource contract section");
    assertEqual(rendered.includes("peakRssMb.p95"), true, "default compare UI names skipped repeated resource metric");

    const mismatchOnly = compareReports(legacyBaseline, baseline, { thresholds });
    const mismatchOnlyScenario = mismatchOnly.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(mismatchOnly.ok, true, "resource-only contract mismatch remains non-blocking");
    assertEqual(mismatchOnlyScenario.status, "OK", "mismatch-only scenario status remains ok");
    assertEqual(
      pickAffectedScenarios(mismatchOnly).some((item) => item.id === "fresh-install"),
      true,
      "mismatch-only scenario remains visible in affected rendering"
    );
    const mismatchOnlyRendered = renderCompareAssessment(
      mismatchOnly,
      { color: "never", full: true },
      process.env,
      process.stdout
    );
    assertEqual(mismatchOnlyRendered.includes("SKIPPED"), true, "mismatch-only table renders skipped raw rows");

    const sparseLegacyBaseline = structuredClone(legacyBaseline);
    const sparseCurrent = structuredClone(baseline);
    for (const report of [sparseLegacyBaseline, sparseCurrent]) {
      for (const record of report.records) {
        delete record.measurements.resourcePeakTrackedRssMb;
      }
    }
    const sparseMismatch = compareReports(sparseLegacyBaseline, sparseCurrent, { thresholds });
    const sparseMismatchScenario = sparseMismatch.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(
      sparseMismatchScenario.skippedMetrics.includes("resourcePeakTrackedRssMb"),
      false,
      "null resource metric is absent from skipped details"
    );

    return {
      id: "resource-contract-compare",
      status: "PASS",
      command: "compare compatible and mismatched resource contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-contract-compare",
      status: "FAIL",
      command: "compare compatible and mismatched resource contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

export function sourceReleaseCompareCheck() {
  try {
    const releaseReport = syntheticCompareReport({
      runId: "release-run",
      target: "npm:2026.4.27",
      timelineAvailable: false,
      preProviderMs: 62000,
      slowestSpanMs: null
    });
    const sourceReport = syntheticCompareReport({
      runId: "source-run",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 4000,
      slowestSpanMs: 3200
    });
    const comparison = compareReports(releaseReport, sourceReport);
    assertEqual(comparison.ok, true, "source/release comparison with source timeline should pass");
    assertEqual(comparison.sourceRelease?.pairCount, 1, "source/release pair count");
    assertEqual(comparison.sourceRelease?.infoCount, 1, "release missing timeline should be informational");
    assertEqual(comparison.sourceRelease?.pairs?.[0]?.source?.timelineAvailable, true, "source timeline available");
    assertEqual(comparison.sourceRelease?.pairs?.[0]?.release?.timelineAvailable, false, "release timeline missing");

    const missingTimelineComparison = compareReports(releaseReport, syntheticCompareReport({
      runId: "source-no-timeline",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: false,
      preProviderMs: 4000,
      slowestSpanMs: null
    }));
    assertEqual(missingTimelineComparison.ok, false, "source missing timeline should fail comparison");
    assertEqual(missingTimelineComparison.sourceRelease?.blockingCount, 1, "source missing timeline blocking count");
    assertEqual(
      renderCompareSummary(missingTimelineComparison).includes("source-build report omitted OpenClaw timeline diagnostics"),
      true,
      "compare summary includes source timeline blocker"
    );

    const repeatedSource = syntheticCompareReport({
      runId: "source-repeated",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 4000,
      slowestSpanMs: 3200
    });
    repeatedSource.records.push({
      ...structuredClone(repeatedSource.records[0]),
      status: "FAIL",
      measurements: {
        ...repeatedSource.records[0].measurements,
        openclawTimelineAvailable: false,
        openclawTimelineEventCount: 0,
        openclawSlowestSpanName: null,
        openclawSlowestSpanMs: null,
        coldPreProviderMs: 6000,
        agentPreProviderMs: 6000
      }
    });
    repeatedSource.summary = { statuses: { PASS: 1, FAIL: 1 } };
    for (const records of [repeatedSource.records, [...repeatedSource.records].reverse()]) {
      const orderedSource = { ...repeatedSource, records };
      const repeatedComparison = compareReports(releaseReport, orderedSource);
      const source = repeatedComparison.sourceRelease?.pairs?.[0]?.source;
      assertEqual(repeatedComparison.sourceRelease?.blockingCount, 1, "repeated source missing timeline blocks");
      assertEqual(source?.sampleCount, 2, "source diagnostics retain repeated samples");
      assertEqual(source?.status, "FAIL", "source diagnostics retain worst status");
      assertEqual(source?.timelineMissingCount, 1, "source diagnostics count missing timelines");
      assertEqual(source?.agentPreProviderMs, 5000, "source diagnostics use repeated-sample median");
      assertEqual(source?.slowestSpanMs, 3200, "source diagnostics retain worst slow span");
    }

    const failingReport = syntheticCompareReport({
      runId: "gateway-rss-failing",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 4000,
      slowestSpanMs: 3200
    });
    failingReport.summary = { statuses: { FAIL: 1 } };
    failingReport.records[0].status = "FAIL";
    failingReport.records[0].violations = [{
      metric: "resourcePeakGatewayRssMb",
      message: "gateway peak RSS 701.8 MB exceeded threshold 700 MB"
    }];
    const fixedReport = syntheticCompareReport({
      runId: "gateway-rss-fixed",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 3800,
      slowestSpanMs: 3000
    });
    const fixedComparison = compareReports(failingReport, fixedReport);
    assertEqual(fixedComparison.ok, true, "resolved failure comparison should pass");
    assertEqual(fixedComparison.statusChanges.improvements.length, 1, "status improvement count");
    assertEqual(fixedComparison.findingChanges.resolved.length, 1, "resolved finding count");
    assertEqual(
      renderCompareSummary(fixedComparison).includes("RESOLVED FAIL agent-cold-warm-message/mock-openai-provider"),
      true,
      "compare summary includes resolved finding"
    );

    return {
      id: "source-release-compare",
      status: "PASS",
      command: "evaluate synthetic source-build versus release-runtime comparison",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "source-release-compare",
      status: "FAIL",
      command: "evaluate synthetic source-build versus release-runtime comparison",
      durationMs: 0,
      message: error.message
    };
  }
}
