import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScriptStep } from "mock-ai-provider/dist/providers/openai/common/scripted-response.js";
import { quoteShell, runCommand } from "./commands.mjs";
import { runCleanupCommand } from "./cleanup.mjs";
import { applyEvidenceLedgerGating, attachEvidenceLedger } from "./evidence-ledger.mjs";
import { attachCleanupEvidence } from "./evidence/record.mjs";
import { appendChannelCapabilityEvidence, channelCapabilityEvidenceFromResult } from "./run/channel-capability-results.mjs";
import { summarizeCpuProfiles } from "./collectors/node-profiles.mjs";
import { summarizeHeapProfiles } from "./collectors/heap.mjs";
import { collectEnvMetrics } from "./metrics.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import { evaluateWorkflowCase } from "../support/channel-conformance/evaluator.mjs";
import { assertValidObservationSet } from "../support/channel-conformance/observation-schema.mjs";
import { planWorkflowCases } from "../support/channel-conformance/planner.mjs";
import { channelWorkflowScript } from "../support/channel-workflow-provider-script.mjs";
import { evaluateGate } from "./matrix/gate.mjs";
import { extractAssistantVisibleText } from "../support/openclaw-runtime.mjs";
import { declaredCapabilityProofRows } from "../support/channel-conformance/capability-proof.mjs";
import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore
} from "./performance/baselines.mjs";
import { buildPerformanceSummary } from "./performance/stats.mjs";
import {
  loadChannelCapabilities,
  validateChannelCapabilityCatalogReferences,
  validateChannelCapabilityWorkflowReferences,
  validateChannelCapabilityShape
} from "./registries/channel-capabilities.mjs";
import { loadChannelCapabilityCatalog, validateChannelCapabilityCatalogShape } from "./registries/channel-capability-catalog.mjs";
import { loadChannelWorkflowInventory, validateChannelWorkflowInventoryReferences } from "./registries/channel-workflow-inventory.mjs";
import {
  loadChannelWorkflowCaseCatalog,
  validateChannelWorkflowCaseCatalogReferences,
  validateChannelWorkflowCaseCatalogShape,
  validateChannelWorkflowCaseInventoryReferences
} from "./registries/channel-workflow-cases.mjs";
import { loadProcessRoles } from "./registries/process-roles.mjs";
import { validateProfileShape } from "./registries/profiles.mjs";
import { validateScenarioShape } from "./registries/scenarios.mjs";
import { validateStateShape } from "./registries/states.mjs";
import { validateRegistryReferences } from "./registries/validate.mjs";
import { assertSafeScenarioCommand } from "./safety.mjs";
import { parseTimelineText } from "./collectors/timeline.mjs";
import {
  boundedLogSnippet,
  isExpectedKovaMockProviderFailureLine,
  summarizeEmbeddedRunTraces,
  summarizeLivenessWarnings,
  summarizeRuntimeDepsLogs
} from "./collectors/logs.mjs";
import {
  buildAgentTurnBreakdown,
  summarizeAgentTurnBreakdownForMarkdown
} from "./collectors/agent-turns.mjs";
import { buildAgentCliPreProviderAttribution } from "./collectors/agent-cli-attribution.mjs";
import {
  attributedSpanIntervals,
  buildGatewaySessionPreProviderAttribution
} from "./collectors/gateway-session-turn-attribution.mjs";
import { classifyReadiness } from "./collectors/readiness.mjs";
import {
  computeProviderTurnAttribution,
  parseProviderRequestLog,
  parseTimelineProviderRequestLog
} from "./collectors/provider.mjs";
import { captureProcessSnapshot, classifyRegistryRolesForProcess, classifySnapshotRolesForProcess, diffProcessSnapshots, summarizeResourceSamples } from "./collectors/resources.mjs";
import { captureOpenClawStateSnapshot } from "./collectors/openclaw-state.mjs";
import { buildReportSummary, renderMarkdownReport, renderPasteSummary, renderReportSummary, summarizeRecords } from "./reporting/report.mjs";
import { buildRepeatedWorkAudit } from "./audits/repeated-work.mjs";
import { ENV_COLLECTOR_IDS, resolveCollectionPolicy } from "./collection-policy.mjs";
import { channelPlatformsDir } from "./paths.mjs";
import {
  buildAgentCliLocalTurnEvidenceInvariants,
  buildAgentGatewayRpcTurnEvidenceInvariants,
  buildGatewaySessionEvidenceInvariants,
  buildOfficialPluginInstallEvidenceInvariants,
  buildReleaseRuntimeStartupEvidenceInvariants,
  buildUpgradeLogDerivedInvariants,
  buildUpgradeStateSnapshotInvariants
} from "./evidence/invariants.mjs";
import {
  attachCommandResultInterpretation,
  commandFailureRecordStatus,
  interpretCommandResult,
  isNoLogsOutput,
  normalizeOptionalCommandResult
} from "./command-results.mjs";
import { compareReports, renderCompareSummary } from "./reporting/compare.mjs";
import { scenarioMetricRows } from "./reporting/compare-aggregate.mjs";
import { renderAssessment } from "./reporting/render-assessment.mjs";
import { aggregateScenarios } from "./reporting/scenario-aggregate.mjs";
import {
  ocmAt,
  ocmEnvDestroy,
  ocmEnvExec,
  ocmEnvExecShell,
  ocmLogs,
  ocmRuntimeBuildLocal,
  ocmRuntimeRemoveJson,
  ocmServiceStatusJson,
  ocmTargetSelector
} from "./ocm/commands.mjs";
import { mockAiProviderServeCommand } from "./auth.mjs";
import { envNameFor, maxOcmEnvNameLength } from "./run/env-name.mjs";
import {
  checkAggregateThreshold,
  checkDuration,
  checkEvidenceThreshold,
  checkRoleThresholds,
  checkTurnThreshold
} from "./evaluation/violations.mjs";
import { resolveThresholdPolicy } from "./evaluation/thresholds.mjs";
import { createSelfCheckProgress, renderSelfCheckReceipt } from "./reporting/render-selfcheck.mjs";

