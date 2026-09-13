import { evaluateRecord } from "../evaluator.mjs";
import { applyEvidenceLedgerGating, attachEvidenceLedger } from "../evidence-ledger.mjs";
import { buildUpgradeLogDerivedInvariants } from "../evidence/invariants.mjs";
import { attachCleanupEvidence } from "../evidence/record.mjs";
import {
  buildHealthMeasurement,
  healthKnownFailures,
  healthTotalFailures,
  healthTotalFailuresComplete
} from "../health.mjs";
import { buildReportSummary, summarizeRecords } from "../reporting/report.mjs";
import { syntheticUpgradeLogRecord, zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function evidenceLedgerGatingCheck() {
  try {
    const record = {
      scenario: "upgrade-existing-user",
      surface: "upgrade-existing-user",
      title: "Existing OpenClaw User Upgrade",
      status: "PASS",
      state: { id: "old-release-user" },
      likelyOwner: "Kova",
      phases: [{
        id: "post-upgrade",
        commands: ["ocm @kova-self-check -- status", "ocm @kova-self-check -- plugins list"],
        results: [{
          command: "ocm @kova-self-check -- status",
          status: 0,
          durationMs: 20
        }]
      }],
      finalMetrics: {
        error: null,
        service: { gatewayState: "running" },
        health: { ok: true, durationMs: 5 },
        healthSamples: [{ ok: true, durationMs: 5 }],
        healthSummary: { count: 1, failureCount: 0 }
      },
      measurements: {}
    };
    attachEvidenceLedger(record);
    applyEvidenceLedgerGating(record);
    assertEqual(record.status, "INCOMPLETE", "missing required ledger entry gates pass");
    assertEqual(record.evidenceLedger.completeness, "incomplete", "ledger completeness is incomplete");
    assertEqual(record.evidenceLedger.summary.requiredMissing, 1, "ledger missing count");
    assertEqual(record.incompleteEvidence?.[0], "command:post-upgrade:2", "incomplete evidence id");

    const failedRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [{
        id: "post-upgrade",
        commands: ["ocm @kova-self-check -- status"],
        results: [{
          command: "ocm @kova-self-check -- status",
          status: 1,
          durationMs: 20
        }]
      }]
    };
    attachEvidenceLedger(failedRecord);
    applyEvidenceLedgerGating(failedRecord);
    assertEqual(failedRecord.status, "FAIL", "failed required ledger entry gates pass");

    const missingMetricsRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: []
    };
    delete missingMetricsRecord.finalMetrics;
    attachEvidenceLedger(missingMetricsRecord);
    applyEvidenceLedgerGating(missingMetricsRecord);
    assertEqual(missingMetricsRecord.status, "INCOMPLETE", "absent final metrics gate pass as incomplete");
    assertEqual(
      missingMetricsRecord.evidenceLedger.entries.find((entry) => entry.id === "collector:final-metrics")?.status,
      "missing",
      "absent final metrics ledger status"
    );

    const disabledServiceRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      finalMetrics: {
        error: null,
        service: {
          gatewayState: "disabled",
          running: false,
          desiredRunning: false
        },
        health: null,
        healthSamples: [],
        healthSummary: null
      }
    };
    attachEvidenceLedger(disabledServiceRecord);
    applyEvidenceLedgerGating(disabledServiceRecord);
    assertEqual(disabledServiceRecord.status, "PASS", "intentionally disabled service needs no health samples");
    assertEqual(
      disabledServiceRecord.evidenceLedger.entries.find((entry) => entry.id === "collector:final-metrics")?.status,
      "passed",
      "disabled service final metrics ledger status"
    );

    const failedMetricsRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      finalMetrics: {
        error: "service status unavailable",
        service: null,
        health: null,
        healthSamples: []
      }
    };
    const health = buildHealthMeasurement(failedMetricsRecord);
    assertEqual(health.final.ok, null, "failed final metrics health is unknown");
    assertEqual(health.final.failureCount, null, "failed final metrics do not report zero failures");
    assertEqual(healthTotalFailures(health), null, "missing final metrics keep exact health failure total unknown");
    assertEqual(healthKnownFailures(health), 0, "missing final metrics retain known health failure lower bound");
    assertEqual(healthTotalFailuresComplete(health), false, "missing final metrics mark health total incomplete");
    attachEvidenceLedger(failedMetricsRecord);
    applyEvidenceLedgerGating(failedMetricsRecord);
    assertEqual(failedMetricsRecord.status, "INCOMPLETE", "failed final metrics gate pass as incomplete");
    assertEqual(failedMetricsRecord.evidenceLedger.completeness, "incomplete", "failed final metrics mark ledger incomplete");
    assertEqual(
      failedMetricsRecord.evidenceLedger.entries.find((entry) => entry.id === "collector:final-metrics")?.status,
      "failed",
      "failed final metrics ledger status"
    );

    const emptyErrorMetricsRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      finalMetrics: {
        ...record.finalMetrics,
        error: ""
      }
    };
    attachEvidenceLedger(emptyErrorMetricsRecord);
    applyEvidenceLedgerGating(emptyErrorMetricsRecord);
    assertEqual(emptyErrorMetricsRecord.status, "INCOMPLETE", "empty final metrics error gates pass");

    const incompleteSummaryRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      finalMetrics: {
        error: null,
        service: { gatewayState: "running" },
        health: null,
        healthSamples: [],
        healthSummary: { count: 1 }
      }
    };
    const incompleteSummaryHealth = buildHealthMeasurement(incompleteSummaryRecord);
    assertEqual(incompleteSummaryHealth.final.ok, null, "count-only final health summary is unknown");
    attachEvidenceLedger(incompleteSummaryRecord);
    applyEvidenceLedgerGating(incompleteSummaryRecord);
    assertEqual(incompleteSummaryRecord.status, "INCOMPLETE", "count-only final health summary gates pass");

    const malformedSamplesRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      finalMetrics: {
        error: null,
        service: { gatewayState: "running" },
        health: null,
        healthSamples: [{}],
        healthSummary: null
      }
    };
    const malformedSamplesHealth = buildHealthMeasurement(malformedSamplesRecord);
    assertEqual(malformedSamplesHealth.final.ok, null, "malformed final health samples are unknown");
    attachEvidenceLedger(malformedSamplesRecord);
    applyEvidenceLedgerGating(malformedSamplesRecord);
    assertEqual(malformedSamplesRecord.status, "INCOMPLETE", "malformed final health samples gate pass");

    const knownFailureRecord = {
      ...failedMetricsRecord,
      phases: [{
        id: "post-ready",
        healthScope: "post-ready",
        commands: [],
        results: [],
        metrics: {
          healthSamples: [{ ok: false, durationMs: 5 }]
        }
      }]
    };
    const knownFailureHealth = buildHealthMeasurement(knownFailureRecord);
    assertEqual(healthTotalFailures(knownFailureHealth), null, "observed failures do not fabricate an exact total");
    assertEqual(healthKnownFailures(knownFailureHealth), 1, "missing final metrics retain observed health failures");
    assertEqual(healthTotalFailuresComplete(knownFailureHealth), false, "observed lower bound remains incomplete");

    const incompleteServiceFailureRecord = {
      ...record,
      status: "PASS",
      phases: [],
      finalMetrics: {
        error: null,
        service: { gatewayState: " " },
        health: { ok: false, durationMs: 5 },
        healthSamples: [{ ok: false, durationMs: 5 }],
        healthSummary: { count: 1, failureCount: 1 }
      }
    };
    const incompleteServiceHealth = buildHealthMeasurement(incompleteServiceFailureRecord);
    assertEqual(incompleteServiceHealth.final.ok, null, "malformed service state keeps final health indeterminate");
    assertEqual(incompleteServiceHealth.final.failureCount, 1, "malformed service state retains observed final failure");
    evaluateRecord(incompleteServiceFailureRecord, { thresholds: { finalHealthFailures: 0 } });
    assertEqual(
      incompleteServiceFailureRecord.violations.some((violation) => violation.metric === "finalHealthFailures"),
      true,
      "observed final failure remains a threshold violation"
    );
    attachEvidenceLedger(incompleteServiceFailureRecord);
    assertEqual(
      incompleteServiceFailureRecord.evidenceLedger.entries.find((entry) => entry.id === "collector:final-metrics")?.status,
      "missing",
      "blank final gateway state is incomplete evidence"
    );

    const failedPhaseRecord = {
      ...record,
      status: "FAIL",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [{
        id: "source-runtime",
        commands: [
          "ocm upgrade kova-self-check --version 2026.4.20 --json",
          "ocm @kova-self-check -- status"
        ],
        results: [{
          command: "ocm upgrade kova-self-check --version 2026.4.20 --json",
          status: 1,
          durationMs: 20
        }]
      }]
    };
    attachEvidenceLedger(failedPhaseRecord);
    applyEvidenceLedgerGating(failedPhaseRecord);
    assertEqual(failedPhaseRecord.status, "FAIL", "phase failure remains failure");
    assertEqual(failedPhaseRecord.evidenceLedger.summary.requiredMissing, 0, "failed phase has no missing follow-up command");
    assertEqual(failedPhaseRecord.evidenceLedger.summary.requiredFailed, 2, "failed phase counts failed command and blocked follow-up");
    assertEqual(failedPhaseRecord.evidenceLedger.entries[1].status, "failed", "blocked follow-up command is marked failed");
    assertEqual(
      failedPhaseRecord.evidenceLedger.entries[1].reason,
      'not executed because command:source-runtime:1 in phase "source-runtime" failed: ocm upgrade kova-self-check --version 2026.4.20 --json (command exited 1)',
      "blocked follow-up reason"
    );

    const failedSnapshotRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [{
        id: "evidence-post-upgrade-snapshots",
        evidenceKind: "snapshot",
        evidenceIds: ["snapshot:post-upgrade-state"],
        evidenceRequired: [true],
        commands: ["ocm env exec kova-self-check -- node support/capture-openclaw-state.mjs"],
        results: [{
          command: "ocm env exec kova-self-check -- node support/capture-openclaw-state.mjs",
          status: 0,
          durationMs: 20,
          evidenceKind: "snapshot",
          evidenceId: "snapshot:post-upgrade-state",
          evidenceStatus: "failed",
          evidenceReason: "OpenClaw state snapshot did not find OPENCLAW_HOME"
        }]
      }]
    };
    attachEvidenceLedger(failedSnapshotRecord);
    applyEvidenceLedgerGating(failedSnapshotRecord);
    assertEqual(failedSnapshotRecord.status, "INCOMPLETE", "failed required snapshot evidence gates pass as incomplete");
    assertEqual(failedSnapshotRecord.evidenceLedger.completeness, "incomplete", "failed snapshot evidence marks ledger incomplete");

    const overBudgetArtifactRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      evidenceArtifacts: [{
        id: "record-budget",
        required: true,
        status: "failed",
        summary: "total retained evidence artifact bytes stay within the per-record cap",
        reason: "evidence artifacts used 9000000 bytes over cap 5242880"
      }]
    };
    attachEvidenceLedger(overBudgetArtifactRecord);
    applyEvidenceLedgerGating(overBudgetArtifactRecord);
    assertEqual(overBudgetArtifactRecord.status, "INCOMPLETE", "failed required artifact budget gates pass as incomplete");

    const missingCleanupRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      cleanupEvidence: [{
        id: "env-cleanup",
        required: true,
        status: "missing",
        summary: "disposable Kova env cleanup completed or was explicitly accounted for",
        reason: "cleanup result was not recorded"
      }]
    };
    attachEvidenceLedger(missingCleanupRecord);
    applyEvidenceLedgerGating(missingCleanupRecord);
    assertEqual(missingCleanupRecord.status, "INCOMPLETE", "missing required cleanup proof gates pass as incomplete");

    const retainedFailureCleanupRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      cleanup: "retained",
      retainedReason: "failure"
    };
    attachCleanupEvidence(retainedFailureCleanupRecord);
    attachEvidenceLedger(retainedFailureCleanupRecord);
    applyEvidenceLedgerGating(retainedFailureCleanupRecord);
    assertEqual(retainedFailureCleanupRecord.status, "PASS", "retain-on-failure cleanup proof is accounted for");
    assertEqual(retainedFailureCleanupRecord.cleanupEvidence?.[0]?.required, false, "retain-on-failure cleanup evidence is optional");

    const failedInvariantRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      evidenceInvariants: [{
        id: "plugin-install-index-preserved",
        required: true,
        status: "failed",
        summary: "plugin install index evidence is preserved across upgrade",
        reason: "count decreased from 1 to 0"
      }]
    };
    attachEvidenceLedger(failedInvariantRecord);
    applyEvidenceLedgerGating(failedInvariantRecord);
    assertEqual(failedInvariantRecord.status, "FAIL", "failed required invariant gates pass as fail");

    const failedChannelCapabilityRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      channelCapabilityEvidence: [{
        channelId: "telegram",
        group: "durable-final",
        capabilityId: "media",
        required: true,
        status: "failed",
        proofMode: "deterministic-shim",
        summary: "Telegram durable-final media delivery preserves the generated media payload",
        reason: "adapter returned success but Telegram sendMedia was not called",
        ownerArea: "telegram adapter"
      }]
    };
    attachEvidenceLedger(failedChannelCapabilityRecord);
    applyEvidenceLedgerGating(failedChannelCapabilityRecord);
    assertEqual(failedChannelCapabilityRecord.status, "FAIL", "failed required channel capability gates pass as fail");
    assertEqual(failedChannelCapabilityRecord.evidenceLedger.completeness, "complete", "failed channel capability is complete proof");
    assertEqual(
      failedChannelCapabilityRecord.evidenceLedger.entries[0].id,
      "channel-capability:telegram:durable-final:media",
      "channel capability ledger id"
    );

    const missingChannelCapabilityRecord = {
      ...record,
      status: "PASS",
      incompleteReason: undefined,
      incompleteEvidence: undefined,
      phases: [],
      channelCapabilityEvidence: [{
        channelId: "telegram",
        group: "durable-final",
        capabilityId: "media",
        required: true,
        status: "missing",
        proofMode: "deterministic-shim",
        summary: "Telegram durable-final media delivery preserves the generated media payload",
        reason: "scenario helper did not emit a media proof row",
        ownerArea: "Kova"
      }]
    };
    attachEvidenceLedger(missingChannelCapabilityRecord);
    applyEvidenceLedgerGating(missingChannelCapabilityRecord);
    assertEqual(missingChannelCapabilityRecord.status, "INCOMPLETE", "missing required channel capability gates pass as incomplete");
    assertEqual(missingChannelCapabilityRecord.incompleteEvidence?.[0], "channel-capability:telegram:durable-final:media", "missing channel capability evidence id");

    return {
      id: "evidence-ledger-gating",
      status: "PASS",
      command: "evaluate evidence ledger status gating",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "evidence-ledger-gating",
      status: "FAIL",
      command: "evaluate evidence ledger status gating",
      durationMs: 0,
      message: error.message
    };
  }
}

