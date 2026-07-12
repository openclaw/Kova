#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const [targetVersion] = process.argv.slice(2);
if (!targetVersion) {
  fail("target version is required");
}

const basePackage = readHeadJson("package.json");
const baseLockfile = readHeadJson("package-lock.json");
const packageJson = await readJson("package.json");
const lockfile = await readJson("package-lock.json");

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

const allowedLockfileVersions = new Set([baseLockfile.version, targetVersion]);
if (!allowedLockfileVersions.has(lockfile.version) || !allowedLockfileVersions.has(rootPackage.version)) {
  fail(`package-lock.json version fields must be ${baseLockfile.version} or ${targetVersion}`);
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

function readHeadJson(path) {
  const result = spawnSync("git", ["show", `HEAD:${path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    fail(`could not read HEAD:${path}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse HEAD:${path}: ${error.message}`);
  }
}

function fail(message) {
  console.error(`error: unsafe release metadata state: ${message}`);
  process.exit(1);
}