export async function runSelfCheck(flags = {}) {
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
  const tmp = await mkdtemp(join(tmpdir(), "kova-self-check-"));
  const previousKovaHome = process.env.KOVA_HOME;
  process.env.KOVA_HOME = join(tmp, "kova-home");

  try {
    checks.push(await commandCheck(
      "syntax",
      "for f in bin/kova.mjs $(find src -name '*.mjs' -type f | sort); do node --check \"$f\" || exit 1; done"
    ));
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
    checks.push(await failingCommandCheck(
      "setup-non-tty-requires-mode",
      "node bin/kova.mjs setup --json",
      "kova setup requires --non-interactive or --ci when stdin is not a TTY"
    ));
    checks.push(await credentialStoreSelfCheck(tmp));
    checks.push(await failingCommandCheck(
      "live-auth-requires-credentials",
      `KOVA_HOME=${quoteShell(join(tmp, "empty-auth-home"))} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json`,
      "--auth live requires configured live credentials"
    ));
    checks.push(await setupNumericFlagsRejectedCheck(tmp));
    checks.push(await externalCliSetupCheck(tmp));
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
    checks.push(await failingCommandCheck(
      "setup-external-cli-verifies-auth",
      `HOME=${quoteShell(join(tmp, "no-codex-auth"))} KOVA_HOME=${quoteShell(join(tmp, "missing-external-cli-auth-home"))} node bin/kova.mjs setup --non-interactive --provider openai --auth external-cli --json`,
      "external-cli codex is not usable"
    ));
    checks.push(await externalCliRunAuthVerificationCheck(tmp));
    checks.push(await commandTimeoutContractCheck());
    checks.push(await commandOutputBudgetCheck());
    checks.push(logSnippetBudgetCheck());
    checks.push(expectedMockProviderFailureTimeoutLogCheck());
    checks.push(optionalNoLogsCommandCheck());
    checks.push(commandResultInterpretationCheck());
    checks.push(missingCollectorProofCheck());
    checks.push(ocmCommandBuildersCheck());
    checks.push(envNameLengthCheck());
    checks.push(evaluationViolationHelpersCheck());
    checks.push(statusFoundationCheck());
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
    checks.push(await doctorUpgradeSnapshotEvidenceCheck(tmp));
    checks.push(upgradeStateSnapshotInvariantsCheck());
    checks.push(upgradeLogDerivedInvariantsCheck());
    checks.push(localBuildTargetSetupResourceExclusionCheck());
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
      const officialSurface = data.surfaces.find((surface) => surface.id === "official-plugin-install");
      assertEqual(Boolean(officialSurface), true, "official plugin surface present");
      assertArrayNotEmpty(officialSurface?.purposes, "official plugin surface purposes");
      assertArrayNotEmpty(officialSurface?.requirements, "official plugin surface requirements");
      assertEqual(data.states.some((state) => state.id === "official-plugins"), true, "official plugins state present");
      assertEqual(data.scenarios.some((scenario) => scenario.id === "official-plugin-install" && scenario.surface === "official-plugin-install"), true, "official plugin scenario present");
      if (data.scenarios.some((scenario) => typeof scenario.surface !== "string" || scenario.surface.length === 0)) {
        throw new Error("every scenario must expose a surface");
      }
      if (data.scenarios.some((scenario) => !Array.isArray(scenario.proves) || scenario.proves.length === 0)) {
        throw new Error("every scenario must declare the surface requirement ids it proves");
      }
    }));
    checks.push(await channelCapabilityRegistryCheck());
    checks.push(await inventoryPlanCheck(tmp));
    checks.push(await repeatedWorkAuditCheck());
    checks.push(await collectionPolicyResolverCheck(tmp));
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
    }));
    checks.push(await jsonCommandCheck("durable-clone-local-build-dry-run-json", `node bin/kova.mjs run --target local-build:/tmp/openclaw --scenario upgrade-durable-clone-to-local-build --state plugin-index --source-env 'Team Env' --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      const commands = (record?.phases ?? []).flatMap((phase) => phase.commands ?? []);
      assertEqual(commands.some((command) => command.includes("ocm env clone 'Team Env'")), true, "quoted source env clone command present");
      assertEqual(commands.some((command) => command.includes("ocm upgrade") && /--runtime '?kova-local-/.test(command)), true, "local-build runtime upgrade command present");
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
      }));
    }
    checks.push(await jsonCommandCheck("run-profiling-dry-run-json", `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --node-profile --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      assertEqual(report.records?.[0]?.profiling?.enabled, true, "profiling marker");
      assertEqual(report.performance?.profiledRunCount, 1, "profiled run count");
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
      assertEqual(data.profile?.diagnostics?.timelineRequired, true, "diagnostic timeline required");
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
    }));
    checks.push(await cleanupArtifactsCheck(tmp));
    checks.push(await diagnosticsTimelineCheck());
    checks.push(await diagnosticsOpenSpanCheck());
    checks.push(diagnosticsTimelineEvaluationCheck());
    checks.push(runtimeDepsLogParserCheck());
    checks.push(embeddedRunLogParserCheck());
    checks.push(runtimeDepsWarmReuseEvaluationCheck());
    checks.push(await performanceBaselineCheck(tmp));
    checks.push(markdownFailureCardsCheck());
    checks.push(reportRecommendedNextScenarioCheck());
    checks.push(readinessClassificationCheck());
    checks.push(healthReadinessModelCheck());
    checks.push(healthFailureThresholdPolicyCheck());
    checks.push(agentContainmentHealthScopeCheck());
    checks.push(await resourceRoleAttributionCheck(tmp));
    checks.push(await resourceRootCommandRoleBoundaryCheck());
    checks.push(await resourceRolePollutionCheck());
    checks.push(await gatewaySessionSurfaceContractCheck());
    checks.push(await releaseRuntimeStartupSurfaceContractCheck());
    checks.push(await officialPluginInstallSurfaceContractCheck());
    checks.push(await agentCliLocalTurnSurfaceContractCheck());
    checks.push(await agentGatewayRpcTurnSurfaceContractCheck());
    checks.push(releaseRuntimeStartupEvidenceInvariantCheck());
    checks.push(officialPluginInstallEvidenceInvariantCheck());
    checks.push(agentCliLocalTurnEvidenceInvariantCheck());
    checks.push(agentGatewayRpcTurnEvidenceInvariantCheck());
    checks.push(await processSnapshotCheck(tmp));
    checks.push(roleThresholdEvaluationCheck());
    checks.push(thresholdPolicyCalibrationCheck());
    checks.push(await cleanupRetryCheck(tmp));
    checks.push(stateRegistryValidationCheck());
    checks.push(scenarioCloneFirstValidationCheck());
    checks.push(scenarioHealthScopeValidationCheck());
    checks.push(scenarioStateCompatibilityCheck());
    checks.push(await cpuProfileParserCheck());
    checks.push(await heapProfileParserCheck());
    checks.push(await providerEvidenceParserCheck());
    checks.push(agentTurnBreakdownCheck());
    checks.push(gatewaySessionHistoryTextExtractionCheck());
    checks.push(gatewaySessionTurnEvaluationCheck());
    checks.push(gatewaySessionEvidenceInvariantCheck());
    checks.push(gatewaySessionPreProviderAttributionCheck());
    checks.push(agentCliPreProviderAttributionCheck());
    checks.push(await mockProviderBehaviorCheck(tmp));
    checks.push(providerFailureEvaluationCheck());
    checks.push(agentColdWarmEvaluationCheck());
    checks.push(sourceReleaseCompareCheck());
    checks.push(await concurrentAgentRunnerCheck(tmp));
    checks.push(providerConcurrentEvaluationCheck());
    checks.push(agentAuthFailureEvaluationCheck());
    checks.push(await soakLoopRunnerCheck(tmp));
    checks.push(soakTrendEvaluationCheck());
    checks.push(mcpBridgeEvidenceEvaluationCheck());
    checks.push(browserAutomationEvidenceEvaluationCheck());
    checks.push(mediaUnderstandingEvidenceEvaluationCheck());
    checks.push(networkOfflineEvidenceEvaluationCheck());
    checks.push(await officialPluginInstallRunnerCheck(tmp));
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
    checks.push(defaultGatewayResourceRoleCheck());
    checks.push(compareRepeatAggregationCheck());
    checks.push(compareMetricOrderingCheck());
    checks.push(compareGatewayRssDedupeCheck());
    checks.push(fixtureAccountingRenderCheck());

    const receiptCheck = await jsonCommandCheck(
      "dry-run-report-json",
      `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --repeat 2 --report-dir ${quoteShell(tmp)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "run receipt schema");
        assertEqual(data.mode, "dry-run", "run mode");
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 2, "dry-run repeat count");
        assertEqual(data.performance?.repeat, 2, "run receipt repeat");
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
        assertString(data.jsonPath, "matrix json report path");
        assertString(data.bundlePath, "matrix bundle path");
        if (!data.bundlePath.startsWith(tmp)) {
          throw new Error(`matrix bundle path should use report dir: ${data.bundlePath}`);
        }
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 6, "filtered matrix dry-run count");
      }
    ));
    checks.push(await gateDryRunCheck(tmp));
    checks.push(gatePartialFailureCheck());
    checks.push(gatePartialPassCheck());
    checks.push(gatePlatformCoverageCheck());
    checks.push(gateNonReleaseOutcomeCheck());
    checks.push(gateRequirementCoverageCheck());
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
    }
  } finally {
    if (previousKovaHome === undefined) {
      delete process.env.KOVA_HOME;
    } else {
      process.env.KOVA_HOME = previousKovaHome;
    }
    await rm(tmp, { recursive: true, force: true });
  }

  const ok = checks.every((check) => check.status === "PASS");
  const result = {
    schemaVersion: "kova.selfcheck.v1",
    generatedAt: new Date().toISOString(),
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

function ocmCommandBuildersCheck() {
  try {
    assertEqual(ocmTargetSelector({ kind: "npm", value: "2026.4.27" }), "--version '2026.4.27'", "npm selector");
    assertEqual(ocmTargetSelector({ kind: "release", value: "beta" }), "--channel 'beta'", "release selector");
    assertEqual(ocmTargetSelector({ kind: "runtime", value: "stable" }), "--runtime 'stable'", "runtime selector");
    assertEqual(
      ocmTargetSelector({ kind: "local-build", value: "/tmp/openclaw", runtimeName: "kova-local-test" }),
      "--runtime 'kova-local-test'",
      "local-build selector"
    );
    assertEqual(ocmServiceStatusJson("Team Env"), "ocm service status 'Team Env' --json", "quoted service status");
    assertEqual(ocmLogs("Team Env", { tail: 25, raw: true }), "ocm logs 'Team Env' --tail '25' --raw", "quoted logs");
    assertEqual(ocmEnvDestroy("Team Env"), "ocm env destroy 'Team Env' --yes", "quoted env destroy");
    assertEqual(ocmAt("Team Env", ["status"]), "ocm @'Team Env' -- 'status'", "quoted at command");
    assertEqual(
      ocmEnvExec("Team Env", ["node", "support/script.mjs", "--name", "O'Hara"]),
      "ocm env exec 'Team Env' -- 'node' 'support/script.mjs' '--name' 'O'\\''Hara'",
      "quoted env exec args"
    );
    assertEqual(
      ocmEnvExecShell("Team Env", "printf '%s\\n' ok"),
      "ocm env exec 'Team Env' -- 'sh' '-lc' 'printf '\\''%s\\n'\\'' ok'",
      "quoted env exec shell"
    );
    assertEqual(
      ocmRuntimeBuildLocal("kova-local-test", "/tmp/Open Claw"),
      "ocm runtime build-local 'kova-local-test' --repo '/tmp/Open Claw' --force",
      "quoted local runtime build"
    );
    assertEqual(ocmRuntimeRemoveJson("kova-local-test"), "ocm runtime remove 'kova-local-test' --json", "quoted runtime remove");
    return {
      id: "ocm-command-builders",
      status: "PASS",
      command: "validate centralized OCM command builders",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "ocm-command-builders",
      status: "FAIL",
      command: "validate centralized OCM command builders",
      durationMs: 0,
      message: error.message
    };
  }
}

function envNameLengthCheck() {
  try {
    const name = envNameFor(
      "channel-model-turn-baseline",
      "mock-openai-provider",
      "kova-260521-001757-f3cb72"
    );
    assertEqual(name.startsWith("kova-channel-model-turn"), true, "env name keeps readable scenario prefix");
    if (name.length > maxOcmEnvNameLength()) {
      throw new Error(`env name length ${name.length} exceeds ${maxOcmEnvNameLength()}: ${name}`);
    }
    assertEqual(/^kova-[a-z0-9][a-z0-9-]*$/.test(name), true, "env name remains OCM safe");
    const repeatName = envNameFor(
      "channel-model-turn-baseline",
      "mock-openai-provider",
      "kova-260521-001757-f3cb72",
      { index: 2, total: 3 }
    );
    if (repeatName === name) {
      throw new Error("repeat env name must be distinct");
    }
    return {
      id: "env-name-length",
      status: "PASS",
      command: "validate generated OCM env names stay bounded",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "env-name-length",
      status: "FAIL",
      command: "validate generated OCM env names stay bounded",
      durationMs: 0,
      message: error.message
    };
  }
}

function evaluationViolationHelpersCheck() {
  try {
    const violations = [];
    checkDuration(violations, [{ command: "openclaw status", durationMs: 51 }], "statusMs", 50, (command) => command.includes("status"));
    checkEvidenceThreshold(violations, "media", "mediaDescribeMs", 101, 100, "Media describe");
    checkRoleThresholds(violations, { gateway: { peakRssMb: 901, maxCpuPercent: 41 } }, { gateway: { peakRssMb: 900, maxCpuPercent: 40 } });
    checkAggregateThreshold(violations, 201, "agentTurnP95Ms", 200);
    checkTurnThreshold(violations, { phaseId: "turn", preProviderMs: 301 }, "preProviderMs", 300, "pre-provider latency was 301ms");
    assertEqual(violations.length, 6, "violation helper count");
    assertEqual(violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"), true, "role RSS violation");
    assertEqual(violations.some((violation) => violation.phaseId === "turn"), true, "turn threshold violation");
    return {
      id: "evaluation-violation-helpers",
      status: "PASS",
      command: "validate evaluation violation helper contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "evaluation-violation-helpers",
      status: "FAIL",
      command: "validate evaluation violation helper contract",
      durationMs: 0,
      message: error.message
    };
  }
}

function localBuildTargetSetupResourceExclusionCheck() {
  try {
    const record = {
      scenario: "local-build-runtime-resources",
      status: "PASS",
      phases: [
        {
          id: "target-setup",
          measurementScope: "harness",
          results: [{
            command: "ocm runtime build-local kova-local-test --repo /tmp/openclaw --force",
            status: 0,
            durationMs: 60000,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 2500,
              maxCpuPercent: 350,
              role: "build-tooling"
            })
          }]
        },
        {
          id: "auth-prepare",
          measurementScope: "harness",
          results: [{
            command: "mock-ai-provider serve --providers openai",
            status: 0,
            durationMs: 500,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 1900,
              maxCpuPercent: 320,
              role: "mock-provider"
            })
          }]
        },
        {
          id: "scenario-command",
          measurementScope: "product",
          results: [{
            command: "ocm @kova-self-check -- status",
            status: 0,
            durationMs: 100,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 100,
              maxCpuPercent: 20,
              role: "gateway"
            })
          }, {
            command: "node support/kova-helper.mjs",
            status: 0,
            durationMs: 100,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 600,
              maxCpuPercent: 30,
              role: "command-tree"
            })
          }]
        },
        {
          id: "auth-cleanup",
          measurementScope: "cleanup",
          results: [{
            command: "kill $(cat mock/pid)",
            status: 0,
            durationMs: 50,
            resourceSamples: syntheticResourceSamples({
              peakRssMb: 1800,
              maxCpuPercent: 300,
              role: "mock-provider"
            })
          }]
        }
      ],
      finalMetrics: {
        service: { gatewayState: "disabled" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, { thresholds: { peakRssMb: 200 } }, {
      surface: { thresholds: {}, resourcePrimaryRole: "gateway" },
      targetPlan: { kind: "local-build" }
    });
    assertEqual(record.status, "PASS", "local-build target setup resources ignored status");
    assertEqual(record.measurements.peakRssMb, 100, "local-build target setup resources ignored RSS");
    assertEqual(record.measurements.resourcePeakTrackedRssMb, 600, "tracked product helper RSS retained separately");
    assertEqual(record.measurements.resourcePrimaryRole, "gateway", "primary resource role retained");
    assertEqual(record.measurements.resourceByRole.gateway.peakRssMb, 100, "scenario role RSS retained");
    assertEqual(record.measurements.resourceByRole["build-tooling"], undefined, "target setup role excluded");
    assertEqual(record.measurements.resourceByRole["mock-provider"], undefined, "harness auth resources excluded");
    assertEqual(record.measurements.measurementScopeSummary.harnessCommandCount, 2, "harness command count");
    assertEqual(record.measurements.measurementScopeSummary.cleanupCommandCount, 1, "cleanup command count");
    assertEqual(record.violations, undefined, "no-service local-build record has no gateway violation");
    return {
      id: "local-build-target-setup-resource-exclusion",
      status: "PASS",
      command: "evaluate local-build target setup resource exclusion",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "local-build-target-setup-resource-exclusion",
      status: "FAIL",
      command: "evaluate local-build target setup resource exclusion",
      durationMs: 0,
      message: error.message
    };
  }
}

function defaultGatewayResourceRoleCheck() {
  try {
    const record = {
      scenario: "gateway-default-rss",
      status: "PASS",
      phases: [{
        id: "scenario-command",
        measurementScope: "product",
        results: [{
          command: "ocm @kova-self-check -- status",
          status: 0,
          durationMs: 100,
          resourceSamples: {
            schemaVersion: "kova.resourceSamples.v1",
            sampleCount: 1,
            peakTotalRssMb: 650,
            maxTotalCpuPercent: 80,
            peakCommandTreeRssMb: 650,
            peakGatewayRssMb: 100,
            byRole: {
              gateway: { peakRssMb: 100, maxCpuPercent: 20, peakProcessCount: 1 },
              "command-tree": { peakRssMb: 650, maxCpuPercent: 80, peakProcessCount: 1 }
            },
            topRolesByRss: [
              { role: "command-tree", peakRssMb: 650, maxCpuPercent: 80 },
              { role: "gateway", peakRssMb: 100, maxCpuPercent: 20 }
            ],
            topRolesByCpu: [
              { role: "command-tree", peakRssMb: 650, maxCpuPercent: 80 },
              { role: "gateway", peakRssMb: 100, maxCpuPercent: 20 }
            ],
            topByRss: [],
            topByCpu: []
          }
        }]
      }],
      finalMetrics: {
        service: { gatewayState: "disabled" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, { thresholds: { peakRssMb: 200 } }, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    assertEqual(record.status, "PASS", "gateway RSS is default headline gate");
    assertEqual(record.measurements.peakRssMb, 100, "headline RSS defaults to gateway role");
    assertEqual(record.measurements.resourcePeakTrackedRssMb, 650, "tracked total RSS retained separately");
    assertEqual(record.measurements.resourcePrimaryRole, "gateway", "default resource primary role recorded");
    assertEqual(record.measurements.resourceGateKind, "role", "resource gate kind recorded");
    return {
      id: "default-gateway-resource-role",
      status: "PASS",
      command: "evaluate default gateway RSS resource contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "default-gateway-resource-role",
      status: "FAIL",
      command: "evaluate default gateway RSS resource contract",
      durationMs: 0,
      message: error.message
    };
  }
}

function compareRepeatAggregationCheck() {
  try {
    const baseline = syntheticPerformanceReport({
      runId: "baseline-repeat",
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "npm:2026.5.12",
      records: [
        syntheticPerformanceRecord(1, { peakRssMb: 1000 }),
        syntheticPerformanceRecord(2, { peakRssMb: 1100 }),
        syntheticPerformanceRecord(3, { peakRssMb: 1200 })
      ]
    });
    const current = syntheticPerformanceReport({
      runId: "current-repeat",
      platform: baseline.platform,
      target: "npm:2026.5.18",
      records: [
        syntheticPerformanceRecord(1, { peakRssMb: 900 }),
        syntheticPerformanceRecord(2, { peakRssMb: 1000 }),
        syntheticPerformanceRecord(3, {
          peakRssMb: 1350,
          resourcePeakTrackedRssMb: 1350
        })
      ]
    });
    baseline.records[0].status = "FAIL";
    baseline.records[0].violations = [{
      kind: "threshold",
      metric: "peakRssMb",
      expected: "<= 900",
      actual: 1000,
      message: "gateway peak RSS 1000 MB exceeded threshold 900 MB"
    }];
    current.records[2].status = "FAIL";
    current.records[2].violations = [{
      kind: "threshold",
      metric: "peakRssMb",
      expected: "<= 900",
      actual: 1350,
      message: "gateway peak RSS 1350 MB exceeded threshold 900 MB"
    }];
    const comparison = compareReports(baseline, current, { thresholds: { peakRssMb: 100 } });
    const scenario = comparison.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(scenario.metrics.peakRssMb.baseline, 1100, "repeat compare uses baseline median");
    assertEqual(scenario.metrics.peakRssMb.current, 1000, "repeat compare uses current median");
    assertEqual(scenario.metrics["peakRssMb.max"].baseline, 1200, "repeat compare tracks baseline max");
    assertEqual(scenario.metrics["peakRssMb.max"].current, 1350, "repeat compare tracks current max");
    assertEqual(scenario.regressions.some((regression) => regression.metric === "peakRssMb"), false, "improved median is not a regression");
    assertEqual(scenario.regressions.some((regression) => regression.metric === "peakRssMb.max"), true, "worse max is explicit max regression");
    assertEqual(comparison.findingChanges.new.length, 0, "same metric finding is not new just because value changed");
    assertEqual(comparison.findingChanges.resolved.length, 0, "same metric finding is not resolved just because value changed");
    return {
      id: "compare-repeat-aggregation",
      status: "PASS",
      command: "evaluate repeated-run compare aggregation",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-repeat-aggregation",
      status: "FAIL",
      command: "evaluate repeated-run compare aggregation",
      durationMs: 0,
      message: error.message
    };
  }
}

function compareMetricOrderingCheck() {
  try {
    const rows = scenarioMetricRows({
      scenario: "gateway-performance",
      state: "fresh",
      regressions: [
        { kind: "metric", metric: "postReadyHealthFailures.max", baseline: 0, current: 3, delta: 3, tolerance: 0 }
      ],
      metrics: {
        cpuPercentMax: { baseline: 100, current: 123, tolerance: 25 },
        "postReadyHealthFailures.max": { baseline: 0, current: 3, tolerance: 0 },
        modelsListMs: { baseline: 1034, current: 2496 },
        readinessHealthReadyMs: { baseline: 2342, current: 1859 },
        gatewayRestartCount: { baseline: 6, current: 6 }
      }
    }, { limit: Infinity });
    assertEqual(rows.map((row) => row.status).join(","), "OVER,WATCH,PASS,PASS", "compare rows sort by status class");
    assertEqual(rows.map((row) => row.id).join(","), "postReadyHealthFailures.max,modelsListMs,cpuPercentMax,readinessHealthReadyMs", "compare rows omit unchanged rows");
    assertEqual(rows.find((row) => row.id === "cpuPercentMax").threshold, 25, "within-tolerance metric retains tolerance");
    assertEqual(rows.find((row) => row.id === "cpuPercentMax").status, "PASS", "within-tolerance worse metric passes");
    assertEqual(rows.find((row) => row.id === "postReadyHealthFailures.max").absoluteDelta, 3, "zero-baseline count delta retained");
    return {
      id: "compare-metric-ordering",
      status: "PASS",
      command: "evaluate compare metric row ordering",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-metric-ordering",
      status: "FAIL",
      command: "evaluate compare metric row ordering",
      durationMs: 0,
      message: error.message
    };
  }
}

function compareGatewayRssDedupeCheck() {
  try {
    const baseline = syntheticPerformanceReport({
      runId: "baseline-gateway-rss",
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "npm:2026.5.12",
      records: [
        syntheticPerformanceRecord(1, {
          peakRssMb: 640,
          resourcePeakGatewayRssMb: 640,
          resourcePeakTrackedRssMb: 1100,
          resourcePrimaryRole: "gateway",
          resourceGateKind: "role"
        })
      ]
    });
    const current = syntheticPerformanceReport({
      runId: "current-gateway-rss",
      platform: baseline.platform,
      target: "npm:2026.5.18",
      records: [
        syntheticPerformanceRecord(1, {
          peakRssMb: 660,
          resourcePeakGatewayRssMb: 660,
          resourcePeakTrackedRssMb: 1200,
          resourcePrimaryRole: "gateway",
          resourceGateKind: "role"
        })
      ]
    });
    const comparison = compareReports(baseline, current, {
      thresholds: { peakRssMb: 100, resourcePeakGatewayRssMb: 100, resourcePeakTrackedRssMb: 100 }
    });
    const scenario = comparison.scenarios.find((item) => item.key === "fresh-install:fresh");
    assertEqual(Boolean(scenario.metrics.peakRssMb), true, "primary gateway rss retained");
    assertEqual(Boolean(scenario.metrics.resourcePeakGatewayRssMb), false, "duplicate role gateway rss hidden");
    assertEqual(Boolean(scenario.metrics.resourcePeakTrackedRssMb), true, "tracked total rss remains available");
    assertEqual(scenario.regressions.some((regression) => regression.metric === "resourcePeakGatewayRssMb"), false, "duplicate gateway rss threshold not evaluated");
    return {
      id: "compare-gateway-rss-dedupe",
      status: "PASS",
      command: "evaluate compare gateway RSS dedupe",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "compare-gateway-rss-dedupe",
      status: "FAIL",
      command: "evaluate compare gateway RSS dedupe",
      durationMs: 0,
      message: error.message
    };
  }
}

function fixtureAccountingRenderCheck() {
  try {
    const report = syntheticPerformanceReport({
      runId: "fixture-accounting-render",
      platform: { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" },
      target: "runtime:stable",
      records: [
        syntheticPerformanceRecord(1, { coldReadyMs: 100, peakRssMb: 100 })
      ]
    });
    report.records[0].state = { id: "large-memory-session", traits: ["session-state"] };
    report.records[0].stateFixtureAccounting = {
      schemaVersion: "kova.fixtureAccounting.v1",
      stateId: "large-memory-session",
      kind: "openclaw-session-state",
      files: [
        { id: "source-session-store", exists: true, shape: { kind: "openclaw-session-store", entryCount: 80 }, sizeBytes: 1024 },
        { id: "canonical-session-store", exists: true, shape: { kind: "openclaw-session-store", entryCount: 80 }, sizeBytes: 1024 },
        { id: "legacy-session-store", exists: true, shape: { kind: "openclaw-session-store", entryCount: 80 }, sizeBytes: 1024 },
        { id: "source-memory", exists: true, shape: { kind: "kova-memory-fixture", itemCount: 1200 }, sizeBytes: 2048 },
        { id: "canonical-memory", exists: true, shape: { kind: "kova-memory-fixture", itemCount: 1200 }, sizeBytes: 2048 },
        { id: "legacy-memory", exists: true, shape: { kind: "kova-memory-fixture", itemCount: 1200 }, sizeBytes: 2048 }
      ],
      findings: []
    };
    const rendered = renderAssessment(report, { full: true, color: "never" }, process.env, process.stdout);
    assertEqual(rendered.includes("Fixture Accounting"), true, "fixture accounting section rendered");
    assertEqual(rendered.includes("sessions:"), true, "session accounting line rendered");
    assertEqual(rendered.includes("store[80] source"), true, "source session store summarized");
    assertEqual(rendered.includes("store[80] canonical"), true, "canonical session store summarized");
    assertEqual(rendered.includes("store[80] legacy"), true, "legacy session store summarized");
    assertEqual(rendered.includes("memory:"), true, "memory accounting line rendered");
    assertEqual(rendered.includes("items[1200] source"), true, "source memory summarized");
    assertEqual(rendered.includes("items[1200] canonical"), true, "canonical memory summarized");
    assertEqual(rendered.includes("items[1200] legacy"), true, "legacy memory summarized");
    assertEqual(rendered.includes("sessionId"), false, "fixture payload keys not dumped");
    return {
      id: "fixture-accounting-render",
      status: "PASS",
      command: "render fixture accounting summary",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "fixture-accounting-render",
      status: "FAIL",
      command: "render fixture accounting summary",
      durationMs: 0,
      message: error.message
    };
  }
}

function statusFoundationCheck() {
  try {
    const record = {
      scenario: "upgrade-existing-user",
      surface: "upgrade-existing-user",
      title: "Existing OpenClaw User Upgrade",
      status: "INCOMPLETE",
      state: { id: "old-release-user" },
      likelyOwner: "Kova",
      incompleteReason: "post-upgrade auth/model snapshot was not collected",
      incompleteEvidence: ["post-auth-model-snapshot missing"],
      phases: [],
      measurements: {}
    };
    const report = {
      schemaVersion: "kova.report.v1",
      mode: "execution",
      target: "runtime:stable",
      records: [record],
      summary: summarizeRecords([record])
    };
    assertEqual(report.summary.statuses.INCOMPLETE, 1, "summary counts incomplete records");

    const summary = buildReportSummary(report);
    assertEqual(summary.decision.verdict, "INCOMPLETE", "report summary incomplete verdict");
    assertEqual(summary.decision.ok, false, "incomplete report summary is not ok");
    assertEqual(summary.decision.blockingFindingCount, 1, "incomplete finding blocks summary");
    assertEqual(summary.findings?.[0]?.severity, "incomplete", "incomplete finding severity");

    const behaviorFailRecord = {
      scenario: "channel-model-turn-baseline",
      surface: "channel",
      title: "Channel Model Turn Baseline",
      status: "FAIL",
      state: { id: "fresh" },
      likelyOwner: "OpenClaw",
      phases: [],
      measurements: {},
      violations: [{
        kind: "resource",
        metric: "resourceByRole.gateway.peakRssMb",
        message: "gateway peak RSS 881 MB exceeded threshold 700 MB"
      }, {
        kind: "channel",
        metric: "channelModelTurn.case.source-visible-delivery.media.message-tool-only",
        workflow: "source-visible-delivery",
        inventoryWorkflow: "source-visible-delivery",
        matrix: {
          content: "media",
          route: "direct",
          delivery: "message-tool-only-source-delivery",
          lifecycle: "success"
        },
        failedInvariant: "source-visible-delivery.media.message-tool-only:no-success-plus-extra-visible",
        atomCoverage: "workflow/source-visible-delivery, durable-final/media",
        userAction: "user asks OpenClaw to produce a media result and receives that result in the same chat",
        ownerArea: "OpenClaw",
        message: "channel model turn case source-visible-delivery.media.message-tool-only failed: observed duplicate final delivery (workflow source-visible-delivery; inventory source-visible-delivery; matrix media/direct/message-tool-only-source-delivery/success; invariant source-visible-delivery.media.message-tool-only:no-success-plus-extra-visible; atoms workflow/source-visible-delivery, durable-final/media)"
      }]
    };
    const behaviorFailSummary = buildReportSummary({
      schemaVersion: "kova.report.v1",
      mode: "execution",
      target: "local-build:/tmp/openclaw",
      records: [behaviorFailRecord],
      summary: summarizeRecords([behaviorFailRecord])
    });
    assertEqual(
      behaviorFailSummary.decision.reason,
      "channel model turn case source-visible-delivery.media.message-tool-only failed: observed duplicate final delivery (workflow source-visible-delivery; inventory source-visible-delivery; matrix media/direct/message-tool-only-source-delivery/success; invariant source-visible-delivery.media.message-tool-only:no-success-plus-extra-visible; atoms workflow/source-visible-delivery, durable-final/media)",
      "behavior failure is report headline before resource finding with workflow matrix context"
    );
    assertEqual(
      behaviorFailSummary.findings?.some((finding) =>
        finding.metric === "channelModelTurn.case.source-visible-delivery.media.message-tool-only" &&
        finding.ownerArea === "OpenClaw" &&
        finding.summary.includes("workflow source-visible-delivery") &&
        finding.summary.includes("matrix media/direct/message-tool-only-source-delivery/success") &&
        finding.summary.includes("durable-final/media")
      ),
      true,
      "channel model turn finding includes workflow matrix and atom context"
    );

    const gate = evaluateGate(report, {
      id: "release",
      purpose: "release",
      entries: [{ scenario: "upgrade-existing-user", state: "old-release-user" }]
    });
    assertEqual(gate.verdict, "BLOCKED", "incomplete record blocks release gate");
    assertEqual(gate.ok, false, "incomplete release gate is not ok");
    assertEqual(gate.complete, false, "incomplete release gate is incomplete");
    assertEqual(gate.cards?.[0]?.kind, "incomplete-proof", "incomplete record gate card kind");
    return {
      id: "status-foundation",
      status: "PASS",
      command: "evaluate INCOMPLETE status handling",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "status-foundation",
      status: "FAIL",
      command: "evaluate INCOMPLETE status handling",
      durationMs: 0,
      message: error.message
    };
  }
}

function evidenceLedgerGatingCheck() {
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

function channelCapabilityReportSummaryCheck() {
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

function channelCapabilityResultIngestionCheck() {
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

function channelDeclaredCapabilityProofRowsCheck() {
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

async function channelGeneratedMediaProviderScriptCheck() {
  try {
    const completionCaseId = "completion-handoff.image.generated-direct";
    const completionScript = channelWorkflowScript([completionCaseId], process.cwd());
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
    const sourceScript = channelWorkflowScript([sourceCaseId], process.cwd());
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

async function channelWorkflowResourceAttributionCheck(tmp) {
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
      resourceSampleLine(7000, 805, 120, 82)
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
            sampleCount: 4,
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
    assertEqual(resources?.topByGatewayRss?.[0]?.userAction, "user sends an image and asks OpenClaw to make a video from it", "user action is preserved with resource attribution");

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

function resourceSampleLine(elapsedMs, gatewayRssMb, commandRssMb, cpuPercent) {
  return JSON.stringify({
    timestamp: new Date(1700000000000 + elapsedMs).toISOString(),
    elapsedMs,
    processes: [{
      pid: 101,
      ppid: 1,
      rssMb: gatewayRssMb,
      cpuPercent,
      roles: ["gateway", "gateway-tree"],
      role: "gateway,gateway-tree",
      command: "openclaw gateway"
    }, {
      pid: 202,
      ppid: 1,
      rssMb: commandRssMb,
      cpuPercent: 1,
      roles: ["command-tree"],
      role: "command-tree",
      command: "node support/channel-conformance/run.mjs"
    }]
  });
}

function channelModelTurnMultiInvariantEvaluationCheck() {
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

function optionalDiagnosticGapCheck() {
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

function missingCollectorProofCheck() {
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

function syntheticUpgradeLogRecord({ results }) {
  return {
    scenario: "upgrade-existing-user",
    surface: "upgrade-existing-user",
    status: "PASS",
    phases: [{
      id: "post-upgrade",
      commands: results.map((result) => result.command),
      results
    }],
    finalMetrics: {
      service: { gatewayState: "running" }
    }
  };
}

function provisioningBlockedStatusCheck() {
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

function cleanupProofRequiredCheck() {
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

async function openClawStateSnapshotCheck(tmp) {
  const home = join(tmp, "snapshot-openclaw-home");
  try {
    await mkdir(join(home, "config"), { recursive: true });
    await mkdir(join(home, "plugins", "browser", "node_modules", "large-package"), { recursive: true });
    await writeFile(join(home, "config", "settings.json"), JSON.stringify({
      schemaVersion: "kova.fixture.settings.v1",
      provider: "openai",
      model: "gpt-5.5",
      authMethod: "env-var",
      workspaceRoot: "/Users/self-check/project",
      apiKey: "sk-kova-secret-value",
      nested: {
        refreshToken: "refresh-secret-value"
      }
    }, null, 2));
    await writeFile(join(home, "plugins", "installs.json"), JSON.stringify({
      schemaVersion: "kova.fixture.plugins.v1",
      plugins: [{ id: "browser", source: "bundled", enabled: true }]
    }, null, 2));
    await writeFile(join(home, "config", "version.json"), JSON.stringify({
      schemaVersion: "kova.fixture.old-release.v1",
      release: "2026.4.20",
      channel: "stable"
    }, null, 2));
    await writeFile(join(home, "plugins", "legacy-index.json"), JSON.stringify({
      plugins: ["browser"]
    }, null, 2));
    await writeFile(join(home, "plugins", "browser", "package.json"), JSON.stringify({
      name: "browser",
      version: "1.0.0"
    }, null, 2));
    await writeFile(join(home, "plugins", "browser", "node_modules", "large-package", "index.js"), "secret dependency content");
    await writeFile(join(home, "config", "models.json"), `${"x".repeat(1024)}\n`);

    const snapshot = await captureOpenClawStateSnapshot({
      home,
      label: "self-check",
      runtime: {
        targetKind: "local-build",
        targetValue: "/tmp/openclaw checkout",
        runtimeName: "kova-local-self-check"
      },
      service: {
        desired: "running",
        state: "running",
        pid: 1234,
        port: 4321,
        restartCount: 2,
        readiness: "ready"
      },
      cleanup: {
        expected: true,
        state: "planned",
        reason: "self-check"
      },
      limits: {
        maxFileBytes: 512
      }
    });
    const serialized = JSON.stringify(snapshot);
    assertEqual(snapshot.schemaVersion, "kova.openclawStateSnapshot.v1", "OpenClaw state snapshot schema");
    assertEqual(snapshot.home.present, true, "OpenClaw state snapshot home present");
    assertEqual(snapshot.budget.truncatedCount > 0, true, "OpenClaw state snapshot truncates large files");
    assertEqual(snapshot.redaction.secretKeyCount, 2, "OpenClaw state snapshot redacts secret keys");
    assertEqual(serialized.includes("sk-kova-secret-value"), false, "OpenClaw state snapshot does not include API key value");
    assertEqual(serialized.includes("refresh-secret-value"), false, "OpenClaw state snapshot does not include refresh token value");
    assertEqual(snapshot.plugins.installIndexes.length, 1, "OpenClaw state snapshot includes plugin install index");
    assertEqual(snapshot.files.some((file) => file.path === "config/version.json"), true, "OpenClaw state snapshot includes legacy version marker");
    assertEqual(snapshot.files.some((file) => file.path === "plugins/legacy-index.json"), true, "OpenClaw state snapshot includes legacy plugin index marker");
    assertEqual(snapshot.plugins.installed?.[0]?.id, "browser", "OpenClaw state snapshot summarizes installed plugin ids");
    assertEqual(snapshot.plugins.pluginDirs.some((plugin) => plugin.nodeModulesPresent), true, "OpenClaw state snapshot records node_modules presence");
    assertEqual(snapshot.files.some((file) => file.path.includes("node_modules")), false, "OpenClaw state snapshot excludes dependency trees");
    assertEqual(snapshot.runtime.targetKind, "local-build", "OpenClaw state snapshot runtime target kind");
    assertEqual(snapshot.runtime.targetValue, null, "OpenClaw state snapshot redacts local-build target path");
    assertEqual(typeof snapshot.runtime.targetValueHash, "string", "OpenClaw state snapshot hashes local-build target path");
    assertEqual(snapshot.service.state, "running", "OpenClaw state snapshot service state");
    assertEqual(snapshot.auth.providerIds.includes("openai"), true, "OpenClaw state snapshot auth provider shape");
    assertEqual(snapshot.auth.authMethodShapes.includes("env-var"), true, "OpenClaw state snapshot auth method shape");
    assertEqual(snapshot.models.modelIds.includes("gpt-5.5"), true, "OpenClaw state snapshot model shape");
    assertEqual(snapshot.workspace.allowedRootCount, 1, "OpenClaw state snapshot workspace boundary count");
    assertEqual(snapshot.cleanup.expected, true, "OpenClaw state snapshot cleanup expectation");

    return {
      id: "openclaw-state-snapshot",
      status: "PASS",
      command: "capture bounded redacted OpenClaw state snapshot",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "openclaw-state-snapshot",
      status: "FAIL",
      command: "capture bounded redacted OpenClaw state snapshot",
      durationMs: 0,
      message: error.message
    };
  }
}

async function doctorUpgradeSnapshotEvidenceCheck(tmp) {
  const home = join(tmp, "doctor-upgrade-snapshot-openclaw-home");
  const state = "legacy-channel-config-doctor-2026-5-7";
  try {
    const writeResult = await runCommand(
      `node support/write-doctor-upgrade-state.mjs --state ${quoteShell(state)}`,
      {
        env: { OPENCLAW_HOME: home },
        timeoutMs: 30000
      }
    );
    if (writeResult.status !== 0) {
      throw new Error(`doctor fixture writer failed: ${writeResult.stderr || writeResult.stdout}`);
    }

    const captureResult = await runCommand(
      `node support/capture-openclaw-state.mjs --home ${quoteShell(home)} --label doctor-fixture`,
      {
        timeoutMs: 30000,
        maxOutputChars: 200000
      }
    );
    if (captureResult.status !== 0) {
      throw new Error(`doctor fixture snapshot failed: ${captureResult.stderr || captureResult.stdout}`);
    }
    const snapshot = JSON.parse(captureResult.stdout);
    const files = new Set((snapshot.files ?? []).map((file) => file.path));
    assertEqual(files.has(".openclaw/openclaw.json"), true, "doctor fixture snapshot includes legacy OpenClaw config");
    assertEqual(files.has("config/kova-doctor-upgrade-evidence.json"), true, "doctor fixture snapshot includes Kova evidence marker");
    assertEqual(
      snapshot.config?.files?.includes("config/kova-doctor-upgrade-evidence.json"),
      true,
      "doctor fixture evidence marker is summarized as config"
    );

    return {
      id: "doctor-upgrade-snapshot-evidence",
      status: "PASS",
      command: "write doctor fixture and capture OpenClaw state snapshot",
      durationMs: writeResult.durationMs + captureResult.durationMs
    };
  } catch (error) {
    return {
      id: "doctor-upgrade-snapshot-evidence",
      status: "FAIL",
      command: "write doctor fixture and capture OpenClaw state snapshot",
      durationMs: 0,
      message: error.message
    };
  }
}

function upgradeStateSnapshotInvariantsCheck() {
  try {
    const baseSnapshot = {
      runtime: { targetKind: "local-build", targetValueHash: "runtime-hash" },
      service: { desired: "running", state: "running", readiness: "ready", pid: 100, restartCount: 1 },
      auth: { providerIds: ["openai"], authMethodShapes: ["env-var"] },
      models: { providerIds: ["openai"], modelIds: ["gpt-5.5"] },
      workspace: { rootHashes: ["workspace-hash"] },
      installedPluginIds: ["browser", "memory-core"],
      pluginInstallIndexCount: 1,
      pluginDirCount: 2
    };
    const record = upgradeSnapshotRecord({
      pre: baseSnapshot,
      post: {
        ...baseSnapshot,
        service: { desired: "running", state: "running", readiness: "ready", pid: 200, restartCount: 2 },
        pluginDirCount: 3
      }
    });
    const passing = buildUpgradeStateSnapshotInvariants(record);
    assertEqual(passing.every((invariant) => invariant.status === "passed"), true, "preserved upgrade state invariants pass");

    const failingRecord = upgradeSnapshotRecord({
      pre: baseSnapshot,
      post: {
        ...baseSnapshot,
        auth: { providerIds: [], authMethodShapes: [] },
        models: { providerIds: [], modelIds: [] },
        workspace: { rootHashes: [] },
        service: { desired: "running", state: "stopped", readiness: "not-ready", pid: 300, restartCount: 3 },
        installedPluginIds: ["browser"],
        pluginInstallIndexCount: 0,
        pluginDirCount: 1
      }
    });
    const failing = buildUpgradeStateSnapshotInvariants(failingRecord);
    const failedIds = failing.filter((invariant) => invariant.status === "failed").map((invariant) => invariant.id);
    for (const id of [
      "plugin-install-index-preserved",
      "plugin-directory-count-not-decreased",
      "provider-ids-preserved",
      "model-ids-preserved",
      "auth-method-shape-preserved",
      "installed-plugin-ids-preserved",
      "workspace-roots-preserved",
      "service-running-state-preserved",
      "service-readiness-preserved"
    ]) {
      assertEqual(failedIds.includes(id), true, `upgrade invariant ${id} fails on state loss`);
    }

    return {
      id: "upgrade-state-snapshot-invariants",
      status: "PASS",
      command: "evaluate upgrade state snapshot invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "upgrade-state-snapshot-invariants",
      status: "FAIL",
      command: "evaluate upgrade state snapshot invariants",
      durationMs: 0,
      message: error.message
    };
  }
}

function upgradeSnapshotRecord({ pre, post }) {
  return {
    status: "PASS",
    phases: [{
      id: "evidence-source-runtime-snapshots",
      results: [{
        evidenceId: "snapshot:pre-upgrade-state",
        evidenceArtifactPath: "/tmp/pre.json",
        snapshot: pre
      }]
    }, {
      id: "evidence-post-upgrade-snapshots",
      results: [{
        evidenceId: "snapshot:post-upgrade-state",
        evidenceArtifactPath: "/tmp/post.json",
        snapshot: post
      }]
    }]
  };
}

function upgradeLogDerivedInvariantsCheck() {
  try {
    const clean = buildUpgradeLogDerivedInvariants({
      status: "PASS",
      measurements: {
        missingDependencyErrors: 0,
        pluginLoadFailures: 0
      },
      phases: [{
        id: "post-upgrade",
        metrics: {
          collectors: [
            syntheticCollectorReceipt("logs", { artifacts: ["/tmp/kova/logs/gateway-tail.log"] })
          ],
          logs: {
            ...zeroLogMetrics(),
            commandStatus: 0,
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          }
        },
        results: [{
          command: "ocm @kova-self-check -- doctor --fix",
          status: 0,
          stdout: "doctor ok\n",
          stderr: ""
        }]
      }]
    });
    assertEqual(clean.every((invariant) => invariant.status === "passed"), true, "clean upgrade log invariants pass");

    const bad = buildUpgradeLogDerivedInvariants({
      status: "PASS",
      measurements: {
        missingDependencyErrors: 2,
        pluginLoadFailures: 1
      },
      phases: [{
        id: "post-upgrade",
        results: [{
          command: "ocm @kova-self-check -- doctor --fix",
          status: 0,
          stdout: "",
          stderr: ""
        }]
      }]
    });
    const byId = Object.fromEntries(bad.map((invariant) => [invariant.id, invariant]));
    assertEqual(byId["no-missing-runtime-dependency-errors"].status, "failed", "missing dependency invariant fails");
    assertEqual(byId["no-plugin-load-failures"].status, "failed", "plugin load invariant fails");
    assertEqual(byId["doctor-output-captured"].status, "missing", "missing doctor output is incomplete proof");

    return {
      id: "upgrade-log-derived-invariants",
      status: "PASS",
      command: "evaluate upgrade log-derived invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "upgrade-log-derived-invariants",
      status: "FAIL",
      command: "evaluate upgrade log-derived invariants",
      durationMs: 0,
      message: error.message
    };
  }
}

function syntheticResourceSamples({ peakRssMb, maxCpuPercent, role }) {
  return {
    sampleCount: 1,
    peakTotalRssMb: peakRssMb,
    maxTotalCpuPercent: maxCpuPercent,
    peakCommandTreeRssMb: peakRssMb,
    peakGatewayRssMb: role === "gateway" ? peakRssMb : 0,
    byRole: {
      [role]: {
        peakRssMb,
        maxCpuPercent,
        peakProcessCount: 1
      }
    },
    topRolesByRss: [{ role, peakRssMb, maxCpuPercent }],
    topRolesByCpu: [{ role, peakRssMb, maxCpuPercent }],
    topByRss: [],
    topByCpu: []
  };
}

function gatePartialFailureCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: ["scenario:release-runtime-startup"],
        exclude: []
      },
      records: [
        {
          scenario: "release-runtime-startup",
          state: { id: "fresh" },
          status: "FAIL",
          title: "Release Runtime Startup",
          likelyOwner: "OpenClaw",
          violations: [{ message: "gateway became healthy after 47100ms, beyond the 30000ms threshold" }],
          phases: []
        }
      ]
    }, {
      id: "release",
      gate: {
        id: "test-release-gate",
        blocking: [
          { scenario: "release-runtime-startup", state: "fresh" },
          { scenario: "fresh-install", state: "fresh" }
        ]
      }
    });

    assertEqual(gate.verdict, "DO_NOT_SHIP", "partial gate failure verdict");
    assertEqual(gate.partial, true, "partial gate marker");
    assertEqual(gate.complete, false, "partial gate completeness");
    assertEqual(gate.missingRequiredCount, 1, "partial gate missing count");
    assertEqual(gate.cards.some((card) => card.kind === "filtered-required-scenario"), true, "filtered required card");
    return {
      id: "gate-partial-failure-do-not-ship",
      status: "PASS",
      command: "evaluate synthetic partial release gate failure",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-partial-failure-do-not-ship",
      status: "FAIL",
      command: "evaluate synthetic partial release gate failure",
      durationMs: 0,
      message: error.message
    };
  }
}

function gatePartialPassCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: ["scenario:release-runtime-startup"],
        exclude: []
      },
      records: [
        {
          scenario: "release-runtime-startup",
          state: { id: "fresh" },
          status: "PASS",
          title: "Release Runtime Startup",
          likelyOwner: "OpenClaw",
          phases: []
        }
      ]
    }, {
      id: "release",
      gate: {
        id: "test-release-gate",
        blocking: [
          { scenario: "release-runtime-startup", state: "fresh" },
          { scenario: "fresh-install", state: "fresh" }
        ]
      }
    });

    assertEqual(gate.verdict, "PARTIAL", "partial gate pass verdict");
    assertEqual(gate.ok, false, "partial gate not ok");
    assertEqual(gate.complete, false, "partial gate completeness");
    assertEqual(gate.partial, true, "partial gate marker");
    return {
      id: "gate-partial-pass",
      status: "PASS",
      command: "evaluate synthetic partial release gate pass",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-partial-pass",
      status: "FAIL",
      command: "evaluate synthetic partial release gate pass",
      durationMs: 0,
      message: error.message
    };
  }
}

function gatePlatformCoverageCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: [],
        exclude: []
      },
      platform: {
        os: "darwin",
        arch: "arm64",
        release: "25.3.0",
        node: "v24.13.0"
      },
      records: [
        {
          scenario: "release-runtime-startup",
          state: { id: "fresh" },
          status: "PASS",
          title: "Release Runtime Startup",
          likelyOwner: "OpenClaw",
          phases: []
        }
      ]
    }, {
      id: "release",
      gate: {
        id: "test-release-gate",
        coverage: {
          platforms: {
            blocking: ["darwin-arm64"],
            warning: ["linux-x64"]
          }
        },
        blocking: [
          { scenario: "release-runtime-startup", state: "fresh" }
        ]
      }
    });

    assertEqual(gate.verdict, "SHIP", "current required platform coverage should pass");
    assertEqual(gate.outcome, "SHIP", "release gate outcome matches ship verdict");
    assertEqual(gate.complete, true, "platform-covered gate completeness");
    assertEqual(gate.cards.some((card) => card.coverage === "platform" && card.expected === "platform coverage darwin-arm64"), false, "darwin-arm64 should not be missing");
    assertEqual(gate.cards.some((card) => card.coverage === "platform" && card.expected === "platform coverage linux-x64" && card.severity === "warning"), true, "linux warning platform should remain visible");
    return {
      id: "gate-platform-coverage",
      status: "PASS",
      command: "evaluate synthetic release gate platform coverage",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-platform-coverage",
      status: "FAIL",
      command: "evaluate synthetic release gate platform coverage",
      durationMs: 0,
      message: error.message
    };
  }
}

function gateNonReleaseOutcomeCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: [],
        exclude: []
      },
      records: [
        {
          scenario: "gateway-performance",
          surface: "gateway-performance",
          state: { id: "many-bundled-plugins" },
          status: "PASS",
          title: "Gateway Performance",
          likelyOwner: "OpenClaw",
          phases: []
        }
      ]
    }, {
      id: "benchmark",
      purpose: "performance",
      gate: {
        id: "test-performance-gate",
        blocking: [
          { scenario: "gateway-performance", state: "many-bundled-plugins" }
        ]
      }
    });

    assertEqual(gate.verdict, "SHIP", "non-release gate keeps ship verdict");
    assertEqual(gate.outcome, "PASS", "non-release gate maps ship verdict to pass outcome");
    assertEqual(gate.purpose, "performance", "non-release gate purpose");
    return {
      id: "gate-non-release-outcome",
      status: "PASS",
      command: "evaluate synthetic non-release gate outcome",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-non-release-outcome",
      status: "FAIL",
      command: "evaluate synthetic non-release gate outcome",
      durationMs: 0,
      message: error.message
    };
  }
}

function gateRequirementCoverageCheck() {
  try {
    const profile = {
      id: "release",
      gate: {
        id: "test-release-gate",
        coverage: {
          requirements: {
            blocking: ["release-runtime-startup:baseline"],
            warning: ["fresh-install:baseline"]
          }
        },
        blocking: [
          { scenario: "release-runtime-startup", state: "fresh" }
        ]
      }
    };
    const report = {
      mode: "execution",
      controls: {
        include: [],
        exclude: []
      },
      records: [
        {
          scenario: "release-runtime-startup",
          surface: "release-runtime-startup",
          state: { id: "fresh" },
          status: "PASS",
          title: "Release Runtime Startup",
          likelyOwner: "OpenClaw",
          phases: []
        }
      ]
    };
    const gate = evaluateGate(report, profile, {
      resolvedCoverage: {
        obligations: [{
          surface: "release-runtime-startup",
          requirement: "baseline",
          scenario: "release-runtime-startup",
          state: "fresh",
          status: "planned"
        }]
      }
    });

    assertEqual(gate.verdict, "SHIP", "required requirement coverage should pass");
    assertEqual(gate.cards.some((card) => card.coverage === "requirement" && card.expected === "requirement coverage release-runtime-startup:baseline"), false, "covered requirement should not be missing");
    assertEqual(gate.cards.some((card) => card.coverage === "requirement" && card.expected === "requirement coverage fresh-install:baseline" && card.severity === "warning"), true, "missing warning requirement should remain visible");
    return {
      id: "gate-requirement-coverage",
      status: "PASS",
      command: "evaluate synthetic release gate requirement coverage",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-requirement-coverage",
      status: "FAIL",
      command: "evaluate synthetic release gate requirement coverage",
      durationMs: 0,
      message: error.message
    };
  }
}

async function doctorUpgradeGatePolicyCheck() {
  try {
    const profile = JSON.parse(await readFile("profiles/doctor-upgrade.json", "utf8"));
    const states = [
      "legacy-core-config-doctor-2026-4-24",
      "legacy-plugin-config-doctor-2026-5-22",
      "legacy-provider-config-doctor-2026-5-7",
      "legacy-channel-config-doctor-2026-5-7",
      "legacy-runtime-pin-doctor-2026-5-8"
    ];
    const records = states.map((state) => ({
      scenario: "doctor-repair-upgrade",
      surface: "upgrade-existing-user",
      state: { id: state },
      status: "PASS",
      title: "Doctor Repair Upgrade",
      likelyOwner: "OpenClaw",
      phases: []
    }));
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: [],
        exclude: []
      },
      records
    }, profile, {
      resolvedCoverage: {
        obligations: records.map((record) => ({
          surface: "upgrade-existing-user",
          requirement: "doctor-repair",
          scenario: record.scenario,
          state: record.state.id,
          status: "planned"
        }))
      }
    });

    assertEqual(gate.verdict, "SHIP", "doctor upgrade gate ships with all stateful records");
    assertEqual(gate.complete, true, "doctor upgrade gate complete");
    assertEqual(gate.missingRequiredCount, 0, "doctor upgrade gate no missing stateful records");
    assertEqual(gate.required?.length, states.length, "doctor upgrade gate requires every state");

    return {
      id: "doctor-upgrade-gate-policy",
      status: "PASS",
      command: "evaluate synthetic doctor upgrade stateful gate policy",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "doctor-upgrade-gate-policy",
      status: "FAIL",
      command: "evaluate synthetic doctor upgrade stateful gate policy",
      durationMs: 0,
      message: error.message
    };
  }
}

function gateSubsystemSummaryCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: [],
        exclude: []
      },
      records: [
        {
          scenario: "gateway-performance",
          state: { id: "many-bundled-plugins" },
          status: "FAIL",
          title: "Gateway Performance",
          likelyOwner: "gateway-runtime",
          violations: [{ message: "gateway RSS 1200 MB exceeded threshold 900 MB" }],
          phases: []
        },
        {
          scenario: "agent-provider-timeout",
          state: { id: "mock-openai-provider" },
          status: "FAIL",
          title: "Agent Provider Timeout",
          likelyOwner: "agent-runtime/provider",
          violations: [{ message: "provider timeout was not contained" }],
          phases: []
        }
      ]
    }, {
      id: "release",
      gate: {
        id: "test-release-gate",
        blocking: [
          { scenario: "gateway-performance", state: "many-bundled-plugins" },
          { scenario: "agent-provider-timeout", state: "mock-openai-provider" }
        ]
      }
    });

    assertEqual(gate.verdict, "DO_NOT_SHIP", "subsystem gate verdict");
    assertEqual(gate.subsystems?.length, 2, "subsystem count");
    assertEqual(gate.fixerSummaries?.length, 2, "fixer summary count");
    assertEqual(gate.fixerSummaries[0]?.fixerPrompt.includes("Use the JSON report card measurements"), true, "fixer prompt evidence guidance");
    return {
      id: "gate-subsystem-summary",
      status: "PASS",
      command: "evaluate synthetic gate subsystem summaries",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-subsystem-summary",
      status: "FAIL",
      command: "evaluate synthetic gate subsystem summaries",
      durationMs: 0,
      message: error.message
    };
  }
}

async function performanceBaselineCheck(tmp) {
  try {
    const platform = { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" };
    const targetPlan = { kind: "local-build", value: "/tmp/openclaw" };
    const baselineReport = syntheticPerformanceReport({
      runId: "baseline",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 400, cpuPercentMax: 20, eventLoopDelayMs: 100, agentTurnMs: 2000 }),
        syntheticPerformanceRecord(2, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1200 }), peakRssMb: 420, cpuPercentMax: 22, eventLoopDelayMs: 110, agentTurnMs: 2200 }),
        syntheticPerformanceRecord(3, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1100 }), peakRssMb: 410, cpuPercentMax: 21, eventLoopDelayMs: 105, agentTurnMs: 2100 })
      ]
    });
    baselineReport.performance = buildPerformanceSummary(baselineReport.records, { repeat: 3 });

    const baselinePath = join(tmp, "baselines.json");
    const unreviewed = reviewBaselineUpdate(baselineReport, { reviewedGood: false });
    assertEqual(unreviewed.ok, false, "baseline update requires review");
    assertEqual(unreviewed.blockers.some((blocker) => blocker.kind === "review-required"), true, "baseline review-required blocker");

    const failingReport = syntheticPerformanceReport({
      runId: "failing",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        {
          ...syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 400 }),
          status: "FAIL",
          violations: [{ message: "gateway readiness exceeded threshold" }]
        }
      ]
    });
    failingReport.performance = buildPerformanceSummary(failingReport.records, { repeat: 1 });
    const failingReview = reviewBaselineUpdate(failingReport, { reviewedGood: true });
    assertEqual(failingReview.ok, false, "failing report rejected for baseline");
    assertEqual(failingReview.blockers.some((blocker) => blocker.kind === "non-passing-records"), true, "non-passing blocker");

    const profiledReport = syntheticPerformanceReport({
      runId: "profiled",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        {
          ...syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1000 }), peakRssMb: 400 }),
          profiling: { enabled: true, interpretation: "instrumented run", baselineEligible: false }
        }
      ]
    });
    profiledReport.performance = buildPerformanceSummary(profiledReport.records, { repeat: 1 });
    const profiledReview = reviewBaselineUpdate(profiledReport, { reviewedGood: true });
    assertEqual(profiledReview.ok, false, "profiled report rejected for baseline");
    assertEqual(profiledReview.blockers.some((blocker) => blocker.kind === "profiled-run"), true, "profiled-run blocker");

    const savedStore = updateBaselineStore(await loadBaselineStore(baselinePath), baselineReport, { targetPlan, reviewedGood: true });
    await saveBaselineStore(baselinePath, savedStore);
    const loadedStore = await loadBaselineStore(baselinePath);
    assertEqual(Object.keys(loadedStore.entries).length, 1, "baseline entry count");
    assertEqual(
      Object.keys(loadedStore.entries)[0].includes("/tmp/openclaw"),
      true,
      "baseline key includes target value"
    );
    const otherTargetComparison = comparePerformanceToBaseline(baselineReport, loadedStore, {
      targetPlan: { kind: "local-build", value: "/tmp/other-openclaw" }
    });
    assertEqual(otherTargetComparison.missingBaselineCount, 1, "different target value misses baseline");

    const parallelReport = {
      ...baselineReport,
      controls: { parallel: 2 },
      performance: {
        ...baselineReport.performance,
        parallel: 2,
        parallelContaminated: true
      }
    };
    const parallelReview = reviewBaselineUpdate(parallelReport, { reviewedGood: true });
    assertEqual(parallelReview.ok, false, "parallel report rejected for baseline");
    assertEqual(parallelReview.blockers.some((blocker) => blocker.kind === "parallel-performance"), true, "parallel-performance blocker");

    const currentReport = syntheticPerformanceReport({
      runId: "current",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1800 }), peakRssMb: 500, cpuPercentMax: 30, eventLoopDelayMs: 180, agentTurnMs: 3000 }),
        syntheticPerformanceRecord(2, { health: syntheticHealthMeasurement({ healthReadyAtMs: 1900 }), peakRssMb: 510, cpuPercentMax: 31, eventLoopDelayMs: 190, agentTurnMs: 3100 }),
        syntheticPerformanceRecord(3, { health: syntheticHealthMeasurement({ healthReadyAtMs: 2000 }), peakRssMb: 520, cpuPercentMax: 32, eventLoopDelayMs: 200, agentTurnMs: 3200 })
      ]
    });
    currentReport.performance = buildPerformanceSummary(currentReport.records, { repeat: 3 });
    assertEqual(currentReport.performance.groups[0].metrics.readinessHealthReadyMs.median, 1900, "performance median");
    assertEqual(currentReport.performance.groups[0].metrics.readinessHealthReadyMs.p95, 1990, "performance p95");

    const comparison = comparePerformanceToBaseline(currentReport, loadedStore, {
      targetPlan,
      regressionThresholds: {
        startupRegressionPercent: 10,
        rssRegressionPercent: 10,
        cpuRegressionPercent: 10,
        eventLoopRegressionPercent: 10,
        agentLatencyRegressionPercent: 10
      }
    });
    assertEqual(comparison.ok, false, "baseline comparison regression");
    assertEqual(comparison.regressions.some((regression) => regression.metric === "readinessHealthReadyMs"), true, "startup regression present");
    const regressedReview = reviewBaselineUpdate({
      ...currentReport,
      baseline: { path: baselinePath, comparison }
    }, { reviewedGood: true });
    assertEqual(regressedReview.ok, false, "regressed current report rejected for baseline update");
    assertEqual(regressedReview.blockers.some((blocker) => blocker.kind === "baseline-regression"), true, "baseline-regression blocker");

    const gate = evaluateGate({
      mode: "execution",
      controls: {},
      platform,
      baseline: { path: baselinePath, comparison },
      records: currentReport.records
    }, {
      id: "perf-gate",
      gate: {
        id: "perf-gate",
        blocking: [{ scenario: "fresh-install", state: "fresh" }]
      }
    });
    assertEqual(gate.verdict, "DO_NOT_SHIP", "performance regression gate verdict");
    assertEqual(gate.baseline?.regressionCount, comparison.regressionCount, "gate baseline regression count");
    assertEqual(gate.baseline?.regressedGroups?.[0]?.scenario, "fresh-install", "gate baseline group scenario");
    assertEqual(gate.cards.some((card) => card.kind === "performance-regression"), true, "performance regression gate card");

    return {
      id: "performance-baseline-regression",
      status: "PASS",
      command: "evaluate synthetic repeat performance baseline",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "performance-baseline-regression",
      status: "FAIL",
      command: "evaluate synthetic repeat performance baseline",
      durationMs: 0,
      message: error.message
    };
  }
}

function syntheticPerformanceReport({ runId, platform, target, records }) {
  return {
    schemaVersion: "kova.report.v1",
    generatedAt: "2026-04-29T00:00:00.000Z",
    runId,
    mode: "execution",
    target,
    platform,
    records
  };
}

function syntheticPerformanceRecord(index, measurements) {
  return {
    scenario: "fresh-install",
    surface: "fresh-install",
    title: "Fresh Install",
    status: "PASS",
    target: "local-build:/tmp/openclaw",
    state: { id: "fresh", title: "Fresh" },
    repeat: { index, total: 3 },
    envName: `kova-fresh-install-r${index}`,
    measurements,
    phases: []
  };
}

function syntheticHealthMeasurement({ listeningReadyAtMs = null, healthReadyAtMs = null } = {}) {
  return {
    schemaVersion: "kova.health.v1",
    readiness: {
      phaseId: "start",
      listeningReadyAtMs,
      healthReadyAtMs,
      classification: "ready",
      severity: "pass",
      reason: "synthetic readiness",
      thresholdMs: 30000,
      deadlineMs: 90000,
      attempts: 1
    },
    startupSamples: emptySyntheticHealthSummary("startup-sample"),
    postReadySamples: emptySyntheticHealthSummary("post-ready"),
    unknownSamples: emptySyntheticHealthSummary("unknown"),
    final: {
      ...emptySyntheticHealthSummary("final"),
      gatewayState: "running",
      ok: true,
      healthOk: true
    },
    slowestSample: null
  };
}

function emptySyntheticHealthSummary(scope) {
  return {
    scope,
    count: 0,
    okCount: 0,
    failureCount: 0,
    minMs: null,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    slowestPhaseId: null
  };
}

async function gateDryRunCheck(tmp) {
  const command = `node bin/kova.mjs matrix run --profile release --target runtime:stable --include scenario:release-runtime-startup --gate --report-dir ${quoteShell(tmp)} --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status === 0) {
      throw new Error("gate dry-run should exit non-zero");
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.matrix.run.receipt.v1", "gate receipt schema");
    assertEqual(data.gate?.verdict, "BLOCKED", "gate dry-run verdict");
    assertEqual(data.gate?.ok, false, "gate dry-run ok");
    const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
    assertEqual(report.gate?.cards?.some((card) => card.kind === "not-executed"), true, "gate not-executed card");
    const summary = renderReportSummary(report, { structured: true });
    assertString(summary.failureBrief?.fixerPrompt, "failure brief fixer prompt");
    assertString(data.retainedGateArtifacts?.outputDir, "retained gate artifact dir");
    assertString(data.retainedGateArtifacts?.pasteSummaryPath, "retained paste summary path");
    const retained = JSON.parse(await readFile(`${data.retainedGateArtifacts.outputDir}/retained-artifacts.json`, "utf8"));
    assertEqual(retained.verdict, "BLOCKED", "retained artifact verdict");
    await rm(data.retainedGateArtifacts.outputDir, { recursive: true, force: true });
    return {
      id: "gate-dry-run-blocked",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "gate-dry-run-blocked",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function safetyGuardCheck() {
  try {
    assertSafeScenarioCommand("ocm start kova-safe-test --runtime stable --json", {}, "kova-safe-test");
    assertSafeScenarioCommand("ocm env clone 'Team Env' kova-safe-test --json", { sourceEnv: "Team Env" }, "kova-safe-test");
    const blockedCases = [
      "ocm env destroy Violet --yes",
      "ocm upgrade Violet --channel beta --json",
      "ocm @Violet -- status",
      "ocm env clone 'Team Env' Violet --json"
    ];
    let blocked = 0;
    for (const command of blockedCases) {
      try {
        assertSafeScenarioCommand(command, { sourceEnv: "Team Env" }, "kova-safe-test");
      } catch (error) {
        if (/refusing to mutate non-Kova/.test(error.message)) {
          blocked += 1;
        }
      }
    }
    assertEqual(blocked, blockedCases.length, "durable env mutation cases blocked");
    let wrongSourceBlocked = false;
    try {
      assertSafeScenarioCommand("ocm env clone Other kova-safe-test --json", { sourceEnv: "Team Env" }, "kova-safe-test");
    } catch (error) {
      wrongSourceBlocked = /refusing to mutate non-Kova/.test(error.message);
    }
    assertEqual(wrongSourceBlocked, true, "unexpected source env clone blocked");
    return {
      id: "durable-env-mutation-guard",
      status: "PASS",
      command: "evaluate synthetic command guard cases",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "durable-env-mutation-guard",
      status: "FAIL",
      command: "evaluate synthetic command guard cases",
      durationMs: 0,
      message: error.message
    };
  }
}

async function localBuildRuntimeCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin");
  const repoDir = join(tmp, "mock-openclaw repo");
  const reportDir = join(tmp, "local-build-cleanup-report");
  const ocmLog = join(tmp, "mock-ocm.log");
  const removeCount = join(tmp, "mock-runtime-remove-count");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local) echo '{"ok":true}'; exit 0 ;;
  runtime:remove)
    count=0
    if [ -f "$KOVA_MOCK_REMOVE_COUNT" ]; then count=$(cat "$KOVA_MOCK_REMOVE_COUNT"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$KOVA_MOCK_REMOVE_COUNT"
    if [ "$count" -lt 2 ]; then echo 'runtime busy shutting down' >&2; exit 1; fi
    echo '{"removed":true}'
    exit 0
    ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:exec) exit 0 ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*) echo 'ok'; exit 0 ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs run --target local-build:${quoteShell(repoDir)} --scenario fresh-install --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog,
      KOVA_MOCK_REMOVE_COUNT: removeCount
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.targetCleanup?.status, "removed", "local-build target cleanup status");
    assertEqual(report.targetCleanup?.result?.attempts?.length, 2, "local-build target cleanup retry attempts");
    if (!/runtime remove kova-local-\d+ --json/.test(log)) {
      throw new Error(`runtime remove was not called; log:\n${log}`);
    }
    return {
      id: "local-build-runtime-cleanup",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-runtime-cleanup",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function localBuildRuntimeAlreadyAbsentCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin-absent-runtime");
  const repoDir = join(tmp, "mock-openclaw failed build");
  const reportDir = join(tmp, "local-build-absent-cleanup-report");
  const ocmLog = join(tmp, "mock-ocm-absent.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local) echo 'dependency install failed' >&2; exit 1 ;;
  runtime:remove) echo 'ocm: runtime "kova-local-mock" does not exist' >&2; exit 1 ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:destroy) echo 'ocm: environment "kova-mock" does not exist' >&2; exit 1 ;;
