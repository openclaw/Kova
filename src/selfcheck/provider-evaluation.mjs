import { evaluateRecord } from "../evaluator.mjs";
import {
  providerRequest,
  syntheticProviderSpecificRecord,
  zeroLogMetrics,
  zeroProcessLeakSummary
} from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function providerFailureEvaluationCheck() {
  try {
    const recoverCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-provider-recovery --message hi --json";
    const record = {
      scenario: "agent-provider-recovery",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "transient-provider-failure-turn",
          results: [{
            command: recoverCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:00:02.000Z",
            finishedAtEpochMs: 1777543202000,
            durationMs: 1000,
            stdout: "{\"payloads\":[{\"text\":\"KOVA_AGENT_OK\"}]}",
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
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 2,
        requests: [
          {
            requestId: "provider-error",
            mode: "error-then-recover",
            outcome: "completed",
            errorClass: "provider-error",
            receivedAt: "2026-04-30T10:00:01.500Z",
            receivedAtEpochMs: 1777543201500,
            respondedAt: "2026-04-30T10:00:01.520Z",
            respondedAtEpochMs: 1777543201520,
            firstByteLatencyMs: 10,
            firstChunkLatencyMs: 10,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 503,
            statusClass: "5xx"
          },
          {
            requestId: "provider-recover",
            mode: "normal",
            outcome: "completed",
            errorClass: null,
            receivedAt: "2026-04-30T10:00:01.600Z",
            receivedAtEpochMs: 1777543201600,
            respondedAt: "2026-04-30T10:00:01.700Z",
            respondedAtEpochMs: 1777543201700,
            firstByteLatencyMs: 20,
            firstChunkLatencyMs: 20,
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
      id: "agent-provider-recovery",
      mockProvider: { mode: "error-then-recover" },
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        providerFinalMs: 10000,
        providerFailureHealthFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "provider recovery scenario status");
    assertEqual(record.measurements.agentProviderSimulation.mode, "error-then-recover", "provider simulation mode");
    assertEqual(record.measurements.agentProviderSimulation.recoveryOk, true, "provider recovery ok");
    assertEqual(record.measurements.agentProviderSimulation.containmentOk, true, "provider containment ok");
    assertEqual(record.measurements.agentFailureContainment.processLeaksOk, true, "agent process leaks ok");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "recovery response ok");
    assertEqual(record.measurements.agentLatencyDiagnosis.kind, "provider-error", "provider failure diagnosis");
    const fixerKinds = new Set(record.measurements.agentFailureFixerSummary.items.map((item) => item.kind));
    assertEqual(fixerKinds.has("provider-error"), true, "provider error fixer evidence");
    assertEqual(fixerKinds.has("provider-recovered"), true, "provider recovered fixer evidence");
    return {
      id: "provider-failure-evaluation",
      status: "PASS",
      command: "evaluate synthetic provider failure containment",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provider-failure-evaluation",
      status: "FAIL",
      command: "evaluate synthetic provider failure containment",
      durationMs: 0,
      message: error.message
    };
  }
}

export function adversarialInputEvaluationCheck() {
  try {
    const command = "node support/run-adversarial-inputs.mjs --env kova-self-check --model openclaw --expected-text KOVA_AGENT_OK";
    const record = {
      scenario: "adversarial-input-openai-compatible",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      providerEvidence: {
        available: true,
        requestCount: 5,
        requests: [
          providerRequest({ startedAt: 1777543201000, finishedAt: 1777543201100, status: 200 }),
          providerRequest({ startedAt: 1777543201200, finishedAt: 1777543201300, status: 200 }),
          providerRequest({ startedAt: 1777543201400, finishedAt: 1777543201500, status: 200 }),
          providerRequest({ startedAt: 1777543201600, finishedAt: 1777543201700, status: 200 }),
          providerRequest({ startedAt: 1777543201800, finishedAt: 1777543201900, status: 200 })
        ]
      },
      phases: [{
        id: "hostile-input-corpus",
        results: [{
          command,
          status: 0,
          timedOut: false,
          startedAt: "2026-04-30T10:00:01.000Z",
          startedAtEpochMs: 1777543201000,
          finishedAt: "2026-04-30T10:00:02.000Z",
          finishedAtEpochMs: 1777543202000,
          durationMs: 1000,
          stdout: JSON.stringify({
            ok: true,
            surface: "adversarial-input",
            expectedText: "KOVA_AGENT_OK",
            finalAssistantVisibleText: "KOVA_AGENT_OK",
            finalAssistantCaseText: [
              "xml-close-tags:KOVA_AGENT_OK",
              "html-script:KOVA_AGENT_OK",
              "template-braces:KOVA_AGENT_OK",
              "path-traversal:KOVA_AGENT_OK",
              "unicode-controls:KOVA_AGENT_OK"
            ].join("\n"),
            expectedTextPresent: true,
            caseCount: 5,
            cases: [
              { id: "xml-close-tags", ok: true, finalAssistantVisibleText: "KOVA_AGENT_OK", expectedTextPresent: true },
              { id: "html-script", ok: true, finalAssistantVisibleText: "KOVA_AGENT_OK", expectedTextPresent: true },
              { id: "template-braces", ok: true, finalAssistantVisibleText: "KOVA_AGENT_OK", expectedTextPresent: true },
              { id: "path-traversal", ok: true, finalAssistantVisibleText: "KOVA_AGENT_OK", expectedTextPresent: true },
              { id: "unicode-controls", ok: true, finalAssistantVisibleText: "KOVA_AGENT_OK", expectedTextPresent: true }
            ]
          }),
          stderr: "",
          processSnapshots: { leaks: zeroProcessLeakSummary() }
        }]
      }]
    };
    const scenario = {
      id: "adversarial-input-openai-compatible",
      surface: "adversarial-input",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        providerRequestCountMin: 5,
        providerFinalMs: 5000
      },
      mockProvider: { mode: "normal" }
    };

    evaluateRecord(record, scenario, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(record.status, "PASS", "adversarial input corpus evaluates as pass");
    assertEqual(record.measurements.agentTurnCount, 1, "adversarial input helper is one aggregate agent turn");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "adversarial input aggregate response ok");
    assertEqual(record.measurements.agentTurns[0].expectedTextPresent, true, "adversarial input exact expected text");
    assertEqual(record.measurements.agentTurns[0].responseText, "KOVA_AGENT_OK", "adversarial input aggregate final marker");

    return {
      id: "adversarial-input-evaluation",
      status: "PASS",
      command: "evaluate synthetic adversarial input corpus response",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "adversarial-input-evaluation",
      status: "FAIL",
      command: "evaluate synthetic adversarial input corpus response",
      durationMs: 0,
      message: error.message
    };
  }
}

export function providerSpecificFailureEvaluationCheck() {
  try {
    const protocolRecord = syntheticProviderSpecificRecord({
      scenarioId: "agent-provider-protocol-failure",
      phaseId: "protocol-failure-provider-turn",
      expectedFailure: true,
      commandStatus: 0,
      stdout: "",
      stderr: "provider returned protocol-invalid response",
      providerRequests: [{
        requestId: "provider-protocol-failure",
        mode: "protocol-failure",
        outcome: "malformed",
        errorClass: "malformed-response",
        responseType: "malformed",
        receivedAtEpochMs: 1777543201500,
        respondedAtEpochMs: 1777543201520,
        status: 200,
        statusClass: "2xx"
      }]
    });
    evaluateRecord(protocolRecord, {
      id: "agent-provider-protocol-failure",
      mockProvider: { mode: "protocol-failure" },
      agent: { expectedFailure: true },
      thresholds: { providerFailureHealthFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(protocolRecord.status, "PASS", "provider protocol failure scenario status");
    assertEqual(protocolRecord.measurements.agentProviderSimulation.protocolFailureObserved, true, "provider protocol failure observed");
    assertEqual(
      protocolRecord.measurements.agentFailureFixerSummary.items.some((item) => item.kind === "provider-protocol-failure"),
      true,
      "provider protocol failure fixer evidence"
    );

    const protocolMissingSpecificEvidence = syntheticProviderSpecificRecord({
      scenarioId: "agent-provider-protocol-failure",
      phaseId: "protocol-failure-provider-turn",
      expectedFailure: true,
      commandStatus: 0,
      stdout: "",
      stderr: "provider returned malformed response",
      providerRequests: [{
        requestId: "provider-malformed",
        mode: "malformed",
        outcome: "malformed",
        errorClass: "malformed-response",
        responseType: "malformed",
        receivedAtEpochMs: 1777543201500,
        respondedAtEpochMs: 1777543201520,
        status: 200,
        statusClass: "2xx"
      }]
    });
    evaluateRecord(protocolMissingSpecificEvidence, {
      id: "agent-provider-protocol-failure",
      mockProvider: { mode: "protocol-failure" },
      agent: { expectedFailure: true },
      thresholds: { providerFailureHealthFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(protocolMissingSpecificEvidence.status, "FAIL", "protocol failure missing specific evidence fails");
    assertEqual(
      protocolMissingSpecificEvidence.violations.some((violation) => violation.metric === "providerProtocolFailureObserved"),
      true,
      "protocol failure violation emitted"
    );

    const disconnectRecord = syntheticProviderSpecificRecord({
      scenarioId: "agent-provider-random-disconnect",
      phaseId: "disconnect-provider-turn",
      expectedFailure: false,
      commandStatus: 0,
      stdout: JSON.stringify({ finalAssistantVisibleText: "KOVA_AGENT_OK" }),
      stderr: "",
      providerRequests: [
        {
          requestId: "provider-disconnect",
          mode: "disconnect-then-recover",
          outcome: "error",
          errorClass: "provider-disconnect",
          responseType: "error",
          receivedAtEpochMs: 1777543201500,
          respondedAtEpochMs: 1777543201520,
          status: 503,
          statusClass: "5xx"
        },
        {
          requestId: "provider-disconnect-recover",
          mode: "normal",
          outcome: "completed",
          errorClass: null,
          responseType: "final-text",
          receivedAtEpochMs: 1777543201600,
          respondedAtEpochMs: 1777543201700,
          status: 200,
          statusClass: "2xx"
        }
      ]
    });
    evaluateRecord(disconnectRecord, {
      id: "agent-provider-random-disconnect",
      mockProvider: { mode: "disconnect-then-recover" },
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { providerFailureHealthFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(disconnectRecord.status, "PASS", "provider disconnect recovery scenario status");
    assertEqual(disconnectRecord.measurements.agentProviderSimulation.disconnectObserved, true, "provider disconnect observed");
    assertEqual(disconnectRecord.measurements.agentProviderSimulation.recoveryOk, true, "provider disconnect recovery ok");
    assertEqual(disconnectRecord.measurements.agentLatencyDiagnosis.kind, "provider-disconnect", "provider disconnect diagnosis");
    assertEqual(
      disconnectRecord.measurements.agentFailureFixerSummary.items.some((item) => item.kind === "provider-disconnect"),
      true,
      "provider disconnect fixer evidence"
    );

    const disconnectMissingSpecificEvidence = syntheticProviderSpecificRecord({
      scenarioId: "agent-provider-random-disconnect",
      phaseId: "disconnect-provider-turn",
      expectedFailure: false,
      commandStatus: 0,
      stdout: JSON.stringify({ finalAssistantVisibleText: "KOVA_AGENT_OK" }),
      stderr: "",
      providerRequests: [
        {
          requestId: "provider-generic-error",
          mode: "disconnect-then-recover",
          outcome: "error",
          errorClass: "provider-error",
          responseType: "error",
          receivedAtEpochMs: 1777543201500,
          respondedAtEpochMs: 1777543201520,
          status: 503,
          statusClass: "5xx"
        },
        {
          requestId: "provider-generic-recover",
          mode: "normal",
          outcome: "completed",
          errorClass: null,
          responseType: "final-text",
          receivedAtEpochMs: 1777543201600,
          respondedAtEpochMs: 1777543201700,
          status: 200,
          statusClass: "2xx"
        }
      ]
    });
    evaluateRecord(disconnectMissingSpecificEvidence, {
      id: "agent-provider-random-disconnect",
      mockProvider: { mode: "disconnect-then-recover" },
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { providerFailureHealthFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(disconnectMissingSpecificEvidence.status, "FAIL", "disconnect missing specific evidence fails");
    assertEqual(
      disconnectMissingSpecificEvidence.violations.some((violation) => violation.metric === "providerDisconnectObserved"),
      true,
      "disconnect violation emitted"
    );

    return {
      id: "provider-specific-failure-evaluation",
      status: "PASS",
      command: "evaluate synthetic provider protocol and disconnect evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provider-specific-failure-evaluation",
      status: "FAIL",
      command: "evaluate synthetic provider protocol and disconnect evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

export function providerConcurrentEvaluationCheck() {
  try {
    const command = "node support/run-concurrent-agent-turns.mjs --env kova-self-check --count 3 --message hi --expected-text KOVA_AGENT_OK";
    const record = {
      scenario: "agent-provider-concurrent",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "concurrent-provider-turns",
          results: [{
            command,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:00:05.000Z",
            finishedAtEpochMs: 1777543205000,
            durationMs: 4000,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\",\"successCount\":3}",
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
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 3,
        requests: [1, 2, 3].map((index) => ({
          requestId: `concurrent-provider-${index}`,
          mode: "concurrent-pressure",
          outcome: "completed",
          errorClass: null,
          receivedAt: `2026-04-30T10:00:02.${index}00Z`,
          receivedAtEpochMs: 1777543202000 + (index * 100),
          respondedAt: `2026-04-30T10:00:03.${index}00Z`,
          respondedAtEpochMs: 1777543203000 + (index * 100),
          firstByteLatencyMs: 1000,
          firstChunkLatencyMs: 1000,
          route: "/v1/responses",
          model: "gpt-5.5",
          stream: true,
          status: 200,
          statusClass: "2xx"
        }))
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };

    evaluateRecord(record, {
      id: "agent-provider-concurrent",
      mockProvider: { mode: "concurrent-pressure", delayMs: 1500, concurrency: 3 },
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        providerRequestCountMin: 3,
        providerConcurrencyMin: 2,
        providerFailureHealthFailures: 0,
        agentProcessLeaks: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "provider concurrent scenario status");
    assertEqual(record.measurements.agentProviderSimulation.mode, "concurrent-pressure", "provider concurrent mode");
    assertEqual(record.measurements.agentProviderSimulation.concurrentObserved, true, "provider concurrent observed");
    assertEqual(record.measurements.agentProviderSimulation.providerRequestCount, 3, "provider concurrent request count");
    assertEqual(record.measurements.agentProviderSimulation.providerMaxConcurrency, 3, "provider max concurrency");
    assertEqual(record.measurements.agentTurns[0].requestCount, 3, "concurrent turn provider request count");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "concurrent response ok");
    return {
      id: "provider-concurrent-evaluation",
      status: "PASS",
      command: "evaluate synthetic concurrent provider pressure",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provider-concurrent-evaluation",
      status: "FAIL",
      command: "evaluate synthetic concurrent provider pressure",
      durationMs: 0,
      message: error.message
    };
  }
}

export function agentAuthFailureEvaluationCheck() {
  try {
    const command = "node support/expect-command-fails.mjs -- ocm @kova-self-check -- agent --local --agent main --session-id kova-agent-auth-missing --message hi --json";
    const record = {
      scenario: "agent-auth-missing",
      status: "PASS",
      auth: { mode: "missing", source: "override:missing", providerId: null },
      phases: [
        {
          id: "missing-auth-agent-turn",
          expectedAgentFailure: true,
          results: [{
            command,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:00:02.000Z",
            finishedAtEpochMs: 1777543202000,
            durationMs: 1000,
            stdout: "",
            stderr: "missing OpenAI credentials",
            processSnapshots: {
              leaks: {
                schemaVersion: "kova.processLeakSummary.v1",
                leakCount: 0,
                leakedProcesses: [],
                leaksByRole: {}
              }
            }
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        },
        {
          id: "post-auth-failure-health",
          results: [{
            command: "ocm @kova-self-check -- status",
            status: 0,
            timedOut: false,
            durationMs: 100,
            stdout: "status ok",
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        }
      ],
      providerEvidence: {
        available: false,
        requestCount: 0,
        requests: [],
        errors: [],
        error: "provider request log not found"
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };

    evaluateRecord(record, {
      id: "agent-auth-missing",
      auth: { mode: "missing" },
      agent: { expectedFailure: true },
      thresholds: {
        agentContainmentHealthFailures: 0,
        agentProcessLeaks: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "agent auth failure scenario status");
    assertEqual(record.measurements.agentTurnCount, 1, "auth failure agent turn count");
    assertEqual(record.measurements.agentTurns[0].expectedFailureObserved, true, "auth failure observed");
    assertEqual(record.measurements.agentLatencyDiagnosis.kind, "auth-failure", "auth failure diagnosis");
    assertEqual(record.measurements.agentFailureContainment.gatewayHealthy, true, "auth failure gateway healthy");
    assertEqual(
      record.measurements.agentFailureFixerSummary.items.some((item) => item.kind === "auth-failure"),
      true,
      "auth failure fixer evidence"
    );
    return {
      id: "agent-auth-failure-evaluation",
      status: "PASS",
      command: "evaluate synthetic missing-auth agent failure containment",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-auth-failure-evaluation",
      status: "FAIL",
      command: "evaluate synthetic missing-auth agent failure containment",
      durationMs: 0,
      message: error.message
    };
  }
}
