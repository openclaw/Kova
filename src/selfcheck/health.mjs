import { classifyReadiness } from "../collectors/readiness.mjs";
import { resolveThresholdPolicy } from "../evaluation/thresholds.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { healthTotalFailures } from "../health.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function readinessClassificationCheck() {
  try {
    const record = {
      status: "PASS",
      phases: [
        {
          id: "provision",
          healthScope: "readiness",
          results: [],
          metrics: {
            readiness: {
              deadlineMs: 90000,
              thresholdMs: 30000,
              ready: true,
              listeningReady: true,
              listeningReadyAtMs: 47000,
              healthReadyAtMs: 47100,
              classification: {
                state: "slow-startup",
                severity: "fail",
                reason: "gateway became healthy after 47100ms, beyond the 30000ms threshold"
              }
            },
            logs: {
              missingDependencyErrors: 0,
              pluginLoadFailures: 0,
              metadataScanMentions: 0,
              configNormalizationMentions: 0,
              gatewayRestartMentions: 0,
              providerLoadMentions: 0,
              modelCatalogMentions: 0,
              providerTimeoutMentions: 0,
              eventLoopDelayMentions: 0,
              v8DiagnosticMentions: 0
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: {
          missingDependencyErrors: 0,
          pluginLoadFailures: 0,
          metadataScanMentions: 0,
          configNormalizationMentions: 0,
          gatewayRestartMentions: 0,
          providerLoadMentions: 0,
          modelCatalogMentions: 0,
          providerTimeoutMentions: 0,
          eventLoopDelayMentions: 0,
          v8DiagnosticMentions: 0
        }
      }
    };
    evaluateRecord(record, { thresholds: { gatewayReadyMs: 30000 } });
    assertEqual(record.status, "FAIL", "slow readiness status");
    assertEqual(record.measurements.health.readiness.classification, "slow-startup", "readiness classification");
    assertEqual(
      record.violations.some((violation) => violation.metric === "readiness.classification"),
      true,
      "readiness violation"
    );
    const healthReadyClassification = classifyReadiness({
      thresholdMs: 30000,
      listeningReadyAtMs: null,
      healthReadyAtMs: 6802
    });
    assertEqual(healthReadyClassification.state, "ready", "health success proves readiness even when raw TCP probe timed out first");
    return {
      id: "readiness-classification",
      status: "PASS",
      command: "evaluate synthetic slow readiness record",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "readiness-classification",
      status: "FAIL",
      command: "evaluate synthetic slow readiness record",
      durationMs: 0,
      message: error.message
    };
  }
}

export function healthReadinessModelCheck() {
  try {
    const record = {
      status: "PASS",
      phases: [
        {
          id: "cold-start",
          healthScope: "readiness",
          results: [],
          metrics: {
            readiness: {
              deadlineMs: 90000,
              thresholdMs: 30000,
              ready: true,
              listeningReady: true,
              listeningReadyAtMs: 120,
              healthReadyAtMs: 200,
              attempts: 2,
              classification: {
                state: "ready",
                severity: "pass",
                reason: "gateway became healthy within the readiness threshold"
              },
              healthAttempts: [
                { ok: false, durationMs: 25 },
                { ok: true, durationMs: 30 }
              ]
            },
            healthSamples: [
              { ok: true, durationMs: 40 }
            ],
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 40,
              p50Ms: 40,
              p95Ms: 40,
              maxMs: 40
            }
          }
        },
        {
          id: "api-latency",
          healthScope: "post-ready",
          results: [],
          metrics: {
            healthSamples: [
              { ok: true, durationMs: 10 },
              { ok: true, durationMs: 1500 }
            ],
            healthSummary: {
              count: 2,
              okCount: 2,
              failureCount: 0,
              minMs: 10,
              p50Ms: 10,
              p95Ms: 1500,
              maxMs: 1500
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        healthSamples: [{ ok: true, durationMs: 50 }],
        healthSummary: {
          count: 1,
          okCount: 1,
          failureCount: 0,
          minMs: 50,
          p50Ms: 50,
          p95Ms: 50,
          maxMs: 50
        },
        health: { ok: true, durationMs: 50 }
      }
    };
    const scenario = {
      phases: [
        { id: "cold-start", healthScope: "readiness" },
        { id: "api-latency", healthScope: "post-ready" }
      ],
      thresholds: {
        gatewayReadyMs: 30000,
        postReadyHealthP95Ms: 1000
      }
    };
    evaluateRecord(record, scenario);
    assertEqual(record.status, "FAIL", "post-ready health threshold fails");
    assertEqual(record.measurements.health.schemaVersion, "kova.health.v1", "health schema");
    assertEqual(record.measurements.health.readiness.healthReadyAtMs, 200, "readiness health ready captured");
    assertEqual(record.measurements.health.startupSamples.p95Ms, 30, "startup health p95 derived from readiness attempts");
    assertEqual(record.measurements.health.postReadySamples.p95Ms, 1500, "post-ready health p95 derived from post-ready samples");
    assertEqual(record.measurements.health.slowestSample.scope, "post-ready", "slowest health scope");
    assertEqual(
      record.violations.some((violation) => violation.metric === "postReadyHealthP95Ms"),
      true,
      "post-ready health violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "readinessHealthReadyMs"),
      false,
      "post-ready liveness does not masquerade as readiness"
    );
    return {
      id: "health-readiness-model",
      status: "PASS",
      command: "evaluate synthetic scoped health record",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "health-readiness-model",
      status: "FAIL",
      command: "evaluate synthetic scoped health record",
      durationMs: 0,
      message: error.message
    };
  }
}

export function healthFailureThresholdPolicyCheck() {
  try {
    const policy = resolveThresholdPolicy({
      scenario: {
        id: "synthetic-health-policy",
        thresholds: {
          postReadyHealthP95Ms: 1000
        }
      }
    });
    assertEqual(policy.thresholds.postReadyHealthFailures, 0, "post-ready health latency derives failed-sample gate");
    assertEqual(policy.thresholds.finalHealthFailures, 0, "post-ready health latency derives final failed-sample gate");
    assertEqual(
      policy.report.sources.some((source) =>
        source.kind === "derived" && source.thresholds.includes("postReadyHealthFailures")
      ),
      true,
      "derived health thresholds are reported"
    );

    const explicitPolicy = resolveThresholdPolicy({
      scenario: {
        id: "synthetic-explicit-health-policy",
        thresholds: {
          postReadyHealthP95Ms: 1000,
          postReadyHealthFailures: 2,
          finalHealthFailures: 1
        }
      }
    });
    assertEqual(explicitPolicy.thresholds.postReadyHealthFailures, 2, "explicit post-ready failure budget is preserved");
    assertEqual(explicitPolicy.thresholds.finalHealthFailures, 1, "explicit final failure budget is preserved");

    const record = {
      status: "PASS",
      phases: [
        {
          id: "api-latency",
          healthScope: "post-ready",
          results: [],
          metrics: {
            healthSamples: [
              { ok: false, durationMs: 2, error: "fetch failed" },
              { ok: true, durationMs: 20 }
            ],
            healthSummary: {
              count: 2,
              okCount: 1,
              failureCount: 1,
              minMs: 20,
              p50Ms: 20,
              p95Ms: 20,
              maxMs: 20
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        healthSamples: [{ ok: false, durationMs: 1, error: "fetch failed" }],
        healthSummary: {
          count: 1,
          okCount: 0,
          failureCount: 1,
          minMs: null,
          p50Ms: null,
          p95Ms: null,
          maxMs: null
        }
      }
    };
    evaluateRecord(record, { id: "synthetic-health-policy", thresholds: { postReadyHealthP95Ms: 1000 } });
    assertEqual(record.status, "FAIL", "failed health samples fail even when p95 latency is under threshold");
    assertEqual(
      record.violations.some((violation) => violation.metric === "postReadyHealthFailures"),
      true,
      "post-ready failed samples are violations"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "finalHealthFailures"),
      true,
      "final failed samples are violations"
    );
    assertEqual(
      healthTotalFailures({
        startupSamples: { failureCount: -1 },
        postReadySamples: { failureCount: 1 },
        unknownSamples: { failureCount: 0 },
        final: { failureCount: 0 }
      }),
      null,
      "negative health failure counts are rejected instead of offsetting failures"
    );
    assertEqual(
      healthTotalFailures({
        startupSamples: { failureCount: 0.5 },
        postReadySamples: { failureCount: 0 },
        unknownSamples: { failureCount: 0 },
        final: { failureCount: 0 }
      }),
      null,
      "fractional health failure counts are rejected"
    );
    assertEqual(
      healthTotalFailures({
        postReadySamples: { failureCount: 0 },
        unknownSamples: { failureCount: 0 },
        final: { failureCount: 0 }
      }),
      null,
      "missing health failure counts do not fabricate a zero total"
    );
    return {
      id: "health-failure-threshold-policy",
      status: "PASS",
      command: "evaluate derived health failure thresholds",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "health-failure-threshold-policy",
      status: "FAIL",
      command: "evaluate derived health failure thresholds",
      durationMs: 0,
      message: error.message
    };
  }
}

export function agentContainmentHealthScopeCheck() {
  try {
    const record = {
      scenario: "gateway-session-send-turn",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "gateway-start",
          results: [],
          metrics: {
            logs: zeroLogMetrics(),
            readiness: {
              listeningReadyAtMs: 100,
              healthReadyAtMs: 300,
              thresholdMs: 30000,
              deadlineMs: 90000,
              attempts: 3,
              classification: {
                state: "ready",
                severity: "pass",
                reason: "synthetic startup recovered"
              },
              healthAttempts: [
                { ok: false, durationMs: 0 },
                { ok: false, durationMs: 1 },
                { ok: true, durationMs: 10 }
              ]
            },
            healthSummary: {
              count: 3,
              okCount: 1,
              failureCount: 2,
              minMs: 0,
              p50Ms: 1,
              p95Ms: 10,
              maxMs: 10
            }
          }
        },
        {
          id: "cold-gateway-session-turn",
          results: [{
            command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
            status: 0,
            timedOut: false,
            startedAt: "2026-05-06T10:00:01.000Z",
            startedAtEpochMs: 1778061601000,
            finishedAt: "2026-05-06T10:00:01.400Z",
            finishedAtEpochMs: 1778061601400,
            durationMs: 400,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
            stderr: "",
            processSnapshots: {
              leaks: {
                schemaVersion: "kova.processLeakSummary.v1",
                leakCount: 0,
                leakedProcesses: [],
                leaksByRole: {}
              }
            }
          }],
          metrics: {
            logs: zeroLogMetrics(),
            health: { ok: true, durationMs: 2 },
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 2,
              p50Ms: 2,
              p95Ms: 2,
              maxMs: 2
            }
          }
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [{
          requestId: "provider",
          receivedAt: "2026-05-06T10:00:01.100Z",
          receivedAtEpochMs: 1778061601100,
          respondedAt: "2026-05-06T10:00:01.200Z",
          respondedAtEpochMs: 1778061601200,
          firstByteLatencyMs: 5,
          firstChunkLatencyMs: 5,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          statusClass: "2xx"
        }]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        health: { ok: true, durationMs: 1 },
        healthSummary: {
          count: 1,
          okCount: 1,
          failureCount: 0,
          minMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          maxMs: 1
        }
      }
    };

    evaluateRecord(record, {
      id: "gateway-session-send-turn",
      phases: [
        { id: "gateway-start", healthScope: "readiness" },
        { id: "cold-gateway-session-turn", healthScope: "post-ready" }
      ],
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        agentContainmentHealthFailures: 0,
        agentProcessLeaks: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });

    assertEqual(record.status, "PASS", "startup health failures should not fail post-agent containment");
    assertEqual(record.measurements.health.startupSamples.failureCount, 2, "startup failures retained");
    assertEqual(record.measurements.health.postReadySamples.failureCount, 0, "post-ready failures absent");
    assertEqual(record.measurements.agentFailureContainment.healthFailures, 0, "containment excludes startup failures");
    assertEqual(record.measurements.agentFailureContainment.healthFailureBreakdown.startup, 2, "containment reports startup failures separately");
    assertEqual(record.measurements.agentFailureContainment.gatewayHealthy, true, "gateway containment healthy");
    assertEqual(
      (record.violations ?? []).some((violation) => violation.metric === "agentGatewayHealthy"),
      false,
      "startup readiness failures do not create agentGatewayHealthy violation"
    );

    return {
      id: "agent-containment-health-scope",
      status: "PASS",
      command: "evaluate agent containment scoped health failures",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-containment-health-scope",
      status: "FAIL",
      command: "evaluate agent containment scoped health failures",
      durationMs: 0,
      message: error.message
    };
  }
}
