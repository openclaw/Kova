import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureProcessSnapshot,
  classifyRegistryRolesForProcess,
  classifySnapshotRolesForProcess,
  diffProcessSnapshots,
  startResourceSampler,
  summarizeResourceSamples
} from "../collectors/resources.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { loadProcessRoles } from "../registries/process-roles.mjs";
import { collectTargetRuntime } from "../run/finalize-record.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertArrayNotEmpty, assertEqual, assertString, sleep } from "./harness.mjs";

export function defaultGatewayResourceRoleCheck() {
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

export function gatewayProcessResourceRoleCheck() {
  try {
    const buildRecord = () => ({
      scenario: "gateway-process-resource-role",
      status: "PASS",
      phases: [{
        id: "scenario-command",
        measurementScope: "product",
        results: [{
          command: "synthetic",
          status: 0,
          durationMs: 1,
          resourceSamples: {
            schemaVersion: "kova.resourceSamples.v1",
            sampleCount: 1,
            peakTotalRssMb: 700,
            maxTotalCpuPercent: 80,
            peakGatewayRssMb: 700,
            byRole: {
              gateway: { peakRssMb: 700, maxCpuPercent: 80, peakProcessCount: 1 },
              "plugin-cli": { peakRssMb: 200, maxCpuPercent: 20, peakProcessCount: 1 }
            },
            topRolesByRss: [
              { role: "gateway", peakRssMb: 700, maxCpuPercent: 80 },
              { role: "plugin-cli", peakRssMb: 200, maxCpuPercent: 20 }
            ],
            topRolesByCpu: [
              { role: "gateway", peakRssMb: 700, maxCpuPercent: 80 },
              { role: "plugin-cli", peakRssMb: 200, maxCpuPercent: 20 }
            ],
            topByRss: [],
            topByCpu: []
          }
        }],
        metrics: {
          process: { pid: 123, rssMb: 1000, cpuPercent: 300, command: "openclaw-gateway" },
          logs: zeroLogMetrics()
        }
      }],
      finalMetrics: {
        process: { pid: 123, rssMb: 1100, cpuPercent: 320, command: "openclaw-gateway" },
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    });

    const gatewayRecord = buildRecord();
    evaluateRecord(gatewayRecord, { thresholds: { peakRssMb: 900, cpuPercentMax: 250 } }, {
      surface: {
        resourcePrimaryRole: "gateway",
        thresholds: {},
        roleThresholds: { gateway: { peakRssMb: 900, maxCpuPercent: 250 } }
      }
    });
    assertEqual(gatewayRecord.status, "FAIL", "gateway final process metrics fail resource gate");
    assertEqual(gatewayRecord.measurements.peakRssMb, 1100, "gateway final process RSS reaches headline gate");
    assertEqual(gatewayRecord.measurements.cpuPercentMax, 320, "gateway final process CPU reaches headline gate");
    assertEqual(gatewayRecord.measurements.resourceByRole.gateway.peakRssMb, 1100, "gateway role merges final process RSS");
    assertEqual(gatewayRecord.measurements.resourceByRole.gateway.maxCpuPercent, 320, "gateway role merges final process CPU");
    assertEqual(
      gatewayRecord.violations.some((violation) => violation.metric === "peakRssMb"),
      true,
      "headline RSS threshold sees final process"
    );
    assertEqual(
      gatewayRecord.violations.some((violation) => violation.metric === "cpuPercentMax"),
      true,
      "headline CPU threshold sees final process"
    );
    assertEqual(
      gatewayRecord.violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"),
      false,
      "gateway role RSS threshold is not duplicated"
    );
    assertEqual(
      gatewayRecord.violations.some((violation) => violation.metric === "resourceByRole.gateway.maxCpuPercent"),
      false,
      "gateway role CPU threshold is not duplicated"
    );

    const pluginRecord = buildRecord();
    evaluateRecord(pluginRecord, { thresholds: { peakRssMb: 300, cpuPercentMax: 50 } }, {
      surface: { resourcePrimaryRole: "plugin-cli", thresholds: {} }
    });
    assertEqual(pluginRecord.status, "PASS", "gateway final process metrics do not pollute plugin role gate");
    assertEqual(pluginRecord.measurements.peakRssMb, 200, "plugin role remains headline RSS gate");
    assertEqual(pluginRecord.measurements.cpuPercentMax, 20, "plugin role remains headline CPU gate");
    assertEqual(pluginRecord.measurements.resourceByRole.gateway.peakRssMb, 1100, "gateway final process RSS stays attributed");

    const finalOnlyRecord = buildRecord();
    delete finalOnlyRecord.phases[0].results[0].resourceSamples;
    delete finalOnlyRecord.phases[0].metrics.process;
    evaluateRecord(finalOnlyRecord, { thresholds: { peakRssMb: 1200, cpuPercentMax: 400 } }, {
      surface: { resourcePrimaryRole: "gateway", thresholds: {} }
    });
    assertEqual(finalOnlyRecord.status, "PASS", "final gateway process metrics satisfy configured role evidence");
    assertEqual(finalOnlyRecord.measurements.resourceGateKind, "role", "final gateway process avoids missing-role gate");
    assertEqual(finalOnlyRecord.measurements.peakRssMb, 1100, "final-only gateway RSS reaches headline gate");
    return {
      id: "gateway-process-resource-role",
      status: "PASS",
      command: "evaluate gateway process resource role attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-process-resource-role",
      status: "FAIL",
      command: "evaluate gateway process resource role attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function resourceSamplerFailureCheck() {
  try {
    const sampler = startResourceSampler(12345, {
      intervalMs: 250,
      processLister: () => ({
        ok: false,
        status: 1,
        error: "synthetic ps failure",
        processes: []
      })
    });
    await sleep(275);
    const summary = await sampler.stop();
    assertEqual(summary.available, false, "failed resource samples are unavailable");
    assertEqual(summary.successfulSampleCount, 0, "failed resource samples are excluded");
    assertEqual(summary.failedSampleCount >= 2, true, "failed resource sample count retained");
    assertEqual(summary.peakTotalRssMb, null, "failed resource samples do not synthesize zero RSS");
    assertEqual(summary.maxTotalCpuPercent, null, "failed resource samples do not synthesize zero CPU");
    assertEqual(summary.errors[0], "synthetic ps failure", "resource collection error retained");
    return {
      id: "resource-sampler-failure",
      status: "PASS",
      command: "summarize failed process-list observations",
      durationMs: 275
    };
  } catch (error) {
    return {
      id: "resource-sampler-failure",
      status: "FAIL",
      command: "summarize failed process-list observations",
      durationMs: 275,
      message: error.message
    };
  }
}

export async function resourceRoleAttributionCheck(tmp) {
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

export function resourceConfiguredRoleMissingCheck() {
  try {
    const record = {
      scenario: "mcp-tool-call",
      status: "PASS",
      phases: [{
        id: "mcp",
        measurementScope: "product",
        results: [{
          command: "node support/mcp-tool-call-smoke.mjs --env kova-self-check",
          status: 0,
          durationMs: 100,
          resourceSamples: {
            schemaVersion: "kova.resourceSamples.v1",
            sampleCount: 1,
            peakTotalRssMb: 1060,
            maxTotalCpuPercent: 120,
            peakCommandTreeRssMb: 410,
            peakGatewayRssMb: 650,
            byRole: {
              gateway: { peakRssMb: 650, maxCpuPercent: 80, peakProcessCount: 1 },
              "gateway-tree": { peakRssMb: 650, maxCpuPercent: 80, peakProcessCount: 1 },
              "tool-runtime": { peakRssMb: 410, maxCpuPercent: 120, peakProcessCount: 1 },
              "command-tree": { peakRssMb: 410, maxCpuPercent: 120, peakProcessCount: 1 }
            },
            topRolesByRss: [
              { role: "gateway", peakRssMb: 650, maxCpuPercent: 80 },
              { role: "tool-runtime", peakRssMb: 410, maxCpuPercent: 120 }
            ],
            topRolesByCpu: [
              { role: "tool-runtime", peakRssMb: 410, maxCpuPercent: 120 },
              { role: "gateway", peakRssMb: 650, maxCpuPercent: 80 }
            ],
            topByRss: [],
            topByCpu: []
          }
        }]
      }],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, { thresholds: { peakRssMb: 900 } }, {
      surface: {
        resourcePrimaryRole: "mcp-runtime",
        thresholds: {},
        roleThresholds: {
          "mcp-runtime": { peakRssMb: 400, maxCpuPercent: 60 },
          gateway: { peakRssMb: 850 },
          "tool-runtime": { peakRssMb: 500 }
        },
        diagnostics: { expectedSpans: [] }
      },
      targetPlan: { kind: "runtime" }
    });
    assertEqual(record.status, "FAIL", "missing configured primary role fails active resource threshold");
    assertEqual(record.measurements.peakRssMb, null, "missing primary role has no headline RSS value");
    assertEqual(record.measurements.resourceGateKind, "role-missing", "missing primary role gate kind");
    assertEqual(record.measurements.resourcePrimaryRole, "mcp-runtime", "configured primary role retained");
    assertEqual(record.measurements.resourceGateAttribution?.topRolesByRss?.[0]?.role, "gateway", "top RSS role retained for diagnosis");
    assertEqual(
      record.violations?.some((violation) => violation.metric === "resourceByRole.mcp-runtime.missing"),
      true,
      "missing configured role violation surfaced"
    );
    assertEqual(
      record.violations?.some((violation) => violation.metric === "peakRssMb"),
      false,
      "aggregate RSS is not reported as component RSS"
    );
    assertEqual(
      record.violations?.some((violation) => violation.metric === "cpuPercentMax"),
      false,
      "aggregate CPU is not judged against the missing primary role"
    );
    assertEqual(
      record.violations?.some((violation) => violation.metric === "resourceByRole.mcp-runtime.maxCpuPercent"),
      false,
      "missing primary role does not suppress or fabricate a role CPU measurement"
    );
    return {
      id: "resource-configured-role-missing",
      status: "PASS",
      command: "evaluate missing configured resource role RSS attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-configured-role-missing",
      status: "FAIL",
      command: "evaluate missing configured resource role RSS attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function resourceRootCommandRoleBoundaryCheck() {
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

export async function resourceRolePollutionCheck() {
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
    const openclawWrapperRoles = classifyRegistryRolesForProcess(
      { command: "openclaw" },
      {
        processRoles,
        rootCommand: "ocm @kova -- agent --local --message hi",
        existingRoles: ["command-tree"]
      }
    );
    const openclawSessionCliRoles = classifyRegistryRolesForProcess(
      { command: "openclaw agent --session-id kova-agent" },
      {
        processRoles,
        rootCommand: "ocm @kova -- agent --session-id kova-agent --message hi",
        existingRoles: ["command-tree"]
      }
    );
    const openclawMessageSessionRoles = classifyRegistryRolesForProcess(
      { command: "openclaw agent --message session" },
      {
        processRoles,
        rootCommand: "ocm @kova -- agent --message session",
        existingRoles: ["command-tree"]
      }
    );
    const openclawAgentSessionRoles = classifyRegistryRolesForProcess(
      { command: "openclaw-agent --session-id kova-agent" },
      {
        processRoles,
        rootCommand: "ocm @kova -- agent --session-id kova-agent --message hi",
        existingRoles: ["command-tree"]
      }
    );
    const trackedProvider = startResourceSampler(process.pid, {
      trackedRolePids: { "mock-provider": process.pid }
    });
    const trackedProviderSummary = await trackedProvider.stop();
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
    assertEqual(openclawAgentRoles.includes("agent-cli"), false, "openclaw-agent process must not imply agent-cli");
    assertEqual(openclawAgentRoles.includes("agent-process"), true, "openclaw-agent process must imply agent-process");
    assertEqual(openclawWrapperRoles.includes("agent-cli"), true, "generic OpenClaw wrapper inherits agent CLI command role");
    assertEqual(openclawWrapperRoles.includes("agent-process"), false, "generic OpenClaw wrapper must not imply agent process");
    assertEqual(openclawSessionCliRoles.includes("agent-cli"), true, "agent session-id CLI remains attributed to agent CLI");
    assertEqual(openclawSessionCliRoles.includes("agent-process"), false, "session-id option must not imply agent process");
    assertEqual(openclawMessageSessionRoles.includes("agent-cli"), true, "agent message CLI remains attributed to agent CLI");
    assertEqual(openclawMessageSessionRoles.includes("agent-process"), false, "session message text must not imply agent process");
    assertEqual(openclawAgentSessionRoles.includes("agent-cli"), false, "agent process pattern outranks session-id command text");
    assertEqual(openclawAgentSessionRoles.includes("agent-process"), true, "agent process with session-id remains attributed");
    assertEqual(
      Boolean(trackedProviderSummary.byRole?.["mock-provider"]),
      true,
      "explicit mock provider owner PID is sampled outside command matching"
    );
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

export async function resourceGatewayPidLookupCheck(tmp, scope) {
  const binDir = join(tmp, "resource-gateway-pid-bin");
  const lookupLog = join(tmp, "resource-gateway-pid-lookups.log");
  const fakeOcm = join(binDir, "ocm");
  const fakeShell = join(binDir, "shell");
  await mkdir(binDir, { recursive: true });
  const runningEnvName = `${scope.envName}-resource-running`;
  const missingEnvName = `${scope.envName}-resource-missing`;
  await writeFile(fakeOcm, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
if [ "$3" = ${quoteShell(runningEnvName)} ]; then
  printf '{"childPid":%s}\\n' "$KOVA_MOCK_GATEWAY_PID"
else
  printf '{"childPid":null}\\n'
fi
`, "utf8");
  await writeFile(fakeShell, `#!/bin/sh
exec /bin/sh -c "$2"
`, "utf8");
  await chmod(fakeOcm, 0o755);
  await chmod(fakeShell, 0o755);

  const commandEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    KOVA_MOCK_OCM_LOG: lookupLog,
    KOVA_MOCK_GATEWAY_PID: String(process.pid),
    SHELL: fakeShell
  };

  try {
    const first = startResourceSampler(process.pid, {
      envName: runningEnvName,
      intervalMs: 250,
      commandEnv
    });
    await first.stop();
    const second = startResourceSampler(process.pid, {
      envName: runningEnvName,
      intervalMs: 250,
      commandEnv
    });
    await second.stop();

    const missing = startResourceSampler(process.pid, {
      envName: missingEnvName,
      intervalMs: 250,
      commandEnv
    });
    await sleep(600);
    const missingSummary = await missing.stop();

    const lookups = (await readFile(lookupLog, "utf8")).trim().split("\n").filter(Boolean);
    assertEqual(
      lookups.filter((line) => line.includes(runningEnvName)).length,
      1,
      "live gateway pid reused across samplers"
    );
    assertEqual(
      lookups.filter((line) => line.includes(missingEnvName)).length >= 3,
      true,
      "missing gateway pid lookup retries on the next sample"
    );
    assertEqual(missingSummary.sampleCount >= 3, true, "missing gateway sampler collected repeated samples");
    return {
      id: "resource-gateway-pid-lookups",
      status: "PASS",
      command: "reuse live gateway pid and retry missing pid lookups",
      durationMs: 600
    };
  } catch (error) {
    return {
      id: "resource-gateway-pid-lookups",
      status: "FAIL",
      command: "reuse live gateway pid and back off missing pid lookups",
      durationMs: 600,
      message: error.message
    };
  }
}

export async function targetRuntimeEvidenceCheck() {
  try {
    const commands = [];
    const execute = async (command, options) => {
      commands.push({ command, timeoutMs: options.timeoutMs });
      if (command.includes("'--port'")) {
        return { status: 1, stderr: 'OpenClaw does not recognize option "--port".' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ nodeVersion: "v22.22.3", pid: 4242, port: 19000 })
      };
    };
    const trusted = await collectTargetRuntime("Team Env", 4242, 19000, 5000, execute);
    assertEqual(
      commands[0]?.command,
      "ocm @'Team Env' -- 'gateway' 'call' 'system.info' '--json'",
      "target runtime uses supported RPC options in the selected OCM env"
    );
    assertEqual(trusted.collectionStatus, "ok", "matching Gateway runtime identity is trusted");
    assertEqual(trusted.nodeVersion, "v22.22.3", "Gateway-reported Node version is retained");

    const mismatch = await collectTargetRuntime("Team Env", 4343, 19000, 5000, execute);
    assertEqual(mismatch.collectionStatus, "identity-mismatch", "Gateway identity mismatch is untrusted");
    assertEqual(mismatch.nodeVersion, null, "PID mismatch cannot select a Node baseline");

    const wrongPort = await collectTargetRuntime("Team Env", 4242, 19001, 5000, execute);
    assertEqual(wrongPort.collectionStatus, "identity-mismatch", "Gateway port mismatch is untrusted");
    assertEqual(wrongPort.nodeVersion, null, "port mismatch cannot select a Node baseline");

    const malformed = await collectTargetRuntime("Team Env", 4242, 19000, 5000, async () => ({
      status: 0,
      stdout: JSON.stringify({ nodeVersion: "unknown", pid: 4242, port: 19000 })
    }));
    assertEqual(malformed.collectionStatus, "invalid-payload", "malformed Gateway runtime payload is untrusted");

    const prerelease = await collectTargetRuntime("Team Env", 4242, 19000, 5000, async () => ({
      status: 0,
      stdout: JSON.stringify({ nodeVersion: "v24.0.0-rc.1", pid: 4242, port: 19000 })
    }));
    assertEqual(prerelease.collectionStatus, "ok", "valid Node prerelease version is trusted");

    let compatibilityCommands = 0;
    const compatible = await collectTargetRuntime("Team Env", 4242, 19000, 5000, async () => {
      compatibilityCommands += 1;
      return compatibilityCommands === 1
        ? {
            status: 1,
            stdout: JSON.stringify({ error: { message: "unknown method: system.info" } })
          }
        : {
            status: 0,
            stdout: "OS  macOS 14.7 · node 22.22.3\n"
          };
    });
    assertEqual(compatible.collectionStatus, "compatibility-fallback", "older Gateway uses its bound runtime version");
    assertEqual(compatible.nodeVersion, "22.22.3", "older Gateway runtime major is retained");

    const failed = await collectTargetRuntime("Team Env", 4242, 19000, 5000, async () => ({
      status: 1,
      stdout: "{\"token\":\"must-not-be-retained\"}"
    }));
    assertEqual(failed.collectionStatus, "command-failed", "failed Gateway runtime query is untrusted");
    assertEqual(JSON.stringify(failed).includes("must-not-be-retained"), false, "runtime query failure output is not retained");

    let missingPidCommands = 0;
    const missingPid = await collectTargetRuntime("Team Env", null, 19000, 5000, async () => {
      missingPidCommands += 1;
      return { status: 0, stdout: "{}" };
    });
    assertEqual(missingPid.collectionStatus, "missing-service-identity", "missing OCM Gateway identity is untrusted");
    assertEqual(missingPidCommands, 0, "missing OCM Gateway PID skips the RPC");

    return {
      id: "target-runtime-evidence",
      status: "PASS",
      command: "validate Gateway runtime identity collection",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "target-runtime-evidence",
      status: "FAIL",
      command: "validate Gateway runtime identity collection",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function processSnapshotCheck(tmp, scope) {
  const processRoles = await loadProcessRoles();
  const rootCommand = `ocm @${scope.envName} -- agent --local --session-id ${scope.sessionPrefix} --message hi`;
  const commandEnv = { KOVA_HOME: join(tmp, "kova-home") };
  const customValue = `${scope.id}-custom-redaction-value`;
  const flagValue = `${scope.id}-client-redaction-value`;
  const headerValue = `${scope.id}-header-redaction-value`;
  const urlValue = `${scope.id}-url-redaction-value`;
  const child = runCommand(
    `node -e 'setTimeout(() => {}, 1200)' openclaw-agent ${scope.envName} --client-secret ${flagValue} --header 'Authorization: Bearer ${headerValue}' https://user:${urlValue}@example.test ${customValue}`,
    {
    timeoutMs: 5000,
    resourceSample: null
    }
  );
  await sleep(250);
  const before = captureProcessSnapshot({
    processRoles,
    envName: scope.envName,
    rootCommand,
    commandEnv,
    redactValues: [customValue]
  });
  const result = await child;
  const after = captureProcessSnapshot({
    processRoles,
    envName: scope.envName,
    rootCommand,
    commandEnv,
    redactValues: [customValue]
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
      envName: scope.envName,
      rootCommand
    });
    const scopedBrowserRoles = classifySnapshotRolesForProcess({
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/${scope.id}/browser`
    }, {
      processRoles,
      envName: scope.envName,
      rootCommand
    });
    const gatewayBrowserRoles = classifySnapshotRolesForProcess({
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer"
    }, {
      processRoles,
      existingRoles: ["gateway-tree"],
      envName: scope.envName
    });
    const scopedAgentRoles = classifySnapshotRolesForProcess({
      command: `openclaw-agent --session-id ${scope.sessionPrefix}`
    }, {
      processRoles,
      envName: scope.envName,
      rootCommand
    });
    assertEqual(result.status, 0, "snapshot command status");
    assertEqual(before.schemaVersion, "kova.processSnapshot.v1", "snapshot schema");
    assertEqual(leaks.schemaVersion, "kova.processLeakSummary.v1", "leak summary schema");
    assertEqual(typeof leaks.leakCount, "number", "leak count type");
    assertEqual(unrelatedBrowserRoles.includes("browser-sidecar"), false, "unrelated browser process excluded from snapshot role");
    assertEqual(scopedBrowserRoles.includes("browser-sidecar"), true, "scoped browser process retained");
    assertEqual(gatewayBrowserRoles.includes("browser-sidecar"), true, "gateway child browser process retained");
    assertEqual(scopedAgentRoles.includes("agent-cli"), false, "scoped agent process is not attributed to the CLI wrapper");
    assertEqual(scopedAgentRoles.includes("agent-process"), true, "scoped agent process retained");
    const retainedCommands = before.processes.map((process) => process.command).join("\n");
    for (const value of [customValue, flagValue, headerValue, urlValue]) {
      assertEqual(retainedCommands.includes(value), false, `process snapshot redacts ${value}`);
    }
    assertEqual(retainedCommands.includes("--client-secret [redacted]"), true, "process snapshot redacts client-secret flag");
    assertEqual(retainedCommands.includes("Authorization: [redacted]"), true, "process snapshot redacts authorization header");
    assertEqual(retainedCommands.includes("https://[redacted]@example.test"), true, "process snapshot redacts credential URL");
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