esac
case "$1" in
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs run --target local-build:${quoteShell(repoDir)} --scenario fresh-install --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const summaryResult = await runCommand(`node bin/kova.mjs report summarize ${quoteShell(receipt.jsonPath)} --json`, {
      timeoutMs: 30000,
      maxOutputChars: 1000000
    });
    if (summaryResult.status !== 0) {
      throw new Error(summaryResult.stderr.trim() || summaryResult.stdout.trim() || `summary exit ${summaryResult.status}`);
    }
    const summary = JSON.parse(summaryResult.stdout);
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.summary?.statuses?.BLOCKED, 1, "failed local-build scenario status");
    assertEqual(report.records?.[0]?.cleanup, "already-absent", "already absent env cleanup status");
    assertEqual(report.targetCleanup?.status, "already-absent", "already absent local-build target cleanup status");
    assertEqual(summary.scenarios?.[0]?.failureReason, "dependency install failed", "summary failure reason");
    if (!/runtime remove kova-local-\d+ --json/.test(log)) {
      throw new Error(`runtime remove was not called after failed build; log:\n${log}`);
    }
    return {
      id: "local-build-runtime-already-absent-cleanup",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-runtime-already-absent-cleanup",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function cpuProfileParserCheck() {
  try {
    const summary = await summarizeCpuProfiles(["fixtures/diagnostics/sample.cpuprofile"], { limit: 3 });
    assertEqual(summary.profileCount, 1, "CPU profile count");
    assertEqual(summary.parseErrorCount, 0, "CPU profile parse errors");
    assertEqual(summary.topFunctions[0]?.functionName, "collectBundledPluginMetadata", "top CPU function");
    assertEqual(summary.topFunctions[0]?.selfMs, 7, "top CPU self ms");
    return {
      id: "cpu-profile-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/sample.cpuprofile",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "cpu-profile-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/sample.cpuprofile",
      durationMs: 0,
      message: error.message
    };
  }
}

async function heapProfileParserCheck() {
  try {
    const summary = await summarizeHeapProfiles(["fixtures/diagnostics/sample.heapprofile"], { limit: 3 });
    assertEqual(summary.profileCount, 1, "heap profile count");
    assertEqual(summary.parseErrorCount, 0, "heap profile parse errors");
    assertEqual(summary.topFunctions[0]?.functionName, "loadBundledPluginMetadata", "top heap function");
    assertEqual(summary.topFunctions[0]?.selfSizeMb, 7, "top heap size mb");
    return {
      id: "heap-profile-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/sample.heapprofile",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "heap-profile-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/sample.heapprofile",
      durationMs: 0,
      message: error.message
    };
  }
}

async function providerEvidenceParserCheck() {
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
      await readFile("fixtures/provider/mock-requests.jsonl", "utf8")
    ].join("\n");
    const evidence = parseProviderRequestLog(text);
    assertEqual(evidence.requestCount, 2, "provider request count");
    assertEqual(evidence.providerDurationMs, 6700, "provider duration includes first through last response");
    assertEqual(evidence.firstByteLatencyMs, 15, "first byte latency");
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

async function liveApiKeyExecutionCheck(tmp) {
  const home = join(tmp, "live-api-key-home");
  const reportDir = join(tmp, "live-api-key-report");
  const openclawHome = join(tmp, "live-api-key-openclaw-home");
  const binDir = join(tmp, "live-api-key-bin");
  const ocmLog = join(tmp, "live-api-key-ocm.log");
  const secret = "kova-live-secret-selfcheck";
  await mkdir(join(home, "credentials"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(home, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "api-key",
        envVars: ["OPENAI_API_KEY"],
        externalCli: null,
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(home, "credentials", "live.env"), `OPENAI_API_KEY=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(binDir, "ocm"), fakeOcmScript(), "utf8");
  await chmod(join(binDir, "ocm"), 0o755);

  const command = [
    `KOVA_HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${binDir}:${process.env.PATH}`)}`,
    `KOVA_FAKE_OPENCLAW_HOME=${quoteShell(openclawHome)}`,
    `KOVA_MOCK_OCM_LOG=${quoteShell(ocmLog)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --execute --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000, redactValues: [secret] });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const reportText = await readFile(receipt.jsonPath, "utf8");
    if (reportText.includes(secret)) {
      throw new Error("live API key leaked into JSON report");
    }
    const report = JSON.parse(reportText);
    const record = report.records?.[0];
    assertEqual(report.auth?.requestedMode, "live", "report requested live auth");
    assertEqual(report.auth?.live?.environmentDependent, true, "top-level live env-dependent flag");
    assertEqual(record?.auth?.mode, "live", "record live auth mode");
    assertEqual(record?.auth?.source, "api-key", "record live auth source");
    assertEqual(record?.auth?.setupKind, "openclaw-onboard", "record live setup kind");
    assertEqual(record?.auth?.environmentDependent, true, "record live env-dependent flag");
    assertEqual(record?.auth?.secretValues, "redacted", "record secret values redacted");
    assertEqual(record?.providerEvidence?.environmentDependent, true, "provider evidence live env-dependent flag");
    const config = JSON.parse(await readFile(join(openclawHome, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.openai?.apiKey?.id, "OPENAI_API_KEY", "OpenClaw live config env ref");
    const serializedConfig = JSON.stringify(config);
    if (serializedConfig.includes(secret)) {
      throw new Error("live API key leaked into OpenClaw config");
    }
    const statusResult = record.phases
      ?.flatMap((phase) => phase.results ?? [])
      ?.find((item) => item.command.includes(" -- status"));
    if (!statusResult || statusResult.stdout.includes(secret) || !statusResult.stdout.includes("[REDACTED]")) {
      throw new Error("live command env was not redacted in command output");
    }
    return {
      id: "live-api-key-execution",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-api-key-execution",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function liveExternalCliDryRunCheck(tmp) {
  const home = join(tmp, "live-external-cli-home");
  const kovaHome = join(tmp, "live-external-cli-kova-home");
  const fakeBin = join(tmp, "live-external-cli-bin");
  const reportDir = join(tmp, "live-external-cli-report");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(kovaHome, "credentials"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "{\"tokens\":{\"access_token\":\"redacted\"}}\n", "utf8");
  await writeFile(join(fakeBin, "codex"), "#!/bin/sh\necho codex-selfcheck\n", "utf8");
  await chmod(join(fakeBin, "codex"), 0o755);
  await writeFile(join(kovaHome, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "external-cli",
        envVars: [],
        externalCli: "codex",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(kovaHome, "credentials", "live.env"), "", { encoding: "utf8", mode: 0o600 });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const record = report.records?.[0];
    assertEqual(report.auth?.requestedMode, "live", "external cli requested live auth");
    assertEqual(report.auth?.live?.method, "external-cli", "external cli live method");
    assertEqual(report.auth?.live?.verification?.verified, true, "external cli verification");
    assertEqual(record?.auth?.mode, "live", "external cli record live mode");
    assertEqual(record?.auth?.source, "external-cli", "external cli record source");
    assertEqual(record?.auth?.externalCli, "codex", "external cli record name");
    assertEqual(record?.auth?.setupKind, "fixture-config-patch", "codex cli fixture setup kind");
    const authSetupCommand = record.phases
      ?.flatMap((phase) => phase.commands ?? [])
      ?.find((item) => item.includes("configure-openclaw-live-auth.mjs")) ?? "";
    if (!/'?--auth-method'?\s+'?external-cli'?/.test(authSetupCommand) || !/'?--external-cli'?\s+'?codex'?/.test(authSetupCommand)) {
      throw new Error(`external-cli auth setup command missing expected args: ${authSetupCommand}`);
    }
    return {
      id: "live-external-cli-dry-run",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-external-cli-dry-run",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function liveAnthropicExternalCliDryRunCheck(tmp) {
  const home = join(tmp, "live-anthropic-cli-home");
  const kovaHome = join(tmp, "live-anthropic-cli-kova-home");
  const fakeBin = join(tmp, "live-anthropic-cli-bin");
  const reportDir = join(tmp, "live-anthropic-cli-report");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(kovaHome, "credentials"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(home, ".claude", ".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"redacted\"}}\n", "utf8");
  await writeFile(join(fakeBin, "claude"), "#!/bin/sh\necho claude-selfcheck\n", "utf8");
  await chmod(join(fakeBin, "claude"), 0o755);
  await writeFile(join(kovaHome, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        id: "anthropic",
        method: "external-cli",
        envVars: [],
        externalCli: "claude",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(kovaHome, "credentials", "live.env"), "", { encoding: "utf8", mode: 0o600 });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const record = report.records?.[0];
    assertEqual(report.auth?.live?.method, "external-cli", "anthropic external cli live method");
    assertEqual(report.auth?.live?.externalCli, "claude", "anthropic external cli name");
    assertEqual(record?.auth?.mode, "live", "anthropic cli record live mode");
    assertEqual(record?.auth?.providerId, "anthropic", "anthropic cli provider");
    assertEqual(record?.auth?.setupKind, "openclaw-onboard", "anthropic cli onboard setup");
    const authSetupCommand = record.phases
      ?.flatMap((phase) => phase.commands ?? [])
      ?.find((item) => item.includes("onboard")) ?? "";
    if (!authSetupCommand.includes("--auth-choice") || !authSetupCommand.includes("anthropic-cli")) {
      throw new Error(`anthropic external-cli auth setup command missing OpenClaw onboard path: ${authSetupCommand}`);
    }
    return {
      id: "live-anthropic-external-cli-dry-run",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-anthropic-external-cli-dry-run",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function fakeOcmScript() {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:exec)
    env_name="$3"
    shift 4
    OPENCLAW_HOME="$KOVA_FAKE_OPENCLAW_HOME" "$@"
    exit $?
    ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*)
    env_name="$1"
    shift
    if [ "$1" = "--" ]; then shift; fi
    if [ "$1" = "onboard" ]; then
      mkdir -p "$KOVA_FAKE_OPENCLAW_HOME/.openclaw"
      case " $* " in
        *" --auth-choice openai-api-key "*)
          cat > "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" <<'JSON'
{"models":{"mode":"merge","providers":{"openai":{"apiKey":{"source":"env","provider":"default","id":"OPENAI_API_KEY"},"models":[{"id":"gpt-5.5","name":"gpt-5.5","api":"openai-responses"}]}}},"agents":{"defaults":{"model":{"primary":"openai/gpt-5.5"}}}}
JSON
          ;;
        *" --auth-choice apiKey "*)
          cat > "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" <<'JSON'
{"models":{"mode":"merge","providers":{"anthropic":{"apiKey":{"source":"env","provider":"default","id":"ANTHROPIC_API_KEY"},"models":[{"id":"claude-sonnet-4-5","name":"claude-sonnet-4-5"}]}}},"agents":{"defaults":{"model":{"primary":"anthropic/claude-sonnet-4-5"}}}}
JSON
          ;;
        *" --auth-choice anthropic-cli "*)
          cat > "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" <<'JSON'
{"agents":{"defaults":{"model":{"primary":"claude-cli/claude-sonnet-4-5"},"agentRuntime":{"id":"claude-cli","fallback":"none"}}}}
JSON
          ;;
      esac
      echo '{"ok":true}'
      exit 0
    fi
    echo "live command key=$OPENAI_API_KEY"
    exit 0
    ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`;
}

function agentTurnBreakdownCheck() {
  try {
    const normal = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1200,
      firstByteLatencyMs: 15,
      firstChunkLatencyMs: 18,
      lastProviderResponseAtEpochMs: 1600,
      finishedAtEpochMs: 2000,
      timelineSummary: {
        available: true,
        spanTotals: {
          "agent.prepare": { count: 1, totalDurationMs: 90, maxDurationMs: 90 },
          "models.catalog.gateway": { count: 1, totalDurationMs: 70, maxDurationMs: 70 },
          "channel.plugin.load": { count: 1, totalDurationMs: 25, maxDurationMs: 25 }
        },
        keySpans: {}
      }
    });
    assertEqual(normal.breakdown.buckets.preProviderOpenClawMs, 200, "normal pre-provider bucket");
    assertEqual(normal.breakdown.buckets.providerMs, 400, "normal provider bucket");
    assertEqual(normal.breakdown.buckets.postProviderMs, 400, "normal post-provider bucket");
    assertEqual(normal.breakdown.buckets.unknownMs, 15, "normal unattributed pre-provider bucket");
    assertEqual(normal.breakdown.provider.firstByteLatencyMs, 15, "normal first byte latency");
    assertEqual(normal.breakdown.sourceSpans.categories.modelCatalog.totalDurationMs, 70, "model catalog source span");

    const preProviderStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 62000,
      lastProviderResponseAtEpochMs: 62800,
      finishedAtEpochMs: 63000,
      timelineSummary: null
    });
    assertEqual(preProviderStall.breakdown.evidenceQuality, "outside-in-only", "pre-provider missing timeline quality");
    assertEqual(preProviderStall.breakdown.buckets.preProviderOpenClawMs, 61000, "pre-provider stall bucket");
    assertEqual(preProviderStall.breakdown.buckets.unknownMs, 61000, "pre-provider stall unknown");

    const providerStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 21500,
      finishedAtEpochMs: 22000,
      timelineSummary: null
    });
    assertEqual(providerStall.breakdown.buckets.providerMs, 20000, "provider stall bucket");
    assertEqual(providerStall.breakdown.buckets.unknownMs, 500, "provider stall unknown pre-provider");

    const cleanupStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 1800,
      finishedAtEpochMs: 77000,
      timelineSummary: {
        available: true,
        spanTotals: {
          "agent.cleanup": { count: 1, totalDurationMs: 74000, maxDurationMs: 74000 }
        },
        keySpans: {}
      }
    });
    assertEqual(cleanupStall.breakdown.buckets.cleanupMs, 74000, "cleanup stall bucket");
    assertEqual(cleanupStall.breakdown.sourceSpans.categories.agentCleanup.totalDurationMs, 74000, "cleanup source span");

    const missingTimeline = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 1800,
      finishedAtEpochMs: 1900,
      timelineSummary: { available: false, spanTotals: {}, keySpans: {} }
    });
    assertEqual(missingTimeline.breakdown.evidenceQuality, "outside-in-only", "missing timeline outside-in quality");
    assertEqual(missingTimeline.breakdown.buckets.unknownMs, 500, "missing timeline unknown");

    const record = {
      scenario: "agent-cold-warm-message",
      title: "Agent cold/warm message",
      status: "PASS",
      cleanup: "done",
      phases: [{
        id: "cold-agent-turn",
        title: "Cold agent turn",
        intent: "Synthetic self-check",
        commands: [normal.result.command],
        evidence: [],
        results: [{
          ...normal.result,
          status: 0,
          timedOut: false,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: ""
        }],
        metrics: {
          logs: zeroLogMetrics(),
          health: { ok: true },
          timeline: {
            available: true,
            eventCount: 3,
            parseErrorCount: 0,
            spanTotals: {
              "agent.prepare": { count: 1, totalDurationMs: 90, maxDurationMs: 90 },
              "models.catalog.gateway": { count: 1, totalDurationMs: 70, maxDurationMs: 70 }
            },
            keySpans: {}
          }
        }
      }],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [normal.request]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {}
    }, { surface: { thresholds: {} }, targetPlan: { kind: "local-build" } });
    assertEqual(record.measurements.agentTurnStats?.count, 1, "agent turn stats count");
    assertEqual(record.measurements.agentTurnP95Ms, 1000, "agent turn p95");
    assertEqual(record.measurements.agentPreProviderP95Ms, 200, "agent pre-provider p95");
    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-agent-turn-breakdown",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("breakdown:"), true, "markdown includes agent turn breakdown");
    assertEqual(rendered.includes("models.catalog.* 70ms"), true, "markdown includes source span evidence");
    assertEqual(rendered.includes("Agent turn stats:"), true, "markdown includes agent turn stats");
    assertEqual(
      summarizeAgentTurnBreakdownForMarkdown(normal.breakdown).includes("unknown 15ms"),
      true,
      "breakdown markdown helper includes unknown bucket"
    );

    const cleanupRecord = {
      scenario: "agent-cold-warm-message",
      title: "Agent cleanup stall",
      status: "PASS",
      cleanup: "done",
      phases: [{
        id: "cleanup-agent-turn",
        title: "Cleanup agent turn",
        intent: "Synthetic cleanup stall",
        commands: [cleanupStall.result.command],
        evidence: [],
        results: [{
          ...cleanupStall.result,
          status: 0,
          timedOut: false,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: ""
        }],
        metrics: {
          logs: zeroLogMetrics(),
          health: { ok: true },
          timeline: {
            available: true,
            eventCount: 1,
            parseErrorCount: 0,
            spanTotals: {
              "agent.cleanup": { count: 1, totalDurationMs: 74000, maxDurationMs: 74000 }
            },
            keySpans: {}
          }
        }
      }],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [cleanupStall.request]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(cleanupRecord, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentCleanupMs: 5000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "local-build" } });
    assertEqual(cleanupRecord.status, "FAIL", "cleanup stall should fail");
    assertEqual(cleanupRecord.measurements.agentCleanupMaxMs, 74000, "agent cleanup max measurement");
    assertEqual(cleanupRecord.measurements.agentCleanupDiagnosis.kind, "slow-agent-cleanup", "agent cleanup diagnosis");
    assertEqual(
      cleanupRecord.measurements.agentFailureFixerSummary.items.some((item) => item.kind === "slow-agent-cleanup"),
      true,
      "slow cleanup fixer evidence"
    );

    return {
      id: "agent-turn-breakdown",
      status: "PASS",
      command: "evaluate synthetic agent turn phase breakdowns",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-turn-breakdown",
      status: "FAIL",
      command: "evaluate synthetic agent turn phase breakdowns",
      durationMs: 0,
      message: error.message
    };
  }
}

