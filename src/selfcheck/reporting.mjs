import { evaluateGate } from "../matrix/gate.mjs";
import { markdownFence, markdownTableCodeSpan } from "../reporting/markdown.mjs";
import { renderAssessment } from "../reporting/render-assessment.mjs";
import { renderBundleReceipt } from "../reporting/render-bundle.mjs";
import { renderHelp } from "../reporting/render-help.mjs";
import { renderInventoryPlan } from "../reporting/render-inventory.mjs";
import { renderMatrixPlan } from "../reporting/render-matrix-plan.mjs";
import { renderPlan } from "../reporting/render-plan.mjs";
import { createRunProgress } from "../reporting/render-run-progress.mjs";
import { renderRunReceipt } from "../reporting/render-run-receipt.mjs";
import {
  buildReportSummary,
  renderMarkdownReport,
  renderPasteSummary,
  renderReportSummary,
  summarizeRecords
} from "../reporting/report.mjs";
import { aggregateScenarios, runConfidence } from "../reporting/scenario-aggregate.mjs";
import { syntheticHealthMeasurement, syntheticPerformanceRecord, syntheticPerformanceReport } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function fixtureAccountingRenderCheck() {
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
    const normalizedRendered = rendered.replace(/\s+/g, " ");
    assertEqual(rendered.includes("Fixture Accounting"), true, "fixture accounting section rendered");
    assertEqual(rendered.includes("sessions:"), true, "session accounting line rendered");
    assertEqual(normalizedRendered.includes("store[80] source"), true, "source session store summarized");
    assertEqual(normalizedRendered.includes("store[80] canonical"), true, "canonical session store summarized");
    assertEqual(normalizedRendered.includes("store[80] legacy"), true, "legacy session store summarized");
    assertEqual(rendered.includes("memory:"), true, "memory accounting line rendered");
    assertEqual(normalizedRendered.includes("items[1200] source"), true, "source memory summarized");
    assertEqual(normalizedRendered.includes("items[1200] canonical"), true, "canonical memory summarized");
    assertEqual(normalizedRendered.includes("items[1200] legacy"), true, "legacy memory summarized");
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

export function statusFoundationCheck() {
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

export function reportStatusPrecedenceCheck() {
  try {
    const baseRecord = {
      scenario: "mixed-status",
      surface: "mixed-status",
      title: "Mixed Status",
      state: { id: "fresh" },
      likelyOwner: "OpenClaw",
      phases: [],
      measurements: {}
    };
    const records = [{
      ...baseRecord,
      status: "BLOCKED",
      blockedReason: "test harness unavailable"
    }, {
      ...baseRecord,
      status: "FAIL",
      violations: [{ message: "OpenClaw behavior failed" }]
    }];
    const report = {
      schemaVersion: "kova.report.v1",
      runId: "mixed-status-run",
      mode: "execution",
      target: "runtime:stable",
      records,
      summary: summarizeRecords(records)
    };
    const scenarios = aggregateScenarios(report);
    assertEqual(scenarios[0]?.verdict, "FAIL", "scenario FAIL outranks BLOCKED");
    assertEqual(scenarios[0]?.statuses?.FAIL, 1, "scenario retains failed sample count");
    assertEqual(scenarios[0]?.statuses?.BLOCKED, 1, "scenario retains blocked sample count");
    assertEqual(buildReportSummary(report).decision.verdict, "FAIL", "report FAIL outranks BLOCKED");

    const assessment = renderAssessment(report, { full: true, color: "never" }, process.env, process.stdout);
    assertEqual(assessment.includes("1 scenario failed"), true, "mixed assessment reports failed scenario");
    assertEqual(assessment.includes("1 failed, 1 blocked of 2 samples"), true, "mixed assessment preserves blocked sample");

    const receipt = renderRunReceipt({ report }, { color: "never" }, process.env, process.stdout);
    assertEqual(receipt.includes("1 failed, 1 blocked of 2"), true, "mixed receipt preserves blocked count");

    const blockedReport = {
      ...report,
      runId: "blocked-status-run",
      records: [records[0]],
      summary: summarizeRecords([records[0]])
    };
    assertEqual(buildReportSummary(blockedReport).decision.verdict, "BLOCKED", "blocked-only report verdict");
    const blockedAssessment = renderAssessment(
      blockedReport,
      { full: true, color: "never" },
      process.env,
      process.stdout
    );
    assertEqual(blockedAssessment.includes("1 scenario blocked"), true, "blocked assessment uses blocked language");
    assertEqual(blockedAssessment.includes("scenario failed"), false, "blocked assessment avoids failed language");
    const blockedReceipt = renderRunReceipt(
      { report: blockedReport },
      { color: "never" },
      process.env,
      process.stdout
    );
    assertEqual(blockedReceipt.includes("1 blocked of 1"), true, "blocked receipt headline");
    assertEqual(blockedReceipt.includes("Blocked"), true, "blocked receipt KPI");

    const skippedRecords = [{
      ...baseRecord,
      status: "PASS"
    }, {
      ...baseRecord,
      status: "SKIPPED"
    }];
    const skippedReport = {
      ...report,
      runId: "skipped-status-run",
      records: skippedRecords,
      summary: summarizeRecords(skippedRecords)
    };
    const skippedAssessment = renderAssessment(
      skippedReport,
      { full: true, color: "never" },
      process.env,
      process.stdout
    );
    assertEqual(skippedAssessment.includes("1 skipped of 2 samples"), true, "assessment reports skipped samples");

    const plannedRecords = [{
      ...baseRecord,
      status: "PASS"
    }, {
      ...baseRecord,
      status: "DRY-RUN"
    }];
    const plannedReport = {
      ...report,
      runId: "planned-status-run",
      records: plannedRecords,
      summary: summarizeRecords(plannedRecords)
    };
    const plannedAssessment = renderAssessment(
      plannedReport,
      { full: true, color: "never" },
      process.env,
      process.stdout
    );
    assertEqual(plannedAssessment.includes("1 planned of 2 samples"), true, "assessment reports mixed planned samples");

    const progressOutput = [];
    const progress = createRunProgress({
      flags: { color: "always" },
      env: { TERM: "xterm-256color" },
      stream: {
        isTTY: true,
        columns: 120,
        write(value) {
          progressOutput.push(String(value));
          return true;
        }
      }
    });
    progress.runFinish({ total: 1, statuses: { SKIPPED: 1 } });
    assertEqual(
      progressOutput.join("").includes("\u001b[33m[FINISH]"),
      true,
      "skipped run finish uses warning tone"
    );

    const gate = evaluateGate(report, {
      id: "mixed-status-gate",
      gate: {
        id: "mixed-status-gate",
        blocking: [{ scenario: "mixed-status", state: "fresh" }]
      }
    });
    assertEqual(gate.verdict, "DO_NOT_SHIP", "gate FAIL outranks harness BLOCKED");
    return {
      id: "report-status-precedence",
      status: "PASS",
      command: "evaluate mixed fail and blocked report semantics",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "report-status-precedence",
      status: "FAIL",
      command: "evaluate mixed fail and blocked report semantics",
      durationMs: 0,
      message: error.message
    };
  }
}

export function reportAggregationIntegrityCheck() {
  try {
    const record = (actual, roleActual) => ({
      scenario: "aggregate-worst",
      surface: "aggregate-worst",
      title: "Aggregate Worst",
      state: { id: "fresh" },
      status: "FAIL",
      likelyOwner: "OpenClaw",
      phases: [],
      measurements: { peakRssMb: actual },
      violations: [{
        kind: "threshold",
        metric: "peakRssMb",
        expected: "<= 100",
        actual,
        message: `peak RSS ${actual} MB exceeded threshold 100 MB`
      }, {
        kind: "threshold",
        metric: "resourceByRole.gateway.peakRssMb",
        expected: "<= 100",
        actual: roleActual,
        message: `gateway role RSS ${roleActual} MB exceeded threshold 100 MB`
      }]
    });
    const records = [record(150, 180), record(600, 700)];
    for (const ordered of [records, [...records].reverse()]) {
      const scenario = aggregateScenarios({ records: ordered })[0];
      const roleMetric = scenario.metrics.find((metric) => metric.key === "peakRssMb#gateway");
      const parentMetric = scenario.metrics.find((metric) => metric.key === "peakRssMb");
      assertEqual(roleMetric?.value, 700, "role aggregation keeps worst violation");
      assertEqual(parentMetric?.stats?.n, 2, "metric aggregation retains sample count");
      assertEqual(scenario.worst?.note.includes("700"), true, "scenario worst evaluates every violation");
    }

    const childFailureScenario = aggregateScenarios({
      records: [{
        scenario: "aggregate-child-failure",
        surface: "aggregate-child-failure",
        title: "Aggregate Child Failure",
        state: { id: "fresh" },
        status: "FAIL",
        phases: [],
        measurements: { peakRssMb: 50 },
        violations: [{
          kind: "threshold",
          metric: "resourceByRole.gateway.peakRssMb",
          expected: "<= 100",
          actual: 150,
          message: "gateway role RSS 150 MB exceeded threshold 100 MB"
        }]
      }]
    })[0];
    assertEqual(
      childFailureScenario.metrics.find((metric) => metric.key === "peakRssMb")?.status,
      "FAIL",
      "failed role child keeps the parent metric failed"
    );

    const lowerBoundRecords = [50, 90].map((actual) => ({
      scenario: "aggregate-minimum",
      surface: "aggregate-minimum",
      title: "Aggregate Minimum",
      state: { id: "fresh" },
      status: "FAIL",
      phases: [],
      measurements: {},
      violations: [{
        kind: "soak",
        metric: "soakDurationMs",
        expected: ">= 100",
        actual,
        message: `soak duration ${actual}ms was below required 100ms`
      }]
    }));
    for (const ordered of [lowerBoundRecords, [...lowerBoundRecords].reverse()]) {
      const scenario = aggregateScenarios({ records: ordered })[0];
      assertEqual(scenario.worst?.note.includes("50ms"), true, "minimum threshold keeps farthest underage");
    }

    const confidenceRecords = [
      ...[100, 100, 100].map((agentTurnMs) => ({
        scenario: "stable-confidence",
        title: "Stable Confidence",
        status: "PASS",
        phases: [],
        measurements: { agentTurnMs }
      })),
      {
        scenario: "sparse-confidence",
        title: "Sparse Confidence",
        status: "PASS",
        phases: [],
        measurements: { agentTurnMs: 100 }
      }
    ];
    const confidenceScenarios = aggregateScenarios({ records: confidenceRecords });
    const sparseMetric = confidenceScenarios
      .find((scenario) => scenario.id === "sparse-confidence")
      ?.metrics.find((metric) => metric.key === "agentTurnMs");
    assertEqual(sparseMetric?.stats?.n, 1, "single-sample metric retains its own n");
    assertEqual(runConfidence(confidenceScenarios).bucket, "single-sample", "run confidence uses weakest metric confidence");
    const noMetricConfidence = runConfidence(Array.from({ length: 10 }, (_, index) => ({
      id: `blocked-${index}`,
      total: 1,
      metrics: []
    })));
    assertEqual(noMetricConfidence.label, "single-sample", "run confidence does not pool unrelated no-metric scenarios");
    const mixedConfidence = runConfidence([
      confidenceScenarios.find((scenario) => scenario.id === "stable-confidence"),
      { id: "blocked-without-metrics", total: 1, metrics: [] }
    ]);
    assertEqual(mixedConfidence.label, "single-sample", "run confidence includes metric-less scenarios");
    return {
      id: "report-aggregation-integrity",
      status: "PASS",
      command: "evaluate worst-case metrics and per-metric confidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "report-aggregation-integrity",
      status: "FAIL",
      command: "evaluate worst-case metrics and per-metric confidence",
      durationMs: 0,
      message: error.message
    };
  }
}

export function renderedCommandGuidanceCheck() {
  try {
    const flags = { color: "never" };
    const plan = renderPlan({
      scenarios: [{ id: "fresh-install", states: [], phases: [] }],
      states: [],
      profiles: [],
      surfaces: []
    }, flags, process.env, process.stdout);
    assertEqual(
      plan.includes("kova run --target runtime:stable --scenario fresh-install"),
      true,
      "plan run hint includes required target"
    );

    const inventory = renderInventoryPlan({
      coverage: { ok: true, discoveredCount: 0, matchedCount: 0, modeledSurfaceCount: 0, warnings: [] },
      sources: []
    }, flags, process.env, process.stdout);
    assertEqual(inventory.includes("kova inventory plan --json"), true, "inventory hint uses plan subcommand");

    const bundle = renderBundleReceipt({
      runId: "kova-guidance-check",
      outputPath: "/tmp/kova-guidance-check.tar.gz",
      checksumPath: "/tmp/kova-guidance-check.tar.gz.sha256",
      included: []
    }, flags, process.env, process.stdout);
    assertEqual(bundle.includes("kova report kova-guidance-check"), true, "bundle hint uses report run id");
    assertEqual(bundle.includes("kova report /tmp/kova-guidance-check.tar.gz"), false, "bundle hint avoids archive input");

    const matrix = renderMatrixPlan({
      profile: { id: "smoke" },
      target: "runtime:stable",
      entries: Array.from({ length: 22 }, (_, index) => ({
        scenario: { id: `scenario-${index}`, title: `Scenario ${index}` },
        state: { id: "fresh" }
      }))
    }, flags, process.env, process.stdout);
    assertEqual(matrix.includes("+ 2 more entries"), true, "matrix plan pluralizes entries");
    assertEqual(matrix.includes("entryies"), false, "matrix plan avoids invalid plural");

    const help = renderHelp("setup", flags, process.env, process.stdout);
    assertEqual(help.includes("--method <method>"), true, "setup help documents auth method flag");
    return {
      id: "rendered-command-guidance",
      status: "PASS",
      command: "validate rendered CLI follow-up commands",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "rendered-command-guidance",
      status: "FAIL",
      command: "validate rendered CLI follow-up commands",
      durationMs: 0,
      message: error.message
    };
  }
}

export function markdownFailureCardsCheck() {
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
    assertEqual(
      rendered.includes("gateway: RSS 1100 MB (scenario gateway-performance); CPU 220% (scenario gateway-performance)"),
      true,
      "markdown resource role summary"
    );
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

export function markdownRuntimeFieldSafetyCheck() {
  try {
    const attack = "visible\n## forged\n<script>alert(1)</script>\n```text\nbreak";
    const report = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "unsafe|run",
      mode: "execution",
      target: "runtime:unsafe|target",
      platform: { os: attack, release: attack, arch: attack, node: attack },
      summary: { total: 1, statuses: { FAIL: 1 } },
      records: [{
        scenario: attack,
        title: attack,
        status: "FAIL",
        cleanup: attack,
        target: "runtime:unsafe|target",
        likelyOwner: attack,
        phases: [{
          id: "unsafe",
          title: attack,
          intent: attack,
          commands: [attack],
          evidence: [],
          results: [{
            command: attack,
            status: 1,
            timedOut: false,
            durationMs: 1,
            stdout: "",
            stderr: attack
          }]
        }],
        measurements: {},
        violations: []
      }]
    };
    const original = JSON.stringify(report);
    const markdown = renderMarkdownReport(report);
    const paste = renderPasteSummary(report);
    const failedCommandIndex = markdown.indexOf("- Failed command:");
    const markdownInline = markdown.slice(0, failedCommandIndex);
    assertEqual(failedCommandIndex >= 0, true, "report includes code-formatted failed command");
    assertEqual(markdown.includes("\n## forged"), false, "report rejects forged headings");
    assertEqual(markdownInline.includes("<script>"), false, "report inline fields reject raw HTML");
    assertEqual(markdownInline.includes("&lt;script&gt;"), true, "report retains escaped inline HTML text");
    assertEqual(markdown.includes("| Run ID | `unsafe\\|run` |"), true, "report table code spans escape pipes");
    const failureLine = markdown.split("\n").find((line) => line.startsWith("- Failure:"));
    assertEqual(failureLine?.includes("visible"), true, "report summarizes raw multiline failure output");
    assertEqual(failureLine?.includes("forged"), false, "report failure summary stays concise");
    const stderrMarker = "- stderr:\n";
    const stderrIndex = paste.indexOf(stderrMarker);
    const pasteInline = paste.slice(0, stderrIndex);
    const pasteStderr = paste.slice(stderrIndex + stderrMarker.length);
    assertEqual(stderrIndex >= 0, true, "paste includes fenced stderr");
    assertEqual(pasteInline.includes("\n## forged"), false, "paste inline fields reject forged headings");
    assertEqual(pasteInline.includes("<script>"), false, "paste inline fields reject raw HTML");
    assertEqual(pasteInline.includes("&lt;script&gt;"), true, "paste retains escaped inline HTML text");
    assertEqual(pasteStderr.startsWith("````text\n"), true, "paste chooses a fence longer than stderr backticks");
    assertEqual(pasteStderr.includes(attack), true, "paste preserves multiline stderr evidence");
    assertEqual(pasteStderr.includes("\n````\n"), true, "paste closes the expanded stderr fence");
    const backtickStress = markdownFence(
      `${Array.from({ length: 30 }, () => "safe").join("\n")}\n${"` ".repeat(150_000)}`
    );
    assertEqual(backtickStress.startsWith("```text\n"), true, "fence sizing ignores omitted log lines");
    assertEqual(backtickStress.split("\n").length, 32, "fence output remains capped at 30 evidence lines");
    const tableCode = markdownTableCodeSpan("left\\|right");
    const pipeIndex = tableCode.indexOf("|");
    const precedingBackslashes = tableCode.slice(0, pipeIndex).match(/\\+$/)?.[0].length ?? 0;
    assertEqual(precedingBackslashes, 3, "table code preserves a literal backslash while escaping its pipe");
    assertEqual(JSON.stringify(report), original, "renderers do not mutate JSON report data");
    return {
      id: "markdown-runtime-field-safety",
      status: "PASS",
      command: "render hostile runtime-derived Markdown fields",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "markdown-runtime-field-safety",
      status: "FAIL",
      command: "render hostile runtime-derived Markdown fields",
      durationMs: 0,
      message: error.message
    };
  }
}

export function resourcePeakProvenanceCheck() {
  try {
    const baseRecord = {
      title: "Resource peak provenance",
      status: "PASS",
      target: "runtime:stable",
      likelyOwner: "gateway-runtime",
      phases: [],
      violations: []
    };
    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-resource-peak-provenance",
      mode: "execution",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 2, statuses: { PASS: 2 } },
      records: [
        {
          ...baseRecord,
          scenario: "rss-heavy",
          state: { id: "first" },
          measurements: {
            resourceTopRolesByRss: [
              { role: "gateway", peakRssMb: 900, maxCpuPercent: 20 },
              { role: "agent", peakRssMb: 500, maxCpuPercent: 10 }
            ],
            resourceTopRolesByCpu: [
              { role: "agent", peakRssMb: 100, maxCpuPercent: 80 },
              { role: "gateway", peakRssMb: 200, maxCpuPercent: 40 }
            ]
          }
        },
        {
          ...baseRecord,
          scenario: "cpu-heavy",
          state: { id: "second" },
          measurements: {
            resourceTopRolesByRss: [{ role: "gateway", peakRssMb: 700, maxCpuPercent: 30 }],
            resourceTopRolesByCpu: [{ role: "gateway", peakRssMb: 300, maxCpuPercent: 220 }]
          }
        }
      ]
    });
    const gateway = "- gateway: RSS 900 MB (scenario rss-heavy/first); CPU 220% (scenario cpu-heavy/second)";
    const agent = "- agent: RSS 500 MB (scenario rss-heavy/first); CPU 80% (scenario rss-heavy/first)";
    assertEqual(rendered.includes(gateway), true, "RSS and CPU retain independent peak sources");
    assertEqual(rendered.includes(agent), true, "ranked lists retain independent metric values");
    assertEqual(rendered.indexOf(gateway) < rendered.indexOf(agent), true, "RSS rank order is preserved");
    const cpuOnlyRendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-cpu-only-role",
      mode: "execution",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 1, statuses: { PASS: 1 } },
      records: [{
        ...baseRecord,
        scenario: "split-rankings",
        measurements: {
          resourceTopRolesByRss: Array.from({ length: 8 }, (_, index) => ({
            role: `rss-${index}`,
            peakRssMb: 800 - index,
            maxCpuPercent: index
          })),
          resourceTopRolesByCpu: [{ role: "cpu-only", peakRssMb: 10, maxCpuPercent: 999 }]
        }
      }]
    });
    assertEqual(cpuOnlyRendered.includes("- cpu-only: RSS 10 MB"), true, "CPU-only top role survives display limit");
    const laterPeakRendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-later-global-peak",
      mode: "execution",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 2, statuses: { PASS: 2 } },
      records: [
        {
          ...baseRecord,
          scenario: "early-roles",
          measurements: {
            resourceTopRolesByRss: Array.from({ length: 8 }, (_, index) => ({
              role: `early-${index}`,
              peakRssMb: 100 - index,
              maxCpuPercent: 10 - index
            }))
          }
        },
        {
          ...baseRecord,
          scenario: "late-peak",
          measurements: {
            resourceTopRolesByRss: [{ role: "late-hot", peakRssMb: 2000, maxCpuPercent: 1500 }]
          }
        }
      ]
    });
    assertEqual(laterPeakRendered.includes("- late-hot: RSS 2000 MB"), true, "later global peak survives display limit");
    const roleKeyRendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-resource-role-keys",
      mode: "execution",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 1, statuses: { PASS: 1 } },
      records: [{
        ...baseRecord,
        scenario: "role-keys",
        measurements: {
          resourceTopRolesByRss: [{ role: "worker_name", peakRssMb: 500, maxCpuPercent: 50 }],
          resourceByRole: {
            worker_name: { peakRssMb: 500, maxCpuPercent: 50 },
            "unsafe\n## forged\n<script>": { peakRssMb: 4, maxCpuPercent: 4 },
            "## forged": { peakRssMb: 3, maxCpuPercent: 3 },
            "1) forged": { peakRssMb: 2, maxCpuPercent: 2 },
            "---": { peakRssMb: 1, maxCpuPercent: 1 }
          }
        }
      }]
    });
    assertEqual(roleKeyRendered.match(/worker\\_name/g)?.length, 1, "role array values and map keys share one identity");
    assertEqual(roleKeyRendered.includes("\n## forged"), false, "resource role keys cannot forge headings");
    assertEqual(roleKeyRendered.includes("<script>"), false, "resource role keys cannot inject raw HTML");
    assertEqual(roleKeyRendered.includes("- \\## forged:"), true, "ATX heading role keys stay inline");
    assertEqual(roleKeyRendered.includes("- 1\\) forged:"), true, "ordered-list role keys stay inline");
    assertEqual(roleKeyRendered.includes("- \\---:"), true, "thematic-rule role keys stay inline");
    const distinctRoleRendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-distinct-resource-role-keys",
      mode: "execution",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      summary: { total: 1, statuses: { PASS: 1 } },
      records: [{
        ...baseRecord,
        scenario: "distinct-role-keys",
        measurements: {
          resourceByRole: {
            "worker\nname": { peakRssMb: 900, maxCpuPercent: 10 },
            "worker name": { peakRssMb: 100, maxCpuPercent: 800 }
          }
        }
      }]
    });
    assertEqual(
      distinctRoleRendered.match(/- worker name: RSS/g)?.length,
      2,
      "roles remain distinct even when their escaped labels match"
    );
    assertEqual(distinctRoleRendered.includes("RSS 900 MB"), true, "first colliding role retains its RSS peak");
    assertEqual(distinctRoleRendered.includes("CPU 800%"), true, "second colliding role retains its CPU peak");
    return {
      id: "resource-peak-provenance",
      status: "PASS",
      command: "render divergent RSS and CPU peak sources",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-peak-provenance",
      status: "FAIL",
      command: "render divergent RSS and CPU peak sources",
      durationMs: 0,
      message: error.message
    };
  }
}

export function reportRecommendedNextScenarioCheck() {
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
