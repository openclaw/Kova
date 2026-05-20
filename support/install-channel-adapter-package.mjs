#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSupportArgs, readTimeoutMs } from "./openclaw-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const startedAtEpochMs = Date.now();

try {
  const args = parseSupportArgs(process.argv.slice(2));
  const envName = requiredArg(args, "env");
  const artifactDir = requiredArg(args, "artifact-dir");
  const channelId = requiredArg(args, "channel");
  const targetRepo = args["target-repo"] ?? "";
  const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
  const registry = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", `${channelId}.json`), "utf8"));
  const distribution = registry.adapterDistribution;

  assertSafeKovaEnv(envName);
  if (distribution?.kind !== "external") {
    throw new Error(`channel ${channelId} does not use an external adapter package`);
  }

  const localPackage = await resolveInstallSpec({ distribution, targetRepo, artifactDir, channelId });
  const installSpec = localPackage.installSpec;
  const preparationCommands = localPackage.preparationCommands ?? [];
  const install = await runStep(`install:${channelId}`, "ocm", [`@${envName}`, "--", "plugins", "install", installSpec, "--force"], { timeoutMs });
  const list = install.status === 0
    ? await runStep(`list:${channelId}`, "ocm", [`@${envName}`, "--", "plugins", "list"], { timeoutMs: 30000 })
    : skippedStep(`list:${channelId}`, "install failed");
  const registryRefresh = install.status === 0
    ? await runStep(`registry-refresh:${channelId}`, "ocm", [`@${envName}`, "--", "plugins", "registry", "--refresh", "--json"], { timeoutMs: 60000 })
    : skippedStep(`registry-refresh:${channelId}`, "install failed");
  const ok = install.status === 0 && list.status === 0 && registryRefresh.status === 0;
  const artifactPath = join(artifactDir, `channel-adapter-install-${safeArtifactSegment(channelId)}.json`);
  const artifact = {
    schemaVersion: "kova.channelAdapterInstall.v1",
    ok,
    envName,
    channelId,
    adapterId: registry.adapterId,
    distribution,
    installSpec,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs,
    commands: [...preparationCommands, install, list, registryRefresh].map(compactStep)
  };

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "kova.channelAdapterInstall.v1",
    ok,
    artifactPath,
    envName,
    channelId,
    adapterId: registry.adapterId,
    installSpec,
    commands: artifact.commands
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  const summary = {
    schemaVersion: "kova.channelAdapterInstall.v1",
    ok: false,
    error: error.message,
    startedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    durationMs: Date.now() - startedAtEpochMs,
    commands: []
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

async function resolveInstallSpec({ distribution, targetRepo, artifactDir, channelId }) {
  const trimmedRepo = String(targetRepo ?? "").trim();
  if (trimmedRepo) {
    const repoPath = resolve(trimmedRepo);
    const packageSource = resolve(repoPath, "extensions", channelId);
    if (!isInsideOrSame(repoPath, packageSource)) {
      throw new Error(`channel ${distribution.pluginId} localBuildPath escapes target repo`);
    }
    if (existsSync(join(packageSource, "package.json"))) {
      return await stageLocalBuildPackage({ repoPath, packageSource, artifactDir, channelId });
    }
  }
  return { installSpec: distribution.packageName, preparationCommands: [] };
}

async function stageLocalBuildPackage({ repoPath, packageSource, artifactDir, channelId }) {
  const stagingRoot = resolve(artifactDir, "channel-adapter-packages");
  const stagedPackage = join(stagingRoot, channelId);
  await rm(stagedPackage, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(packageSource, stagedPackage, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(packageSource.length).replaceAll("\\", "/");
      return !relative.startsWith("/node_modules") && !relative.startsWith("/dist");
    }
  });
  await writeFile(join(stagedPackage, "tsconfig.json"), `${JSON.stringify({
    extends: join(repoPath, "tsconfig.json")
  }, null, 2)}\n`, "utf8");

  const runtimeBuildModule = await import(pathToFileURL(join(repoPath, "scripts", "lib", "plugin-npm-runtime-build.mjs")).href);
  const packageManifestModule = await import(pathToFileURL(join(repoPath, "scripts", "lib", "plugin-npm-package-manifest.mjs")).href);
  const buildResult = await runtimeBuildModule.buildPluginNpmRuntime({
    repoRoot: repoPath,
    packageDir: stagedPackage,
    logLevel: "warn"
  });
  if (!buildResult) {
    throw new Error(`channel ${channelId} did not produce a package-local runtime build`);
  }

  const packageJsonOverlay = packageManifestModule.resolveAugmentedPluginNpmPackageJson({
    repoRoot: repoPath,
    packageDir: stagedPackage
  });
  if (packageJsonOverlay.packageJson) {
    await writeFile(packageJsonOverlay.packageJsonPath, `${JSON.stringify(packageJsonOverlay.packageJson, null, 2)}\n`, "utf8");
  }
  const manifestOverlay = packageManifestModule.resolveAugmentedPluginNpmManifest({
    repoRoot: repoPath,
    packageDir: stagedPackage
  });
  if (manifestOverlay.manifest) {
    await writeFile(manifestOverlay.manifestPath, `${JSON.stringify(manifestOverlay.manifest, null, 2)}\n`, "utf8");
  }
  const pack = await runStep(`pack:${channelId}`, "npm", ["pack", "--silent", "--pack-destination", stagingRoot], {
    timeoutMs: 60000,
    cwd: stagedPackage
  });
  if (pack.status !== 0) {
    throw new Error(`failed to pack staged channel package ${channelId}: ${pack.stderrTail || pack.stdoutTail}`);
  }
  const packedFilename = pack.stdoutTail.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  const tarballPath = packedFilename && resolve(packedFilename) === packedFilename
    ? packedFilename
    : join(stagingRoot, packedFilename ?? "");
  if (!packedFilename || !existsSync(tarballPath)) {
    throw new Error(`npm pack did not produce a tarball for staged channel package ${channelId}`);
  }
  return {
    installSpec: tarballPath,
    preparationCommands: [pack]
  };
}

function runStep(id, command, args, options) {
  const started = Date.now();
  return new Promise((resolveStep) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: options.cwd
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveStep({
        id,
        command: [command, ...args].join(" "),
        status,
        timedOut,
        durationMs: Date.now() - started,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr)
      });
    });
  });
}

function skippedStep(id, reason) {
  return {
    id,
    command: null,
    status: null,
    skipped: true,
    reason,
    timedOut: false,
    durationMs: 0,
    stdoutTail: "",
    stderrTail: ""
  };
}

function compactStep(step) {
  return {
    id: step.id,
    command: step.command,
    status: step.status,
    skipped: step.skipped === true,
    reason: step.reason ?? null,
    timedOut: step.timedOut === true,
    durationMs: step.durationMs,
    stdoutTail: step.stdoutTail,
    stderrTail: step.stderrTail
  };
}

function assertSafeKovaEnv(value) {
  if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`refusing to install channel adapter package against non-Kova env '${value}'`);
  }
}

function isInsideOrSame(parent, child) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function tail(value, maxLength = 4000) {
  return String(value ?? "").slice(-maxLength);
}

function safeArtifactSegment(value) {
  return String(value ?? "all").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}
