import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCleanupCommand } from "../cleanup.mjs";
import { runCommand } from "../commands.mjs";
import { artifactsDir, reportsDir } from "../paths.mjs";
import {
  ocmEnvDestroy,
  ocmEnvDestroyPreviewJson,
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
  const summaries = await loadEnvSummaries();

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
      const { result, precondition, stage, code } = await destroyCleanupEnv(env.name, {
        force,
        cutoffMs
      });
      results.push({
        env: env.name,
        stage,
        code,
        precondition,
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
  if (flags.execute === true && results.some((result) => result.status !== 0)) {
    process.exitCode = 1;
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

async function destroyCleanupEnv(envName, { force, cutoffMs }) {
  if (force) {
    const result = await runCleanupCommand(
      ocmEnvDestroy(envName, { force: true, json: true }),
      {
        timeoutMs: 120000,
        // Force bypasses blockers, but it does not make partial teardown retry-safe.
        retryDelaysMs: [0]
      }
    );
    const code = cleanupResultCode(result);
    return {
      result,
      precondition: null,
      stage: code === "partial_apply" ? "partial-apply" : "destroy",
      code
    };
  }

  const preview = await runCommand(ocmEnvDestroyPreviewJson(envName), { timeoutMs: 30000 });
  const precondition = summarizeCleanupCommand(preview);
  if (preview.status !== 0) {
    return {
      result: preview,
      precondition,
      stage: "precondition",
      code: cleanupResultCode(preview)
    };
  }

  let previewSummary;
  try {
    previewSummary = JSON.parse(preview.stdout);
  } catch (error) {
    return {
      result: invalidPreconditionResult(preview, `invalid destroy preview JSON: ${error.message}`),
      precondition,
      stage: "precondition",
      code: "invalid_preview"
    };
  }

  const previewError = validateDestroyPreview(previewSummary);
  if (previewError) {
    return {
      result: invalidPreconditionResult(preview, previewError),
      precondition,
      stage: "precondition",
      code: "unsafe_preview"
    };
  }

  const stateRevision = previewSummary.stateToken;
  if (typeof stateRevision !== "string" || stateRevision.length === 0) {
    return {
      result: invalidPreconditionResult(preview, "destroy preview did not return a stateToken"),
      precondition,
      stage: "precondition",
      code: "invalid_preview"
    };
  }

  let fresh;
  try {
    fresh = await loadCleanupEnvClassification(envName, cutoffMs);
  } catch (error) {
    return {
      result: invalidPreconditionResult(preview, `failed to refresh cleanup eligibility: ${error.message}`),
      precondition,
      stage: "precondition",
      code: "eligibility_refresh_failed"
    };
  }
  if (!fresh) {
    return {
      result: invalidPreconditionResult(preview, "environment no longer appears in OCM inventory"),
      precondition,
      stage: "precondition",
      code: "environment_missing"
    };
  }
  if (!fresh.eligible) {
    return {
      result: invalidPreconditionResult(
        preview,
        `environment is no longer eligible for cleanup: ${fresh.reasons.join(", ")}`
      ),
      precondition,
      stage: "precondition",
      code: "eligibility_changed"
    };
  }

  const result = await runCleanupCommand(
    ocmEnvDestroy(envName, { json: true, stateToken: stateRevision }),
    {
      timeoutMs: 120000,
      // partial_apply means teardown began; a retry needs a fresh preview.
      retryDelaysMs: [0]
    }
  );
  const code = cleanupResultCode(result);
  return {
    result,
    precondition,
    stage: code === "partial_apply" ? "partial-apply" : "destroy",
    code
  };
}

function validateDestroyPreview(summary) {
  const allowedStepKinds = new Set(["service", "processes", "worktree", "env", "snapshots"]);
  if (summary == null || typeof summary !== "object" || Array.isArray(summary)) {
    return "destroy preview did not return an object";
  }
  if (
    typeof summary.serviceInstalled !== "boolean" ||
    typeof summary.serviceLoaded !== "boolean" ||
    typeof summary.serviceRunning !== "boolean" ||
    !Number.isSafeInteger(summary.processCount) ||
    summary.processCount < 0 ||
    !Array.isArray(summary.blockers) ||
    !summary.blockers.every((blocker) => typeof blocker === "string") ||
    !Array.isArray(summary.steps) ||
    !summary.steps.every((step) =>
      step !== null &&
      typeof step === "object" &&
      !Array.isArray(step) &&
      allowedStepKinds.has(step.kind) &&
      typeof step.description === "string" &&
      step.description.length > 0
    )
  ) {
    return "destroy preview did not return complete service, blocker, and teardown state";
  }
  if (summary.blockers.length > 0) {
    return `destroy preview reported blockers: ${summary.blockers.join(", ")}`;
  }
  if (summary.serviceLoaded || summary.serviceRunning) {
    return "destroy preview reported an active service";
  }
  if (summary.processCount > 0 || summary.steps.some((step) => step.kind === "processes")) {
    return "destroy preview reported live processes";
  }
  return null;
}

function summarizeCleanupCommand(result) {
  return {
    command: result.command,
    status: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function invalidPreconditionResult(preview, message) {
  return {
    ...preview,
    status: 1,
    stderr: [preview.stderr, message].filter(Boolean).join("\n")
  };
}

async function loadEnvSummaries() {
  const result = await runCommand(ocmEnvListJson(), { timeoutMs: 30000 });
  if (result.status !== 0) {
    throw new Error(`failed to list OCM envs: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const summaries = JSON.parse(result.stdout);
  if (!Array.isArray(summaries)) {
    throw new Error("ocm env list --json returned unexpected data");
  }
  return summaries;
}

async function loadCleanupEnvClassification(envName, cutoffMs) {
  const summaries = await loadEnvSummaries();
  const summary = summaries.find((candidate) => candidate?.name === envName);
  if (!summary) return null;

  const serviceInventory = await loadServiceInventory();
  const retentionInventory = await loadRetentionInventory();
  return classifyCleanupEnv({
    summary,
    service: serviceInventory.byEnv.get(envName),
    serviceInventoryOk: serviceInventory.ok,
    retained: retentionInventory.envNames.has(envName),
    retentionInventoryOk: retentionInventory.ok,
    cutoffMs,
    force: false
  });
}

function cleanupResultCode(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed?.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
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
    const byEnv = new Map();
    for (const service of parsed.services) {
      const error = validateServiceInventoryRecord(service);
      if (error) throw new Error(error);
      if (byEnv.has(service.envName)) {
        throw new Error(`duplicate service envName: ${service.envName}`);
      }
      byEnv.set(service.envName, service);
    }
    return {
      ok: true,
      error: null,
      byEnv
    };
  } catch (error) {
    return {
      ok: false,
      error: `invalid service status JSON: ${error.message}`,
      byEnv: new Map()
    };
  }
}

function validateServiceInventoryRecord(service) {
  if (service === null || typeof service !== "object" || Array.isArray(service)) {
    return "services array contains an invalid record";
  }
  if (typeof service.envName !== "string" || service.envName.length === 0) {
    return "service record is missing envName";
  }
  if (
    typeof service.installed !== "boolean" ||
    typeof service.desiredRunning !== "boolean" ||
    typeof service.running !== "boolean" ||
    typeof service.gatewayState !== "string" ||
    service.gatewayState.length === 0
  ) {
    return `service record for ${service.envName} is incomplete`;
  }
  if (
    service.childPid !== null &&
    (!Number.isSafeInteger(service.childPid) || service.childPid <= 0)
  ) {
    return `service record for ${service.envName} has invalid childPid`;
  }
  if (service.issue !== undefined && service.issue !== null && typeof service.issue !== "string") {
    return `service record for ${service.envName} has invalid issue`;
  }
  return null;
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
      if (
        report === null ||
        typeof report !== "object" ||
        Array.isArray(report) ||
        !Array.isArray(report.records)
      ) {
        throw new Error("records array missing");
      }
      for (const record of report.records) {
        if (record === null || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("records array contains an invalid record");
        }
        if (record.cleanup === "retained") {
          if (typeof record.envName !== "string" || record.envName.length === 0) {
            throw new Error("retained record is missing envName");
          }
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
  const serviceKnown = serviceInventoryOk && service !== undefined && service.issue == null;
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
