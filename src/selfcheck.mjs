import { createHash } from "node:crypto";
import { cp, mkdir, readFile, truncate, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { collectErrorFlags, parseFlags } from "./cli.mjs";
import { quoteShell, runCommand } from "./commands.mjs";
import { RESOURCE_HEADLINE_CONTRACT, RESOURCE_MEASUREMENT_SCOPE } from "./performance/stats.mjs";
import { bundleReport } from "./reporting/artifacts.mjs";
import { renderRunReceipt } from "./reporting/render-run-receipt.mjs";
import { createSelfCheckProgress, renderSelfCheckReceipt } from "./reporting/render-selfcheck.mjs";
import { createRunId } from "./run/run-id.mjs";
import { runInSelfCheckScope } from "./selfcheck-scope.mjs";
import {
  agentCliLocalTurnEvidenceInvariantCheck,
  agentGatewayRpcTurnEvidenceInvariantCheck
} from "./selfcheck/agent-evidence.mjs";
import { agentColdWarmEvaluationCheck, agentTurnBreakdownCheck } from "./selfcheck/agent-turns.mjs";
import { buildPaxRecord, buildTarGzipFixture } from "./selfcheck/archive-fixtures.mjs";
import {
  agentCliPreProviderAttributionCheck,
  gatewaySessionPreProviderAttributionCheck
} from "./selfcheck/attribution.mjs";
import { performanceBaselineCheck } from "./selfcheck/baselines.mjs";
import {
  browserAutomationEvidenceEvaluationCheck,
  mediaUnderstandingEvidenceEvaluationCheck,
  networkOfflineEvidenceEvaluationCheck
} from "./selfcheck/browser-media.mjs";
import { channelCapabilityRegistryCheck } from "./selfcheck/channel-registry.mjs";
import {
  channelCapabilityReportSummaryCheck,
  channelCapabilityResultIngestionCheck,
  channelDeclaredCapabilityProofRowsCheck,
  channelGeneratedMediaProviderScriptCheck,
  channelModelTurnMultiInvariantEvaluationCheck,
  channelWorkflowResourceAttributionCheck
} from "./selfcheck/channel-workflows.mjs";
import { cleanupArtifactsCheck, cleanupEnvSafetyCheck, cleanupRetryCheck } from "./selfcheck/cleanup.mjs";
import { collectionPolicyResolverCheck } from "./selfcheck/collection-policy.mjs";
import {
  collectorArtifactCollisionCheck,
  stateFixtureCollectorFailureCheck
} from "./selfcheck/collector-artifacts.mjs";
import {
  commandResultContractCheck,
  commandResultInterpretationCheck,
  expectedMockProviderFailureTimeoutLogCheck,
  optionalNoLogsCommandCheck
} from "./selfcheck/command-results.mjs";
import {
  commandOutputBudgetCheck,
  commandTimeoutContractCheck,
  logArtifactRedactionCheck,
  logSnippetBudgetCheck
} from "./selfcheck/commands.mjs";
import {
  compareGatewayRssDedupeCheck,
  compareIdentityAndRollupCheck,
  compareMetricOrderingCheck,
  compareRepeatAggregationCheck,
  resourceContractCompareCheck,
  sourceReleaseCompareCheck
} from "./selfcheck/compare.mjs";
import {
  credentialStoreConcurrentWritersCheck,
  credentialStoreInterruptedTransactionCheck,
  credentialStoreLegacyFallbackMigrationCheck,
  credentialStoreSelfCheck
} from "./selfcheck/credentials.mjs";
import { diagnosticTriggerValidationCheck } from "./selfcheck/diagnostic-signals.mjs";
import {
  cleanupProofRequiredCheck,
  evidenceLedgerGatingCheck,
  missingCollectorProofCheck,
  optionalDiagnosticGapCheck,
  provisioningBlockedStatusCheck
} from "./selfcheck/evidence-ledger.mjs";
import {
  anthropicApiKeyOpenClawConfigCheck,
  claudeCliLoggedOutCheck,
  claudeCliOpenClawConfigCheck,
  directCredentialProviderPairingCheck,
  externalCliOpenClawConfigCheck,
  externalCliProviderPairingCheck,
  externalCliRunAuthVerificationCheck,
  externalCliSetupCheck,
  externalCliSetupRejectsUnauthenticatedCheck,
  mockAuthOpenClawConfigCheck
} from "./selfcheck/external-cli.mjs";
import { fileLockRecoveryCheck } from "./selfcheck/file-lock.mjs";
import {
  gatewaySessionEvidenceInvariantCheck,
  gatewaySessionHistoryTextExtractionCheck,
  gatewaySessionTurnEvaluationCheck
} from "./selfcheck/gateway-evidence.mjs";
import {
  assertArray,
  assertArrayNotEmpty,
  assertEqual,
  assertString,
  commandCheck,
  failingCommandCheck,
  fileExists,
  inlineCheck,
  jsonCommandCheck,
  jsonFailureCommandCheck,
  readSelfCheckJson,
  syntaxCheck,
  validateReport
} from "./selfcheck/harness.mjs";
import {
  agentContainmentHealthScopeCheck,
  healthFailureThresholdPolicyCheck,
  healthReadinessModelCheck,
  readinessClassificationCheck
} from "./selfcheck/health.mjs";
import {
  concurrentAgentRunnerCheck,
  officialPluginInstallRunnerCheck,
  openAiCompatibleTurnFrontageCheck,
  soakLoopRunnerCheck
} from "./selfcheck/helper-runners.mjs";
import { inventoryManifestContractsCheck, inventoryPlanCheck, repeatedWorkAuditCheck } from "./selfcheck/inventory.mjs";
import {
  embeddedRunLogParserCheck,
  runtimeDepsLogParserCheck,
  runtimeDepsWarmReuseEvaluationCheck
} from "./selfcheck/legacy-logs.mjs";
import {
  liveAnthropicExternalCliDryRunCheck,
  liveApiKeyExecutionCheck,
  liveExternalCliDryRunCheck
} from "./selfcheck/live-auth.mjs";
import {
  doctorUpgradeGatePolicyCheck,
  gateDryRunCheck,
  gateExecutedCoverageDimensionsCheck,
  gateNonReleaseOutcomeCheck,
  gatePartialFailureCheck,
  gatePartialPassCheck,
  gatePlatformCoverageCheck,
  gateRequirementCoverageCheck,
  gateScenarioWildcardCheck,
  gateSubsystemSummaryCheck,
  matrixWorkerRejectionCheck
} from "./selfcheck/matrix.mjs";
import {
  diagnosticArtifactIdentityCheck,
  mockProviderBehaviorCheck,
  mockProviderProcessSafetyCheck,
  mockProviderScriptModesCheck
} from "./selfcheck/mock-provider.mjs";
import {
  adversarialInputHelperExactFrontageCheck,
  cronGatewayTokenEnvCheck,
  mcpToolCallSmokeRedactsGatewayTokenCheck,
  networkFrontageBootstrapCommandsBypassPreflightCheck,
  networkFrontageHelperEndpointCheck,
  networkFrontageNoChildTcpCheck,
  networkFrontagePartialStartupCleanupInvariantCheck,
  networkFrontageProductGuardCheck,
  networkFrontageProductPreflightBlocksPendingCheck,
  networkFrontageRuntimeEnvCheck
} from "./selfcheck/network-frontage.mjs";
import {
  envNameLengthCheck,
  guardedTeardownStagesCheck,
  localBuildRuntimeNameCheck,
  measurementPhaseOwnershipCheck,
  ocmCommandBuildersCheck,
  ocmMissingResourceCheck
} from "./selfcheck/ocm.mjs";
import { officialPluginInstallEvidenceInvariantCheck } from "./selfcheck/plugin-evidence.mjs";
import { pluginInstallIndexFixturesCheck } from "./selfcheck/plugin-fixtures.mjs";
import { pluginRecoveryEvidenceEvaluationCheck } from "./selfcheck/plugin-recovery.mjs";
import {
  cpuProfileParserCheck,
  diagnosticProfilerMeasurementScopeCheck,
  heapProfileParserCheck
} from "./selfcheck/profilers.mjs";
import {
  adversarialInputEvaluationCheck,
  agentAuthFailureEvaluationCheck,
  providerConcurrentEvaluationCheck,
  providerFailureEvaluationCheck,
  providerSpecificFailureEvaluationCheck
} from "./selfcheck/provider-evaluation.mjs";
import { providerEvidenceParserCheck } from "./selfcheck/provider-evidence.mjs";
import { cleanupPublicationReceiptCheck, reportPublicationCheck } from "./selfcheck/publication.mjs";
import {
  scenarioCleanupOwnershipCheck,
  scenarioCloneFirstValidationCheck,
  scenarioHealthScopeValidationCheck,
  scenarioStateCompatibilityCheck,
  stateRegistryValidationCheck
} from "./selfcheck/registry.mjs";
import { reportCompareExitStatusCheck, reportRunIdReferenceCheck } from "./selfcheck/report-commands.mjs";
import {
  fixtureAccountingRenderCheck,
  markdownFailureCardsCheck,
  markdownRuntimeFieldSafetyCheck,
  renderedCommandGuidanceCheck,
  reportAggregationIntegrityCheck,
  reportRecommendedNextScenarioCheck,
  reportStatusPrecedenceCheck,
  resourcePeakProvenanceCheck,
  statusFoundationCheck
} from "./selfcheck/reporting.mjs";
import {
  defaultGatewayResourceRoleCheck,
  gatewayProcessResourceRoleCheck,
  processSnapshotCheck,
  resourceConfiguredRoleMissingCheck,
  resourceGatewayPidLookupCheck,
  resourceRoleAttributionCheck,
  resourceRolePollutionCheck,
  resourceRootCommandRoleBoundaryCheck,
  resourceSamplerFailureCheck,
  targetRuntimeEvidenceCheck
} from "./selfcheck/resources.mjs";
import { safetyGuardCheck } from "./selfcheck/safety.mjs";
import {
  setupDirectoryWriteProbeCheck,
  setupNumericFlagsRejectedCheck,
  setupTtySecretInputCheck
} from "./selfcheck/setup.mjs";
import { soakTrendEvaluationCheck } from "./selfcheck/soak.mjs";
import { releaseRuntimeStartupEvidenceInvariantCheck } from "./selfcheck/startup-evidence.mjs";
import {
  stateLifecycleCommandIndexesCheck,
  stateLifecycleFailureShortCircuitCheck
} from "./selfcheck/state-lifecycle.mjs";
import {
  doctorUpgradeSnapshotEvidenceCheck,
  openClawStateSnapshotCheck,
  openClawStateSymlinkContainmentCheck,
  upgradeLogDerivedInvariantsCheck,
  upgradeStateSnapshotInvariantsCheck
} from "./selfcheck/state-snapshots.mjs";
import {
  agentCliLocalTurnSurfaceContractCheck,
  agentGatewayRpcTurnSurfaceContractCheck,
  bundledPluginStartupSurfaceContractCheck,
  currentProfileDiagnosticsContractCheck,
  gatewaySessionSurfaceContractCheck,
  legacyRuntimeDepsIsolationCheck,
  officialPluginInstallSurfaceContractCheck,
  releaseResourceCalibrationCheck,
  releaseRuntimeStartupSurfaceContractCheck,
  startupSurfaceDiagnosticsContractCheck
} from "./selfcheck/surface-contracts.mjs";
import { checkTargetIdentityBinding, checkTargetIdentityOutputs } from "./selfcheck/target-identity.mjs";
import {
  localBuildParallelSingleFlightCheck,
  localBuildProfileEnvCheck,
  localBuildRuntimeAlreadyAbsentCleanupCheck,
  localBuildRuntimeCleanupCheck,
  localBuildRuntimeExceptionCleanupCheck
} from "./selfcheck/target-lifecycle.mjs";
import {
  evaluationViolationHelpersCheck,
  instrumentedPerformanceThresholdPolicyCheck,
  localBuildTargetSetupResourceExclusionCheck,
  roleThresholdEvaluationCheck,
  thresholdPolicyCalibrationCheck
} from "./selfcheck/thresholds.mjs";
import {
  diagnosticsOpenSpanCheck,
  diagnosticsTimelineCheck,
  diagnosticsTimelineEvaluationCheck,
  malformedTimelineCheck
} from "./selfcheck/timeline.mjs";
import { mcpBridgeEvidenceEvaluationCheck, toolRuntimeEvidenceEvaluationCheck } from "./selfcheck/tool-runtime.mjs";
import { rollingUpgradeResolverCheck } from "./selfcheck/upgrade-resolver.mjs";
import { webPayloadContractCheck } from "./selfcheck/web-payload.mjs";
import {
  badge,
  card,
  detectCapabilities,
  formatDuration,
  makeUi,
  renderKovaHeader,
  renderTable,
  resolveWidth,
  scenarioRule,
  summarizeSamples,
  truncate as truncateText,
  visualWidth,
  withMargin,
  wrap
} from "./ui/index.mjs";
import { projectInternalReport } from "./web-publish/from-internal-report.mjs";
import { augmentWithDeltas, findImmediatePrior } from "./web-publish/projector.mjs";

export async function runSelfCheck(flags = {}) {
  return runInSelfCheckScope(
    ({ scope, workspace }) => runScopedSelfCheck(flags, scope, workspace)
  );
}

async function runScopedSelfCheck(flags, scope, workspace) {
  const progress = createSelfCheckProgress({ flags });
  const checks = new Proxy([], {
    set(target, prop, value) {
      target[prop] = value;
      if (prop !== "length" && value && typeof value === "object" && typeof value.status === "string") {
        try { progress.checkDone(value); } catch {}
      }
      return true;
    },
  });
  progress.runStart();
  const tmp = workspace.root;

  checks.push(await syntaxCheck());
  checks.push(await webPayloadContractCheck(tmp));
  checks.push(commandResultContractCheck());
  checks.push(await inlineCheck("target-identity-binding", checkTargetIdentityBinding));
  checks.push(await inlineCheck("target-identity-outputs", () => checkTargetIdentityOutputs(tmp)));
    checks.push(await jsonCommandCheck("version-json", "node bin/kova.mjs version --json", (data) => {
      assertEqual(data.schemaVersion, "kova.version.v1", "version schema");
      assertString(data.version, "version");
    }));
    checks.push(await jsonCommandCheck("setup-json", "node bin/kova.mjs setup --ci --json", (data) => {
      assertEqual(data.schemaVersion, "kova.setup.v1", "setup schema");
      assertEqual(data.ok, true, "setup ok");
      assertEqual(data.auth?.method, "mock", "setup auth default");
      assertArrayNotEmpty(data.checks, "setup checks");
    }));
    checks.push(await inlineCheck("run-id-collision-resistance", () => {
      const ids = Array.from({ length: 8 }, () => createRunId());
      assertEqual(new Set(ids).size, ids.length, "same-process run ids are unique");
      assertEqual(ids.every((id) => /^kova-\d{6}-\d{6}-[0-9a-f]{6}$/.test(id)), true, "run id format includes unique suffix");
    }));
    checks.push(await inlineCheck("web-publish-prior-version-order", () => {
      const release = (ver, releaseDate = "2026-05-26") => ({
        id: ver,
        data: { ver, releaseDate },
      });
      const prior = findImmediatePrior([
        release("2026.5.9"),
        release("2026.5.10"),
        release("2026.5.12"),
        release("2026.5.99", "2026-05-25"),
      ], "2026.5.11", "2026-05-26");
      assertEqual(prior?.data?.ver, "2026.5.10", "same-day prior uses numeric version ordering");
    }));
    checks.push(await inlineCheck("web-publish-delta-identity", () => {
      const augmented = augmentWithDeltas({
        ver: "2026.5.27",
        headline: [{
          label: "agent turn",
          value: 2,
          unit: "s",
          scenarioId: "gateway-session-send-turn",
          metric: "agent.turn.s",
        }],
        scenarios: [{
          id: "gateway-session-send-turn",
          metric: "Session Send",
          value: 2000,
          unit: "ms",
          worstMetric: { name: "pre-provider share", value: 90, unit: "%" },
        }],
      }, {
        id: "2026.5.26",
        data: {
          ver: "2026.5.26",
          headline: [
            {
              label: "pre-provider",
              value: 99,
              unit: "s",
              scenarioId: "gateway-session-send-turn",
              metric: "agent.pre_provider.s",
            },
            {
              label: "agent turn",
              value: 1.6,
              unit: "s",
              scenarioId: "gateway-session-send-turn",
              metric: "agent.turn.s",
            },
          ],
          scenarios: [{
            id: "gateway-session-send-turn",
            metric: "Session Send",
            value: 1600,
            unit: "ms",
          }],
        },
      });
      assertEqual(augmented.headline?.[0]?.deltaPct, 25, "headline delta uses matching headline identity");
      assertEqual(augmented.comparison?.rows?.[0]?.metric, "Session Send", "comparison uses scenario metric");
    }));
    checks.push(await inlineCheck("web-publish-turn-median", () => {
      const turnRecord = (repeat, agentTurnMs, sendDurationMs) => ({
        scenario: "gateway-session-send-turn",
        surface: "gateway-session-send-turn",
        title: "Gateway Session Turns",
        status: "PASS",
        repeat: { index: repeat, total: 2 },
        measurements: {
          agentTurnMs,
          coldAgentTurnMs: agentTurnMs,
          agentTurns: [{
            label: "cold",
            gatewaySession: {
              sendDurationMs,
              timeToMatchedAssistantMs: sendDurationMs * 2,
            },
          }],
        },
        thresholds: {
          agentTurnMs: 1000,
          coldAgentTurnMs: 1000,
        },
      });
      const projected = projectInternalReport({
        schemaVersion: "kova.report.v1",
        generatedAt: "2026-05-27T00:00:00.000Z",
        runId: "web-publish-turn-median",
        mode: "execution",
        target: "npm:2026.5.27",
        summary: { total: 2, statuses: { PASS: 2 } },
        records: [
          turnRecord(1, 100, 10),
          turnRecord(2, 300, 30),
        ],
      });
      const metrics = projected.runs?.[0]?.scenarios?.[0]?.metrics ?? [];
      assertEqual(metrics.find((row) => row.name === "full turn")?.value, 200, "primary turn row median");
      assertEqual(metrics.find((row) => row.name === "↳ cold send rpc")?.value, 20, "child turn row median");
      assertEqual(metrics.find((row) => row.name === "↳ cold matched assistant")?.value, 40, "child assistant row median");
    }));
    checks.push(await inlineCheck("cli-flag-contract", () => {
      assertEqual(parseFlags(["--execute"]).execute, true, "bare boolean flag");
      assertEqual(parseFlags(["--execute=true"]).execute, true, "inline true boolean flag");
      assertEqual(parseFlags(["--execute=false"]).execute, false, "inline false boolean flag");
      assertEqual(parseFlags(["--no-progress"]).no_progress, true, "no-progress boolean flag");
      assertEqual(parseFlags(["--", "--execute"])._.join(","), "--execute", "end-of-options delimiter");
      assertEqual(collectErrorFlags(["bad", "--json"]).json, true, "JSON error flag");
      assertEqual(collectErrorFlags(["bad", "--", "--json"]).json, undefined, "error flags stop at delimiter");
      let rejected = false;
      try {
        parseFlags(["--execute=maybe"]);
      } catch (error) {
        rejected = /must be true or false/.test(error.message);
      }
      assertEqual(rejected, true, "invalid boolean value rejected");
    }));
    checks.push(await inlineCheck("terminal-ui-contracts", () => {
      const samples = summarizeSamples([null, "", false, 0, 2, Number.NaN]);
      assertEqual(samples.n, 2, "sample summary accepts finite numbers only");
      assertEqual(samples.mean, 1, "sample summary preserves numeric zero");

      assertEqual(visualWidth("e\u0301"), 1, "combining grapheme width");
      assertEqual(visualWidth("界"), 2, "fullwidth cell width");
      assertEqual(visualWidth("👨‍👩‍👧‍👦"), 2, "emoji grapheme width");
      assertEqual(truncateText("👨‍👩‍👧‍👦 family", 3), "👨‍👩‍👧‍👦…", "truncate preserves grapheme");
      assertEqual(wrap("界界界", 4).every((line) => visualWidth(line) <= 4), true, "wrap respects cell width");
      const narrowWideGrapheme = wrap("界", 1);
      assertEqual(narrowWideGrapheme.length, 1, "wide grapheme wrap line count");
      assertEqual(narrowWideGrapheme[0], "…", "wrap replaces graphemes wider than the line");

      assertEqual(formatDuration(59_950), "1m", "duration carries seconds into minutes");
      assertEqual(formatDuration(3_599_600), "1h 00m", "duration carries minutes into hours");
      assertEqual(resolveWidth(24).width, 24, "resolved width never exceeds narrow terminal");
      assertEqual(resolveWidth(24, { width: 80 }).width, 24, "explicit width cannot exceed terminal");

      assertEqual(detectCapabilities({ NO_COLOR: "" }, {}).noColor, false, "empty NO_COLOR is disabled");
      assertEqual(detectCapabilities({ NO_COLOR: "0" }, {}).noColor, true, "non-empty NO_COLOR is enabled");

      const ui = makeUi(
        { color: "never" },
        { LANG: "en_US.UTF-8" },
        { isTTY: false, columns: 24 },
      );
      const header = renderKovaHeader({
        surface: "report",
        verdict: "OK",
        headline: "a deliberately long headline with fullwidth 界 text",
        meta: "target runtime:stable",
        ui,
      });
      assertEqual(
        header.split("\n").every((line) => visualWidth(line) <= ui.width),
        true,
        "header wraps within terminal width",
      );
      const command = withMargin(
        "  → node bin/kova.mjs run --profile-on-failure --json",
        0,
        39,
      );
      assertEqual(
        command.split("\n").every((line) => visualWidth(line) <= 39),
        true,
        "command continuations stay within terminal width",
      );
      assertEqual(command.includes("\\\n"), true, "wrapped commands use shell continuations");
      assertEqual(
        Array.from({ length: 11 }, (_, index) => index + 1).every((width) => (
          withMargin("  → node bin/kova.mjs run --json", 0, width)
            .split("\n")
            .every((line) => visualWidth(line) <= width)
        )),
        true,
        "sub-structural command hints never exceed terminal width",
      );
      assertEqual(
        [12, 13, 14, 15].every((width) => (
          withMargin("  → printf '%s' 'quoted value'", 0, width)
            .split("\n")
            .every((line) => visualWidth(line) <= width)
        )),
        true,
        "quoted commands never bypass narrow width constraints",
      );
      const colorUi = makeUi(
        { color: "always" },
        { LANG: "en_US.UTF-8" },
        { isTTY: true, columns: 39 },
      );
      const coloredCommand = withMargin(
        `  ${colorUi.c.dim(colorUi.g.arrow)} node bin/kova.mjs run --profile-on-failure --json`,
        0,
        39,
      );
      assertEqual(coloredCommand.includes("\\\n"), true, "colorized command arrows preserve shell wrapping");
      assertEqual(
        withMargin("  → printf '%s' 'quoted value'", 0, 24).includes("eval "),
        true,
        "quoted commands use an exact shell expression",
      );
      const centeredExpression = withMargin("  → printf '%s' 'quoted value'", 4, 24);
      assertEqual(
        centeredExpression.includes("\\\n'"),
        true,
        "centered shell chunks stay adjacent across continuations",
      );
      assertEqual(
        centeredExpression.split("\n").every((line) => visualWidth(line) <= 28),
        true,
        "centered commands include margin within terminal width",
      );
      const compactTable = renderTable({
        columns: [
          { key: "status", header: "status", align: "left", minWidth: 8 },
          { key: "name", header: "artifact dir", align: "left", minWidth: 24 },
          { key: "note", header: "detail", align: "left", minWidth: 10 },
        ],
        rows: [{ status: "REMOVED", name: "long-artifact-name", note: "done" }],
        gap: 2,
        maxWidth: 40,
      });
      assertEqual(
        compactTable.split("\n").every((line) => visualWidth(line) <= 40),
        true,
        "tables compact when structural columns do not fit",
      );
      assertEqual(
        scenarioRule({
          id: "a-very-long-scenario-identifier-that-cannot-fit-inline",
          verdict: "PASS",
          samples: 12,
          ui: colorUi,
        }).split("\n").every((line) => visualWidth(line) <= 39),
        true,
        "scenario rules stack metadata before overflow",
      );
      const longArtifactReceipt = renderRunReceipt({
        report: {
          mode: "dry-run",
          runId: "kova-terminal-width-check",
          summary: { total: 0, statuses: {} },
          records: [],
        },
        reportPath: `/outside/${"deep/".repeat(20)}report.md`,
      }, { color: "never" }, process.env, { isTTY: false, columns: 80 });
      const artifactLines = longArtifactReceipt.split("\n");
      const artifactLabelIndex = artifactLines.findIndex((line) => line.includes("◆ markdown"));
      assertEqual(artifactLabelIndex >= 0, true, "artifact receipt includes markdown label");
      assertEqual(
        artifactLines[artifactLabelIndex].includes("/outside/"),
        true,
        "artifact path begins beside its label",
      );
      assertEqual(
        artifactLines[artifactLabelIndex + 1].startsWith(" ".repeat(16)),
        true,
        "artifact path continuations use a hanging indent",
      );
      assertEqual(
        artifactLines.every((line) => visualWidth(line) <= 80),
        true,
        "artifact receipt stays within terminal width",
      );
      assertEqual(
        card({
          title: "a card title much wider than its frame",
          lines: ["body"],
          width: 24,
          ui: colorUi,
        }).split("\n").every((line) => visualWidth(line) <= 24),
        true,
        "card titles stay within their frame",
      );
      assertEqual(badge("OK", "OK", { color: true }).includes("\u001b[42;30m"), true, "OK badge uses success tone");
    }));
    checks.push(await inlineCheck("external-plugin-fixture-manifests", async () => {
      for (const [dir, expectedId] of [
        ["support/plugins/kova-basic", "kova-basic"],
        ["support/plugins/kova-missing-runtime-dep", "kova-missing-runtime-dep"]
      ]) {
        const manifest = await readSelfCheckJson(dir, "openclaw.plugin.json");
        assertEqual(manifest.id, expectedId, `${expectedId} manifest id`);
        assertEqual(manifest.configSchema?.type, "object", `${expectedId} config schema`);
      }
    }));
    checks.push(await failingCommandCheck(
      "setup-non-tty-requires-mode",
      "node bin/kova.mjs setup --json",
      "kova setup requires --non-interactive or --ci when stdin is not a TTY"
    ));
    checks.push(await jsonFailureCommandCheck(
      "unknown-command-json-error",
      "node bin/kova.mjs not-a-command --json",
      "unknown command: not-a-command"
    ));
    checks.push(await credentialStoreSelfCheck(tmp));
    checks.push(await credentialStoreLegacyFallbackMigrationCheck(tmp));
    checks.push(await credentialStoreConcurrentWritersCheck(tmp));
    checks.push(await credentialStoreInterruptedTransactionCheck(tmp));
    checks.push(await setupDirectoryWriteProbeCheck(tmp));
    checks.push(await setupTtySecretInputCheck(tmp));
    checks.push(await failingCommandCheck(
      "live-auth-requires-credentials",
      `KOVA_HOME=${quoteShell(join(tmp, "empty-auth-home"))} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json`,
      "--auth live requires configured live credentials"
    ));
    checks.push(await failingCommandCheck(
      "model-requires-live-auth",
      `KOVA_HOME=${quoteShell(join(tmp, "model-with-mock-auth-home"))} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --model gpt-5.6 --json`,
      "--model requires --auth live"
    ));
    checks.push(await setupNumericFlagsRejectedCheck(tmp));
    checks.push(await externalCliSetupCheck(tmp));
    checks.push(await directCredentialProviderPairingCheck(tmp));
    checks.push(await externalCliProviderPairingCheck(tmp));
    checks.push(await claudeCliLoggedOutCheck(tmp));
    checks.push(await externalCliOpenClawConfigCheck(tmp));
    checks.push(await anthropicApiKeyOpenClawConfigCheck(tmp));
    checks.push(await mockAuthOpenClawConfigCheck(tmp));
    checks.push(await claudeCliOpenClawConfigCheck(tmp));
    checks.push(await liveApiKeyExecutionCheck(tmp));
    checks.push(await liveExternalCliDryRunCheck(tmp));
    checks.push(await liveAnthropicExternalCliDryRunCheck(tmp));
    checks.push(await failingCommandCheck(
      "setup-custom-provider-rejects-external-cli",
      `KOVA_HOME=${quoteShell(join(tmp, "custom-external-cli-home"))} node bin/kova.mjs setup --non-interactive --provider custom-openai --auth external-cli --json`,
      "external-cli auth is only supported for provider openai or anthropic"
    ));
    checks.push(await externalCliSetupRejectsUnauthenticatedCheck(tmp));
    checks.push(await externalCliRunAuthVerificationCheck(tmp));
    checks.push(await commandTimeoutContractCheck(tmp));
    checks.push(await commandOutputBudgetCheck());
    checks.push(logSnippetBudgetCheck());
    checks.push(await logArtifactRedactionCheck(tmp));
    checks.push(expectedMockProviderFailureTimeoutLogCheck());
    checks.push(optionalNoLogsCommandCheck());
    checks.push(commandResultInterpretationCheck());
    checks.push(missingCollectorProofCheck());
    checks.push(ocmCommandBuildersCheck());
    checks.push(localBuildRuntimeNameCheck());
    checks.push(ocmMissingResourceCheck());
    checks.push(await guardedTeardownStagesCheck());
    checks.push(measurementPhaseOwnershipCheck());
    checks.push(diagnosticProfilerMeasurementScopeCheck(tmp));
    checks.push(envNameLengthCheck());
    checks.push(evaluationViolationHelpersCheck());
    checks.push(statusFoundationCheck());
    checks.push(reportStatusPrecedenceCheck());
    checks.push(reportAggregationIntegrityCheck());
    checks.push(renderedCommandGuidanceCheck());
    checks.push(evidenceLedgerGatingCheck());
    checks.push(channelCapabilityReportSummaryCheck());
    checks.push(channelCapabilityResultIngestionCheck());
    checks.push(channelDeclaredCapabilityProofRowsCheck());
    checks.push(await channelGeneratedMediaProviderScriptCheck());
    checks.push(await channelWorkflowResourceAttributionCheck(tmp));
    checks.push(channelModelTurnMultiInvariantEvaluationCheck());
    checks.push(optionalDiagnosticGapCheck());
    checks.push(provisioningBlockedStatusCheck());
    checks.push(cleanupProofRequiredCheck());
    checks.push(await openClawStateSnapshotCheck(tmp));
    checks.push(await openClawStateSymlinkContainmentCheck(tmp));
    checks.push(await doctorUpgradeSnapshotEvidenceCheck(tmp));
    checks.push(upgradeStateSnapshotInvariantsCheck());
    checks.push(upgradeLogDerivedInvariantsCheck());
    checks.push(localBuildTargetSetupResourceExclusionCheck());
    checks.push(instrumentedPerformanceThresholdPolicyCheck());
    checks.push(await jsonCommandCheck("plan-json", "node bin/kova.mjs plan --json", (data) => {
      assertEqual(data.schemaVersion, "kova.plan.v1", "plan schema");
      assertArrayNotEmpty(data.surfaces, "plan surfaces");
      assertArrayNotEmpty(data.processRoles, "plan process roles");
      assertArrayNotEmpty(data.metrics, "plan metrics");
      assertArrayNotEmpty(data.channelCapabilityCatalog, "plan channel capability catalog");
      assertArrayNotEmpty(data.channelWorkflowInventory, "plan channel workflow inventory");
      assertArrayNotEmpty(data.channelWorkflowCaseCatalog, "plan channel workflow case catalog");
      assertArrayNotEmpty(data.channelCapabilities, "plan channel capabilities");
      const openClawCatalog = data.channelCapabilityCatalog.find((catalog) => catalog.id === "openclaw-message");
      assertEqual(Boolean(openClawCatalog), true, "OpenClaw message capability catalog present");
      assertEqual(openClawCatalog?.capabilities?.some((capability) => capability.group === "durable-final" && capability.id === "native-quote"), true, "OpenClaw native quote catalog capability present");
      const workflowInventory = data.channelWorkflowInventory.find((inventory) => inventory.id === "openclaw-channel-workflow-inventory");
      assertEqual(Boolean(workflowInventory), true, "OpenClaw channel workflow inventory present");
      assertEqual(workflowInventory?.workflows?.some((workflow) => workflow.id === "completion-handoff"), true, "completion handoff workflow inventory present");
      const workflowCatalog = data.channelWorkflowCaseCatalog.find((catalog) => catalog.id === "openclaw-channel-workflow-cases");
      assertEqual(Boolean(workflowCatalog), true, "OpenClaw channel workflow case catalog present");
      assertEqual(workflowCatalog?.cases?.some((testCase) => testCase.id === "source-visible-delivery.media.message-tool-only"), true, "source visible media workflow case present");
      const telegramChannel = data.channelCapabilities.find((channel) => channel.id === "telegram");
      assertEqual(Boolean(telegramChannel), true, "telegram channel capability registry present");
      assertEqual(telegramChannel?.capabilities?.some((capability) => capability.group === "durable-final" && capability.id === "media"), true, "telegram media durable-final capability present");
      assertArrayNotEmpty(data.scenarios, "plan scenarios");
      assertArrayNotEmpty(data.states, "plan states");
      assertArrayNotEmpty(data.profiles, "profiles");
      assertEqual(data.coverage?.schemaVersion, "kova.coverage.v1", "coverage schema");
      assertArrayNotEmpty(data.coverage?.scenarioSurfaceMap, "scenario surface map");
      const releaseCoverage = data.coverage?.profiles?.find((profile) => profile.id === "release");
      const releaseProfile = data.profiles?.find((profile) => profile.id === "release");
      assertArrayNotEmpty(releaseCoverage?.required?.platforms, "release required platform coverage");
      assertArrayNotEmpty(releaseCoverage?.required?.requirements, "release required requirement coverage");
      assertArrayNotEmpty(releaseCoverage?.currentPlatformKeys, "current platform coverage keys");
      assertEqual(releaseProfile?.purpose, "release", "release profile purpose");
      assertEqual((releaseProfile?.calibration?.surfaceCount ?? 0) > 0, true, "release profile calibrated surfaces");
      assertEqual((releaseProfile?.calibration?.roleCount ?? 0) > 0, true, "release profile calibrated roles");
      const freshSurface = data.surfaces.find((surface) => surface.id === "fresh-install");
      assertEqual(freshSurface?.roleThresholds?.gateway?.maxCpuPercent, 250, "fresh install retains the default gateway CPU cap");
      const officialSurface = data.surfaces.find((surface) => surface.id === "official-plugin-install");
      assertEqual(Boolean(officialSurface), true, "official plugin surface present");
      assertArrayNotEmpty(officialSurface?.purposes, "official plugin surface purposes");
      assertArrayNotEmpty(officialSurface?.requirements, "official plugin surface requirements");
      assertEqual(data.states.some((state) => state.id === "official-plugins"), true, "official plugins state present");
      assertEqual(data.scenarios.some((scenario) => scenario.id === "official-plugin-install" && scenario.surface === "official-plugin-install"), true, "official plugin scenario present");
      assertEqual(data.surfaces.some((surface) => surface.id === "adversarial-input"), true, "adversarial input surface present");
      assertEqual(data.scenarios.some((scenario) => scenario.id === "adversarial-input-openai-compatible" && scenario.surface === "adversarial-input"), true, "adversarial input scenario present");
      assertEqual(data.scenarios.some((scenario) => scenario.id === "agent-provider-random-disconnect" && scenario.mockProvider?.mode === "disconnect-then-recover"), true, "provider disconnect recovery scenario present");
      assertEqual(data.scenarios.some((scenario) => scenario.id === "agent-provider-protocol-failure" && scenario.mockProvider?.mode === "protocol-failure"), true, "provider protocol failure scenario present");
      assertEqual(data.profiles.some((profile) => profile.id === "adversarial"), true, "adversarial profile present");
      if (data.scenarios.some((scenario) => typeof scenario.surface !== "string" || scenario.surface.length === 0)) {
        throw new Error("every scenario must expose a surface");
      }
      if (data.scenarios.some((scenario) => !Array.isArray(scenario.proves) || scenario.proves.length === 0)) {
        throw new Error("every scenario must declare the surface requirement ids it proves");
      }
      const expectedScopes = {
        "doctor-repair-upgrade": { clone: "harness", upgrade: "product", "doctor-repair": "product", "post-repair-health": "product" },
        "gateway-session-send-turn-existing-user": { clone: "harness", upgrade: "product", "gateway-start": "product", "gateway-session-turn": "product", "post-gateway-session-health": "product" },
        "upgrade-durable-clone-to-local-build": { clone: "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-existing-user": { clone: "harness", "source-runtime": "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-from-2026-4-20": { clone: "harness", "source-runtime": "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-from-2026-4-24": { clone: "harness", "source-runtime": "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-from-day-ago": { clone: "harness", "source-runtime": "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-from-week-ago": { clone: "harness", "source-runtime": "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-from-month-ago": { clone: "harness", "source-runtime": "harness", upgrade: "product", "post-upgrade": "product" },
        "release-update-recovery": { source: "harness", upgrade: "product", "plugin-health": "product", "doctor-repair": "product", "update-retry": "product", rollback: "product" },
        "upgrade-stable-release-to-beta": { start: "harness", upgrade: "product", "post-upgrade": "product" },
        "upgrade-stable-release-to-local-build": { start: "harness", upgrade: "product", "post-upgrade": "product" }
      };
      for (const [scenarioId, phaseScopes] of Object.entries(expectedScopes)) {
        const scenario = data.scenarios.find((candidate) => candidate.id === scenarioId);
        for (const [phaseId, scope] of Object.entries(phaseScopes)) {
          assertEqual(
            scenario?.phases?.find((phase) => phase.id === phaseId)?.measurementScope,
            scope,
            `${scenarioId}/${phaseId} measurement scope`
          );
        }
      }
    }));
    checks.push(await channelCapabilityRegistryCheck());
    checks.push(inventoryManifestContractsCheck());
    checks.push(await inventoryPlanCheck(tmp));
    checks.push(await repeatedWorkAuditCheck());
    checks.push(await collectionPolicyResolverCheck(tmp, scope));
    checks.push(await jsonCommandCheck("matrix-plan-json", "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --include scenario:fresh-install --parallel 2 --json", (data) => {
      assertEqual(data.schemaVersion, "kova.matrix.plan.v1", "matrix plan schema");
      assertEqual(data.profile?.id, "smoke", "matrix profile id");
      assertArrayNotEmpty(data.entries, "matrix entries");
      assertEqual(data.resolvedCoverage?.schemaVersion, "kova.resolvedCoverage.v1", "resolved coverage schema");
      assertEqual(data.resolvedCoverage?.statuses?.planned, 1, "resolved planned obligation count");
      assertEqual(data.resolvedCoverage?.warnings?.length, 0, "resolved coverage migration warnings");
      assertEqual(data.resolvedCoverage?.obligations?.[0]?.surface, "fresh-install", "resolved obligation surface");
      assertEqual(data.resolvedCoverage?.obligations?.[0]?.requirement, "baseline", "resolved obligation requirement");
      assertEqual(data.entries.length, 1, "matrix include filter count");
      assertEqual(data.controls?.requestedParallel, 2, "matrix requested parallel");
    }));
    checks.push(await jsonCommandCheck("matrix-plan-repeat-json", "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --include scenario:fresh-install --repeat 3 --json", (data) => {
      assertEqual(data.controls?.repeat, 3, "matrix repeat control");
    }));
    checks.push(await jsonCommandCheck("release-upgrade-plan-json", "node bin/kova.mjs matrix plan --profile release-upgrade --target release:beta --json", (data) => {
      assertEqual(data.profile?.id, "release-upgrade", "release upgrade profile id");
      assertEqual(data.target, "release:beta", "release upgrade target");
      assertEqual(data.entries?.[0]?.scenario?.id, "upgrade-stable-release-to-beta", "release upgrade scenario");
    }));
    checks.push(await failingCommandCheck(
      "channel-target-selector-is-unsupported",
      "node bin/kova.mjs matrix plan --profile release-upgrade --target channel:beta --json",
      "unsupported target selector kind: channel"
    ));
    checks.push(await failingCommandCheck(
      "channel-upgrade-profile-is-unsupported",
      "node bin/kova.mjs matrix plan --profile channel-upgrade --target release:beta --json",
      "no profile found for channel-upgrade"
    ));
    checks.push(await failingCommandCheck(
      "release-upgrade-rejects-wrong-target-value",
      "node bin/kova.mjs matrix plan --profile release-upgrade --target release:stable --json",
      "upgrade-stable-release-to-beta supports target value beta, got stable"
    ));
    checks.push(await jsonCommandCheck("local-build-upgrade-plan-json", "node bin/kova.mjs matrix plan --profile local-build-upgrade --target local-build:/tmp/openclaw --include scenario:upgrade-stable-release-to-local-build --json", (data) => {
      assertEqual(data.profile?.id, "local-build-upgrade", "local-build upgrade profile id");
      assertEqual(data.entries?.[0]?.scenario?.id, "upgrade-stable-release-to-local-build", "local-build stable upgrade scenario");
    }));
    checks.push(await rollingUpgradeResolverCheck(tmp, scope));
    checks.push(await jsonCommandCheck("rolling-upgrade-plan-json", "node bin/kova.mjs matrix plan --profile rolling-upgrade --target runtime:stable --json", (data) => {
      assertEqual(data.profile?.id, "rolling-upgrade", "rolling upgrade profile id");
      assertEqual(data.entries?.length, 3, "rolling upgrade entry count");
      assertEqual(data.entries?.some((entry) => entry.scenario?.id === "upgrade-from-day-ago"), true, "day-ago upgrade scenario present");
      assertEqual(data.entries?.some((entry) => entry.scenario?.id === "upgrade-from-week-ago"), true, "week-ago upgrade scenario present");
      assertEqual(data.entries?.some((entry) => entry.scenario?.id === "upgrade-from-month-ago"), true, "month-ago upgrade scenario present");
      assertEqual(data.entries?.every((entry) => entry.state?.id === "rolling-old-release-user"), true, "rolling upgrade uses rolling-specific old-release state");
    }));
    checks.push(await jsonCommandCheck("rolling-upgrade-dry-run-json", `node bin/kova.mjs matrix run --profile rolling-upgrade --target runtime:stable --source-env ${quoteShell("Team Env")} --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      assertEqual(data.profile?.id, "rolling-upgrade", "rolling upgrade run profile id");
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const rollingRecords = (report.records ?? []).filter((record) => String(record.scenario ?? "").startsWith("upgrade-from-"));
      assertEqual(rollingRecords.length, 3, "rolling upgrade dry-run records");
      assertEqual(rollingRecords.every((record) => record.state?.id === "rolling-old-release-user"), true, "rolling dry-run records use rolling state");
      assertEqual(
        rollingRecords.every((record) => !(record.phases ?? []).some((phase) => phase.id === "state-source-runtime")),
        true,
        "rolling source runtime is not overwritten by static old-release state"
      );
      assertEqual(
        rollingRecords.every((record) => (record.phases ?? []).some((phase) => phase.id === "evidence-source-runtime-snapshots")),
        true,
        "rolling pre-upgrade snapshots remain after source runtime"
      );
    }));
    checks.push(await jsonCommandCheck("doctor-upgrade-plan-json", "node bin/kova.mjs matrix plan --profile doctor-upgrade --target local-build:/tmp/openclaw --json", (data) => {
      assertEqual(data.profile?.id, "doctor-upgrade", "doctor upgrade profile id");
      assertEqual(data.entries?.length, 5, "doctor upgrade state variety");
      assertEqual(data.resolvedCoverage?.statuses?.planned, 5, "doctor upgrade resolved obligations");
      assertEqual(data.resolvedCoverage?.gaps?.length, 0, "doctor upgrade coverage gaps");
      const states = new Set(data.entries?.map((entry) => entry.state?.id));
      for (const state of [
        "legacy-core-config-doctor-2026-4-24",
        "legacy-plugin-config-doctor-2026-5-22",
        "legacy-provider-config-doctor-2026-5-7",
        "legacy-channel-config-doctor-2026-5-7",
        "legacy-runtime-pin-doctor-2026-5-8"
      ]) {
        assertEqual(states.has(state), true, `doctor upgrade includes ${state}`);
      }
    }));
    checks.push(await jsonCommandCheck("release-upgrade-dry-run-json", `node bin/kova.mjs run --target release:beta --scenario upgrade-stable-release-to-beta --state stable-release-user --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      assertEqual(report.target, "release:beta", "release dry-run report target");
      const record = report.records?.[0];
      const commands = (record?.phases ?? []).flatMap((phase) => phase.commands ?? []);
      assertEqual(commands.some((command) => command.includes("ocm start") && command.includes("--channel stable")), true, "stable start command present");
      assertEqual(commands.some((command) => command.includes("ocm upgrade") && /--channel '?beta'?/.test(command)), true, "beta upgrade command present");
      assertEqual(record?.phases?.find((phase) => phase.id === "start")?.measurementScope, "harness", "stable source start scope");
      assertEqual(record?.phases?.find((phase) => phase.id === "upgrade")?.measurementScope, "product", "candidate upgrade scope");
      assertEqual(record?.phases?.find((phase) => phase.id === "post-upgrade")?.measurementScope, "product", "post-upgrade scope");
    }));
    checks.push(await jsonCommandCheck("durable-clone-local-build-dry-run-json", `node bin/kova.mjs run --target local-build:/tmp/openclaw --scenario upgrade-durable-clone-to-local-build --state plugin-index --source-env 'Team Env' --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      const commands = (record?.phases ?? []).flatMap((phase) => phase.commands ?? []);
      assertEqual(commands.some((command) => command.includes("ocm env clone 'Team Env'")), true, "quoted source env clone command present");
      assertEqual(commands.some((command) => command.includes("ocm upgrade") && /--runtime '?kova-local-/.test(command)), true, "local-build runtime upgrade command present");
      assertEqual(record?.phases?.find((phase) => phase.id === "clone")?.measurementScope, "harness", "durable clone scope");
      assertEqual(record?.phases?.find((phase) => phase.id === "upgrade")?.measurementScope, "product", "durable candidate upgrade scope");
    }));
    checks.push(await jsonCommandCheck("run-auth-default-mock-json", `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "mock", "default auth mode");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (!phaseIds.includes("auth-prepare") || !phaseIds.includes("auth-setup") || !phaseIds.includes("auth-cleanup")) {
        throw new Error(`default mock auth phases missing: ${phaseIds.join(", ")}`);
      }
    }));
    checks.push(await jsonCommandCheck("run-auth-no-service-before-gateway-start-json", `node bin/kova.mjs run --target runtime:stable --scenario openai-compatible-turn --state mock-openai-provider --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "mock", "no-service scenario default auth mode");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      const provision = phaseIds.indexOf("provision");
      const authSetup = phaseIds.indexOf("auth-setup");
      const gatewayStart = phaseIds.indexOf("gateway-start");
      assertEqual(provision >= 0, true, "no-service provision planned");
      assertEqual(authSetup > provision, true, "auth setup follows no-service provision");
      assertEqual(gatewayStart > authSetup, true, "gateway start follows auth setup");
    }));
    for (const scenarioId of [
      "bundled-plugin-startup",
      "bundled-runtime-deps",
      "cron-runtime",
      "exec-tool-safety",
      "fresh-install",
      "gateway-performance",
      "mcp-runtime-start-stop",
      "mcp-tool-call",
      "tool-failure-containment"
    ]) {
      checks.push(await jsonCommandCheck(`mock-auth-gateway-start-order-${scenarioId}-json`, `node bin/kova.mjs run --target runtime:stable --scenario ${scenarioId} --report-dir ${quoteShell(tmp)} --json`, async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const record = report.records?.[0];
        assertEqual(record?.auth?.mode, "mock", `${scenarioId} default auth mode`);
        const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
        const envCreate = record?.phases?.findIndex((phase) =>
          (phase.commands ?? []).some((command) =>
            command.includes("ocm start") && command.includes("--no-service")
          ),
        );
        const authSetup = phaseIds.indexOf("auth-setup");
        const gatewayStart = record?.phases?.findIndex((phase) =>
          (phase.commands ?? []).some((command) => command.includes("ocm service start")),
        );
        assertEqual(envCreate >= 0, true, `${scenarioId} no-service env creation planned`);
        assertEqual(authSetup > envCreate, true, `${scenarioId} auth setup follows env creation`);
        assertEqual(gatewayStart > authSetup, true, `${scenarioId} gateway start follows auth setup`);
        const envCreateCommands = record?.phases?.[envCreate]?.commands ?? [];
        const gatewayStartCommands = record?.phases?.[gatewayStart]?.commands ?? [];
        assertEqual(envCreateCommands.some((command) => command.includes("ocm start") && command.includes("--no-service")), true, `${scenarioId} env creation does not start gateway service`);
        assertEqual(gatewayStartCommands.some((command) => command.includes("ocm service install")), true, `${scenarioId} gateway service install planned after auth`);
        assertEqual(gatewayStartCommands.some((command) => command.includes("ocm service start")), true, `${scenarioId} gateway service start planned after auth`);
      }));
    }
    for (const [scenarioId, stateId, statePhaseId] of [
      ["bundled-runtime-deps", "missing-plugin-index", "state-cold-start"],
      ["fresh-install", "onboarded-user", "state-provision"],
      ["gateway-performance", "gateway-already-running", "state-cold-start"]
    ]) {
      checks.push(await jsonCommandCheck(`mock-auth-state-order-${scenarioId}-${stateId}-json`, `node bin/kova.mjs run --target runtime:stable --scenario ${scenarioId} --state ${stateId} --report-dir ${quoteShell(tmp)} --json`, async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const phases = report.records?.[0]?.phases ?? [];
        const envCreate = phases.findIndex((phase) =>
          (phase.commands ?? []).some((command) =>
            command.includes("ocm start") && command.includes("--no-service")
          ),
        );
        const gatewayStart = phases.findIndex((phase) =>
          (phase.commands ?? []).some((command) => command.includes("ocm service start")),
        );
        const stateSetup = phases.findIndex((phase) => phase.id === statePhaseId);
        assertEqual(envCreate >= 0, true, `${scenarioId} creates env without service`);
        assertEqual(gatewayStart > envCreate, true, `${scenarioId} starts gateway after env creation`);
        assertEqual(stateSetup > gatewayStart, true, `${scenarioId} applies ${stateId} after gateway start`);
      }));
    }
    checks.push(await jsonCommandCheck("network-frontage-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --network-frontage loopback --worker-id 7 --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(report.networkFrontage?.mode, "loopback-frontage", "report network frontage mode");
      assertEqual(report.networkFrontage?.enabled, true, "report network frontage enabled");
      assertEqual(record?.networkFrontage?.status, "planned", "record network frontage planned");
      assertEqual(record?.networkFrontage?.workerId, 7, "record worker id");
      assertEqual(record?.networkFrontage?.frontageHost, "127.0.1.17", "record frontage host");
      const cleanupPhase = record?.phases?.find((phase) => phase.id === "network-frontage-cleanup");
      assertEqual(Boolean(cleanupPhase), true, "network frontage cleanup planned");
      const summary = JSON.parse(await readFile(data.summaryPath, "utf8"));
      assertEqual(summary.run?.networkFrontage?.mode, "loopback-frontage", "summary network frontage mode");
    }));
    checks.push(await jsonCommandCheck("network-frontage-stale-worker-env-ignored-json", `KOVA_WORKER_ID=abc node bin/kova.mjs run --target runtime:stable --scenario fresh-install --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      assertEqual(report.networkFrontage?.mode, "port", "stale worker env keeps default port mode");
      assertEqual(report.networkFrontage?.enabled, false, "stale worker env does not enable frontage");
    }));
    checks.push(await networkFrontageNoChildTcpCheck());
    checks.push(networkFrontageProductGuardCheck());
    checks.push(networkFrontageRuntimeEnvCheck());
    checks.push(networkFrontageHelperEndpointCheck());
    checks.push(await openAiCompatibleTurnFrontageCheck(tmp, scope));
    checks.push(await networkFrontageProductPreflightBlocksPendingCheck(tmp, scope));
    checks.push(await networkFrontageBootstrapCommandsBypassPreflightCheck(tmp, scope));
    checks.push(await cronGatewayTokenEnvCheck(tmp, scope));
    checks.push(await networkFrontagePartialStartupCleanupInvariantCheck());
    checks.push(await failingCommandCheck(
      "network-frontage-invalid-mode",
      "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --network-frontage bad --json",
      "--network-frontage must be one of port, loopback, loopback-frontage"
    ));
    checks.push(await failingCommandCheck(
      "network-frontage-parallel-matrix-rejected",
      "node bin/kova.mjs matrix run --profile smoke --target runtime:stable --include scenario:fresh-install --network-frontage loopback --worker-id 7 --parallel 2 --json",
      "--network-frontage loopback cannot be combined with matrix --parallel > 1"
    ));
    checks.push(await jsonCommandCheck("run-auth-skip-json", `node bin/kova.mjs run --auth skip --target runtime:stable --scenario fresh-install --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "skip", "run auth skip mode");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (phaseIds.includes("auth-prepare") || phaseIds.includes("auth-setup") || phaseIds.includes("auth-cleanup")) {
        throw new Error(`run --auth skip should not inject auth phases: ${phaseIds.join(", ")}`);
      }
    }));
    checks.push(await jsonCommandCheck("run-auth-missing-override-json", `node bin/kova.mjs run --target runtime:stable --scenario provider-models --state model-auth-missing --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "missing", "missing auth override mode");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (phaseIds.includes("auth-prepare") || phaseIds.includes("auth-setup")) {
        throw new Error(`missing auth override should not inject auth phases: ${phaseIds.join(", ")}`);
      }
    }));
    checks.push(await jsonCommandCheck("run-auth-live-source-env-json", `node bin/kova.mjs run --auth live --target runtime:stable --scenario gateway-session-send-turn-existing-user --source-env 'Team Env' --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "live", "source-env live auth mode");
      assertEqual(record?.auth?.source, "source-env", "source-env live auth source");
      assertEqual(record?.auth?.setup, false, "source-env live auth does not patch config");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (phaseIds.includes("auth-setup") || phaseIds.includes("auth-prepare")) {
        throw new Error(`source-env live auth should not inject auth phases: ${phaseIds.join(", ")}`);
      }
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      assertEqual(commands.some((command) => command.includes("ocm env clone 'Team Env'")), true, "source env clone command present");
      assertEqual(commands.some((command) => command.includes("run-gateway-session-send-turn.mjs")), true, "gateway session helper command present");
    }));
    for (const item of [
      ["agent-gateway-rpc-turn", "agent-gateway-rpc-turn", "ocm @"],
      ["gateway-session-send-turn", "gateway-session-send-turn", "run-gateway-session-send-turn.mjs"],
      ["tui-message-turn", "tui-message-turn", "run-tui-message-turn.mjs"],
      ["openai-compatible-turn", "openai-compatible-turn", "run-openai-compatible-turn.mjs"]
    ]) {
      const [scenarioId, surfaceId, expectedCommand] = item;
      checks.push(await jsonCommandCheck(`message-ingress-${scenarioId}-dry-run-json`, `node bin/kova.mjs run --target runtime:stable --scenario ${scenarioId} --state mock-openai-provider --report-dir ${quoteShell(tmp)} --json`, async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const record = report.records?.[0];
        assertEqual(record?.surface, surfaceId, `${scenarioId} surface`);
        assertEqual(record?.auth?.mode, "mock", `${scenarioId} mock auth mode`);
        const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
        assertEqual(commands.some((command) => command.includes(expectedCommand)), true, `${scenarioId} ingress command`);
        if (scenarioId === "openai-compatible-turn") {
          assertEqual(commands.some((command) => command.includes("--model openclaw")), true, "OpenAI-compatible HTTP endpoint uses gateway agent model name");
        }
      }));
    }
    checks.push(await jsonCommandCheck("adversarial-input-openai-compatible-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario adversarial-input-openai-compatible --state mock-openai-provider --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      assertEqual(commands.some((command) => command.includes("run-adversarial-inputs.mjs") && command.includes("--model openclaw")), true, "adversarial HTTP endpoint uses gateway agent model name");
    }));
    checks.push(await adversarialInputHelperExactFrontageCheck(tmp, scope));
    for (const [scenarioId, mode] of [
      ["agent-provider-random-disconnect", "disconnect-then-recover"],
      ["agent-provider-protocol-failure", "protocol-failure"]
    ]) {
      checks.push(await jsonCommandCheck(`provider-failure-${scenarioId}-dry-run-json`, `node bin/kova.mjs run --target runtime:stable --scenario ${scenarioId} --state mock-openai-provider --report-dir ${quoteShell(tmp)} --json`, async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const record = report.records?.[0];
        assertEqual(record?.surface, "agent-cli-local-turn", `${scenarioId} surface`);
        assertEqual(record?.auth?.mockProvider?.mode, mode, `${scenarioId} mock provider mode`);
        const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
        assertEqual(commands.some((command) => command.includes("ocm @") && command.includes("-- agent --local")), true, `${scenarioId} agent command`);
      }));
    }
    checks.push(await jsonCommandCheck("run-profiling-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --node-profile --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      assertEqual(report.records?.[0]?.profiling?.enabled, true, "profiling marker");
      assertEqual(report.records?.[0]?.profiling?.affectsPerformanceMeasurements, true, "profiling performance marker");
      assertEqual(report.performance?.profiledRunCount, 1, "profiled run count");
    }));
    checks.push(await jsonCommandCheck("run-profile-on-failure-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --profile-on-failure --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const profiling = report.records?.[0]?.profiling;
      assertEqual(profiling?.enabled, true, "profile-on-failure marker");
      assertEqual(profiling?.affectsPerformanceMeasurements, false, "profile-on-failure keeps normal performance measurements");
      assertEqual(profiling?.baselineEligible, false, "profile-on-failure remains baseline ineligible");
    }));
    checks.push(await jsonCommandCheck("workspace-scan-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario workspace-scan-pressure --state large-workspace --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.surface, "workspace-scan", "workspace scan surface");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (!phaseIds.includes("state-start")) {
        throw new Error(`large workspace state setup after start missing: ${phaseIds.join(", ")}`);
      }
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      assertEqual(commands.some((command) => command.includes("kova-large")), true, "large workspace fixture command");
      assertEqual(commands.some((command) => command.includes("ocm service restart")), true, "workspace restart command");
      assertEqual(commands.some((command) => command.includes("run-soak-loop.mjs") && command.includes("--duration-ms 15000")), true, "workspace repeated command loop");
    }));
    checks.push(await jsonCommandCheck("mcp-runtime-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario mcp-runtime-start-stop --state fresh --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.surface, "mcp-runtime", "MCP runtime surface");
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      const bridgeCommand = commands.find((command) => command.includes("mcp-bridge-smoke.mjs")) ?? "";
      assertEqual(bridgeCommand.includes("--artifact-dir '"), true, "MCP bridge helper receives quoted artifact dir");
      assertEqual(commands.some((command) => command.includes("ocm start") && command.includes("--json")), true, "MCP gateway start command");
      assertEqual(record?.thresholds?.mcpProcessLeaks, 0, "MCP process leak threshold");
    }));
    checks.push(await mcpToolCallSmokeRedactsGatewayTokenCheck(tmp, scope));
    checks.push(await commandCheck(
      "mcp-runtime-role-patterns",
      "node -e \"const role=require('./process-roles/mcp-runtime.json'); if (role.commandPatterns.includes('mcp') || role.processPatterns.includes('mcp') || role.processPatterns.some((p)=>p.includes('modelcontextprotocol'))) process.exit(1);\""
    ));
    checks.push(await jsonCommandCheck("browser-automation-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario browser-automation-smoke --state fresh --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.surface, "browser-automation", "browser automation surface");
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      const browserCommand = commands.find((command) => command.includes("browser-automation-smoke.mjs")) ?? "";
      assertEqual(browserCommand.includes("--artifact-dir '"), true, "browser helper receives quoted artifact dir");
      assertEqual(record?.thresholds?.browserProcessLeaks, 0, "browser process leak threshold");
    }));
    checks.push(await jsonCommandCheck("media-understanding-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario media-understanding-timeout --state fresh --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.surface, "media-understanding", "media understanding surface");
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      const mediaCommand = commands.find((command) => command.includes("media-understanding-timeout.mjs")) ?? "";
      assertEqual(mediaCommand.includes("--artifact-dir '"), true, "media helper receives quoted artifact dir");
      assertEqual(mediaCommand.includes("--timeout-ms 1200"), true, "media helper receives provider timeout");
      assertEqual(mediaCommand.includes("--max-command-ms 45000"), true, "media helper allows cold CLI evidence before outer timeout");
      assertEqual(record?.auth?.mockProvider?.mode, "timeout", "media scenario mock timeout mode");
      assertEqual(record?.thresholds?.mediaTimeoutObserved, 1, "media timeout threshold");
      assertEqual(record?.thresholds?.providerRequestCountMin, 1, "media provider request threshold");
    }));
    checks.push(await jsonCommandCheck("network-offline-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario agent-network-offline --state fresh --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.surface, "network-offline", "network offline surface");
      assertEqual(record?.auth?.mode, "none", "network offline opts out of default mock auth");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (phaseIds.includes("auth-prepare") || phaseIds.includes("auth-setup")) {
        throw new Error(`network offline must not start mock auth phases: ${phaseIds.join(", ")}`);
      }
      const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
      const networkCommand = commands.find((command) => command.includes("agent-network-offline.mjs")) ?? "";
      assertEqual(networkCommand.includes("--artifact-dir '"), true, "network helper receives quoted artifact dir");
      assertEqual(networkCommand.includes("--max-command-ms 45000"), true, "network helper allows cold CLI evidence before outer timeout");
      assertEqual(record?.thresholds?.networkFailureObserved, 1, "network failure threshold");
    }));
    checks.push(await jsonCommandCheck("diagnostic-profile-plan-json", "node bin/kova.mjs matrix plan --profile diagnostic --target local-build:/tmp/openclaw --include scenario:release-runtime-startup --json", (data) => {
      assertEqual(data.schemaVersion, "kova.matrix.plan.v1", "diagnostic matrix plan schema");
      assertEqual(data.profile?.id, "diagnostic", "diagnostic profile id");
      assertEqual(data.profile?.localBuildProfile, "sourcePerformance", "diagnostic local build profile");
      assertEqual(data.profile?.diagnostics?.timelineRequired, true, "diagnostic timeline required");
      assertEqual(
        data.profile?.diagnostics?.requiredKeySpans,
        undefined,
        "heterogeneous diagnostic profile leaves span ownership to each surface"
      );
      assertArrayNotEmpty(data.entries, "diagnostic entries");
    }));
    checks.push(await failingCommandCheck(
      "diagnostic-profile-rejects-non-local-build",
      "node bin/kova.mjs matrix plan --profile diagnostic --target runtime:stable --json",
      "profile 'diagnostic' requires target kind local-build"
    ));
    checks.push(await failingCommandCheck(
      "invalid-parallel-rejected",
      "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --parallel nope --json",
      "--parallel must be a positive integer"
    ));
    checks.push(await failingCommandCheck(
      "invalid-timeout-rejected",
      "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --timeout-ms 0 --json",
      "--timeout-ms must be a positive integer"
    ));
    checks.push(await failingCommandCheck(
      "baseline-requires-execute",
      "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --baseline --json",
      "--baseline and --save-baseline require --execute"
    ));
    checks.push(await failingCommandCheck(
      "save-baseline-requires-reviewed-good",
      "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --execute --save-baseline --json",
      "--save-baseline requires --reviewed-good"
    ));
    checks.push(await failingCommandCheck(
      "exhaustive-execute-requires-explicit-flag",
      "node bin/kova.mjs matrix run --profile exhaustive --target runtime:stable --execute --json",
      "executing profile 'exhaustive' requires --allow-exhaustive"
    ));
    checks.push(await jsonCommandCheck("cleanup-json", "node bin/kova.mjs cleanup envs --json", (data) => {
      assertEqual(data.schemaVersion, "kova.cleanup.envs.v1", "cleanup schema");
      assertEqual(data.execute, false, "cleanup execute flag");
      assertArray(data.envs, "cleanup envs");
      assertEqual(data.envs.every((env) => typeof env === "string"), true, "cleanup v1 envs stay names");
      assertArray(data.classifications, "cleanup classifications");
    }));
    checks.push(await cleanupEnvSafetyCheck(tmp));
    checks.push(await cleanupArtifactsCheck(tmp));
    checks.push(await mockProviderProcessSafetyCheck(tmp));
    checks.push(await diagnosticArtifactIdentityCheck(tmp));
    checks.push(await stateFixtureCollectorFailureCheck(tmp));
    checks.push(await diagnosticsTimelineCheck());
    checks.push(await diagnosticsOpenSpanCheck());
    checks.push(await malformedTimelineCheck(tmp));
    checks.push(await collectorArtifactCollisionCheck(tmp));
    checks.push(await diagnosticTriggerValidationCheck(tmp));
    checks.push(diagnosticsTimelineEvaluationCheck());
    checks.push(runtimeDepsLogParserCheck());
    checks.push(embeddedRunLogParserCheck());
    checks.push(runtimeDepsWarmReuseEvaluationCheck());
    checks.push(await performanceBaselineCheck(tmp));
    checks.push(await fileLockRecoveryCheck(tmp));
    checks.push(await reportPublicationCheck(tmp));
    checks.push(cleanupPublicationReceiptCheck());
    checks.push(markdownFailureCardsCheck());
    checks.push(markdownRuntimeFieldSafetyCheck());
    checks.push(resourcePeakProvenanceCheck());
    checks.push(reportRecommendedNextScenarioCheck());
    checks.push(readinessClassificationCheck());
    checks.push(healthReadinessModelCheck());
    checks.push(healthFailureThresholdPolicyCheck());
    checks.push(agentContainmentHealthScopeCheck());
    checks.push(await resourceRoleAttributionCheck(tmp));
    checks.push(resourceConfiguredRoleMissingCheck());
    checks.push(await resourceRootCommandRoleBoundaryCheck());
    checks.push(await resourceRolePollutionCheck());
    checks.push(await resourceGatewayPidLookupCheck(tmp, scope));
    checks.push(await resourceSamplerFailureCheck());
    checks.push(await targetRuntimeEvidenceCheck());
    checks.push(await startupSurfaceDiagnosticsContractCheck());
    checks.push(await gatewaySessionSurfaceContractCheck());
    checks.push(await bundledPluginStartupSurfaceContractCheck());
    checks.push(await legacyRuntimeDepsIsolationCheck());
    checks.push(await currentProfileDiagnosticsContractCheck());
    checks.push(await releaseResourceCalibrationCheck());
    checks.push(await releaseRuntimeStartupSurfaceContractCheck());
    checks.push(await officialPluginInstallSurfaceContractCheck());
    checks.push(await agentCliLocalTurnSurfaceContractCheck());
    checks.push(await agentGatewayRpcTurnSurfaceContractCheck());
    checks.push(releaseRuntimeStartupEvidenceInvariantCheck());
    checks.push(officialPluginInstallEvidenceInvariantCheck());
    checks.push(agentCliLocalTurnEvidenceInvariantCheck());
    checks.push(agentGatewayRpcTurnEvidenceInvariantCheck());
    checks.push(await processSnapshotCheck(tmp, scope));
    checks.push(roleThresholdEvaluationCheck());
    checks.push(thresholdPolicyCalibrationCheck());
    checks.push(await cleanupRetryCheck(tmp));
    checks.push(stateRegistryValidationCheck());
    checks.push(scenarioCloneFirstValidationCheck());
    checks.push(await scenarioCleanupOwnershipCheck());
    checks.push(scenarioHealthScopeValidationCheck());
    checks.push(scenarioStateCompatibilityCheck());
    checks.push(await cpuProfileParserCheck(tmp));
    checks.push(await heapProfileParserCheck(tmp));
    checks.push(await providerEvidenceParserCheck());
    checks.push(agentTurnBreakdownCheck());
    checks.push(gatewaySessionHistoryTextExtractionCheck());
    checks.push(gatewaySessionTurnEvaluationCheck());
    checks.push(gatewaySessionEvidenceInvariantCheck());
    checks.push(gatewaySessionPreProviderAttributionCheck());
    checks.push(agentCliPreProviderAttributionCheck());
    checks.push(await mockProviderBehaviorCheck(tmp));
    checks.push(mockProviderScriptModesCheck());
    checks.push(providerFailureEvaluationCheck());
    checks.push(providerSpecificFailureEvaluationCheck());
    checks.push(adversarialInputEvaluationCheck());
    checks.push(agentColdWarmEvaluationCheck());
    checks.push(sourceReleaseCompareCheck());
    checks.push(await concurrentAgentRunnerCheck(tmp, scope));
    checks.push(providerConcurrentEvaluationCheck());
    checks.push(agentAuthFailureEvaluationCheck());
    checks.push(await soakLoopRunnerCheck(tmp, scope));
    checks.push(soakTrendEvaluationCheck());
    checks.push(mcpBridgeEvidenceEvaluationCheck());
    checks.push(toolRuntimeEvidenceEvaluationCheck());
    checks.push(pluginRecoveryEvidenceEvaluationCheck());
    checks.push(browserAutomationEvidenceEvaluationCheck());
    checks.push(mediaUnderstandingEvidenceEvaluationCheck());
    checks.push(networkOfflineEvidenceEvaluationCheck());
    checks.push(await officialPluginInstallRunnerCheck(tmp, scope));
    checks.push(await jsonCommandCheck(
      "dry-run-state-lifecycle-json",
      `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --state missing-plugin-index --report-dir ${quoteShell(tmp)} --json`,
      async (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "state dry-run receipt schema");
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const commands = report.records?.[0]?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
        if (!commands.some((command) => command.includes("rm -f") && command.includes("plugins/installs.json"))) {
          throw new Error("state lifecycle command missing from dry-run report");
        }
      }
    ));
    checks.push(await stateLifecycleCommandIndexesCheck(tmp));
    checks.push(await stateLifecycleFailureShortCircuitCheck(tmp));
    checks.push(await pluginInstallIndexFixturesCheck(tmp));
    checks.push(await jsonCommandCheck(
      "allowlisted-scenario-omitted-state-falls-back-json",
      `node bin/kova.mjs run --target runtime:stable --scenario official-plugin-install --report-dir ${quoteShell(tmp)} --json`,
      async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        assertEqual(report.state?.id, "fresh", "omitted direct-run state falls back to fresh");
        assertEqual(report.records?.[0]?.state?.id, "fresh", "record uses default fresh state");
      }
    ));
    checks.push(await failingCommandCheck(
      "allowlisted-scenario-explicit-state-rejected",
      `node bin/kova.mjs run --target runtime:stable --scenario official-plugin-install --state fresh --report-dir ${quoteShell(tmp)} --json`,
      "scenario 'official-plugin-install' supports only states: official-plugins; got 'fresh'"
    ));
    checks.push(await jsonCommandCheck(
      "official-plugin-install-dry-run-json",
      `node bin/kova.mjs run --target runtime:stable --scenario official-plugin-install --state official-plugins --report-dir ${quoteShell(tmp)} --json`,
      async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const record = report.records?.[0];
        assertEqual(record?.auth?.mode, "skip", "official plugin install skips provider auth");
        const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
        if (phaseIds.includes("auth-prepare") || phaseIds.includes("auth-setup") || phaseIds.includes("auth-cleanup")) {
          throw new Error(`official plugin install should not inject provider auth phases: ${phaseIds.join(", ")}`);
        }
        const commands = record?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
        assertEqual(commands.some((command) => command.includes("run-official-plugin-install.mjs") && command.includes("states/official-plugins.json")), true, "official plugin state-backed command present");
        assertEqual(commands.some((command) => command.includes("ensure-gateway-running.mjs")), true, "official plugin post-install gateway reconciliation command present");
        assertEqual(commands.some((command) => command.includes("ocm service restart")), false, "official plugin should not issue a second restart after install-triggered restart");
      }
    ));
    checks.push(await jsonCommandCheck(
      "dry-run-source-env-quoting-json",
      `node bin/kova.mjs run --target local-build:/tmp/openclaw --from runtime:2026.5.2 --scenario upgrade-existing-user --source-env 'Team Env' --report-dir ${quoteShell(tmp)} --json`,
      async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const commands = report.records?.[0]?.phases
          ?.flatMap((phase) => phase.commands ?? []) ?? [];
        const cloneCommand = commands.find((item) => item.includes("ocm env clone")) ?? "";
        if (!cloneCommand.includes("ocm env clone 'Team Env'")) {
          throw new Error(`source env was not shell-quoted: ${cloneCommand}`);
        }
        assertEqual(commands.some((command) => command.includes("ocm upgrade") && /--runtime '?kova-local-/.test(command)), true, "existing-user upgrade uses target local-build runtime");
        assertEqual(commands.some((command) => command.includes("ocm upgrade") && command.includes("2026.5.2")), false, "existing-user source selector is not executed as an upgrade");
        const record = report.records?.[0];
        const snapshotPhases = record?.phases?.filter((phase) => phase.evidenceKind === "snapshot") ?? [];
        assertEqual(snapshotPhases.length, 2, "upgrade dry-run includes required snapshot phases");
        const snapshotLedgerEntries = record?.evidenceLedger?.entries?.filter((entry) => entry.category === "snapshot") ?? [];
        assertEqual(snapshotLedgerEntries.length, 2, "upgrade dry-run includes snapshot ledger entries");
        assertEqual(snapshotLedgerEntries.every((entry) => entry.required === true && entry.status === "skipped"), true, "dry-run snapshot ledger entries are required skipped evidence");
      }
    ));
    checks.push(await localBuildRuntimeCleanupCheck(tmp));
    checks.push(await localBuildRuntimeAlreadyAbsentCleanupCheck(tmp));
    checks.push(await localBuildRuntimeExceptionCleanupCheck(tmp));
    checks.push(await localBuildProfileEnvCheck(tmp, scope));
    checks.push(await localBuildParallelSingleFlightCheck(tmp));
    checks.push(defaultGatewayResourceRoleCheck());
    checks.push(gatewayProcessResourceRoleCheck());
    checks.push(compareRepeatAggregationCheck());
    checks.push(compareMetricOrderingCheck());
    checks.push(compareIdentityAndRollupCheck());
    checks.push(compareGatewayRssDedupeCheck());
    checks.push(resourceContractCompareCheck());
    checks.push(await reportCompareExitStatusCheck(tmp));
    checks.push(fixtureAccountingRenderCheck());

    const receiptCheck = await jsonCommandCheck(
      "dry-run-report-json",
      `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --repeat 2 --report-dir ${quoteShell(tmp)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "run receipt schema");
        assertEqual(data.mode, "dry-run", "run mode");
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 2, "dry-run repeat count");
        assertEqual(data.performance?.repeat, 2, "run receipt repeat");
        assertEqual(data.performance?.resourceMeasurementScope, RESOURCE_MEASUREMENT_SCOPE, "run receipt resource scope");
        assertEqual(data.performance?.resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "run receipt resource contract");
        assertString(data.jsonPath, "json report path");
      }
    );
    checks.push(receiptCheck);
    checks.push(await reportRunIdReferenceCheck(tmp));

    checks.push(await jsonCommandCheck(
      "matrix-dry-run-json",
      `node bin/kova.mjs matrix run --profile smoke --target runtime:stable --include tag:plugins --exclude state:stale-runtime-deps --parallel 2 --report-dir ${quoteShell(tmp)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.matrix.run.receipt.v1", "matrix run receipt schema");
        assertEqual(data.mode, "dry-run", "matrix dry-run mode");
        assertEqual(data.performance?.resourceMeasurementScope, RESOURCE_MEASUREMENT_SCOPE, "matrix receipt resource scope");
        assertEqual(data.performance?.resourceHeadlineContract, RESOURCE_HEADLINE_CONTRACT, "matrix receipt resource contract");
        assertString(data.jsonPath, "matrix json report path");
        assertString(data.bundlePath, "matrix bundle path");
        if (!data.bundlePath.startsWith(tmp)) {
          throw new Error(`matrix bundle path should use report dir: ${data.bundlePath}`);
        }
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 5, "filtered matrix dry-run count");
      }
    ));
    checks.push(await matrixWorkerRejectionCheck());
    checks.push(await gateDryRunCheck(tmp));
    checks.push(gatePartialFailureCheck());
    checks.push(gatePartialPassCheck());
    checks.push(gatePlatformCoverageCheck());
    checks.push(gateNonReleaseOutcomeCheck());
    checks.push(gateRequirementCoverageCheck());
    checks.push(gateScenarioWildcardCheck());
    checks.push(gateExecutedCoverageDimensionsCheck());
    checks.push(await doctorUpgradeGatePolicyCheck());
    checks.push(gateSubsystemSummaryCheck());
    checks.push(safetyGuardCheck());
    checks.push(await failingCommandCheck(
      "gate-preflight-source-env",
      `node bin/kova.mjs matrix run --profile release --target runtime:stable --execute --gate --report-dir ${quoteShell(tmp)} --json`,
      "release gate preflight failed: --source-env <env> is required"
    ));

    if (receiptCheck.status === "PASS") {
      const report = JSON.parse(await readFile(receiptCheck.data.jsonPath, "utf8"));
      checks.push(validateReport(report));
      checks.push(await jsonCommandCheck(
        "report-compare-json",
        `node bin/kova.mjs report compare ${quoteShell(receiptCheck.data.jsonPath)} ${quoteShell(receiptCheck.data.jsonPath)} --json`,
        (data) => {
          assertEqual(data.schemaVersion, "kova.compare.v1", "compare schema");
          assertEqual(data.ok, true, "compare ok");
          assertEqual(data.regressionCount, 0, "compare regression count");
        }
      ));
      checks.push(await jsonCommandCheck(
        "report-bundle-json",
        `node bin/kova.mjs report bundle ${quoteShell(receiptCheck.data.jsonPath)} --output-dir ${quoteShell(tmp)} --json`,
        (data) => {
          assertEqual(data.schemaVersion, "kova.artifact.bundle.v1", "bundle schema");
          assertString(data.outputPath, "bundle output path");
          assertString(data.checksumPath, "bundle checksum path");
          assertString(data.sha256, "bundle sha256");
          assertEqual(data.included?.artifactIndex, true, "bundle includes artifact index");
          assertEqual(data.artifactIndex?.path, "artifact-index.json", "artifact index path");
          assertEqual((data.artifactIndex?.fileCount ?? 0) > 0, true, "artifact index file count");
        }
      ));
      const publishBundle = await bundleReport(receiptCheck.data.jsonPath, { outputDir: tmp });
      const committedReportBytes = await readFile(receiptCheck.data.jsonPath);
      await writeFile(
        receiptCheck.data.jsonPath,
        `${JSON.stringify({ ...report, mode: "stale-generation" }, null, 2)}\n`
      );
      const staleGenerationBundle = await bundleReport(
        receiptCheck.data.jsonPath,
        { outputDir: tmp }
      );
      await writeFile(receiptCheck.data.jsonPath, committedReportBytes);
      const newerBundleTime = new Date(Date.now() + 60_000);
      await utimes(
        staleGenerationBundle.outputPath,
        newerBundleTime,
        newerBundleTime
      );
      await writeFile(join(tmp, `${report.runId}-bundle.tar.gz`), "stale legacy bundle\n");
      const publishRoot = join(tmp, "publish-content-addressed");
      const publishOutDir = join(publishRoot, "src", "content", "releases");
      checks.push(await jsonCommandCheck(
        "publish-content-addressed-bundle",
        `node bin/kova.mjs publish ${quoteShell(receiptCheck.data.jsonPath)} --ver 2026.7.12-selfcheck --release-date 2026-07-12 --sha selfcheck --out-dir ${quoteShell(publishOutDir)} --json`,
        async () => {
          const payload = JSON.parse(await readFile(join(publishOutDir, "2026.7.12-selfcheck.json"), "utf8"));
          const bundleName = basename(publishBundle.outputPath);
          assertEqual(payload.runs?.[0]?.bundle?.name, bundleName, "publish discovers content-addressed report bundle");
          assertEqual(
            payload.runs?.[0]?.bundle?.name === basename(staleGenerationBundle.outputPath),
            false,
            "publish rejects a newer bundle from another report generation"
          );
          assertEqual(
            await fileExists(join(publishRoot, "public", "bundles", bundleName)),
            true,
            "publish copies content-addressed report bundle"
          );
        }
      ));
      const externalReportPath = join(tmp, "external-report.json");
      const externalMarkdownPath = join(tmp, "external-report.md");
      const externalReport = {
        ...report,
        runId: "external/report",
        outputPaths: {
          ...report.outputPaths,
          json: externalReportPath,
          markdown: externalMarkdownPath
        }
      };
      await writeFile(externalReportPath, `${JSON.stringify(externalReport, null, 2)}\n`);
      await writeFile(externalMarkdownPath, "# external report\n");
      const externalBundle = await bundleReport(externalReportPath, { outputDir: tmp });
      const externalPublishRoot = join(tmp, "publish-external-content-addressed");
      const externalPublishOutDir = join(externalPublishRoot, "src", "content", "releases");
      checks.push(await jsonCommandCheck(
        "publish-noncanonical-content-addressed-bundle",
        `node bin/kova.mjs publish ${quoteShell(externalReportPath)} --ver 2026.7.12-external-selfcheck --release-date 2026-07-12 --sha selfcheck --out-dir ${quoteShell(externalPublishOutDir)} --json`,
        async () => {
          const payload = JSON.parse(
            await readFile(join(externalPublishOutDir, "2026.7.12-external-selfcheck.json"), "utf8")
          );
          const bundleName = basename(externalBundle.outputPath);
          assertEqual(
            payload.runs?.[0]?.bundle?.name,
            bundleName,
            "publish uses the producer mapping for noncanonical run IDs"
          );
          assertEqual(
            await fileExists(join(externalPublishRoot, "public", "bundles", bundleName)),
            true,
            "publish copies noncanonical content-addressed report bundle"
          );
        }
      ));

      const misleadingRunId = "kova-260712-235959-deadbe";
      const misleadingReportPath = join(tmp, `${misleadingRunId}.json`);
      const misleadingMarkdownPath = join(tmp, `${misleadingRunId}.md`);
      await writeFile(
        misleadingReportPath,
        `${JSON.stringify({ ...report, runId: misleadingRunId }, null, 2)}\n`
      );
      await writeFile(misleadingMarkdownPath, "# misleading report\n");
      const misleadingBundle = await bundleReport(misleadingReportPath, { outputDir: tmp });
      const expectedBundleRoot = `${report.runId}-bundle`;
      const unsafeArchives = [];
      const unsafeEntrySets = [
        [{ name: "-unsafe/manifest.json", content: JSON.stringify({ runId: report.runId }) }],
        [{
          name: `${expectedBundleRoot}/../${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/./manifest.json`,
            content: JSON.stringify({ runId: "wrong-run" })
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: "wrong-run" })
          }
        ],
        [{
          name: `${expectedBundleRoot}/format\u00ad\u200b\u200c\u200d\u2060\ufeff/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: "package.json",
            content: "{}"
          }
        ],
        [{
          name: `${expectedBundleRoot}/manifest.json/`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [{
          name: `C:/${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [{
          name: `server:stream/${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [{
          name: `CON/${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [{
          name: `host\\share\\${expectedBundleRoot}\\manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        }],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: "",
            type: "5"
          },
          {
            name: `${expectedBundleRoot}/manifest.json/payload.json`,
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [{
          name: `${expectedBundleRoot}/manifest.json`,
          content: "",
          type: "2",
          linkName: `${expectedBundleRoot}/other.json`
        }],
        [{
          name: `${expectedBundleRoot}/manifest.json`,
          content: "",
          type: "1",
          linkName: `${expectedBundleRoot}/other.json`
        }],
        [
          {
            name: "PaxHeader",
            content: buildPaxRecord("size", String(512 * 1024 * 1024 + 1)),
            type: "x"
          },
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [
          {
            name: "LongPath",
            content: `${expectedBundleRoot}/manifest.json\0`,
            type: "L"
          },
          {
            name: "placeholder",
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [
          {
            name: "OldGnuLongPath",
            content: `${expectedBundleRoot}/manifest.json\0`,
            type: "N"
          },
          {
            name: "placeholder",
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [
          {
            name: "LongLink",
            content: `${expectedBundleRoot}/manifest.json\0`,
            type: "K"
          },
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: "PaxHeader",
            content: buildPaxRecord(
              "path",
              `${expectedBundleRoot}/./manifest.json`
            ),
            type: "x"
          },
          {
            name: "placeholder",
            content: JSON.stringify({ runId: "wrong-run" })
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot.toUpperCase()}/MANIFEST.JSON`,
            content: JSON.stringify({ runId: "wrong-run" })
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/caf\u00e9.json`,
            content: "{}"
          },
          {
            name: `${expectedBundleRoot}/cafe\u0301.json`,
            content: "{}"
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/sigma-\u03c3.json`,
            content: "{}"
          },
          {
            name: `${expectedBundleRoot}/sigma-\u03c2.json`,
            content: "{}"
          }
        ],
        [
          { pseudoTerminator: true, content: "" },
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/malformed-size.bin`,
            content: "",
            rawSizeField: Buffer.from([0, 0x2d, 0x31])
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: "invalid-name",
            rawNameField: Buffer.from([0xff]),
            content: "{}"
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: "invalid-prefix",
            rawPrefixField: Buffer.from([0xff]),
            content: "{}"
          }
        ],
        [{
          name: `${expectedBundleRoot}/manifest.json`,
          content: Buffer.concat([
            Buffer.from(`{"runId":"${report.runId}","note":"`),
            Buffer.from([0xff]),
            Buffer.from('"}')
          ])
        }],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/manifest.json/payload.json`,
            content: "{}"
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json/payload.json`,
            content: "{}"
          },
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          }
        ],
        [{
          name: `${expectedBundleRoot}/oversized-directory`,
          content: "x",
          declaredSize: 1,
          type: "5"
        }],
        [
          {
            name: "GlobalPaxHeader",
            content: buildPaxRecord("path", "../escape"),
            type: "g"
          },
          {
            name: `${expectedBundleRoot}/safe.json`,
            content: "{}"
          }
        ],
        [
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/oversized.bin`,
            content: "",
            declaredSize: 512 * 1024 * 1024 + 1
          }
        ],
        [{
          name: `${expectedBundleRoot}/manifest.json`,
          content: "x".repeat(64 * 1024 + 1)
        }],
        [
          {
            name: "PaxHeader",
            content: buildPaxRecord(
              "path",
              `${expectedBundleRoot}/${"x".repeat(4 * 1024 + 1)}`
            ),
            type: "x"
          },
          {
            name: "placeholder",
            content: "{}"
          }
        ]
      ];
      unsafeEntrySets.push(
        ...["<", ">", "\"", "|", "?", "*"].map((character) => [{
          name: `${expectedBundleRoot}/forbidden-${character}.json`,
          content: JSON.stringify({ runId: report.runId })
        }]),
        Array.from({ length: 10_001 }, (_, index) => ({
          name: `${expectedBundleRoot}/many/${index}.json`,
          content: "{}"
        }))
      );
      for (const entries of unsafeEntrySets) {
        const archive = buildTarGzipFixture(entries);
        const digest = createHash("sha256").update(archive).digest("hex");
        const path = join(tmp, `${report.runId}-bundle-${digest}.tar.gz`);
        await writeFile(path, archive);
        await writeFile(
          `${path}.sha256`,
          `${digest}  ${basename(path)}\n`
        );
        unsafeArchives.push(path);
      }
      const oversizedArchivePath = join(
        tmp,
        `${report.runId}-bundle-${"f".repeat(64)}.tar.gz`
      );
      await writeFile(oversizedArchivePath, "");
      await truncate(oversizedArchivePath, 256 * 1024 * 1024 + 1);
      await writeFile(
        `${oversizedArchivePath}.sha256`,
        `${"f".repeat(64)}  ${basename(oversizedArchivePath)}\n`
      );
      unsafeArchives.push(oversizedArchivePath);
      const oversizedChecksumArchive = buildTarGzipFixture([{
        name: `${expectedBundleRoot}/manifest.json`,
        content: JSON.stringify({ runId: report.runId })
      }]);
      const oversizedChecksumDigest = createHash("sha256")
        .update(oversizedChecksumArchive)
        .digest("hex");
      const oversizedChecksumPath = join(
        tmp,
        `${report.runId}-bundle-${oversizedChecksumDigest}.tar.gz`
      );
      await writeFile(oversizedChecksumPath, oversizedChecksumArchive);
      await writeFile(`${oversizedChecksumPath}.sha256`, "x".repeat(8 * 1024 + 1));
      unsafeArchives.push(oversizedChecksumPath);

      const mismatchedExplicitArchive = buildTarGzipFixture([
        {
          name: `${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        },
        {
          name: `${expectedBundleRoot}/mismatched-explicit.json`,
          content: "{}"
        }
      ]);
      const mismatchedExplicitDigest = "0".repeat(64);
      const mismatchedExplicitPath = join(
        tmp,
        `${report.runId}-bundle-${mismatchedExplicitDigest}.tar.gz`
      );
      await writeFile(mismatchedExplicitPath, mismatchedExplicitArchive);
      await writeFile(
        `${mismatchedExplicitPath}.sha256`,
        `${mismatchedExplicitDigest}  ${basename(mismatchedExplicitPath)}\n`
      );
      unsafeArchives.push(mismatchedExplicitPath);

      const badSidecarArchive = buildTarGzipFixture([
        {
          name: `${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        },
        {
          name: `${expectedBundleRoot}/bad-sidecar.json`,
          content: "{}"
        }
      ]);
      const badSidecarDigest = createHash("sha256")
        .update(badSidecarArchive)
        .digest("hex");
      const badSidecarPath = join(
        tmp,
        `${report.runId}-bundle-${badSidecarDigest}.tar.gz`
      );
      await writeFile(badSidecarPath, badSidecarArchive);
      await writeFile(`${badSidecarPath}.sha256`, "bad checksum\n");
      unsafeArchives.push(badSidecarPath);

      const missingSidecarArchive = buildTarGzipFixture([
        {
          name: `${expectedBundleRoot}/manifest.json`,
          content: JSON.stringify({ runId: report.runId })
        },
        {
          name: `${expectedBundleRoot}/missing-sidecar.json`,
          content: "{}"
        }
      ]);
      const missingSidecarDigest = createHash("sha256")
        .update(missingSidecarArchive)
        .digest("hex");
      const missingSidecarPath = join(
        tmp,
        `${report.runId}-bundle-${missingSidecarDigest}.tar.gz`
      );
      await writeFile(missingSidecarPath, missingSidecarArchive);
      unsafeArchives.push(missingSidecarPath);

      if (process.platform !== "win32") {
        const fifoChecksumArchive = buildTarGzipFixture([
          {
            name: `${expectedBundleRoot}/manifest.json`,
            content: JSON.stringify({ runId: report.runId })
          },
          {
            name: `${expectedBundleRoot}/fifo-checksum.json`,
            content: "{}"
          }
        ]);
        const fifoChecksumDigest = createHash("sha256")
          .update(fifoChecksumArchive)
          .digest("hex");
        const fifoChecksumPath = join(
          tmp,
          `${report.runId}-bundle-${fifoChecksumDigest}.tar.gz`
        );
        await writeFile(fifoChecksumPath, fifoChecksumArchive);
        const fifoChecksum = await runCommand(
          `mkfifo ${quoteShell(`${fifoChecksumPath}.sha256`)}`
        );
        assertEqual(fifoChecksum.status, 0, "creates checksum FIFO fixture");
        unsafeArchives.push(fifoChecksumPath);
      }
      const reportForBundleDiscovery = structuredClone(report);
      delete reportForBundleDiscovery.bundle;
      delete reportForBundleDiscovery.bundlePath;
      if (reportForBundleDiscovery.outputPaths) {
        delete reportForBundleDiscovery.outputPaths.bundle;
        delete reportForBundleDiscovery.outputPaths.bundlePath;
      }
      await writeFile(
        misleadingReportPath,
        `${JSON.stringify(reportForBundleDiscovery, null, 2)}\n`
      );
      await writeFile(
        misleadingMarkdownPath,
        await readFile(receiptCheck.data.jsonPath.replace(/\.json$/, ".md"), "utf8")
      );
      const priorityPublishRoot = join(tmp, "publish-run-id-priority");
      const priorityPublishOutDir = join(
        priorityPublishRoot,
        "src",
        "content",
        "releases"
      );
      checks.push(await jsonCommandCheck(
        "publish-prefers-report-run-id-bundle",
        `node bin/kova.mjs publish ${quoteShell(misleadingReportPath)} --ver 2026.7.12-run-id-priority --release-date 2026-07-12 --sha selfcheck --out-dir ${quoteShell(priorityPublishOutDir)} --json`,
        async () => {
          const payload = JSON.parse(
            await readFile(
              join(priorityPublishOutDir, "2026.7.12-run-id-priority.json"),
              "utf8"
            )
          );
          assertEqual(
            payload.runs?.[0]?.bundle?.name,
            basename(publishBundle.outputPath),
            "publish prioritizes the report run ID bundle"
          );
          assertEqual(
            payload.runs?.[0]?.bundle?.name === basename(misleadingBundle.outputPath),
            false,
            "publish rejects a newer filename-derived bundle from another run"
          );
          assertEqual(
            unsafeArchives.some(
              (path) => payload.runs?.[0]?.bundle?.name === basename(path)
            ),
            false,
            "publish rejects option-like, traversal, aliased, and duplicate tar members"
          );
        }
      ));
      const invalidExplicitRoot = join(tmp, "publish-invalid-explicit");
      const invalidExplicitReportPath = join(invalidExplicitRoot, "report.json");
      const invalidExplicitBundlePath = join(invalidExplicitRoot, "invalid-bundle.tar.gz");
      await mkdir(invalidExplicitRoot);
      await writeFile(invalidExplicitBundlePath, "not a bundle\n");
      const validExplicitBundlePath = join(
        invalidExplicitRoot,
        basename(publishBundle.outputPath)
      );
      await cp(publishBundle.outputPath, validExplicitBundlePath);
      await cp(
        publishBundle.checksumPath,
        `${validExplicitBundlePath}.sha256`
      );
      await writeFile(
        invalidExplicitReportPath,
        `${JSON.stringify({
          ...report,
          bundle: {
            outputPath: validExplicitBundlePath
          },
          bundlePath: invalidExplicitBundlePath
        }, null, 2)}\n`
      );
      await writeFile(join(invalidExplicitRoot, "report.md"), "# invalid explicit bundle\n");
      checks.push(await failingCommandCheck(
        "publish-rejects-invalid-explicit-bundle",
        `node bin/kova.mjs publish ${quoteShell(invalidExplicitReportPath)} --ver 2026.7.12-invalid-explicit --release-date 2026-07-12 --sha selfcheck --out-dir ${quoteShell(join(invalidExplicitRoot, "releases"))} --json`,
        "explicitly referenced report bundle failed integrity verification"
      ));
      const legacyExplicitRoot = join(tmp, "publish-legacy-explicit");
      const legacyExplicitReportPath = join(legacyExplicitRoot, "report.json");
      const legacyExplicitMarkdownPath = join(legacyExplicitRoot, "report.md");
      const legacyExplicitBundlePath = join(legacyExplicitRoot, "report-bundle.tar.gz");
      await mkdir(legacyExplicitRoot);
      const legacyExplicitReport = {
        ...report,
        bundlePath: legacyExplicitBundlePath
      };
      await writeFile(
        legacyExplicitReportPath,
        `${JSON.stringify(legacyExplicitReport, null, 2)}\n`
      );
      await writeFile(legacyExplicitMarkdownPath, "# legacy explicit bundle\n");
      const contentAddressedLegacySource = await bundleReport(
        legacyExplicitReportPath,
        { outputDir: legacyExplicitRoot }
      );
      await cp(contentAddressedLegacySource.outputPath, legacyExplicitBundlePath);
      await cp(
        contentAddressedLegacySource.checksumPath,
        `${legacyExplicitBundlePath}.sha256`
      );
      checks.push(await failingCommandCheck(
        "publish-rejects-non-content-addressed-explicit-bundle",
        `node bin/kova.mjs publish ${quoteShell(legacyExplicitReportPath)} --ver 2026.7.12-legacy-explicit --release-date 2026-07-12 --sha selfcheck --out-dir ${quoteShell(join(legacyExplicitRoot, "releases"))} --json`,
        "explicitly referenced report bundle failed integrity verification"
      ));
    }

  const ok = checks.every((check) => check.status === "PASS");
  const result = {
    schemaVersion: "kova.selfcheck.v1",
    generatedAt: new Date().toISOString(),
    scopeId: scope.id,
    ok,
    checks: checks.map(({ data, ...check }) => check)
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (flags.plain === true) {
    for (const check of result.checks) {
      console.log(`${check.status} ${check.id}${check.message ? `: ${check.message}` : ""}`);
    }
  } else {
    progress.runFinish({ ok, total: result.checks.length });
    console.log(renderSelfCheckReceipt(result, flags));
  }

  if (!ok) {
    throw new Error("self-check failed");
  }
}
