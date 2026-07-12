import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import JSON5 from "json5";
import { quoteShell, runCommand } from "../commands.mjs";
import { positiveIntegerFlag } from "../run/options.mjs";
import { resolveFromCwd } from "../cli.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { discoverOpenClawChannelCapabilityCatalogSource } from "./channel-capability-source.mjs";

const inventorySchemaVersion = "kova.inventory.plan.v1";
const manifestSearchDirs = ["apps", "extensions", "packages", "plugins", "src"];
const manifestCandidateLimit = 300;
const manifestCandidateCollectionLimit = manifestCandidateLimit + 1;
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp"
]);

const commandSurfaceMap = new Map([
  ["acp", ["agent-cli-local-turn", "agent-gateway-rpc-turn"]],
  ["agent", ["agent-cli-local-turn", "agent-gateway-rpc-turn"]],
  ["agents", ["agent-cli-local-turn", "agent-gateway-rpc-turn", "workspace-scan"]],
  ["browser", ["browser-automation"]],
  ["capability", ["openai-compatible-turn", "provider-models"]],
  ["chat", ["gateway-session-send-turn", "tui", "tui-message-turn"]],
  ["configure", ["fresh-install", "provider-models"]],
  ["daemon", ["release-runtime-startup", "gateway-performance"]],
  ["dashboard", ["dashboard", "gateway-session-send-turn"]],
  ["doctor", ["failure-containment", "release-runtime-startup"]],
  ["gateway", ["release-runtime-startup", "gateway-performance", "gateway-session-send-turn"]],
  ["health", ["release-runtime-startup", "gateway-performance"]],
  ["infer", ["openai-compatible-turn", "provider-models"]],
  ["logs", ["release-runtime-startup", "gateway-performance"]],
  ["mcp", ["mcp-runtime"]],
  ["media", ["media-understanding"]],
  ["model", ["provider-models"]],
  ["models", ["provider-models"]],
  ["node", ["release-runtime-startup", "gateway-performance"]],
  ["nodes", ["release-runtime-startup", "gateway-performance"]],
  ["onboard", ["fresh-install", "provider-models"]],
  ["plugin", ["plugin-lifecycle"]],
  ["plugins", ["plugin-lifecycle", "official-plugin-install"]],
  ["provider", ["provider-models"]],
  ["providers", ["provider-models"]],
  ["setup", ["fresh-install", "release-runtime-startup"]],
  ["start", ["release-runtime-startup", "gateway-performance"]],
  ["status", ["release-runtime-startup"]],
  ["stop", ["release-runtime-startup"]],
  ["terminal", ["tui", "tui-message-turn"]],
  ["tui", ["tui", "tui-message-turn"]],
  ["uninstall", ["fresh-install", "failure-containment"]],
  ["update", ["upgrade-existing-user"]],
  ["upgrade", ["upgrade-existing-user"]],
  ["workspace", ["workspace-scan"]]
]);
const packageScriptScopes = new Set(["product", "all", "none"]);
const productScriptNames = new Set([
  "gateway:dev",
  "gateway:dev:reset",
  "gateway:watch",
  "gateway:watch:raw",
  "openclaw",
  "openclaw:rpc",
  "plugin-sdk:api:check",
  "plugin-sdk:check-exports",
  "plugins:inventory:check",
  "plugins:inventory:gen",
  "plugins:sync",
  "plugins:sync:check",
  "release-metadata:check",
  "release:check",
  "release:openclaw:npm:check",
  "release:openclaw:npm:verify-published",
  "start",
  "test:docker:live-gateway",
  "test:docker:live-models",
  "test:docker:npm-onboard-channel-agent",
  "test:docker:plugin-update",
  "test:docker:plugins",
  "test:docker:published-upgrade-survivor",
  "test:docker:update-migration",
  "test:docker:upgrade-survivor",
  "test:gateway",
  "test:install:e2e",
  "test:install:smoke",
  "test:live:gateway-profiles",
  "test:live:media",
  "test:live:models-profiles",
  "test:perf:budget",
  "test:perf:groups",
  "test:plugins:gateway-gauntlet",
  "test:stability:gateway",
  "test:startup:bench",
  "test:startup:bench:check",
  "test:startup:bench:smoke",
  "test:startup:gateway",
  "test:startup:memory",
  "tui",
  "tui:dev",
  "ui:build",
  "ui:dev",
  "ui:install"
]);
const productScriptPrefixes = [
  "release:plugins:",
  "test:docker:live-acp-bind:",
  "test:docker:live-cli-backend:",
  "test:docker:live-gateway:",
  "test:docker:live-models:",
  "test:live:media:"
];

