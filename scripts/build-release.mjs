#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const version = packageJson.version;
const distDir = parseOutputDir();
await mkdir(distDir, { recursive: true });
const stageRoot = await mkdtemp(join(distDir, ".kova-stage-"));
const appName = `kova-${version}`;
const appDir = join(stageRoot, appName);
const archivePath = join(distDir, `${appName}.tar.gz`);
const checksumPath = `${archivePath}.sha256`;
const latestArchivePath = join(distDir, "kova.tar.gz");
const latestChecksumPath = `${latestArchivePath}.sha256`;
const temporaryArchivePath = join(distDir, `.${appName}.${process.pid}.tar.gz`);
const temporaryChecksumPath = `${temporaryArchivePath}.sha256`;
const temporaryLatestArchivePath = join(distDir, `.kova.${process.pid}.tar.gz`);
const temporaryLatestChecksumPath = `${temporaryLatestArchivePath}.sha256`;

try {
  await mkdir(appDir, { recursive: true });

  for (const path of ["bin", "src", "scenarios", "states", "profiles", "surfaces", "channel-capabilities", "process-roles", "metrics", "support", "fixtures", ".agents/skills/kova-operator", ".agents/skills/ocm-operator"]) {
    await copyRequired(path);
  }

  for (const path of ["README.md", "LICENSE", "package.json", "package-lock.json"]) {
    await copyRequired(path);
  }

  await mkdir(join(appDir, "docs"), { recursive: true });
  for (const path of [
    "docs/WHAT_IS_KOVA.md",
    "docs/AGENT_USAGE.md",
    "docs/HANDOFF_EXAMPLES.md",
    "docs/SCENARIO_HIERARCHY.md",
    "docs/CONTRACT_REGISTRY.md",
    "docs/DIAGNOSTICS_CONTRACT.md",
    "docs/OCM_OPERATOR_INTEGRATION.md",
    "docs/REPORT_SCHEMA.md"
  ]) {
    await copyRequired(path);
  }

  const npm = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
    cwd: appDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (npm.status !== 0) {
    throw new Error(npm.stderr || npm.stdout || "npm ci failed");
  }

  const tar = spawnSync("tar", ["-czf", temporaryArchivePath, "-C", stageRoot, appName], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (tar.status !== 0) {
    throw new Error(tar.stderr || tar.stdout || "tar failed");
  }

  const archive = await readFile(temporaryArchivePath);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  await writeFile(temporaryChecksumPath, `${sha256}  ${appName}.tar.gz\n`, "utf8");
  await cp(temporaryArchivePath, temporaryLatestArchivePath);
  await writeFile(temporaryLatestChecksumPath, `${sha256}  kova.tar.gz\n`, "utf8");

  await rename(temporaryArchivePath, archivePath);
  await rename(temporaryChecksumPath, checksumPath);
  await rename(temporaryLatestArchivePath, latestArchivePath);
  await rename(temporaryLatestChecksumPath, latestChecksumPath);

  console.log(JSON.stringify({
    schemaVersion: "kova.releaseArtifact.v1",
    version,
    archivePath,
    checksumPath,
    latestArchivePath,
    latestChecksumPath,
    sha256,
    bytes: archive.length
  }, null, 2));
} finally {
  await rm(stageRoot, { recursive: true, force: true });
  await rm(temporaryArchivePath, { force: true });
  await rm(temporaryChecksumPath, { force: true });
  await rm(temporaryLatestArchivePath, { force: true });
  await rm(temporaryLatestChecksumPath, { force: true });
}

async function copyRequired(path) {
  const source = join(repoRoot, path);
  if (!existsSync(source)) {
    throw new Error(`release input missing: ${path}`);
  }
  const destination = join(appDir, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function parseOutputDir() {
  let outputDir = "dist";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-dir") {
      index += 1;
      if (!args[index]) {
        throw new Error("--output-dir requires a value");
      }
      outputDir = args[index];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: scripts/build-release.mjs [--output-dir <dir>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return resolve(repoRoot, outputDir);
}
