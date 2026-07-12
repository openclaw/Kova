import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCleanupCommand } from "../cleanup.mjs";
import { runCommand } from "../commands.mjs";
import { artifactsDir } from "../paths.mjs";
import { ocmEnvDestroy, ocmEnvListJson } from "../ocm/commands.mjs";
import { positiveIntegerFlag } from "../run/options.mjs";
import { renderCleanupEnvs, renderCleanupArtifacts } from "../reporting/render-cleanup.mjs";

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
  const envList = await runCommand(ocmEnvListJson(), { timeoutMs: 30000 });
  if (envList.status !== 0) {
    throw new Error(`failed to list OCM envs: ${envList.stderr.trim() || envList.stdout.trim()}`);
  }

  const summaries = JSON.parse(envList.stdout);
  if (!Array.isArray(summaries)) {
    throw new Error("ocm env list --json returned unexpected data");
  }

  const envs = summaries
    .map((summary) => summary.name)
    .filter((name) => /^kova-[a-z0-9-]+$/.test(name));
  const results = [];

  if (flags.execute === true) {
    for (const env of envs) {
      results.push(await runCleanupCommand(ocmEnvDestroy(env), { timeoutMs: 120000 }));
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.envs.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      envs,
      results: results.map((result) => ({
        command: result.command,
        status: result.status,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        attempts: result.attempts ?? []
      }))
    }, null, 2));
    return;
  }

  if (flags.plain === true) {
    if (envs.length === 0) {
      console.log("No stale Kova envs found.");
      return;
    }
    if (!flags.execute) {
      console.log("Stale Kova envs:");
      for (const env of envs) {
        console.log(`- ${env}`);
      }
      console.log("Run with --execute to destroy them.");
      return;
    }
    for (const result of results) {
      console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.command}`);
    }
    return;
  }

  console.log(renderCleanupEnvs({ envs, results, execute: flags.execute === true }, flags));
}

async function cleanupArtifacts(flags) {
  const olderThanDays = positiveIntegerFlag(flags, "older_than_days", 7);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
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
      ageDays: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / (24 * 60 * 60 * 1000)))
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
