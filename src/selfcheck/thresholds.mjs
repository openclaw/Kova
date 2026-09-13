import { resolveThresholdPolicy } from "../evaluation/thresholds.mjs";
import {
  checkAggregateThreshold,
  checkDuration,
  checkEvidenceThreshold,
  checkRoleThresholds,
  checkTurnThreshold
} from "../evaluation/violations.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { evaluateGate } from "../matrix/gate.mjs";
import { comparePerformanceToBaseline, updateBaselineStore } from "../performance/baselines.mjs";
import { isInstrumentedPerformanceMetric, isProfilingArtifactMetric } from "../performance/instrumentation.mjs";
import { buildPerformanceSummary } from "../performance/stats.mjs";
import { compareReports, renderCompareSummary } from "../reporting/compare.mjs";
import { renderCompareAssessment } from "../reporting/render-compare.mjs";
import { aggregateScenarios } from "../reporting/scenario-aggregate.mjs";
import {
  syntheticPerformanceRecord,
  syntheticPerformanceReport,
  syntheticResourceSamples,
  zeroLogMetrics
} from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function evaluationViolationHelpersCheck() {
  try {
    const violations = [];
    checkDuration(violations, [{ command: "openclaw status", durationMs: 51 }], "statusMs", 50, (command) => command.includes("status"));
    checkEvidenceThreshold(violations, "media", "mediaDescribeMs", 101, 100, "Media describe");
    checkRoleThresholds(violations, { gateway: { peakRssMb: 901, maxCpuPercent: 41 } }, { gateway: { peakRssMb: 900, maxCpuPercent: 40 } });
    checkAggregateThreshold(violations, 201, "agentTurnP95Ms", 200);
    checkTurnThreshold(violations, { phaseId: "turn", preProviderMs: 301 }, "preProviderMs", 300, "pre-provider latency was 301ms");
    assertEqual(violations.length, 6, "violation helper count");
    assertEqual(violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"), true, "role RSS violation");
    assertEqual(violations.some((violation) => violation.phaseId === "turn"), true, "turn threshold violation");

    const malformed = [];
    checkDuration(
      malformed,
      [{ command: "openclaw status", durationMs: "51" }],
      "statusMs",
      50,
      (command) => command.includes("status")
    );
    checkEvidenceThreshold(malformed, "media", "mediaDescribeMs", Number.NaN, 100, "Media describe");
    checkAggregateThreshold(malformed, null, "agentTurnP95Ms", 200);
    checkTurnThreshold(
      malformed,
      { phaseId: "turn", preProviderMs: undefined },
      "preProviderMs",
      300,
      "pre-provider latency was malformed"
    );
    assertEqual(malformed.length, 4, "malformed helper payload count");
    assertEqual(
      malformed.every((violation) => violation.failureDomain === "kova-harness"),
      true,
      "malformed helper payloads are Kova harness blockers"
    );

    const optionalMeasurements = [];
    checkTurnThreshold(
      optionalMeasurements,
      { phaseId: "turn", cleanupMs: null },
      "cleanupMs",
      5000,
      "agent cleanup was unavailable",
      { optionalMeasurement: true }
    );
    checkAggregateThreshold(
      optionalMeasurements,
      null,
      "agentCleanupMaxMs",
      5000,
      { optionalMeasurement: true }
    );
    assertEqual(optionalMeasurements.length, 0, "missing optional measurements stay non-blocking");
    checkTurnThreshold(
      optionalMeasurements,
      { phaseId: "turn", cleanupMs: -1 },
      "cleanupMs",
      5000,
      "agent cleanup was malformed",
      { optionalMeasurement: true }
    );
    assertEqual(optionalMeasurements.length, 1, "malformed optional measurements still block");

    const malformedRecord = {
      status: "PASS",
      phases: [{
        id: "status",
        results: [{
          command: "ocm @kova-self-check -- status",
          status: 0,
          durationMs: "51"
        }]
      }]
    };
    evaluateRecord(malformedRecord, { thresholds: { statusMs: 50 } });
    assertEqual(malformedRecord.status, "BLOCKED", "malformed Kova evidence blocks the record");
    assertEqual(
      malformedRecord.violations.some((violation) => violation.failureDomain === "kova-harness"),
      true,
      "blocked record preserves malformed evidence reason"
    );
    const failedMalformedRecord = {
      status: "FAIL",
      phases: structuredClone(malformedRecord.phases)
    };
    evaluateRecord(failedMalformedRecord, { thresholds: { statusMs: 50 } });
    assertEqual(
      failedMalformedRecord.status,
      "FAIL",
      "malformed Kova evidence does not hide an established target failure"
    );
    const mixedRecord = {
      status: "PASS",
      phases: [{
        id: "status",
        results: [{
          command: "ocm @kova-self-check -- status",
          status: 0,
          durationMs: 51
        }, {
          command: "ocm @kova-self-check -- status",
          status: 0,
          durationMs: "malformed"
        }]
      }]
    };
    evaluateRecord(mixedRecord, { thresholds: { statusMs: 50 } });
    assertEqual(
      mixedRecord.status,
      "FAIL",
      "confirmed target violations take precedence over malformed Kova evidence"
    );
    return {
      id: "evaluation-violation-helpers",
      status: "PASS",
      command: "validate evaluation violation helper contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "evaluation-violation-helpers",
      status: "FAIL",
      command: "validate evaluation violation helper contract",
      durationMs: 0,
      message: error.message
    };
  }
}

export function localBuildTargetSetupResourceExclusionCheck() {
  try {
    const record = {
      scenario: "local-build-runtime-resources",
      status: "PASS",
      phases: [
        {
          id: "target-setup",
          measurementScope: "harness",
          results: [{
            command: "ocm runtime build-local kova-local-test --repo /tmp/openclaw --force",
            status: 0,
            durationMs: 60000,
            measurementScope: "product",
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 2500,
              maxCpuPercent: 350,
              role: "build-tooling"
            })
          }]
        },
        {
          id: "auth-prepare",
          measurementScope: "harness",
          results: [{
            command: "mock-ai-provider serve --providers openai",
            status: 0,
            durationMs: 500,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 1900,
              maxCpuPercent: 320,
              role: "mock-provider"
            })
          }]
        },
        {
          id: "scenario-command",
          measurementScope: "product",
          results: [{
            command: "ocm @kova-self-check -- status",
            status: 0,
            durationMs: 100,
            measurementScope: "harness",
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 100,
              maxCpuPercent: 20,
              role: "gateway"
            })
          }, {
            command: "node support/kova-helper.mjs",
            status: 0,
            durationMs: 100,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 600,
              maxCpuPercent: 30,
              role: "command-tree"
            })
          }]
        },
        {
          id: "auth-cleanup",
          measurementScope: "cleanup",
          results: [{
            command: "kill $(cat mock/pid)",
            status: 0,
            durationMs: 50,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 1800,
              maxCpuPercent: 300,
              role: "mock-provider"
            })
          }]
        }
      ],
      finalMetrics: {
        service: { gatewayState: "disabled" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, { thresholds: { peakRssMb: 200 } }, {
      surface: { thresholds: {}, resourcePrimaryRole: "gateway" },
      targetPlan: { kind: "local-build" }
    });
    assertEqual(record.status, "PASS", "local-build target setup resources ignored status");
    assertEqual(record.measurements.peakRssMb, 100, "local-build target setup resources ignored RSS");
    assertEqual(record.measurements.resourcePeakTrackedRssMb, 600, "tracked product helper RSS retained separately");
    assertEqual(record.measurements.resourcePrimaryRole, "gateway", "primary resource role retained");
    assertEqual(record.measurements.resourceByRole.gateway.peakRssMb, 100, "scenario role RSS retained");
    assertEqual(record.measurements.resourceByRole["build-tooling"], undefined, "target setup role excluded");
    assertEqual(record.measurements.resourceByRole["mock-provider"], undefined, "harness auth resources excluded");
    assertEqual(record.measurements.measurementScopeSummary.harnessCommandCount, 2, "harness command count");
    assertEqual(record.measurements.measurementScopeSummary.productCommandCount, 2, "product command count is phase-owned");
    assertEqual(record.measurements.measurementScopeSummary.cleanupCommandCount, 1, "cleanup command count");
    assertEqual(record.violations, undefined, "no-service local-build record has no gateway violation");
    return {
      id: "local-build-target-setup-resource-exclusion",
      status: "PASS",
      command: "evaluate local-build target setup resource exclusion",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "local-build-target-setup-resource-exclusion",
      status: "FAIL",
      command: "evaluate local-build target setup resource exclusion",
      durationMs: 0,
      message: error.message
    };
  }
}