export async function buildOpenClawInventoryPlan(flags = {}) {
  const registry = await loadRegistryContext();
  const timeoutMs = positiveIntegerFlag(flags, "timeout_ms", 10000);
  const maxSubcommands = positiveIntegerFlag(flags, "max_subcommands", 40);
  const openclawBin = normalizeOptionalCommand(flags.openclaw_bin);
  const repoPath = normalizeOptionalPath(flags.openclaw_repo);
  const scriptScope = normalizeScriptScope(flags.script_scope);
  const requestedSubcommands = parseList(flags.subcommands);
  const requiredModeled = parseList(flags.require_modeled);
  const sources = [];
  const capabilities = [];

  const helpInventory = await discoverCliHelp({
    openclawBin,
    requestedSubcommands,
    maxSubcommands,
    timeoutMs
  });
  sources.push(helpInventory.source);
  capabilities.push(...helpInventory.capabilities);

  const repoInventory = await discoverRepoInventory({ repoPath, scriptScope });
  sources.push(...repoInventory.sources);
  capabilities.push(...repoInventory.capabilities);

  const openClawChannelCatalog = registry.channelCapabilityCatalog.find((catalog) => catalog.id === "openclaw-message");
  const channelCatalogInventory = await discoverOpenClawChannelCapabilityCatalogSource({
    repoPath,
    catalog: openClawChannelCatalog
  });
  sources.push(channelCatalogInventory.source);

  const modeledSurfaces = registry.surfaces.map((surface) => ({
    id: surface.id,
    title: surface.title,
    ownerArea: surface.ownerArea,
    purposes: surface.purposes ?? []
  }));
  const classifiedCapabilities = capabilities.map((capability) =>
    classifyCapability(capability, registry.surfaces)
  );

  return {
    schemaVersion: inventorySchemaVersion,
    generatedAt: new Date().toISOString(),
    openclaw: {
      bin: openclawBin,
      repoPath,
      scriptScope
    },
    sources,
    modeledSurfaces,
    capabilities: classifiedCapabilities,
    channelCapabilityCatalog: channelCatalogInventory.result,
    coverage: summarizeCoverage(classifiedCapabilities, modeledSurfaces, {
      requiredModeled
    })
  };
}

async function discoverCliHelp({ openclawBin, requestedSubcommands, maxSubcommands, timeoutMs }) {
  if (!openclawBin) {
    return {
      source: {
        id: "openclaw-help",
        kind: "cli-help",
        status: "skipped",
        reason: "--openclaw-bin was not provided"
      },
      capabilities: []
    };
  }

  const helpCommand = `${quoteShell(openclawBin)} --help`;
  const topLevel = await runCommand(helpCommand, {
    timeoutMs,
    maxOutputChars: 50000
  });
  if (topLevel.status !== 0) {
    return {
      source: {
        id: "openclaw-help",
        kind: "cli-help",
        status: "failed",
        command: topLevel.command,
        statusCode: topLevel.status,
        timedOut: topLevel.timedOut,
        error: topLevel.stderr.trim() || topLevel.stdout.trim() || "openclaw --help failed"
      },
      capabilities: []
    };
  }

  const parsedCommands = requestedSubcommands.length > 0
    ? requestedSubcommands
    : parseHelpCommands(topLevel.stdout);
  const allUniqueCommands = [...new Set(parsedCommands)].sort();
  const uniqueCommands = allUniqueCommands.slice(0, maxSubcommands);
  const capabilities = uniqueCommands.map((command) => ({
    id: `cli:${command}`,
    kind: "cli-command",
    name: command,
    source: "openclaw-help",
    path: null,
    summary: null,
    evidence: {
      command: helpCommand
    }
  }));

  for (const capability of capabilities) {
    const result = await runCommand(`${quoteShell(openclawBin)} ${quoteShell(capability.name)} --help`, {
      timeoutMs,
      maxOutputChars: 30000
    });
    capability.evidence.subcommandHelp = {
      command: result.command,
      status: result.status,
      timedOut: result.timedOut
    };
    if (result.status === 0) {
      capability.summary = firstUsefulHelpLine(result.stdout);
    }
  }

  return {
    source: {
      id: "openclaw-help",
      kind: "cli-help",
      status: "scanned",
      command: topLevel.command,
      commandCount: capabilities.length,
      discoveredCommandCount: allUniqueCommands.length,
      truncated: allUniqueCommands.length > uniqueCommands.length,
      requestedSubcommands
    },
    capabilities
  };
}

