#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const [targetVersion, mode, commitRef] = process.argv.slice(2);
if (!targetVersion) {
  fail("target version is required");
}
if (mode && (mode !== "--commit" || !commitRef)) {
  fail("usage: validate-version-metadata.mjs <version> [--commit <ref>]");
}

const baseRef = commitRef ? `${commitRef}^` : "HEAD";
const basePackage = readGitJson(baseRef, "package.json");
const baseLockfile = readGitJson(baseRef, "package-lock.json");
const packageJson = commitRef ? readGitJson(commitRef, "package.json") : await readJson("package.json");
const lockfile = commitRef ? readGitJson(commitRef, "package-lock.json") : await readJson("package-lock.json");

if (packageJson.version !== targetVersion) {
  fail(`package.json version must be ${targetVersion}`);
}

const normalizedPackage = structuredClone(packageJson);
normalizedPackage.version = basePackage.version;
if (!isDeepStrictEqual(normalizedPackage, basePackage)) {
  fail("package.json contains changes outside the version field");
}

const baseRootPackage = baseLockfile.packages?.[""];
const rootPackage = lockfile.packages?.[""];
if (!baseRootPackage || !rootPackage) {
  fail('package-lock.json must contain packages[""] metadata');
}

const allowedLockfileVersions = new Set(commitRef ? [targetVersion] : [baseLockfile.version, targetVersion]);
if (!allowedLockfileVersions.has(lockfile.version) || !allowedLockfileVersions.has(rootPackage.version)) {
  const expectedVersions = commitRef ? targetVersion : `${baseLockfile.version} or ${targetVersion}`;
  fail(`package-lock.json version fields must be ${expectedVersions}`);
}

const normalizedLockfile = structuredClone(lockfile);
normalizedLockfile.version = baseLockfile.version;
normalizedLockfile.packages[""].version = baseRootPackage.version;
if (!isDeepStrictEqual(normalizedLockfile, baseLockfile)) {
  fail("package-lock.json contains changes outside version fields");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`could not parse ${path}: ${error.message}`);
  }
}

function readGitJson(ref, path) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    fail(`could not read ${ref}:${path}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse ${ref}:${path}: ${error.message}`);
  }
}

function fail(message) {
  console.error(`error: unsafe release metadata state: ${message}`);
  process.exit(1);
}
