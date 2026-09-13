import { buildAgentTurnBreakdown, summarizeAgentTurnBreakdownForMarkdown } from "../collectors/agent-turns.mjs";
import {
  summarizeEmbeddedRunTraces,
  summarizeLivenessWarnings,
  summarizeRuntimeDepsLogs
} from "../collectors/logs.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { renderPasteSummary } from "../reporting/report.mjs";
import { runtimeDepsRecord } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function runtimeDepsLogParserCheck() {
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

export function embeddedRunLogParserCheck() {
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

export function runtimeDepsWarmReuseEvaluationCheck() {
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
