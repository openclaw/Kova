import {
  gatewaySessionHealthOk,
  gatewaySessionHealthReason,
  nonNegativeNumber,
  numberOrNull,
  parseJsonObject,
  zeroCountInvariant
} from "./shared.mjs";

export function buildGatewaySessionEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const turns = collectGatewaySessionTurnResults(record);
  const expectedTurnCount = scenario.id === "gateway-session-send-turn" ? 2 : Math.max(1, turns.length);
  const health = record.measurements?.health ?? {};
  const providerEvidence = record.providerEvidence ?? {};
  const agentTurns = record.measurements?.agentTurns ?? [];
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;

  return [
    {
      id: "gateway-session-turn-json-captured",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => turn.result?.status === 0 && turn.payload)
        ? "passed"
        : "missing",
      summary: "cold/warm Gateway session helper command JSON was captured",
      artifactPath: null,
      reason: turns.length >= expectedTurnCount
        ? missingGatewaySessionPayloadReason(turns)
        : `expected at least ${expectedTurnCount} Gateway session turn result(s), found ${turns.length}`
    },
    {
      id: "gateway-session-direct-rpc-transport",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => turn.payload?.gatewayTransport?.kind === "direct-gateway-rpc")
        ? "passed"
        : "failed",
      summary: "Gateway session sends used direct Gateway RPC transport",
      artifactPath: null,
      reason: gatewaySessionTransportReason(turns)
    },
    {
      id: "gateway-session-response-content",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => gatewaySessionResponseOk(turn.payload))
        ? "passed"
        : "failed",
      summary: "Gateway session turns produced the expected assistant marker and assistant-count evidence",
      artifactPath: null,
      reason: gatewaySessionResponseReason(turns)
    },
    {
      id: "gateway-session-latency-windows",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => gatewaySessionLatencyOk(turn.payload))
        ? "passed"
        : "missing",
      summary: "Gateway session active-turn and response latency windows were measured",
      artifactPath: null,
      reason: gatewaySessionLatencyReason(turns)
    },
    {
      id: "gateway-session-provider-proof",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: providerProofOk(providerEvidence, agentTurns, expectedTurnCount) ? "passed" : "missing",
      summary: "provider request/response evidence was captured and attributed to every Gateway session turn",
      artifactPath: providerEvidence.summaryPath ?? providerArtifacts[0] ?? null,
      reason: providerProofReason(providerEvidence, agentTurns, expectedTurnCount)
    },
    {
      id: "gateway-session-readiness-health-proof",
      phaseId: "gateway-start",
      required: true,
      status: gatewaySessionHealthOk(record, health) ? "passed" : "missing",
      summary: "Gateway readiness, post-ready health, and final service state were measured",
      artifactPath: null,
      reason: gatewaySessionHealthReason(record, health)
    },
    zeroCountInvariant({
      id: "gateway-session-no-missing-runtime-dependency-errors",
      summary: "gateway logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "post-gateway-session-health"
    }),
    zeroCountInvariant({
      id: "gateway-session-no-plugin-load-failures",
      summary: "gateway logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "post-gateway-session-health"
    })
  ];
}

function collectGatewaySessionTurnResults(record) {
  const turns = [];
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (!result?.command?.includes("run-gateway-session-send-turn.mjs")) {
        continue;
      }
      turns.push({
        phaseId: phase.id,
        result,
        payload: parseJsonObject(result.stdout)
      });
    }
  }
  return turns;
}

function missingGatewaySessionPayloadReason(turns) {
  const bad = turns.find((turn) => turn.result?.status !== 0 || !turn.payload);
  if (!bad) {
    return null;
  }
  if (bad.result?.status !== 0) {
    return `${bad.phaseId} command exited ${bad.result?.status ?? "unknown"}`;
  }
  return `${bad.phaseId} did not emit parseable JSON`;
}

function gatewaySessionTransportReason(turns) {
  const bad = turns.find((turn) => turn.payload?.gatewayTransport?.kind !== "direct-gateway-rpc");
  if (!bad) {
    return null;
  }
  const transport = bad.payload?.gatewayTransport?.kind ?? "missing";
  return `${bad.phaseId} used ${transport}`;
}

