import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCleanupCommand } from "../cleanup.mjs";
import { runCommand } from "../commands.mjs";
import { artifactsDir, reportsDir } from "../paths.mjs";
import {
  ocmEnvDestroy,
  ocmEnvListJson,
  ocmServiceStatusAllJson
} from "../ocm/commands.mjs";
import { positiveIntegerFlag } from "../run/options.mjs";
import { renderCleanupEnvs, renderCleanupArtifacts } from "../reporting/render-cleanup.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runCleanupCliCommand(flags) {
  const [subcommand] = flags._;
  if (subcommand === "envs") {
    await cleanupEnvs(flags);
    return;
  }
  if (subcommand === "artifacts") {
    await cleanupArtifacts(flags);
    return;
  }

  throw new Error(`unknown cleanup command: ${subcommand ?? ""}`);
}

async function cleanupEnvs(flags) {
  const olderThanDays = positiveIntegerFlag(flags, "older_than_days", 1);
  const cutoffMs = Date.now() - olderThanDays * DAY_MS;
  const force = flags.force === true;
  const envList = await runCommand(ocmEnvListJson(), { timeoutMs: 30000 });
  if (envList.status !== 0) {
    throw new Error(`failed to list OCM envs: ${envList.stderr.trim() || envList.stdout.trim()}`);
  }

  const summaries = JSON.parse(envList.stdout);
  if (!Array.isArray(summaries)) {
    throw new Error("ocm env list --json returned unexpected data");
  }

  const serviceInventory = await loadServiceInventory();
  const retentionInventory = await loadRetentionInventory();
  const envs = summaries
    .filter((summary) => /^kova-[a-z0-9-]+$/.test(summary?.name))
    .map((summary) => classifyCleanupEnv({
      summary,
      service: serviceInventory.byEnv.get(summary.name),
      serviceInventoryOk: serviceInventory.ok,
      retained: retentionInventory.envNames.has(summary.name),
      retentionInventoryOk: retentionInventory.ok,
      cutoffMs,
      force
    }));
  const candidates = envs.filter((env) => env.eligible);
  const results = [];

  // Destructive cleanup must require the literal boolean set by `--execute`.
  if (flags.execute === true) {
    for (const env of candidates) {
      const result = await runCleanupCommand(ocmEnvDestroy(env.name, { force }), { timeoutMs: 120000 });
      results.push({
        env: env.name,
        command: result.command,
        status: result.status,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        attempts: result.attempts ?? []
      });
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.envs.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      force,
      olderThanDays,
      serviceInventory: {
        ok: serviceInventory.ok,
        error: serviceInventory.error
      },
      retentionInventory: {
        ok: retentionInventory.ok,
        error: retentionInventory.error
      },
      envs: envs.map((env) => env.name),
      classifications: envs,
      candidates: candidates.map((candidate) => candidate.name),
      results
    }, null, 2));
    return;
  }

  if (flags.plain === true) {
    if (envs.length === 0) {
      console.log("No Kova envs found.");
      return;
    }
    if (flags.execute !== true) {
      console.log(`Kova env cleanup plan (older than ${olderThanDays} day(s)):`);
      for (const env of envs) {
        console.log(`- ${env.eligible ? "REMOVE" : "SKIP"} ${env.name}: ${env.reasons.join(", ") || "eligible"}`);
      }
      console.log("Run with --execute to destroy eligible envs; add --force to override safeguards.");
      return;
    }
    for (const result of results) {
      console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.env}: ${result.command}`);
    }
    return;
  }

  console.log(renderCleanupEnvs({
    envs,
    results,
    execute: flags.execute === true,
    force,
    olderThanDays
  }, flags));
}

async function loadServiceInventory() {
  const result = await runCommand(ocmServiceStatusAllJson(), { timeoutMs: 30000 });
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`,
      byEnv: new Map()
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed?.services)) {
      throw new Error("services array missing");
    }
    return {
      ok: true,
      error: null,
      byEnv: new Map(parsed.services.map((service) => [service.envName, service]))
    };
  } catch (error) {
    return {
      ok: false,
      error: `invalid service status JSON: ${error.message}`,
      byEnv: new Map()
    };
  }
}

