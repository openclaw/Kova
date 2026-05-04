import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { positiveIntegerFlag } from "../commands/run-support.mjs";
import { resolveFromCwd } from "../cli.mjs";
import { loadRegistryContext } from "../registries/context.mjs";

const inventorySchemaVersion = "kova.inventory.plan.v1";
const manifestSearchDirs = ["apps", "extensions", "packages", "plugins", "src"];
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
  ["agent", ["agent-cli-local-turn", "agent-gateway-rpc-turn"]],
  ["browser", ["browser-automation"]],
  ["dashboard", ["dashboard", "dashboard-session-send-turn"]],
  ["mcp", ["mcp-runtime"]],
  ["media", ["media-understanding"]],
  ["model", ["provider-models"]],
  ["models", ["provider-models"]],
  ["plugin", ["plugin-lifecycle"]],
  ["plugins", ["plugin-lifecycle", "official-plugin-install"]],
  ["provider", ["provider-models"]],
  ["providers", ["provider-models"]],
  ["start", ["release-runtime-startup", "gateway-performance"]],
  ["status", ["release-runtime-startup"]],
  ["stop", ["release-runtime-startup"]],
  ["tui", ["tui", "tui-message-turn"]],
  ["update", ["upgrade-existing-user"]],
  ["upgrade", ["upgrade-existing-user"]],
  ["workspace", ["workspace-scan"]]
]);

export async function buildOpenClawInventoryPlan(flags = {}) {
  const registry = await loadRegistryContext();
  const timeoutMs = positiveIntegerFlag(flags, "timeout_ms", 10000);
  const maxSubcommands = positiveIntegerFlag(flags, "max_subcommands", 40);
  const openclawBin = normalizeOptionalCommand(flags.openclaw_bin);
  const repoPath = normalizeOptionalPath(flags.openclaw_repo);
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

  const repoInventory = await discoverRepoInventory({ repoPath });
  sources.push(...repoInventory.sources);
  capabilities.push(...repoInventory.capabilities);

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
      repoPath
    },
    sources,
    modeledSurfaces,
    capabilities: classifiedCapabilities,
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

async function discoverRepoInventory({ repoPath }) {
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
    for (const script of scripts) {
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
      scriptCount: scripts.length
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
    await collectManifestCandidates(root, repoPath, candidates);
  }

  const capabilities = [];
  for (const path of candidates.slice(0, 300)) {
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
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
      // Non-JSON manifest-looking files are ignored; registry validation catches Kova contracts.
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
      truncated: candidates.length > 300
    },
    capabilities
  };
}

async function collectManifestCandidates(root, repoPath, candidates, depth = 0) {
  if (depth > 8 || candidates.length > 300) {
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

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        await collectManifestCandidates(join(root, entry.name), repoPath, candidates, depth + 1);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (name === "plugin.json" || name === "manifest.json" || name.endsWith(".manifest.json")) {
      candidates.push(join(root, entry.name));
    }
  }
}

function classifyManifest(path, manifest) {
  const lowerPath = path.toLowerCase();
  if (manifest.openclawPlugin === true || manifest.plugin === true || lowerPath.endsWith("/plugin.json")) {
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
  const mapped = commandSurfaceMap.get(normalizedName) ?? [];
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
    warnings: [
      ...unmodeled.map((capability) => ({
        kind: "unmodeled-capability",
        capability: capability.id,
        name: capability.name,
        source: capability.source,
        message: `${capability.kind} ${capability.name} is not mapped to a Kova surface`
      })),
      ...ambiguous.map((capability) => ({
        kind: "ambiguous-capability",
        capability: capability.id,
        name: capability.name,
        source: capability.source,
        matchedSurfaceIds: capability.matchedSurfaceIds,
        message: `${capability.kind} ${capability.name} maps to multiple Kova surfaces`
      }))
    ],
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
    const match = line.match(/^\s{2,}([a-z][a-z0-9:-]*)\b/i);
    if (match) {
      commands.push(match[1]);
    }
  }
  return commands.filter((command) => !["help", "completion"].includes(command));
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

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/openclaw/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