async function discoverRepoInventory({ repoPath, scriptScope }) {
  if (!repoPath) {
    return {
      sources: [
        {
          id: "package-scripts",
          kind: "package-json",
          status: "skipped",
          reason: "--openclaw-repo was not provided"
        },
        {
          id: "manifests",
          kind: "manifest-scan",
          status: "skipped",
          reason: "--openclaw-repo was not provided"
        }
      ],
      capabilities: []
    };
  }

  const sources = [];
  const capabilities = [];
  const packagePath = join(repoPath, "package.json");
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const scripts = Object.keys(packageJson.scripts ?? {}).sort();
    const includedScripts = filterPackageScripts(scripts, scriptScope);
    for (const script of includedScripts) {
      capabilities.push({
        id: `script:${script}`,
        kind: "package-script",
        name: script,
        source: "package-scripts",
        path: relative(repoPath, packagePath),
        summary: packageJson.scripts[script],
        evidence: {
          packageName: packageJson.name ?? null
        }
      });
    }
    sources.push({
      id: "package-scripts",
      kind: "package-json",
      status: "scanned",
      path: packagePath,
      scriptScope,
      scriptCount: scripts.length,
      includedScriptCount: includedScripts.length,
      excludedScriptCount: scripts.length - includedScripts.length
    });
  } catch (error) {
    sources.push({
      id: "package-scripts",
      kind: "package-json",
      status: error.code === "ENOENT" ? "missing" : "failed",
      path: packagePath,
      error: error.code === "ENOENT" ? null : error.message
    });
  }

  const manifestResult = await discoverManifests(repoPath);
  sources.push(manifestResult.source);
  capabilities.push(...manifestResult.capabilities);
  return { sources, capabilities };
}

async function discoverManifests(repoPath) {
  const candidates = [];
  const roots = manifestSearchDirs.map((dir) => join(repoPath, dir));
  for (const root of roots) {
    await collectManifestCandidates(root, candidates);
  }

  const capabilities = [];
  for (const path of selectManifestCandidates(candidates)) {
    try {
      const manifest = parseManifest(path, await readFile(path, "utf8"));
      const kind = classifyManifest(path, manifest);
      if (!kind) {
        continue;
      }
      const name = manifest.name ?? manifest.id ?? manifest.displayName ?? basename(path);
      capabilities.push({
        id: `${kind}:${normalizeToken(name) || normalizeToken(relative(repoPath, path))}`,
        kind,
        name,
        source: "manifests",
        path: relative(repoPath, path),
        summary: manifest.description ?? manifest.title ?? null,
        evidence: {
          manifestId: manifest.id ?? null,
          packageName: manifest.name ?? null
        }
      });
    } catch {
      // Unparseable manifest-looking files are ignored; registry validation catches Kova contracts.
    }
  }

  return {
    source: {
      id: "manifests",
      kind: "manifest-scan",
      status: "scanned",
      roots: roots.map((root) => relative(repoPath, root)),
      candidateCount: candidates.length,
      capabilityCount: capabilities.length,
      truncated: candidates.length > manifestCandidateLimit
    },
    capabilities
  };
}

