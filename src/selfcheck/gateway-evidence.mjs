import { extractAssistantVisibleText } from "../../support/openclaw-runtime.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { buildGatewaySessionEvidenceInvariants } from "../evidence/invariants.mjs";
import { renderMarkdownReport } from "../reporting/report.mjs";
import { syntheticGatewaySessionRecord, zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function gatewaySessionHistoryTextExtractionCheck() {
  try {
    const text = extractAssistantVisibleText({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "KOVA_AGENT_OK"
        }
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0
      },
      stopReason: "stop"
    });
    assertEqual(text, "KOVA_AGENT_OK", "Gateway session history assistant content text");

    return {
      id: "gateway-session-history-text-extraction",
      status: "PASS",
      command: "extract Gateway chat.history assistant text",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-history-text-extraction",
      status: "FAIL",
      command: "extract Gateway chat.history assistant text",
      durationMs: 0,
      message: error.message
    };
  }
}

export function gatewaySessionTurnEvaluationCheck() {
  try {
    const base = 1777536000000;
    const coldPayload = {
      ok: true,
      surface: "gateway-session-send-turn",
      method: "sessions.send",
      createSession: true,
      minAssistantCount: 1,
      sessionKey: "kova-gateway-session-send",
      runId: "cold-run",
      gatewayTransport: { kind: "direct-gateway-rpc" },
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 2500,
      activeTurnMs: 1500,
      sessionCreateDurationMs: 100,
      sendStartedAtEpochMs: base + 1000,
      sendFinishedAtEpochMs: base + 1040,
      sendDurationMs: 40,
      assistantFirstSeenAtEpochMs: base + 2200,
      assistantMatchedAtEpochMs: base + 2500,
      timeToFirstAssistantMs: 1200,
      timeToMatchedAssistantMs: 1500,
      historyPollCount: 3,
      historyErrorCount: 0,
      assistantMessageCount: 1,
      finalAssistantVisibleText: "KOVA_AGENT_OK",
      expectedTextPresent: true
    };
    const warmPayload = {
      ok: true,
      surface: "gateway-session-send-turn",
      method: "sessions.send",
      createSession: false,
      minAssistantCount: 2,
      sessionKey: "kova-gateway-session-send",
      runId: "warm-run",
      gatewayTransport: { kind: "direct-gateway-rpc" },
      activeStartedAtEpochMs: base + 11000,
      activeFinishedAtEpochMs: base + 11800,
      activeTurnMs: 800,
      sessionCreateDurationMs: null,
      sendStartedAtEpochMs: base + 11000,
      sendFinishedAtEpochMs: base + 11050,
      sendDurationMs: 50,
      assistantFirstSeenAtEpochMs: base + 11600,
      assistantMatchedAtEpochMs: base + 11800,
      timeToFirstAssistantMs: 600,
      timeToMatchedAssistantMs: 800,
      historyPollCount: 2,
      historyErrorCount: 0,
      assistantMessageCount: 2,
      finalAssistantVisibleText: "KOVA_AGENT_OK",
      expectedTextPresent: true
    };
    const record = {
      scenario: "gateway-session-send-turn",
      surface: "gateway-session-send-turn",
      title: "Gateway session cold/warm",
      status: "PASS",
      cleanup: "done",
      auth: { mode: "mock" },
      phases: [
        {
          id: "cold-gateway-session-turn",
          title: "Cold Gateway Session Turn",
          intent: "Synthetic cold Gateway session turn",
          commands: ["node support/run-gateway-session-send-turn.mjs --create-session true"],
          evidence: [],
          results: [{
            command: "node support/run-gateway-session-send-turn.mjs --create-session true",
            status: 0,
            timedOut: false,
            startedAt: new Date(base).toISOString(),
            startedAtEpochMs: base,
            finishedAt: new Date(base + 5000).toISOString(),
            finishedAtEpochMs: base + 5000,
            durationMs: 5000,
            stdout: JSON.stringify(coldPayload),
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        },
        {
          id: "warm-gateway-session-turn",
          title: "Warm Gateway Session Turn",
          intent: "Synthetic warm Gateway session turn",
          commands: ["node support/run-gateway-session-send-turn.mjs --create-session false"],
          evidence: [],
          results: [{
            command: "node support/run-gateway-session-send-turn.mjs --create-session false",
            status: 0,
            timedOut: false,
            startedAt: new Date(base + 10000).toISOString(),
            startedAtEpochMs: base + 10000,
            finishedAt: new Date(base + 14000).toISOString(),
            finishedAtEpochMs: base + 14000,
            durationMs: 4000,
            stdout: JSON.stringify(warmPayload),
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
            receivedAt: new Date(base + 1200).toISOString(),
            receivedAtEpochMs: base + 1200,
            respondedAt: new Date(base + 1800).toISOString(),
            respondedAtEpochMs: base + 1800,
            firstByteLatencyMs: 25,
            firstChunkLatencyMs: 30,
            route: "/v1/responses",
            model: "gpt-5.5",
            status: 200
          },
          {
            requestId: "warm-provider",
            receivedAt: new Date(base + 11250).toISOString(),
            receivedAtEpochMs: base + 11250,
            respondedAt: new Date(base + 11600).toISOString(),
            respondedAtEpochMs: base + 11600,
            firstByteLatencyMs: 20,
            firstChunkLatencyMs: 22,
            route: "/v1/responses",
            model: "gpt-5.5",
            status: 200
          }
        ]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: {
          available: true,
          eventCount: 5,
          parseErrorCount: 0,
          events: [
            { type: "span.end", name: "plugins.metadata.scan", timestamp: new Date(base + 700).toISOString(), durationMs: 99 },
            { type: "span.end", name: "plugins.metadata.scan", timestamp: new Date(base + 1150).toISOString(), durationMs: 33 },
            { type: "eventLoop.sample", name: "eventLoop.sample", timestamp: new Date(base + 1250).toISOString(), maxMs: 9 },
            { type: "span.end", name: "plugins.metadata.scan", timestamp: new Date(base + 11100).toISOString(), durationMs: 11 },
            { type: "eventLoop.sample", name: "eventLoop.sample", timestamp: new Date(base + 11200).toISOString(), maxMs: 7 }
          ],
          spanTotals: {},
          keySpans: {}
        }
      }
    };

    evaluateRecord(record, {
      id: "gateway-session-send-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentTurnMs: 2000, coldAgentTurnMs: 2000, warmAgentTurnMs: 1000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });

    assertEqual(record.status, "PASS", "gateway session active-window scenario status");
    assertEqual(record.measurements.coldAgentTurnMs, 1500, "cold gateway session active turn duration");
    assertEqual(record.measurements.warmAgentTurnMs, 800, "warm gateway session active turn duration");
    assertEqual(record.measurements.agentTurnMs, 1500, "agent turn max uses active turn duration");
    assertEqual(record.measurements.agentTurns[0].rawCommandDurationMs, 5000, "raw support command duration preserved");
    assertEqual(record.measurements.coldPreProviderMs, 200, "cold pre-provider uses active window");
    assertEqual(record.measurements.coldProviderFinalMs, 600, "cold provider duration");
    assertEqual(record.measurements.agentMetadataScanCount, 2, "active-window metadata scans");
    assertEqual(record.measurements.agentMetadataScanTotalMs, 44, "active-window metadata scan total");
    assertEqual(record.measurements.agentEventLoopMaxMs, 9, "active-window event-loop max");
    assertEqual(record.measurements.agentSessionPollCount, 5, "session polling total");
    assertEqual(record.measurements.agentTurns[1].gatewaySession.createSession, false, "warm turn reuses session");
    assertEqual(record.measurements.agentTurns[0].gatewaySession.gatewayTransportKind, "direct-gateway-rpc", "Gateway session direct Gateway transport");

    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-gateway-session-turn",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("gateway session:"), true, "markdown includes gateway session detail");
    assertEqual(rendered.includes("transport direct-gateway-rpc"), true, "markdown includes direct Gateway transport");
    assertEqual(rendered.includes("active window:"), true, "markdown includes active turn diagnostics");

    const nonDirectPayload = {
      ...coldPayload,
      gatewayTransport: { kind: "shell" }
    };
    const nonDirectRecord = {
      scenario: "gateway-session-send-turn",
      surface: "gateway-session-send-turn",
      title: "Gateway session non-direct transport",
      status: "PASS",
      phases: [{
        id: "cold-gateway-session-turn",
        title: "Cold Gateway Session Turn",
        intent: "Synthetic non-direct transport",
        commands: ["node support/run-gateway-session-send-turn.mjs --create-session true"],
        evidence: [],
        results: [{
          command: "node support/run-gateway-session-send-turn.mjs --create-session true",
          status: 0,
          timedOut: false,
          startedAt: new Date(base).toISOString(),
          startedAtEpochMs: base,
          finishedAt: new Date(base + 5000).toISOString(),
          finishedAtEpochMs: base + 5000,
          durationMs: 5000,
            stdout: JSON.stringify(nonDirectPayload),
          stderr: ""
        }],
        metrics: { logs: zeroLogMetrics(), health: { ok: true } }
      }],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [record.providerEvidence.requests[0]]
      },
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(nonDirectRecord, {
      id: "gateway-session-send-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {}
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    assertEqual(nonDirectRecord.status, "FAIL", "gateway session non-direct transport rejected");
    assertEqual(
      nonDirectRecord.violations.some((violation) => violation.metric === "gatewayTransport.kind"),
      true,
      "gateway session non-direct transport violation"
    );

    return {
      id: "gateway-session-turn-evaluation",
      status: "PASS",
      command: "evaluate synthetic Gateway session cold/warm active-turn attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-turn-evaluation",
      status: "FAIL",
      command: "evaluate synthetic Gateway session cold/warm active-turn attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

export function gatewaySessionEvidenceInvariantCheck() {
  try {
    const base = 1777536000000;
    const record = syntheticGatewaySessionRecord({
      base,
      timeline: {
        available: true,
        eventCount: 0,
        parseErrorCount: 0,
        events: [],
        spanTotals: {},
        keySpans: {}
      }
    });
    for (const phase of record.phases) {
      phase.healthScope = "post-ready";
      phase.metrics.healthSummary = {
        count: 1,
        okCount: 1,
        failureCount: 0,
        minMs: 2,
        p50Ms: 2,
        p95Ms: 2,
        maxMs: 2
      };
    }
    record.phases.unshift({
      id: "gateway-start",
      title: "Gateway start",
      intent: "Synthetic gateway readiness",
      healthScope: "readiness",
      commands: ["ocm service start kova --json"],
      results: [{
        command: "ocm service start kova --json",
        status: 0,
        durationMs: 300
      }],
      metrics: {
        logs: zeroLogMetrics(),
        readiness: {
          listeningReadyAtMs: 100,
          healthReadyAtMs: 300,
          thresholdMs: 30000,
          deadlineMs: 90000,
          attempts: 1,
          classification: {
            state: "ready",
            severity: "pass",
            reason: "synthetic ready"
          },
          healthAttempts: [{ ok: true, durationMs: 2 }]
        },
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
    });
    record.providerEvidence.summaryPath = "/tmp/kova/provider/provider-evidence.json";
    record.providerEvidence.artifacts = [
      "/tmp/kova/mock-openai/requests.jsonl",
      "/tmp/kova/provider/provider-evidence.json"
    ];
    record.finalMetrics.health = { ok: true, durationMs: 1 };
    record.finalMetrics.healthSummary = {
      count: 1,
      okCount: 1,
      failureCount: 0,
      minMs: 1,
      p50Ms: 1,
      p95Ms: 1,
      maxMs: 1
    };

    const scenario = {
      id: "gateway-session-send-turn",
      surface: "gateway-session-send-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {},
      phases: [
        { id: "gateway-start", healthScope: "readiness" },
        { id: "cold-gateway-session-turn", healthScope: "post-ready" },
        { id: "warm-gateway-session-turn", healthScope: "post-ready" }
      ]
    };
    evaluateRecord(record, scenario, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    const invariants = buildGatewaySessionEvidenceInvariants(record, scenario);
    assertEqual(invariants.length, 8, "gateway session invariant count");
    assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "complete gateway session evidence passes invariants");

    const missingProviderRecord = JSON.parse(JSON.stringify(record));
    missingProviderRecord.providerEvidence = { available: false, requestCount: 0, error: "provider request log not found" };
    evaluateRecord(missingProviderRecord, scenario, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    const missingProviderInvariants = buildGatewaySessionEvidenceInvariants(missingProviderRecord, scenario);
    const providerProof = missingProviderInvariants.find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(providerProof?.status, "missing", "missing provider proof is an incomplete evidence obligation");

    const missingAggregateCountRecord = JSON.parse(JSON.stringify(record));
    delete missingAggregateCountRecord.providerEvidence.requestCount;
    const missingAggregateCountProof = buildGatewaySessionEvidenceInvariants(missingAggregateCountRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(missingAggregateCountProof?.status, "missing", "missing aggregate provider request count is incomplete evidence");

    const missingStatusRecord = JSON.parse(JSON.stringify(record));
    missingStatusRecord.measurements.agentTurns[0].providerStatuses = [];
    const missingStatusProof = buildGatewaySessionEvidenceInvariants(missingStatusRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(missingStatusProof?.status, "missing", "empty provider response statuses are incomplete evidence");

    const incompleteResponseRecord = JSON.parse(JSON.stringify(record));
    incompleteResponseRecord.measurements.agentTurns[0].providerFinalMs = null;
    incompleteResponseRecord.measurements.agentTurns[0].providerStatuses = [{ value: 200, count: 1 }];
    const incompleteResponseProof = buildGatewaySessionEvidenceInvariants(incompleteResponseRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(incompleteResponseProof?.status, "missing", "unfinished provider response is incomplete gateway evidence");

    const partialStatusRecord = JSON.parse(JSON.stringify(record));
    partialStatusRecord.measurements.agentTurns[0].requestCount = 2;
    partialStatusRecord.measurements.agentTurns[0].providerStatuses = [{ value: 200, count: 1 }];
    const partialStatusProof = buildGatewaySessionEvidenceInvariants(partialStatusRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(partialStatusProof?.status, "missing", "gateway status evidence must cover every attributed request");

    const aggregateUndercountRecord = JSON.parse(JSON.stringify(record));
    for (const turn of aggregateUndercountRecord.measurements.agentTurns) {
      turn.requestCount = 2;
      turn.providerStatuses = [{ value: 200, count: 2 }];
    }
    aggregateUndercountRecord.providerEvidence.requestCount = 2;
    const aggregateUndercountProof = buildGatewaySessionEvidenceInvariants(aggregateUndercountRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(aggregateUndercountProof?.status, "missing", "gateway aggregate count covers every attributed request");

    const duplicateStatusRecord = JSON.parse(JSON.stringify(record));
    duplicateStatusRecord.measurements.agentTurns[0].requestCount = 2;
    duplicateStatusRecord.measurements.agentTurns[0].providerStatuses = [
      { value: 200, count: 1 },
      { value: 200, count: 1 }
    ];
    duplicateStatusRecord.providerEvidence.requestCount = 3;
    const duplicateStatusProof = buildGatewaySessionEvidenceInvariants(duplicateStatusRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-provider-proof");
    assertEqual(duplicateStatusProof?.status, "missing", "duplicate gateway status buckets are incomplete evidence");

    for (const malformedTurns of [{ malformed: true }, [null]]) {
      const malformedTurnRecord = JSON.parse(JSON.stringify(record));
      malformedTurnRecord.measurements.agentTurns = malformedTurns;
      const malformedTurnProof = buildGatewaySessionEvidenceInvariants(malformedTurnRecord, scenario)
        .find((invariant) => invariant.id === "gateway-session-provider-proof");
      assertEqual(malformedTurnProof?.status, "missing", "malformed agent turn evidence does not throw or pass");
    }

    const missingFinalHealthRecord = JSON.parse(JSON.stringify(record));
    delete missingFinalHealthRecord.finalMetrics.health;
    delete missingFinalHealthRecord.finalMetrics.healthSummary;
    evaluateRecord(missingFinalHealthRecord, scenario, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    const missingFinalHealthProof = buildGatewaySessionEvidenceInvariants(missingFinalHealthRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-readiness-health-proof");
    assertEqual(missingFinalHealthProof?.status, "missing", "missing final health count is incomplete evidence");

    const missingPostReadyFailureRecord = JSON.parse(JSON.stringify(record));
    delete missingPostReadyFailureRecord.measurements.health.postReadySamples.failureCount;
    const missingPostReadyFailureProof = buildGatewaySessionEvidenceInvariants(missingPostReadyFailureRecord, scenario)
      .find((invariant) => invariant.id === "gateway-session-readiness-health-proof");
    assertEqual(
      missingPostReadyFailureProof?.status,
      "missing",
      "missing post-ready health failure count is incomplete evidence"
    );

    return {
      id: "gateway-session-evidence-invariants",
      status: "PASS",
      command: "evaluate Gateway session evidence completeness invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-evidence-invariants",
      status: "FAIL",
      command: "evaluate Gateway session evidence completeness invariants",
      durationMs: 0,
      message: error.message
    };
  }
}