export function instrumentedPerformanceThresholdPolicyCheck() {
  try {
    const scenario = {
      id: "instrumented-performance-threshold-policy",
      thresholds: {
        statusMs: 100,
        peakRssMb: 1000,
        cpuPercentMax: 350
      }
    };
    const options = {
      surface: {
        id: "agent-cli-local-turn",
        thresholds: {},
        resourcePrimaryRole: "agent-process",
        roleThresholds: {}
      },
      targetPlan: { kind: "local-build" }
    };
    const instrumentedProfiling = {
      enabled: true,
      deepProfile: true,
      nodeProfile: true,
      heapSnapshot: true,
      diagnosticReport: true,
      profileOnFailure: false,
      affectsPerformanceMeasurements: true,
      affectsResourceMeasurements: true,
      baselineEligible: false
    };
    const buildRecord = ({
      profiling,
      status = "PASS",
      commandStatus = 0,
      durationMs = 200,
      resourceRole = "agent-process"
    }) => ({
      scenario: scenario.id,
      surface: "agent-cli-local-turn",
      title: "Instrumented Performance Threshold Policy",
      state: { id: "mock-openai-provider" },
      status,
      profiling,
      phases: [{
        id: "scenario-command",
        measurementScope: "product",
        results: [{
          command: "ocm @kova-self-check -- status",
          status: commandStatus,
          durationMs,
          resourceSamples: syntheticResourceSamples({
            peakRssMb: 1065,
            maxCpuPercent: 420,
            role: resourceRole,
            processRoles: resourceRole === "gateway"
              ? ["gateway"]
              : [resourceRole, "command-tree"]
          })
        }]
      }],
      finalMetrics: {
        service: { gatewayState: "disabled" },
        logs: zeroLogMetrics()
      }
    });

    const instrumented = buildRecord({ profiling: instrumentedProfiling });
    evaluateRecord(instrumented, scenario, options);
    assertEqual(instrumented.status, "PASS", "instrumented performance overages do not fail the record");
    assertEqual(instrumented.violations, undefined, "instrumented performance overages are not fatal violations");
    assertEqual(instrumented.measurements.peakRssMb, 1065, "instrumented RSS remains visible");
    assertEqual(instrumented.measurements.cpuPercentMax, 420, "instrumented CPU remains visible");
    assertEqual(
      instrumented.performanceThresholdAssessment?.skipped.some(
        (assessment) =>
          assessment.metric === "peakRssMb" &&
          assessment.observedOverThreshold === true
      ),
      true,
      "instrumented RSS threshold is explicitly skipped"
    );
    assertEqual(
      instrumented.performanceThresholdAssessment?.skipped.some(
        (assessment) =>
          assessment.metric === "statusMs" &&
          assessment.observedOverThreshold === true
      ),
      true,
      "instrumented latency threshold is explicitly skipped"
    );

    const heapOnly = buildRecord({
      profiling: {
        ...instrumentedProfiling,
        deepProfile: false,
        nodeProfile: false,
        diagnosticReport: false
      }
    });
    evaluateRecord(heapOnly, scenario, options);
    assertEqual(heapOnly.status, "PASS", "heap-only performance overages remain diagnostic");
    assertEqual(
      heapOnly.performanceThresholdAssessment?.skipped.some(
        (assessment) =>
          assessment.metric === "peakRssMb" &&
          assessment.observedOverThreshold === true
      ),
      true,
      "heap-only RSS threshold is explicitly skipped"
    );
    const heapOnlyGate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      records: [heapOnly]
    }, {
      id: "heap-only-performance-gate",
      purpose: "release",
      gate: {
        blocking: [{ scenario: scenario.id, state: "mock-openai-provider" }]
      }
    });
    assertEqual(heapOnlyGate.verdict, "PARTIAL", "heap-only evidence cannot ship");
    assertEqual(heapOnlyGate.ok, false, "heap-only evidence is not gate-ok");

    const normal = buildRecord({
      profiling: {
        enabled: false,
        affectsPerformanceMeasurements: false,
        affectsResourceMeasurements: false,
        baselineEligible: true
      }
    });
    evaluateRecord(normal, scenario, options);
    assertEqual(normal.status, "FAIL", "normal performance overages remain fatal");
    for (const metric of ["peakRssMb", "cpuPercentMax", "statusMs"]) {
      assertEqual(
        normal.violations.some((violation) => violation.metric === metric),
        true,
        `normal ${metric} violation remains`
      );
    }

    const cleanGateway = buildRecord({
      profiling: instrumentedProfiling,
      resourceRole: "gateway"
    });
    evaluateRecord(cleanGateway, scenario, {
      ...options,
      surface: {
        ...options.surface,
        resourcePrimaryRole: "gateway"
      }
    });
    assertEqual(cleanGateway.status, "FAIL", "unprofiled gateway resource overages remain fatal");
    assertEqual(
      cleanGateway.violations.some((violation) => violation.metric === "peakRssMb"),
      true,
      "gateway RSS remains gateable during a profiled run"
    );
    assertEqual(
      cleanGateway.performanceThresholdAssessment?.skipped.some(
        (assessment) => assessment.metric === "peakRssMb"
      ),
      false,
      "gateway RSS is not mislabeled as instrumented"
    );

    const cleanStartup = buildRecord({
      profiling: instrumentedProfiling,
      durationMs: 200,
      resourceRole: "gateway"
    });
    cleanStartup.phases[0].results[0].command = "ocm service start kova-self-check";
    evaluateRecord(cleanStartup, {
      id: "instrumented-clean-startup",
      thresholds: { gatewayReadyMs: 100 }
    }, {
      ...options,
      surface: {
        ...options.surface,
        resourcePrimaryRole: "gateway"
      }
    });
    assertEqual(cleanStartup.status, "FAIL", "unprofiled gateway startup latency remains fatal");
    assertEqual(
      cleanStartup.violations.some((violation) => violation.metric === "coldReadyMs"),
      true,
      "gateway startup latency is not mislabeled as instrumented"
    );

    const functionalFailure = buildRecord({
      profiling: instrumentedProfiling,
      status: "FAIL",
      commandStatus: 1
    });
    evaluateRecord(functionalFailure, scenario, options);
    assertEqual(functionalFailure.status, "FAIL", "instrumentation never hides command failure");

    const malformed = buildRecord({
      profiling: instrumentedProfiling,
      durationMs: "200"
    });
    evaluateRecord(malformed, scenario, options);
    assertEqual(malformed.status, "BLOCKED", "instrumentation never hides malformed evidence");
    assertEqual(
      malformed.violations.some((violation) => violation.failureDomain === "kova-harness"),
      true,
      "malformed performance evidence remains a harness blocker"
    );

    const gateProfile = {
      id: "instrumented-performance",
      purpose: "release",
      gate: {
        id: "instrumented-performance-gate",
        blocking: [{ scenario: scenario.id, state: "mock-openai-provider" }]
      }
    };
    const gate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      records: [instrumented]
    }, gateProfile);
    assertEqual(gate.verdict, "PARTIAL", "instrumented release evidence cannot ship");
    assertEqual(gate.ok, false, "instrumented release evidence is not gate-ok");
    assertEqual(gate.complete, false, "instrumented release evidence is incomplete");
    assertEqual(gate.partial, true, "instrumented release evidence is explicitly partial");
    assertEqual(
      gate.cards.some((card) =>
        card.kind === "instrumented-performance-thresholds" &&
        card.required === true
      ),
      true,
      "gate explains the instrumented performance gap"
    );
    const repeatedInstrumented = structuredClone(instrumented);
    repeatedInstrumented.performanceThresholdAssessment.skipped =
      repeatedInstrumented.performanceThresholdAssessment.skipped.toReversed();
    const repeatedGate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      records: [instrumented, repeatedInstrumented]
    }, gateProfile);
    const repeatedCards = repeatedGate.cards.filter(
      (card) => card.kind === "instrumented-performance-thresholds"
    );
    assertEqual(repeatedCards.length, 2, "repeat records retain one instrumented card each");
    assertEqual(
      repeatedGate.instrumentedPerformanceIncompleteCount,
      2,
      "repeat instrumented cards remain independently required"
    );
    assertEqual(
      repeatedCards.map((card) => card.measurements.firstMetric).join(","),
      [
        instrumented.performanceThresholdAssessment.skipped[0].metric,
        repeatedInstrumented.performanceThresholdAssessment.skipped[0].metric
      ].join(","),
      "repeat cards retain their owning record assessment"
    );
    assertEqual(
      isInstrumentedPerformanceMetric("agentMetadataScanCount"),
      false,
      "instrumentation never masks behavioral count thresholds"
    );
    assertEqual(
      isInstrumentedPerformanceMetric("resourceSampleCount"),
      false,
      "instrumentation never masks resource evidence counts"
    );
    const profilingArtifactMetrics = [
      "v8ReportCount",
      "heapSnapshotCount",
      "diagnosticArtifactBytes",
      "nodeCpuProfileCount",
      "nodeHeapProfileCount",
      "nodeTraceEventCount",
      "nodeProfileArtifactBytes",
      "nodeProfileTopFunctionMs",
      "heapSnapshotBytes"
    ];
    for (const metric of profilingArtifactMetrics) {
      assertEqual(
        isProfilingArtifactMetric(metric),
        true,
        `profiling artifact taxonomy includes ${metric}`
      );
      assertEqual(
        isInstrumentedPerformanceMetric(metric),
        false,
        `profiling artifact threshold remains gateable for ${metric}`
      );
    }
    for (const metric of [
      "soakDurationMs",
      "execTimeoutMs",
      "mcpShutdownMs",
      "agentCleanupMs",
      "statusAfterFailureMs"
    ]) {
      assertEqual(
        isInstrumentedPerformanceMetric(metric),
        false,
        `instrumentation never masks functional timing contract ${metric}`
      );
    }

    const soakMinimum = {
      scenario: "instrumented-soak-minimum",
      surface: "soak",
      title: "Instrumented Soak Minimum",
      state: { id: "fresh" },
      status: "PASS",
      profiling: instrumentedProfiling,
      phases: [{
        id: "soak",
        measurementScope: "product",
        results: [{
          command: "node support/run-soak-loop.mjs",
          status: 0,
          durationMs: 1000,
          stdout: JSON.stringify({
            schemaVersion: "kova.soakLoop.v1",
            durationMs: 1000,
            iterations: 1,
            commandSummary: {
              p95Ms: 10,
              maxMs: 10,
              failureCount: 0
            },
            healthSummary: {
              p95Ms: 10,
              maxMs: 10,
              failureCount: 0
            }
          })
        }]
      }],
      finalMetrics: {
        service: { gatewayState: "disabled" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(soakMinimum, {
      id: "instrumented-soak-minimum",
      thresholds: { soakMinDurationMs: 15000 }
    }, {
      surface: { id: "soak", thresholds: {} },
      targetPlan: { kind: "local-build" }
    });
    assertEqual(soakMinimum.status, "FAIL", "instrumentation never hides a short soak");
    assertEqual(
      soakMinimum.violations.some((violation) => violation.metric === "soakDurationMs"),
      true,
      "soak minimum remains a fatal functional contract"
    );
    assertEqual(
      soakMinimum.performanceThresholdAssessment?.complete,
      true,
      "profiled records retain an explicit complete threshold assessment"
    );
    assertEqual(
      soakMinimum.performanceThresholdAssessment?.skippedCount,
      0,
      "complete threshold assessments retain a zero skipped count"
    );

    const platform = {
      os: process.platform,
      arch: process.arch,
      release: "self-check",
      node: process.version
    };
    const target = "local-build:/tmp/openclaw";
    const targetPlan = { kind: "local-build", value: "/tmp/openclaw" };
    const baselineRecord = syntheticPerformanceRecord(1, {
      peakRssMb: 500,
      resourcePeakGatewayRssMb: 500,
      cpuPercentMax: 25,
      agentTurnMs: 2000
    });
    baselineRecord.repeat = { index: 1, total: 1 };
    const baselineReport = syntheticPerformanceReport({
      runId: "instrumented-baseline",
      platform,
      target,
      records: [baselineRecord]
    });
    baselineReport.controls = { parallel: 1 };
    baselineReport.performance = buildPerformanceSummary(baselineReport.records, {
      repeat: 1,
      parallel: 1
    });
    const store = updateBaselineStore({
      schemaVersion: "kova.baselines.v1",
      entries: {}
    }, baselineReport, {
      targetPlan,
      reviewedGood: true
    });
    const currentRecord = structuredClone(baselineRecord);
    currentRecord.measurements.peakRssMb = 1500;
    currentRecord.measurements.resourcePeakGatewayRssMb = 500;
    currentRecord.measurements.cpuPercentMax = 80;
    currentRecord.measurements.agentTurnMs = 5000;
    currentRecord.profiling = instrumentedProfiling;
    currentRecord.phases = structuredClone(instrumented.phases);
    currentRecord.performanceThresholdAssessment =
      instrumented.performanceThresholdAssessment;
    currentRecord.measurements.profilingAffectsPerformanceMeasurements = true;
    currentRecord.measurements.performanceThresholdSkippedCount =
      currentRecord.performanceThresholdAssessment.skippedCount;
    const currentReport = syntheticPerformanceReport({
      runId: "instrumented-current",
      platform,
      target,
      records: [currentRecord]
    });
    currentReport.performance = buildPerformanceSummary(currentReport.records, {
      repeat: 1,
      parallel: 1
    });
    const baselineComparison = comparePerformanceToBaseline(currentReport, store, {
      targetPlan,
      regressionThresholds: {
        rssRegressionPercent: 1,
        cpuRegressionPercent: 1,
        agentLatencyRegressionPercent: 1
      }
    });
    assertEqual(baselineComparison.ok, true, "instrumented baseline values cannot regress a clean baseline");
    assertEqual(baselineComparison.regressionCount, 0, "instrumented baseline comparison has no regressions");
    assertEqual(
      baselineComparison.groups[0]?.metricComparisons?.peakRssMb?.comparable,
      false,
      "instrumented baseline RSS is non-comparable"
    );
    assertEqual(
      baselineComparison.groups[0]?.metricComparisons?.peakRssMb?.reason,
      "instrumented-performance-measurement",
      "instrumented baseline skip reason is explicit"
    );
    assertEqual(
      baselineComparison.groups[0]?.metricComparisons?.resourcePeakGatewayRssMb?.comparable,
      true,
      "clean gateway RSS remains comparable during an instrumented run"
    );
    const baselineGateReport = structuredClone(currentReport);
    baselineGateReport.records[0].performanceThresholdAssessment = {
      schemaVersion: "kova.performanceThresholdAssessment.v1",
      complete: true,
      skippedCount: 0,
      reason: null,
      rerun: null,
      skipped: []
    };
    baselineGateReport.records[0].measurements.performanceThresholdSkippedCount = 0;
    baselineGateReport.baseline = { comparison: baselineComparison };
    const baselineGate = evaluateGate(baselineGateReport, {
      id: "instrumented-baseline-gate",
      purpose: "release",
      gate: {
        blocking: [{
          scenario: baselineGateReport.records[0].scenario,
          state: baselineGateReport.records[0].state.id
        }]
      }
    });
    const baselineCards = baselineGate.cards.filter(
      (card) => card.kind === "instrumented-performance-thresholds"
    );
    assertEqual(baselineCards.length, 1, "instrumented baseline emits one deduplicated card");
    assertEqual(
      baselineCards[0].measurements.skippedMetrics.join(","),
      baselineComparison.instrumentedPerformanceGroups[0].skippedMetrics.join(","),
      "instrumented baseline card retains comparison evidence"
    );
    assertEqual(
      baselineGate.instrumentedPerformanceIncompleteCount,
      1,
      "required instrumented baseline evidence keeps the gate partial"
    );

    const artifactBaselineReport = structuredClone(baselineReport);
    Object.assign(artifactBaselineReport.records[0].measurements, {
      v8ReportCount: 0,
      heapSnapshotCount: 0,
      diagnosticArtifactBytes: 0,
      nodeCpuProfileCount: 0,
      nodeHeapProfileCount: 0,
      nodeTraceEventCount: 0,
      nodeProfileArtifactBytes: 0,
      nodeProfileTopFunctionMs: null,
      heapSnapshotBytes: 0
    });
    artifactBaselineReport.performance = buildPerformanceSummary(
      artifactBaselineReport.records,
      { repeat: 1, parallel: 1 }
    );
    const artifactCurrentReport = structuredClone(currentReport);
    Object.assign(artifactCurrentReport.records[0].measurements, {
      v8ReportCount: 0,
      heapSnapshotCount: 0,
      diagnosticArtifactBytes: 0,
      nodeCpuProfileCount: 6,
      nodeHeapProfileCount: 6,
      nodeTraceEventCount: 6,
      nodeProfileArtifactBytes: 169517767,
      nodeProfileTopFunctionMs: 15285.75,
      heapSnapshotBytes: 0
    });
    artifactCurrentReport.performance = buildPerformanceSummary(
      artifactCurrentReport.records,
      { repeat: 1, parallel: 1 }
    );
    const reportComparison = compareReports(
      artifactBaselineReport,
      artifactCurrentReport,
      {
        thresholds: {
          peakRssMb: 1,
          cpuPercentMax: 1,
          agentTurnMs: 1
        }
      }
    );
    const comparedScenario = reportComparison.scenarios[0];
    assertEqual(comparedScenario.regressions.length, 0, "cross-mode report compare has no false regression");
    assertEqual(comparedScenario.metrics.peakRssMb.comparable, false, "cross-mode report RSS is non-comparable");
    assertEqual(
      reportComparison.performanceProfileMismatchCount,
      1,
      "cross-mode report comparison records one profile mismatch"
    );
    for (const metric of profilingArtifactMetrics) {
      assertEqual(
        comparedScenario.metrics[metric].comparable,
        false,
        `cross-mode report marks ${metric} non-comparable`
      );
      assertEqual(
        comparedScenario.skippedMetrics.includes(metric),
        true,
        `cross-mode report records skipped ${metric}`
      );
    }
    assertEqual(
      comparedScenario.metrics.nodeProfileArtifactBytes.delta,
      null,
      "cross-mode report suppresses profile artifact deltas"
    );
    assertEqual(reportComparison.result, "INCONCLUSIVE", "cross-mode report comparison is inconclusive");
    assertEqual(reportComparison.ok, false, "inconclusive report comparison is not successful");
    assertEqual(reportComparison.complete, false, "inconclusive report comparison is incomplete");
    assertEqual(
      renderCompareSummary(reportComparison).includes("Result: INCONCLUSIVE"),
      true,
      "plain comparison renders the inconclusive result"
    );
    assertEqual(
      renderCompareAssessment(
        reportComparison,
        { color: "never", full: true },
        process.env,
        process.stdout
      ).includes("[INCONCLUSIVE]"),
      true,
      "default comparison renders the inconclusive result"
    );

    const reverseReportComparison = compareReports(
      artifactCurrentReport,
      artifactBaselineReport
    );
    assertEqual(
      reverseReportComparison.scenarios[0].metrics.nodeProfileArtifactBytes.comparable,
      false,
      "reverse cross-mode report profile artifacts are non-comparable"
    );
    assertEqual(
      reverseReportComparison.result,
      "INCONCLUSIVE",
      "reverse cross-mode report comparison is inconclusive"
    );

    const sameProfileArtifactBaseline = structuredClone(artifactCurrentReport);
    sameProfileArtifactBaseline.records[0].measurements.nodeProfileArtifactBytes =
      8 * 1024 * 1024;
    sameProfileArtifactBaseline.performance = buildPerformanceSummary(
      sameProfileArtifactBaseline.records,
      { repeat: 1, parallel: 1 }
    );
    const sameProfileArtifactComparison = compareReports(
      sameProfileArtifactBaseline,
      artifactCurrentReport
    );
    assertEqual(
      sameProfileArtifactComparison.scenarios[0].metrics.nodeProfileArtifactBytes.comparable,
      true,
      "same-profile report artifacts remain comparable"
    );
    assertEqual(
      sameProfileArtifactComparison.scenarios[0].regressions.some(
        (regression) => regression.metric === "nodeProfileArtifactBytes"
      ),
      true,
      "same-profile report artifacts can regress"
    );
    assertEqual(
      sameProfileArtifactComparison.result,
      "REGRESSED",
      "same-profile artifact growth remains a regression"
    );

    const failedBaselineReport = structuredClone(baselineReport);
    failedBaselineReport.records[0].status = "FAIL";
    failedBaselineReport.records[0].violations = [{
      kind: "threshold",
      metric: "peakRssMb",
      expected: "<= 400",
      actual: 500,
      message: "primary RSS 500 MB exceeded threshold 400 MB"
    }];
    failedBaselineReport.performance = buildPerformanceSummary(
      failedBaselineReport.records,
      { repeat: 1, parallel: 1 }
    );
    const inconclusiveComparison = compareReports(
      failedBaselineReport,
      currentReport
    );
    assertEqual(
      inconclusiveComparison.statusChanges.inconclusive.length,
      1,
      "instrumented evidence does not claim a prior performance failure improved"
    );
    assertEqual(
      inconclusiveComparison.findingChanges.inconclusive.some(
        (finding) => finding.metric === "peakRssMb"
      ),
      true,
      "instrumented evidence does not claim a prior performance finding resolved"
    );

    const instrumentedFailedReport = structuredClone(currentReport);
    instrumentedFailedReport.records[0].status = "FAIL";
    instrumentedFailedReport.records[0].violations = [{
      kind: "threshold",
      metric: "peakRssMb",
      expected: "<= 1000",
      actual: 1500,
      message: "primary RSS 1500 MB exceeded threshold 1000 MB"
    }];
    instrumentedFailedReport.performance = buildPerformanceSummary(
      instrumentedFailedReport.records,
      { repeat: 1, parallel: 1 }
    );
    const newInstrumentedFailure = compareReports(
      baselineReport,
      instrumentedFailedReport
    );
    assertEqual(
      newInstrumentedFailure.regressionCount,
      0,
      "instrumented performance failure does not create a false regression"
    );
    assertEqual(
      newInstrumentedFailure.statusChanges.inconclusive.length,
      1,
      "normal pass to instrumented performance failure is inconclusive"
    );
    assertEqual(
      newInstrumentedFailure.findingChanges.inconclusive.some(
        (finding) =>
          finding.metric === "peakRssMb" &&
          finding.comparisonDirection === "new"
      ),
      true,
      "new instrumented performance finding is inconclusive"
    );

    const repairedAfterInstrumentedFailure = compareReports(
      instrumentedFailedReport,
      baselineReport
    );
    assertEqual(
      repairedAfterInstrumentedFailure.statusChanges.inconclusive.length,
      1,
      "instrumented failure to normal pass is inconclusive"
    );
    assertEqual(
      repairedAfterInstrumentedFailure.findingChanges.resolved.length,
      0,
      "normal evidence does not claim an instrumented finding resolved"
    );

    const instrumentedPassReport = structuredClone(currentReport);
    instrumentedPassReport.records[0].measurements.peakRssMb = 500;
    instrumentedPassReport.performance = buildPerformanceSummary(
      instrumentedPassReport.records,
      { repeat: 1, parallel: 1 }
    );
    const sameProfileComparison = compareReports(
      instrumentedFailedReport,
      instrumentedPassReport
    );
    assertEqual(
      sameProfileComparison.statusChanges.improvements.length,
      1,
      "same-profile instrumented evidence can prove an improvement"
    );
    assertEqual(
      sameProfileComparison.findingChanges.resolved.some(
        (finding) => finding.metric === "peakRssMb"
      ),
      true,
      "same-profile instrumented evidence can resolve a finding"
    );

    const doctorFailureRecord = structuredClone(baselineRecord);
    doctorFailureRecord.status = "FAIL";
    doctorFailureRecord.measurements.doctorFixMs = 500;
    doctorFailureRecord.violations = [{
      kind: "threshold",
      metric: "doctorFixMs",
      expected: "<= 100",
      actual: 500,
      message: "doctor repair took 500ms, over threshold 100ms"
    }];
    const doctorFailureReport = syntheticPerformanceReport({
      runId: "normal-doctor-failure",
      platform,
      target,
      records: [doctorFailureRecord]
    });
    const instrumentedDoctorRecord = structuredClone(doctorFailureRecord);
    delete instrumentedDoctorRecord.violations;
    instrumentedDoctorRecord.profiling = instrumentedProfiling;
    instrumentedDoctorRecord.phases = [{
      id: "doctor",
      measurementScope: "product",
      results: [{
        command: "node support/run-doctor-repair.mjs",
        status: 0,
        timedOut: false,
        durationMs: 500
      }]
    }];
    instrumentedDoctorRecord.performanceThresholdAssessment = {
      schemaVersion: "kova.performanceThresholdAssessment.v1",
      complete: false,
      skippedCount: 1,
      reason: "instrumented-performance-measurement",
      rerun: "rerun without profiling for gateable performance evidence",
      skipped: [{
        metric: "doctorFixMs",
        measurementMetric: "doctorFixMs",
        role: null,
        status: "SKIPPED",
        reason: "instrumented-performance-measurement",
        threshold: 100,
        actual: 500,
        observedOverThreshold: true,
        affectsRecordStatus: false,
        message: "doctorFixMs was not adjudicated because the run was instrumented"
      }]
    };
    const instrumentedDoctorReport = syntheticPerformanceReport({
      runId: "instrumented-doctor-failure",
      platform,
      target,
      records: [instrumentedDoctorRecord]
    });
    const findingOnlyInconclusive = compareReports(
      doctorFailureReport,
      instrumentedDoctorReport
    );
    assertEqual(
      findingOnlyInconclusive.performanceProfileMismatchCount,
      0,
      "finding-only profiler mismatch does not require a headline metric mismatch"
    );
    assertEqual(
      findingOnlyInconclusive.findingChanges.inconclusive.length,
      1,
      "finding-only profiler mismatch remains explicit"
    );
    assertEqual(
      findingOnlyInconclusive.result,
      "INCONCLUSIVE",
      "finding-only profiler mismatch cannot return OK"
    );
    assertEqual(
      findingOnlyInconclusive.complete,
      false,
      "finding-only profiler mismatch is incomplete"
    );

    const evidenceFailureRecord = structuredClone(instrumentedFailedReport.records[0]);
    evidenceFailureRecord.evidenceLedger = {
      schemaVersion: "kova.evidenceLedger.v1",
      completeness: "complete",
      summary: {},
      entries: [{
        id: "invariant:agent-cleanup",
        category: "invariant",
        required: true,
        status: "failed",
        summary: "agent cleanup invariant failed"
      }]
    };
    const evidenceFailureReport = syntheticPerformanceReport({
      runId: "instrumented-evidence-failure",
      platform,
      target,
      records: [evidenceFailureRecord]
    });
    const evidenceFailureComparison = compareReports(
      baselineReport,
      evidenceFailureReport
    );
    assertEqual(
      evidenceFailureComparison.scenarios[0]?.performanceComparison?.statusInconclusive,
      false,
      "independent evidence failure is not downgraded to profiler-inconclusive"
    );
    assertEqual(
      evidenceFailureComparison.statusChanges.regressions.length,
      1,
      "independent evidence failure remains a status regression"
    );
    assertEqual(
      evidenceFailureComparison.result,
      "REGRESSED",
      "independent evidence failure remains blocking"
    );

    return {
      id: "instrumented-performance-threshold-policy",
      status: "PASS",
      command: "evaluate instrumented performance threshold policy",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "instrumented-performance-threshold-policy",
      status: "FAIL",
      command: "evaluate instrumented performance threshold policy",
      durationMs: 0,
      message: error.message
    };
  }
}

export function roleThresholdEvaluationCheck() {
  try {
    const sourceRecord = {
      scenario: "synthetic-role-threshold",
      title: "Synthetic Role Threshold",
      status: "PASS",
      phases: [
        {
          id: "sample",
          results: [
            {
              command: "synthetic",
              status: 0,
              durationMs: 1,
              resourceSamples: {
                schemaVersion: "kova.resourceSamples.v1",
                sampleCount: 1,
                peakTotalRssMb: 250,
                maxTotalCpuPercent: 80,
                byRole: {
                  gateway: {
                    peakRssMb: 250,
                    maxCpuPercent: 80,
                    peakRssAtMs: 10,
                    peakCpuAtMs: 10,
                    peakProcessCount: 1
                  }
                },
                topRolesByRss: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
                topRolesByCpu: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
                topByRss: [],
                topByCpu: []
              }
            }
          ],
          metrics: {
            logs: zeroLogMetrics()
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    const record = structuredClone(sourceRecord);
    evaluateRecord(record, { thresholds: {} }, {
      surface: {
        thresholds: {},
        roleThresholds: {
          gateway: { peakRssMb: 100, maxCpuPercent: 50 }
        }
      }
    });
    assertEqual(record.status, "FAIL", "role threshold status");
    assertEqual(record.measurements.resourceByRole.gateway.peakRssMb, 250, "gateway role RSS measurement");
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"),
      true,
      "role RSS violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.maxCpuPercent"),
      true,
      "role CPU violation"
    );
    const reportScenarios = aggregateScenarios({
      records: [record],
      summary: { total: 1, statuses: { FAIL: 1 } }
    });
    const peakRow = reportScenarios[0]?.metrics?.find((metric) => metric.key === "peakRssMb");
    const gatewayRow = reportScenarios[0]?.metrics?.find((metric) => metric.key === "peakRssMb#gateway");
    assertEqual(peakRow?.status, "FAIL", "parent RSS row inherits failed role child status");
    assertEqual(gatewayRow?.status, "FAIL", "gateway role child row fails");

    const deduplicatedRecord = structuredClone(sourceRecord);
    evaluateRecord(deduplicatedRecord, {
      thresholds: {
        peakRssMb: 100,
        cpuPercentMax: 50
      }
    }, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        roleThresholds: {
          gateway: { peakRssMb: 50, maxCpuPercent: 40 }
        }
      }
    });
    const deduplicatedMetrics = deduplicatedRecord.violations.map((violation) => violation.metric);
    assertEqual(deduplicatedMetrics.includes("peakRssMb"), true, "primary RSS threshold remains active");
    assertEqual(deduplicatedMetrics.includes("cpuPercentMax"), true, "primary CPU threshold remains active");
    assertEqual(
      deduplicatedRecord.violations.find((violation) => violation.metric === "peakRssMb")?.expected,
      "<= 50",
      "headline RSS enforces the stricter primary-role threshold"
    );
    assertEqual(
      deduplicatedRecord.violations.find((violation) => violation.metric === "cpuPercentMax")?.expected,
      "<= 40",
      "headline CPU enforces the stricter primary-role threshold"
    );
    assertEqual(
      deduplicatedMetrics.includes("resourceByRole.gateway.peakRssMb"),
      false,
      "primary RSS role threshold is not duplicated"
    );
    assertEqual(
      deduplicatedMetrics.includes("resourceByRole.gateway.maxCpuPercent"),
      false,
      "primary CPU role threshold is not duplicated"
    );

    const malformedPrimaryRoleRecord = structuredClone(sourceRecord);
    evaluateRecord(malformedPrimaryRoleRecord, {
      thresholds: {
        peakRssMb: 100,
        cpuPercentMax: 50
      }
    }, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        roleThresholds: {
          gateway: { peakRssMb: "invalid", maxCpuPercent: "invalid" }
        }
      }
    });
    const malformedPrimaryRoleViolations = malformedPrimaryRoleRecord.violations.filter(
      (violation) => violation.failureDomain === "kova-harness"
    );
    assertEqual(
      malformedPrimaryRoleViolations.some(
        (violation) => violation.metric === "resourceByRole.gateway.peakRssMb"
      ),
      true,
      "deduplicated primary RSS threshold remains validated"
    );
    assertEqual(
      malformedPrimaryRoleViolations.some(
        (violation) => violation.metric === "resourceByRole.gateway.maxCpuPercent"
      ),
      true,
      "deduplicated primary CPU threshold remains validated"
    );
    return {
      id: "resource-role-thresholds",
      status: "PASS",
      command: "evaluate synthetic role resource thresholds",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-role-thresholds",
      status: "FAIL",
      command: "evaluate synthetic role resource thresholds",
      durationMs: 0,
      message: error.message
    };
  }
}

