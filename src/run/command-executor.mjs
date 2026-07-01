import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  attachCommandResultInterpretation,
  normalizeOptionalCommandResult
} from "../command-results.mjs";
import { runCommand } from "../commands.mjs";
import { collectorArtifactDirs } from "../collectors/artifacts.mjs";
import { captureProcessSnapshot, diffProcessSnapshots } from "../collectors/resources.mjs";
import {
  isAgentMessageCommand,
  measurementScopeForPhase,
  tagCommandResult
} from "../measurement-contract.mjs";
import { assertNetworkFrontageCommandSafe, maybeStartNetworkFrontage } from "../network-frontage.mjs";
import { assertSafeScenarioCommand } from "../safety.mjs";
import { safeSegment } from "./phase-commands.mjs";

export async function runScenarioCommand(command, context, envName, artifactDir, phaseId, commandIndex, authPolicy = null) {
  assertSafeScenarioCommand(command, context, envName);
  if (measurementScopeForPhase({ id: phaseId, commands: [command] }) === "product") {
    assertNetworkFrontageCommandSafe(command, context);
  }
  const agentCommand = isAgentMessageCommand(command);
  const snapshotOptions = {
    envName,
    processRoles: context.processRoles ?? [],
    rootCommand: command
  };
  const snapshotBase = join(collectorArtifactDirs(artifactDir).processSnapshots, `${safeSegment(phaseId)}-${commandIndex + 1}`);
  const beforeSnapshot = agentCommand ? captureProcessSnapshot(snapshotOptions) : null;
  if (beforeSnapshot) {
    await writeJsonArtifact(`${snapshotBase}-before.json`, beforeSnapshot);
  }
  const result = await runCommand(command, {
    timeoutMs: context.timeoutMs,
    env: {
      ...diagnosticsEnv(context, envName, artifactDir),
      ...(authPolicy?.commandEnv ?? {})
    },
    redactValues: authPolicy?.redactionValues ?? context.auth?.redactionValues ?? [],
    resourceSample: context.resourceSampling === false ? null : {
      envName,
      intervalMs: context.resourceSampleIntervalMs,
      processRoles: context.processRoles ?? [],
      artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, `${safeSegment(phaseId)}-${commandIndex + 1}.jsonl`)
    }
  });
  normalizeOptionalCommandResult(result);
  tagCommandResult(result, phaseId);
  if (result.status === 0) {
    try {
      const allocation = await maybeStartNetworkFrontage(context, envName, artifactDir);
      if (allocation?.status === "active") {
        result.networkFrontage = allocation;
      }
    } catch (error) {
      result.status = 1;
      result.harnessBlocker = true;
      result.stderr = `${result.stderr ?? ""}${result.stderr ? "\n" : ""}network frontage blocked: ${error.message}`;
      result.networkFrontage = context.networkFrontageAllocation ?? null;
    }
  }
  attachCommandResultInterpretation(result);
  if (agentCommand) {
    await sleep(1000);
    const afterSnapshot = captureProcessSnapshot(snapshotOptions);
    const processLeaks = diffProcessSnapshots(beforeSnapshot, afterSnapshot, {
      roles: agentLeakRoles()
    });
    await writeJsonArtifact(`${snapshotBase}-after.json`, afterSnapshot);
    await writeJsonArtifact(`${snapshotBase}-leaks.json`, processLeaks);
    result.processSnapshots = {
      schemaVersion: "kova.agentProcessSnapshots.v1",
      beforePath: `${snapshotBase}-before.json`,
      afterPath: `${snapshotBase}-after.json`,
      leaksPath: `${snapshotBase}-leaks.json`,
      before: compactSnapshot(beforeSnapshot),
      after: compactSnapshot(afterSnapshot),
      leaks: processLeaks
    };
  }
  return result;
}

function diagnosticsEnv(context, envName, artifactDir) {
  if (context.openclawDiagnostics === false) {
    return {};
  }
  const artifactDirs = collectorArtifactDirs(artifactDir);

  const env = {
    OPENCLAW_DIAGNOSTICS: "timeline",
    OPENCLAW_DIAGNOSTICS_RUN_ID: context.runId,
    OPENCLAW_DIAGNOSTICS_ENV: envName,
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(artifactDirs.openclaw, "timeline.jsonl"),
    OPENCLAW_DIAGNOSTICS_EVENT_LOOP: "1"
  };

  if (context.nodeProfile === true) {
    const profileDir = artifactDirs.nodeProfiles;
    env.KOVA_NODE_PROFILE_DIR = profileDir;
    env.NODE_OPTIONS = mergeNodeOptions(process.env.NODE_OPTIONS, [
      "--cpu-prof",
      `--cpu-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heap-prof",
      `--heap-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heapsnapshot-signal=SIGUSR2",
      "--report-on-signal",
      "--report-signal=SIGUSR2",
      `--report-directory=${quoteNodeOptionValue(profileDir)}`,
      "--trace-events-enabled",
      "--trace-event-categories=node.perf,node.async_hooks,v8",
      `--trace-event-file-pattern=${quoteNodeOptionValue(join(profileDir, "node-trace-${pid}.json"))}`
    ]);
  }

  return env;
}

function mergeNodeOptions(existing, additions) {
  return [existing, ...additions].filter(Boolean).join(" ");
}

function quoteNodeOptionValue(value) {
  const string = String(value);
  if (!/\s|"/.test(string)) {
    return string;
  }
  return `"${string.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function agentLeakRoles() {
  return ["agent-cli", "agent-process", "mcp-runtime", "plugin-cli", "mock-provider", "browser-sidecar"];
}

function compactSnapshot(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    envName: snapshot.envName,
    gatewayPid: snapshot.gatewayPid,
    processCount: snapshot.processCount,
    roleCounts: snapshot.roleCounts
  };
}

async function writeJsonArtifact(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