export function optionalDiagnosticGapCheck() {
  try {
    const record = {
      scenario: "diagnostic-gap",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: {
          available: true,
          eventCount: 1,
          parseErrorCount: 0,
          openSpanCount: 0,
          openSpans: [],
          keySpans: {},
          spanTotals: {
            "gateway.startup": { count: 1, totalDurationMs: 100, maxDurationMs: 100 }
          },
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    evaluateRecord(record, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(record.status, "PASS", "optional diagnostic gap does not fail user path");
    assertEqual(record.measurements.openclawMissingRequiredSpanSeverity, "diagnostic-gap", "optional diagnostic gap severity");
    assertEqual((record.violations ?? []).length, 0, "optional diagnostic gap does not create violation");
    return {
      id: "optional-diagnostic-gap",
      status: "PASS",
      command: "evaluate optional diagnostic gap behavior",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "optional-diagnostic-gap",
      status: "FAIL",
      command: "evaluate optional diagnostic gap behavior",
      durationMs: 0,
      message: error.message
    };
  }
}

export function missingCollectorProofCheck() {
  try {
    const missingRecord = syntheticUpgradeLogRecord({
      results: [{
        command: "ocm @kova-self-check -- doctor --fix",
        status: 0,
        stdout: "doctor ok\n",
        stderr: ""
      }]
    });
    evaluateRecord(missingRecord, { id: "upgrade-existing-user", thresholds: {} });
    assertEqual(missingRecord.measurements.missingDependencyErrors, null, "missing logs do not prove missing dependency zero");
    assertEqual(missingRecord.measurements.pluginLoadFailures, null, "missing logs do not prove plugin failure zero");
    const missingInvariants = Object.fromEntries(
      buildUpgradeLogDerivedInvariants(missingRecord).map((invariant) => [invariant.id, invariant])
    );
    assertEqual(
      missingInvariants["upgrade-logs-captured"].status,
      "missing",
      "missing logs are incomplete upgrade proof"
    );
    assertEqual(
      missingInvariants["no-missing-runtime-dependency-errors"].status,
      "missing",
      "missing dependency proof is incomplete without logs"
    );
    assertEqual(
      missingInvariants["no-plugin-load-failures"].status,
      "missing",
      "plugin load proof is incomplete without logs"
    );

    const explicitLogRecord = syntheticUpgradeLogRecord({
      results: [{
        command: "ocm logs kova-self-check --tail 300 --raw",
        status: 0,
        stdout: "gateway ready\n",
        stderr: ""
      }]
    });
    evaluateRecord(explicitLogRecord, { id: "upgrade-existing-user", thresholds: {} });
    assertEqual(explicitLogRecord.measurements.missingDependencyErrors, 0, "explicit log command proves missing dependency zero");
    assertEqual(explicitLogRecord.measurements.pluginLoadFailures, 0, "explicit log command proves plugin failure zero");
    return {
      id: "missing-collector-proof",
      status: "PASS",
      command: "evaluate missing collector proof semantics",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "missing-collector-proof",
      status: "FAIL",
      command: "evaluate missing collector proof semantics",
      durationMs: 0,
      message: error.message
    };
  }
}

export function provisioningBlockedStatusCheck() {
  try {
    const record = {
      scenario: "fresh-install",
      surface: "fresh-install",
      status: "BLOCKED",
      likelyOwner: "Kova",
      phases: [{
        id: "target-setup",
        commands: ["ocm runtime build-local kova-self-check --repo /tmp/openclaw --force"],
        results: [{
          command: "ocm runtime build-local kova-self-check --repo /tmp/openclaw --force",
          status: 1,
          stderr: "dependency install failed"
        }]
      }],
      cleanup: "already-absent"
    };
    const summary = buildReportSummary({
      mode: "execution",
      target: "local-build:/tmp/openclaw",
      records: [record],
      summary: summarizeRecords([record])
    });
    assertEqual(summary.decision.verdict, "BLOCKED", "provisioning failure remains blocked");
    assertEqual(summary.findings.some((finding) => finding.severity === "blocked"), true, "blocked finding is emitted");
    return {
      id: "provisioning-blocked-status",
      status: "PASS",
      command: "evaluate provisioning failure classification",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provisioning-blocked-status",
      status: "FAIL",
      command: "evaluate provisioning failure classification",
      durationMs: 0,
      message: error.message
    };
  }
}

export function cleanupProofRequiredCheck() {
  try {
    const record = {
      scenario: "upgrade-existing-user",
      surface: "upgrade-existing-user",
      status: "PASS",
      phases: [],
      cleanupEvidence: [{
        id: "env-cleanup",
        required: true,
        status: "missing",
        summary: "disposable Kova env cleanup completed or was explicitly accounted for",
        reason: "cleanup result was not recorded"
      }]
    };
    attachEvidenceLedger(record);
    applyEvidenceLedgerGating(record);
    assertEqual(record.status, "INCOMPLETE", "missing cleanup proof prevents pass");
    assertEqual(record.incompleteEvidence?.includes("cleanup:env-cleanup"), true, "missing cleanup evidence id");
    return {
      id: "cleanup-proof-required",
      status: "PASS",
      command: "evaluate required cleanup proof gating",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "cleanup-proof-required",
      status: "FAIL",
      command: "evaluate required cleanup proof gating",
      durationMs: 0,
      message: error.message
    };
  }
}
