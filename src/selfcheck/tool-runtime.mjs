import { evaluateRecord } from "../evaluator.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function mcpBridgeEvidenceEvaluationCheck() {
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

export function toolRuntimeEvidenceEvaluationCheck() {
  try {
    const cronSmoke = {
      schemaVersion: "kova.cronRuntimeSmoke.v1",
      durationMs: 1700,
      cronStatusMs: 110,
      cronRegisterMs: 220,
      cronRunMs: 650,
      cronRunsMs: 140,
      cronRunCompleted: true,
      cronRunTimedOut: false,
      cronTriggerAttributed: true,
      errors: []
    };
    const execSmoke = {
      schemaVersion: "kova.execToolSafety.v1",
      durationMs: 2300,
      safeCommandMs: 480,
      safeCommandSucceeded: true,
      safeCommandBoundary: "openclaw-agent-exec-tool",
      dangerousPayload: "rm -rf /tmp/kova-self-check-sentinel",
      dangerousCommandBoundary: "openclaw-agent-exec-tool",
      dangerousPayloadExecuted: false,
      dangerousCommandBlocked: true,
      dangerousSentinelStillPresent: true,
      outputTruncated: true,
      timeoutMs: 1000,
      timeoutObserved: true,
      processLeaks: 0,
      leakedProcesses: [],
      processSnapshotPaths: {
        before: "/tmp/kova/exec-tool-processes-before.json",
        after: "/tmp/kova/exec-tool-processes-after.json",
        leaks: "/tmp/kova/exec-tool-process-leaks.json"
      },
      errors: []
    };
    const mcpToolSmoke = {
      schemaVersion: "kova.mcpToolCallSmoke.v1",
      durationMs: 1300,
      initializeMs: 100,
      toolsListMs: 80,
      toolsCallMs: 240,
      invalidToolsCallMs: 90,
      shutdownMs: 40,
      toolCount: 4,
      toolNames: ["conversations_list", "messages_read"],
      safeToolName: "conversations_list",
      safeToolSucceeded: true,
      invalidToolErrorAttributed: true,
      processExited: true,
      errors: []
    };
    const record = {
      scenario: "tool-runtime-matrix",
      status: "PASS",
      phases: [{
        id: "tool-runtime",
        results: [
          {
            command: "node support/run-cron-runtime-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
            status: 0,
            timedOut: false,
            durationMs: 1700,
            stdout: JSON.stringify(cronSmoke),
            stderr: ""
          },
          {
            command: "node support/run-exec-tool-safety.mjs --env kova-self-check --artifact-dir /tmp/kova",
            status: 0,
            timedOut: false,
            durationMs: 2300,
            stdout: JSON.stringify(execSmoke),
            stderr: ""
          },
          {
            command: "node support/mcp-tool-call-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
            status: 0,
            timedOut: false,
            durationMs: 1300,
            stdout: JSON.stringify(mcpToolSmoke),
            stderr: ""
          }
        ],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "tool-runtime-matrix",
      thresholds: {
        cronRegisterMs: 5000,
        cronRunMs: 5000,
        execSafeCommandMs: 5000,
        execSafeCommandSucceeded: 1,
        execDangerousCommandBlocked: 1,
        execOutputTruncated: 1,
        execTimeoutMs: 2000,
        execProcessLeaks: 0,
        mcpInitializeMs: 5000,
        mcpToolsListMs: 5000,
        mcpToolsCallMs: 5000,
        mcpToolCallSucceeded: 1,
        mcpToolCallErrorAttributed: 1,
        mcpShutdownMs: 5000,
        mcpToolCountMin: 1,
        mcpProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "tool runtime record status");
    assertEqual(record.measurements.cronRegisterMs, 220, "cron register ms");
    assertEqual(record.measurements.cronRunMs, 650, "cron run ms");
    assertEqual(record.measurements.cronRunCompleted, true, "cron run completed");
    assertEqual(record.measurements.cronTriggerAttributed, true, "cron trigger attributed");
    assertEqual(record.measurements.execSafeCommandMs, 480, "exec safe command ms");
    assertEqual(record.measurements.execDangerousCommandBlocked, true, "exec dangerous command blocked");
    assertEqual(record.measurements.execDangerousPayloadExecuted, false, "exec dangerous payload not executed");
    assertEqual(record.measurements.execProcessLeaks, 0, "exec process leak count");
    assertEqual(record.measurements.mcpInitializeMs, 100, "MCP initialize ms");
    assertEqual(record.measurements.mcpToolsListMs, 80, "MCP tools/list ms");
    assertEqual(record.measurements.mcpToolsCallMs, 240, "MCP tools/call ms");
    assertEqual(record.measurements.mcpToolCallSucceeded, true, "MCP safe tools/call succeeded");
    assertEqual(record.measurements.mcpToolCallErrorAttributed, true, "MCP tool-call error attributed");
    assertEqual(record.measurements.mcpShutdownMs, 40, "MCP shutdown ms");
    assertEqual(record.measurements.mcpToolCount, 4, "MCP tool count");
    assertEqual(record.measurements.mcpProcessLeaks, 0, "MCP process leak count");

    const expectedPluginFailureRecord = {
      scenario: "plugin-legacy-unsafe-memory",
      status: "PASS",
      phases: [{
        id: "survival",
        results: [{
          command: "ocm logs kova-self-check --tail 500 --raw",
          status: 0,
          timedOut: false,
          durationMs: 20,
          stdout: "[plugins] kova-legacy-unsafe-memory failed during register: Error: KOVA_LEGACY_UNSAFE_MEMORY_PLUGIN_REJECTED blocked=4/4\n",
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(expectedPluginFailureRecord, {
      id: "plugin-legacy-unsafe-memory",
      expectedPluginFailureMarkers: ["KOVA_LEGACY_UNSAFE_MEMORY_PLUGIN_REJECTED"],
      thresholds: { pluginLoadFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(expectedPluginFailureRecord.status, "PASS", "expected plugin failure marker ignored");
    assertEqual(expectedPluginFailureRecord.measurements.pluginLoadFailures, 0, "expected plugin failure marker does not count as generic plugin failure");

    const unexpectedPluginFailureRecord = {
      ...expectedPluginFailureRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "survival",
        results: [{
          command: "ocm logs kova-self-check --tail 500 --raw",
          status: 0,
          timedOut: false,
          durationMs: 20,
          stdout: "[plugins] unrelated-plugin failed during register: Error: boom\n",
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(unexpectedPluginFailureRecord, {
      id: "plugin-legacy-unsafe-memory",
      expectedPluginFailureMarkers: ["KOVA_LEGACY_UNSAFE_MEMORY_PLUGIN_REJECTED"],
      thresholds: { pluginLoadFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(unexpectedPluginFailureRecord.status, "FAIL", "unexpected plugin failure still fails");
    assertEqual(
      unexpectedPluginFailureRecord.violations.some((violation) => violation.metric === "pluginLoadFailures"),
      true,
      "unexpected plugin failure violation surfaced"
    );

    const unattributedCron = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [{
          command: "node support/run-cron-runtime-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1700,
          stdout: JSON.stringify({
            ...cronSmoke,
            cronTriggerAttributed: false
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(unattributedCron, {
      id: "cron-runtime",
      thresholds: {
        cronRunCompleted: 1,
        cronTriggerAttributed: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(unattributedCron.status, "FAIL", "unattributed cron status");
    assertEqual(
      unattributedCron.violations.some((violation) => violation.metric === "cronTriggerAttributed"),
      true,
      "cron trigger attribution violation surfaced"
    );

    const missingCronEvidence = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(missingCronEvidence, {
      id: "cron-runtime",
      thresholds: {
        cronRegisterMs: 5000,
        cronRunMs: 5000,
        cronRunCompleted: 1,
        cronTriggerAttributed: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingCronEvidence.status, "FAIL", "missing cron evidence status");
    assertEqual(
      missingCronEvidence.violations.some((violation) => [
        "cronRegisterMs",
        "cronRunMs",
        "cronRunCompleted",
        "cronTriggerAttributed"
      ].includes(violation.metric)),
      true,
      "missing cron helper evidence failed closed"
    );

    const missingExecEvidence = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(missingExecEvidence, {
      id: "exec-tool-safety",
      thresholds: {
        execSafeCommandSucceeded: 1,
        execDangerousCommandBlocked: 1,
        execOutputTruncated: 1,
        execProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingExecEvidence.status, "FAIL", "missing exec evidence status");
    assertEqual(
      missingExecEvidence.violations.some((violation) => [
        "execSafeCommandSucceeded",
        "execDangerousCommandBlocked",
        "execOutputTruncated",
        "execProcessLeaks"
      ].includes(violation.metric)),
      true,
      "missing exec helper evidence failed closed"
    );

    const incompleteExecEvidence = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [{
          command: "node support/run-exec-tool-safety.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 2300,
          stdout: JSON.stringify({
            schemaVersion: "kova.execToolSafety.v1",
            errors: []
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(incompleteExecEvidence, {
      id: "exec-tool-safety",
      thresholds: {
        execSafeCommandSucceeded: 1,
        execDangerousCommandBlocked: 1,
        execOutputTruncated: 1,
        execProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(incompleteExecEvidence.status, "FAIL", "incomplete exec evidence status");
    assertEqual(
      incompleteExecEvidence.violations.some((violation) => [
        "execSafeCommandSucceeded",
        "execDangerousCommandBlocked",
        "execOutputTruncated",
        "execProcessLeaks"
      ].includes(violation.metric)),
      true,
      "incomplete exec helper evidence failed closed"
    );

    const leakedExecEvidence = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [{
          command: "node support/run-exec-tool-safety.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 2300,
          stdout: JSON.stringify({
            ...execSmoke,
            processLeaks: 1,
            leakedProcesses: [{ pid: 12345, role: "gateway-tree", command: "sleep 30" }]
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(leakedExecEvidence, {
      id: "exec-tool-safety",
      thresholds: {
        execProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(leakedExecEvidence.status, "FAIL", "leaked exec process status");
    assertEqual(
      leakedExecEvidence.violations.some((violation) => violation.metric === "execProcessLeaks"),
      true,
      "exec process leak violation"
    );

    const missingMcpToolEvidence = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(missingMcpToolEvidence, {
      id: "mcp-tool-call",
      thresholds: {
        mcpInitializeMs: 5000,
        mcpToolsListMs: 5000,
        mcpToolsCallMs: 5000,
        mcpToolCallSucceeded: 1,
        mcpToolCallErrorAttributed: 1,
        mcpShutdownMs: 5000,
        mcpToolCountMin: 1,
        mcpProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingMcpToolEvidence.status, "FAIL", "missing MCP tool-call evidence status");
    assertEqual(
      missingMcpToolEvidence.violations.some((violation) => [
        "mcpInitializeMs",
        "mcpToolsListMs",
        "mcpToolsCallMs",
        "mcpToolCallSucceeded",
        "mcpToolCallErrorAttributed",
        "mcpShutdownMs",
        "mcpToolCountMin",
        "mcpProcessLeaks"
      ].includes(violation.metric)),
      true,
      "missing MCP tool-call helper evidence failed closed"
    );

    const incompleteMcpToolEvidence = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [{
          command: "node support/mcp-tool-call-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1300,
          stdout: JSON.stringify({
            schemaVersion: "kova.mcpToolCallSmoke.v1",
            errors: []
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(incompleteMcpToolEvidence, {
      id: "mcp-tool-call",
      thresholds: {
        mcpInitializeMs: 5000,
        mcpToolsListMs: 5000,
        mcpToolsCallMs: 5000,
        mcpToolCallSucceeded: 1,
        mcpToolCallErrorAttributed: 1,
        mcpShutdownMs: 5000,
        mcpToolCountMin: 1,
        mcpProcessLeaks: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(incompleteMcpToolEvidence.status, "FAIL", "incomplete MCP tool-call evidence status");
    assertEqual(
      incompleteMcpToolEvidence.violations.some((violation) => [
        "mcpInitializeMs",
        "mcpToolsListMs",
        "mcpToolsCallMs",
        "mcpToolCallSucceeded",
        "mcpToolCallErrorAttributed",
        "mcpShutdownMs",
        "mcpToolCountMin",
        "mcpProcessLeaks"
      ].includes(violation.metric)),
      true,
      "incomplete MCP tool-call helper evidence failed closed"
    );

    const slowMcpLifecycle = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [{
          command: "node support/mcp-tool-call-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1300,
          stdout: JSON.stringify({
            ...mcpToolSmoke,
            initializeMs: 6000,
            toolsListMs: 7000,
            shutdownMs: 8000,
            toolCount: 0
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(slowMcpLifecycle, {
      id: "mcp-tool-call",
      thresholds: {
        mcpInitializeMs: 5000,
        mcpToolsListMs: 5000,
        mcpShutdownMs: 5000,
        mcpToolCountMin: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(slowMcpLifecycle.status, "FAIL", "slow MCP lifecycle status");
    assertEqual(
      ["mcpInitializeMs", "mcpToolsListMs", "mcpShutdownMs", "mcpToolCountMin"].every((metric) =>
        slowMcpLifecycle.violations.some((violation) => violation.metric === metric)
      ),
      true,
      "slow MCP lifecycle violations surfaced"
    );

    const failedExec = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "tool-runtime",
        results: [{
          command: "node support/run-exec-tool-safety.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 1,
          timedOut: false,
          durationMs: 2300,
          stdout: JSON.stringify({
            ...execSmoke,
            dangerousPayloadExecuted: true,
            dangerousCommandBlocked: false,
            dangerousSentinelStillPresent: false
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failedExec, {
      id: "exec-tool-safety",
      thresholds: {
        execDangerousCommandBlocked: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failedExec.status, "FAIL", "failed exec safety status");
    assertEqual(
      failedExec.violations.some((violation) => violation.metric === "execDangerousCommandBlocked" || violation.metric === "execDangerousPayloadExecuted"),
      true,
      "exec safety violation surfaced"
    );

    return {
      id: "tool-runtime-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic tool runtime evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "tool-runtime-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic tool runtime evidence",
      durationMs: 0,
      message: error.message
    };
  }
}
