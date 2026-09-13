import { collectPhaseResultEntries, isDoctorFixCommand } from "./records.mjs";
import { firstLine, firstNonEmptyLine, maxNullable, sumNumbers } from "./shared.mjs";

export function collectSoakEvidence(results) {
  const loops = results
    .filter((result) => result.command?.includes("run-soak-loop.mjs"))
    .map((result) => parseSoakLoopOutput(result))
    .filter(Boolean);

  if (loops.length === 0) {
    return {
      schemaVersion: "kova.soakEvidence.v1",
      available: false,
      durationMs: null,
      iterations: null,
      commandP95Ms: null,
      commandMaxMs: null,
      commandFailures: null,
      healthP95Ms: null,
      healthMaxMs: null,
      healthFailures: null,
      loops: []
    };
  }

  return {
    schemaVersion: "kova.soakEvidence.v1",
    available: true,
    durationMs: maxNullable(...loops.map((loop) => loop.durationMs)),
    iterations: maxNullable(...loops.map((loop) => loop.iterations)),
    commandP95Ms: maxNullable(...loops.map((loop) => loop.commandSummary?.p95Ms)),
    commandMaxMs: maxNullable(...loops.map((loop) => loop.commandSummary?.maxMs)),
    commandFailures: loops.reduce((total, loop) => total + (loop.commandSummary?.failureCount ?? 0), 0),
    healthP95Ms: maxNullable(...loops.map((loop) => loop.healthSummary?.p95Ms)),
    healthMaxMs: maxNullable(...loops.map((loop) => loop.healthSummary?.maxMs)),
    healthFailures: loops.reduce((total, loop) => total + (loop.healthSummary?.failureCount ?? 0), 0),
    loops: loops.map((loop) => ({
      durationMs: loop.durationMs ?? null,
      iterations: loop.iterations ?? null,
      commandSummary: loop.commandSummary ?? null,
      healthSummary: loop.healthSummary ?? null
    }))
  };
}

function parseSoakLoopOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.soakLoop.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function collectMcpBridgeEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("mcp-bridge-smoke.mjs"))
    .map((result) => parseMcpBridgeSmokeOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.mcpBridgeEvidence.v1",
      available: false,
      initializeMs: null,
      toolsListMs: null,
      shutdownMs: null,
      toolCount: null,
      toolNames: [],
      processExited: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.mcpBridgeEvidence.v1",
    available: true,
    initializeMs: maxNullable(...smokes.map((smoke) => smoke.initializeMs)),
    toolsListMs: maxNullable(...smokes.map((smoke) => smoke.toolsListMs)),
    shutdownMs: maxNullable(...smokes.map((smoke) => smoke.shutdownMs)),
    toolCount: maxNullable(...smokes.map((smoke) => smoke.toolCount)),
    toolNames: [...new Set(smokes.flatMap((smoke) => smoke.toolNames ?? []))].sort(),
    processExited: smokes.every((smoke) => smoke.processExited === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      initializeMs: smoke.initializeMs ?? null,
      toolsListMs: smoke.toolsListMs ?? null,
      shutdownMs: smoke.shutdownMs ?? null,
      toolCount: smoke.toolCount ?? null,
      processExited: smoke.processExited ?? null,
      exitStatus: smoke.exitStatus ?? null,
      exitSignal: smoke.exitSignal ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseMcpBridgeSmokeOutput(result) {
  return parseSchemaOutput(result, "kova.mcpBridgeSmoke.v1");
}

export function collectCronRuntimeEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("run-cron-runtime-smoke.mjs"))
    .map((result) => parseSchemaOutput(result, "kova.cronRuntimeSmoke.v1"))
    .filter(Boolean);
  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.cronRuntimeEvidence.v1",
      available: false,
      cronStatusMs: null,
      cronRegisterMs: null,
      cronRunMs: null,
      cronRunsMs: null,
      cronRunCompleted: null,
      cronTriggerAttributed: null,
      errors: [],
      smokes: []
    };
  }
  return {
    schemaVersion: "kova.cronRuntimeEvidence.v1",
    available: true,
    cronStatusMs: maxNullable(...smokes.map((smoke) => smoke.cronStatusMs)),
    cronRegisterMs: maxNullable(...smokes.map((smoke) => smoke.cronRegisterMs)),
    cronRunMs: maxNullable(...smokes.map((smoke) => smoke.cronRunMs)),
    cronRunsMs: maxNullable(...smokes.map((smoke) => smoke.cronRunsMs)),
    cronRunCompleted: smokes.every((smoke) => smoke.cronRunCompleted === true),
    cronTriggerAttributed: smokes.every((smoke) => smoke.cronTriggerAttributed === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      cronStatusMs: smoke.cronStatusMs ?? null,
      cronRegisterMs: smoke.cronRegisterMs ?? null,
      cronRunMs: smoke.cronRunMs ?? null,
      cronRunsMs: smoke.cronRunsMs ?? null,
      cronRunCompleted: smoke.cronRunCompleted ?? null,
      cronTriggerAttributed: smoke.cronTriggerAttributed ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

export function collectExecToolEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("run-exec-tool-safety.mjs"))
    .map((result) => parseSchemaOutput(result, "kova.execToolSafety.v1"))
    .filter(Boolean);
  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.execToolEvidence.v1",
      available: false,
      safeCommandMs: null,
      safeCommandSucceeded: null,
      dangerousCommandBlocked: null,
      dangerousPayloadExecuted: null,
      outputTruncated: null,
      timeoutMs: null,
      processLeaks: null,
      errors: [],
      smokes: []
    };
  }
  return {
    schemaVersion: "kova.execToolEvidence.v1",
    available: true,
    safeCommandMs: maxNullable(...smokes.map((smoke) => smoke.safeCommandMs)),
    safeCommandSucceeded: nullableEvery(smokes.map((smoke) => smoke.safeCommandSucceeded)),
    dangerousCommandBlocked: nullableEvery(smokes.map((smoke) => smoke.dangerousCommandBlocked)),
    dangerousPayloadExecuted: smokes.some((smoke) => smoke.dangerousPayloadExecuted === true),
    outputTruncated: nullableEvery(smokes.map((smoke) => smoke.outputTruncated)),
    timeoutMs: maxNullable(...smokes.map((smoke) => smoke.timeoutMs)),
    processLeaks: maxNullable(...smokes.map((smoke) => smoke.processLeaks)),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      safeCommandMs: smoke.safeCommandMs ?? null,
      safeCommandSucceeded: smoke.safeCommandSucceeded ?? null,
      safeCommandBoundary: smoke.safeCommandBoundary ?? null,
      dangerousCommandBlocked: smoke.dangerousCommandBlocked ?? null,
      dangerousCommandBoundary: smoke.dangerousCommandBoundary ?? null,
      dangerousPayloadExecuted: smoke.dangerousPayloadExecuted ?? null,
      outputTruncated: smoke.outputTruncated ?? null,
      timeoutMs: smoke.timeoutMs ?? null,
      processLeaks: smoke.processLeaks ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

export function collectMcpToolCallEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("mcp-tool-call-smoke.mjs"))
    .map((result) => parseSchemaOutput(result, "kova.mcpToolCallSmoke.v1"))
    .filter(Boolean);
  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.mcpToolCallEvidence.v1",
      available: false,
      initializeMs: null,
      toolsListMs: null,
      toolsCallMs: null,
      invalidToolsCallMs: null,
      shutdownMs: null,
      toolCount: null,
      toolNames: [],
      safeToolSucceeded: null,
      safeToolName: null,
      invalidToolErrorAttributed: null,
      processExited: null,
      errors: [],
      smokes: []
    };
  }
  return {
    schemaVersion: "kova.mcpToolCallEvidence.v1",
    available: true,
    initializeMs: maxNullable(...smokes.map((smoke) => smoke.initializeMs)),
    toolsListMs: maxNullable(...smokes.map((smoke) => smoke.toolsListMs)),
    toolsCallMs: maxNullable(...smokes.map((smoke) => smoke.toolsCallMs)),
    invalidToolsCallMs: maxNullable(...smokes.map((smoke) => smoke.invalidToolsCallMs)),
    shutdownMs: maxNullable(...smokes.map((smoke) => smoke.shutdownMs)),
    toolCount: maxNullable(...smokes.map((smoke) => smoke.toolCount)),
    toolNames: [...new Set(smokes.flatMap((smoke) => smoke.toolNames ?? []))].sort(),
    safeToolSucceeded: smokes.every((smoke) => smoke.safeToolSucceeded === true),
    safeToolName: smokes.find((smoke) => typeof smoke.safeToolName === "string")?.safeToolName ?? null,
    invalidToolErrorAttributed: smokes.every((smoke) => smoke.invalidToolErrorAttributed === true),
    processExited: smokes.every((smoke) => smoke.processExited === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      initializeMs: smoke.initializeMs ?? null,
      toolsListMs: smoke.toolsListMs ?? null,
      toolsCallMs: smoke.toolsCallMs ?? null,
      invalidToolsCallMs: smoke.invalidToolsCallMs ?? null,
      shutdownMs: smoke.shutdownMs ?? null,
      toolCount: smoke.toolCount ?? null,
      toolNames: smoke.toolNames ?? [],
      safeToolName: smoke.safeToolName ?? null,
      safeToolSucceeded: smoke.safeToolSucceeded ?? null,
      invalidToolErrorAttributed: smoke.invalidToolErrorAttributed ?? null,
      processExited: smoke.processExited ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

export function combineMcpLifecycleEvidence(mcpBridgeEvidence, mcpToolCallEvidence) {
  const sources = [mcpBridgeEvidence, mcpToolCallEvidence].filter((evidence) => evidence.available);
  if (sources.length === 0) {
    return {
      schemaVersion: "kova.mcpLifecycleEvidence.v1",
      available: false,
      initializeMs: null,
      toolsListMs: null,
      shutdownMs: null,
      toolCount: null,
      toolNames: [],
      processExited: null,
      processLeaks: null
    };
  }
  const processExited = sources.every((evidence) => evidence.processExited === true);
  return {
    schemaVersion: "kova.mcpLifecycleEvidence.v1",
    available: true,
    initializeMs: maxNullable(...sources.map((evidence) => evidence.initializeMs)),
    toolsListMs: maxNullable(...sources.map((evidence) => evidence.toolsListMs)),
    shutdownMs: maxNullable(...sources.map((evidence) => evidence.shutdownMs)),
    toolCount: maxNullable(...sources.map((evidence) => evidence.toolCount)),
    toolNames: [...new Set(sources.flatMap((evidence) => evidence.toolNames ?? []))].sort(),
    processExited,
    processLeaks: processExited ? 0 : 1
  };
}

export function collectDirtyPluginEvidence(record) {
  const entries = collectPhaseResultEntries(record);
  const summaries = entries
    .filter(({ result }) => result.command?.includes("dirty-plugin-state.mjs"))
    .map(({ phase, result }) => ({ phase, result, parsed: parseSchemaOutput(result, "kova.dirtyPluginState.v1") }))
    .filter((entry) => entry.parsed);
  const verifierSummaries = summaries.filter(({ result }) => result.command?.includes(" verify "));
  const pluginCommands = entries.filter(({ phase, result }) =>
    (phase.id === "plugin-inspect" || phase.id === "restart") &&
    / -- plugins (?:list|update\b)/.test(result.command ?? "")
  );
  const pluginCommandText = pluginCommands.map(({ result }) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`).join("\n");
  const pluginCommandStatuses = pluginCommands.map(({ result }) => result.status);
  const verifierFailures = verifierSummaries.flatMap(({ parsed }) => parsed.failures ?? []);
  const failedVerifierCommands = summaries
    .filter(({ result }) => result.status !== 0)
    .map(({ result }) => firstLine(result.stderr) || firstLine(result.stdout) || `dirty plugin verifier exited ${result.status}`);
  const dirtyRecords = summaries.flatMap(({ parsed }) => parsed.pluginRecords ?? [])
    .filter((plugin) => String(plugin.id ?? "").startsWith("kova-dirty-"));
  const checksumVerdicts = verifierSummaries
    .map(({ parsed }) => typeof parsed.ok === "boolean" ? parsed.ok : null)
    .filter((value) => value !== null);

  return {
    schemaVersion: "kova.dirtyPluginEvidence.v1",
    available: summaries.length > 0 || pluginCommands.length > 0,
    dirtyPluginDetected: dirtyRecords.length > 0 ? dirtyRecords.some((plugin) => plugin.dirty === true || plugin.partial === true || plugin.broken === true || plugin.symlink === true || plugin.staleDeps === true || plugin.manifestDrift === true) : null,
    dirtyPluginReported: pluginCommandText.length > 0 ? /kova-dirty-|dirty plugin|dirty/i.test(pluginCommandText) : null,
    dirtyPluginChecksumPreserved: checksumVerdicts.length > 0 ? checksumVerdicts.every(Boolean) : null,
    doctorDestructiveChangeCount: verifierSummaries.length > 0 ? verifierFailures.length : null,
    pluginsUsableWithDirtyState: pluginCommandStatuses.length > 0 ? pluginCommandStatuses.every((status) => status === 0) : null,
    gatewaySurvivedDirtyPlugin: dirtyGatewaySurvived(record, entries),
    errors: [...verifierFailures, ...failedVerifierCommands],
    summaries: summaries.map(({ phase, result, parsed }) => ({
      phaseId: phase.id,
      command: result.command,
      status: result.status,
      state: parsed.state ?? null,
      ok: parsed.ok ?? null,
      aggregateMarkerMissing: parsed.aggregateMarkerMissing ?? null,
      pluginRecordCount: Array.isArray(parsed.pluginRecords) ? parsed.pluginRecords.length : 0,
      failures: parsed.failures ?? []
    }))
  };
}

export function collectReleaseRecoveryEvidence(record) {
  const entries = collectPhaseResultEntries(record);
  const upgradeVersion = extractPhaseVersion(entries, "upgrade");
  const retryVersion = extractPhaseVersion(entries, "update-retry");
  const rollbackResult = entries.find(({ phase, result }) =>
    phase.id === "rollback" && result.command?.includes("restore-first-ocm-upgrade-snapshot.mjs")
  )?.result ?? null;
  const rollbackParsed = rollbackResult ? parseSchemaOutput(rollbackResult, "kova.ocmUpgradeSnapshotRestore.v1") : null;
  const doctorResults = entries.filter(({ phase, result }) =>
    phase.id === "doctor-repair" && isDoctorFixCommand(result.command)
  );
  const doctorSummaries = doctorResults
    .map(({ result }) => parseSchemaOutput(result, "kova.doctorRepair.v1"))
    .filter(Boolean);
  const postUpgradePluginCommands = entries.filter(({ phase, result }) =>
    phase.id === "plugin-health" && / -- plugins (?:list|update\b)/.test(result.command ?? "")
  );
  const postRollbackPluginCommands = entries.filter(({ phase, result }) =>
    phase.id === "rollback" && / -- plugins list\b/.test(result.command ?? "")
  );
  const rollbackVerifier = entries
    .filter(({ phase, result }) => phase.id === "state-rollback" && result.command?.includes("dirty-plugin-state.mjs") && result.command.includes(" verify "))
    .map(({ result }) => parseSchemaOutput(result, "kova.dirtyPluginState.v1"))
    .filter(Boolean);
  const rollbackFailures = rollbackVerifier.flatMap((parsed) => parsed.failures ?? []);
  const restoreFailure = rollbackResult && rollbackResult.status !== 0
    ? firstLine(rollbackResult.stderr) || firstLine(rollbackResult.stdout) || `rollback restore exited ${rollbackResult.status}`
    : null;
  const doctorEvidenceMissing = doctorResults.length > 0 && doctorSummaries.length === 0
    ? "doctor repair command did not emit kova.doctorRepair.v1 evidence"
    : null;
  const doctorFailures = doctorSummaries.flatMap((parsed) => parsed.errors ?? []);

  return {
    schemaVersion: "kova.releaseRecoveryEvidence.v1",
    available: Boolean(upgradeVersion || retryVersion || rollbackResult || doctorResults.length || doctorSummaries.length || postUpgradePluginCommands.length || postRollbackPluginCommands.length || rollbackVerifier.length),
    doctorFixSucceeded: doctorSummaries.length > 0 ? doctorSummaries.every((parsed) => parsed.doctorFixSucceeded === true) : null,
    doctorUnrepairedFindingCount: doctorSummaries.length > 0 ? sumNumbers(doctorSummaries.map((parsed) => parsed.doctorUnrepairedFindingCount)) : null,
    updateRetryVersionDrift: upgradeVersion && retryVersion ? (upgradeVersion === retryVersion ? 0 : 1) : null,
    upgradeVersion,
    retryVersion,
    rollbackAvailable: rollbackResult ? rollbackResult.status === 0 && Boolean(rollbackParsed?.snapshotId) : null,
    rollbackSucceeded: rollbackResult ? rollbackResult.status === 0 && Boolean(rollbackParsed?.restored) : null,
    pluginsUsableAfterUpgrade: postUpgradePluginCommands.length > 0 ? postUpgradePluginCommands.every(({ result }) => result.status === 0) : null,
    pluginsUsableAfterRollback: postRollbackPluginCommands.length > 0 ? postRollbackPluginCommands.every(({ result }) => result.status === 0) : null,
    rollbackPreservedPluginData: rollbackVerifier.length > 0 ? rollbackVerifier.every((parsed) => parsed.ok === true) : null,
    errors: [restoreFailure, doctorEvidenceMissing, ...doctorFailures, ...rollbackFailures].filter(Boolean),
    doctor: doctorSummaries.map((parsed) => ({
      status: parsed.status ?? null,
      doctorFixSucceeded: parsed.doctorFixSucceeded ?? null,
      doctorUnrepairedFindingCount: parsed.doctorUnrepairedFindingCount ?? null
    })),
    rollback: rollbackResult ? {
      status: rollbackResult.status,
      snapshotId: rollbackParsed?.snapshotId ?? null,
      selectedBy: rollbackParsed?.selectedBy ?? null
    } : null
  };
}

function parseSchemaOutput(result, schemaVersion) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === schemaVersion ? parsed : null;
  } catch {
    return null;
  }
}

function nullableEvery(values) {
  const concrete = values.filter((value) => value !== null && value !== undefined);
  return concrete.length === 0 ? null : concrete.every((value) => value === true);
}

function dirtyGatewaySurvived(record, entries) {
  if (record.finalMetrics?.service?.gatewayState === "running") {
    return true;
  }
  const statusResults = entries.filter(({ phase, result }) =>
    (phase.id === "doctor" || phase.id === "restart") &&
    (/ -- status\b/.test(result.command ?? "") || /service status/.test(result.command ?? ""))
  );
  return statusResults.length > 0 ? statusResults.every(({ result }) => result.status === 0) : null;
}

function extractPhaseVersion(entries, phaseId) {
  const result = entries.find(({ phase, result }) => phase.id === phaseId && / -- --version\b/.test(result.command ?? ""))?.result;
  if (!result) {
    return null;
  }
  return extractOpenClawVersion(result.stdout) ?? extractOpenClawVersion(result.stderr);
}

function extractOpenClawVersion(text = "") {
  const match = String(text).match(/\b(\d{4}\.\d+\.\d+(?:[-+._a-z0-9]+)?)\b/i);
  return match?.[1] ?? null;
}

export function collectBrowserAutomationEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("browser-automation-smoke.mjs"))
    .map((result) => parseBrowserAutomationSmokeOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.browserAutomationEvidence.v1",
      available: false,
      browserDoctorMs: null,
      browserStartMs: null,
      browserTabsMs: null,
      browserOpenMs: null,
      browserSnapshotMs: null,
      browserStopMs: null,
      browserTabCount: null,
      browserSnapshotOk: null,
      browserStopped: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.browserAutomationEvidence.v1",
    available: true,
    browserDoctorMs: maxNullable(...smokes.map((smoke) => smoke.browserDoctorMs)),
    browserStartMs: maxNullable(...smokes.map((smoke) => smoke.browserStartMs)),
    browserTabsMs: maxNullable(...smokes.map((smoke) => smoke.browserTabsMs)),
    browserOpenMs: maxNullable(...smokes.map((smoke) => smoke.browserOpenMs)),
    browserSnapshotMs: maxNullable(...smokes.map((smoke) => smoke.browserSnapshotMs)),
    browserStopMs: maxNullable(...smokes.map((smoke) => smoke.browserStopMs)),
    browserTabCount: maxNullable(...smokes.map((smoke) => smoke.browserTabCount)),
    browserSnapshotOk: smokes.every((smoke) => smoke.browserSnapshotOk === true),
    browserStopped: smokes.every((smoke) => smoke.browserStopped === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      browserDoctorMs: smoke.browserDoctorMs ?? null,
      browserStartMs: smoke.browserStartMs ?? null,
      browserTabsMs: smoke.browserTabsMs ?? null,
      browserOpenMs: smoke.browserOpenMs ?? null,
      browserSnapshotMs: smoke.browserSnapshotMs ?? null,
      browserStopMs: smoke.browserStopMs ?? null,
      browserTabCount: smoke.browserTabCount ?? null,
      browserSnapshotOk: smoke.browserSnapshotOk ?? null,
      browserStopped: smoke.browserStopped ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseBrowserAutomationSmokeOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.browserAutomationSmoke.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function collectMediaUnderstandingEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("media-understanding-timeout.mjs"))
    .map((result) => parseMediaUnderstandingTimeoutOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.mediaUnderstandingEvidence.v1",
      available: false,
      mediaDescribeMs: null,
      mediaTimeoutObserved: null,
      mediaCommandTimedOut: null,
      mediaStatusAfterTimeoutMs: null,
      gatewayStatusWorks: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.mediaUnderstandingEvidence.v1",
    available: true,
    mediaDescribeMs: maxNullable(...smokes.map((smoke) => smoke.mediaDescribeMs)),
    mediaTimeoutObserved: smokes.every((smoke) => smoke.mediaTimeoutObserved === true),
    mediaCommandTimedOut: smokes.some((smoke) => smoke.mediaCommandTimedOut === true),
    mediaStatusAfterTimeoutMs: maxNullable(...smokes.map((smoke) => smoke.mediaStatusAfterTimeoutMs)),
    gatewayStatusWorks: smokes.every((smoke) => smoke.gatewayStatusWorks === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      mediaDescribeMs: smoke.mediaDescribeMs ?? null,
      mediaTimeoutObserved: smoke.mediaTimeoutObserved ?? null,
      mediaCommandTimedOut: smoke.mediaCommandTimedOut ?? null,
      mediaCommandStatus: smoke.mediaCommandStatus ?? null,
      mediaStatusAfterTimeoutMs: smoke.mediaStatusAfterTimeoutMs ?? null,
      gatewayStatusWorks: smoke.gatewayStatusWorks ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseMediaUnderstandingTimeoutOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.mediaUnderstandingTimeout.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function collectNetworkOfflineEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("agent-network-offline.mjs"))
    .map((result) => parseNetworkOfflineOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.networkOfflineEvidence.v1",
      available: false,
      networkTurnMs: null,
      networkFailureObserved: null,
      networkCommandTimedOut: null,
      networkStatusAfterFailureMs: null,
      gatewayStatusWorks: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.networkOfflineEvidence.v1",
    available: true,
    networkTurnMs: maxNullable(...smokes.map((smoke) => smoke.networkTurnMs)),
    networkFailureObserved: smokes.every((smoke) => smoke.networkFailureObserved === true),
    networkCommandTimedOut: smokes.some((smoke) => smoke.networkCommandTimedOut === true),
    networkStatusAfterFailureMs: maxNullable(...smokes.map((smoke) => smoke.networkStatusAfterFailureMs)),
    gatewayStatusWorks: smokes.every((smoke) => smoke.gatewayStatusWorks === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      networkTurnMs: smoke.networkTurnMs ?? null,
      networkFailureObserved: smoke.networkFailureObserved ?? null,
      networkCommandTimedOut: smoke.networkCommandTimedOut ?? null,
      networkCommandStatus: smoke.networkCommandStatus ?? null,
      networkStatusAfterFailureMs: smoke.networkStatusAfterFailureMs ?? null,
      gatewayStatusWorks: smoke.gatewayStatusWorks ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseNetworkOfflineOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.agentNetworkOffline.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function collectOfficialPluginEvidence(results) {
  const runs = results
    .filter((result) => result.command?.includes("run-official-plugin-install.mjs"))
    .map((result) => parseOfficialPluginInstallOutput(result))
    .filter(Boolean);

  if (runs.length === 0) {
    return {
      schemaVersion: "kova.officialPluginEvidence.v1",
      available: false,
      ok: null,
      pluginCount: 0,
      requiredPluginCount: 0,
      failedRequiredCount: 0,
      durationMs: null,
      installed: null,
      listed: null,
      registryRefreshed: null,
      securityBlockCount: null,
      securityEvidence: null,
      failureEvidence: [],
      artifactPath: null,
      runs: []
    };
  }

  const securityBlockCounts = runs.map((run) => run.securityBlockCount);
  const securityBlockCount = securityBlockCounts.every((count) => Number.isInteger(count) && count >= 0)
    ? securityBlockCounts.reduce((total, count) => total + count, 0)
    : null;

  return {
    schemaVersion: "kova.officialPluginEvidence.v1",
    available: true,
    ok: runs.every((run) => run.ok === true),
    pluginCount: maxNullable(...runs.map((run) => run.pluginCount)),
    requiredPluginCount: maxNullable(...runs.map((run) => run.requiredPluginCount)),
    failedRequiredCount: runs.reduce((total, run) => total + (run.failedRequiredCount ?? 0), 0),
    durationMs: maxNullable(...runs.map((run) => run.durationMs)),
    installed: runs.every((run) => run.installed === true),
    listed: runs.every((run) => run.listed === true),
    registryRefreshed: runs.every((run) => run.registryRefreshed === true),
    securityBlockCount,
    securityEvidence: runs.find((run) => run.securityBlocked === true)?.securityEvidence ?? null,
    failureEvidence: runs.flatMap((run) => run.failureEvidence ?? []),
    artifactPath: runs.find((run) => typeof run.artifactPath === "string" && run.artifactPath.length > 0)?.artifactPath ?? null,
    runs: runs.map((run) => ({
      ok: run.ok === true,
      pluginCount: run.pluginCount ?? null,
      requiredPluginCount: run.requiredPluginCount ?? null,
      failedRequiredCount: run.failedRequiredCount ?? null,
      durationMs: run.durationMs ?? null,
      installed: run.installed === true,
      listed: run.listed === true,
      registryRefreshed: run.registryRefreshed === true,
      securityBlocked: run.securityBlocked === true,
      securityBlockCount: run.securityBlockCount ?? null,
      securityEvidence: run.securityEvidence ?? null,
      failureEvidence: run.failureEvidence ?? [],
      artifactPath: run.artifactPath ?? null,
      pluginResults: run.pluginResults ?? [],
      commands: run.commands ?? []
    }))
  };
}

function parseOfficialPluginInstallOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.officialPluginInstall.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function officialPluginInstallFailureMessage(evidence) {
  const failure = firstOfficialPluginFailure(evidence);
  if (failure) {
    return failure;
  }
  if (evidence.securityBlockCount > 0) {
    return `official plugin install was blocked by the OpenClaw security scanner: ${evidence.securityEvidence ?? "unknown plugin"}`;
  }
  if (evidence.installed === false) {
    return "one or more official plugin install commands failed";
  }
  if (evidence.listed === false) {
    return "one or more official plugins did not appear in plugins list after install";
  }
  if (evidence.registryRefreshed === false) {
    return "official plugin registry refresh failed after installing one or more official plugins";
  }
  return "official plugin install validation failed";
}

function firstOfficialPluginFailure(evidence) {
  const failure = evidence.failureEvidence?.[0];
  const command = failure?.command;
  if (!failure || !command) {
    return null;
  }
  const plugin = failure.plugin ? `${failure.plugin} ` : "";
  const timedOut = command.timedOut ? " timed out" : "";
  const status = command.status !== null && command.status !== undefined ? ` exited ${command.status}` : " failed";
  const response = firstNonEmptyLine(command.stderrSnippet, command.stdoutSnippet);
  return `${plugin}official plugin command${timedOut || status}: ${command.command ?? command.id}${response ? `; ${response}` : ""}`;
}