async function loadRetentionInventory() {
  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ok: true, error: null, envNames: new Set() };
    }
    return {
      ok: false,
      error: `failed to read reports directory: ${error.message}`,
      envNames: new Set()
    };
  }

  const retained = new Set();
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".summary.json")) {
      continue;
    }
    try {
      const report = JSON.parse(await readFile(join(reportsDir, entry.name), "utf8"));
      for (const record of report.records ?? []) {
        if (record?.cleanup === "retained" && typeof record.envName === "string") {
          retained.add(record.envName);
        }
      }
    } catch (error) {
      errors.push(`${entry.name}: ${error.message}`);
    }
  }
  return {
    ok: errors.length === 0,
    error: errors.length === 0 ? null : `failed to read retention evidence: ${errors.join("; ")}`,
    envNames: retained
  };
}

function classifyCleanupEnv({
  summary,
  service,
  serviceInventoryOk,
  retained,
  retentionInventoryOk,
  cutoffMs,
  force
}) {
  const timestamp = Date.parse(summary.lastUsedAt ?? summary.createdAt ?? "");
  const ageDays = Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS))
    : null;
  const serviceKnown = serviceInventoryOk && service !== undefined;
  const active = serviceKnown && (
    service.running === true ||
    service.desiredRunning === true ||
    service.childPid != null ||
    !["stopped", "not-installed"].includes(service.gatewayState)
  );
  const reasons = [];
  if (!Number.isFinite(timestamp)) reasons.push("unknown-age");
  else if (timestamp > cutoffMs) reasons.push("too-recent");
  if (summary.protected === true) reasons.push("protected");
  if (retained) reasons.push("retained-by-run");
  if (!retentionInventoryOk) reasons.push("unknown-retention-state");
  if (!serviceKnown) reasons.push("unknown-service-state");
  else if (active) reasons.push("active-service");

  return {
    name: summary.name,
    eligible: force || reasons.length === 0,
    forced: force && reasons.length > 0,
    reasons,
    ageDays,
    createdAt: summary.createdAt ?? null,
    lastUsedAt: summary.lastUsedAt ?? null,
    protected: summary.protected === true,
    retained,
    service: serviceKnown
      ? {
        installed: service.installed === true,
        desiredRunning: service.desiredRunning === true,
        running: service.running === true,
        gatewayState: service.gatewayState ?? null,
        childPid: service.childPid ?? null,
        issue: service.issue ?? null
      }
      : null
  };
}

async function cleanupArtifacts(flags) {
  const olderThanDays = positiveIntegerFlag(flags, "older_than_days", 7);
  const cutoffMs = Date.now() - olderThanDays * DAY_MS;
  const candidates = [];

  let entries = [];
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^kova-\d{4}-\d{2}-\d{2}t/i.test(entry.name)) {
      continue;
    }
    const path = join(artifactsDir, entry.name);
    const info = await stat(path);
    if (info.mtimeMs > cutoffMs) {
      continue;
    }
    candidates.push({
      name: entry.name,
      path,
      mtime: info.mtime.toISOString(),
      ageDays: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / DAY_MS))
    });
  }

  const results = [];
  if (flags.execute === true) {
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        await rm(candidate.path, { recursive: true, force: true });
        results.push({
          path: candidate.path,
          status: 0,
          durationMs: Date.now() - started,
          error: null
        });
      } catch (error) {
        results.push({
          path: candidate.path,
          status: 1,
          durationMs: Date.now() - started,
          error: error.message
        });
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.artifacts.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      artifactsDir,
      olderThanDays,
      candidates,
      results
    }, null, 2));
    return;
  }

  if (flags.plain === true) {
    if (candidates.length === 0) {
      console.log(`No Kova run artifact dirs older than ${olderThanDays} day(s) found.`);
      return;
    }
    if (flags.execute !== true) {
      console.log(`Kova run artifact dirs older than ${olderThanDays} day(s):`);
      for (const candidate of candidates) {
        console.log(`- ${candidate.path}`);
      }
      console.log("Run with --execute to remove them.");
      return;
    }
    for (const result of results) {
      console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.path}`);
    }
    return;
  }

  console.log(renderCleanupArtifacts({
    candidates, results, execute: flags.execute === true, artifactsDir, olderThanDays,
  }, flags));
}
