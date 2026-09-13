import { readFile } from "node:fs/promises";
import {
  computeProviderTurnAttribution,
  parseProviderRequestLog,
  parseTimelineProviderRequestLog
} from "../collectors/provider.mjs";
import { assertEqual, selfCheckPath } from "./harness.mjs";

export async function providerEvidenceParserCheck() {
  try {
    const text = [
      JSON.stringify({
        schemaVersion: "mock-ai-provider.request.v1",
        requestId: "req_health",
        receivedAt: "2026-04-30T10:00:00.000Z",
        receivedAtEpochMs: 1777543200000,
        respondedAt: "2026-04-30T10:00:00.001Z",
        respondedAtEpochMs: 1777543200001,
        method: "GET",
        route: "/health",
        path: "/health",
        status: 200
      }),
      await readFile(selfCheckPath("fixtures", "provider", "mock-requests.jsonl"), "utf8")
    ].join("\n");
    const evidence = parseProviderRequestLog(text);
    assertEqual(evidence.requestCount, 2, "provider request count");
    assertEqual(evidence.providerDurationMs, 6700, "provider duration includes first through last response");
    assertEqual(evidence.firstByteLatencyMs, 15, "first byte latency");
    const protocolEvidence = parseProviderRequestLog(JSON.stringify({
      schemaVersion: "mock-ai-provider.request.v1",
      requestId: "req_protocol",
      receivedAt: "2026-04-30T10:00:02.000Z",
      receivedAtEpochMs: 1777543202000,
      respondedAt: "2026-04-30T10:00:02.010Z",
      respondedAtEpochMs: 1777543202010,
      method: "POST",
      path: "/v1/responses",
      status: 200,
      matchedScriptStep: "kova-protocol-failure-response",
      responseType: "malformed"
    }));
    assertEqual(protocolEvidence.requests[0]?.mode, "protocol-failure", "protocol-failure inferred from script step");
    assertEqual(protocolEvidence.requests[0]?.errorClass, "malformed-response", "protocol-failure malformed response class");
    const disconnectEvidence = parseProviderRequestLog(JSON.stringify({
      schemaVersion: "mock-ai-provider.request.v1",
      requestId: "req_disconnect",
      receivedAt: "2026-04-30T10:00:03.000Z",
      receivedAtEpochMs: 1777543203000,
      respondedAt: "2026-04-30T10:00:03.010Z",
      respondedAtEpochMs: 1777543203010,
      method: "POST",
      path: "/v1/responses",
      status: 503,
      matchedScriptStep: "kova-disconnect-then-recover-disconnect",
      responseType: "error",
      errorClass: "provider-disconnect"
    }));
    assertEqual(disconnectEvidence.requests[0]?.mode, "disconnect-then-recover", "disconnect recovery inferred from script step");
    assertEqual(disconnectEvidence.requests[0]?.errorClass, "provider-disconnect", "disconnect error class preserved");
    const timelineEvidence = parseTimelineProviderRequestLog([
      JSON.stringify({
        schemaVersion: "openclaw.diagnostics.v1",
        type: "provider.request",
        timestamp: "2026-04-30T10:00:01.250Z",
        name: "provider.request",
        provider: "openai",
        operation: "responses.create",
        model: "gpt-5.5",
        durationMs: 350,
        ok: true
      })
    ].join("\n"));
    assertEqual(timelineEvidence.requestCount, 1, "timeline provider request count");
    assertEqual(timelineEvidence.providerDurationMs, 350, "timeline provider duration");
    assertEqual(timelineEvidence.requests[0]?.route, "responses.create", "timeline provider route");
    const attribution = computeProviderTurnAttribution({
      command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
      startedAt: "2026-04-30T10:00:01.000Z",
      startedAtEpochMs: 1777543201000,
      finishedAt: "2026-04-30T10:00:07.000Z",
      finishedAtEpochMs: 1777543207000
    }, {
      ...evidence,
      available: true
    });
    assertEqual(attribution.preProviderMs, 5000, "pre-provider latency");
    assertEqual(attribution.providerFinalMs, 800, "provider final latency");
    assertEqual(attribution.postProviderMs, 200, "post-provider latency");
    const incompleteAttribution = computeProviderTurnAttribution({
      command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
      startedAt: "2026-04-30T10:00:01.000Z",
      startedAtEpochMs: 1777543201000,
      finishedAt: "2026-04-30T10:00:07.000Z",
      finishedAtEpochMs: 1777543207000
    }, {
      available: true,
      requests: [{
        requestId: "req_incomplete",
        receivedAt: "2026-04-30T10:00:05.000Z",
        receivedAtEpochMs: 1777543205000,
        route: "/v1/responses",
        model: "gpt-5.5",
        status: null,
        errorClass: "provider-timeout"
      }]
    });
    assertEqual(incompleteAttribution.requestCount, 1, "incomplete provider request remains attributed");
    assertEqual(incompleteAttribution.missingProviderRequest, false, "started provider request is not erased as missing");
    assertEqual(incompleteAttribution.providerFinalMs, null, "incomplete provider response has no final latency");
    assertEqual(incompleteAttribution.errors[0]?.kind, "provider-timeout", "incomplete provider error evidence is retained");
    const partiallyCompleteAttribution = computeProviderTurnAttribution({
      command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
      startedAt: "2026-04-30T10:00:01.000Z",
      startedAtEpochMs: 1777543201000,
      finishedAt: "2026-04-30T10:00:07.000Z",
      finishedAtEpochMs: 1777543207000
    }, {
      available: true,
      requests: [
        {
          requestId: "req_complete",
          receivedAt: "2026-04-30T10:00:04.000Z",
          receivedAtEpochMs: 1777543204000,
          respondedAt: "2026-04-30T10:00:05.000Z",
          respondedAtEpochMs: 1777543205000,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200
        },
        {
          requestId: "req_incomplete_after_complete",
          receivedAt: "2026-04-30T10:00:05.500Z",
          receivedAtEpochMs: 1777543205500,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          errorClass: "provider-timeout"
        }
      ]
    });
    assertEqual(partiallyCompleteAttribution.requestCount, 2, "mixed provider requests remain attributed");
    assertEqual(partiallyCompleteAttribution.providerFinalMs, null, "one incomplete request invalidates provider final latency");
    const lateIncompleteAttribution = computeProviderTurnAttribution({
      command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
      startedAt: "2026-04-30T10:00:01.000Z",
      startedAtEpochMs: 1777543201000,
      finishedAt: "2026-04-30T10:00:07.000Z",
      finishedAtEpochMs: 1777543207000
    }, {
      available: true,
      requests: [{
        requestId: "req_late_incomplete",
        receivedAt: "2026-04-30T10:00:08.000Z",
        receivedAtEpochMs: 1777543208000,
        route: "/v1/responses",
        model: "gpt-5.5",
        status: null,
        errorClass: "provider-timeout"
      }]
    });
    assertEqual(lateIncompleteAttribution.providerAfterCommandEnd, true, "late incomplete provider request is retained");
    assertEqual(lateIncompleteAttribution.preProviderMs, null, "late incomplete request has no pre-provider duration");
    assertEqual(lateIncompleteAttribution.preProviderDominates, null, "late incomplete request has no dominance ratio");
    const malformedRequestAttribution = computeProviderTurnAttribution({
      command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
      startedAt: "2026-04-30T10:00:01.000Z",
      startedAtEpochMs: 1777543201000,
      finishedAt: "2026-04-30T10:00:07.000Z",
      finishedAtEpochMs: 1777543207000
    }, {
      available: true,
      requests: [null]
    });
    assertEqual(malformedRequestAttribution.requestCount, 0, "malformed provider request entries are rejected");
    assertEqual(malformedRequestAttribution.missingProviderRequest, true, "malformed provider requests fail closed");
    assertEqual(evidence.usage?.available, true, "provider usage availability");
    assertEqual(evidence.usage?.totalTokens, 12, "provider usage total tokens");
    return {
      id: "provider-evidence-parser",
      status: "PASS",
      command: "parse fixtures/provider/mock-requests.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provider-evidence-parser",
      status: "FAIL",
      command: "parse fixtures/provider/mock-requests.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}