export function thresholdPolicyCalibrationCheck() {
  try {
    const record = {
      scenario: "synthetic-threshold-policy",
      title: "Synthetic Threshold Policy",
      status: "PASS",
      phases: [{
        id: "sample",
        results: [
          {
            command: "ocm start kova-threshold-test --no-service",
            status: 0,
            durationMs: 300
          },
          {
            command: "ocm service start kova-threshold-test",
            status: 0,
            durationMs: 150,
            resourceSamples: {
              schemaVersion: "kova.resourceSamples.v1",
              cpuCoverageComplete: true,
              cpuMeasurementContract: process.platform === "linux" ? "linux-process-interval-v1" : "ps-process-cpu-v1",
              sampleCount: 1,
              peakTotalRssMb: 250,
              maxTotalCpuPercent: 80,
              byRole: {
                gateway: {
                  peakRssMb: 250,
                  maxCpuPercent: 80,
                  peakRssAtMs: 10,
                  peakCpuAtMs: 10,
                  peakProcessCount: 1
                }
              },
              topRolesByRss: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
              topRolesByCpu: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
              topByRss: [],
              topByCpu: []
            }
          }
        ],
        metrics: { logs: zeroLogMetrics() }
      }],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, {
      id: "synthetic-threshold-policy",
      thresholds: {}
    }, {
      profile: {
        id: "release",
        calibration: {
          roles: {
            gateway: { peakRssMb: 200 }
          },
          surfaces: {
            "release-runtime-startup": {
              thresholds: { coldReadyMs: 100 }
            }
          }
        }
      },
      surface: {
        id: "release-runtime-startup",
        thresholds: { coldReadyMs: 1000 },
        roleThresholds: {}
      }
    });
    assertEqual(record.status, "FAIL", "profile calibration threshold should fail record");
    assertEqual(record.thresholdPolicy?.profileId, "release", "threshold policy profile id");
    assertEqual(record.thresholdPolicy?.thresholds?.coldReadyMs, 100, "profile surface threshold override");
    assertEqual(record.thresholdPolicy?.roleThresholds?.gateway?.peakRssMb, 200, "profile role threshold");
    assertEqual(record.measurements?.coldReadyMs, 150, "cold-ready metric ignores no-service provisioning");
    assertEqual(
      record.violations.some((violation) => violation.metric === "coldReadyMs"),
      true,
      "profile calibrated duration violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"),
      true,
      "profile calibrated role violation"
    );
    const runtimeThresholdSurface = {
      id: "runtime-major-threshold",
      thresholds: {},
      roleThresholds: {
        gateway: {
          peakRssMb: {
            baselineByNodeMajor: { "22": 730, "24": 1085 },
            maxRegressionPercent: 10,
            absoluteCeilingMb: 1200
          }
        }
      }
    };
    const runtimeOptions = (targetRuntime) => ({
      targetRuntime,
      surface: runtimeThresholdSurface
    });
    const trustedRuntime = (nodeVersion) => ({
      collectionStatus: "ok",
      nodeVersion,
      gatewayPid: 4242,
      expectedGatewayPid: 4242,
      gatewayPort: 19000,
      expectedGatewayPort: 19000
    });
    const runtimeMismatch = structuredClone(record);
    runtimeMismatch.status = "PASS";
    delete runtimeMismatch.violations;
    const runtimeResources = runtimeMismatch.phases
      .flatMap((phase) => phase.results)
      .find((result) => result.resourceSamples)?.resourceSamples;
    assertEqual(Boolean(runtimeResources), true, "runtime mismatch fixture has resource samples");
    runtimeResources.peakTotalRssMb = 805;
    runtimeResources.byRole.gateway.peakRssMb = 805;
    runtimeResources.topRolesByRss[0].peakRssMb = 805;
    evaluateRecord(
      runtimeMismatch,
      { id: "runtime-major-threshold", thresholds: {} },
      runtimeOptions(trustedRuntime("v22.22.3"))
    );
    assertEqual(runtimeMismatch.thresholdPolicy?.roleThresholds?.gateway?.peakRssMb, 803, "evaluator uses measured Node major instead of Kova runner major");
    assertEqual(runtimeMismatch.status, "FAIL", "measured Node 22 runtime applies its stricter RSS gate");

    const untrustedRuntime = structuredClone(runtimeMismatch);
    untrustedRuntime.status = "PASS";
    delete untrustedRuntime.violations;
    const unavailableRuntime = {
      collectionStatus: "command-failed",
      nodeVersion: null,
      gatewayPid: null,
      expectedGatewayPid: 4242,
      gatewayPort: null,
      expectedGatewayPort: 19000
    };
    evaluateRecord(
      untrustedRuntime,
      { id: "runtime-major-threshold", thresholds: {} },
      runtimeOptions(unavailableRuntime)
    );
    assertEqual(untrustedRuntime.thresholdPolicy?.roleThresholds?.gateway?.peakRssMb, 1200, "untrusted runtime remains absolutely bounded");
    assertEqual(untrustedRuntime.status, "BLOCKED", "untrusted runtime identity blocks calibrated RSS evidence");
    assertEqual(
      untrustedRuntime.violations.some((violation) =>
        violation.metric === "targetRuntime.nodeVersion" &&
        violation.failureDomain === "kova-harness"
      ),
      true,
      "untrusted runtime identity is attributed to the Kova harness"
    );
    evaluateRecord(
      untrustedRuntime,
      { id: "runtime-major-threshold", thresholds: {} },
      runtimeOptions(unavailableRuntime)
    );
    assertEqual(untrustedRuntime.status, "BLOCKED", "runtime identity blocker survives repeated evaluation");

    const futureRuntime = structuredClone(untrustedRuntime);
    futureRuntime.status = "PASS";
    delete futureRuntime.violations;
    evaluateRecord(
      futureRuntime,
      { id: "runtime-major-threshold", thresholds: {} },
      runtimeOptions(trustedRuntime("v26.0.0"))
    );
    assertEqual(futureRuntime.status, "PASS", "trusted future Node major uses the bounded fallback");
    assertEqual(futureRuntime.thresholdPolicy?.runtimeCalibration?.[0]?.baselineMb, null, "future Node major reports missing baseline");
    const scenarioRolePolicy = resolveThresholdPolicy({
      scenario: {
        id: "scenario-role-policy",
        thresholds: {
          coldReadyMs: 100,
          roleThresholds: {
            gateway: { peakRssMb: 200 }
          }
        }
      }
    });
    const scenarioSource = scenarioRolePolicy.report.sources.find((source) => source.kind === "scenario");
    const scenarioRoleSource = scenarioRolePolicy.report.sources.find((source) => source.kind === "scenario-role");
    assertEqual(JSON.stringify(scenarioSource?.thresholds), JSON.stringify(["coldReadyMs"]), "scenario scalar threshold provenance");
    assertEqual(JSON.stringify(scenarioRoleSource?.roles), JSON.stringify(["gateway"]), "scenario role threshold provenance");
    return {
      id: "threshold-policy-calibration",
      status: "PASS",
      command: "evaluate synthetic profile threshold calibration",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "threshold-policy-calibration",
      status: "FAIL",
      command: "evaluate synthetic profile threshold calibration",
      durationMs: 0,
      message: error.message
    };
  }
}
