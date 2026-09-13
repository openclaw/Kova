import { readFile, rm } from "node:fs/promises";
import { quoteShell, runCommand } from "../commands.mjs";
import { evaluateGate } from "../matrix/gate.mjs";
import { renderReportSummary } from "../reporting/report.mjs";
import { runEntries } from "../run/engine.mjs";
import { assertEqual, assertString, readSelfCheckJson } from "./harness.mjs";

export async function matrixWorkerRejectionCheck() {
  const firstError = new Error("synthetic matrix worker failure");
  const started = [];
  const completed = [];
  try {
    let caught;
    try {
      await runEntries({
        entries: [0, 1, 2, 3],
        execute: true,
        controls: { parallel: 2, failFast: false },
        runEntry: async (entry) => {
          started.push(entry);
          if (entry === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw firstError;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          completed.push(entry);
          return [{ status: "PASS" }];
        }
      });
    } catch (error) {
      caught = error;
    }
    assertEqual(caught, firstError, "parallel matrix rethrows first worker error");
    assertEqual(started.join(","), "0,1", "parallel matrix stops assigning new entries after rejection");
    assertEqual(completed.join(","), "1", "parallel matrix drains active workers before rejecting");

    const serialStarted = [];
    const serialRecords = await runEntries({
      entries: [0, 1],
      execute: true,
      controls: { parallel: 1, failFast: true },
      runEntry: async (entry) => {
        serialStarted.push(entry);
        return [{ status: entry === 0 ? "FAIL" : "PASS" }];
      }
    });
    assertEqual(serialStarted.join(","), "0", "serial fail-fast stops after first non-passing record");
    assertEqual(serialRecords.length, 1, "serial fail-fast returns completed records");

    return {
      id: "matrix-worker-rejection",
      status: "PASS",
      command: "reject parallel matrix worker and drain active work",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "matrix-worker-rejection",
      status: "FAIL",
      command: "reject parallel matrix worker and drain active work",
      durationMs: 0,
      message: error.message
    };
  }
}

export function gatePartialFailureCheck() {
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

export function gatePartialPassCheck() {
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

export function gatePlatformCoverageCheck() {
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

export function gateNonReleaseOutcomeCheck() {
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

export function gateRequirementCoverageCheck() {
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

export function gateScenarioWildcardCheck() {
  try {
    const passingGate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      records: [{
        scenario: "doctor-repair-upgrade",
        surface: "upgrade-existing-user",
        state: { id: "legacy-core-config", traits: ["legacy-config"] },
        status: "PASS",
        title: "Doctor Repair Upgrade",
        likelyOwner: "OpenClaw",
        phases: []
      }]
    }, {
      id: "doctor-upgrade",
      gate: {
        id: "doctor-upgrade-gate",
        blocking: [{ scenario: "doctor-repair-upgrade" }]
      }
    });
    assertEqual(passingGate.verdict, "SHIP", "scenario-only blocking entry matches stateful record");
    assertEqual(passingGate.missingRequiredCount, 0, "scenario-only blocking entry is not missing");

    for (const status of ["DRY-RUN", "SKIPPED"]) {
      const unexecutedGate = evaluateGate({
        mode: "execution",
        controls: { include: [], exclude: [] },
        records: [{
          scenario: "doctor-repair-upgrade",
          surface: "upgrade-existing-user",
          state: { id: "legacy-core-config", traits: ["legacy-config"] },
          status,
          title: "Doctor Repair Upgrade",
          likelyOwner: "Kova",
          phases: []
        }]
      }, {
        id: "doctor-upgrade",
        gate: {
          id: "doctor-upgrade-gate",
          blocking: [{ scenario: "doctor-repair-upgrade" }]
        }
      });
      assertEqual(unexecutedGate.missingRequiredCount, 1, `scenario-only blocking entry ignores ${status} records`);
      assertEqual(
        unexecutedGate.cards.some((card) => card.kind === "missing-required-scenario"),
        true,
        `${status} record leaves required scenario missing`
      );
    }

    const warningGate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      records: [{
        scenario: "agent-provider-timeout",
        surface: "agent-cli-local-turn",
        state: { id: "mock-openai-provider", traits: ["mock-provider"] },
        status: "FAIL",
        title: "Agent Provider Timeout",
        likelyOwner: "OpenClaw",
        phases: []
      }]
    }, {
      id: "provider-warning",
      gate: {
        id: "provider-warning-gate",
        blocking: [],
        warning: [{ scenario: "agent-provider-timeout" }]
      }
    });
    assertEqual(warningGate.verdict, "SHIP", "scenario-only warning entry matches stateful failure");
    assertEqual(warningGate.warningCount, 1, "scenario-only warning classifies stateful failure");
    assertEqual(warningGate.blockingCount, 0, "scenario-only warning does not become blocking");

    return {
      id: "gate-scenario-wildcard-state",
      status: "PASS",
      command: "evaluate scenario-only gate entries against stateful records",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-scenario-wildcard-state",
      status: "FAIL",
      command: "evaluate scenario-only gate entries against stateful records",
      durationMs: 0,
      message: error.message
    };
  }
}

export function gateExecutedCoverageDimensionsCheck() {
  try {
    const profile = {
      id: "release",
      gate: {
        id: "executed-coverage-gate",
        coverage: {
          platforms: { blocking: ["darwin-arm64"] },
          requirements: { blocking: ["release-runtime-startup:baseline"] }
        },
        blocking: [{ scenario: "release-runtime-startup", state: "fresh" }]
      }
    };
    const resolvedCoverage = {
      obligations: [{
        surface: "release-runtime-startup",
        requirement: "baseline",
        scenario: "release-runtime-startup",
        state: "fresh",
        stateTraits: ["fresh-user"],
        status: "planned"
      }]
    };
    const emptyGate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      platform: { os: "darwin", arch: "arm64" },
      records: []
    }, profile, { resolvedCoverage });
    const missingDimensions = new Set(emptyGate.cards
      .filter((card) => card.kind === "missing-required-coverage")
      .map((card) => card.coverage));
    assertEqual(
      [...missingDimensions].sort().join(","),
      ["platform", "requirement", "scenario", "state", "state-surface", "surface", "trait"].sort().join(","),
      "gate checks every coverage dimension against executed records"
    );

    const completeGate = evaluateGate({
      mode: "execution",
      controls: { include: [], exclude: [] },
      platform: { os: "darwin", arch: "arm64" },
      records: [{
        scenario: "release-runtime-startup",
        surface: "release-runtime-startup",
        state: { id: "fresh", traits: ["fresh-user"] },
        status: "PASS",
        title: "Release Runtime Startup",
        likelyOwner: "OpenClaw",
        phases: []
      }]
    }, profile, { resolvedCoverage });
    assertEqual(completeGate.verdict, "SHIP", "executed record satisfies all seven coverage dimensions");
    assertEqual(completeGate.missingRequiredCount, 0, "complete executed coverage has no gaps");

    return {
      id: "gate-executed-coverage-dimensions",
      status: "PASS",
      command: "evaluate all gate coverage dimensions from executed records",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-executed-coverage-dimensions",
      status: "FAIL",
      command: "evaluate all gate coverage dimensions from executed records",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function doctorUpgradeGatePolicyCheck() {
  try {
    const profile = await readSelfCheckJson("profiles", "doctor-upgrade.json");
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

export function gateSubsystemSummaryCheck() {
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

export async function gateDryRunCheck(tmp) {
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
    assertEqual(data.gate?.complete, false, "gate dry-run is incomplete");
    const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
    assertEqual(report.gate?.cards?.some((card) => card.kind === "not-executed"), true, "gate not-executed card");
    const summary = renderReportSummary(report, { structured: true });
    assertString(summary.failureBrief?.fixerPrompt, "failure brief fixer prompt");
    assertString(data.retainedGateArtifacts?.outputDir, "retained gate artifact dir");
    assertString(data.retainedGateArtifacts?.pasteSummaryPath, "retained paste summary path");
    const retained = JSON.parse(await readFile(`${data.retainedGateArtifacts.outputDir}/retained-artifacts.json`, "utf8"));
    assertEqual(retained.verdict, "BLOCKED", "retained artifact verdict");
    await rm(data.retainedGateArtifacts.outputDir, { recursive: true, force: true });

    const skippedGate = evaluateGate({
      mode: "execution",
      records: [{
        scenario: "release-runtime-startup",
        state: { id: "fresh" },
        status: "SKIPPED",
        title: "Release Runtime Startup",
        phases: []
      }]
    }, {
      id: "skipped-gate",
      gate: {
        id: "skipped-gate",
        blocking: [{ scenario: "release-runtime-startup", state: "fresh" }]
      }
    });
    assertEqual(skippedGate.verdict, "BLOCKED", "required skipped gate verdict");
    assertEqual(skippedGate.complete, false, "required skipped gate is incomplete");
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