function gatewaySessionHistoryTextExtractionCheck() {
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

function gatewaySessionTurnEvaluationCheck() {
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

function gatewaySessionEvidenceInvariantCheck() {
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

function releaseRuntimeStartupEvidenceInvariantCheck() {
  try {
    const record = {
      scenario: "release-runtime-startup",
      surface: "release-runtime-startup",
      status: "PASS",
      phases: [
        {
          id: "provision",
          results: [{
            command: "ocm start kova-release-startup --runtime stable --json",
            status: 0,
            durationMs: 1200,
            stdout: JSON.stringify({
              defaultRuntime: "stable",
              gatewayPort: 43111,
              serviceRequested: true,
              serviceStarted: true
            }),
            resourceSamples: syntheticReleaseStartupResourceSamples("/tmp/kova/resources/provision-1.jsonl")
          }],
          metrics: {
            service: {
              gatewayState: "running",
              gatewayPort: 43111,
              runtimeReleaseChannel: "stable",
              runtimeReleaseVersion: "2026.5.7"
            },
            readiness: {
              classification: {
                state: "ready",
                severity: "ok",
                reason: null
              },
              listeningReadyAtMs: 900,
              healthReadyAtMs: 1500,
              thresholdMs: 30000,
              deadlineMs: 120000,
              attempts: 2,
              healthAttempts: [
                { ok: false, durationMs: 5 },
                { ok: true, durationMs: 4 }
              ]
            }
          }
        },
        {
          id: "post-start",
          results: [
            { command: "ocm service status kova-release-startup --json", status: 0, durationMs: 50, stdout: "{\"gatewayState\":\"running\"}" },
            { command: "ocm @kova-release-startup -- status", status: 0, durationMs: 80, stdout: "OpenClaw ready\n" },
            { command: "ocm @kova-release-startup -- plugins list", status: 0, durationMs: 90, stdout: "core\n" }
          ],
          metrics: {
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 1,
              p50Ms: 1,
              p95Ms: 1,
              maxMs: 1
            },
            collectors: [
              { id: "service", status: "PASS", durationMs: 5 },
              { id: "logs", status: "PASS", durationMs: 5, artifactCount: 1 }
            ],
            logs: zeroLogMetrics()
          }
        },
        {
          id: "startup-logs",
          results: [{
            command: "ocm logs kova-release-startup --tail 400 --raw",
            status: 0,
            durationMs: 40,
            stdout: "gateway ready\nplugins loaded\n"
          }],
          metrics: {
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 1,
              p50Ms: 1,
              p95Ms: 1,
              maxMs: 1
            },
            collectors: [
              { id: "service", status: "PASS", durationMs: 5 },
              { id: "logs", status: "PASS", durationMs: 5, artifactCount: 1 }
            ],
            logs: {
              ...zeroLogMetrics(),
              commandStatus: 0,
              artifacts: ["/tmp/kova/logs/gateway-tail.log"]
            },
            timeline: {
              available: true,
              eventCount: 12,
              parseErrorCount: 0,
              artifacts: ["/tmp/kova/openclaw/timeline.jsonl"],
              keySpans: {
                "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
                "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
                "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
              },
              spanTotals: {
                "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
                "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
                "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
              },
              openSpanCount: 0,
              openSpans: [],
              runtimeDeps: {},
              eventLoop: {},
              providers: {},
              childProcesses: {}
            }
          }
        }
      ],
      finalMetrics: {
        service: {
          gatewayState: "running",
          gatewayPort: 43111,
          runtimeReleaseChannel: "stable",
          runtimeReleaseVersion: "2026.5.7"
        },
        health: { ok: true, durationMs: 1 },
        healthSummary: {
          count: 1,
          okCount: 1,
          failureCount: 0,
          minMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          maxMs: 1
        },
        logs: zeroLogMetrics(),
        timeline: {
          available: true,
          eventCount: 12,
          parseErrorCount: 0,
          artifacts: ["/tmp/kova/openclaw/timeline.jsonl"],
          keySpans: {
            "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
            "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
            "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
          },
          spanTotals: {
            "gateway.ready": { count: 1, totalDurationMs: 20, maxDurationMs: 20 },
            "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
            "plugins.load": { count: 1, totalDurationMs: 40, maxDurationMs: 40 }
          },
          openSpanCount: 0,
          openSpans: [],
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    const scenario = {
      id: "release-runtime-startup",
      surface: "release-runtime-startup",
      thresholds: {},
      phases: [
        { id: "provision", healthScope: "readiness" },
        { id: "post-start", healthScope: "post-ready" },
        { id: "startup-logs", healthScope: "post-ready" }
      ]
    };
    evaluateRecord(record, scenario, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        diagnostics: { expectedSpans: ["gateway.ready", "plugins.metadata.scan", "plugins.load"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const invariants = buildReleaseRuntimeStartupEvidenceInvariants(record, scenario);
    assertEqual(invariants.length, 9, "release runtime startup invariant count");
    assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "complete release startup evidence passes invariants");

    const collectorOnlyRecord = JSON.parse(JSON.stringify(record));
    collectorOnlyRecord.phases[1].results = collectorOnlyRecord.phases[1].results.filter((result) => !result.command.startsWith("ocm service status "));
    collectorOnlyRecord.phases[2].results = [];
    evaluateRecord(collectorOnlyRecord, scenario, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        diagnostics: { expectedSpans: ["gateway.ready", "plugins.metadata.scan", "plugins.load"] }
      },
      targetPlan: { kind: "runtime" }
    });
    const collectorOnlyInvariants = buildReleaseRuntimeStartupEvidenceInvariants(collectorOnlyRecord, scenario);
    const receiptsProof = collectorOnlyInvariants.find((invariant) => invariant.id === "release-runtime-command-receipts");
    const logsProof = collectorOnlyInvariants.find((invariant) => invariant.id === "release-runtime-startup-logs-captured");
    assertEqual(receiptsProof?.status, "passed", "release startup collector receipts can replace service/log commands");
    assertEqual(logsProof?.status, "passed", "release startup collector log artifact can replace log command");

    const missingTimelineRecord = JSON.parse(JSON.stringify(record));
    missingTimelineRecord.finalMetrics.timeline.available = false;
    missingTimelineRecord.finalMetrics.timeline.eventCount = 0;
    missingTimelineRecord.phases[2].metrics.timeline.available = false;
    missingTimelineRecord.phases[2].metrics.timeline.eventCount = 0;
    evaluateRecord(missingTimelineRecord, scenario, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingTimelineInvariants = buildReleaseRuntimeStartupEvidenceInvariants(missingTimelineRecord, scenario);
    const timelineProof = missingTimelineInvariants.find((invariant) => invariant.id === "release-runtime-diagnostic-timeline-proof");
    assertEqual(timelineProof?.status, "missing", "missing diagnostic timeline is an incomplete evidence obligation");

    const stoppedRecord = JSON.parse(JSON.stringify(record));
    stoppedRecord.finalMetrics.service.gatewayState = "stopped";
    evaluateRecord(stoppedRecord, scenario, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const stoppedInvariants = buildReleaseRuntimeStartupEvidenceInvariants(stoppedRecord, scenario);
    const healthProof = stoppedInvariants.find((invariant) => invariant.id === "release-runtime-readiness-health-proof");
    assertEqual(healthProof?.status, "failed", "stopped final gateway state is failed evidence, not a pass");

    return {
      id: "release-runtime-startup-evidence-invariants",
      status: "PASS",
      command: "evaluate release runtime startup evidence completeness invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "release-runtime-startup-evidence-invariants",
      status: "FAIL",
      command: "evaluate release runtime startup evidence completeness invariants",
      durationMs: 0,
      message: error.message
    };
  }
}

function officialPluginInstallEvidenceInvariantCheck() {
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

    const missingHelperRecord = syntheticOfficialPluginInstallRecord({ includeInstallHelper: false });
    evaluateRecord(missingHelperRecord, scenario, {
      surface: { thresholds: {}, diagnostics: { expectedSpans: [] } },
      targetPlan: { kind: "runtime" }
    });
    const missingHelperInvariants = buildOfficialPluginInstallEvidenceInvariants(missingHelperRecord, scenario);
    const installProof = missingHelperInvariants.find((invariant) => invariant.id === "official-plugin-install-proof");
    assertEqual(installProof?.status, "missing", "missing official plugin helper JSON is incomplete proof");

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

function agentCliLocalTurnEvidenceInvariantCheck() {
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

function syntheticAgentCliLocalTurnRecord({
  coldCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json",
  warmCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json"
} = {}) {
  return {
    scenario: "agent-cold-warm-message",
    surface: "agent-cli-local-turn",
    status: "PASS",
    auth: { mode: "mock", source: "mock", providerId: "openai" },
    phases: [
      {
        id: "provision",
        commands: ["ocm start kova --runtime stable --no-service --json"],
        results: [{
          command: "ocm start kova --runtime stable --no-service --json",
          status: 0,
          durationMs: 100,
          stdout: "{\"gatewayPort\":43111,\"serviceRequested\":false}"
        }],
        metrics: { service: { gatewayState: "disabled", gatewayPort: 43111 } }
      },
      {
        id: "cold-agent-turn",
        commands: [coldCommand],
        results: [{
          command: coldCommand,
          status: 0,
          timedOut: false,
          startedAt: "2026-05-15T10:00:01.000Z",
          startedAtEpochMs: 1778839201000,
          finishedAt: "2026-05-15T10:00:03.000Z",
          finishedAtEpochMs: 1778839203000,
          durationMs: 2000,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: "",
          resourceSamples: syntheticAgentCliResourceSamples("/tmp/kova/resources/cold-agent-turn-1.jsonl")
        }],
        metrics: {
          logs: zeroLogMetrics(),
          timeline: syntheticTimelineMetrics()
        }
      },
      {
        id: "warm-agent-turn",
        commands: [warmCommand],
        results: [{
          command: warmCommand,
          status: 0,
          timedOut: false,
          startedAt: "2026-05-15T10:00:10.000Z",
          startedAtEpochMs: 1778839210000,
          finishedAt: "2026-05-15T10:00:11.500Z",
          finishedAtEpochMs: 1778839211500,
          durationMs: 1500,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: "",
          resourceSamples: syntheticAgentCliResourceSamples("/tmp/kova/resources/warm-agent-turn-1.jsonl")
        }],
        metrics: {
          logs: zeroLogMetrics(),
          timeline: syntheticTimelineMetrics()
        }
      },
      {
        id: "post-agent-health",
        commands: ["ocm @kova -- status"],
        results: [{
          command: "ocm @kova -- status",
          status: 0,
          durationMs: 100,
          stdout: "OpenClaw env ok\n",
          resourceSamples: syntheticAgentCliResourceSamples("/tmp/kova/resources/post-agent-health-1.jsonl")
        }],
        metrics: {
          logs: {
            ...zeroLogMetrics(),
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          },
          timeline: syntheticTimelineMetrics()
        }
      }
    ],
    providerEvidence: {
      available: true,
      requestCount: 2,
      summaryPath: "/tmp/kova/provider/provider-evidence.json",
      artifacts: ["/tmp/kova/mock-openai/requests.jsonl", "/tmp/kova/provider/provider-evidence.json"],
      requests: [
        {
          requestId: "cold-provider",
          receivedAt: "2026-05-15T10:00:02.000Z",
          receivedAtEpochMs: 1778839202000,
          respondedAt: "2026-05-15T10:00:02.050Z",
          respondedAtEpochMs: 1778839202050,
          firstByteLatencyMs: 5,
          firstChunkLatencyMs: 5,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          statusClass: "2xx"
        },
        {
          requestId: "warm-provider",
          receivedAt: "2026-05-15T10:00:10.700Z",
          receivedAtEpochMs: 1778839210700,
          respondedAt: "2026-05-15T10:00:10.750Z",
          respondedAtEpochMs: 1778839210750,
          firstByteLatencyMs: 4,
          firstChunkLatencyMs: 4,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          statusClass: "2xx"
        }
      ]
    },
    finalMetrics: {
      service: { gatewayState: "disabled", gatewayPort: 43111 },
      health: { ok: false, durationMs: null },
      healthSummary: {
        count: 0,
        okCount: 0,
        failureCount: 0,
        minMs: null,
        p50Ms: null,
        p95Ms: null,
        maxMs: null
      },
      logs: zeroLogMetrics(),
      timeline: syntheticTimelineMetrics()
    }
  };
}

function syntheticAgentCliResourceSamples(artifactPath) {
  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: 1,
    artifactPath,
    peakTotalRssMb: 650,
    maxTotalCpuPercent: 80,
    peakCommandTreeRssMb: 650,
    peakGatewayRssMb: 0,
    byRole: {
      "agent-cli": {
        peakRssMb: 650,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "agent-process": {
        peakRssMb: 650,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "command-tree": {
        peakRssMb: 650,
        maxCpuPercent: 80,
        peakProcessCount: 1
      }
    },
    topRolesByRss: [{ role: "agent-cli", peakRssMb: 650, maxCpuPercent: 80 }],
    topRolesByCpu: [{ role: "agent-cli", peakRssMb: 650, maxCpuPercent: 80 }],
    topByRss: [],
    topByCpu: []
  };
}

function agentGatewayRpcTurnEvidenceInvariantCheck() {
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

function syntheticAgentGatewayRpcTurnRecord({
  turnCommand = "ocm @kova -- agent --agent main --session-id kova-agent-gateway-rpc --message hi --json"
} = {}) {
  return {
    scenario: "agent-gateway-rpc-turn",
    surface: "agent-gateway-rpc-turn",
    status: "PASS",
    auth: { mode: "mock", source: "mock", providerId: "openai" },
    phases: [
      {
        id: "provision",
        commands: ["ocm start kova --runtime stable --no-service --json"],
        results: [{
          command: "ocm start kova --runtime stable --no-service --json",
          status: 0,
          durationMs: 100,
          stdout: "{\"gatewayPort\":43111,\"serviceRequested\":false}"
        }],
        metrics: {
          service: { gatewayState: "disabled", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" }
        }
      },
      {
        id: "gateway-start",
        commands: [
          "ocm service install kova --json",
          "ocm service start kova --json"
        ],
        results: [
          {
            command: "ocm service install kova --json",
            status: 0,
            durationMs: 100,
            stdout: "{\"ok\":true}",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/gateway-start-1.jsonl")
          },
          {
            command: "ocm service start kova --json",
            status: 0,
            durationMs: 100,
            stdout: "{\"ok\":true}",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/gateway-start-2.jsonl")
          }
        ],
        metrics: {
          readiness: syntheticReadyReadiness(),
          healthSummary: syntheticHealthSummary(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
          logs: zeroLogMetrics(),
          timeline: {
            ...syntheticTimelineMetrics(),
            keySpans: {
              "gateway.ready": { count: 1, totalDurationMs: 120, maxDurationMs: 120 },
              "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
            },
            spanTotals: {
              "gateway.ready": { count: 1, totalDurationMs: 120, maxDurationMs: 120 },
              "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
            }
          }
        }
      },
      {
        id: "gateway-agent-turn",
        commands: [turnCommand],
        results: [{
          command: turnCommand,
          status: 0,
          timedOut: false,
          startedAt: "2026-05-15T10:00:10.000Z",
          startedAtEpochMs: 1778839210000,
          finishedAt: "2026-05-15T10:00:13.000Z",
          finishedAtEpochMs: 1778839213000,
          durationMs: 3000,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: "",
          resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/gateway-agent-turn-1.jsonl")
        }],
        metrics: {
          health: { ok: true, durationMs: 2 },
          healthSummary: syntheticHealthSummary(),
          logs: zeroLogMetrics(),
          timeline: syntheticTimelineMetrics()
        }
      },
      {
        id: "post-agent-health",
        commands: [
          "ocm @kova -- status",
          "ocm logs kova --tail 300 --raw"
        ],
        results: [
          {
            command: "ocm @kova -- status",
            status: 0,
            durationMs: 100,
            stdout: "OpenClaw env ok\n",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/post-agent-health-1.jsonl")
          },
          {
            command: "ocm logs kova --tail 300 --raw",
            status: 0,
            durationMs: 50,
            stdout: "gateway ready\nKOVA_AGENT_OK\n",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/post-agent-health-2.jsonl")
          }
        ],
        metrics: {
          readiness: syntheticReadyReadiness(),
          healthSummary: syntheticHealthSummary(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
          logs: {
            ...zeroLogMetrics(),
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          },
          timeline: syntheticTimelineMetrics()
        }
      }
    ],
    providerEvidence: {
      available: true,
      requestCount: 1,
      summaryPath: "/tmp/kova/provider/provider-evidence.json",
      artifacts: ["/tmp/kova/mock-openai/requests.jsonl", "/tmp/kova/provider/provider-evidence.json"],
      requests: [{
        requestId: "gateway-provider",
        receivedAt: "2026-05-15T10:00:12.000Z",
        receivedAtEpochMs: 1778839212000,
        respondedAt: "2026-05-15T10:00:12.050Z",
        respondedAtEpochMs: 1778839212050,
        firstByteLatencyMs: 5,
        firstChunkLatencyMs: 5,
        route: "/v1/responses",
        model: "gpt-5.5",
        status: 200,
        statusClass: "2xx"
      }]
    },
    finalMetrics: {
      service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
      health: { ok: true, durationMs: 1 },
      healthSummary: syntheticHealthSummary(),
      logs: zeroLogMetrics(),
      timeline: syntheticTimelineMetrics()
    }
  };
}

function syntheticAgentGatewayResourceSamples(artifactPath) {
  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: 1,
    artifactPath,
    peakTotalRssMb: 1000,
    maxTotalCpuPercent: 120,
    peakCommandTreeRssMb: 500,
    peakGatewayRssMb: 600,
    byRole: {
      gateway: {
        peakRssMb: 600,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "gateway-tree": {
        peakRssMb: 600,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "agent-cli": {
        peakRssMb: 500,
        maxCpuPercent: 120,
        peakProcessCount: 1
      },
      "agent-process": {
        peakRssMb: 500,
        maxCpuPercent: 120,
        peakProcessCount: 1
      },
      "command-tree": {
        peakRssMb: 500,
        maxCpuPercent: 120,
        peakProcessCount: 1
      }
    },
    topRolesByRss: [{ role: "gateway", peakRssMb: 600, maxCpuPercent: 80 }],
    topRolesByCpu: [{ role: "agent-cli", peakRssMb: 500, maxCpuPercent: 120 }],
    topByRss: [],
    topByCpu: []
  };
}

function syntheticOfficialPluginInstallRecord({ helperPayload = {}, includeInstallHelper = true } = {}) {
  const officialPayload = {
    schemaVersion: "kova.officialPluginInstall.v1",
    ok: true,
    pluginCount: 1,
    requiredPluginCount: 1,
    failedRequiredCount: 0,
    durationMs: 1200,
    installed: true,
    listed: true,
    registryRefreshed: true,
    securityBlocked: false,
    securityBlockCount: 0,
    securityEvidence: null,
    failureEvidence: [],
    artifactPath: "/tmp/kova/official-plugins.json",
    pluginResults: [{
      id: "discord",
      package: "@openclaw/discord",
      ok: true,
      required: true,
      installed: true,
      listed: true,
      registryRefreshed: true,
      securityBlocked: false
    }],
    commands: [
      { id: "install:discord", status: 0, durationMs: 500 },
      { id: "list:discord", status: 0, durationMs: 100 },
      { id: "registry-refresh:discord", status: 0, durationMs: 100 }
    ],
    ...helperPayload
  };
  officialPayload.ok = officialPayload.securityBlocked === true ? false : officialPayload.ok;
  officialPayload.securityBlockCount = officialPayload.securityBlocked === true
    ? Math.max(1, officialPayload.securityBlockCount ?? 1)
    : officialPayload.securityBlockCount;
  officialPayload.failedRequiredCount = officialPayload.securityBlocked === true
    ? Math.max(1, officialPayload.failedRequiredCount ?? 1)
    : officialPayload.failedRequiredCount;

  const installResults = includeInstallHelper
    ? [{
        command: "node support/run-official-plugin-install.mjs --env kova --state states/official-plugins.json --artifact-dir /tmp/kova --timeout-ms 120000",
        status: officialPayload.ok ? 0 : 1,
        durationMs: 1200,
        stdout: JSON.stringify(officialPayload),
        resourceSamples: syntheticReleaseStartupResourceSamples("/tmp/kova/resources/install-1.jsonl")
      }]
    : [];

  return {
    scenario: "official-plugin-install",
    surface: "official-plugin-install",
    status: "PASS",
    phases: [
      {
        id: "provision",
        results: [
          { command: "ocm start kova --runtime stable --json", status: 0, durationMs: 100, stdout: "{\"gatewayPort\":43111}" },
          { command: "ocm @kova -- plugins list", status: 0, durationMs: 100, stdout: "Plugins\n" }
        ],
        metrics: {
          readiness: syntheticReadyReadiness(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" }
        }
      },
      {
        id: "install",
        results: installResults,
        metrics: {
          healthSummary: syntheticHealthSummary(),
          logs: zeroLogMetrics()
        }
      },
      {
        id: "restart",
        results: [{
          command: "node support/ensure-gateway-running.mjs --env kova --artifact-dir /tmp/kova --timeout-ms 120000",
          status: 0,
          durationMs: 300,
          stdout: "{\"ok\":true,\"gatewayState\":\"running\"}"
        }],
        metrics: {
          readiness: syntheticReadyReadiness(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" }
        }
      },
      {
        id: "post-restart-verify",
        results: [
          { command: "ocm service status kova --json", status: 0, durationMs: 50, stdout: "{\"gatewayState\":\"running\"}" },
          { command: "ocm @kova -- plugins list", status: 0, durationMs: 100, stdout: "@openclaw/discord\n" },
          { command: "ocm logs kova --tail 400 --raw", status: 0, durationMs: 40, stdout: "plugins loaded\n" }
        ],
        metrics: {
          collectors: [
            syntheticCollectorReceipt("service"),
            syntheticCollectorReceipt("logs", { artifacts: ["/tmp/kova/logs/gateway-tail.log"] }),
            syntheticCollectorReceipt("timeline", { artifacts: ["/tmp/kova/openclaw/timeline.jsonl"] })
          ],
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
          healthSummary: syntheticHealthSummary(),
          logs: {
            ...zeroLogMetrics(),
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          },
          timeline: syntheticTimelineMetrics()
        }
      }
    ],
    finalMetrics: {
      service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
      health: { ok: true, durationMs: 1 },
      healthSummary: syntheticHealthSummary(),
      logs: zeroLogMetrics(),
      timeline: syntheticTimelineMetrics()
    }
  };
}

function syntheticCollectorReceipt(id, overrides = {}) {
  return {
    schemaVersion: "kova.collectorReceipt.v1",
    id,
    status: "PASS",
    durationMs: 1,
    commandStatus: 0,
    timedOut: false,
    artifactCount: overrides.artifacts?.length ?? 0,
    artifacts: overrides.artifacts ?? [],
    error: null,
    ...overrides
  };
}

function syntheticReadyReadiness() {
  return {
    classification: {
      state: "ready",
      severity: "pass",
      reason: "gateway became healthy within the readiness threshold"
    },
    listeningReadyAtMs: 100,
    healthReadyAtMs: 200,
    thresholdMs: 30000,
    deadlineMs: 120000,
    attempts: 2,
    healthAttempts: [
      { ok: false, durationMs: 5 },
      { ok: true, durationMs: 4 }
    ]
  };
}

function syntheticHealthSummary() {
  return {
    count: 1,
    okCount: 1,
    failureCount: 0,
    minMs: 1,
    p50Ms: 1,
    p95Ms: 1,
    maxMs: 1
  };
}

function syntheticTimelineMetrics() {
  return {
    available: true,
    eventCount: 4,
    parseErrorCount: 0,
    artifacts: ["/tmp/kova/openclaw/timeline.jsonl"],
    keySpans: {
      "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
    },
    spanTotals: {
      "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
    },
    openSpanCount: 0,
    openSpans: [],
    runtimeDeps: {},
    eventLoop: {},
    providers: {},
    childProcesses: {}
  };
}

function syntheticReleaseStartupResourceSamples(artifactPath) {
  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: 1,
    artifactPath,
    peakTotalRssMb: 500,
    maxTotalCpuPercent: 60,
    peakCommandTreeRssMb: 20,
    peakGatewayRssMb: 480,
    byRole: {
      gateway: {
        peakRssMb: 480,
        maxCpuPercent: 60,
        peakProcessCount: 1
      },
      "command-tree": {
        peakRssMb: 20,
        maxCpuPercent: 5,
        peakProcessCount: 1
      }
    },
    trend: {
      available: true,
      sampleCount: 1,
      totalRssGrowthMb: 0,
      gatewayRssGrowthMb: 0
    },
    peakRssSample: {
      elapsedMs: 1000,
      totalRssMb: 500,
      topProcess: { pid: 123, role: "gateway", roles: ["gateway"], rssMb: 480, cpuPercent: 60, command: "openclaw gateway" }
    },
    peakCpuSample: {
      elapsedMs: 1000,
      totalCpuPercent: 60,
      topProcess: { pid: 123, role: "gateway", roles: ["gateway"], rssMb: 480, cpuPercent: 60, command: "openclaw gateway" }
    },
    topByRss: [],
    topByCpu: []
  };
}

function gatewaySessionPreProviderAttributionCheck() {
  try {
    const base = 1777536000000;
    const timelineText = [
      timelineEvent({ type: "span.start", name: "gateway.chat_send.load_session", timestamp: base + 1010, spanId: "cold-load" }),
      timelineEvent({ type: "span.end", name: "gateway.chat_send.load_session", timestamp: base + 1070, spanId: "cold-load", durationMs: 60 }),
      timelineEvent({ type: "span.start", name: "auto_reply.finalize_context", timestamp: base + 1060, spanId: "cold-finalize" }),
      timelineEvent({ type: "span.end", name: "auto_reply.finalize_context", timestamp: base + 1160, spanId: "cold-finalize", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "reply.ensure_workspace", timestamp: base + 1180, spanId: "cold-workspace" }),
      timelineEvent({ type: "span.error", name: "reply.ensure_workspace", timestamp: base + 1230, spanId: "cold-workspace", durationMs: 50, errorName: "SyntheticError" }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 1150, spanId: "cold-scan", durationMs: 33, phase: "startup" }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 1175, spanId: "cold-scan-gap", durationMs: 10, phase: "agent-turn" }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 1200, receivedAtEpochMs: base + 1200, respondedAtEpochMs: base + 1800, durationMs: 600 }),
      timelineEvent({ type: "eventLoop.sample", name: "eventLoop.sample", timestamp: base + 1250, maxMs: 9 }),
      timelineEvent({ type: "span.start", name: "gateway.chat_send.dispatch_inbound", timestamp: base + 11025, spanId: "warm-dispatch" }),
      timelineEvent({ type: "span.end", name: "gateway.chat_send.dispatch_inbound", timestamp: base + 11125, spanId: "warm-dispatch", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "reply.load_runtime_plugins", timestamp: base + 11120, spanId: "warm-plugins" }),
      timelineEvent({ type: "span.end", name: "reply.load_runtime_plugins", timestamp: base + 11220, spanId: "warm-plugins", durationMs: 100 }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 11100, spanId: "warm-scan", durationMs: 11, phase: "agent-turn" }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 11250, receivedAtEpochMs: base + 11250, respondedAtEpochMs: base + 11600, durationMs: 350 }),
      timelineEvent({ type: "eventLoop.sample", name: "eventLoop.sample", timestamp: base + 11200, maxMs: 7 })
    ].join("\n");
    const parsed = parseTimelineText(timelineText);
    assertEqual(parsed.turnAttributionEvents.length, 17, "turn attribution events retained");
    const parsedIntervals = attributedSpanIntervals(parsed.turnAttributionEvents);
    assertEqual(parsedIntervals.length, 8, "span parser includes error terminal and metadata scans");
    assertEqual(parsedIntervals.some((span) => span.type === "span.error" && span.name === "reply.ensure_workspace"), true, "span error included");

    const coldAttribution = buildGatewaySessionPreProviderAttribution({
      label: "cold",
      phaseId: "cold-gateway-session-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 2500,
      attribution: {
        firstProviderRequestAtEpochMs: base + 1200,
        preProviderMs: 200,
        providerFinalMs: 600,
        firstByteLatencyMs: 25,
        firstChunkLatencyMs: 30
      },
      timelineSummary: {
        available: true,
        turnAttributionEvents: parsed.turnAttributionEvents,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    });
    assertEqual(coldAttribution.available, true, "cold attribution available");
    assertEqual(coldAttribution.knownAttributedMs, 180, "overlap-safe cold known attribution includes active-turn metadata scan");
    assertEqual(coldAttribution.unattributedMs, 20, "cold unattributed remainder");
    const coldScanSummary = coldAttribution.spanSummaries.find((span) => span.name === "plugins.metadata.scan");
    assertEqual(coldScanSummary?.count, 2, "gateway session attribution includes active-turn metadata scans");
    assertEqual(coldScanSummary?.phases?.some((phase) => phase.phase === "startup"), true, "startup phase scan inside active window is counted");
    assertEqual(coldScanSummary?.phases?.some((phase) => phase.phase === "agent-turn"), true, "agent-turn phase scan inside active window is counted");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "reply.ensure_workspace")?.errorCount, 1, "error span summary");
    assertEqual(coldAttribution.provider.totalDurationMs, 600, "provider duration stays separate");
    assertEqual(coldAttribution.timelineArtifacts[0], "/tmp/kova/openclaw/timeline.jsonl", "timeline artifact path");

    const missingAttribution = buildGatewaySessionPreProviderAttribution({
      label: "cold",
      phaseId: "cold-gateway-session-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 2500,
      attribution: { firstProviderRequestAtEpochMs: base + 1200, preProviderMs: 200 },
      timelineSummary: { available: false, artifacts: [] }
    });
    assertEqual(missingAttribution.available, false, "missing timeline unavailable");
    assertEqual(missingAttribution.unattributedMs, 200, "missing timeline preserves full remainder");

    const record = syntheticGatewaySessionRecord({ base, timeline: parsed });
    evaluateRecord(record, {
      id: "gateway-session-send-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentTurnMs: 2000, coldAgentTurnMs: 2000, warmAgentTurnMs: 1000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    assertEqual(record.measurements.coldPreProviderAttributedMs, 180, "record cold attributed metric");
    assertEqual(record.measurements.warmPreProviderAttributedMs, 195, "record warm attributed metric");
    assertEqual(record.measurements.warmPreProviderUnattributedMs, 55, "record warm unattributed metric");
    assertEqual(record.measurements.gatewaySessionPreProviderAttribution.timelineArtifacts[0], "/tmp/kova/openclaw/timeline.jsonl", "record timeline artifact");

    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-gateway-session-pre-provider",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("Gateway session pre-provider attribution:"), true, "markdown includes gateway session attribution table");
    assertEqual(rendered.includes("Spans are selected by active turn timestamp window"), true, "markdown describes timestamp-window attribution");
    assertEqual(rendered.includes("`agent-turn`"), true, "markdown includes metadata scan phase as descriptive context");
    assertEqual(rendered.includes("`reply.ensure_workspace`"), true, "markdown includes span table");

    return {
      id: "gateway-session-pre-provider-attribution",
      status: "PASS",
      command: "evaluate synthetic Gateway session pre-provider timeline attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-pre-provider-attribution",
      status: "FAIL",
      command: "evaluate synthetic Gateway session pre-provider timeline attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

function agentCliPreProviderAttributionCheck() {
  try {
    const base = 1777536000000;
    const timelineText = [
      timelineEvent({ type: "span.start", name: "agent.turn", timestamp: base + 1000, spanId: "cold-turn" }),
      timelineEvent({ type: "span.start", name: "agent.prepare", timestamp: base + 1020, spanId: "cold-prepare" }),
      timelineEvent({ type: "span.end", name: "agent.prepare", timestamp: base + 1120, spanId: "cold-prepare", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "models.catalog.gateway", timestamp: base + 1080, spanId: "cold-models" }),
      timelineEvent({ type: "span.end", name: "models.catalog.gateway", timestamp: base + 1180, spanId: "cold-models", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "channel.plugin.load", timestamp: base + 1150, spanId: "cold-channel" }),
      timelineEvent({ type: "span.error", name: "channel.plugin.load", timestamp: base + 1170, spanId: "cold-channel", durationMs: 20, errorName: "SyntheticError" }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 1190, spanId: "cold-scan", durationMs: 30 }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 1200, receivedAtEpochMs: base + 1200, respondedAtEpochMs: base + 1700, durationMs: 500 }),
      timelineEvent({ type: "span.end", name: "agent.turn", timestamp: base + 1900, spanId: "cold-turn", durationMs: 900 }),
      timelineEvent({ type: "span.start", name: "runtimeDeps.stage", timestamp: base + 11020, spanId: "warm-runtime" }),
      timelineEvent({ type: "span.end", name: "runtimeDeps.stage", timestamp: base + 11070, spanId: "warm-runtime", durationMs: 50 }),
      timelineEvent({ type: "span.start", name: "channel.capabilities", timestamp: base + 11080, spanId: "warm-channel" }),
      timelineEvent({ type: "span.end", name: "channel.capabilities", timestamp: base + 11110, spanId: "warm-channel", durationMs: 30 }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 11200, receivedAtEpochMs: base + 11200, respondedAtEpochMs: base + 11500, durationMs: 300 }),
      timelineEvent({ type: "eventLoop.sample", name: "eventLoop.sample", timestamp: base + 11250, maxMs: 6 })
    ].join("\n");
    const parsed = parseTimelineText(timelineText);
    assertEqual(parsed.turnAttributionEvents.length, 16, "agent CLI turn attribution events retained");

    const coldAttribution = buildAgentCliPreProviderAttribution({
      label: "cold",
      phaseId: "cold-agent-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 1900,
      attribution: {
        firstProviderRequestAtEpochMs: base + 1200,
        preProviderMs: 200,
        providerFinalMs: 500
      },
      timelineSummary: {
        available: true,
        turnAttributionEvents: parsed.turnAttributionEvents,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    });
    assertEqual(coldAttribution.available, true, "agent CLI cold attribution available");
    assertEqual(coldAttribution.knownAttributedMs, 170, "agent CLI overlap-safe cold known attribution");
    assertEqual(coldAttribution.unattributedMs, 30, "agent CLI cold unattributed remainder");
    assertEqual(coldAttribution.spanSummaries.some((span) => span.name === "agent.turn"), false, "agent.turn parent span is not counted as pre-provider work");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "channel.plugin.load")?.errorCount, 1, "agent CLI error span summary");

    const missingAttribution = buildAgentCliPreProviderAttribution({
      label: "cold",
      phaseId: "cold-agent-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 1900,
      attribution: { firstProviderRequestAtEpochMs: base + 1200, preProviderMs: 200 },
      timelineSummary: { available: false, artifacts: [] }
    });
    assertEqual(missingAttribution.available, false, "agent CLI missing timeline unavailable");
    assertEqual(missingAttribution.unattributedMs, 200, "agent CLI missing timeline preserves full remainder");

    const record = syntheticAgentCliRecord({ base, timeline: parsed });
    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentTurnMs: 2000, coldAgentTurnMs: 2000, warmAgentTurnMs: 1000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    assertEqual(record.measurements.agentCliPreProviderAttribution.count, 2, "record agent CLI attribution count");
    assertEqual(record.measurements.gatewaySessionPreProviderAttribution.count, 0, "record gateway session attribution stays empty for CLI turns");
    assertEqual(record.measurements.coldPreProviderAttributedMs, 170, "record agent CLI cold attributed metric");
    assertEqual(record.measurements.warmPreProviderAttributedMs, 80, "record agent CLI warm attributed metric");
    assertEqual(record.measurements.warmPreProviderUnattributedMs, 120, "record agent CLI warm unattributed metric");
    assertEqual(record.measurements.agentTurns[0].agentCliPreProviderAttribution.timelineArtifacts[0], "/tmp/kova/openclaw/timeline.jsonl", "record agent CLI timeline artifact");

    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-agent-cli-pre-provider",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("Agent CLI pre-provider attribution:"), true, "markdown includes agent CLI attribution table");
    assertEqual(rendered.includes("`channel.plugin.load`"), true, "markdown includes agent CLI span table");

    return {
      id: "agent-cli-pre-provider-attribution",
      status: "PASS",
      command: "evaluate synthetic agent CLI pre-provider timeline attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cli-pre-provider-attribution",
      status: "FAIL",
      command: "evaluate synthetic agent CLI pre-provider timeline attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

function timelineEvent(event) {
  const timestamp = typeof event.timestamp === "number" ? new Date(event.timestamp).toISOString() : event.timestamp;
  return JSON.stringify({
    schemaVersion: "openclaw.diagnostics.v1",
    ...event,
    timestamp
  });
}

function syntheticGatewaySessionRecord({ base, timeline }) {
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
    ...coldPayload,
    createSession: false,
    minAssistantCount: 2,
    runId: "warm-run",
    activeStartedAtEpochMs: base + 11000,
    activeFinishedAtEpochMs: base + 11800,
    activeTurnMs: 800,
    sendStartedAtEpochMs: base + 11000,
    sendFinishedAtEpochMs: base + 11050,
    sendDurationMs: 50,
    assistantFirstSeenAtEpochMs: base + 11600,
    assistantMatchedAtEpochMs: base + 11800,
    timeToFirstAssistantMs: 600,
    timeToMatchedAssistantMs: 800,
    historyPollCount: 2,
    assistantMessageCount: 2
  };
  return {
    scenario: "gateway-session-send-turn",
    surface: "gateway-session-send-turn",
    title: "Gateway session cold/warm",
    status: "PASS",
    cleanup: "done",
    auth: { mode: "mock" },
    phases: [
      syntheticGatewayTurnPhase({
        id: "cold-gateway-session-turn",
        command: "node support/run-gateway-session-send-turn.mjs --create-session true",
        startedAtEpochMs: base,
        finishedAtEpochMs: base + 5000,
        payload: coldPayload
      }),
      syntheticGatewayTurnPhase({
        id: "warm-gateway-session-turn",
        command: "node support/run-gateway-session-send-turn.mjs --create-session false",
        startedAtEpochMs: base + 10000,
        finishedAtEpochMs: base + 14000,
        payload: warmPayload
      })
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
        ...timeline,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    }
  };
}

function syntheticAgentCliRecord({ base, timeline }) {
  return {
    scenario: "agent-cold-warm-message",
    surface: "agent-cold-warm-message",
    title: "Agent CLI cold/warm",
    status: "PASS",
    cleanup: "done",
    auth: { mode: "mock" },
    phases: [
      syntheticAgentCliTurnPhase({
        id: "cold-agent-turn",
        startedAtEpochMs: base + 1000,
        finishedAtEpochMs: base + 1900
      }),
      syntheticAgentCliTurnPhase({
        id: "warm-agent-turn",
        startedAtEpochMs: base + 11000,
        finishedAtEpochMs: base + 11600
      })
    ],
    providerEvidence: {
      available: true,
      requestCount: 2,
      requests: [
        {
          requestId: "cold-provider",
          receivedAt: new Date(base + 1200).toISOString(),
          receivedAtEpochMs: base + 1200,
          respondedAt: new Date(base + 1700).toISOString(),
          respondedAtEpochMs: base + 1700,
          firstByteLatencyMs: 20,
          firstChunkLatencyMs: 25,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200
        },
        {
          requestId: "warm-provider",
          receivedAt: new Date(base + 11200).toISOString(),
          receivedAtEpochMs: base + 11200,
          respondedAt: new Date(base + 11500).toISOString(),
          respondedAtEpochMs: base + 11500,
          firstByteLatencyMs: 18,
          firstChunkLatencyMs: 20,
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
        ...timeline,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    }
  };
}

function syntheticAgentCliTurnPhase({ id, startedAtEpochMs, finishedAtEpochMs }) {
  const command = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
  return {
    id,
    title: id,
    intent: "Synthetic agent CLI turn",
    commands: [command],
    evidence: [],
    results: [{
      command,
      status: 0,
      timedOut: false,
      startedAt: new Date(startedAtEpochMs).toISOString(),
      startedAtEpochMs,
      finishedAt: new Date(finishedAtEpochMs).toISOString(),
      finishedAtEpochMs,
      durationMs: finishedAtEpochMs - startedAtEpochMs,
      stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
      stderr: ""
    }],
    metrics: { logs: zeroLogMetrics(), health: { ok: true } }
  };
}

function syntheticGatewayTurnPhase({ id, command, startedAtEpochMs, finishedAtEpochMs, payload }) {
  return {
    id,
    title: id,
    intent: "Synthetic Gateway session turn",
    commands: [command],
    evidence: [],
    results: [{
      command,
      status: 0,
      timedOut: false,
      startedAt: new Date(startedAtEpochMs).toISOString(),
      startedAtEpochMs,
      finishedAt: new Date(finishedAtEpochMs).toISOString(),
      finishedAtEpochMs,
      durationMs: finishedAtEpochMs - startedAtEpochMs,
      stdout: JSON.stringify(payload),
      stderr: ""
    }],
    metrics: { logs: zeroLogMetrics(), health: { ok: true } }
  };
}

function syntheticTurn({
  startedAtEpochMs,
  firstProviderRequestAtEpochMs,
  firstByteLatencyMs = null,
  firstChunkLatencyMs = null,
  lastProviderResponseAtEpochMs,
  finishedAtEpochMs,
  timelineSummary
}) {
  const result = {
    command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
    startedAt: new Date(startedAtEpochMs).toISOString(),
    startedAtEpochMs,
    finishedAt: new Date(finishedAtEpochMs).toISOString(),
    finishedAtEpochMs,
    durationMs: finishedAtEpochMs - startedAtEpochMs,
    processSnapshots: {
      before: { capturedAt: new Date(startedAtEpochMs - 10).toISOString(), processCount: 2 },
      after: { capturedAt: new Date(finishedAtEpochMs + 10).toISOString(), processCount: 2 },
      leaks: { leakCount: 0, leaksByRole: {}, leakedProcesses: [] }
    }
  };
  const request = {
    requestId: "self-check-provider",
    receivedAt: new Date(firstProviderRequestAtEpochMs).toISOString(),
    receivedAtEpochMs: firstProviderRequestAtEpochMs,
    firstByteLatencyMs,
    firstChunkLatencyMs,
    respondedAt: new Date(lastProviderResponseAtEpochMs).toISOString(),
    respondedAtEpochMs: lastProviderResponseAtEpochMs,
    route: "/v1/responses",
    model: "gpt-5.5",
    stream: true,
    status: 200,
    statusClass: "2xx"
  };
  const attribution = computeProviderTurnAttribution(result, {
    available: true,
    requests: [request]
  });
  return {
    result,
    request,
    attribution,
    breakdown: buildAgentTurnBreakdown({ result, attribution, timelineSummary })
  };
}

async function mockProviderBehaviorCheck(tmp) {
  const dir = join(tmp, "mock-provider-behavior");
  await mkdir(dir, { recursive: true });
  const scriptPath = join(dir, "script.json");
  const requestLogPath = join(dir, "requests.jsonl");
  const serverLogPath = join(dir, "server.log");
  const portPath = join(dir, "port");
  const pidPath = join(dir, "pid");
  const writePort = [
    "node",
    "-e",
    quoteShell("const fs=require('fs'); const [logPath, portPath] = process.argv.slice(1); const line=fs.readFileSync(logPath,'utf8').split(/\\r?\\n/).find(Boolean); if (!line) process.exit(1); const startup=JSON.parse(line); if (!startup.port) process.exit(1); fs.writeFileSync(portPath, String(startup.port));"),
    quoteShell(serverLogPath),
    quoteShell(portPath)
  ].join(" ");
  const command = [
    `node support/write-mock-ai-provider-script.mjs --output ${quoteShell(scriptPath)} --mode error-then-recover --error-status 503`,
    mockAiProviderServeCommand({ scriptPath, requestLog: requestLogPath, serverLog: serverLogPath, pidFile: pidPath }),
    `trap 'test -s ${quoteShell(pidPath)} && kill "$(cat ${quoteShell(pidPath)})" 2>/dev/null || true' EXIT`,
    `for i in $(seq 1 100); do ${writePort} >/dev/null 2>&1 && test -s ${quoteShell(portPath)} && node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$(cat ${quoteShell(portPath)})" && break; sleep 0.1; done`,
    `test -s ${quoteShell(portPath)} || { cat ${quoteShell(serverLogPath)} >&2; exit 1; }`,
    `port=$(cat ${quoteShell(portPath)})`,
    "node -e 'const port=process.argv[1]; const body=JSON.stringify({model:\"gpt-5.5\",stream:false}); const send=()=>fetch(`http://127.0.0.1:${port}/v1/responses`,{method:\"POST\",headers:{\"content-type\":\"application/json\"},body}).then(async r=>({status:r.status,text:await r.text()})); const first=await send(); const second=await send(); console.log(JSON.stringify({first:first.status,second:second.status}));' \"$port\""
  ].join("; ");
  const result = await runCommand(command, { timeoutMs: 30000 });
  try {
    if (result.status !== 0) {
      const detail = result.timedOut ? `timed out after ${result.durationMs}ms` : (result.stderr || result.stdout);
      throw new Error(`mock provider behavior command failed: ${detail}`);
    }
    const response = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assertEqual(response.first, 503, "first transient provider status");
    assertEqual(response.second, 200, "second recovered provider status");
    const evidence = parseProviderRequestLog(await readFile(requestLogPath, "utf8"));
    const responseRequests = evidence.requests.filter((request) => request.route === "/v1/responses");
    assertEqual(responseRequests.length, 2, "behavior request count");
    assertEqual(responseRequests[0]?.mode, "error-then-recover", "first request behavior");
    assertEqual(responseRequests[0]?.errorClass, "provider-error", "first request error class");
    assertEqual(responseRequests[1]?.status, 200, "second recovered request status");
    assertEqual(responseRequests[1]?.errorClass, null, "second request error class");
    return {
      id: "mock-provider-behavior",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "mock-provider-behavior",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function concurrentAgentRunnerCheck(tmp) {
  const fakeBin = join(tmp, "concurrent-agent-runner-bin");
  const fakeOcm = join(fakeBin, "ocm");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({ finalAssistantVisibleText: 'KOVA_AGENT_OK' }) + '\\n');"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const command = `PATH=${quoteShell(fakeBin)}:$PATH node support/run-concurrent-agent-turns.mjs --env kova-self-check --count 2 --session-prefix kova-self-check-concurrent --message hi --expected-text KOVA_AGENT_OK --timeout 5`;
  const result = await runCommand(command, { timeoutMs: 10000 });
  try {
    if (result.status !== 0) {
      throw new Error(`concurrent agent runner failed: ${result.stderr || result.stdout}`);
    }
    const summary = JSON.parse(result.stdout);
    assertEqual(summary.schemaVersion, "kova.concurrentAgentTurns.v1", "concurrent runner schema");
    assertEqual(summary.ok, true, "concurrent runner ok");
    assertEqual(summary.count, 2, "concurrent runner count");
    assertEqual(summary.successCount, 2, "concurrent runner success count");
    assertEqual(summary.turns.every((turn) => turn.expectedTextPresent === true), true, "all concurrent turns included expected text");
    return {
      id: "concurrent-agent-runner",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "concurrent-agent-runner",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function officialPluginInstallRunnerCheck(tmp) {
  const fakeBin = join(tmp, "official-plugin-runner-bin");
  const fakeOcm = join(fakeBin, "ocm");
  const artifactDir = join(tmp, "official-plugin-runner-artifacts");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const text = process.argv.slice(2).join(' ');",
    "if (text.includes('@kova-self-check -- plugins install @openclaw/discord')) {",
    "  if (process.env.KOVA_FAKE_OCM_SECURITY_BLOCK === '1') {",
    "    process.stderr.write('WARNING: Plugin \"discord\" contains dangerous code patterns: credential harvesting\\n');",
    "    process.exit(1);",
    "  }",
    "  process.stdout.write('installed @openclaw/discord\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('@kova-self-check -- plugins list')) {",
    "  process.stdout.write('discord @openclaw/discord\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('@kova-self-check -- plugins registry --refresh --json')) {",
    "  process.stdout.write(JSON.stringify({ plugins: [{ id: 'discord' }] }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('@kova-self-check -- status')) {",
    "  process.stdout.write('status ok\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('logs kova-self-check --tail 400 --raw')) {",
    "  process.stdout.write('[plugins] diagnostic log line\\n');",
    "  process.exit(0);",
    "}",
    "process.stderr.write('unexpected fake ocm command: ' + text + '\\n');",
    "process.exit(2);"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const successCommand = `PATH=${quoteShell(fakeBin)}:$PATH node support/run-official-plugin-install.mjs --env kova-self-check --state states/official-plugins.json --artifact-dir ${quoteShell(artifactDir)} --timeout-ms 5000`;
  const success = await runCommand(successCommand, { timeoutMs: 10000, maxOutputChars: 1000000 });
  const blockedCommand = `PATH=${quoteShell(fakeBin)}:$PATH KOVA_FAKE_OCM_SECURITY_BLOCK=1 node support/run-official-plugin-install.mjs --env kova-self-check --state states/official-plugins.json --artifact-dir ${quoteShell(join(tmp, "official-plugin-blocked-artifacts"))} --timeout-ms 5000`;
  const blocked = await runCommand(blockedCommand, { timeoutMs: 10000, maxOutputChars: 1000000 });

  try {
    if (success.status !== 0) {
      throw new Error(`official plugin runner success path failed: ${success.stderr || success.stdout}`);
    }
    const successSummary = JSON.parse(success.stdout);
    assertEqual(successSummary.schemaVersion, "kova.officialPluginInstall.v1", "official plugin runner schema");
    assertEqual(successSummary.ok, true, "official plugin runner ok");
    assertEqual(successSummary.pluginCount >= 1, true, "official plugin runner plugin count");
    assertEqual(successSummary.pluginResults?.[0]?.package, "@openclaw/discord", "official plugin package");

    if (blocked.status === 0) {
      throw new Error("official plugin runner security-block path should fail");
    }
    const blockedSummary = JSON.parse(blocked.stdout);
    assertEqual(blockedSummary.securityBlocked, true, "official plugin runner security blocked");
    assertEqual(blockedSummary.securityBlockCount, 1, "official plugin runner security block count");
    assertEqual(blockedSummary.failureEvidence?.length, 1, "official plugin runner failure evidence");
    assertEqual(blockedSummary.failureEvidence?.[0]?.diagnostics?.some((step) => step.id === "diagnostic-logs:discord"), true, "official plugin runner diagnostic logs");
    return {
      id: "official-plugin-install-runner",
      status: "PASS",
      command: successCommand,
      durationMs: success.durationMs + blocked.durationMs
    };
  } catch (error) {
    return {
      id: "official-plugin-install-runner",
      status: "FAIL",
      command: successCommand,
      durationMs: success.durationMs + blocked.durationMs,
      message: error.message
    };
  }
}

function providerFailureEvaluationCheck() {
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

function providerConcurrentEvaluationCheck() {
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

function agentAuthFailureEvaluationCheck() {
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

async function soakLoopRunnerCheck(tmp) {
  const fakeBin = join(tmp, "soak-loop-runner-bin");
  const fakeOcm = join(fakeBin, "ocm");
  const port = 39291;
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'service' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({ gatewayState: 'running', running: true, gatewayPort: Number(process.env.KOVA_FAKE_PORT) }) + '\\n');",
    "  process.exit(0);",
    "}",
    "process.stdout.write('ok\\n');"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const command = [
    `node -e "require('node:http').createServer((req,res)=>{res.end('ok')}).listen(${port},'127.0.0.1')" >/dev/null 2>&1 & server_pid=$!`,
    `PATH=${quoteShell(fakeBin)}:$PATH KOVA_FAKE_PORT=${port} node support/run-soak-loop.mjs --env kova-self-check --duration-ms 50 --interval-ms 0 --timeout-ms 5000`,
    "rc=$?",
    "kill $server_pid 2>/dev/null || true",
    "exit $rc"
  ].join("; ");
  const result = await runCommand(command, { timeoutMs: 10000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(`soak loop runner failed: ${result.stderr || result.stdout}`);
    }
    const summary = JSON.parse(result.stdout);
    assertEqual(summary.schemaVersion, "kova.soakLoop.v1", "soak loop schema");
    assertEqual(summary.iterations >= 1, true, "soak loop iterations");
    assertEqual(summary.commandSummary.failureCount, 0, "soak loop command failures");
    assertEqual(summary.healthSummary.failureCount, 0, "soak loop health failures");
    assertEqual(summary.commandSummary.byId.status.count >= 1, true, "soak loop status command count");
    return {
      id: "soak-loop-runner",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "soak-loop-runner",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function soakTrendEvaluationCheck() {
  try {
    const loop = {
      schemaVersion: "kova.soakLoop.v1",
      durationMs: 65000,
      iterations: 3,
      commandSummary: {
        count: 9,
        okCount: 9,
        failureCount: 0,
        p95Ms: 900,
        maxMs: 1200
      },
      healthSummary: {
        count: 3,
        okCount: 3,
        failureCount: 0,
        p95Ms: 45,
        maxMs: 60
      }
    };
    const record = {
      scenario: "soak",
      status: "PASS",
      phases: [{
        id: "loop",
        results: [{
          command: "node support/run-soak-loop.mjs --env kova-self-check --duration-ms 60000",
          status: 0,
          timedOut: false,
          durationMs: 65000,
          stdout: JSON.stringify(loop),
          stderr: "",
          resourceSamples: {
            sampleCount: 3,
            peakTotalRssMb: 1000,
            maxTotalCpuPercent: 80,
            peakGatewayRssMb: 900,
            peakCommandTreeRssMb: 100,
            byRole: {},
            topRolesByRss: [],
            topRolesByCpu: [],
            topByRss: [],
            topByCpu: [],
            trend: {
              schemaVersion: "kova.resourceTrend.v1",
              available: true,
              totalRssGrowthMb: 420,
              gatewayRssGrowthMb: 390
            }
          }
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "soak",
      thresholds: {
        soakMinDurationMs: 60000,
        soakCommandP95Ms: 10000,
        soakHealthP95Ms: 1000,
        soakCommandFailures: 0,
        soakHealthFailures: 0,
        rssGrowthMb: 300,
        gatewayRssGrowthMb: 300
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "FAIL", "soak trend record status");
    assertEqual(record.measurements.soakIterations, 3, "soak iterations");
    assertEqual(record.measurements.soakCommandP95Ms, 900, "soak command p95");
    assertEqual(record.measurements.rssGrowthMb, 420, "soak total RSS growth");
    assertEqual(record.measurements.gatewayRssGrowthMb, 390, "soak gateway RSS growth");
    assertEqual(
      record.violations.some((violation) => violation.metric === "rssGrowthMb"),
      true,
      "soak RSS growth violation"
    );

    return {
      id: "soak-trend-evaluation",
      status: "PASS",
      command: "evaluate synthetic soak trend regression",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "soak-trend-evaluation",
      status: "FAIL",
      command: "evaluate synthetic soak trend regression",
      durationMs: 0,
      message: error.message
    };
  }
}

function mcpBridgeEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.mcpBridgeSmoke.v1",
      durationMs: 1800,
      initializeMs: 120,
      toolsListMs: 90,
      shutdownMs: 45,
      toolCount: 8,
      toolNames: ["conversations_list", "messages_read"],
      processExited: true,
      exitStatus: 0,
      exitSignal: null,
      errors: []
    };
    const record = {
      scenario: "mcp-runtime-start-stop",
      status: "PASS",
      phases: [{
        id: "mcp-bridge",
        results: [{
          command: "node support/mcp-bridge-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1800,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "mcp-runtime-start-stop",
      thresholds: {
        mcpInitializeMs: 10000,
        mcpToolsListMs: 10000,
        mcpShutdownMs: 5000,
        mcpToolCountMin: 1,
        mcpProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "MCP bridge record status");
    assertEqual(record.measurements.mcpInitializeMs, 120, "MCP initialize ms");
    assertEqual(record.measurements.mcpToolsListMs, 90, "MCP tools/list ms");
    assertEqual(record.measurements.mcpShutdownMs, 45, "MCP shutdown ms");
    assertEqual(record.measurements.mcpToolCount, 8, "MCP tool count");
    assertEqual(record.measurements.mcpProcessLeaks, 0, "MCP process leak count");

    const leaked = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "mcp-bridge",
        results: [{
          command: "node support/mcp-bridge-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1800,
          stdout: JSON.stringify({ ...smoke, processExited: false }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(leaked, {
      id: "mcp-runtime-start-stop",
      thresholds: { mcpProcessLeaks: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(leaked.status, "FAIL", "MCP leaked process status");
    assertEqual(
      leaked.violations.some((violation) => violation.metric === "mcpProcessLeaks"),
      true,
      "MCP process leak violation"
    );

    return {
      id: "mcp-bridge-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic MCP bridge evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "mcp-bridge-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic MCP bridge evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

function browserAutomationEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.browserAutomationSmoke.v1",
      durationMs: 4200,
      browserDoctorMs: 120,
      browserStartMs: 1800,
      browserTabsMs: 90,
      browserOpenMs: 300,
      browserSnapshotMs: 250,
      browserStopMs: 180,
      browserTabCount: 2,
      browserSnapshotOk: true,
      browserStopped: true,
      errors: []
    };
    const record = {
      scenario: "browser-automation-smoke",
      status: "PASS",
      phases: [{
        id: "browser-smoke",
        results: [{
          command: "node support/browser-automation-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 4200,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "browser-automation-smoke",
      thresholds: {
        browserDoctorMs: 15000,
        browserStartMs: 30000,
        browserTabsMs: 10000,
        browserOpenMs: 15000,
        browserSnapshotMs: 15000,
        browserStopMs: 10000,
        browserTabCountMin: 1,
        browserProcessLeaks: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "browser automation record status");
    assertEqual(record.measurements.browserStartMs, 1800, "browser start ms");
    assertEqual(record.measurements.browserOpenMs, 300, "browser open ms");
    assertEqual(record.measurements.browserSnapshotMs, 250, "browser snapshot ms");
    assertEqual(record.measurements.browserTabCount, 2, "browser tab count");
    assertEqual(record.measurements.browserProcessLeaks, 0, "browser process leak count");

    const failed = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "browser-smoke",
        results: [{
          command: "node support/browser-automation-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 4200,
          stdout: JSON.stringify({ ...smoke, browserStopped: false, errors: ["browser stop failed"] }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failed, {
      id: "browser-automation-smoke",
      thresholds: { browserProcessLeaks: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failed.status, "FAIL", "browser failed stop status");
    assertEqual(
      failed.violations.some((violation) => violation.metric === "browserProcessLeaks"),
      true,
      "browser process leak violation"
    );

    return {
      id: "browser-automation-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic browser automation evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "browser-automation-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic browser automation evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

function mediaUnderstandingEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.mediaUnderstandingTimeout.v1",
      ok: true,
      durationMs: 1600,
      mediaDescribeMs: 1250,
      mediaTimeoutObserved: true,
      mediaCommandTimedOut: false,
      mediaCommandStatus: 1,
      mediaStatusAfterTimeoutMs: 180,
      gatewayStatusWorks: true,
      errors: []
    };
    const record = {
      scenario: "media-understanding-timeout",
      status: "PASS",
      providerEvidence: { requestCount: 1 },
      phases: [{
        id: "media-timeout",
        results: [{
          command: "node support/media-understanding-timeout.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1600,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "media-understanding-timeout",
      thresholds: {
        mediaDescribeMs: 10000,
        mediaTimeoutObserved: 1,
        mediaStatusAfterTimeoutMs: 10000,
        providerRequestCountMin: 1
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "media understanding record status");
    assertEqual(record.measurements.mediaDescribeMs, 1250, "media describe ms");
    assertEqual(record.measurements.mediaTimeoutObserved, true, "media timeout observed");
    assertEqual(record.measurements.mediaCommandTimedOut, false, "media command did not hit outer timeout");
    assertEqual(record.measurements.mediaStatusAfterTimeoutMs, 180, "post-media status ms");
    assertEqual(record.measurements.mediaGatewayStatusWorks, true, "gateway status after media timeout");

    const failed = {
      ...record,
      status: "PASS",
      providerEvidence: { requestCount: 0 },
      violations: [],
      measurements: undefined,
      phases: [{
        id: "media-timeout",
        results: [{
          command: "node support/media-understanding-timeout.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1600,
          stdout: JSON.stringify({
            ...smoke,
            ok: false,
            mediaTimeoutObserved: false,
            gatewayStatusWorks: false,
            errors: ["media timeout not observed"]
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failed, {
      id: "media-understanding-timeout",
      thresholds: {
        mediaTimeoutObserved: 1,
        providerRequestCountMin: 1
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failed.status, "FAIL", "media failure status");
    assertEqual(
      failed.violations.some((violation) => violation.metric === "mediaTimeoutObserved"),
      true,
      "media timeout observed violation"
    );
    assertEqual(
      failed.violations.some((violation) => violation.metric === "providerRequestCountMin"),
      true,
      "media provider request count violation"
    );

    return {
      id: "media-understanding-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic media understanding timeout evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "media-understanding-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic media understanding timeout evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

function networkOfflineEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.agentNetworkOffline.v1",
      ok: true,
      durationMs: 1800,
      networkTurnMs: 1400,
      networkFailureObserved: true,
      networkCommandTimedOut: false,
      networkCommandStatus: 1,
      networkStatusAfterFailureMs: 190,
      gatewayStatusWorks: true,
      errors: []
    };
    const record = {
      scenario: "agent-network-offline",
      status: "PASS",
      phases: [{
        id: "network-offline-turn",
        results: [{
          command: "node support/agent-network-offline.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1800,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "agent-network-offline",
      thresholds: {
        networkFailureObserved: 1,
        networkStatusAfterFailureMs: 10000
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "network offline record status");
    assertEqual(record.measurements.networkTurnMs, 1400, "network turn ms");
    assertEqual(record.measurements.networkFailureObserved, true, "network failure observed");
    assertEqual(record.measurements.networkCommandTimedOut, false, "network command did not hit outer timeout");
    assertEqual(record.measurements.networkStatusAfterFailureMs, 190, "post-network status ms");
    assertEqual(record.measurements.networkGatewayStatusWorks, true, "gateway status after network failure");

    const failed = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "network-offline-turn",
        results: [{
          command: "node support/agent-network-offline.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1800,
          stdout: JSON.stringify({
            ...smoke,
            ok: false,
            networkFailureObserved: false,
            gatewayStatusWorks: false,
            errors: ["network failure not observed"]
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failed, {
      id: "agent-network-offline",
      thresholds: {
        networkFailureObserved: 1
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failed.status, "FAIL", "network failure status");
    assertEqual(
      failed.violations.some((violation) => violation.metric === "networkFailureObserved"),
      true,
      "network failure observed violation"
    );
    assertEqual(
      failed.violations.some((violation) => violation.metric === "networkGatewayStatusWorks"),
      true,
      "network gateway status violation"
    );

    return {
      id: "network-offline-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic network offline evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-offline-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic network offline evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

function agentColdWarmEvaluationCheck() {
  try {
    const coldCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
    const warmCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
    const record = {
      scenario: "agent-cold-warm-message",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "cold-agent-turn",
          results: [{
            command: coldCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:01:03.000Z",
            finishedAtEpochMs: 1777543263000,
            durationMs: 62000,
            stdout: "{\"payloads\":[{\"text\":\"KOVA_AGENT_OK\"}]}",
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        },
        {
          id: "warm-agent-turn",
          results: [{
            command: warmCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:01:10.000Z",
            startedAtEpochMs: 1777543270000,
            finishedAt: "2026-04-30T10:01:12.000Z",
            finishedAtEpochMs: 1777543272000,
            durationMs: 2000,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\",\"payloads\":[{\"text\":\"WRONG_REPLY\"}]}",
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
            receivedAt: "2026-04-30T10:01:02.000Z",
            receivedAtEpochMs: 1777543262000,
            respondedAt: "2026-04-30T10:01:02.800Z",
            respondedAtEpochMs: 1777543262800,
            firstByteLatencyMs: 50,
            firstChunkLatencyMs: 50,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 200,
            statusClass: "2xx"
          },
          {
            requestId: "warm-provider",
            receivedAt: "2026-04-30T10:01:10.500Z",
            receivedAtEpochMs: 1777543270500,
            respondedAt: "2026-04-30T10:01:11.300Z",
            respondedAtEpochMs: 1777543271300,
            firstByteLatencyMs: 40,
            firstChunkLatencyMs: 40,
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
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        preProviderMs: 10000,
        coldWarmDeltaMs: 30000,
        providerFinalMs: 3000,
        preProviderDominanceRatio: 0.8
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "FAIL", "cold pre-provider stall should fail");
    assertEqual(record.measurements.agentTurnCount, 2, "agent turn count");
    assertEqual(record.measurements.coldAgentTurnMs, 62000, "cold turn duration");
    assertEqual(record.measurements.warmAgentTurnMs, 2000, "warm turn duration");
    assertEqual(record.measurements.agentColdWarmDeltaMs, 60000, "cold warm delta");
    assertEqual(record.measurements.coldPreProviderMs, 61000, "cold pre-provider latency");
    assertEqual(record.measurements.warmPreProviderMs, 500, "warm pre-provider latency");
    assertEqual(record.measurements.coldProviderFinalMs, 800, "cold provider final");
    assertEqual(record.measurements.agentLatencyDiagnosis.kind, "cold-pre-provider-stall", "latency diagnosis kind");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "cold response ok");
    assertEqual(record.measurements.agentTurns[0].responseText, "KOVA_AGENT_OK", "payload response text");
    assertEqual(record.measurements.agentTurns[1].responseText, "KOVA_AGENT_OK", "final assistant response precedence");
    assertEqual(record.measurements.agentTurns[1].providerRoutes[0].value, "/v1/responses", "warm provider route evidence");
    assertEqual(
      renderPasteSummary({
        runId: "self-check-cold-warm",
        target: "runtime:stable",
        mode: "self-check",
        platform: { os: "test", release: "test", arch: "test" },
        records: [record]
      }).includes("cold-warm delta 60000ms"),
      true,
      "paste summary includes cold/warm evidence"
    );

    return {
      id: "agent-cold-warm-evaluation",
      status: "PASS",
      command: "evaluate synthetic cold/warm agent provider attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cold-warm-evaluation",
      status: "FAIL",
      command: "evaluate synthetic cold/warm agent provider attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

function sourceReleaseCompareCheck() {
  try {
    const releaseReport = syntheticCompareReport({
      runId: "release-run",
      target: "npm:2026.4.27",
      timelineAvailable: false,
      preProviderMs: 62000,
      slowestSpanMs: null
    });
    const sourceReport = syntheticCompareReport({
      runId: "source-run",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 4000,
      slowestSpanMs: 3200
    });
    const comparison = compareReports(releaseReport, sourceReport);
    assertEqual(comparison.ok, true, "source/release comparison with source timeline should pass");
    assertEqual(comparison.sourceRelease?.pairCount, 1, "source/release pair count");
    assertEqual(comparison.sourceRelease?.infoCount, 1, "release missing timeline should be informational");
    assertEqual(comparison.sourceRelease?.pairs?.[0]?.source?.timelineAvailable, true, "source timeline available");
    assertEqual(comparison.sourceRelease?.pairs?.[0]?.release?.timelineAvailable, false, "release timeline missing");

    const missingTimelineComparison = compareReports(releaseReport, syntheticCompareReport({
      runId: "source-no-timeline",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: false,
      preProviderMs: 4000,
      slowestSpanMs: null
    }));
    assertEqual(missingTimelineComparison.ok, false, "source missing timeline should fail comparison");
    assertEqual(missingTimelineComparison.sourceRelease?.blockingCount, 1, "source missing timeline blocking count");
    assertEqual(
      renderCompareSummary(missingTimelineComparison).includes("source-build report did not include OpenClaw timeline diagnostics"),
      true,
      "compare summary includes source timeline blocker"
    );

    const failingReport = syntheticCompareReport({
      runId: "gateway-rss-failing",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 4000,
      slowestSpanMs: 3200
    });
    failingReport.summary = { statuses: { FAIL: 1 } };
    failingReport.records[0].status = "FAIL";
    failingReport.records[0].violations = [{
      metric: "resourcePeakGatewayRssMb",
      message: "gateway peak RSS 701.8 MB exceeded threshold 700 MB"
    }];
    const fixedReport = syntheticCompareReport({
      runId: "gateway-rss-fixed",
      target: "local-build:/tmp/openclaw",
      timelineAvailable: true,
      preProviderMs: 3800,
      slowestSpanMs: 3000
    });
    const fixedComparison = compareReports(failingReport, fixedReport);
    assertEqual(fixedComparison.ok, true, "resolved failure comparison should pass");
    assertEqual(fixedComparison.statusChanges.improvements.length, 1, "status improvement count");
    assertEqual(fixedComparison.findingChanges.resolved.length, 1, "resolved finding count");
    assertEqual(
      renderCompareSummary(fixedComparison).includes("RESOLVED FAIL agent-cold-warm-message/mock-openai-provider"),
      true,
      "compare summary includes resolved finding"
    );

    return {
      id: "source-release-compare",
      status: "PASS",
      command: "evaluate synthetic source-build versus release-runtime comparison",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "source-release-compare",
      status: "FAIL",
      command: "evaluate synthetic source-build versus release-runtime comparison",
      durationMs: 0,
      message: error.message
    };
  }
}

function syntheticCompareReport({ runId, target, timelineAvailable, preProviderMs, slowestSpanMs }) {
  return {
    runId,
    mode: "execution",
    target,
    generatedAt: "2026-05-01T00:00:00.000Z",
    platform: { os: "darwin", arch: "arm64", release: "test", node: "test" },
    summary: { statuses: { PASS: 1 } },
    records: [{
      scenario: "agent-cold-warm-message",
      surface: "agent-cli-local-turn",
      state: { id: "mock-openai-provider" },
      status: "PASS",
      measurements: {
        openclawTimelineAvailable: timelineAvailable,
        openclawTimelineEventCount: timelineAvailable ? 20 : 0,
        openclawSlowestSpanName: timelineAvailable ? "agent.prepare" : null,
        openclawSlowestSpanMs: slowestSpanMs,
        coldAgentTurnMs: preProviderMs + 800,
        coldPreProviderMs: preProviderMs,
        coldProviderFinalMs: 800,
        agentTurnMs: preProviderMs + 800,
        agentPreProviderMs: preProviderMs,
        agentProviderFinalMs: 800,
        runtimeDepsStagingMs: 0,
        peakRssMb: 100
      }
    }]
  };
}

async function diagnosticsTimelineCheck() {
  try {
    const text = await readFile("fixtures/diagnostics/timeline.jsonl", "utf8");
    const timeline = parseTimelineText(text);
    assertEqual(timeline.available, true, "timeline available");
    assertEqual(timeline.eventCount, 8, "timeline event count");
    assertEqual(timeline.parseErrorCount, 0, "timeline parse errors");
    assertEqual(
      timeline.repeatedSpans.some((span) => span.name === "plugins.metadata.scan"),
      true,
      "repeated plugin metadata span"
    );
    assertEqual(timeline.runtimeDeps.slowest?.pluginId, "browser", "runtime deps slowest plugin");
    assertEqual(timeline.runtimeDeps.byPlugin[1]?.pluginId, "memory-core", "runtime deps by plugin");
    assertEqual(timeline.eventLoop.maxMs, 214, "event loop max");
    assertEqual(timeline.providers.maxDurationMs, 1220, "provider duration");
    assertEqual(timeline.childProcesses.failedCount, 1, "child process failures");
    assertEqual(timeline.keySpans["gateway.startup"].maxDurationMs, 2450, "gateway startup key span");
    return {
      id: "diagnostics-timeline-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/timeline.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-timeline-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/timeline.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}

async function diagnosticsOpenSpanCheck() {
  try {
    const text = await readFile("fixtures/diagnostics/timeline-open-span.jsonl", "utf8");
    const timeline = parseTimelineText(text);
    assertEqual(timeline.available, true, "open timeline available");
    assertEqual(timeline.openSpanCount, 1, "open span count");
    assertEqual(timeline.openSpans[0]?.name, "runtimeDeps.stage", "open span name");
    assertEqual(timeline.openSpans[0]?.ageMs, 5000, "open span age");
    assertEqual(timeline.keySpans["runtimeDeps.stage"].openCount, 1, "key open span count");
    return {
      id: "diagnostics-open-span-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/timeline-open-span.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-open-span-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/timeline-open-span.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}

function diagnosticsTimelineEvaluationCheck() {
  try {
    const missingTimelineRecord = {
      scenario: "diagnostic-missing-timeline",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: {
          available: false,
          eventCount: 0,
          parseErrorCount: 0,
          openSpanCount: 0,
          openSpans: [],
          keySpans: {},
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    evaluateRecord(missingTimelineRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: {
        id: "diagnostic",
        diagnostics: {
          timelineRequired: true,
          timelineRequiredForTargetKinds: ["local-build"]
        }
      },
      surface: {
        id: "release-runtime-startup",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(missingTimelineRecord.status, "FAIL", "missing diagnostic timeline status");
    assertEqual(
      missingTimelineRecord.violations.some((violation) => violation.metric === "openclawTimelineAvailable"),
      true,
      "missing diagnostic timeline violation"
    );

    const missingSpanRecord = {
      scenario: "diagnostic-missing-span",
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
    evaluateRecord(missingSpanRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(missingSpanRecord.status, "PASS", "missing expected span alone does not fail user path");
    assertEqual(missingSpanRecord.measurements.openclawMissingRequiredSpanCount, 1, "missing required span measurement");
    assertEqual(missingSpanRecord.measurements.openclawMissingRequiredSpanSeverity, "diagnostic-gap", "missing expected span severity");
    assertEqual(
      (missingSpanRecord.violations ?? []).some((violation) => violation.metric === "openclawMissingRequiredSpanCount"),
      false,
      "missing expected span does not become violation by default"
    );

    const strictMissingSpanRecord = structuredClone(missingSpanRecord);
    strictMissingSpanRecord.status = "PASS";
    strictMissingSpanRecord.violations = [];
    strictMissingSpanRecord.measurements = undefined;
    evaluateRecord(strictMissingSpanRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: {
          expectedSpans: ["runtimeDeps.stage"],
          missingExpectedSpanSeverity: "fail"
        },
        thresholds: {}
      }
    });
    assertEqual(strictMissingSpanRecord.status, "FAIL", "strict missing span status");
    assertEqual(strictMissingSpanRecord.measurements.openclawMissingRequiredSpanSeverity, "fail", "strict missing span severity");
    assertEqual(
      strictMissingSpanRecord.violations.some((violation) => violation.metric === "openclawMissingRequiredSpanCount"),
      true,
      "strict missing span violation"
    );

    const openSpanRecord = {
      scenario: "diagnostic-open-span",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: parseTimelineText([
          "{\"type\":\"span.start\",\"timestamp\":\"2026-04-29T15:30:00.000Z\",\"name\":\"runtimeDeps.stage\",\"spanId\":\"1\"}",
          "{\"type\":\"eventLoop.sample\",\"timestamp\":\"2026-04-29T15:30:06.000Z\",\"name\":\"eventLoop\",\"maxMs\":400}"
        ].join("\n"))
      }
    };
    evaluateRecord(openSpanRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(openSpanRecord.status, "FAIL", "open required span status");
    assertEqual(openSpanRecord.measurements.openclawOpenRequiredSpanCount, 1, "open required span measurement");
    assertEqual(
      openSpanRecord.violations.some((violation) => violation.metric === "openclawOpenRequiredSpanCount"),
      true,
      "open required span violation"
    );
    const reportSummary = renderReportSummary({
      schemaVersion: "kova.report.v1",
      generatedAt: "2026-04-29T15:30:10.000Z",
      runId: "self-check-diagnostics",
      summary: { total: 1, statuses: { FAIL: 1 } },
      records: [openSpanRecord]
    }, { structured: true });
    assertEqual(
      reportSummary.scenarios[0]?.measurements?.diagnostics?.openRequiredSpanCount,
      1,
      "structured report open span evidence"
    );
    assertEqual(
      reportSummary.scenarios[0]?.measurements?.diagnostics?.openSpans?.[0]?.name,
      "runtimeDeps.stage",
      "structured report open span name"
    );
    assertEqual(
      renderPasteSummary({
        runId: "self-check-diagnostics",
        target: "local-build:/tmp/openclaw",
        mode: "self-check",
        records: [openSpanRecord]
      }).includes("openRequiredSpans: 1"),
      true,
      "brief evidence includes open required spans"
    );

    return {
      id: "diagnostics-timeline-evaluation",
      status: "PASS",
      command: "evaluate synthetic diagnostic timeline records",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-timeline-evaluation",
      status: "FAIL",
      command: "evaluate synthetic diagnostic timeline records",
      durationMs: 0,
      message: error.message
    };
  }
}

function runtimeDepsLogParserCheck() {
  try {
    const summary = summarizeRuntimeDepsLogs([
      "21:22:15 [plugins] browser staging bundled runtime deps (6 specs): @modelcontextprotocol/sdk@1.29.0, commander@^14.0.3",
      "21:22:19 [plugins] browser installed bundled runtime deps in 3964ms: @modelcontextprotocol/sdk@1.29.0, commander@^14.0.3",
      "21:22:19 [plugins] memory-core staging bundled runtime deps (2 specs): chokidar@^5.0.0, typebox@1.1.33",
      "21:22:20 [plugins] memory-core installed bundled runtime deps in 1529ms: chokidar@^5.0.0, typebox@1.1.33",
      "runtime-postbuild: bundled plugin runtime deps completed in 45226ms"
    ].join("\n"));

    assertEqual(summary.stageCount, 2, "runtime deps stage count");
    assertEqual(summary.installCount, 2, "runtime deps install count");
    assertEqual(summary.installMaxMs, 3964, "runtime deps install max");
    assertEqual(summary.postbuildCount, 1, "runtime deps postbuild count");
    assertEqual(summary.postbuildMaxMs, 45226, "runtime deps postbuild max");
    assertEqual(summary.pluginIds.includes("browser"), true, "runtime deps browser plugin");

    return {
      id: "runtime-deps-log-parser",
      status: "PASS",
      command: "parse synthetic OpenClaw runtime dependency logs",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "runtime-deps-log-parser",
      status: "FAIL",
      command: "parse synthetic OpenClaw runtime dependency logs",
      durationMs: 0,
      message: error.message
    };
  }
}

function embeddedRunLogParserCheck() {
  try {
    const text = [
      "[agent/embedded] [trace:embedded-run] startup stages: runId=53b2 sessionId=ocm-direct-live-1 phase=attempt-dispatch totalMs=11948 stages=workspace:0ms@0ms,runtime-plugins:7325ms@7325ms,hooks:0ms@7325ms,model-resolution:1035ms@8360ms,auth:2045ms@10405ms,context-engine:1ms@10406ms,attempt-dispatch:1542ms@11948ms",
      "[agent/embedded] [trace:embedded-run] prep stages: runId=53b2 sessionId=ocm-direct-live-1 phase=stream-setup totalMs=10988 stages=workspace-sandbox:3ms@3ms,skills:0ms@3ms,core-plugin-tools:4688ms@4691ms,bootstrap-context:6ms@4697ms,bundle-tools:519ms@5216ms,system-prompt:2688ms@7904ms,session-resource-loader:526ms@8430ms,agent-session:1ms@8431ms,stream-setup:2557ms@10988ms",
      "[diagnostic] liveness warning: reasons=eventLoopDelay interval=10000ms eventLoopDelayP99Ms=116.9 eventLoopDelayMaxMs=9982.4 eventLoopUtilization=0.688 cpuCoreRatio=0.701 active=1 waiting=0 queued=0"
    ].join("\n");
    const embedded = summarizeEmbeddedRunTraces(text);
    const liveness = summarizeLivenessWarnings(text);

    assertEqual(embedded.eventCount, 2, "embedded trace count");
    assertEqual(embedded.startupCount, 1, "embedded startup count");
    assertEqual(embedded.prepCount, 1, "embedded prep count");
    assertEqual(embedded.stageTotals["runtime-plugins"]?.totalDurationMs, 7325, "runtime plugin stage duration");
    assertEqual(embedded.stageTotals["core-plugin-tools"]?.maxDurationMs, 4688, "core plugin tools max");
    assertEqual(embedded.topStages[0]?.name, "runtime-plugins", "embedded top stage");
    assertEqual(liveness.count, 1, "liveness warning count");
    assertEqual(liveness.maxEventLoopDelayMaxMs, 9982.4, "liveness event loop max");

    const breakdown = buildAgentTurnBreakdown({
      result: {
        command: "node support/run-gateway-session-send-turn.mjs",
        startedAtEpochMs: 1000,
        finishedAtEpochMs: 63000,
        durationMs: 62000
      },
      attribution: {
        commandStartedAtEpochMs: 1000,
        commandFinishedAtEpochMs: 63000,
        totalTurnMs: 62000,
        firstProviderRequestAtEpochMs: 52000,
        lastProviderResponseAtEpochMs: 52800,
        preProviderMs: 51000,
        providerFinalMs: 800,
        postProviderMs: 10200
      },
      timelineSummary: null,
      logSummary: { embeddedRuns: embedded }
    });
    assertEqual(breakdown.sourceLogs.categories.runtimePlugins.totalDurationMs, 7325, "embedded log source category");
    assertEqual(breakdown.sourceLogs.unmappedStages.some((stage) => stage.name === "attempt-dispatch"), true, "unmapped embedded stages preserved");
    assertEqual(
      summarizeAgentTurnBreakdownForMarkdown(breakdown).includes("embedded:attempt-dispatch"),
      true,
      "breakdown markdown includes raw unmapped stage evidence"
    );

    return {
      id: "embedded-run-log-parser",
      status: "PASS",
      command: "parse synthetic OpenClaw embedded-run and liveness logs",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "embedded-run-log-parser",
      status: "FAIL",
      command: "parse synthetic OpenClaw embedded-run and liveness logs",
      durationMs: 0,
      message: error.message
    };
  }
}

function runtimeDepsWarmReuseEvaluationCheck() {
  try {
    const coldLog = [
      "21:22:15 [plugins] browser staging bundled runtime deps (6 specs): @modelcontextprotocol/sdk@1.29.0",
      "21:22:19 [plugins] browser installed bundled runtime deps in 3964ms: @modelcontextprotocol/sdk@1.29.0",
      "21:22:19 [plugins] memory-core staging bundled runtime deps (2 specs): chokidar@^5.0.0",
      "21:22:20 [plugins] memory-core installed bundled runtime deps in 1529ms: chokidar@^5.0.0"
    ].join("\n");
    const scenario = {
      id: "bundled-runtime-deps",
      thresholds: {
        warmRuntimeDepsRestageCount: 0,
        warmRuntimeDepsStagingMs: 5000
      }
    };
    const surface = {
      id: "bundled-runtime-deps",
      thresholds: {}
    };
    const cleanRecord = runtimeDepsRecord({
      coldLog,
      warmLog: coldLog
    });
    evaluateRecord(cleanRecord, scenario, { surface, targetPlan: { kind: "npm" } });
    assertEqual(cleanRecord.status, "PASS", "warm reuse clean record status");
    assertEqual(cleanRecord.measurements.coldRuntimeDepsInstallCount, 2, "cold install count");
    assertEqual(cleanRecord.measurements.warmRuntimeDepsRestageCount, 0, "warm restage count");
    assertEqual(cleanRecord.measurements.runtimeDepsWarmReuseOk, true, "warm reuse ok");

    const restagedRecord = runtimeDepsRecord({
      coldLog,
      warmLog: [
        coldLog,
        "21:23:02 [plugins] browser staging bundled runtime deps (6 specs): @modelcontextprotocol/sdk@1.29.0",
        "21:23:08 [plugins] browser installed bundled runtime deps in 6100ms: @modelcontextprotocol/sdk@1.29.0"
      ].join("\n")
    });
    evaluateRecord(restagedRecord, scenario, { surface, targetPlan: { kind: "npm" } });
    assertEqual(restagedRecord.status, "FAIL", "warm restage record status");
    assertEqual(restagedRecord.measurements.warmRuntimeDepsRestageCount, 1, "warm restage failure count");
    assertEqual(restagedRecord.measurements.warmRuntimeDepsStagingMs, 6100, "warm restage failure duration");
    assertEqual(
      restagedRecord.violations.some((violation) => violation.metric === "warmRuntimeDepsRestageCount"),
      true,
      "warm restage count violation"
    );
    assertEqual(
      renderPasteSummary({
        runId: "self-check-runtime-deps",
        target: "runtime:stable",
        mode: "self-check",
        records: [restagedRecord]
      }).includes("warmRuntimeDepsRestageCount: 1"),
      true,
      "brief evidence includes warm runtime deps restage"
    );

    return {
      id: "runtime-deps-warm-reuse-evaluation",
      status: "PASS",
      command: "evaluate synthetic warm runtime dependency reuse",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "runtime-deps-warm-reuse-evaluation",
      status: "FAIL",
      command: "evaluate synthetic warm runtime dependency reuse",
      durationMs: 0,
      message: error.message
    };
  }
}

function runtimeDepsRecord({ coldLog, warmLog }) {
  return {
    scenario: "bundled-runtime-deps",
    status: "PASS",
    phases: [
      {
        id: "cold-start",
        results: [{ command: "ocm logs kova-runtime-deps --tail 300 --raw", status: 0, stdout: coldLog, stderr: "", durationMs: 100 }],
        metrics: {
          service: { gatewayState: "running" },
          logs: zeroLogMetrics()
        }
      },
      {
        id: "warm-restart",
        results: [{ command: "ocm logs kova-runtime-deps --tail 300 --raw", status: 0, stdout: warmLog, stderr: "", durationMs: 100 }],
        metrics: {
          service: { gatewayState: "running" },
          logs: zeroLogMetrics()
        }
      }
    ],
    finalMetrics: {
      service: { gatewayState: "running" },
      logs: zeroLogMetrics()
    }
  };
}

async function cleanupArtifactsCheck(tmp) {
  const home = join(tmp, "artifact-cleanup-home");
  const staleDir = join(home, "artifacts", "kova-2000-01-01t000000z");
  const keepDir = join(home, "artifacts", "not-a-kova-run");
  await mkdir(staleDir, { recursive: true });
  await mkdir(keepDir, { recursive: true });
  await writeFile(join(staleDir, "sample.txt"), "stale artifact\n", "utf8");
  const oldDate = new Date("2000-01-01T00:00:00.000Z");
  await utimes(staleDir, oldDate, oldDate);

  const dryRun = await runCommand(
    `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs cleanup artifacts --older-than-days 1 --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  if (dryRun.status !== 0) {
    return {
      id: "cleanup-artifacts",
      status: "FAIL",
      command: dryRun.command,
      durationMs: dryRun.durationMs,
      message: dryRun.stderr.trim() || dryRun.stdout.trim()
    };
  }
  const dryRunJson = JSON.parse(dryRun.stdout);
  assertEqual(dryRunJson.schemaVersion, "kova.cleanup.artifacts.v1", "cleanup artifacts schema");
  assertEqual(dryRunJson.execute, false, "cleanup artifacts dry-run");
  assertEqual(dryRunJson.candidates.length, 1, "cleanup artifacts candidate count");
  assertEqual(dryRunJson.candidates[0].name, "kova-2000-01-01t000000z", "cleanup artifacts candidate name");

  const execute = await runCommand(
    `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs cleanup artifacts --older-than-days 1 --execute --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  if (execute.status !== 0) {
    return {
      id: "cleanup-artifacts",
      status: "FAIL",
      command: execute.command,
      durationMs: execute.durationMs,
      message: execute.stderr.trim() || execute.stdout.trim()
    };
  }
  const executeJson = JSON.parse(execute.stdout);
  assertEqual(executeJson.execute, true, "cleanup artifacts execute");
  assertEqual(executeJson.results.length, 1, "cleanup artifacts result count");
  let staleStillExists = true;
  try {
    await stat(staleDir);
  } catch (error) {
    staleStillExists = error.code !== "ENOENT";
  }
  assertEqual(staleStillExists, false, "stale artifact directory removed");
  assertEqual((await stat(keepDir)).isDirectory(), true, "non-kova artifact directory retained");

  return {
    id: "cleanup-artifacts",
    status: "PASS",
    command: "node bin/kova.mjs cleanup artifacts --older-than-days 1 --execute --json",
    durationMs: dryRun.durationMs + execute.durationMs
  };
}

async function inventoryPlanCheck(tmp) {
  const binDir = join(tmp, "inventory-bin");
  const repoDir = join(tmp, "inventory-openclaw");
  const openclawBin = join(binDir, "openclaw");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(repoDir, "plugins", "bundled"), { recursive: true });
  await mkdir(join(repoDir, "extensions", "dashboard"), { recursive: true });
  await mkdir(join(repoDir, "src", "channels", "message"), { recursive: true });
  await writeFile(openclawBin, `#!/bin/sh
case "$1" in
  --help)
    cat <<'HELP'
Usage: openclaw <command>

Commands:
  Hint: commands suffixed with * have subcommands.
  dashboard  Start dashboard
  plugins *  Manage plugins
  unknownx   Experimental command
HELP
    ;;
  dashboard)
    echo "OpenClaw dashboard help"
    ;;
  plugins)
    echo "OpenClaw plugins help"
    ;;
  unknownx)
    echo "OpenClaw unknownx help"
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 2
    ;;
esac
`, "utf8");
  await chmod(openclawBin, 0o755);
  await writeFile(join(repoDir, "package.json"), `${JSON.stringify({
    name: "openclaw",
    scripts: {
      "audit:internal": "node scripts/internal-audit.mjs",
      build: "pnpm build",
      "release:check": "node scripts/release-check.mjs"
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(repoDir, "plugins", "bundled", "plugin.json"), `${JSON.stringify({
    name: "plugins",
    description: "Bundled plugin manifest",
    openclawPlugin: true
  }, null, 2)}\n`, "utf8");
  await writeFile(join(repoDir, "extensions", "dashboard", "manifest.json"), `${JSON.stringify({
    name: "dashboard",
    description: "Dashboard extension",
    openclawExtension: true
  }, null, 2)}\n`, "utf8");
  await writeFile(join(repoDir, "src", "channels", "message", "types.ts"), `export const durableFinalDeliveryCapabilities = [
  "text",
  "media",
  "poll",
  "payload",
  "silent",
  "replyTo",
  "thread",
  "nativeQuote",
  "messageSendingHooks",
  "batch",
  "reconcileUnknownSend",
  "afterSendSuccess",
  "afterCommit"
] as const;

export const channelMessageLiveCapabilities = [
  "draftPreview",
  "previewFinalization",
  "progressUpdates",
  "nativeStreaming",
  "quietFinalization"
] as const;

export const livePreviewFinalizerCapabilities = [
  "finalEdit",
  "normalFallback",
  "discardPending",
  "previewReceipt",
  "retainOnAmbiguousFailure"
] as const;

export const channelMessageReceiveAckPolicies = [
  "after_receive_record",
  "after_agent_dispatch",
  "after_durable_send",
  "manual"
] as const;
`, "utf8");

  return jsonCommandCheck(
    "inventory-plan-json",
    `node bin/kova.mjs inventory plan --openclaw-bin ${quoteShell(openclawBin)} --openclaw-repo ${quoteShell(repoDir)} --require-modeled cli:unknownx --json`,
    (data) => {
      assertEqual(data.schemaVersion, "kova.inventory.plan.v1", "inventory schema");
      assertEqual(data.sources?.find((source) => source.id === "openclaw-help")?.status, "scanned", "inventory help source");
      assertEqual(data.sources?.find((source) => source.id === "package-scripts")?.status, "scanned", "inventory package source");
      assertEqual(data.sources?.find((source) => source.id === "manifests")?.status, "scanned", "inventory manifests source");
      assertEqual(data.sources?.find((source) => source.id === "channel-capability-catalog")?.status, "matched", "inventory channel capability source catalog");
      assertEqual(data.channelCapabilityCatalog?.ok, true, "inventory channel capability catalog source comparison");
      assertEqual(data.sources?.find((source) => source.id === "package-scripts")?.includedScriptCount, 1, "inventory product script filter");
      assertEqual(data.capabilities?.some((capability) => capability.id === "cli:dashboard" && capability.matchedSurfaceIds?.includes("dashboard")), true, "dashboard command mapped");
      assertEqual(data.capabilities?.some((capability) => capability.id === "cli:Hint"), false, "help parser ignores help prose");
      assertEqual(data.capabilities?.some((capability) => capability.id === "cli:unknownx" && capability.matchStatus === "unmodeled"), true, "unknown command warning");
      assertEqual(data.capabilities?.some((capability) => capability.id === "script:release:check"), true, "product package scripts discovered");
      assertEqual(data.capabilities?.some((capability) => capability.id === "script:build"), false, "internal package scripts filtered");
      assertEqual(data.capabilities?.some((capability) => capability.kind === "plugin-manifest"), true, "plugin manifest discovered");
      assertEqual(data.capabilities?.some((capability) => capability.kind === "extension-manifest"), true, "extension manifest discovered");
      assertEqual((data.coverage?.warnings ?? []).some((warning) => warning.capability === "cli:unknownx"), true, "unmodeled warning emitted");
      assertEqual(data.coverage?.ok, false, "required unmodeled capability blocks inventory coverage");
      assertEqual((data.coverage?.blockers ?? []).some((blocker) => blocker.capability === "cli:unknownx"), true, "required unmodeled blocker emitted");
    }
  );
}

async function repeatedWorkAuditCheck() {
  const audit = await buildRepeatedWorkAudit();
  assertEqual(audit.schemaVersion, "kova.repeatedWorkAudit.v1", "repeated work audit schema");
  assertEqual(audit.scenarioCount > 0, true, "repeated work audit scenarios");
  assertEqual(audit.phaseCount > 0, true, "repeated work audit phases");
  assertEqual(
    Object.values(audit.profiles).some((profile) => profile.minimumCollectEnvMetrics > profile.entries),
    true,
    "repeated work audit profile collector floor"
  );
  assertEqual(
    audit.duplicateCommands.some((entry) => entry.command === "ocm @{env} -- status" && entry.count > 1),
    true,
    "repeated work audit duplicate status command"
  );
  assertEqual(
    audit.explicitEvidenceCommands.some((entry) => entry.kind === "logs"),
    false,
    "repeated work audit log evidence commands removed"
  );
  assertEqual(
    audit.explicitEvidenceCommands.length,
    0,
    "repeated work audit explicit evidence commands empty"
  );
  assertEqual(
    audit.commandReceiptLocks.some((lock) => lock.scenario === "release-runtime-startup"),
    false,
    "repeated work audit release receipt lock removed"
  );
  assertEqual(
    audit.commandReceiptLocks.some((lock) => lock.scenario === "official-plugin-install"),
    false,
    "repeated work audit official plugin receipt lock removed"
  );
  assertEqual(
    audit.commandReceiptLocks.length,
    0,
    "repeated work audit command receipt locks empty"
  );
  return {
    id: "repeated-work-audit",
    status: "PASS"
  };
}

async function collectionPolicyResolverCheck(tmp) {
  const policy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "fresh-install",
    surface: "fresh-install",
    phaseId: "provision",
    phaseHealthScope: "readiness",
    measurementScope: "product",
    resultStatus: "success"
  });
  assertEqual(policy.schemaVersion, "kova.collectionPolicy.v1", "collection policy schema");
  assertEqual(policy.mode, "full", "collection policy default mode");
  assertEqual(policy.context.scenario, "fresh-install", "collection policy scenario context");
  assertEqual(policy.context.phaseId, "provision", "collection policy phase context");
  for (const collector of ENV_COLLECTOR_IDS) {
    assertEqual(policy.collectors[collector], true, `collection policy keeps ${collector}`);
  }
  assertEqual(policy.skipped.length, 0, "scenario phase collection policy skips nothing");
  const postReadyWithoutIntentPolicy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "agent-cold-warm-message",
    surface: "agent-cli-local-turn",
    phaseId: "post-agent-health",
    phaseHealthScope: "post-ready",
    measurementScope: "product",
    resultStatus: "success"
  });
  assertEqual(postReadyWithoutIntentPolicy.mode, "full", "post-ready healthScope without collection intent keeps full collection");

  const postReadyPolicy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "agent-cold-warm-message",
    surface: "agent-cli-local-turn",
    phaseId: "post-agent-health",
    phaseHealthScope: "post-ready",
    measurementScope: "product",
    collectionIntent: "post-ready-health",
    resultStatus: "success"
  });
  assertEqual(postReadyPolicy.mode, "post-ready-health", "post-ready phase policy mode");
  assertEqual(postReadyPolicy.context.collectionIntent, "post-ready-health", "post-ready phase records collection intent");
  assertEqual(postReadyPolicy.readiness, "none", "post-ready phase skips readiness wait");
  assertEqual(postReadyPolicy.healthSamples, true, "post-ready phase keeps health samples");
  assertEqual(postReadyPolicy.collectors.logs, true, "post-ready phase keeps logs");
  assertEqual(postReadyPolicy.collectors.timeline, true, "post-ready phase keeps timeline");

  const authPreparePolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-prepare",
    measurementScope: "harness",
    collectionIntent: "skip-env",
    resultStatus: "success"
  });
  assertEqual(authPreparePolicy.mode, "skip-env", "successful auth prepare skips env metrics");
  assertEqual(authPreparePolicy.collectors.service, false, "successful auth prepare skips service collector");
  assertEqual(authPreparePolicy.skipped.length, ENV_COLLECTOR_IDS.length, "auth prepare skipped collector list");

  const failedAuthCleanupPolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-cleanup",
    measurementScope: "cleanup",
    collectionIntent: "skip-env",
    resultStatus: "failure"
  });
  assertEqual(failedAuthCleanupPolicy.mode, "full", "failed auth cleanup keeps full collection");

  const authSetupPolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-setup",
    measurementScope: "harness",
    collectionIntent: "service-only",
    resultStatus: "success"
  });
  assertEqual(authSetupPolicy.mode, "service-only", "successful auth setup uses service-only collection");
  assertEqual(authSetupPolicy.collectors.service, true, "auth setup keeps service collector");
  assertEqual(authSetupPolicy.collectors.process, true, "auth setup keeps process collector");
  assertEqual(authSetupPolicy.collectors.logs, false, "auth setup skips logs collector");
  assertEqual(authSetupPolicy.collectors.timeline, false, "auth setup skips timeline collector");

  const noServicePolicy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "gateway-session-send-turn",
    surface: "gateway-session-send-turn",
    phaseId: "provision",
    phaseHealthScope: "none",
    measurementScope: "product",
    collectionIntent: "service-only",
    resultStatus: "success",
    hasNoServiceCommand: true
  });
  assertEqual(noServicePolicy.mode, "service-only", "successful no-service phase uses service-only collection");
  assertEqual(noServicePolicy.collectors.service, true, "no-service phase keeps service collector");
  assertEqual(noServicePolicy.collectors.readiness, false, "no-service phase skips readiness collector");
  assertEqual(noServicePolicy.collectors.logs, false, "no-service phase skips logs collector");

  const stateSetupPolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    scenario: "gateway-session-send-turn",
    surface: "gateway-session-send-turn",
    phaseId: "provision",
    measurementScope: "harness",
    lifecycleKind: "state-provision",
    collectionIntent: "service-only",
    resultStatus: "success"
  });
  assertEqual(stateSetupPolicy.mode, "service-only", "successful state setup uses service-only collection");
  assertEqual(stateSetupPolicy.context.lifecycleKind, "state-provision", "state setup policy records lifecycle kind");
  assertEqual(stateSetupPolicy.collectors.service, true, "state setup keeps service collector");
  assertEqual(stateSetupPolicy.collectors.readiness, false, "state setup skips readiness collector");
  assertEqual(stateSetupPolicy.collectors.logs, false, "state setup skips logs collector");

  const failedStateSetupPolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    phaseId: "provision",
    measurementScope: "harness",
    lifecycleKind: "state-provision",
    collectionIntent: "service-only",
    resultStatus: "failure"
  });
  assertEqual(failedStateSetupPolicy.mode, "full", "failed state setup keeps full collection");

  const hostStatePreparePolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    phaseId: null,
    measurementScope: "harness",
    lifecycleKind: "prepare",
    lifecycleCommandScope: "host",
    collectionIntent: "skip-env",
    resultStatus: "success"
  });
  assertEqual(hostStatePreparePolicy.mode, "skip-env", "successful host-only state prepare skips env metrics");
  assertEqual(hostStatePreparePolicy.context.lifecycleCommandScope, "host", "host state prepare records command scope");
  assertEqual(hostStatePreparePolicy.collectors.service, false, "host state prepare skips service collector");

  const envStatePreparePolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    phaseId: null,
    measurementScope: "harness",
    lifecycleKind: "prepare",
    lifecycleCommandScope: "env",
    collectionIntent: "skip-env",
    resultStatus: "success"
  });
  assertEqual(envStatePreparePolicy.mode, "skip-env", "collection intent, not command scope, drives env state prepare collection");

  const skippedMetrics = await collectEnvMetrics("kova-self-check-skip-env", {
    collectionPolicy: authPreparePolicy
  });
  assertEqual(skippedMetrics.service, null, "skipped env metrics avoid service collection");
  assertEqual(
    skippedMetrics.collectors.every((collector) => collector.status === "SKIPPED"),
    true,
    "skipped env metrics records skipped collectors"
  );
  assertEqual(skippedMetrics.collectors.length, ENV_COLLECTOR_IDS.length, "skipped env metrics receipt count");

  const hostStatePrepareMetrics = await collectEnvMetrics("kova-self-check-host-state-prepare", {
    collectionPolicy: hostStatePreparePolicy
  });
  assertEqual(hostStatePrepareMetrics.service, null, "host state prepare metrics avoid service collection");
  assertEqual(
    hostStatePrepareMetrics.collectors.every((collector) => collector.status === "SKIPPED"),
    true,
    "host state prepare metrics records skipped collectors"
  );

  const authSetupMetrics = await collectPostReadySelfCheckMetrics(tmp, authSetupPolicy);
  assertEqual(authSetupMetrics.service?.gatewayState, "running", "auth setup service-only keeps service state");
  assertEqual(Boolean(authSetupMetrics.process), true, "auth setup service-only keeps process metrics");
  assertEqual(authSetupMetrics.logs, null, "auth setup service-only skips logs payload");
  assertEqual(authSetupMetrics.timeline, null, "auth setup service-only skips timeline payload");
  assertEqual(authSetupMetrics.diagnostics, null, "auth setup service-only skips diagnostics payload");
  assertEqual(
    authSetupMetrics.collectors.some((collector) => collector.id === "logs" && collector.status === "SKIPPED"),
    true,
    "auth setup service-only records skipped logs"
  );
  assertEqual(
    authSetupMetrics.collectors.some((collector) => collector.id === "timeline" && collector.status === "SKIPPED"),
    true,
    "auth setup service-only records skipped timeline"
  );

  const stateSetupMetrics = await collectPostReadySelfCheckMetrics(tmp, stateSetupPolicy);
  assertEqual(stateSetupMetrics.service?.gatewayState, "running", "state setup service-only keeps service state");
  assertEqual(Boolean(stateSetupMetrics.process), true, "state setup service-only keeps process metrics");
  assertEqual(stateSetupMetrics.logs, null, "state setup service-only skips logs payload");
  assertEqual(stateSetupMetrics.timeline, null, "state setup service-only skips timeline payload");
  assertEqual(stateSetupMetrics.diagnostics, null, "state setup service-only skips diagnostics payload");
  assertEqual(
    stateSetupMetrics.collectors.some((collector) => collector.id === "logs" && collector.status === "SKIPPED"),
    true,
    "state setup service-only records skipped logs"
  );

  const postReadyMetrics = await collectPostReadySelfCheckMetrics(tmp, postReadyPolicy);
  assertEqual(postReadyMetrics.readiness?.attempts, 0, "post-ready metrics do not run readiness attempts");
  assertEqual(postReadyMetrics.healthSummary?.count, 2, "post-ready metrics keep health samples");
  assertEqual(postReadyMetrics.healthSummary?.failureCount, 0, "post-ready metrics health samples pass");
  assertEqual(
    postReadyMetrics.collectors.some((collector) => collector.id === "readiness" && collector.status === "INFO"),
    true,
    "post-ready metrics records readiness as not applicable"
  );
  assertEqual(
    postReadyMetrics.collectors.some((collector) => collector.id === "health" && collector.status === "PASS"),
    true,
    "post-ready metrics records health collector"
  );
  return {
    id: "collection-policy-resolver",
    status: "PASS"
  };
}

async function collectPostReadySelfCheckMetrics(tmp, collectionPolicy) {
  const fakeBin = join(tmp, "post-ready-policy-bin");
  const fakeOcm = join(fakeBin, "ocm");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'service' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({ gatewayState: 'running', running: true, desiredRunning: true, childPid: Number(process.env.KOVA_FAKE_CHILD_PID), gatewayPort: Number(process.env.KOVA_FAKE_PORT), runtimeReleaseVersion: 'self-check', runtimeReleaseChannel: 'test' }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'logs') {",
    "  process.stdout.write('gateway ready\\n');",
    "  process.exit(0);",
    "}",
    "process.stdout.write('\\n');"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const previousPath = process.env.PATH;
  const previousPort = process.env.KOVA_FAKE_PORT;
  const previousChildPid = process.env.KOVA_FAKE_CHILD_PID;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  process.env.KOVA_FAKE_PORT = String(port);
  process.env.KOVA_FAKE_CHILD_PID = String(process.pid);
  try {
    return await collectEnvMetrics("kova-self-check-post-ready", {
      collectionPolicy,
      timeoutMs: 1000,
      healthSamples: 2,
      healthIntervalMs: 0,
      readinessTimeoutMs: 0
    });
  } finally {
    process.env.PATH = previousPath;
    restoreOptionalEnv("KOVA_FAKE_PORT", previousPort);
    restoreOptionalEnv("KOVA_FAKE_CHILD_PID", previousChildPid);
    await new Promise((resolve) => server.close(resolve));
  }
}

function restoreOptionalEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function readinessClassificationCheck() {
  try {
    const record = {
      status: "PASS",
      phases: [
        {
          id: "provision",
          healthScope: "readiness",
          results: [],
          metrics: {
            readiness: {
              deadlineMs: 90000,
              thresholdMs: 30000,
              ready: true,
              listeningReady: true,
              listeningReadyAtMs: 47000,
              healthReadyAtMs: 47100,
              classification: {
                state: "slow-startup",
                severity: "fail",
                reason: "gateway became healthy after 47100ms, beyond the 30000ms threshold"
              }
            },
            logs: {
              missingDependencyErrors: 0,
              pluginLoadFailures: 0,
              metadataScanMentions: 0,
              configNormalizationMentions: 0,
              gatewayRestartMentions: 0,
              providerLoadMentions: 0,
              modelCatalogMentions: 0,
              providerTimeoutMentions: 0,
              eventLoopDelayMentions: 0,
              v8DiagnosticMentions: 0
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: {
          missingDependencyErrors: 0,
          pluginLoadFailures: 0,
          metadataScanMentions: 0,
          configNormalizationMentions: 0,
          gatewayRestartMentions: 0,
          providerLoadMentions: 0,
          modelCatalogMentions: 0,
          providerTimeoutMentions: 0,
          eventLoopDelayMentions: 0,
          v8DiagnosticMentions: 0
        }
      }
    };
    evaluateRecord(record, { thresholds: { gatewayReadyMs: 30000 } });
    assertEqual(record.status, "FAIL", "slow readiness status");
    assertEqual(record.measurements.health.readiness.classification, "slow-startup", "readiness classification");
    assertEqual(
      record.violations.some((violation) => violation.metric === "readiness.classification"),
      true,
      "readiness violation"
    );
    const healthReadyClassification = classifyReadiness({
      thresholdMs: 30000,
      listeningReadyAtMs: null,
      healthReadyAtMs: 6802
    });
    assertEqual(healthReadyClassification.state, "ready", "health success proves readiness even when raw TCP probe timed out first");
    return {
      id: "readiness-classification",
      status: "PASS",
      command: "evaluate synthetic slow readiness record",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "readiness-classification",
      status: "FAIL",
      command: "evaluate synthetic slow readiness record",
      durationMs: 0,
      message: error.message
    };
  }
}

function healthReadinessModelCheck() {
  try {
    const record = {
      status: "PASS",
      phases: [
        {
          id: "cold-start",
          healthScope: "readiness",
          results: [],
          metrics: {
            readiness: {
              deadlineMs: 90000,
              thresholdMs: 30000,
              ready: true,
              listeningReady: true,
              listeningReadyAtMs: 120,
              healthReadyAtMs: 200,
              attempts: 2,
              classification: {
                state: "ready",
                severity: "pass",
                reason: "gateway became healthy within the readiness threshold"
              },
              healthAttempts: [
                { ok: false, durationMs: 25 },
                { ok: true, durationMs: 30 }
              ]
            },
            healthSamples: [
              { ok: true, durationMs: 40 }
            ],
            healthSummary: {
              count: 1,
              okCount: 1,
              failureCount: 0,
              minMs: 40,
              p50Ms: 40,
              p95Ms: 40,
              maxMs: 40
            }
          }
        },
        {
          id: "api-latency",
          healthScope: "post-ready",
          results: [],
          metrics: {
            healthSamples: [
              { ok: true, durationMs: 10 },
              { ok: true, durationMs: 1500 }
            ],
            healthSummary: {
              count: 2,
              okCount: 2,
              failureCount: 0,
              minMs: 10,
              p50Ms: 10,
              p95Ms: 1500,
              maxMs: 1500
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        healthSamples: [{ ok: true, durationMs: 50 }],
        healthSummary: {
          count: 1,
          okCount: 1,
          failureCount: 0,
          minMs: 50,
          p50Ms: 50,
          p95Ms: 50,
          maxMs: 50
        },
        health: { ok: true, durationMs: 50 }
      }
    };
    const scenario = {
      phases: [
        { id: "cold-start", healthScope: "readiness" },
        { id: "api-latency", healthScope: "post-ready" }
      ],
      thresholds: {
        gatewayReadyMs: 30000,
        postReadyHealthP95Ms: 1000
      }
    };
    evaluateRecord(record, scenario);
    assertEqual(record.status, "FAIL", "post-ready health threshold fails");
    assertEqual(record.measurements.health.schemaVersion, "kova.health.v1", "health schema");
    assertEqual(record.measurements.health.readiness.healthReadyAtMs, 200, "readiness health ready captured");
    assertEqual(record.measurements.health.startupSamples.p95Ms, 30, "startup health p95 derived from readiness attempts");
    assertEqual(record.measurements.health.postReadySamples.p95Ms, 1500, "post-ready health p95 derived from post-ready samples");
    assertEqual(record.measurements.health.slowestSample.scope, "post-ready", "slowest health scope");
    assertEqual(
      record.violations.some((violation) => violation.metric === "postReadyHealthP95Ms"),
      true,
      "post-ready health violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "readinessHealthReadyMs"),
      false,
      "post-ready liveness does not masquerade as readiness"
    );
    return {
      id: "health-readiness-model",
      status: "PASS",
      command: "evaluate synthetic scoped health record",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "health-readiness-model",
      status: "FAIL",
      command: "evaluate synthetic scoped health record",
      durationMs: 0,
      message: error.message
    };
  }
}

function healthFailureThresholdPolicyCheck() {
  try {
    const policy = resolveThresholdPolicy({
      scenario: {
        id: "synthetic-health-policy",
        thresholds: {
          postReadyHealthP95Ms: 1000
        }
      }
    });
    assertEqual(policy.thresholds.postReadyHealthFailures, 0, "post-ready health latency derives failed-sample gate");
    assertEqual(policy.thresholds.finalHealthFailures, 0, "post-ready health latency derives final failed-sample gate");
    assertEqual(
      policy.report.sources.some((source) =>
        source.kind === "derived" && source.thresholds.includes("postReadyHealthFailures")
      ),
      true,
      "derived health thresholds are reported"
    );

    const explicitPolicy = resolveThresholdPolicy({
      scenario: {
        id: "synthetic-explicit-health-policy",
        thresholds: {
          postReadyHealthP95Ms: 1000,
          postReadyHealthFailures: 2,
          finalHealthFailures: 1
        }
      }
    });
    assertEqual(explicitPolicy.thresholds.postReadyHealthFailures, 2, "explicit post-ready failure budget is preserved");
    assertEqual(explicitPolicy.thresholds.finalHealthFailures, 1, "explicit final failure budget is preserved");

    const record = {
      status: "PASS",
      phases: [
        {
          id: "api-latency",
          healthScope: "post-ready",
          results: [],
          metrics: {
            healthSamples: [
              { ok: false, durationMs: 2, error: "fetch failed" },
              { ok: true, durationMs: 20 }
            ],
            healthSummary: {
              count: 2,
              okCount: 1,
              failureCount: 1,
              minMs: 20,
              p50Ms: 20,
              p95Ms: 20,
              maxMs: 20
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        healthSamples: [{ ok: false, durationMs: 1, error: "fetch failed" }],
        healthSummary: {
          count: 1,
          okCount: 0,
          failureCount: 1,
          minMs: null,
          p50Ms: null,
          p95Ms: null,
          maxMs: null
        }
      }
    };
    evaluateRecord(record, { id: "synthetic-health-policy", thresholds: { postReadyHealthP95Ms: 1000 } });
    assertEqual(record.status, "FAIL", "failed health samples fail even when p95 latency is under threshold");
    assertEqual(
      record.violations.some((violation) => violation.metric === "postReadyHealthFailures"),
      true,
      "post-ready failed samples are violations"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "finalHealthFailures"),
      true,
      "final failed samples are violations"
    );
    return {
      id: "health-failure-threshold-policy",
      status: "PASS",
      command: "evaluate derived health failure thresholds",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "health-failure-threshold-policy",
      status: "FAIL",
      command: "evaluate derived health failure thresholds",
      durationMs: 0,
      message: error.message
    };
  }
}

function agentContainmentHealthScopeCheck() {
  try {
    const record = {
      scenario: "gateway-session-send-turn",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "gateway-start",
          results: [],
          metrics: {
            logs: zeroLogMetrics(),
            readiness: {
              listeningReadyAtMs: 100,
              healthReadyAtMs: 300,
              thresholdMs: 30000,
              deadlineMs: 90000,
              attempts: 3,
              classification: {
                state: "ready",
                severity: "pass",
                reason: "synthetic startup recovered"
              },
              healthAttempts: [
                { ok: false, durationMs: 0 },
                { ok: false, durationMs: 1 },
                { ok: true, durationMs: 10 }
              ]
            },
            healthSummary: {
              count: 3,
              okCount: 1,
              failureCount: 2,
              minMs: 0,
              p50Ms: 1,
              p95Ms: 10,
              maxMs: 10
            }
          }
        },
        {
          id: "cold-gateway-session-turn",
          results: [{
            command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
            status: 0,
            timedOut: false,
            startedAt: "2026-05-06T10:00:01.000Z",
            startedAtEpochMs: 1778061601000,
            finishedAt: "2026-05-06T10:00:01.400Z",
            finishedAtEpochMs: 1778061601400,
            durationMs: 400,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
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
          metrics: {
            logs: zeroLogMetrics(),
            health: { ok: true, durationMs: 2 },
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
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [{
          requestId: "provider",
          receivedAt: "2026-05-06T10:00:01.100Z",
          receivedAtEpochMs: 1778061601100,
          respondedAt: "2026-05-06T10:00:01.200Z",
          respondedAtEpochMs: 1778061601200,
          firstByteLatencyMs: 5,
          firstChunkLatencyMs: 5,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          statusClass: "2xx"
        }]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        health: { ok: true, durationMs: 1 },
        healthSummary: {
          count: 1,
          okCount: 1,
          failureCount: 0,
          minMs: 1,
          p50Ms: 1,
          p95Ms: 1,
          maxMs: 1
        }
      }
    };

    evaluateRecord(record, {
      id: "gateway-session-send-turn",
      phases: [
        { id: "gateway-start", healthScope: "readiness" },
        { id: "cold-gateway-session-turn", healthScope: "post-ready" }
      ],
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        agentContainmentHealthFailures: 0,
        agentProcessLeaks: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });

    assertEqual(record.status, "PASS", "startup health failures should not fail post-agent containment");
    assertEqual(record.measurements.health.startupSamples.failureCount, 2, "startup failures retained");
    assertEqual(record.measurements.health.postReadySamples.failureCount, 0, "post-ready failures absent");
    assertEqual(record.measurements.agentFailureContainment.healthFailures, 0, "containment excludes startup failures");
    assertEqual(record.measurements.agentFailureContainment.healthFailureBreakdown.startup, 2, "containment reports startup failures separately");
    assertEqual(record.measurements.agentFailureContainment.gatewayHealthy, true, "gateway containment healthy");
    assertEqual(
      (record.violations ?? []).some((violation) => violation.metric === "agentGatewayHealthy"),
      false,
      "startup readiness failures do not create agentGatewayHealthy violation"
    );

    return {
      id: "agent-containment-health-scope",
      status: "PASS",
      command: "evaluate agent containment scoped health failures",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-containment-health-scope",
      status: "FAIL",
      command: "evaluate agent containment scoped health failures",
      durationMs: 0,
      message: error.message
    };
  }
}

async function resourceRoleAttributionCheck(tmp) {
  const command = "node -e 'setTimeout(() => {}, 650)'";
  const artifactPath = join(tmp, "resource-role-attribution.jsonl");
  const result = await runCommand(command, {
    timeoutMs: 5000,
    resourceSample: {
      intervalMs: 250,
      processRoles: await loadProcessRoles(),
      artifactPath
    }
  });

  try {
    assertEqual(result.status, 0, "resource attribution command status");
    assertEqual(result.resourceSamples?.schemaVersion, "kova.resourceSamples.v1", "resource schema");
    assertEqual(Boolean(result.resourceSamples?.byRole?.["command-tree"]), true, "command-tree role");
    assertEqual(Boolean(result.resourceSamples?.byRole?.uncategorized), true, "uncategorized role");
    assertArrayNotEmpty(result.resourceSamples?.topRolesByRss, "top roles by RSS");
    assertString(result.resourceSamples?.artifactPath, "resource artifact path");
    return {
      id: "resource-role-attribution",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "resource-role-attribution",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function resourceRootCommandRoleBoundaryCheck() {
  try {
    const processRoles = await loadProcessRoles();
    const gatewayRoles = classifyRegistryRolesForProcess(
      { command: "openclaw-gateway" },
      {
        processRoles,
        rootCommand: "node support/mcp-bridge-smoke.mjs --env kova-mcp-runtime-start-stop",
        existingRoles: ["gateway", "gateway-tree"]
      }
    );
    const commandRoles = classifyRegistryRolesForProcess(
      { command: "node support/mcp-bridge-smoke.mjs --env kova-mcp-runtime-start-stop" },
      {
        processRoles,
        rootCommand: "node support/mcp-bridge-smoke.mjs --env kova-mcp-runtime-start-stop",
        existingRoles: ["command-tree"]
      }
    );

    assertEqual(gatewayRoles.includes("mcp-runtime"), false, "root command role must not tag gateway process");
    assertEqual(commandRoles.includes("mcp-runtime"), true, "root command role tags command tree process");
    return {
      id: "resource-root-command-role-boundary",
      status: "PASS",
      command: "classify synthetic gateway and command-tree roles",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-root-command-role-boundary",
      status: "FAIL",
      command: "classify synthetic gateway and command-tree roles",
      durationMs: 0,
      message: error.message
    };
  }
}

async function resourceRolePollutionCheck() {
  try {
    const processRoles = await loadProcessRoles();
    const mockProviderCommand = "mock-ai-provider serve --providers openai --marker KOVA_AGENT_OK";
    const mockProviderRoles = classifyRegistryRolesForProcess(
      { command: `/bin/zsh -lc ${mockProviderCommand}` },
      {
        processRoles,
        rootCommand: mockProviderCommand,
        existingRoles: ["command-tree"]
      }
    );
    const envNameCommand = "ocm env exec kova-mcp-runtime-start-stop -- node support/configure-openclaw-mock-auth.mjs";
    const envNameRoles = classifyRegistryRolesForProcess(
      { command: envNameCommand },
      {
        processRoles,
        rootCommand: envNameCommand,
        existingRoles: ["command-tree"]
      }
    );
    const openclawAgentRoles = classifyRegistryRolesForProcess(
      { command: "openclaw-agent" },
      {
        processRoles,
        rootCommand: "ocm @kova -- agent --local --message hi",
        existingRoles: ["command-tree"]
      }
    );
    const resourceSummary = summarizeResourceSamples([{
      timestamp: "2026-05-07T00:00:00.000Z",
      elapsedMs: 1000,
      processes: [
        {
          pid: 100,
          rssMb: 700,
          cpuPercent: 100,
          roles: ["gateway", "gateway-tree"],
          role: "gateway,gateway-tree",
          command: "openclaw"
        },
        {
          pid: 101,
          rssMb: 60,
          cpuPercent: 1,
          roles: ["command-tree", "gateway-session-client"],
          role: "command-tree,gateway-session-client",
          command: "node support/run-gateway-session-send-turn.mjs"
        }
      ]
    }]);

    assertEqual(mockProviderRoles.includes("mock-provider"), true, "mock provider helper remains classified");
    assertEqual(mockProviderRoles.includes("agent-cli"), false, "KOVA_AGENT_OK marker must not imply agent-cli");
    assertEqual(mockProviderRoles.includes("agent-process"), false, "KOVA_AGENT_OK marker must not imply agent-process");
    assertEqual(mockProviderRoles.includes("browser-sidecar"), false, "browser env name must not imply browser-sidecar");
    assertEqual(envNameRoles.includes("runtime-management"), false, "mcp-runtime env name must not imply runtime-management");
    assertEqual(envNameRoles.includes("model-cli"), false, "configure-openclaw fixture helper must not imply model-cli");
    assertEqual(openclawAgentRoles.includes("agent-cli"), true, "openclaw-agent process must imply agent-cli");
    assertEqual(openclawAgentRoles.includes("agent-process"), true, "openclaw-agent process must imply agent-process");
    assertEqual(resourceSummary.peakGatewayRssMb, 700, "gateway-session-client role must not inflate gateway RSS");
    assertEqual(resourceSummary.peakCommandTreeRssMb, 60, "gateway-session-client remains command-tree RSS");
    return {
      id: "resource-role-pollution-boundary",
      status: "PASS",
      command: "classify synthetic helper commands for role pollution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-role-pollution-boundary",
      status: "FAIL",
      command: "classify synthetic helper commands for role pollution",
      durationMs: 0,
      message: error.message
    };
  }
}

async function gatewaySessionSurfaceContractCheck() {
  try {
    const surface = JSON.parse(await readFile("surfaces/gateway-session-send-turn.json", "utf8"));
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = ["agent.turn", "agent.prepare", "models.catalog", "provider.request", "agent.cleanup", "gateway.chat_send", "auto_reply", "reply"];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `gateway session surface must not require stale ${span} span`);
    }
    assertEqual(expectedSpans.includes("gateway.ready"), true, "gateway session surface requires readiness spans observed by release runtimes");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "gateway session surface requires metadata scan spans used for active-turn attribution");
    return {
      id: "gateway-session-surface-contract",
      status: "PASS",
      command: "validate gateway session surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-surface-contract",
      status: "FAIL",
      command: "validate gateway session surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

async function releaseRuntimeStartupSurfaceContractCheck() {
  try {
    const scenario = JSON.parse(await readFile("scenarios/release-runtime-startup.json", "utf8"));
    const surface = JSON.parse(await readFile("surfaces/release-runtime-startup.json", "utf8"));
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = ["gateway.startup", "plugins.runtimeDeps", "health.ready"];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `release startup surface must not require stale ${span} span`);
    }
    assertEqual(scenario.auth?.mode, "skip", "release startup scenario skips provider auth setup");
    assertEqual(surface.resourcePrimaryRole, "gateway", "release startup resource gate is gateway-scoped");
    assertEqual(expectedSpans.includes("gateway.ready"), true, "release startup surface requires gateway.ready timeline span");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "release startup surface requires plugin metadata scan timeline span");
    assertEqual(expectedSpans.includes("plugins.load"), true, "release startup surface requires plugin load timeline span");
    return {
      id: "release-runtime-startup-surface-contract",
      status: "PASS",
      command: "validate release runtime startup surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "release-runtime-startup-surface-contract",
      status: "FAIL",
      command: "validate release runtime startup surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

async function officialPluginInstallSurfaceContractCheck() {
  try {
    const surface = JSON.parse(await readFile("surfaces/official-plugin-install.json", "utf8"));
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = ["plugins.install", "plugins.registry.refresh", "plugins.security.scan"];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `official plugin surface must not require stale ${span} span`);
    }
    assertEqual(surface.roleThresholds?.["plugin-cli"]?.peakRssMb >= 900, true, "official plugin cli RSS budget covers real release install path");
    assertEqual(expectedSpans.includes("gateway.ready"), true, "official plugin surface requires gateway.ready timeline span");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "official plugin surface requires plugin metadata scan timeline span");
    return {
      id: "official-plugin-install-surface-contract",
      status: "PASS",
      command: "validate official plugin install surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "official-plugin-install-surface-contract",
      status: "FAIL",
      command: "validate official plugin install surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

async function agentCliLocalTurnSurfaceContractCheck() {
  try {
    const surface = JSON.parse(await readFile("surfaces/agent-cli-local-turn.json", "utf8"));
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = [
      "agent.turn",
      "agent.prepare",
      "agent.runtimeCapabilities",
      "channel.capabilities",
      "channel.plugin.load",
      "models.catalog",
      "provider.request",
      "agent.cleanup"
    ];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `agent CLI surface must not require stale ${span} span`);
    }
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "agent CLI surface requires plugin metadata scan timeline span");
    return {
      id: "agent-cli-local-turn-surface-contract",
      status: "PASS",
      command: "validate agent CLI local turn surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cli-local-turn-surface-contract",
      status: "FAIL",
      command: "validate agent CLI local turn surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

async function agentGatewayRpcTurnSurfaceContractCheck() {
  try {
    const surface = JSON.parse(await readFile("surfaces/agent-gateway-rpc-turn.json", "utf8"));
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = [
      "agent.turn",
      "agent.prepare",
      "models.catalog",
      "provider.request",
      "agent.cleanup"
    ];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `agent Gateway RPC surface must not require stale ${span} span`);
    }
    assertEqual(expectedSpans.includes("gateway.ready"), true, "agent Gateway RPC surface requires gateway.ready timeline span");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "agent Gateway RPC surface requires plugin metadata scan timeline span");
    return {
      id: "agent-gateway-rpc-turn-surface-contract",
      status: "PASS",
      command: "validate agent Gateway RPC surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-gateway-rpc-turn-surface-contract",
      status: "FAIL",
      command: "validate agent Gateway RPC surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

async function processSnapshotCheck(tmp) {
  const processRoles = await loadProcessRoles();
  const child = runCommand("node -e 'setTimeout(() => {}, 1200)'", {
    timeoutMs: 5000,
    resourceSample: null
  });
  await sleep(250);
  const before = captureProcessSnapshot({
    processRoles,
    envName: "kova-self-check",
    rootCommand: "ocm @kova-self-check -- agent --local --session-id kova-agent-self-check --message hi"
  });
  const result = await child;
  const after = captureProcessSnapshot({
    processRoles,
    envName: "kova-self-check",
    rootCommand: "ocm @kova-self-check -- agent --local --session-id kova-agent-self-check --message hi"
  });
  const leaks = diffProcessSnapshots(before, after, {
    roles: ["agent-cli", "agent-process", "mcp-runtime", "plugin-cli", "mock-provider", "browser-sidecar"]
  });
  const artifactPath = join(tmp, "process-snapshot-leaks.json");
  await writeFile(artifactPath, `${JSON.stringify(leaks, null, 2)}\n`, "utf8");

  try {
    const unrelatedBrowserRoles = classifySnapshotRolesForProcess({
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer"
    }, {
      processRoles,
      envName: "kova-self-check",
      rootCommand: "ocm @kova-self-check -- agent --local --session-id kova-agent-self-check --message hi"
    });
    const scopedBrowserRoles = classifySnapshotRolesForProcess({
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/kova-self-check/browser"
    }, {
      processRoles,
      envName: "kova-self-check",
      rootCommand: "ocm @kova-self-check -- agent --local --session-id kova-agent-self-check --message hi"
    });
    const gatewayBrowserRoles = classifySnapshotRolesForProcess({
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer"
    }, {
      processRoles,
      existingRoles: ["gateway-tree"],
      envName: "kova-self-check"
    });
    const scopedAgentRoles = classifySnapshotRolesForProcess({
      command: "openclaw-agent --session-id kova-agent-self-check"
    }, {
      processRoles,
      envName: "kova-self-check",
      rootCommand: "ocm @kova-self-check -- agent --local --session-id kova-agent-self-check --message hi"
    });
    assertEqual(result.status, 0, "snapshot command status");
    assertEqual(before.schemaVersion, "kova.processSnapshot.v1", "snapshot schema");
    assertEqual(leaks.schemaVersion, "kova.processLeakSummary.v1", "leak summary schema");
    assertEqual(typeof leaks.leakCount, "number", "leak count type");
    assertEqual(unrelatedBrowserRoles.includes("browser-sidecar"), false, "unrelated browser process excluded from snapshot role");
    assertEqual(scopedBrowserRoles.includes("browser-sidecar"), true, "scoped browser process retained");
    assertEqual(gatewayBrowserRoles.includes("browser-sidecar"), true, "gateway child browser process retained");
    assertEqual(scopedAgentRoles.includes("agent-cli"), true, "scoped agent process retained");
    return {
      id: "process-snapshot-leak-contract",
      status: "PASS",
      command: "capture and diff role-aware process snapshots",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "process-snapshot-leak-contract",
      status: "FAIL",
      command: "capture and diff role-aware process snapshots",
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function roleThresholdEvaluationCheck() {
  try {
    const record = {
      scenario: "synthetic-role-threshold",
      title: "Synthetic Role Threshold",
      status: "PASS",
      phases: [
        {
          id: "sample",
          results: [
            {
              command: "synthetic",
              status: 0,
              durationMs: 1,
              resourceSamples: {
                schemaVersion: "kova.resourceSamples.v1",
                sampleCount: 1,
                peakTotalRssMb: 250,
                maxTotalCpuPercent: 80,
                byRole: {
                  gateway: {
                    peakRssMb: 250,
                    maxCpuPercent: 80,
                    peakRssAtMs: 10,
                    peakCpuAtMs: 10,
                    peakProcessCount: 1
                  }
                },
                topRolesByRss: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
                topRolesByCpu: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
                topByRss: [],
                topByCpu: []
              }
            }
          ],
          metrics: {
            logs: zeroLogMetrics()
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, { thresholds: {} }, {
      surface: {
        thresholds: {},
        roleThresholds: {
          gateway: { peakRssMb: 100, maxCpuPercent: 50 }
        }
      }
    });
    assertEqual(record.status, "FAIL", "role threshold status");
    assertEqual(record.measurements.resourceByRole.gateway.peakRssMb, 250, "gateway role RSS measurement");
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"),
      true,
      "role RSS violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.maxCpuPercent"),
      true,
      "role CPU violation"
    );
    const reportScenarios = aggregateScenarios({
      records: [record],
      summary: { total: 1, statuses: { FAIL: 1 } }
    });
    const peakRow = reportScenarios[0]?.metrics?.find((metric) => metric.key === "peakRssMb");
    const gatewayRow = reportScenarios[0]?.metrics?.find((metric) => metric.key === "peakRssMb#gateway");
    assertEqual(peakRow?.status, "FAIL", "parent RSS row inherits failed role child status");
    assertEqual(gatewayRow?.status, "FAIL", "gateway role child row fails");
    return {
      id: "resource-role-thresholds",
      status: "PASS",
      command: "evaluate synthetic role resource thresholds",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-role-thresholds",
      status: "FAIL",
      command: "evaluate synthetic role resource thresholds",
      durationMs: 0,
      message: error.message
    };
  }
}

function thresholdPolicyCalibrationCheck() {
  try {
    const record = {
      scenario: "synthetic-threshold-policy",
      title: "Synthetic Threshold Policy",
      status: "PASS",
      phases: [{
        id: "sample",
        results: [{
          command: "ocm start kova-threshold-test",
          status: 0,
          durationMs: 150,
          resourceSamples: {
            schemaVersion: "kova.resourceSamples.v1",
            sampleCount: 1,
            peakTotalRssMb: 250,
            maxTotalCpuPercent: 80,
            byRole: {
              gateway: {
                peakRssMb: 250,
                maxCpuPercent: 80,
                peakRssAtMs: 10,
                peakCpuAtMs: 10,
                peakProcessCount: 1
              }
            },
            topRolesByRss: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
            topRolesByCpu: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
            topByRss: [],
            topByCpu: []
          }
        }],
        metrics: { logs: zeroLogMetrics() }
      }],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, {
      id: "synthetic-threshold-policy",
      thresholds: {}
    }, {
      profile: {
        id: "release",
        calibration: {
          roles: {
            gateway: { peakRssMb: 200 }
          },
          surfaces: {
            "release-runtime-startup": {
              thresholds: { coldReadyMs: 100 }
            }
          }
        }
      },
      surface: {
        id: "release-runtime-startup",
        thresholds: { coldReadyMs: 1000 },
        roleThresholds: {}
      }
    });
    assertEqual(record.status, "FAIL", "profile calibration threshold should fail record");
    assertEqual(record.thresholdPolicy?.profileId, "release", "threshold policy profile id");
    assertEqual(record.thresholdPolicy?.thresholds?.coldReadyMs, 100, "profile surface threshold override");
    assertEqual(record.thresholdPolicy?.roleThresholds?.gateway?.peakRssMb, 200, "profile role threshold");
    assertEqual(
      record.violations.some((violation) => violation.metric === "coldReadyMs"),
      true,
      "profile calibrated duration violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"),
      true,
      "profile calibrated role violation"
    );
    return {
      id: "threshold-policy-calibration",
      status: "PASS",
      command: "evaluate synthetic profile threshold calibration",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "threshold-policy-calibration",
      status: "FAIL",
      command: "evaluate synthetic profile threshold calibration",
      durationMs: 0,
      message: error.message
    };
  }
}

async function cleanupRetryCheck(tmp) {
  const counterPath = join(tmp, "cleanup-retry-count");
  const command = `node -e 'const fs=require("fs"); const p=${JSON.stringify(counterPath)}; const n=Number(fs.existsSync(p)?fs.readFileSync(p,"utf8"):0)+1; fs.writeFileSync(p,String(n)); if(n<2){console.error("gateway still shutting down"); process.exit(1)} console.log("destroyed")'`;
  const result = await runCleanupCommand(command, {
    timeoutMs: 30000,
    retryDelaysMs: [0, 0, 0]
  });
  try {
    assertEqual(result.status, 0, "cleanup retry final status");
    assertEqual(result.attempts?.length, 2, "cleanup retry attempts");
    assertEqual(result.attempts?.[0]?.status, 1, "first cleanup attempt failed");
    assertEqual(result.attempts?.[1]?.status, 0, "second cleanup attempt passed");
    return {
      id: "cleanup-retry-contract",
      status: "PASS",
      command: "evaluate retryable cleanup command",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "cleanup-retry-contract",
      status: "FAIL",
      command: "evaluate retryable cleanup command",
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function markdownFailureCardsCheck() {
  try {
    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-failure-cards",
      mode: "execution",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 1, statuses: { FAIL: 1 } },
      records: [{
        scenario: "gateway-performance",
        title: "Gateway Performance",
        status: "FAIL",
        target: "runtime:stable",
        envName: "kova-self-check",
        likelyOwner: "gateway-runtime",
        objective: "Synthetic failure card check",
        phases: [{
          id: "start",
          title: "Start",
          intent: "Start gateway",
          commands: ["ocm start kova-self-check --runtime stable --json"],
          evidence: [],
          results: [{
            command: "ocm start kova-self-check --runtime stable --json",
            status: 1,
            timedOut: false,
            durationMs: 45000,
            stdout: "",
            stderr: "gateway did not become healthy"
          }]
        }],
        measurements: {
          health: syntheticHealthMeasurement({ healthReadyAtMs: 45000 }),
          peakRssMb: 1100,
          resourceTopRolesByRss: [{ role: "gateway", peakRssMb: 1100, maxCpuPercent: 220 }]
        },
        violations: [{ message: "gateway readiness exceeded threshold" }]
      }]
    });
    assertEqual(rendered.includes("## Findings"), true, "markdown findings section");
    assertEqual(rendered.includes("gateway-performance"), true, "finding scenario");
    assertEqual(rendered.includes("gateway readiness exceeded threshold"), true, "finding summary");
    assertEqual(rendered.includes("gateway-runtime"), true, "finding owner");
    assertEqual(rendered.includes("## Resource Roles"), true, "markdown resource roles section");
    assertEqual(rendered.includes("gateway: RSS 1100 MB; CPU 220%"), true, "markdown resource role summary");
    return {
      id: "markdown-failure-cards",
      status: "PASS",
      command: "render synthetic failure Markdown",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "markdown-failure-cards",
      status: "FAIL",
      command: "render synthetic failure Markdown",
      durationMs: 0,
      message: error.message
    };
  }
}

function reportRecommendedNextScenarioCheck() {
  try {
    const report = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-recommended-next",
      mode: "execution",
      target: "local-build:/tmp/OpenClaw Test",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 1, statuses: { FAIL: 1 } },
      records: [{
        scenario: "agent-cold-warm-message",
        title: "Agent Cold Warm Message",
        status: "FAIL",
        target: "local-build:/tmp/OpenClaw Test",
        envName: "kova-self-check",
        state: { id: "mock-openai-provider", title: "Mock OpenAI Provider" },
        likelyOwner: "agent-runtime",
        objective: "Synthetic recommended next scenario check",
        phases: [{
          id: "agent-turn",
          title: "Agent Turn",
          intent: "Send a cold message",
          commands: ["ocm @kova-self-check -- agent --local --message hi --json"],
          evidence: [],
          results: []
        }],
        measurements: {
          coldAgentTurnMs: 62000,
          agentPreProviderMs: 61300
        },
        violations: [{ message: "cold pre-provider latency was 61300ms" }]
      }]
    };
    const structured = renderReportSummary(report, { structured: true });
    const recommended = structured.recommendedNextScenario;
    assertEqual(recommended?.scenario, "agent-cold-warm-message", "recommended scenario id");
    assertEqual(recommended?.state, "mock-openai-provider", "recommended state id");
    assertEqual(
      recommended?.command,
      "node bin/kova.mjs run --target 'local-build:/tmp/OpenClaw Test' --scenario agent-cold-warm-message --state mock-openai-provider --execute --profile-on-failure --retain-on-failure --json",
      "recommended command"
    );
    assertEqual(renderReportSummary(report).includes("Recommended next scenario:"), true, "plain summary recommended section");
    const paste = renderPasteSummary(report);
    assertEqual(paste.includes("Recommended next scenario"), true, "paste summary recommended section");
    assertEqual(paste.includes("cold pre-provider latency was 61300ms"), true, "paste summary recommended reason");
    return {
      id: "report-recommended-next-scenario",
      status: "PASS",
      command: "render synthetic recommended next scenario",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "report-recommended-next-scenario",
      status: "FAIL",
      command: "render synthetic recommended next scenario",
      durationMs: 0,
      message: error.message
    };
  }
}

function stateRegistryValidationCheck() {
  try {
    let rejectedTrait = false;
    try {
      validateStateShape({
        id: "bad-state",
        title: "Bad State",
        objective: "Invalid state fixture",
        tags: [],
        traits: ["not-a-real-trait"],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: ["evidence"],
        cleanupGuarantees: ["cleanup"],
        setup: []
      }, "bad-state.json");
    } catch (error) {
      rejectedTrait = /unknown trait/.test(error.message);
    }
    assertEqual(rejectedTrait, true, "unknown state trait rejected");

    let rejectedEvidence = false;
    try {
      validateStateShape({
        id: "bad-evidence-state",
        title: "Bad Evidence State",
        objective: "Invalid state fixture evidence",
        tags: [],
        traits: ["fresh-user"],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: [],
        cleanupGuarantees: [],
        setup: []
      }, "bad-evidence-state.json");
    } catch (error) {
      rejectedEvidence = /setupEvidence must not be empty/.test(error.message) &&
        /cleanupGuarantees must not be empty/.test(error.message);
    }
    assertEqual(rejectedEvidence, true, "empty state evidence rejected");

    let rejectedStateCollectionIntent = false;
    try {
      validateStateShape({
        id: "bad-collection-state",
        title: "Bad Collection State",
        objective: "Invalid collection intent.",
        tags: [],
        traits: ["fresh-user"],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: ["evidence"],
        cleanupGuarantees: ["cleanup"],
        setup: [{
          id: "bad-intent",
          title: "Bad Intent",
          intent: "Invalid collection intent.",
          afterPhase: "provision",
          commands: ["true"],
          evidence: ["evidence"],
          collectionIntent: "tiny"
        }]
      }, "bad-collection-state.json");
    } catch (error) {
      rejectedStateCollectionIntent = /collectionIntent must be one of/.test(error.message);
    }
    assertEqual(rejectedStateCollectionIntent, true, "invalid state collection intent rejected");

    let rejectedScenarioCollectionIntent = false;
    try {
      validateScenarioShape({
        id: "bad-collection-scenario",
        surface: "fresh-install",
        title: "Bad Collection Scenario",
        objective: "Invalid collection intent.",
        tags: [],
        thresholds: {},
        phases: [{
          id: "provision",
          title: "Provision",
          intent: "Provision.",
          healthScope: "none",
          commands: ["true"],
          evidence: [],
          collectionIntent: "tiny"
        }],
        proves: []
      }, "bad-collection-scenario.json");
    } catch (error) {
      rejectedScenarioCollectionIntent = /collectionIntent must be one of/.test(error.message);
    }
    assertEqual(rejectedScenarioCollectionIntent, true, "invalid scenario collection intent rejected");

    let rejectedSurface = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["baseline"],
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "state",
          traits: ["fresh-user"],
          incompatibleSurfaces: ["missing-surface"]
        }],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          requirements: [{
            id: "baseline",
            states: ["state"],
            targetKinds: ["runtime"],
            metrics: []
          }]
        }],
        processRoles: []
      });
    } catch (error) {
      rejectedSurface = /incompatibleSurfaces references unknown surface/.test(error.message);
    }
    assertEqual(rejectedSurface, true, "unknown incompatible surface rejected");

    let rejectedPurpose = false;
    try {
      validateProfileShape({
        id: "profile",
        title: "Bad Profile",
        objective: "Invalid purpose.",
        entries: [{ scenario: "scenario", state: "state" }],
        purpose: "made-up-purpose"
      }, "bad-profile.json");
    } catch (error) {
      rejectedPurpose = /unknown purpose/.test(error.message);
    }
    assertEqual(rejectedPurpose, true, "unknown profile purpose rejected");

    let rejectedDerivedCoverage = false;
    try {
      validateProfileShape({
        id: "profile",
        title: "Bad Profile Coverage",
        objective: "Invalid derived profile coverage.",
        entries: [{ scenario: "scenario", state: "state" }],
        gate: {
          coverage: {
            surfaces: {
              blocking: ["surface"]
            }
          }
        }
      }, "bad-profile-coverage.json");
    } catch (error) {
      rejectedDerivedCoverage = /coverage\.surfaces is derived/.test(error.message);
    }
    assertEqual(rejectedDerivedCoverage, true, "derived profile coverage rejected");

    let rejectedRequirement = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["missing-requirement"],
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "state",
          traits: ["fresh-user"],
        }],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          thresholds: { knownMetric: 1 },
          requirements: [{
            id: "baseline",
            states: ["missing-state"],
            stateTraits: ["not-a-trait"],
            targetKinds: ["unsupported-target"],
            metrics: ["madeUpMetric"]
          }]
        }],
        processRoles: [],
        metrics: [{ id: "knownMetric" }]
      });
    } catch (error) {
      rejectedRequirement = /proves unknown surface requirement/.test(error.message) &&
        /references unknown state 'missing-state'/.test(error.message) &&
        /references unknown state trait 'not-a-trait'/.test(error.message) &&
        /unsupported-target/.test(error.message) &&
        /unknown metric 'madeUpMetric'/.test(error.message);
    }
    assertEqual(rejectedRequirement, true, "invalid surface requirement and scenario proof rejected");

    let rejectedMetric = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["baseline"],
          thresholds: { madeUpMetric: 1 },
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          thresholds: { knownMetric: 1 },
          requirements: [{
            id: "baseline",
            states: ["state"],
            targetKinds: ["runtime"],
            metrics: ["knownMetric"]
          }]
        }],
        processRoles: [],
        metrics: [{ id: "knownMetric" }]
      });
    } catch (error) {
      rejectedMetric = /unknown metric 'madeUpMetric'/.test(error.message);
    }
    assertEqual(rejectedMetric, true, "unknown scenario metric rejected");

    let rejectedCalibration = false;
    try {
      validateRegistryReferences({
        scenarios: [],
        states: [],
        profiles: [{
          id: "profile",
          entries: [],
          calibration: {
            roles: {
              missingRole: { peakRssMb: 100 }
            },
            surfaces: {
              missingSurface: {
                thresholds: { peakRssMb: 100 }
              },
              knownSurface: {
                thresholds: { madeUpMetric: 1 },
                roleThresholds: {
                  knownRole: { peakRssMb: 100 }
                }
              }
            }
          }
        }],
        surfaces: [{
          id: "knownSurface",
          processRoles: [],
          requirements: [{
            id: "baseline",
            states: ["state"],
            targetKinds: ["runtime"],
            metrics: []
          }]
        }],
        processRoles: [{ id: "knownRole" }],
        metrics: [{ id: "peakRssMb" }]
      });
    } catch (error) {
      rejectedCalibration = /calibration\.roles references unknown process role/.test(error.message) &&
        /calibration\.surfaces references unknown surface/.test(error.message) &&
        /unknown metric 'madeUpMetric'/.test(error.message);
    }
    assertEqual(rejectedCalibration, true, "invalid profile calibration rejected");

    let rejectedPlatform = false;
    try {
      validateRegistryReferences({
        scenarios: [],
        states: [],
        profiles: [{
          id: "profile",
          entries: [],
          gate: {
            coverage: {
              platforms: {
                blocking: ["macos-arm"]
              }
            }
          }
        }],
        surfaces: [],
        processRoles: [],
        metrics: []
      });
    } catch (error) {
      rejectedPlatform = /unknown platform coverage key 'macos-arm'/.test(error.message);
    }
    assertEqual(rejectedPlatform, true, "unknown platform coverage key rejected");

    return {
      id: "state-registry-validation",
      status: "PASS",
      command: "evaluate synthetic invalid state contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "state-registry-validation",
      status: "FAIL",
      command: "evaluate synthetic invalid state contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

function scenarioCloneFirstValidationCheck() {
  try {
    let rejectedMissingClone = false;
    try {
      validateScenarioShape({
        id: "bad-existing-user",
        surface: "upgrade-existing-user",
        title: "Bad Existing User",
        objective: "Touches source env without clone-first protection.",
        tags: ["upgrade"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "status",
          title: "Status",
          intent: "Unsafe durable source access.",
          healthScope: "post-ready",
          commands: ["ocm service status {sourceEnv} --json"],
          evidence: ["status"]
        }]
      }, "bad-existing-user.json");
    } catch (error) {
      rejectedMissingClone = /must start by cloning/.test(error.message);
    }
    assertEqual(rejectedMissingClone, true, "source env scenario without clone-first rejected");

    let rejectedSecondSourceUse = false;
    try {
      validateScenarioShape({
        id: "bad-existing-user-second-source",
        surface: "upgrade-existing-user",
        title: "Bad Existing User Second Source",
        objective: "References source env after clone.",
        tags: ["upgrade"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "clone",
          title: "Clone",
          intent: "Clone source.",
          healthScope: "none",
          commands: ["ocm env clone {sourceEnv} {env} --json", "ocm logs {sourceEnv} --tail 20"],
          evidence: ["clone"]
        }]
      }, "bad-existing-user-second-source.json");
    } catch (error) {
      rejectedSecondSourceUse = /may reference it only in the first clone command/.test(error.message);
    }
    assertEqual(rejectedSecondSourceUse, true, "second source env reference rejected");

    validateScenarioShape({
      id: "good-existing-user",
      surface: "upgrade-existing-user",
      title: "Good Existing User",
      objective: "Clone first, then operate only on the disposable env.",
      tags: ["upgrade"],
      proves: ["baseline"],
      thresholds: {},
      phases: [{
        id: "clone",
        title: "Clone",
        intent: "Clone source.",
        healthScope: "none",
        commands: ["ocm env clone {sourceEnv} {env} --json"],
        evidence: ["clone"]
      }, {
        id: "upgrade",
        title: "Upgrade",
        intent: "Upgrade disposable clone.",
        healthScope: "readiness",
        commands: ["ocm upgrade {env} --channel beta --json"],
        evidence: ["upgrade"]
      }]
    }, "good-existing-user.json");

    return {
      id: "scenario-clone-first-validation",
      status: "PASS",
      command: "validate source-env scenario contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-clone-first-validation",
      status: "FAIL",
      command: "validate source-env scenario contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

async function channelCapabilityRegistryCheck() {
  try {
    const catalogs = await loadChannelCapabilityCatalog();
    const workflowInventories = await loadChannelWorkflowInventory();
    const workflowCatalogs = await loadChannelWorkflowCaseCatalog();
    const openClawCatalog = catalogs.find((catalog) => catalog.id === "openclaw-message");
    assertEqual(Boolean(openClawCatalog), true, "OpenClaw message capability catalog present");
    assertOpenClawChannelCapabilityCatalog(openClawCatalog);
    validateChannelCapabilityCatalogReferences(await loadChannelCapabilities(), catalogs);
    validateChannelWorkflowInventoryReferences(workflowInventories, catalogs);
    validateChannelWorkflowCaseCatalogReferences(workflowCatalogs, catalogs);
    validateChannelWorkflowCaseInventoryReferences(workflowCatalogs, workflowInventories);
    const workflowInventory = workflowInventories.find((inventory) => inventory.id === "openclaw-channel-workflow-inventory");
    assertEqual(Boolean(workflowInventory), true, "OpenClaw channel workflow inventory present");
    const completionHandoff = workflowInventory?.workflows?.find((workflow) => workflow.id === "completion-handoff");
    assertEqual(Boolean(completionHandoff), true, "completion handoff workflow inventory present");
    assertEqual(completionHandoff?.deliveryModes?.includes("completion-handoff"), true, "completion handoff declares delivery mode");
    assertEqual(completionHandoff?.atoms?.some((atom) => atom.group === "workflow" && atom.id === "background-artifact-completion"), true, "completion handoff maps to background completion atom");

    const channels = await loadChannelCapabilities();
    await assertRawChannelPlatformFilesArePlatformOnly();
    validateChannelCapabilityWorkflowReferences(channels, workflowCatalogs);
    const workflowCatalog = workflowCatalogs.find((catalog) => catalog.id === "openclaw-channel-workflow-cases");
    assertEqual(Boolean(workflowCatalog), true, "OpenClaw channel workflow case catalog present");
    const sourceMediaCase = workflowCatalog?.cases?.find((testCase) => testCase.id === "source-visible-delivery.media.message-tool-only");
    assertEqual(Boolean(sourceMediaCase), true, "source visible media workflow case present");
    assertEqual(sourceMediaCase?.inventoryWorkflow, "source-visible-delivery", "source media workflow case maps to inventory workflow");
    assertEqual(sourceMediaCase?.matrix?.delivery, "message-tool-only-source-delivery", "source media workflow case declares matrix delivery mode");
    assertEqual(sourceMediaCase?.atoms?.some((atom) => atom.group === "workflow" && atom.id === "source-visible-delivery"), true, "source media workflow declares source delivery atom");
    const nativePollCase = workflowCatalog?.cases?.find((testCase) => testCase.id === "native-action.poll");
    assertEqual(Boolean(nativePollCase), true, "native poll workflow case present");
    let rejectedNativeCalls = false;
    try {
      validateChannelWorkflowCaseCatalogShape({
        schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
        id: "bad-native-calls",
        title: "Bad Native Calls",
        description: "Bad native call shape.",
        cases: [{
          ...nativePollCase,
          expects: {
            ...nativePollCase.expects,
            nativeActions: undefined,
            nativeCalls: { sendPoll: 1 }
          }
        }]
      }, "bad-native-calls.json");
    } catch (error) {
      rejectedNativeCalls = /nativeCalls must not be used/.test(error.message);
    }
    assertEqual(rejectedNativeCalls, true, "workflow cases reject platform method expectations");

    let rejectedPlatformNamedUserFlow = false;
    try {
      validateChannelWorkflowCaseCatalogShape({
        schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
        id: "bad-platform-named-user-flow",
        title: "Bad Platform Named User Flow",
        description: "Bad platform named user flow shape.",
        cases: [{
          ...nativePollCase,
          userAction: "user asks OpenClaw to create a Telegram poll in the current chat"
        }]
      }, "bad-platform-named-user-flow.json");
    } catch (error) {
      rejectedPlatformNamedUserFlow = /must be platform-neutral/.test(error.message);
    }
    assertEqual(rejectedPlatformNamedUserFlow, true, "workflow user-facing text rejects platform-specific names");

    let rejectedUnknownNativeAction = false;
    try {
      validateChannelWorkflowCaseCatalogShape({
        schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
        id: "bad-native-action",
        title: "Bad Native Action",
        description: "Bad native action shape.",
        cases: [{
          ...nativePollCase,
          expects: {
            ...nativePollCase.expects,
            nativeActions: { "action-delete": 1 }
          }
        }]
      }, "bad-native-action.json");
    } catch (error) {
      rejectedUnknownNativeAction = /must match a native-platform atom/.test(error.message);
    }
    assertEqual(rejectedUnknownNativeAction, true, "workflow native action expectations must match declared atoms");
    const telegram = channels.find((channel) => channel.id === "telegram");
    assertEqual(Boolean(telegram), true, "telegram channel capability registry present");
    assertEqual(telegram.adapterId, "telegram", "telegram adapter id");
    assertEqual(telegram.supportStatus, "supported", "telegram support status");
    assertArrayNotEmpty(telegram.declarationSources, "telegram declaration sources");
    assertEqual(telegram.capabilities.some((capability) =>
      capability.group === "durable-final" && capability.id === "media" && capability.requiredLevel === "blocking"
    ), true, "telegram media capability is blocking");
    assertEqual(telegram.capabilities.every((capability) =>
      telegram.declarationSources.includes(capability.declarationSource)
    ), true, "telegram capability declaration sources reference registry sources");
    assertEqual(telegram.capabilities.every((capability) =>
      capability.catalogId === `${capability.group}:${capability.id}`
    ), true, "telegram capabilities reference OpenClaw catalog ids");
    assertEqual(telegram.workflowCaseIds?.includes("source-visible-delivery.media.message-tool-only"), true, "telegram maps to shared source media workflow case");
    assertEqual(telegram.workflowCoverage?.schemaVersion, "kova.channelWorkflowCoverage.v1", "telegram exposes derived workflow coverage");
    assertEqual(telegram.workflowCoverage?.selectedCount, telegram.workflowCaseIds?.length, "telegram workflow coverage selected count matches selected case ids");
    assertEqual(telegram.workflowCoverage?.selected?.some((row) => row.id === "native-action.poll"), true, "telegram workflow coverage includes selected native poll flow");
    assertEqual(telegram.workflowCoverage?.skipped?.every((row) => typeof row.reason === "string" && row.reason.length > 0), true, "telegram skipped workflow coverage explains every skipped flow");
    const workflowCasesById = new Map((workflowCatalog?.cases ?? []).map((testCase) => [testCase.id, testCase]));
    const telegramCoverageWithDriverSkip = planWorkflowCases({
      channelRegistry: telegram,
      workflowCatalog,
      caseSet: "declared-workflows",
      driver: {
        canDriveWorkflowCase({ workflowCase }) {
          return workflowCase.id === "native-action.poll"
            ? { supported: false, reason: "poll enqueue is not implemented by this driver" }
            : { supported: true, reason: null };
        }
      }
    });
    assertEqual(telegramCoverageWithDriverSkip.skipped.some((row) =>
      row.id === "native-action.poll" && row.reason === "driver support: poll enqueue is not implemented by this driver"
    ), true, "workflow coverage reports driver support skips");
    const telegramWorkflowAtoms = new Set((telegram.workflowCaseIds ?? []).flatMap((caseId) =>
      (workflowCasesById.get(caseId)?.atoms ?? [])
        .filter((atom) => atom.group !== "workflow")
        .map((atom) => `${atom.group}:${atom.id}`)
    ));
    assertEqual(telegram.capabilities
      .filter((capability) => capability.requiredLevel === "blocking")
      .every((capability) => telegramWorkflowAtoms.has(`${capability.group}:${capability.id}`)),
    true, "telegram blocking capabilities have declared workflow proof");
    assertChannelObservationLogicalNativeBoundary();

    let rejectedGroup = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-channel",
        title: "Bad Channel",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "made-up-group",
          catalogId: "made-up-group:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/bad/src/channel.ts"
        }]
      }, "bad-channel.json");
    } catch (error) {
      rejectedGroup = /group must be one of/.test(error.message);
    }
    assertEqual(rejectedGroup, true, "unknown channel capability group rejected");

    let rejectedProofMode = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-proof-mode",
        title: "Bad Proof Mode",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["eventually"],
          declarationSource: "extensions/bad/src/channel.ts"
        }]
      }, "bad-proof-mode.json");
    } catch (error) {
      rejectedProofMode = /proofModes\[0\] must be one of/.test(error.message);
    }
    assertEqual(rejectedProofMode, true, "unknown channel capability proof mode rejected");

    let rejectedSource = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-source",
        title: "Bad Source",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/other/src/channel.ts"
        }]
      }, "bad-source.json");
    } catch (error) {
      rejectedSource = /declarationSource must reference declarationSources/.test(error.message);
    }
    assertEqual(rejectedSource, true, "unknown capability declaration source rejected");

    let rejectedDuplicate = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-duplicate",
        title: "Bad Duplicate",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/bad/src/channel.ts"
        }, {
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text Again",
          requiredLevel: "warning",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/bad/src/channel.ts"
        }]
      }, "bad-duplicate.json");
    } catch (error) {
      rejectedDuplicate = /duplicate capability/.test(error.message);
    }
    assertEqual(rejectedDuplicate, true, "duplicate channel capability rejected");

    let rejectedCatalogReference = false;
    try {
      validateChannelCapabilityCatalogReferences([{
        ...telegram,
        capabilities: [{
          id: "imaginary",
          group: "durable-final",
          catalogId: "durable-final:imaginary"
        }]
      }], catalogs);
    } catch (error) {
      rejectedCatalogReference = /not defined in the OpenClaw channel capability catalog/.test(error.message);
    }
    assertEqual(rejectedCatalogReference, true, "channel capability must reference OpenClaw catalog");

    let rejectedWorkflowCaseReference = false;
    try {
      validateChannelCapabilityWorkflowReferences([{
        ...telegram,
        workflowCaseIds: ["imaginary-workflow-case"]
      }], workflowCatalogs);
    } catch (error) {
      rejectedWorkflowCaseReference = /unknown channel workflow case/.test(error.message);
    }
    assertEqual(rejectedWorkflowCaseReference, true, "channel workflow case references must exist");

    let rejectedUnsupportedWorkflowAtom = false;
    try {
      validateChannelCapabilityWorkflowReferences([{
        ...telegram,
        workflowCaseIds: ["text-final"]
      }], workflowCatalogs);
    } catch (error) {
      rejectedUnsupportedWorkflowAtom = /requires unsupported adapter atom/.test(error.message);
    }
    assertEqual(rejectedUnsupportedWorkflowAtom, true, "channel workflow case references must match adapter atoms");

    let rejectedMissingBlockingWorkflowProof = false;
    try {
      validateChannelCapabilityWorkflowReferences([{
        ...telegram,
        capabilities: telegram.capabilities.map((capability) =>
          capability.group === "durable-final" && capability.id === "payload"
            ? { ...capability, requiredLevel: "blocking" }
            : capability
        ),
        workflowCaseIds: telegram.workflowCaseIds.filter((caseId) => caseId !== "source-visible-delivery.payload.message-tool-only")
      }], workflowCatalogs);
    } catch (error) {
      rejectedMissingBlockingWorkflowProof = /blocking but has no declared runtime workflow proof/.test(error.message);
    }
    assertEqual(rejectedMissingBlockingWorkflowProof, true, "blocking channel capabilities require workflow proof");

    return {
      id: "channel-capability-registry",
      status: "PASS",
      command: "validate channel capability registry contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-capability-registry",
      status: "FAIL",
      command: "validate channel capability registry contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

async function assertRawChannelPlatformFilesArePlatformOnly() {
  const forbiddenKeys = [
    "adapterDistribution",
    "adapterId",
    "claims",
    "declarationSources",
    "deterministicShim",
    "proofModes",
    "requiredLevel",
    "supportStatus",
    "workflowCaseIds",
    "workflowOverrides"
  ];
  const names = (await readdir(channelPlatformsDir)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const platform = JSON.parse(await readFile(join(channelPlatformsDir, name), "utf8"));
    assertEqual(Boolean(platform.adapter), true, `${name} declares adapter facts`);
    assertEqual(Boolean(platform.capabilities && typeof platform.capabilities === "object" && !Array.isArray(platform.capabilities)), true, `${name} declares compact implemented capabilities`);
    for (const key of forbiddenKeys) {
      assertEqual(Object.hasOwn(platform, key), false, `${name} does not declare Kova/test policy key ${key}`);
    }
    assertEqual((platform.sources ?? []).includes("src/channels/message/types.ts"), false, `${name} does not declare generic OpenClaw contract as a platform source`);
  }
}

function assertOpenClawChannelCapabilityCatalog(catalog) {
  validateChannelCapabilityCatalogShape(catalog, "openclaw-message.json");
  const byGroup = new Map();
  for (const capability of catalog.capabilities ?? []) {
    const values = byGroup.get(capability.group) ?? [];
    values.push(capability.id);
    byGroup.set(capability.group, values);
  }

  assertEqual(
    JSON.stringify(byGroup.get("durable-final") ?? []),
    JSON.stringify([
      "text",
      "media",
      "poll",
      "payload",
      "silent",
      "reply-to",
      "thread",
      "native-quote",
      "message-sending-hooks",
      "batch",
      "reconcile-unknown-send",
      "after-send-success",
      "after-commit"
    ]),
    "OpenClaw durable-final capability catalog matches src/channels/message/types.ts"
  );
  assertEqual(
    JSON.stringify(byGroup.get("live-preview") ?? []),
    JSON.stringify([
      "draft-preview",
      "preview-finalization",
      "progress-updates",
      "native-streaming",
      "quiet-finalization"
    ]),
    "OpenClaw live-preview capability catalog matches src/channels/message/types.ts"
  );
  assertEqual(
    JSON.stringify(byGroup.get("live-finalizer") ?? []),
    JSON.stringify([
      "final-edit",
      "normal-fallback",
      "discard-pending",
      "preview-receipt",
      "retain-on-ambiguous-failure"
    ]),
    "OpenClaw live-finalizer capability catalog matches src/channels/message/types.ts"
  );
  assertEqual(
    JSON.stringify(byGroup.get("ack") ?? []),
    JSON.stringify([
      "after-receive-record",
      "after-agent-dispatch",
      "after-durable-send",
      "manual"
    ]),
    "OpenClaw ack policy catalog matches src/channels/message/types.ts"
  );
}

function assertChannelObservationLogicalNativeBoundary() {
  const workflowCase = {
    id: "selfcheck.media-logical-delivery",
    expects: {
      visibleDeliveries: 1,
      kind: "media",
      text: "KOVA_AGENT_MEDIA_OK",
      mediaSource: "/tmp/kova-selfcheck-media.png",
      mediaSourcePolicy: "exact"
    }
  };
  const observations = {
    schemaVersion: "kova.channelObservationSet.v1",
    channelId: "selfcheck",
    inbound: {
      route: {
        key: "room-1"
      },
      messageKey: "msg-1"
    },
    deliveries: [{
      schemaVersion: "kova.channelObservation.v1",
      channelId: "selfcheck",
      actor: "bot",
      visible: true,
      kind: "media",
      text: "KOVA_AGENT_MEDIA_OK",
      caption: null,
      route: {
        kind: "direct",
        key: "room-1",
        parentKey: null
      },
      replyTo: {
        present: false,
        key: null
      },
      delivery: {
        id: "native-1",
        receiptPresent: true,
        status: "sent"
      },
      media: [{
        kind: "image",
        present: true,
        source: "upload",
        sourceName: "kova-selfcheck-media.png",
        sourceRef: "[file:kova-selfcheck-media.png]"
      }],
      silent: false,
      timestampMs: 1,
      nativeMessages: [{
        channelId: "selfcheck",
        method: "sendMedia",
        path: "/messages",
        deliveryId: "native-1",
        status: "sent",
        visible: true,
        timestampMs: 1,
        raw: {}
      }]
    }],
    unmatchedNativeMessages: [],
    nativeCallSummary: {
      count: 1,
      nativeVisibleDeliveryCount: 1,
      logicalDeliveryCount: 1,
      byMethod: {
        sendMedia: 1
      },
      byAction: {}
    }
  };
  assertValidObservationSet(observations, { caseId: workflowCase.id });
  const invariants = evaluateWorkflowCase({
    workflowCase,
    observations,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  });
  assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "logical channel delivery keeps native message proof without overrides");

  const withUnmatchedNativeSend = {
    ...observations,
    unmatchedNativeMessages: [{
      channelId: "selfcheck",
      method: "sendMedia",
      path: "/messages",
      deliveryId: "native-extra",
      status: "sent",
      visible: true,
      timestampMs: 2,
      raw: {}
    }]
  };
  assertValidObservationSet(withUnmatchedNativeSend, { caseId: workflowCase.id });
  const unmatchedInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withUnmatchedNativeSend,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(unmatchedInvariant?.status, "failed", "unmatched native visible sends fail generic channel evaluation");

  const withNativeCompanionText = {
    ...observations,
    unmatchedNativeMessages: [{
      channelId: "selfcheck",
      method: "sendMessage",
      path: "/messages",
      deliveryId: "native-companion",
      status: "sent",
      visible: true,
      timestampMs: 2,
      raw: {
        body: {
          text: "KOVA_AGENT_MEDIA_OK"
        }
      }
    }]
  };
  assertValidObservationSet(withNativeCompanionText, { caseId: workflowCase.id });
  const companionTextInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withNativeCompanionText,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(companionTextInvariant?.status, "passed", "media workflows allow one native companion text send matching the expected response text");

  const messageToolTextWorkflowCase = {
    ...workflowCase,
    expects: {
      ...workflowCase.expects,
      text: undefined
    },
    providerScript: {
      completionToolCalls: [{
        name: "message",
        arguments: {
          action: "send",
          message: "KOVA_AGENT_MEDIA_OK"
        }
      }]
    }
  };
  const derivedCompanionTextInvariant = evaluateWorkflowCase({
    workflowCase: messageToolTextWorkflowCase,
    observations: withNativeCompanionText,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(derivedCompanionTextInvariant?.status, "passed", "media workflows derive companion text proof from scripted message-tool sends");

  const withUnexpectedCompanion = {
    ...observations,
    deliveries: [
      ...observations.deliveries,
      {
        schemaVersion: "kova.channelObservation.v1",
        channelId: "selfcheck",
        actor: "bot",
        visible: true,
        kind: "text",
        text: "unexpected extra text",
        caption: null,
        route: {
          kind: "direct",
          key: "room-1",
          parentKey: null
        },
        replyTo: {
          present: false,
          key: null
        },
        delivery: {
          id: "native-extra-visible",
          receiptPresent: true,
          status: "sent"
        },
        media: [],
        silent: false,
        timestampMs: 3,
        nativeMessages: [{
          channelId: "selfcheck",
          method: "sendMessage",
          path: "/messages",
          deliveryId: "native-extra-visible",
          status: "sent",
          visible: true,
          timestampMs: 3,
          raw: {}
        }]
      }
    ]
  };
  assertValidObservationSet(withUnexpectedCompanion, { caseId: workflowCase.id });
  const unexpectedVisibleInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withUnexpectedCompanion,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(unexpectedVisibleInvariant?.status, "failed", "unexpected visible companion sends fail generic channel evaluation");

  const withWrongMediaSource = {
    ...observations,
    deliveries: observations.deliveries.map((delivery) => ({
      ...delivery,
      media: delivery.media.map((media) => ({
        ...media,
        sourceName: "wrong-media.png",
        sourceRef: "[file:wrong-media.png]"
      }))
    }))
  };
  const mediaSourceInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withWrongMediaSource,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":media-source"));
  assertEqual(mediaSourceInvariant?.status, "failed", "wrong exact media source fails generic channel evaluation");

  const fingerprintWorkflowCase = {
    ...workflowCase,
    id: "selfcheck.media-fingerprint-delivery",
    expects: {
      ...workflowCase.expects,
      mediaSource: "/tmp/kova-fingerprint-source.png",
      mediaSourceProofs: [{
        source: "/tmp/kova-fingerprint-source.png",
        fingerprint: "png:1x1:ct6:bd8:filter0:first=abcdef01"
      }]
    }
  };
  const withFingerprintSource = {
    ...observations,
    deliveries: observations.deliveries.map((delivery) => ({
      ...delivery,
      media: delivery.media.map((media) => ({
        ...media,
        sourceName: null,
        sourceRef: "attach://kova-upload",
        sourceFingerprint: "png:1x1:ct6:bd8:filter0:first=abcdef01"
      }))
    }))
  };
  const fingerprintInvariant = evaluateWorkflowCase({
    workflowCase: fingerprintWorkflowCase,
    observations: withFingerprintSource,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":media-source"));
  assertEqual(fingerprintInvariant?.status, "passed", "exact media source can be proven by upload media fingerprint");
}

function scenarioHealthScopeValidationCheck() {
  try {
    let rejectedMissing = false;
    try {
      validateScenarioShape({
        id: "missing-health-scope",
        surface: "fresh-install",
        title: "Missing Health Scope",
        objective: "Scenario phase without an explicit health scope.",
        tags: ["fresh-user"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "start",
          title: "Start",
          intent: "Start gateway.",
          commands: ["ocm start {env} {startSelector} --json"],
          evidence: ["start"]
        }]
      }, "missing-health-scope.json");
    } catch (error) {
      rejectedMissing = /phases\[0\]\.healthScope must be a non-empty string/.test(error.message);
    }
    assertEqual(rejectedMissing, true, "missing healthScope rejected");

    let rejectedInvalid = false;
    try {
      validateScenarioShape({
        id: "invalid-health-scope",
        surface: "fresh-install",
        title: "Invalid Health Scope",
        objective: "Scenario phase with an invalid health scope.",
        tags: ["fresh-user"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "start",
          title: "Start",
          intent: "Start gateway.",
          healthScope: "startup",
          commands: ["ocm start {env} {startSelector} --json"],
          evidence: ["start"]
        }]
      }, "invalid-health-scope.json");
    } catch (error) {
      rejectedInvalid = /healthScope must be one of/.test(error.message);
    }
    assertEqual(rejectedInvalid, true, "invalid healthScope rejected");

    return {
      id: "scenario-health-scope-validation",
      status: "PASS",
      command: "validate scenario health scope contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-health-scope-validation",
      status: "FAIL",
      command: "validate scenario health scope contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

function scenarioStateCompatibilityCheck() {
  try {
    let rejected = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "upgrade-existing-user",
          surface: "upgrade-existing-user",
          proves: ["baseline"],
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "fresh",
          traits: ["fresh-user"],
          incompatibleSurfaces: ["upgrade-existing-user"]
        }],
        profiles: [{
          id: "bad-profile",
          entries: [{ scenario: "upgrade-existing-user", state: "fresh" }]
        }],
        surfaces: [{
          id: "upgrade-existing-user",
          processRoles: [],
          requirements: [{
            id: "baseline",
            states: ["old-release-user"],
            targetKinds: ["runtime"],
            metrics: []
          }]
        }],
        processRoles: []
      });
    } catch (error) {
      rejected = /pairs scenario 'upgrade-existing-user' with state 'fresh'/.test(error.message) ||
        /explicitly incompatible surface/.test(error.message);
    }
    assertEqual(rejected, true, "invalid scenario/state profile pairing rejected");
    return {
      id: "scenario-state-compatibility",
      status: "PASS",
      command: "evaluate synthetic invalid scenario/state pairing",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-state-compatibility",
      status: "FAIL",
      command: "evaluate synthetic invalid scenario/state pairing",
      durationMs: 0,
      message: error.message
    };
  }
}

function zeroLogMetrics() {
  return {
    missingDependencyErrors: 0,
    pluginLoadFailures: 0,
    metadataScanMentions: 0,
    configNormalizationMentions: 0,
    gatewayRestartMentions: 0,
    providerLoadMentions: 0,
    modelCatalogMentions: 0,
    providerTimeoutMentions: 0,
    eventLoopDelayMentions: 0,
    v8DiagnosticMentions: 0
  };
}

async function reportRunIdReferenceCheck(tmp) {
  const home = join(tmp, "report-run-id-home");
  const prefix = `KOVA_HOME=${quoteShell(home)}`;
  try {
    const run = await jsonCommandCheck(
      "report-run-id-source",
      `${prefix} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "run receipt schema");
        assertString(data.runId, "run id");
      }
    );
    if (run.status !== "PASS") {
      return {
        ...run,
        id: "report-run-id-reference"
      };
    }
    const runId = run.data.runId;
    const report = await jsonCommandCheck(
      "report-run-id-render",
      `${prefix} node bin/kova.mjs report ${quoteShell(runId)} --json`,
      (data) => {
        assertEqual(data.runId, runId, "report run id");
      }
    );
    if (report.status !== "PASS") {
      return { ...report, id: "report-run-id-reference" };
    }
    const compare = await jsonCommandCheck(
      "report-run-id-compare",
      `${prefix} node bin/kova.mjs report compare ${quoteShell(runId)} ${quoteShell(runId)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.compare.v1", "compare schema");
        assertEqual(data.ok, true, "same run id compare ok");
      }
    );
    if (compare.status !== "PASS") {
      return { ...compare, id: "report-run-id-reference" };
    }
    const list = await jsonCommandCheck(
      "reports-list-json",
      `${prefix} node bin/kova.mjs reports --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.reports.v1", "reports schema");
        assertEqual(data.reports.some((item) => item.runId === runId), true, "run id listed");
      }
    );
    return {
      id: "report-run-id-reference",
      status: list.status,
      command: "run, list, render, and compare by runId",
      durationMs: run.durationMs + report.durationMs + compare.durationMs + list.durationMs,
      message: list.message
    };
  } catch (error) {
    return {
      id: "report-run-id-reference",
      status: "FAIL",
      command: "run, list, render, and compare by runId",
      durationMs: 0,
      message: error.message
    };
  }
}

async function commandCheck(id, command) {
  const result = await runCommand(command, { timeoutMs: 30000 });
  return {
    id,
    status: result.status === 0 ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status === 0 ? "" : result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
  };
}

async function credentialStoreSelfCheck(tmp) {
  const home = join(tmp, "credentials-home");
  const command = `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs setup --non-interactive --auth env-only --provider openai --env-var OPENAI_API_KEY --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "setup schema");
    assertEqual(data.auth?.method, "env-only", "setup auth method");
    const liveEnv = join(home, "credentials", "live.env");
    const metadata = await stat(liveEnv);
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`live.env permissions expected 0600, got ${mode.toString(8)}`);
    }
    return {
      id: "credential-store",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "credential-store",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function setupNumericFlagsRejectedCheck(tmp) {
  const home = join(tmp, "numeric-auth-home");
  const command = `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs setup --non-interactive --provider 2 --auth 3 --value kova-selfcheck-key --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status === 0) {
      throw new Error("numeric setup provider/auth flags were accepted");
    }
    const output = `${result.stderr}\n${result.stdout}`;
    if (!output.includes("unknown auth method: 3")) {
      throw new Error(output.trim() || `unexpected exit ${result.status}`);
    }
    return {
      id: "setup-numeric-flags-rejected",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "setup-numeric-flags-rejected",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function externalCliSetupCheck(tmp) {
  const home = join(tmp, "external-cli-home");
  const fakeBin = join(tmp, "fake-bin");
  const kovaHome = join(tmp, "external-cli-kova-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(join(home, ".codex", "auth.json"), "{\"tokens\":{\"access_token\":\"redacted\"}}\n", "utf8");
  await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(fakeCodex, 0o755);

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    "node bin/kova.mjs setup --non-interactive --provider openai --auth external-cli --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "external cli setup schema");
    assertEqual(data.auth?.provider, "openai", "external cli provider");
    assertEqual(data.auth?.method, "external-cli", "external cli method");
    assertEqual(data.auth?.externalCli, "codex", "external cli name");
    assertEqual(data.auth?.verification?.verified, true, "external cli verification");
    const credential = data.checks?.find((check) => check.id === "credentials");
    if (!credential || !credential.message.includes("external-cli codex verified")) {
      throw new Error(`credential check did not report verified external CLI: ${credential?.message ?? "missing"}`);
    }
    return {
      id: "setup-external-cli-verification",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "setup-external-cli-verification",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function externalCliOpenClawConfigCheck(tmp) {
  const home = join(tmp, "external-cli-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider openai --auth-method external-cli --external-cli codex"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.agents?.defaults?.model?.primary, "codex/gpt-5.5", "external cli model ref");
    assertEqual(config.agents?.defaults?.agentRuntime?.id, "codex", "external cli runtime id");
    assertEqual(config.agents?.defaults?.agentRuntime?.fallback, "none", "external cli runtime fallback");
    assertEqual(config.plugins?.entries?.codex?.enabled, true, "external cli codex plugin enabled");
    if (config.models?.providers?.openai !== undefined) {
      throw new Error("Codex external CLI config must not write an OpenAI provider override");
    }
    if (config.models?.providers?.codex !== undefined) {
      throw new Error("Codex external CLI config must use the bundled codex provider instead of writing a provider override");
    }
    return {
      id: "external-cli-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "external-cli-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function anthropicApiKeyOpenClawConfigCheck(tmp) {
  const home = join(tmp, "anthropic-api-key-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider anthropic --env-var ANTHROPIC_API_KEY"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.anthropic?.apiKey?.id, "ANTHROPIC_API_KEY", "anthropic env ref");
    assertEqual(config.agents?.defaults?.model?.primary, "anthropic/claude-sonnet-4-5", "anthropic default model");
    return {
      id: "anthropic-api-key-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "anthropic-api-key-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function mockAuthOpenClawConfigCheck(tmp) {
  const home = join(tmp, "mock-auth-config-home");
  const portFile = join(tmp, "mock-auth-port");
  await writeFile(portFile, "12345\n", "utf8");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    `node support/configure-openclaw-mock-auth.mjs --port-file ${quoteShell(portFile)}`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.openai?.baseUrl, "http://127.0.0.1:12345/v1", "mock provider base URL");
    assertEqual(config.agents?.defaults?.model?.primary, "openai/gpt-5.5", "mock default model");
    assertEqual(config.gateway?.auth?.mode, "token", "mock gateway token mode");
    assertEqual(config.gateway?.auth?.token, "kova-mock-gateway-token", "mock gateway auth token");
    assertEqual(config.gateway?.remote?.token, "kova-mock-gateway-token", "mock gateway remote token");
    return {
      id: "mock-auth-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "mock-auth-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function claudeCliOpenClawConfigCheck(tmp) {
  const home = join(tmp, "claude-cli-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider anthropic --auth-method external-cli --external-cli claude"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.agents?.defaults?.model?.primary, "anthropic/claude-sonnet-4-5", "claude cli model ref");
    assertEqual(config.agents?.defaults?.agentRuntime?.id, "claude-cli", "claude cli runtime id");
    assertEqual(config.agents?.defaults?.agentRuntime?.fallback, "none", "claude cli runtime fallback");
    assertEqual(config.plugins?.entries?.anthropic?.enabled, true, "claude cli anthropic plugin enabled");
    if (config.models?.providers?.anthropic !== undefined) {
      throw new Error("Claude CLI config must use the bundled Anthropic provider instead of writing a provider override");
    }
    return {
      id: "claude-cli-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "claude-cli-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function externalCliRunAuthVerificationCheck(tmp) {
  const home = join(tmp, "stale-external-cli-home");
  const kovaHome = join(tmp, "stale-external-cli-kova-home");
  const credentials = join(kovaHome, "credentials");
  await mkdir(credentials, { recursive: true });
  await writeFile(join(credentials, "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "external-cli",
        envVars: [],
        externalCli: "codex",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(credentials, "live.env"), "", { encoding: "utf8", mode: 0o600 });
  const command = [
    `HOME=${quoteShell(home)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id: "run-external-cli-revalidates-auth",
    status: result.status !== 0 && output.includes("external-cli codex is not usable") ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes("external-cli codex is not usable")
      ? ""
      : `expected stale external CLI failure, got status ${result.status}: ${output.trim()}`
  };
}

async function commandTimeoutContractCheck() {
  const command = "node -e 'setTimeout(() => console.log(\"default-timeout-ok\"), 20)'";
  try {
    const result = await runCommand(command, { maxOutputChars: 100000 });
    assertEqual(result.status, 0, "default timeout command status");
    assertEqual(result.timedOut, false, "default timeout should not expire immediately");
    assertEqual(result.stdout.trim(), "default-timeout-ok", "default timeout command output");
    let invalidRejected = false;
    try {
      await runCommand("node -e 'process.exit(0)'", { timeoutMs: 0 });
    } catch (error) {
      invalidRejected = /timeoutMs must be a positive integer/.test(error.message);
    }
    assertEqual(invalidRejected, true, "invalid timeout rejected");
    return {
      id: "command-timeout-contract",
      status: "PASS",
      command: "evaluate runCommand timeout defaults",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "command-timeout-contract",
      status: "FAIL",
      command,
      durationMs: 0,
      message: error.message
    };
  }
}

async function commandOutputBudgetCheck() {
  try {
    const result = await runCommand("node -e 'process.stdout.write(\"x\".repeat(80)); process.stderr.write(\"y\".repeat(30));'", {
      timeoutMs: 10000,
      maxOutputChars: 20
    });
    assertEqual(result.status, 0, "command output budget command status");
    assertEqual(result.outputBudget?.schemaVersion, "kova.commandOutputBudget.v1", "command output budget schema");
    assertEqual(result.outputBudget?.stdout?.truncated, true, "stdout budget truncates");
    assertEqual(result.outputBudget?.stderr?.truncated, true, "stderr budget truncates");
    assertEqual(result.outputBudget?.stdout?.omittedChars, 60, "stdout omitted chars");
    assertEqual(result.outputBudget?.stderr?.omittedChars, 10, "stderr omitted chars");
    return {
      id: "command-output-budget",
      status: "PASS",
      command: "evaluate command output truncation metadata",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "command-output-budget",
      status: "FAIL",
      command: "evaluate command output truncation metadata",
      durationMs: 0,
      message: error.message
    };
  }
}

function logSnippetBudgetCheck() {
  try {
    const snippet = boundedLogSnippet(`${"a".repeat(40)}tail`, 10);
    assertEqual(snippet.text.startsWith("[truncated 34 chars]"), true, "log snippet truncation marker");
    assertEqual(snippet.text.endsWith("aaaaaatail"), true, "log snippet retains tail");
    assertEqual(snippet.budget.truncated, true, "log snippet budget truncated");
    assertEqual(snippet.budget.retainedBytes, 10, "log snippet retained bytes");
    assertEqual(snippet.budget.omittedBytes, 34, "log snippet omitted bytes");
    return {
      id: "log-snippet-budget",
      status: "PASS",
      command: "evaluate log snippet truncation metadata",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "log-snippet-budget",
      status: "FAIL",
      command: "evaluate log snippet truncation metadata",
      durationMs: 0,
      message: error.message
    };
  }
}

function expectedMockProviderFailureTimeoutLogCheck() {
  try {
    assertEqual(
      isExpectedKovaMockProviderFailureLine("embedded run failover decision reason=timeout rawError=503 mock provider channel workflow failure"),
      true,
      "expected Kova mock provider failure line is classified"
    );

    const expectedFailureRecord = {
      scenario: "channel-telegram-capability-conformance",
      status: "PASS",
      phases: [{
        id: "logs",
        results: [{
          command: "ocm logs kova-self-check --tail 200 --raw",
          status: 0,
          stdout: "model fallback decision reason=timeout detail=503 mock provider channel workflow failure",
          stderr: "",
          durationMs: 10
        }]
      }]
    };
    evaluateRecord(expectedFailureRecord, { thresholds: {} });
    assertEqual(
      expectedFailureRecord.violations?.some((violation) => violation.metric === "providerTimeoutMentions") ?? false,
      false,
      "expected Kova mock provider failure logs do not create global provider timeout violations"
    );

    const realTimeoutRecord = {
      scenario: "provider-timeout-self-check",
      status: "PASS",
      phases: [{
        id: "logs",
        results: [{
          command: "ocm logs kova-self-check --tail 200 --raw",
          status: 0,
          stdout: "provider timeout while calling upstream model",
          stderr: "",
          durationMs: 10
        }]
      }]
    };
    evaluateRecord(realTimeoutRecord, { thresholds: {} });
    assertEqual(
      realTimeoutRecord.violations?.some((violation) => violation.metric === "providerTimeoutMentions") ?? false,
      true,
      "real provider timeout logs still create provider timeout violations"
    );

    return {
      id: "expected-mock-provider-failure-timeout-logs",
      status: "PASS",
      command: "evaluate expected mock provider failure timeout log filtering",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "expected-mock-provider-failure-timeout-logs",
      status: "FAIL",
      command: "evaluate expected mock provider failure timeout log filtering",
      durationMs: 0,
      message: error.message
    };
  }
}

function optionalNoLogsCommandCheck() {
  try {
    const result = normalizeOptionalCommandResult({
      command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
      status: 1,
      stdout: "",
      stderr: "ocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr"
    });
    assertEqual(isNoLogsOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`), true, "missing logs output is detected");
    assertEqual(result.status, 0, "missing logs are normalized to optional success");
    assertEqual(result.originalStatus, 1, "original log command status retained");
    assertEqual(result.optional, true, "optional marker set");
    return {
      id: "optional-no-logs-command",
      status: "PASS",
      command: "evaluate optional empty log collection",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "optional-no-logs-command",
      status: "FAIL",
      command: "evaluate optional empty log collection",
      durationMs: 0,
      message: error.message
    };
  }
}

function commandResultInterpretationCheck() {
  try {
    const blocked = {
      command: "node support/example.mjs",
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        failureDomain: "kova-harness",
        recordStatus: "BLOCKED",
        error: "fixture setup failed"
      }),
      stderr: ""
    };
    const interpreted = attachCommandResultInterpretation(blocked);
    assertEqual(interpreted.interpretation.schemaVersion, "kova.commandResultInterpretation.v1", "interpretation schema");
    assertEqual(interpreted.interpretation.structured, true, "structured helper result detected");
    assertEqual(interpreted.interpretation.failureDomain, "kova-harness", "failure domain preserved");
    assertEqual(commandFailureRecordStatus(interpreted), "BLOCKED", "structured record status honored");
    const summary = buildReportSummary({
      schemaVersion: "kova.report.v1",
      mode: "execution",
      target: "runtime:stable",
      records: [{
        scenario: "structured-helper-failure",
        surface: "structured-helper-failure",
        title: "Structured Helper Failure",
        status: "BLOCKED",
        phases: [{ id: "run", results: [interpreted] }],
        measurements: {}
      }],
      summary: { statuses: { BLOCKED: 1 } }
    });
    assertEqual(summary.scenarios?.[0]?.failureDomain, "kova-harness", "summary failure domain");
    assertEqual(summary.scenarios?.[0]?.failureReason, "kova-harness: fixture setup failed", "summary failure reason uses structured evidence");

    const unstructured = interpretCommandResult({
      command: "node support/example.mjs",
      status: 1,
      stdout: "plain failure",
      stderr: ""
    });
    assertEqual(unstructured.structured, false, "plain stdout is not structured evidence");
    assertEqual(unstructured.recordStatus, null, "plain stdout does not override default classification");

    return {
      id: "command-result-interpretation",
      status: "PASS",
      command: "evaluate structured helper failure interpretation",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "command-result-interpretation",
      status: "FAIL",
      command: "evaluate structured helper failure interpretation",
      durationMs: 0,
      message: error.message
    };
  }
}

async function failingCommandCheck(id, command, expectedMessage) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id,
    status: result.status !== 0 && output.includes(expectedMessage) ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes(expectedMessage)
      ? ""
      : `expected failure containing ${JSON.stringify(expectedMessage)}, got status ${result.status}: ${output.trim()}`
  };
}

async function jsonCommandCheck(id, command, validate) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  if (result.status !== 0) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    await validate(data);
    return {
      id,
      status: "PASS",
      command,
      durationMs: result.durationMs,
      data
    };
  } catch (error) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function validateReport(report) {
  try {
    assertEqual(report.schemaVersion, "kova.report.v1", "report schema");
    assertEqual(report.mode, "dry-run", "report mode");
    assertEqual(report.summary?.statuses?.["DRY-RUN"], 2, "report dry-run count");
    assertEqual(Object.hasOwn(report, "resolvedCoverage"), false, "report does not include planner-only resolved coverage");
    assertEqual(report.performance?.repeat, 2, "report repeat count");
    assertEqual(report.performance?.groupCount, 1, "report performance group count");
    assertArrayNotEmpty(report.records, "report records");
    const ledger = report.records[0]?.evidenceLedger;
    assertEqual(ledger?.schemaVersion, "kova.evidenceLedger.v1", "evidence ledger schema");
    assertEqual(ledger?.completeness, "not-evaluated", "evidence ledger initial completeness");
    assertEqual((ledger?.summary?.required ?? 0) > 0, true, "evidence ledger required command entries");
    assertEqual(ledger?.summary?.byStatus?.skipped > 0, true, "dry-run command ledger entries are skipped");
    assertArrayNotEmpty(ledger?.entries, "evidence ledger entries");
    const summary = buildReportSummary(report);
    assertEqual(summary.proof?.requiredTotal > 0, true, "summary proof required total");
    assertEqual(summary.proof?.completeness?.["not-evaluated"] > 0, true, "summary proof dry-run completeness");
    const dirs = report.records[0]?.collectorArtifactDirs;
    assertEqual(dirs?.schemaVersion, "kova.collectorArtifactDirs.v1", "collector artifact dirs schema");
    assertString(dirs?.resourceSamples, "collector resource samples dir");
    assertString(dirs?.openclaw, "collector OpenClaw dir");
    assertString(dirs?.nodeProfiles, "collector node profiles dir");
    return {
      id: "dry-run-report-file",
      status: "PASS",
      command: "read generated JSON report",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "dry-run-report-file",
      status: "FAIL",
      command: "read generated JSON report",
      durationMs: 0,
      message: error.message
    };
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function assertArrayNotEmpty(value, label) {
  assertArray(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}
