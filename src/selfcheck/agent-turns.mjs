import {
  buildAgentTurnBreakdown,
  summarizeAgentTurnBreakdownForMarkdown,
  summarizeLogStages
} from "../collectors/agent-turns.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { renderMarkdownReport, renderPasteSummary } from "../reporting/report.mjs";
import { syntheticTurn, zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function agentTurnBreakdownCheck() {
  try {
    const normal = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1200,
      firstByteLatencyMs: 15,
      firstChunkLatencyMs: 18,
      lastProviderResponseAtEpochMs: 1600,
      finishedAtEpochMs: 2000,
      timelineSummary: {
        available: true,
        spanTotals: {
          "agent.prepare": { count: 1, totalDurationMs: 90, maxDurationMs: 90 },
          "models.catalog.gateway": { count: 1, totalDurationMs: 70, maxDurationMs: 70 },
          "channel.plugin.load": { count: 1, totalDurationMs: 25, maxDurationMs: 25 }
        },
        keySpans: {}
      }
    });
    assertEqual(normal.breakdown.buckets.preProviderOpenClawMs, 200, "normal pre-provider bucket");
    assertEqual(normal.breakdown.buckets.providerMs, 400, "normal provider bucket");
    assertEqual(normal.breakdown.buckets.postProviderMs, 400, "normal post-provider bucket");
    assertEqual(normal.breakdown.buckets.unknownMs, 15, "normal unattributed pre-provider bucket");
    assertEqual(normal.breakdown.provider.firstByteLatencyMs, 15, "normal first byte latency");
    assertEqual(normal.breakdown.sourceSpans.categories.modelCatalog.totalDurationMs, 70, "model catalog source span");

    const partialEmbeddedStages = summarizeLogStages({
      embeddedRuns: {
        available: true,
        eventCount: 3
      },
      stageTotals: {
        "runtime-plugins": { count: 1, totalDurationMs: 42, maxDurationMs: 42 }
      }
    });
    assertEqual(partialEmbeddedStages.eventCount, 3, "embedded run metadata remains authoritative");
    assertEqual(partialEmbeddedStages.allStages[0]?.totalDurationMs, 42, "missing embedded stage totals fall back");
    const whitespaceNumbers = buildAgentTurnBreakdown({
      result: { durationMs: " " },
      attribution: { firstByteLatencyMs: "\t" }
    });
    assertEqual(whitespaceNumbers.command.totalMs, null, "whitespace command duration is unavailable");
    assertEqual(whitespaceNumbers.provider.firstByteLatencyMs, null, "whitespace provider latency is unavailable");

    const preProviderStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 62000,
      lastProviderResponseAtEpochMs: 62800,
      finishedAtEpochMs: 63000,
      timelineSummary: null
    });
    assertEqual(preProviderStall.breakdown.evidenceQuality, "outside-in-only", "pre-provider missing timeline quality");
    assertEqual(preProviderStall.breakdown.buckets.preProviderOpenClawMs, 61000, "pre-provider stall bucket");
    assertEqual(preProviderStall.breakdown.buckets.unknownMs, 61000, "pre-provider stall unknown");

    const providerStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 21500,
      finishedAtEpochMs: 22000,
      timelineSummary: null
    });
    assertEqual(providerStall.breakdown.buckets.providerMs, 20000, "provider stall bucket");
    assertEqual(providerStall.breakdown.buckets.unknownMs, 500, "provider stall unknown pre-provider");

    const cleanupStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 1800,
      finishedAtEpochMs: 77000,
      timelineSummary: {
        available: true,
        spanTotals: {
          "agent.cleanup": { count: 1, totalDurationMs: 74000, maxDurationMs: 74000 }
        },
        keySpans: {}
      }
    });
    assertEqual(cleanupStall.breakdown.buckets.cleanupMs, 74000, "cleanup stall bucket");
    assertEqual(cleanupStall.breakdown.sourceSpans.categories.agentCleanup.totalDurationMs, 74000, "cleanup source span");

    const missingTimeline = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 1800,
      finishedAtEpochMs: 1900,
      timelineSummary: { available: false, spanTotals: {}, keySpans: {} }
    });
    assertEqual(missingTimeline.breakdown.evidenceQuality, "outside-in-only", "missing timeline outside-in quality");
    assertEqual(missingTimeline.breakdown.buckets.unknownMs, 500, "missing timeline unknown");

    const record = {
      scenario: "agent-cold-warm-message",
      title: "Agent cold/warm message",
      status: "PASS",
      cleanup: "done",
      phases: [{
        id: "cold-agent-turn",
        title: "Cold agent turn",
        intent: "Synthetic self-check",
        commands: [normal.result.command],
        evidence: [],
        results: [{
          ...normal.result,
          status: 0,
          timedOut: false,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: ""
        }],
        metrics: {
          logs: zeroLogMetrics(),
          health: { ok: true },
          timeline: {
            available: true,
            eventCount: 3,
            parseErrorCount: 0,
            spanTotals: {
              "agent.prepare": { count: 1, totalDurationMs: 90, maxDurationMs: 90 },
              "models.catalog.gateway": { count: 1, totalDurationMs: 70, maxDurationMs: 70 }
            },
            keySpans: {}
          }
        }
      }],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [normal.request]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {}
    }, { surface: { thresholds: {} }, targetPlan: { kind: "local-build" } });
    assertEqual(record.measurements.agentTurnStats?.count, 1, "agent turn stats count");
    assertEqual(record.measurements.agentTurnP95Ms, 1000, "agent turn p95");
    assertEqual(record.measurements.agentPreProviderP95Ms, 200, "agent pre-provider p95");
    const missingCleanupRecord = structuredClone(record);
    missingCleanupRecord.status = "PASS";
    evaluateRecord(missingCleanupRecord, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentCleanupMs: 5000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "local-build" } });
    assertEqual(missingCleanupRecord.status, "PASS", "missing optional cleanup span stays pass");
    assertEqual(missingCleanupRecord.measurements.agentCleanupMaxMs, null, "missing cleanup remains explicit null");
    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-agent-turn-breakdown",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("breakdown:"), true, "markdown includes agent turn breakdown");
    assertEqual(rendered.includes("models.catalog.\\* 70ms"), true, "markdown includes source span evidence");
    assertEqual(rendered.includes("Agent turn stats:"), true, "markdown includes agent turn stats");
    assertEqual(
      summarizeAgentTurnBreakdownForMarkdown(normal.breakdown).includes("unknown 15ms"),
      true,
      "breakdown markdown helper includes unknown bucket"
    );

    const cleanupRecord = {
      scenario: "agent-cold-warm-message",
      title: "Agent cleanup stall",
      status: "PASS",
      cleanup: "done",
      phases: [{
        id: "cleanup-agent-turn",
        title: "Cleanup agent turn",
        intent: "Synthetic cleanup stall",
        commands: [cleanupStall.result.command],
        evidence: [],
        results: [{
          ...cleanupStall.result,
          status: 0,
          timedOut: false,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: ""
        }],
        metrics: {
          logs: zeroLogMetrics(),
          health: { ok: true },
          timeline: {
            available: true,
            eventCount: 1,
            parseErrorCount: 0,
            spanTotals: {
              "agent.cleanup": { count: 1, totalDurationMs: 74000, maxDurationMs: 74000 }
            },
            keySpans: {}
          }
        }
      }],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [cleanupStall.request]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(cleanupRecord, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentCleanupMs: 5000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "local-build" } });
    assertEqual(cleanupRecord.status, "FAIL", "cleanup stall should fail");
    assertEqual(cleanupRecord.measurements.agentCleanupMaxMs, 74000, "agent cleanup max measurement");
    assertEqual(cleanupRecord.measurements.agentCleanupDiagnosis.kind, "slow-agent-cleanup", "agent cleanup diagnosis");
    assertEqual(
      cleanupRecord.measurements.agentFailureFixerSummary.items.some((item) => item.kind === "slow-agent-cleanup"),
      true,
      "slow cleanup fixer evidence"
    );

    return {
      id: "agent-turn-breakdown",
      status: "PASS",
      command: "evaluate synthetic agent turn phase breakdowns",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-turn-breakdown",
      status: "FAIL",
      command: "evaluate synthetic agent turn phase breakdowns",
      durationMs: 0,
      message: error.message
    };
  }
}

