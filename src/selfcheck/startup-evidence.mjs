import { evaluateRecord } from "../evaluator.mjs";
import { buildReleaseRuntimeStartupEvidenceInvariants } from "../evidence/invariants.mjs";
import { syntheticReleaseStartupResourceSamples, zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function releaseRuntimeStartupEvidenceInvariantCheck() {
  try {
    const record = {
      scenario: "release-runtime-startup",
      surface: "release-runtime-startup",
      status: "PASS",
      phases: [
        {
          id: "provision",
          results: [{
            command: "ocm start kova-release-startup --runtime stable --json",
            status: 0,
            durationMs: 1200,
            stdout: JSON.stringify({
              defaultRuntime: "stable",
              gatewayPort: 43111,
              serviceRequested: true,
              serviceStarted: true
            }),
            resourceSamples: syntheticReleaseStartupResourceSamples("/tmp/kova/resources/provision-1.jsonl")
          }],
          metrics: {
            service: {
              gatewayState: "running",
              gatewayPort: 43111,
              runtimeReleaseChannel: "stable",
              runtimeReleaseVersion: "2026.5.7"
            },
            readiness: {
              classification: {
                state: "ready",
                severity: "ok",
                reason: null
              },
              listeningReadyAtMs: 900,
              healthReadyAtMs: 1500,
              thresholdMs: 30000,
              deadlineMs: 120000,
              attempts: 2,
              healthAttempts: [
                { ok: false, durationMs: 5 },
                { ok: true, durationMs: 4 }
              ]
            }
          }
        },
        {
          id: "post-start",
          results: [
            { command: "ocm service status kova-release-startup --json", status: 0, durationMs: 50, stdout: "{\"gatewayState\":\"running\"}" },
            { command: "ocm @kova-release-startup -- status", status: 0, durationMs: 80, stdout: "OpenClaw ready\n" },
            { command: "ocm @kova-release-startup -- plugins list", status: 0, durationMs: 90, stdout: "core\n" }
          ],
          metrics: {
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 1,
              p50Ms: 1,
              p95Ms: 1,
              maxMs: 1
            },
            collectors: [
              { id: "service", status: "PASS", durationMs: 5 },
              { id: "logs", status: "PASS", durationMs: 5, artifactCount: 1 }
            ],
            logs: zeroLogMetrics()
          }
        },
        {
          id: "startup-logs",
          results: [{
            command: "ocm logs kova-release-startup --tail 400 --raw",
            status: 0,
            durationMs: 40,
            stdout: "gateway ready\nplugins loaded\n"
          }],
          metrics: {
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 1,
              p50Ms: 1,
              p95Ms: 1,
              maxMs: 1
            },
            collectors: [
              { id: "service", status: "PASS", durationMs: 5 },
              { id: "logs", status: "PASS", durationMs: 5, artifactCount: 1 }
            ],
            logs: {
              ...zeroLogMetrics(),
              commandStatus: 0,
              artifacts: ["/tmp/kova/logs/gateway-tail.log"]
            },
            timeline: {
              available: true,
              eventCount: 12,
              parseErrorCount: 0,
              artifacts: ["/tmp/kova/openclaw/timeline.jsonl"],
              keySpans: {
                "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
                "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
                "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
              },
              spanTotals: {
                "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
                "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
                "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
              },
              openSpanCount: 0,
              openSpans: [],
              runtimeDeps: {},
              eventLoop: {},
              providers: {},
              childProcesses: {}
            }
          }
        }
      ],
      finalMetrics: {
        service: {
          gatewayState: "running",
          gatewayPort: 43111,
          runtimeReleaseChannel: "stable",
          runtimeReleaseVersion: "2026.5.7"
        },
        health: { ok: true, durationMs: 1 },
        healthSummary: {
          count: 1,
          okCount: 1,
          failureCount: 0,
          minMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          maxMs: 1
        },
        logs: zeroLogMetrics(),
        timeline: {
          available: true,
          eventCount: 12,
          parseErrorCount: 0,
          artifacts: ["/tmp/kova/openclaw/timeline.jsonl"],
          keySpans: {
            "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
            "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
            "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
          },
          spanTotals: {
            "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
            "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
            "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
          },
          openSpanCount: 0,
          openSpans: [],
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    const scenario = {
      id: "release-runtime-startup",
      surface: "release-runtime-startup",
      thresholds: {},
      phases: [
        { id: "provision", healthScope: "readiness" },
        { id: "post-start", healthScope: "post-ready" },
        { id: "startup-logs", healthScope: "post-ready" }
      ]
    };
    evaluateRecord(record, scenario, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        diagnostics: { expectedSpans: ["gateway.ready", "plugins.metadata.scan", "plugins.load"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const invariants = buildReleaseRuntimeStartupEvidenceInvariants(record, scenario);
    assertEqual(invariants.length, 9, "release runtime startup invariant count");
    assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "complete release startup evidence passes invariants");

    const collectorOnlyRecord = JSON.parse(JSON.stringify(record));
    collectorOnlyRecord.phases[1].results = collectorOnlyRecord.phases[1].results.filter((result) => !result.command.startsWith("ocm service status "));
    collectorOnlyRecord.phases[2].results = [];
    evaluateRecord(collectorOnlyRecord, scenario, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        diagnostics: { expectedSpans: ["gateway.ready", "plugins.metadata.scan", "plugins.load"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const collectorOnlyInvariants = buildReleaseRuntimeStartupEvidenceInvariants(collectorOnlyRecord, scenario);
    const receiptsProof = collectorOnlyInvariants.find((invariant) => invariant.id === "release-runtime-command-receipts");
    const logsProof = collectorOnlyInvariants.find((invariant) => invariant.id === "release-runtime-startup-logs-captured");
    assertEqual(receiptsProof?.status, "passed", "release startup collector receipts can replace service/log commands");
    assertEqual(logsProof?.status, "passed", "release startup collector log artifact can replace log command");

    const missingTimelineRecord = JSON.parse(JSON.stringify(record));
    missingTimelineRecord.finalMetrics.timeline.available = false;
    missingTimelineRecord.finalMetrics.timeline.eventCount = 0;
    missingTimelineRecord.phases[2].metrics.timeline.available = false;
    missingTimelineRecord.phases[2].metrics.timeline.eventCount = 0;
    evaluateRecord(missingTimelineRecord, scenario, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingTimelineInvariants = buildReleaseRuntimeStartupEvidenceInvariants(missingTimelineRecord, scenario);
    const timelineProof = missingTimelineInvariants.find((invariant) => invariant.id === "release-runtime-diagnostic-timeline-proof");
    assertEqual(timelineProof?.status, "missing", "missing diagnostic timeline is an incomplete evidence obligation");

    const stoppedRecord = JSON.parse(JSON.stringify(record));
    stoppedRecord.finalMetrics.service.gatewayState = "stopped";
    evaluateRecord(stoppedRecord, scenario, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const stoppedInvariants = buildReleaseRuntimeStartupEvidenceInvariants(stoppedRecord, scenario);
    const healthProof = stoppedInvariants.find((invariant) => invariant.id === "release-runtime-readiness-health-proof");
    assertEqual(healthProof?.status, "failed", "stopped final gateway state is failed evidence, not a pass");

    const misplacedProvisionRecord = JSON.parse(JSON.stringify(record));
    const misplacedStart = misplacedProvisionRecord.phases[0].results.shift();
    misplacedProvisionRecord.phases[1].results.push(misplacedStart);
    evaluateRecord(misplacedProvisionRecord, scenario, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const misplacedProvisionProof = buildReleaseRuntimeStartupEvidenceInvariants(misplacedProvisionRecord, scenario)
      .find((invariant) => invariant.id === "release-runtime-command-receipts");
    assertEqual(misplacedProvisionProof?.status, "missing", "release provision receipt must come from provision phase");

    for (const invalidDuration of [null, -1, Number.NaN]) {
      const invalidDurationRecord = JSON.parse(JSON.stringify(record));
      invalidDurationRecord.phases[0].results[0].durationMs = invalidDuration;
      const invalidDurationProof = buildReleaseRuntimeStartupEvidenceInvariants(invalidDurationRecord, scenario)
        .find((invariant) => invariant.id === "release-runtime-command-receipts");
      assertEqual(invalidDurationProof?.status, "missing", `phase receipt duration ${invalidDuration} is rejected`);
    }

    const missingFinalHealthRecord = JSON.parse(JSON.stringify(record));
    delete missingFinalHealthRecord.finalMetrics.health;
    delete missingFinalHealthRecord.finalMetrics.healthSummary;
    evaluateRecord(missingFinalHealthRecord, scenario, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingFinalHealthProof = buildReleaseRuntimeStartupEvidenceInvariants(missingFinalHealthRecord, scenario)
      .find((invariant) => invariant.id === "release-runtime-readiness-health-proof");
    assertEqual(missingFinalHealthProof?.status, "missing", "release proof requires explicit final health failure count");

    const incompleteHealthCounters = [
      ["post-ready failure count", (health) => delete health.postReadySamples.failureCount],
      ["fractional post-ready sample count", (health) => {
        health.postReadySamples.count = 1.5;
      }],
      ["negative final failure count", (health) => {
        health.final.failureCount = -1;
      }]
    ];
    for (const [label, mutate] of incompleteHealthCounters) {
      const incompleteHealthRecord = JSON.parse(JSON.stringify(record));
      mutate(incompleteHealthRecord.measurements.health);
      const incompleteHealthProof = buildReleaseRuntimeStartupEvidenceInvariants(incompleteHealthRecord, scenario)
        .find((invariant) => invariant.id === "release-runtime-readiness-health-proof");
      assertEqual(incompleteHealthProof?.status, "missing", `${label} is incomplete release health evidence`);
    }

    for (const malformedMeasurement of [null, "", " ", false]) {
      const malformedResourceRecord = JSON.parse(JSON.stringify(record));
      malformedResourceRecord.measurements.resourceByRole.gateway.peakRssMb = malformedMeasurement;
      const resourceProof = buildReleaseRuntimeStartupEvidenceInvariants(malformedResourceRecord, scenario)
        .find((invariant) => invariant.id === "release-runtime-resource-proof");
      assertEqual(resourceProof?.status, "missing", `resource measurement ${JSON.stringify(malformedMeasurement)} is rejected`);
    }

    return {
      id: "release-runtime-startup-evidence-invariants",
      status: "PASS",
      command: "evaluate release runtime startup evidence completeness invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "release-runtime-startup-evidence-invariants",
      status: "FAIL",
      command: "evaluate release runtime startup evidence completeness invariants",
      durationMs: 0,
      message: error.message
    };
  }
}
