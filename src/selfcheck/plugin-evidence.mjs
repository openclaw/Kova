import { evaluateRecord } from "../evaluator.mjs";
import { attachEvidenceInvariants, buildOfficialPluginInstallEvidenceInvariants } from "../evidence/invariants.mjs";
import { applyEvidenceLedgerGating } from "../evidence-ledger.mjs";
import { syntheticOfficialPluginInstallRecord } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function officialPluginInstallEvidenceInvariantCheck() {
  try {
    const record = syntheticOfficialPluginInstallRecord();
    const scenario = {
      id: "official-plugin-install",
      surface: "official-plugin-install",
      thresholds: {},
      phases: [
        { id: "provision", healthScope: "readiness" },
        { id: "install", healthScope: "post-ready" },
        { id: "restart", healthScope: "readiness" },
        { id: "post-restart-verify", healthScope: "post-ready" }
      ]
    };
    evaluateRecord(record, scenario, {
      surface: {
        thresholds: {},
        diagnostics: { expectedSpans: ["plugins.metadata.scan"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const invariants = buildOfficialPluginInstallEvidenceInvariants(record, scenario);
    assertEqual(invariants.length, 10, "official plugin invariant count");
    assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "complete official plugin evidence passes invariants");

    const blockedRecord = syntheticOfficialPluginInstallRecord({
      helperPayload: { securityBlocked: true, securityBlockCount: 1, securityEvidence: "@openclaw/discord blocked" }
    });
    evaluateRecord(blockedRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const blockedInvariants = buildOfficialPluginInstallEvidenceInvariants(blockedRecord, scenario);
    const securityProof = blockedInvariants.find((invariant) => invariant.id === "official-plugin-security-proof");
    assertEqual(securityProof?.status, "failed", "security block is failed official plugin evidence");

    for (const malformedCount of [undefined, "0", -1]) {
      const malformedSecurityRecord = syntheticOfficialPluginInstallRecord({
        helperPayload: { securityBlockCount: malformedCount }
      });
      evaluateRecord(malformedSecurityRecord, scenario, {
        surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
        targetPlan: { kind: "runtime" }
      });
      const malformedSecurityProof = buildOfficialPluginInstallEvidenceInvariants(malformedSecurityRecord, scenario)
        .find((invariant) => invariant.id === "official-plugin-security-proof");
      assertEqual(
        malformedSecurityProof?.status,
        "missing",
        `security block count ${JSON.stringify(malformedCount)} is incomplete evidence`
      );
    }

    const evaluateCounts = (candidate) => {
      evaluateRecord(candidate, scenario, {
        surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
        targetPlan: { kind: "runtime" }
      });
      attachEvidenceInvariants(candidate, scenario);
      applyEvidenceLedgerGating(candidate);
      return {
        record: candidate,
        evidence: candidate.measurements.officialPluginEvidence,
        proof: candidate.evidenceInvariants.find((invariant) => invariant.id === "official-plugin-install-proof")
      };
    };
    const installResults = (candidate) => candidate.phases.find((phase) => phase.id === "install").results;
    const complete = evaluateCounts(syntheticOfficialPluginInstallRecord());
    assertEqual(complete.record.status, "PASS", "explicit zero failed-required count passes complete plugin proof");
    for (const field of ["requiredPluginCount", "failedRequiredCount"]) {
      for (const value of [undefined, null, field === "requiredPluginCount" ? "1" : "0", -1, 0.5, {}, true, Number.MAX_SAFE_INTEGER + 1]) {
        for (const mixed of [false, true]) {
          const candidate = syntheticOfficialPluginInstallRecord({ helperPayload: { [field]: value } });
          if (mixed) installResults(candidate).unshift(...installResults(syntheticOfficialPluginInstallRecord()));
          const result = evaluateCounts(candidate);
          const label = `${mixed ? "partial " : ""}${field}=${JSON.stringify(value)}`;
          assertEqual(result.evidence[field], null, `${label} stays unknown`);
          assertEqual(result.proof?.status, "missing", `${label} leaves install proof incomplete`);
          assertEqual(result.proof?.reason.includes("count was not collected"), true, `${label} explains the missing count`);
          assertEqual(result.record.status, "INCOMPLETE", `${label} cannot pass the evidence ledger`);
        }
      }
    }
    const repeated = syntheticOfficialPluginInstallRecord();
    installResults(repeated).push(...installResults(syntheticOfficialPluginInstallRecord()));
    const repeatedCounts = evaluateCounts(repeated);
    assertEqual(repeatedCounts.record.status, "PASS", "complete repeated plugin receipts pass");
    assertEqual(repeatedCounts.evidence.requiredPluginCount, 1, "required count keeps maximum across runs");
    assertEqual(repeatedCounts.evidence.failedRequiredCount, 0, "explicit zero failures remain zero across runs");
    const failure = syntheticOfficialPluginInstallRecord({ helperPayload: { ok: false, failedRequiredCount: 1 } });
    installResults(failure).push(...structuredClone(installResults(failure)));
    const failedCounts = evaluateCounts(failure);
    assertEqual(failedCounts.evidence.failedRequiredCount, 2, "known required failures add across runs");
    assertEqual(failedCounts.proof.status, "failed", "explicit required failures fail install proof");
    assertEqual(failedCounts.record.status, "FAIL", "known required failures stay failed");
    const optionalOnly = evaluateCounts(syntheticOfficialPluginInstallRecord({ helperPayload: { requiredPluginCount: 0 } }));
    assertEqual(optionalOnly.proof.status, "failed", "zero required plugins cannot prove a required install");
    const overflow = syntheticOfficialPluginInstallRecord({ helperPayload: {
      ok: false, pluginCount: Number.MAX_SAFE_INTEGER, requiredPluginCount: Number.MAX_SAFE_INTEGER, failedRequiredCount: Number.MAX_SAFE_INTEGER
    } });
    installResults(overflow).push(...structuredClone(installResults(overflow)));
    overflow.status = "FAIL";
    const overflowCounts = evaluateCounts(overflow);
    assertEqual(overflowCounts.evidence.failedRequiredCount, null, "overflowing failure totals stay unknown");
    assertEqual(overflowCounts.proof.status, "missing", "overflowing failure totals are incomplete proof");
    assertEqual(overflowCounts.record.status, "FAIL", "incomplete counts do not erase an existing failed record");

    const missingHelperRecord = syntheticOfficialPluginInstallRecord({ includeInstallHelper: false });
    evaluateRecord(missingHelperRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingHelperInvariants = buildOfficialPluginInstallEvidenceInvariants(missingHelperRecord, scenario);
    const installProof = missingHelperInvariants.find((invariant) => invariant.id === "official-plugin-install-proof");
    assertEqual(installProof?.status, "missing", "missing official plugin helper JSON is incomplete proof");

    const missingBaselineRecord = syntheticOfficialPluginInstallRecord();
    missingBaselineRecord.phases[0].results = missingBaselineRecord.phases[0].results
      .filter((result) => !result.command.includes(" -- plugins list"));
    evaluateRecord(missingBaselineRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingBaselineProof = buildOfficialPluginInstallEvidenceInvariants(missingBaselineRecord, scenario)
      .find((invariant) => invariant.id === "official-plugin-command-receipts");
    assertEqual(missingBaselineProof?.status, "missing", "baseline plugin list must come from provision phase");

    const missingFinalVerifyRecord = syntheticOfficialPluginInstallRecord();
    missingFinalVerifyRecord.phases[3].results = missingFinalVerifyRecord.phases[3].results
      .filter((result) => !result.command.includes(" -- plugins list"));
    evaluateRecord(missingFinalVerifyRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingFinalVerifyInvariants = buildOfficialPluginInstallEvidenceInvariants(missingFinalVerifyRecord, scenario);
    assertEqual(
      missingFinalVerifyInvariants.find((invariant) => invariant.id === "official-plugin-command-receipts")?.status,
      "missing",
      "post-restart plugin list must come from verification phase"
    );
    assertEqual(
      missingFinalVerifyInvariants.find((invariant) => invariant.id === "official-plugin-command-usability-proof")?.status,
      "missing",
      "post-restart usability proof requires its own command receipt"
    );

    const missingFinalHealthRecord = syntheticOfficialPluginInstallRecord();
    delete missingFinalHealthRecord.finalMetrics.health;
    delete missingFinalHealthRecord.finalMetrics.healthSummary;
    evaluateRecord(missingFinalHealthRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingFinalHealthProof = buildOfficialPluginInstallEvidenceInvariants(missingFinalHealthRecord, scenario)
      .find((invariant) => invariant.id === "official-plugin-readiness-health-proof");
    assertEqual(missingFinalHealthProof?.status, "missing", "official plugin proof requires explicit final health failure count");

    const missingPostVerifyFailureRecord = syntheticOfficialPluginInstallRecord();
    delete missingPostVerifyFailureRecord.phases[3].metrics.healthSummary.failureCount;
    evaluateRecord(missingPostVerifyFailureRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingPostVerifyFailureProof = buildOfficialPluginInstallEvidenceInvariants(
      missingPostVerifyFailureRecord,
      scenario
    ).find((invariant) => invariant.id === "official-plugin-readiness-health-proof");
    assertEqual(
      missingPostVerifyFailureProof?.status,
      "missing",
      "official plugin proof requires explicit post-restart failure count"
    );

    return {
      id: "official-plugin-install-evidence-invariants",
      status: "PASS",
      command: "evaluate official plugin install evidence completeness invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "official-plugin-install-evidence-invariants",
      status: "FAIL",
      command: "evaluate official plugin install evidence completeness invariants",
      durationMs: 0,
      message: error.message
    };
  }
}