async function collectManifestCandidates(root, candidates, depth = 0) {
  if (depth > 8 || candidates.length >= manifestCandidateCollectionLimit) {
    return;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  entries.sort((left, right) => comparePaths(left.name, right.name));

  for (const entry of entries) {
    if (candidates.length >= manifestCandidateCollectionLimit) {
      return;
    }
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        await collectManifestCandidates(join(root, entry.name), candidates, depth + 1);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (
      name === "openclaw.plugin.json" ||
      name === "plugin.json" ||
      name === "manifest.json" ||
      name.endsWith(".manifest.json")
    ) {
      candidates.push(join(root, entry.name));
    }
  }
}

export function selectManifestCandidates(candidates) {
  return [...candidates]
    .sort((left, right) => comparePaths(normalizePath(left), normalizePath(right)))
    .slice(0, manifestCandidateLimit);
}

export function classifyManifest(path, manifest) {
  const lowerPath = normalizePath(path).toLowerCase();
  if (
    manifest.openclawPlugin === true ||
    manifest.plugin === true ||
    lowerPath.endsWith("/openclaw.plugin.json") ||
    lowerPath.endsWith("/plugin.json")
  ) {
    return "plugin-manifest";
  }
  if (manifest.openclawExtension === true || manifest.extension === true || lowerPath.includes("/extensions/")) {
    return "extension-manifest";
  }
  if (Array.isArray(manifest.contributes) || manifest.activationEvents || manifest.main) {
    return lowerPath.includes("plugin") ? "plugin-manifest" : "extension-manifest";
  }
  return null;
}

function parseManifest(path, raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (!normalizePath(path).toLowerCase().endsWith("/openclaw.plugin.json")) {
      throw error;
    }
    return JSON5.parse(raw);
  }
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/");
}

function comparePaths(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function classifyCapability(capability, surfaces) {
  const matchedSurfaceIds = matchSurfaceIds(capability, surfaces);
  return {
    ...capability,
    modeled: matchedSurfaceIds.length > 0,
    matchedSurfaceIds,
    matchStatus: matchedSurfaceIds.length === 0
      ? "unmodeled"
      : matchedSurfaceIds.length === 1 ? "matched" : "ambiguous"
  };
}

function matchSurfaceIds(capability, surfaces) {
  const normalizedName = normalizeToken(capability.name);
  const mapped = [
    ...(commandSurfaceMap.get(normalizedName) ?? []),
    ...matchPackageScriptSurfaceIds(capability)
  ];
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const matches = new Set(mapped.filter((id) => surfaceIds.has(id)));

  for (const surface of surfaces) {
    const haystack = [
      surface.id,
      surface.title,
      surface.ownerArea,
      ...(surface.purposes ?? [])
    ].map(normalizeToken);
    if (haystack.includes(normalizedName)) {
      matches.add(surface.id);
    }
  }

  return [...matches].sort();
}

function summarizeCoverage(capabilities, modeledSurfaces, options = {}) {
  const unmodeled = capabilities.filter((capability) => !capability.modeled);
  const matched = capabilities.filter((capability) => capability.modeled);
  const ambiguous = matched.filter((capability) => capability.matchStatus === "ambiguous");
  const requiredModeled = options.requiredModeled ?? [];
  const capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const blockers = requiredModeled.flatMap((id) => {
    const capability = capabilitiesById.get(id);
    if (!capability) {
      return [{
        kind: "required-capability-missing",
        capability: id,
        message: `required inventory capability ${id} was not discovered`
      }];
    }
    if (!capability.modeled) {
      return [{
        kind: "required-capability-unmodeled",
        capability: id,
        name: capability.name,
        source: capability.source,
        message: `required inventory capability ${id} is not mapped to a Kova surface`
      }];
    }
    return [];
  });
  return {
    discoveredCount: capabilities.length,
    modeledSurfaceCount: modeledSurfaces.length,
    matchedCount: matched.length,
    ambiguousCount: ambiguous.length,
    unmodeledCount: unmodeled.length,
    requiredModeled,
    ok: blockers.length === 0,
    blockers,
    warnings: unmodeled.map((capability) => ({
      kind: "unmodeled-capability",
      capability: capability.id,
      name: capability.name,
      source: capability.source,
      message: `${capability.kind} ${capability.name} is not mapped to a Kova surface`
    })),
    ambiguous: ambiguous.map((capability) => ({
      id: capability.id,
      kind: capability.kind,
      name: capability.name,
      source: capability.source,
      matchedSurfaceIds: capability.matchedSurfaceIds
    })),
    unmodeled: unmodeled.map((capability) => ({
      id: capability.id,
      kind: capability.kind,
      name: capability.name,
      source: capability.source,
      path: capability.path
    }))
  };
}

function parseHelpCommands(text) {
  const commands = [];
  let inCommands = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "");
    if (/^\s*(commands|available commands):\s*$/i.test(line)) {
      inCommands = true;
      continue;
    }
    if (inCommands && /^\S/.test(line) && !/^\s/.test(rawLine)) {
      inCommands = false;
    }
    if (!inCommands) {
      continue;
    }
    const match = line.match(/^\s{2,}([a-z][a-z0-9-]*)\s*(?:\*)?\s{2,}\S/);
    if (match) {
      commands.push(match[1]);
    }
  }
  return commands.filter((command) => !["help", "completion"].includes(command));
}

