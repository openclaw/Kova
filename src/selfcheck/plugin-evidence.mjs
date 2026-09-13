import { evaluateRecord } from "../evaluator.mjs";
import { buildOfficialPluginInstallEvidenceInvariants } from "../evidence/invariants.mjs";
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