function gatewaySessionResponseOk(payload) {
  if (!payload || payload.ok !== true || payload.expectedTextPresent !== true) {
    return false;
  }
  const assistantCount = numberOrNull(payload.assistantMessageCount);
  const minAssistantCount = numberOrNull(payload.minAssistantCount);
  return typeof payload.finalAssistantVisibleText === "string" &&
    payload.finalAssistantVisibleText.length > 0 &&
    assistantCount !== null &&
    minAssistantCount !== null &&
    assistantCount >= minAssistantCount;
}

function gatewaySessionResponseReason(turns) {
  const bad = turns.find((turn) => !gatewaySessionResponseOk(turn.payload));
  if (!bad) {
    return null;
  }
  if (!bad.payload) {
    return `${bad.phaseId} JSON payload was missing`;
  }
  if (bad.payload.ok !== true) {
    return `${bad.phaseId} payload ok was not true`;
  }
  if (bad.payload.expectedTextPresent !== true) {
    return `${bad.phaseId} did not report expected text present`;
  }
  const assistantCount = numberOrNull(bad.payload.assistantMessageCount);
  const minAssistantCount = numberOrNull(bad.payload.minAssistantCount);
  if (assistantCount === null || minAssistantCount === null || assistantCount < minAssistantCount) {
    return `${bad.phaseId} assistant count ${assistantCount ?? "missing"} was below required ${minAssistantCount ?? "missing"}`;
  }
  return `${bad.phaseId} final assistant text was missing`;
}

function gatewaySessionLatencyOk(payload) {
  return payload &&
    nonNegativeNumber(payload.activeTurnMs) &&
    nonNegativeNumber(payload.sendDurationMs) &&
    nonNegativeNumber(payload.timeToMatchedAssistantMs) &&
    nonNegativeNumber(payload.historyPollCount) &&
    numberOrNull(payload.historyErrorCount) === 0;
}

function gatewaySessionLatencyReason(turns) {
  const bad = turns.find((turn) => !gatewaySessionLatencyOk(turn.payload));
  if (!bad) {
    return null;
  }
  if (!bad.payload) {
    return `${bad.phaseId} JSON payload was missing`;
  }
  const missing = ["activeTurnMs", "sendDurationMs", "timeToMatchedAssistantMs", "historyPollCount"]
    .filter((key) => !nonNegativeNumber(bad.payload[key]));
  if (missing.length > 0) {
    return `${bad.phaseId} missing latency field(s): ${missing.join(", ")}`;
  }
  return `${bad.phaseId} historyErrorCount was ${bad.payload.historyErrorCount ?? "missing"}`;
}

function providerProofOk(providerEvidence, agentTurns, expectedTurnCount) {
  if (providerEvidence?.available !== true || providerEvidence.requestCount < expectedTurnCount) {
    return false;
  }
  const gatewayTurns = agentTurns.filter((turn) => turn.gatewaySession);
  if (gatewayTurns.length < expectedTurnCount) {
    return false;
  }
  return gatewayTurns.every((turn) =>
    turn.missingProviderRequest === false &&
    (turn.requestCount ?? 0) > 0 &&
    turn.providerAfterCommandEnd !== true &&
    turn.providerStatuses.every((status) => !Number.isFinite(Number(status.value)) || Number(status.value) < 400)
  );
}

function providerProofReason(providerEvidence, agentTurns, expectedTurnCount) {
  if (providerEvidence?.available !== true) {
    return providerEvidence?.error ?? "provider evidence was not available";
  }
  if (providerEvidence.requestCount < expectedTurnCount) {
    return `provider request count ${providerEvidence.requestCount ?? 0} was below required ${expectedTurnCount}`;
  }
  const gatewayTurns = agentTurns.filter((turn) => turn.gatewaySession);
  if (gatewayTurns.length < expectedTurnCount) {
    return `agent turn attribution count ${gatewayTurns.length} was below required ${expectedTurnCount}`;
  }
  const missing = gatewayTurns.find((turn) => turn.missingProviderRequest === true || (turn.requestCount ?? 0) === 0);
  if (missing) {
    return `${missing.phaseId} had no attributed provider request`;
  }
  const late = gatewayTurns.find((turn) => turn.providerAfterCommandEnd === true);
  if (late) {
    return `${late.phaseId} provider request arrived after command window by ${late.providerLateByMs ?? "unknown"}ms`;
  }
  const failedStatus = gatewayTurns.find((turn) =>
    turn.providerStatuses.some((status) => Number.isFinite(Number(status.value)) && Number(status.value) >= 400)
  );
  if (failedStatus) {
    return `${failedStatus.phaseId} had provider HTTP error status evidence`;
  }
  return null;
}
