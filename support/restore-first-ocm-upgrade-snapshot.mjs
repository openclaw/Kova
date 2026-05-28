#!/usr/bin/env node

import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const envName = args.env;

if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(String(envName ?? ""))) {
  throw new Error(`refusing to restore snapshot for non-Kova env: ${JSON.stringify(envName)}`);
}

const snapshots = await listSnapshots(envName);
const selected = selectFirstUpgradeSnapshot(snapshots);
if (!selected?.id) {
  throw new Error(`no OCM pre-upgrade snapshots found for ${envName}`);
}

const restored = await runOcmJson(["env", "snapshot", "restore", envName, selected.id, "--json"]);
process.stdout.write(`${JSON.stringify({
  schemaVersion: "kova.ocmUpgradeSnapshotRestore.v1",
  envName,
  snapshotId: selected.id,
  selectedBy: "oldest-pre-upgrade-snapshot",
  snapshot: selected,
  restored
}, null, 2)}\n`);

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      out.env = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

async function listSnapshots(envName) {
  const payload = await runOcmJson(["env", "snapshot", "list", envName, "--json"]);
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.snapshots)) {
    return payload.snapshots;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
}

function selectFirstUpgradeSnapshot(snapshots) {
  const candidates = snapshots
    .filter((snapshot) => snapshot && typeof snapshot === "object")
    .filter((snapshot) => String(snapshot.label ?? "").toLowerCase() === "pre-upgrade");
  return candidates
    .sort((left, right) => snapshotSortKey(left).localeCompare(snapshotSortKey(right)))
    [0] ?? null;
}

function snapshotSortKey(snapshot) {
  return String(snapshot.createdAt ?? snapshot.created_at ?? snapshot.timestamp ?? snapshot.id ?? "");
}

async function runOcmJson(args) {
  const result = await runCommand("ocm", args);
  if (result.status !== 0) {
    throw new Error(`ocm ${args.join(" ")} failed with status ${result.status}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch (error) {
    throw new Error(`ocm ${args.join(" ")} did not return JSON: ${error.message}`);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