export function agentColdWarmEvaluationCheck() {
  try {
    const coldCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
    const warmCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
    const truncatedPayloadResponse = `{"payloads":[{"text":"KOVA_AGENT_OK"}],"meta":{"details":"${"x".repeat(20000)}
[truncated 100 chars]`;
    const record = {
      scenario: "agent-cold-warm-message",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "cold-agent-turn",
          results: [{
            command: coldCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:01:03.000Z",
            finishedAtEpochMs: 1777543263000,
            durationMs: 62000,
            stdout: truncatedPayloadResponse,
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        },
        {
          id: "warm-agent-turn",
          results: [{
            command: warmCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:01:10.000Z",
            startedAtEpochMs: 1777543270000,
            finishedAt: "2026-04-30T10:01:12.000Z",
            finishedAtEpochMs: 1777543272000,
            durationMs: 2000,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\",\"payloads\":[{\"text\":\"WRONG_REPLY\"}]}",
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 2,
        requests: [
          {
            requestId: "cold-provider",
            receivedAt: "2026-04-30T10:01:02.000Z",
            receivedAtEpochMs: 1777543262000,
            respondedAt: "2026-04-30T10:01:02.800Z",
            respondedAtEpochMs: 1777543262800,
            firstByteLatencyMs: 50,
            firstChunkLatencyMs: 50,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 200,
            statusClass: "2xx"
          },
          {
            requestId: "warm-provider",
            receivedAt: "2026-04-30T10:01:10.500Z",
            receivedAtEpochMs: 1777543270500,
            respondedAt: "2026-04-30T10:01:11.300Z",
            respondedAtEpochMs: 1777543271300,
            firstByteLatencyMs: 40,
            firstChunkLatencyMs: 40,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 200,
            statusClass: "2xx"
          }
        ]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };

    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        preProviderMs: 10000,
        coldWarmDeltaMs: 30000,
        providerFinalMs: 3000,
        preProviderDominanceRatio: 0.8
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "FAIL", "cold pre-provider stall should fail");
    assertEqual(record.measurements.agentTurnCount, 2, "agent turn count");
    assertEqual(record.measurements.coldAgentTurnMs, 62000, "cold turn duration");
    assertEqual(record.measurements.warmAgentTurnMs, 2000, "warm turn duration");
    assertEqual(record.measurements.agentColdWarmDeltaMs, 60000, "cold warm delta");
    assertEqual(record.measurements.coldPreProviderMs, 61000, "cold pre-provider latency");
    assertEqual(record.measurements.warmPreProviderMs, 500, "warm pre-provider latency");
    assertEqual(record.measurements.coldProviderFinalMs, 800, "cold provider final");
    assertEqual(record.measurements.agentLatencyDiagnosis.kind, "cold-pre-provider-stall", "latency diagnosis kind");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "cold response ok");
    assertEqual(record.measurements.agentTurns[0].responseText, "KOVA_AGENT_OK", "truncated payload response text");
    assertEqual(record.measurements.agentTurns[1].responseText, "KOVA_AGENT_OK", "final assistant response precedence");
    assertEqual(record.measurements.agentTurns[1].providerRoutes[0].value, "/v1/responses", "warm provider route evidence");
    assertEqual(
      record.violations.some((violation) => violation.phaseId === "warm-agent-turn" && violation.metric === "preProviderDominanceRatio"),
      false,
      "warm mock turn should not fail dominance ratio while absolute pre-provider latency is below threshold"
    );
    assertEqual(
      renderPasteSummary({
        runId: "self-check-cold-warm",
        target: "runtime:stable",
        mode: "self-check",
        platform: { os: "test", release: "test", arch: "test" },
        records: [record]
      }).includes("cold-warm delta 60000ms"),
      true,
      "paste summary includes cold/warm evidence"
    );

    return {
      id: "agent-cold-warm-evaluation",
      status: "PASS",
      command: "evaluate synthetic cold/warm agent provider attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cold-warm-evaluation",
      status: "FAIL",
      command: "evaluate synthetic cold/warm agent provider attribution",
      durationMs: 0,
      message: error.message
    };
  }
}
