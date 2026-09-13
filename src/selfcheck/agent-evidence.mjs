import { evaluateRecord } from "../evaluator.mjs";
import {
  buildAgentCliLocalTurnEvidenceInvariants,
  buildAgentGatewayRpcTurnEvidenceInvariants
} from "../evidence/invariants.mjs";
import { syntheticAgentCliLocalTurnRecord, syntheticAgentGatewayRpcTurnRecord } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function agentCliLocalTurnEvidenceInvariantCheck() {
  try {
    const scenario = {
      id: "agent-cold-warm-message",
      surface: "agent-cli-local-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {},
      phases: [
        { id: "provision", healthScope: "none" },
        { id: "cold-agent-turn", healthScope: "post-ready" },
        { id: "warm-agent-turn", healthScope: "post-ready" },
        { id: "post-agent-health", healthScope: "post-ready" }
      ]
    };
    const record = syntheticAgentCliLocalTurnRecord();
    evaluateRecord(record, scenario, {
      surface: {
        thresholds: {},
        diagnostics: { expectedSpans: ["plugins.metadata.scan"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const invariants = buildAgentCliLocalTurnEvidenceInvariants(record, scenario);
    assertEqual(invariants.length, 12, "agent CLI invariant count");
    assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "complete agent CLI local turn evidence passes invariants");

    const missingProviderRecord = syntheticAgentCliLocalTurnRecord();
    missingProviderRecord.providerEvidence = { available: false, requestCount: 0, error: "provider request log not found" };
    evaluateRecord(missingProviderRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingProviderInvariants = buildAgentCliLocalTurnEvidenceInvariants(missingProviderRecord, scenario);
    const providerProof = missingProviderInvariants.find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(providerProof?.status, "missing", "missing provider proof is incomplete agent CLI evidence");

    const missingAggregateCountRecord = JSON.parse(JSON.stringify(record));
    delete missingAggregateCountRecord.providerEvidence.requestCount;
    const missingAggregateCountProof = buildAgentCliLocalTurnEvidenceInvariants(missingAggregateCountRecord, scenario)
      .find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(missingAggregateCountProof?.status, "missing", "agent provider proof requires aggregate request count");

    const invalidTurnCountRecord = JSON.parse(JSON.stringify(record));
    invalidTurnCountRecord.measurements.agentTurns[0].requestCount = Infinity;
    const invalidTurnCountProof = buildAgentCliLocalTurnEvidenceInvariants(invalidTurnCountRecord, scenario)
      .find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(invalidTurnCountProof?.status, "missing", "agent provider proof requires finite per-turn request count");

    for (const malformedStatuses of [
      [],
      { malformed: true },
      [{ value: 200 }],
      [{ value: 200, count: 0 }]
    ]) {
      const malformedStatusRecord = JSON.parse(JSON.stringify(record));
      malformedStatusRecord.measurements.agentTurns[0].providerStatuses = malformedStatuses;
      const malformedStatusProof = buildAgentCliLocalTurnEvidenceInvariants(malformedStatusRecord, scenario)
        .find((invariant) => invariant.id === "agent-cli-provider-proof");
      assertEqual(malformedStatusProof?.status, "missing", "malformed provider response statuses do not throw or pass");
    }

    const incompleteResponseRecord = JSON.parse(JSON.stringify(record));
    incompleteResponseRecord.measurements.agentTurns[0].providerFinalMs = null;
    incompleteResponseRecord.measurements.agentTurns[0].providerStatuses = [{ value: 200, count: 1 }];
    const incompleteResponseProof = buildAgentCliLocalTurnEvidenceInvariants(incompleteResponseRecord, scenario)
      .find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(incompleteResponseProof?.status, "missing", "unfinished provider response is incomplete agent evidence");

    const partialStatusRecord = JSON.parse(JSON.stringify(record));
    partialStatusRecord.measurements.agentTurns[0].requestCount = 2;
    partialStatusRecord.measurements.agentTurns[0].providerStatuses = [{ value: 200, count: 1 }];
    const partialStatusProof = buildAgentCliLocalTurnEvidenceInvariants(partialStatusRecord, scenario)
      .find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(partialStatusProof?.status, "missing", "agent status evidence must cover every attributed request");

    const aggregateUndercountRecord = JSON.parse(JSON.stringify(record));
    for (const turn of aggregateUndercountRecord.measurements.agentTurns) {
      turn.requestCount = 2;
      turn.providerStatuses = [{ value: 200, count: 2 }];
    }
    aggregateUndercountRecord.providerEvidence.requestCount = 2;
    const aggregateUndercountProof = buildAgentCliLocalTurnEvidenceInvariants(aggregateUndercountRecord, scenario)
      .find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(aggregateUndercountProof?.status, "missing", "agent aggregate count covers every attributed request");

    const duplicateStatusRecord = JSON.parse(JSON.stringify(record));
    duplicateStatusRecord.measurements.agentTurns[0].requestCount = 2;
    duplicateStatusRecord.measurements.agentTurns[0].providerStatuses = [
      { value: 200, count: 1 },
      { value: 200, count: 1 }
    ];
    duplicateStatusRecord.providerEvidence.requestCount += 1;
    const duplicateStatusProof = buildAgentCliLocalTurnEvidenceInvariants(duplicateStatusRecord, scenario)
      .find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(duplicateStatusProof?.status, "missing", "duplicate agent status buckets are incomplete evidence");

    const recoveryScenario = {
      ...scenario,
      mockProvider: { mode: "disconnect-then-recover" }
    };
    const statuslessRecoveryRecord = JSON.parse(JSON.stringify(record));
    statuslessRecoveryRecord.providerEvidence.requestCount = 3;
    statuslessRecoveryRecord.measurements.agentTurns[0].requestCount = 2;
    statuslessRecoveryRecord.measurements.agentTurns[0].providerStatuses = [{ value: 200, count: 1 }];
    statuslessRecoveryRecord.measurements.agentTurns[0].providerErrors = [{
      kind: "provider-disconnect",
      requestId: "cold-disconnect",
      status: null
    }];
    const statuslessRecoveryProof = buildAgentCliLocalTurnEvidenceInvariants(
      statuslessRecoveryRecord,
      recoveryScenario
    ).find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(statuslessRecoveryProof?.status, "passed", "typed statusless recovery error accounts for request");

    const numericRecoveryRecord = JSON.parse(JSON.stringify(record));
    numericRecoveryRecord.providerEvidence.requestCount = 3;
    numericRecoveryRecord.measurements.agentTurns[0].requestCount = 2;
    numericRecoveryRecord.measurements.agentTurns[0].providerStatuses = [
      { value: 500, count: 1 },
      { value: 200, count: 1 }
    ];
    numericRecoveryRecord.measurements.agentTurns[0].providerErrors = [{
      kind: "http",
      requestId: "cold-http-failure",
      status: 500
    }];
    const numericRecoveryProof = buildAgentCliLocalTurnEvidenceInvariants(
      numericRecoveryRecord,
      recoveryScenario
    ).find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(numericRecoveryProof?.status, "passed", "typed numeric recovery error accounts for failed request");

    const partialRecoveryRecord = JSON.parse(JSON.stringify(numericRecoveryRecord));
    partialRecoveryRecord.providerEvidence.requestCount = 4;
    partialRecoveryRecord.measurements.agentTurns[0].requestCount = 3;
    partialRecoveryRecord.measurements.agentTurns[0].providerStatuses = [
      { value: 500, count: 2 },
      { value: 200, count: 1 }
    ];
    const partialRecoveryProof = buildAgentCliLocalTurnEvidenceInvariants(
      partialRecoveryRecord,
      recoveryScenario
    ).find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(partialRecoveryProof?.status, "missing", "every failed request requires distinct recovery evidence");

    const duplicateRecoveryRecord = JSON.parse(JSON.stringify(partialRecoveryRecord));
    duplicateRecoveryRecord.measurements.agentTurns[0].providerErrors.push({
      kind: "provider-error",
      requestId: "cold-http-failure",
      status: 500
    });
    const duplicateRecoveryProof = buildAgentCliLocalTurnEvidenceInvariants(
      duplicateRecoveryRecord,
      recoveryScenario
    ).find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(duplicateRecoveryProof?.status, "missing", "duplicate error records do not cover another failed request");

    const completeRecoveryRecord = JSON.parse(JSON.stringify(partialRecoveryRecord));
    completeRecoveryRecord.measurements.agentTurns[0].providerErrors.push({
      kind: "http",
      requestId: "cold-http-failure-2",
      status: 500
    });
    const completeRecoveryProof = buildAgentCliLocalTurnEvidenceInvariants(
      completeRecoveryRecord,
      recoveryScenario
    ).find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(completeRecoveryProof?.status, "passed", "distinct recovery errors cover every failed request");

    for (const malformedErrors of [
      [null],
      [{ kind: "http" }],
      [{ kind: "http", requestId: "cold-http-failure", status: 400 }]
    ]) {
      const malformedErrorRecord = JSON.parse(JSON.stringify(numericRecoveryRecord));
      malformedErrorRecord.measurements.agentTurns[0].providerErrors = malformedErrors;
      const malformedErrorProof = buildAgentCliLocalTurnEvidenceInvariants(
        malformedErrorRecord,
        recoveryScenario
      ).find((invariant) => invariant.id === "agent-cli-provider-proof");
      assertEqual(malformedErrorProof?.status, "missing", "malformed recovery errors do not authorize failed requests");
    }

    const omittedRecoveryStatusRecord = JSON.parse(JSON.stringify(statuslessRecoveryRecord));
    delete omittedRecoveryStatusRecord.measurements.agentTurns[0].providerErrors[0].status;
    const omittedRecoveryStatusProof = buildAgentCliLocalTurnEvidenceInvariants(
      omittedRecoveryStatusRecord,
      recoveryScenario
    ).find((invariant) => invariant.id === "agent-cli-provider-proof");
    assertEqual(omittedRecoveryStatusProof?.status, "missing", "omitted recovery status is incomplete evidence");

    for (const malformedStatus of [false, "missing", { malformed: true }]) {
      const malformedRecoveryRecord = JSON.parse(JSON.stringify(statuslessRecoveryRecord));
      malformedRecoveryRecord.measurements.agentTurns[0].providerErrors[0].status = malformedStatus;
      const malformedRecoveryProof = buildAgentCliLocalTurnEvidenceInvariants(
        malformedRecoveryRecord,
        recoveryScenario
      ).find((invariant) => invariant.id === "agent-cli-provider-proof");
      assertEqual(malformedRecoveryProof?.status, "missing", "malformed recovery error status is rejected");
    }

    for (const malformedTurns of [{ malformed: true }, [null]]) {
      const malformedTurnsRecord = JSON.parse(JSON.stringify(record));
      malformedTurnsRecord.measurements.agentTurns = malformedTurns;
      const malformedTurnsProof = buildAgentCliLocalTurnEvidenceInvariants(malformedTurnsRecord, scenario)
        .find((invariant) => invariant.id === "agent-cli-provider-proof");
      assertEqual(malformedTurnsProof?.status, "missing", "malformed provider turn array does not throw or pass");
    }

    const nonLocalRecord = syntheticAgentCliLocalTurnRecord({
      coldCommand: "ocm @kova -- agent --agent main --session-id kova-agent-cold-warm --message hi --json"
    });
    evaluateRecord(nonLocalRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const nonLocalInvariants = buildAgentCliLocalTurnEvidenceInvariants(nonLocalRecord, scenario);
    const transportProof = nonLocalInvariants.find((invariant) => invariant.id === "agent-cli-local-transport-proof");
    assertEqual(transportProof?.status, "failed", "non-local agent command fails local transport proof");

    const fabricatedDisabledHealthRecord = JSON.parse(JSON.stringify(record));
    fabricatedDisabledHealthRecord.measurements.health.final.failureCount = 0;
    const fabricatedDisabledHealthProof = buildAgentCliLocalTurnEvidenceInvariants(
      fabricatedDisabledHealthRecord,
      scenario
    ).find((invariant) => invariant.id === "agent-cli-no-service-health-proof");
    assertEqual(
      fabricatedDisabledHealthProof?.status,
      "missing",
      "disabled gateway health must remain explicit not-applicable evidence"
    );

    return {
      id: "agent-cli-local-turn-evidence-invariants",
      status: "PASS",
      command: "evaluate agent CLI local turn evidence completeness invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cli-local-turn-evidence-invariants",
      status: "FAIL",
      command: "evaluate agent CLI local turn evidence completeness invariants",
      durationMs: 0,
      message: error.message
    };
  }
}

export function agentGatewayRpcTurnEvidenceInvariantCheck() {
  try {
    const scenario = {
      id: "agent-gateway-rpc-turn",
      surface: "agent-gateway-rpc-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {},
      phases: [
        { id: "provision", healthScope: "none" },
        { id: "gateway-start", healthScope: "readiness" },
        { id: "gateway-agent-turn", healthScope: "post-ready" },
        { id: "post-agent-health", healthScope: "post-ready" }
      ]
    };
    const record = syntheticAgentGatewayRpcTurnRecord();
    evaluateRecord(record, scenario, {
      surface: {
        resourcePrimaryRole: "agent-cli",
        thresholds: {},
        diagnostics: { expectedSpans: ["gateway.ready", "plugins.metadata.scan"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const invariants = buildAgentGatewayRpcTurnEvidenceInvariants(record, scenario);
    assertEqual(invariants.length, 13, "agent Gateway RPC invariant count");
    assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "complete agent Gateway RPC evidence passes invariants");

    const localRuntimeRecord = syntheticAgentGatewayRpcTurnRecord();
    for (const phase of localRuntimeRecord.phases) {
      if (phase.metrics?.service) {
        phase.metrics.service.runtimeReleaseChannel = null;
      }
    }
    evaluateRecord(localRuntimeRecord, scenario, {
      surface: { resourcePrimaryRole: "agent-cli", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const localRuntimeInvariants = buildAgentGatewayRpcTurnEvidenceInvariants(localRuntimeRecord, scenario);
    const localRuntimeBinding = localRuntimeInvariants.find((invariant) => invariant.id === "agent-gateway-runtime-binding-proof");
    assertEqual(localRuntimeBinding?.status, "passed", "local runtime without a release track retains binding proof");

    const localRecord = syntheticAgentGatewayRpcTurnRecord({
      turnCommand: "ocm @kova -- agent --local --agent main --session-id kova-agent-gateway-rpc --message hi --json"
    });
    evaluateRecord(localRecord, scenario, {
      surface: { resourcePrimaryRole: "agent-cli", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const localInvariants = buildAgentGatewayRpcTurnEvidenceInvariants(localRecord, scenario);
    const transportProof = localInvariants.find((invariant) => invariant.id === "agent-gateway-rpc-transport-proof");
    assertEqual(transportProof?.status, "failed", "local agent command fails Gateway RPC transport proof");

    const missingHealthRecord = syntheticAgentGatewayRpcTurnRecord();
    for (const phase of missingHealthRecord.phases) {
      if (phase.metrics) {
        delete phase.metrics.readiness;
      }
    }
    evaluateRecord(missingHealthRecord, scenario, {
      surface: { resourcePrimaryRole: "agent-cli", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingHealthInvariants = buildAgentGatewayRpcTurnEvidenceInvariants(missingHealthRecord, scenario);
    const healthProof = missingHealthInvariants.find((invariant) => invariant.id === "agent-gateway-readiness-health-proof");
    assertEqual(healthProof?.status, "missing", "missing Gateway readiness is incomplete Gateway RPC proof");

    return {
      id: "agent-gateway-rpc-turn-evidence-invariants",
      status: "PASS",
      command: "evaluate agent Gateway RPC evidence completeness invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-gateway-rpc-turn-evidence-invariants",
      status: "FAIL",
      command: "evaluate agent Gateway RPC evidence completeness invariants",
      durationMs: 0,
      message: error.message
    };
  }
}
