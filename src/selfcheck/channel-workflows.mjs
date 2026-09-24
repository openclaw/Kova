import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveScriptStep } from "mock-ai-provider/dist/providers/openai/common/scripted-response.js";
import { declaredCapabilityProofRows } from "../../support/channel-conformance/capability-proof.mjs";
import { channelWorkflowScript } from "../../support/channel-workflow-provider-script.mjs";
import { summarizeChannelWorkflowResources } from "../collectors/channel-workflow-resources.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { applyEvidenceLedgerGating, attachEvidenceLedger } from "../evidence-ledger.mjs";
import { repoRoot } from "../paths.mjs";
import { buildReportSummary, summarizeRecords } from "../reporting/report.mjs";
import {
  appendChannelCapabilityEvidence,
  channelCapabilityEvidenceFromResult
} from "../run/channel-capability-results.mjs";
import { resourceSampleLine } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function channelCapabilityReportSummaryCheck() {
  try {
    const record = {
      scenario: "channel-telegram-capability-conformance",
      surface: "channel-telegram-capability-conformance",
      title: "Telegram Channel Capability Conformance",
      status: "PASS",
      state: { id: "fresh" },
      likelyOwner: "telegram adapter",
      phases: [],
      channelCapabilityEvidence: [{
        channelId: "telegram",
        group: "durable-final",
        capabilityId: "text",
        required: true,
        status: "passed",
        proofMode: "deterministic-shim",
        summary: "Telegram durable-final text delivery preserves assistant text"
      }, {
        channelId: "telegram",
        group: "durable-final",
        capabilityId: "media",
        required: true,
        status: "failed",
        proofMode: "deterministic-shim",
        summary: "Telegram durable-final media delivery preserves generated media",
        reason: "Telegram media adapter did not emit a sendMedia request",
        ownerArea: "telegram adapter"
      }, {
        channelId: "telegram",
        group: "ack",
        capabilityId: "after-agent-dispatch",
        required: true,
        status: "missing",
        proofMode: "deterministic-shim",
        summary: "Telegram ack is sent after agent dispatch",
        reason: "scenario helper did not emit the ack proof row",
        ownerArea: "Kova"
      }]
    };
    attachEvidenceLedger(record);
    applyEvidenceLedgerGating(record);
    const summary = buildReportSummary({
      mode: "execution",
      target: "local-build:/tmp/openclaw",
      records: [record],
      summary: summarizeRecords([record])
    });
    assertEqual(summary.channelCapabilities.total, 3, "channel capability row count");
    assertEqual(summary.channelCapabilities.required, 3, "channel capability required count");
    assertEqual(summary.channelCapabilities.passed, 1, "channel capability passed count");
    assertEqual(summary.channelCapabilities.failed, 1, "channel capability failed count");
    assertEqual(summary.channelCapabilities.missing, 1, "channel capability missing count");
    assertEqual(summary.channelCapabilities.byChannel[0]?.channelId, "telegram", "telegram channel capability summary");
    assertEqual(summary.channelCapabilities.failedRequired[0]?.capabilityId, "media", "failed capability summary row");
    assertEqual(summary.channelCapabilities.missingRequired[0]?.capabilityId, "after-agent-dispatch", "missing capability summary row");
    assertEqual(summary.findings.some((finding) =>
      finding.kind === "channel-capability" &&
      finding.severity === "fail" &&
      finding.ownerArea === "telegram adapter"
    ), true, "failed channel capability finding is emitted");
    return {
      id: "channel-capability-report-summary",
      status: "PASS",
      command: "evaluate channel capability report aggregation",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-capability-report-summary",
      status: "FAIL",
      command: "evaluate channel capability report aggregation",
      durationMs: 0,
      message: error.message
    };
  }
}