function filterPackageScripts(scripts, scriptScope) {
  if (scriptScope === "none") {
    return [];
  }
  if (scriptScope === "all") {
    return scripts;
  }
  return scripts.filter(isProductScript);
}

function isProductScript(script) {
  return productScriptNames.has(script) ||
    productScriptPrefixes.some((prefix) => script.startsWith(prefix));
}

function matchPackageScriptSurfaceIds(capability) {
  if (capability.kind !== "package-script") {
    return [];
  }
  const name = String(capability.name ?? "");
  const normalizedName = normalizeToken(name);
  const searchableName = `${name} ${normalizedName}`;
  const surfaceIds = new Set();
  const add = (...ids) => {
    for (const id of ids) {
      surfaceIds.add(id);
    }
  };

  if (/gateway|(^|[: -])start($|[: -])|openclaw|startup|stability/.test(searchableName)) {
    add("release-runtime-startup", "gateway-performance");
  }
  if (/tui|chat|terminal/.test(searchableName)) {
    add("tui", "tui-message-turn");
  }
  if (/chat|session|channel/.test(searchableName)) {
    add("gateway-session-send-turn");
  }
  if (/dashboard|(^|[: -])ui[: -]/.test(searchableName)) {
    add("dashboard", "gateway-session-send-turn");
  }
  if (/plugin-sdk|plugins?|plugin-update/.test(searchableName)) {
    add("plugin-lifecycle", "official-plugin-install");
  }
  if (/release|install|onboard|published-upgrade|update-migration|upgrade-survivor/.test(searchableName)) {
    add("fresh-install", "upgrade-existing-user");
  }
  if (/models?|provider|capability|infer|openai/.test(searchableName)) {
    add("provider-models", "openai-compatible-turn");
  }
  if (/agent|acp|cli-backend/.test(searchableName)) {
    add("agent-cli-local-turn", "agent-gateway-rpc-turn");
  }
  if (/mcp/.test(searchableName)) {
    add("mcp-runtime");
  }
  if (/browser/.test(searchableName)) {
    add("browser-automation");
  }
  if (/media/.test(searchableName)) {
    add("media-understanding");
  }
  if (/workspace/.test(searchableName)) {
    add("workspace-scan");
  }
  if (/perf|soak/.test(searchableName)) {
    add("gateway-performance", "soak");
  }

  return [...surfaceIds];
}

function firstUsefulHelpLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^usage:/i.test(line) && !/^commands:/i.test(line)) ?? null;
}

function parseList(raw) {
  if (!raw || raw === true) {
    return [];
  }
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeOptionalPath(value) {
  if (!value || value === true) {
    return null;
  }
  return resolveFromCwd(String(value));
}

function normalizeOptionalCommand(value) {
  if (!value || value === true) {
    return null;
  }
  const command = String(value);
  return command.includes("/") || command.startsWith(".") ? resolveFromCwd(command) : command;
}

function normalizeScriptScope(value) {
  if (!value || value === true) {
    return "product";
  }
  const scope = String(value).trim().toLowerCase();
  if (!packageScriptScopes.has(scope)) {
    throw new Error(`invalid --script-scope ${scope}; expected product, all, or none`);
  }
  return scope;
}

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/openclaw/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
