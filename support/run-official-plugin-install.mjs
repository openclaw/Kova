#!/usr/bin/env node

import { runProcess } from "./process.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const startedAtEpochMs = Date.now();

try {
  const args = parseArgs(process.argv.slice(2));
  const envName = required(args, "env");
  const statePath = required(args, "state");
  const state = await readOfficialPluginsState(statePath);
  const plugins = state.officialPlugins;
  const timeoutMs = positiveInteger(args["timeout-ms"] ?? "120000", "--timeout-ms");
  const artifactDir = args["artifact-dir"] ?? "";

  assertSafeKovaEnv(envName);
  for (const plugin of plugins) {
    validatePluginEntry(plugin);
  }

  const pluginResults = [];
  for (const plugin of plugins) {
    pluginResults.push(await installOnePlugin({ envName, plugin, timeoutMs }));
  }

  const failedRequired = pluginResults.filter((result) => result.required !== false && result.ok !== true);
  const securityBlockedResults = pluginResults.filter((result) => result.securityBlocked === true);
  const ok = failedRequired.length === 0;
  const artifactPath = artifactDir ? join(artifactDir, "official-plugins.json") : null;
  const failureEvidence = pluginResults
    .flatMap((result) => result.failureEvidence ?? [])
    .filter(Boolean);
  const summary = {
    schemaVersion: "kova.officialPluginInstall.v1",
    ok,
    envName,
    stateId: state.id,
    statePath,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs,
    pluginCount: pluginResults.length,
    requiredPluginCount: pluginResults.filter((result) => result.required !== false).length,
    failedRequiredCount: failedRequired.length,
    installed: pluginResults.every((result) => result.installed === true),
    listed: pluginResults.every((result) => result.listed === true),
    registryRefreshed: pluginResults.every((result) => result.registryRefreshed === true),
    securityBlocked: securityBlockedResults.length > 0,
    securityBlockCount: securityBlockedResults.length,
    securityEvidence: securityBlockedResults[0]?.securityEvidence ?? null,
    failureEvidence,
    artifactPath,
    pluginResults,
    commands: pluginResults.flatMap((result) => result.commands)
  };

  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(publicSummary(summary), null, 2)}\n`);
  if (!ok) {
    process.stderr.write(failureSummary(summary));
  }
  process.exit(ok ? 0 : 1);
} catch (error) {
  const summary = {
    schemaVersion: "kova.officialPluginInstall.v1",
    ok: false,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs,
    error: error.message,
    commands: []
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

async function readOfficialPluginsState(statePath) {
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.officialPlugins) || parsed.officialPlugins.length === 0) {
    throw new Error(`official plugin state ${statePath} must contain officialPlugins`);
  }
  return parsed;
}

async function installOnePlugin({ envName, plugin, timeoutMs }) {
  const install = await runStep(`install:${plugin.id}`, "ocm", [`@${envName}`, "--", "plugins", "install", plugin.package], { timeoutMs });
  const securityBlocked = hasSecurityBlock(install);
  const list = install.status === 0
    ? await runStep(`list:${plugin.id}`, "ocm", [`@${envName}`, "--", "plugins", "list"], { timeoutMs: 30000 })
    : skippedStep(`list:${plugin.id}`, "install failed");
  const registry = install.status === 0
    ? await runStep(`registry-refresh:${plugin.id}`, "ocm", [`@${envName}`, "--", "plugins", "registry", "--refresh", "--json"], { timeoutMs: 60000 })
    : skippedStep(`registry-refresh:${plugin.id}`, "install failed");

  const listed = list.status === 0 && pluginAppearsInText(list, { pluginPackage: plugin.package, expectedId: plugin.id });
  const registryRefreshed = registry.status === 0;
  const ok = install.status === 0 && !securityBlocked && listed && registryRefreshed;
  const diagnostics = ok
    ? []
    : await collectFailureDiagnostics({ envName, pluginId: plugin.id });
  const failedSteps = [install, list, registry].filter((step) => stepFailed(step, { listed, registryRefreshed, securityBlocked }));
  const failureEvidence = ok
    ? []
    : buildFailureEvidence({ plugin, install, list, registry, diagnostics, listed, registryRefreshed, securityBlocked });
  return {
    id: plugin.id,
    title: plugin.title,
    package: plugin.package,
    required: plugin.required !== false,
    riskArea: plugin.riskArea ?? null,
    ok,
    durationMs: install.durationMs + list.durationMs + registry.durationMs,
    installed: install.status === 0,
    listed,
    registryRefreshed,
    securityBlocked,
    securityEvidence: securityBlocked ? firstSecurityLine(install) : null,
    failedCommand: compactStep(failedSteps[0] ?? install),
    failureEvidence,
    diagnostics: diagnostics.map(compactStep),
    commands: [install, list, registry, ...diagnostics].map(compactStep)
  };
}

async function collectFailureDiagnostics({ envName, pluginId }) {
  return [
    await runStep(`diagnostic-status:${pluginId}`, "ocm", [`@${envName}`, "--", "status"], { timeoutMs: 30000 }),
    await runStep(`diagnostic-list:${pluginId}`, "ocm", [`@${envName}`, "--", "plugins", "list"], { timeoutMs: 30000 }),
    await runStep(`diagnostic-logs:${pluginId}`, "ocm", ["logs", envName, "--tail", "400", "--raw"], { timeoutMs: 30000 })
  ];
}

function buildFailureEvidence({ plugin, install, list, registry, diagnostics, listed, registryRefreshed, securityBlocked }) {
  const failedCommand = firstFailedStep({ install, list, registry, listed, registryRefreshed, securityBlocked });
  return [{
    plugin: plugin.package,
    required: plugin.required !== false,
    command: compactStep(failedCommand),
    install: compactStep(install),
    list: compactStep(list),
    registry: compactStep(registry),
    diagnostics: diagnostics.map(compactStep)
  }];
}

function firstFailedStep({ install, list, registry, listed, registryRefreshed, securityBlocked }) {
  if (install.status !== 0 || install.timedOut || securityBlocked) {
    return install;
  }
  if (list.status !== 0 || list.timedOut || !listed) {
    return list;
  }
  if (registry.status !== 0 || registry.timedOut || !registryRefreshed) {
    return registry;
  }
  return install;
}

function stepFailed(step, { listed, registryRefreshed, securityBlocked }) {
  if (!step || step.skipped === true) {
    return false;
  }
  if (step.status !== 0 || step.timedOut) {
    return true;
  }
  if (step.id?.startsWith("install:") && securityBlocked) {
    return true;
  }
  if (step.id?.startsWith("list:") && !listed) {
    return true;
  }
  if (step.id?.startsWith("registry-refresh:") && !registryRefreshed) {
    return true;
  }
  return false;
}

function parseArgs(argv) {
  const args = {};
  const allowed = new Set(["env", "state", "artifact-dir", "timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function assertSafeKovaEnv(value) {
  if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`refusing to run official plugin install against non-Kova env '${value}'`);
  }
}

function assertOfficialPluginPackage(value) {
  if (!/^@openclaw\/[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`refusing non-official plugin package '${value}'`);
  }
}

function assertExpectedId(value) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`official plugin id must be kebab-case, got '${value}'`);
  }
}

function validatePluginEntry(plugin) {
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
    throw new Error("officialPlugins entries must be objects");
  }
  assertExpectedId(plugin.id);
  assertOfficialPluginPackage(plugin.package);
  if (typeof plugin.title !== "string" || plugin.title.length === 0) {
    throw new Error(`official plugin ${plugin.id} must have a title`);
  }
  if (plugin.required !== undefined && typeof plugin.required !== "boolean") {
    throw new Error(`official plugin ${plugin.id} required must be boolean when set`);
  }
}

async function runStep(id, command, args, options) {
  const startedAtEpochMs = Date.now();
  const result = await runProcess(command, args, options.timeoutMs);
  return {
    id,
    command,
    args,
    ...result,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now()
  };
}

function skippedStep(id, reason) {
  const now = Date.now();
  return {
    id,
    skipped: true,
    reason,
    command: null,
    args: [],
    status: null,
    signal: null,
    timedOut: false,
    startedAtEpochMs: now,
    finishedAtEpochMs: now,
    durationMs: 0,
    stdout: "",
    stderr: ""
  };
}

function hasSecurityBlock(step) {
  const text = `${step.stdout ?? ""}\n${step.stderr ?? ""}`;
  return /dangerous code patterns|credential harvesting|installation blocked|failed the security audit|security audit/i.test(text);
}

function firstSecurityLine(step) {
  const text = `${step.stdout ?? ""}\n${step.stderr ?? ""}`;
  return text.split(/\r?\n/).find((line) =>
    /dangerous code patterns|credential harvesting|installation blocked|failed the security audit|security audit/i.test(line)
  )?.trim() ?? null;
}

function pluginAppearsInText(step, { pluginPackage, expectedId }) {
  const text = `${step.stdout ?? ""}\n${step.stderr ?? ""}`.toLowerCase();
  return text.includes(expectedId.toLowerCase()) || text.includes(pluginPackage.toLowerCase());
}

function compactStep(step) {
  return {
    id: step.id,
    command: step.command ? [step.command, ...step.args].join(" ") : null,
    status: step.status,
    signal: step.signal,
    timedOut: step.timedOut,
    skipped: step.skipped === true,
    reason: step.reason ?? null,
    durationMs: step.durationMs,
    stdoutSnippet: snippet(step.stdout),
    stderrSnippet: snippet(step.stderr)
  };
}

function publicSummary(summary) {
  return {
    schemaVersion: summary.schemaVersion,
    ok: summary.ok,
    envName: summary.envName,
    stateId: summary.stateId,
    statePath: summary.statePath,
    startedAtEpochMs: summary.startedAtEpochMs,
    finishedAtEpochMs: summary.finishedAtEpochMs,
    durationMs: summary.durationMs,
    pluginCount: summary.pluginCount,
    requiredPluginCount: summary.requiredPluginCount,
    failedRequiredCount: summary.failedRequiredCount,
    installed: summary.installed,
    listed: summary.listed,
    registryRefreshed: summary.registryRefreshed,
    securityBlocked: summary.securityBlocked,
    securityBlockCount: summary.securityBlockCount,
    securityEvidence: summary.securityEvidence,
    artifactPath: summary.artifactPath,
    failureEvidence: (summary.failureEvidence ?? []).map(publicFailureEvidence),
    pluginResults: (summary.pluginResults ?? []).map(publicPluginResult),
    commands: (summary.commands ?? []).map(publicStepStatus)
  };
}

function publicPluginResult(result) {
  return {
    id: result.id,
    title: result.title,
    package: result.package,
    required: result.required,
    ok: result.ok,
    durationMs: result.durationMs,
    installed: result.installed,
    listed: result.listed,
    registryRefreshed: result.registryRefreshed,
    securityBlocked: result.securityBlocked,
    securityEvidence: result.securityEvidence,
    failedCommand: result.failedCommand ? publicStep(result.failedCommand) : null
  };
}

function publicFailureEvidence(evidence) {
  return {
    plugin: evidence.plugin,
    required: evidence.required,
    command: evidence.command ? publicStep(evidence.command) : null,
    install: evidence.install ? publicStep(evidence.install) : null,
    list: evidence.list ? publicStep(evidence.list) : null,
    registry: evidence.registry ? publicStep(evidence.registry) : null,
    diagnostics: (evidence.diagnostics ?? []).map((step) => publicStep(step, 300))
  };
}

function publicStep(step, snippetMax = 700) {
  return {
    id: step.id,
    command: step.command,
    status: step.status,
    signal: step.signal,
    timedOut: step.timedOut,
    skipped: step.skipped,
    reason: step.reason,
    durationMs: step.durationMs,
    stdoutSnippet: snippet(step.stdoutSnippet, snippetMax),
    stderrSnippet: snippet(step.stderrSnippet, snippetMax)
  };
}

function publicStepStatus(step) {
  return {
    id: step.id,
    command: step.command,
    status: step.status,
    signal: step.signal,
    timedOut: step.timedOut,
    skipped: step.skipped,
    reason: step.reason,
    durationMs: step.durationMs
  };
}

function snippet(value, maxLength = 1200) {
  const text = String(value ?? "").trim();
  return snippetLength(text, maxLength);
}

function snippetLength(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

function failureSummary(summary) {
  const failed = summary.pluginResults?.find((result) => result.required !== false && result.ok !== true);
  if (!failed) {
    return "official plugin install validation failed\n";
  }
  if (failed.securityBlocked) {
    return `official plugin ${failed.package} blocked by security scanner: ${failed.securityEvidence ?? failed.package}\n`;
  }
  if (!failed.installed) {
    return `official plugin install command failed for ${failed.package}\n`;
  }
  if (!failed.listed) {
    return `official plugin ${failed.id} did not appear in plugins list after install\n`;
  }
  if (!failed.registryRefreshed) {
    return `official plugin registry refresh failed after installing ${failed.package}\n`;
  }
  return `official plugin install validation failed for ${failed.package}\n`;
}