export function channelCapabilityResultIngestionCheck() {
  try {
    const result = {
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: "kova.channelCapabilityRun.v1",
        proofMode: "deterministic-shim",
        artifactPath: "/tmp/kova/channel-capability-result.json",
        ownerArea: "telegram adapter",
        capabilities: [{
          channelId: "telegram",
          group: "durable-final",
          capabilityId: "media",
          required: true,
          status: "failed",
          summary: "Telegram durable-final media delivery preserves generated media",
          reason: "sendMedia was not called"
        }]
      })
    };
    const evidence = channelCapabilityEvidenceFromResult(result, "channel-conformance", 0);
    assertEqual(evidence.length, 1, "channel capability result row parsed");
    assertEqual(evidence[0].phaseId, "channel-conformance", "channel capability phase id attached");
    assertEqual(evidence[0].commandIndex, 0, "channel capability command index attached");
    assertEqual(evidence[0].proofMode, "deterministic-shim", "channel capability proof mode attached");
    assertEqual(evidence[0].ownerArea, "telegram adapter", "channel capability owner attached");

    const workflowEvidence = channelCapabilityEvidenceFromResult({
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: "kova.channelProbeTurnRun.v1",
        proofMode: "workflow-baseline",
        artifactPath: "/tmp/kova/channel-probe-turn.json",
        ownerArea: "OpenClaw",
        capabilities: [{
          channelId: "openclaw",
          group: "workflow",
          capabilityId: "terminal-after-final",
          required: true,
          status: "passed",
          summary: "OpenClaw channel workflow baseline workflow/terminal-after-final",
          reason: null
        }]
      })
    }, "channel-model-turn-final-delivery", 0);
    assertEqual(workflowEvidence.length, 1, "channel probe turn capability row parsed");
    assertEqual(workflowEvidence[0].proofMode, "workflow-baseline", "channel probe turn proof mode attached");
    assertEqual(workflowEvidence[0].artifactPath, "/tmp/kova/channel-probe-turn.json", "channel probe turn artifact path attached");

    const compactEvidence = channelCapabilityEvidenceFromResult({
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: "kova.channelCapabilityRun.v1",
        proofMode: "channel-platform-conformance",
        artifactPath: "/tmp/kova/channel-conformance-telegram.json",
        ownerArea: "telegram adapter/runtime",
        capabilities: [{
          channelId: "telegram",
          group: "live-preview",
          capabilityId: "draft-preview",
          required: true,
          status: "missing",
          summary: "telegram live-preview:draft-preview capability has no selected user-flow proof",
          reason: "no selected telegram user flow proves live-preview:draft-preview"
        }]
      })
    }, "channel-telegram-runtime-workflows", 0);
    assertEqual(compactEvidence.length, 1, "compact channel capability row parsed");
    assertEqual(compactEvidence[0].status, "missing", "compact missing channel capability retained");
    assertEqual(compactEvidence[0].artifactPath, "/tmp/kova/channel-conformance-telegram.json", "compact channel capability row uses top-level artifact path");

    const record = {
      scenario: "channel-telegram-capability-conformance",
      surface: "channel-telegram-capability-conformance",
      status: "PASS",
      phases: []
    };
    appendChannelCapabilityEvidence(record, result, "channel-conformance", 0);
    attachEvidenceLedger(record);
    applyEvidenceLedgerGating(record);
    assertEqual(record.channelCapabilityEvidence.length, 1, "channel capability evidence appended to record");
    assertEqual(record.status, "FAIL", "ingested failed channel capability gates the record");

    let rejectedBadStatus = false;
    try {
      channelCapabilityEvidenceFromResult({
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: "kova.channelCapabilityRun.v1",
          capabilities: [{
            channelId: "telegram",
            group: "durable-final",
            capabilityId: "media",
            status: "unknown",
            summary: "bad status"
          }]
        })
      }, "channel-conformance", 0);
    } catch (error) {
      rejectedBadStatus = /status must be one of/.test(error.message);
    }
    assertEqual(rejectedBadStatus, true, "invalid channel capability status rejected");

    const ignored = channelCapabilityEvidenceFromResult({ status: 0, stdout: "{\"ok\":true}" }, "phase", 0);
    assertEqual(ignored.length, 0, "unrelated JSON command output ignored");

    return {
      id: "channel-capability-result-ingestion",
      status: "PASS",
      command: "evaluate channel capability helper result ingestion",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-capability-result-ingestion",
      status: "FAIL",
      command: "evaluate channel capability helper result ingestion",
      durationMs: 0,
      message: error.message
    };
  }
}

export function channelDeclaredCapabilityProofRowsCheck() {
  try {
    const channelRegistry = {
      id: "telegram",
      capabilities: [
        { group: "durable-final", id: "text" },
        { group: "durable-final", id: "media" },
        { group: "live-preview", id: "draft-preview" }
      ]
    };
    const workflowCoverage = {
      selectedRows: [{
        id: "basic-conversation.text",
        atoms: [{ group: "durable-final", id: "text" }]
      }, {
        id: "media-generation.image",
        atoms: [{ group: "durable-final", id: "media" }]
      }]
    };
    const rows = declaredCapabilityProofRows({
      channelId: "telegram",
      channelRegistry,
      workflowCoverage,
      rows: [
        { id: "basic-conversation.text", status: "passed" },
        {
          id: "media-generation.image",
          status: "failed",
          failureOwner: "openclaw-runtime",
          ownerArea: "OpenClaw media runtime"
        }
      ],
      artifactPath: "/tmp/kova/channel-conformance.json"
    });
    assertEqual(rows.length, 3, "declared capability proof row count");
    assertEqual(rows.find((row) => row.capabilityId === "text")?.status, "passed", "passed capability proof");
    assertEqual(rows.find((row) => row.capabilityId === "media")?.status, "failed", "failed capability proof");
    const missing = rows.find((row) => row.capabilityId === "draft-preview");
    assertEqual(missing?.status, "missing", "missing declared capability proof");
    assertEqual(missing?.required, true, "missing declared capability proof is required");

    const record = {
      scenario: "channel-telegram-capability-conformance",
      surface: "channel-telegram-capability-conformance",
      status: "PASS",
      phases: [],
      channelCapabilityEvidence: rows
    };
    attachEvidenceLedger(record);
    applyEvidenceLedgerGating(record);
    assertEqual(record.status, "FAIL", "failed declared capability proof fails record");

    const missingOnlyRecord = {
      ...record,
      status: "PASS",
      channelCapabilityEvidence: rows.filter((row) => row.status !== "failed")
    };
    attachEvidenceLedger(missingOnlyRecord);
    applyEvidenceLedgerGating(missingOnlyRecord);
    assertEqual(missingOnlyRecord.status, "INCOMPLETE", "missing declared capability proof gates record incomplete");

    return {
      id: "channel-declared-capability-proof-rows",
      status: "PASS",
      command: "evaluate declared channel capability proof rows",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-declared-capability-proof-rows",
      status: "FAIL",
      command: "evaluate declared channel capability proof rows",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function channelGeneratedMediaProviderScriptCheck() {
  try {
    const completionCaseId = "completion-handoff.image.generated-direct";
    const completionScript = channelWorkflowScript([completionCaseId], repoRoot);
    const completionStepIds = completionScript.steps.map((step) => step.id);
    assertEqual(completionStepIds.includes(`${completionCaseId}:final`), false, "completion handoff provider script does not force a final before the OpenClaw completion delivery turn");
    assertEqual(completionStepIds.includes(`${completionCaseId}:completion-tool-calls`), true, "completion handoff provider script models the OpenClaw completion delivery turn");
    const completionStep = completionScript.steps.find((step) => step.id === `${completionCaseId}:completion-tool-calls`);
    const completionRendered = await resolveScriptStep(completionStep, {
      requestBody: {
        input: [{
          content: [{
            text: "Attachments:\n1. type=image name=\"kova-completion-handoff-direct---abc.png\" path=\"/tmp/kova-completion-handoff-direct---abc.png\""
          }]
        }]
      }
    });
    const completionToolCall = completionRendered?.respond?.toolCalls?.[0];
    const completionArgs = JSON.parse(completionToolCall?.arguments ?? "{}");
    assertEqual(completionToolCall?.name, "message", "completion handoff provider script uses the message tool for completion delivery");
    assertEqual(completionArgs.action, "send", "completion handoff provider script sends generated media through message tool");
    assertEqual(completionArgs.media, "/tmp/kova-completion-handoff-direct---abc.png", "completion handoff provider script preserves the generated media path from the OpenClaw completion event");

    const sourceCaseId = "source-visible-delivery.media.message-tool-only";
    const sourceScript = channelWorkflowScript([sourceCaseId], repoRoot);
    const sourceStepIds = sourceScript.steps.map((step) => step.id);
    assertEqual(sourceStepIds.includes(`${sourceCaseId}:tool-calls`), true, "source media provider script sends media through message tool");
    assertEqual(sourceStepIds.includes(`${sourceCaseId}:final`), true, "source media provider script finalizes after message tool delivery");
    const sourceStep = sourceScript.steps.find((step) => step.id === `${sourceCaseId}:tool-calls`);
    const rendered = await resolveScriptStep(sourceStep, {
      requestBody: {}
    });
    const toolCall = rendered?.respond?.toolCalls?.[0];
    const args = JSON.parse(toolCall?.arguments ?? "{}");
    assertEqual(args.media, "kova-source-delivery-media.mp4", "source media provider script preserves the declared media path");
    assertEqual(args.action, "send", "source media provider script sends generated media through message tool");

    return {
      id: "channel-generated-media-provider-script",
      status: "PASS",
      command: "render generated media channel workflow scripts through mock provider templating",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-generated-media-provider-script",
      status: "FAIL",
      command: "render generated media channel workflow scripts through mock provider templating",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function channelWorkflowResourceAttributionCheck(tmp) {
  try {
    const dir = await mkdtemp(join(tmp, "channel-workflow-resources-"));
    const conformanceArtifactPath = join(dir, "channel-conformance-telegram.json");
    const resourceSampleArtifactPath = join(dir, "resource-samples.jsonl");
    const commandStartedAtEpochMs = 100000;

    await writeFile(conformanceArtifactPath, JSON.stringify({
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId: "telegram",
      rows: [{
        id: "final-text.reply-current",
        status: "passed",
        workflow: "final-text-current-reply",
        inventoryWorkflow: "final-delivery",
        matrix: {
          content: "text",
          route: "reply",
          delivery: "final",
          lifecycle: "success"
        },
        userAction: "user replies in a chat and receives a direct answer",
        startedAtEpochMs: commandStartedAtEpochMs + 1000,
        finishedAtEpochMs: commandStartedAtEpochMs + 3000,
        durationMs: 2000
      }, {
        id: "media-transformation.image-to-video",
        status: "passed",
        workflow: "media-transformation",
        inventoryWorkflow: "media-transformation",
        matrix: {
          content: "video",
          route: "reply",
          delivery: "completion-handoff",
          lifecycle: "async-completion"
        },
        userAction: "user sends an image and asks OpenClaw to make a video from it",
        startedAtEpochMs: commandStartedAtEpochMs + 4000,
        finishedAtEpochMs: commandStartedAtEpochMs + 8000,
        durationMs: 4000
      }]
    }, null, 2), "utf8");
    await writeFile(resourceSampleArtifactPath, [
      resourceSampleLine(1000, 210, 50, 5),
      resourceSampleLine(2000, 240, 60, 10),
      resourceSampleLine(5000, 720, 110, 70),
      resourceSampleLine(7000, 805, 120, 82),
      JSON.stringify({ elapsedMs: 8000, processes: [
        { pid: 1, rssMb: 950, cpuPercent: 20, roles: ["gateway", "agent-process"], currentRoles: ["agent-process"] },
        { pid: 2, rssMb: 2000, cpuPercent: 0, roles: ["gateway"], currentRoles: [] }
      ] })
    ].join("\n") + "\n", "utf8");

    const record = {
      scenario: "channel-telegram-capability-conformance",
      status: "PASS",
      phases: [{
        id: "channel-conformance",
        results: [{
          command: "node support/channel-conformance/run.mjs --channel telegram",
          status: 0,
          stdout: JSON.stringify({
            schemaVersion: "kova.channelCapabilityRun.v1",
            proofMode: "channel-platform-conformance",
            artifactPath: conformanceArtifactPath,
            channelId: "telegram",
            capabilities: []
          }),
          stderr: "",
          startedAtEpochMs: commandStartedAtEpochMs,
          finishedAtEpochMs: commandStartedAtEpochMs + 9000,
          durationMs: 9000,
          resourceSamples: {
            schemaVersion: "kova.resourceSamples.v1",
            sampleCount: 5,
            artifactPath: resourceSampleArtifactPath
          }
        }]
      }]
    };

    evaluateRecord(record, {
      id: "channel-telegram-capability-conformance",
      surface: "channel-telegram-capability-conformance",
      thresholds: {}
    }, {
      surface: { id: "channel-telegram-capability-conformance", thresholds: {} },
      targetPlan: { kind: "runtime" }
    });

    const resources = record.measurements.channelWorkflowResources;
    assertEqual(resources?.available, true, "channel workflow resource attribution available");
    assertEqual(resources?.caseCount, 2, "channel workflow resource case count");
    assertEqual(resources?.topByGatewayRss?.[0]?.caseId, "media-transformation.image-to-video", "highest gateway RSS is attributed to the media workflow");
    assertEqual(resources?.topByGatewayRss?.[0]?.peakGatewayRssMb, 805, "gateway RSS peak is captured from the workflow window");
    assertEqual(resources?.topByTrackedRss?.[0]?.peakTrackedRssMb, 950, "current agent RSS remains tracked while CPU-only wait owners add no RSS");
    assertEqual(resources?.topByGatewayRss?.[0]?.userAction, "user sends an image and asks OpenClaw to make a video from it", "user action is preserved with resource attribution");

    await writeFile(conformanceArtifactPath, JSON.stringify({
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId: "telegram",
      rows: [{
        id: "short-workflow",
        status: "passed",
        workflow: "short-workflow",
        startedAtEpochMs: commandStartedAtEpochMs,
        finishedAtEpochMs: commandStartedAtEpochMs + 5,
        durationMs: 5
      }]
    }), "utf8");
    await writeFile(resourceSampleArtifactPath, [
      resourceSampleLine(0, 210, 50, 5),
      resourceSampleLine(5, 210, 50, 10),
      resourceSampleLine(250, 210, 50, 70)
    ].join("\n") + "\n", "utf8");
    const shortResult = {
      startedAtEpochMs: commandStartedAtEpochMs,
      finishedAtEpochMs: commandStartedAtEpochMs + 5,
      stdout: JSON.stringify({
        schemaVersion: "kova.channelCapabilityRun.v1",
        proofMode: "channel-platform-conformance",
        artifactPath: conformanceArtifactPath,
        channelId: "telegram"
      }),
      resourceSamples: { artifactPath: resourceSampleArtifactPath }
    };
    const shortResources = summarizeChannelWorkflowResources([shortResult]);
    assertEqual(shortResources.rows[0]?.sampleCount, 3, "short workflow includes settled terminal sample");
    assertEqual(shortResources.rows[0]?.maxCpuPercent, 71, "short workflow reports settled terminal CPU");
    const unownedTerminal = summarizeChannelWorkflowResources([{
      ...shortResult,
      finishedAtEpochMs: undefined
    }]);
    assertEqual(unownedTerminal.rows[0]?.sampleCount, 2, "unowned terminal sample does not widen workflow windows");

    return {
      id: "channel-workflow-resource-attribution",
      status: "PASS",
      command: "attribute channel workflow resource samples to user workflow rows",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-workflow-resource-attribution",
      status: "FAIL",
      command: "attribute channel workflow resource samples to user workflow rows",
      durationMs: 0,
      message: error.message
    };
  }
}

export function channelModelTurnMultiInvariantEvaluationCheck() {
  try {
    const failedCaseId = "media-batch-final";
    const record = {
      scenario: "channel-model-turn-baseline",
      status: "PASS",
      phases: [{
        id: "channel-model-turn-final-delivery",
        results: [{
          command: "node support/run-channel-probe-turn.mjs --case media-batch-final",
          status: 0,
          stdout: JSON.stringify({
            schemaVersion: "kova.channelProbeTurnRun.v1",
            ok: false,
            envName: "kova-self-check",
            case: failedCaseId,
            workflowCaseCatalogId: "openclaw-channel-workflow-cases",
            workflowCaseIds: [failedCaseId],
            workflows: ["final-media-batch"],
            expectedText: "KOVA_AGENT_MEDIA_BATCH_OK",
            finalText: "KOVA_AGENT_MEDIA_BATCH_OK",
            inboundEventId: "kova-inbound-1",
            routeSessionKey: "agent:main:kova-channel-probe:dm",
            modelTurnCaseCount: 1,
            failedModelTurnCases: [{
              id: failedCaseId,
              workflow: "final-media-batch",
              inventoryWorkflow: "final-delivery",
              matrix: {
                content: "batch",
                route: "reply",
                delivery: "final",
                lifecycle: "success"
              },
              userAction: "user asks OpenClaw for multiple media results and receives every media item in the same conversation",
              ownerArea: "OpenClaw channel runtime",
              capabilities: [
                { group: "durable-final", id: "media" },
                { group: "durable-final", id: "batch" }
              ],
              reason: "media-batch-final produced exactly 2 final channel deliveries; observed 3",
              failedInvariants: [{
                id: "media-batch-final:final-delivery-count",
                reason: "media-batch-final produced exactly 2 final channel deliveries; observed 3"
              }, {
                id: "media-batch-final:unique-final-media",
                reason: "media-batch-final did not deliver the same media item more than once"
              }]
            }],
            capabilityRowCount: 6,
            activeStartedAtEpochMs: 1000,
            activeFinishedAtEpochMs: 2000,
            activeTurnMs: 1000,
            providerRequestDelta: 1,
            providerRequestScopedCount: 1
          }),
          stderr: "",
          durationMs: 1000
        }]
      }]
    };
    evaluateRecord(record, {
      id: "channel-model-turn-baseline",
      surface: "channel-model-turn-baseline",
      thresholds: {}
    }, {
      surface: { id: "channel-model-turn-baseline", thresholds: {} },
      targetPlan: { kind: "runtime" }
    });
    const violation = record.violations?.find((item) => item.metric === `channelModelTurn.case.${failedCaseId}`);
    assertEqual(record.status, "FAIL", "failed channel model turn case fails record");
    assertEqual(violation?.failedInvariantCount, 2, "all failed channel model turn invariants are preserved");
    assertEqual(violation?.failedInvariantSummary?.includes("media-batch-final:final-delivery-count"), true, "first failed invariant appears in summary");
    assertEqual(violation?.failedInvariantSummary?.includes("media-batch-final:unique-final-media"), true, "second failed invariant appears in summary");
    assertEqual(violation?.message.includes("invariants media-batch-final:final-delivery-count, media-batch-final:unique-final-media"), true, "violation message lists multiple failed invariants");
    return {
      id: "channel-model-turn-multi-invariant-evaluation",
      status: "PASS",
      command: "evaluate channel model turn multi-invariant reporting",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-model-turn-multi-invariant-evaluation",
      status: "FAIL",
      command: "evaluate channel model turn multi-invariant reporting",
      durationMs: 0,
      message: error.message
    };
  }
}
