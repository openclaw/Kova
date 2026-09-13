import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { buildReportSummary } from "../reporting/report.mjs";

export function selfCheckPath(...parts) {
  return join(repoRoot, ...parts);
}

export async function readSelfCheckJson(...parts) {
  return JSON.parse(await readFile(selfCheckPath(...parts), "utf8"));
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

export function restoreEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    restoreOptionalEnv(key, value);
  }
}

function restoreOptionalEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

export async function commandCheck(id, command) {
  const result = await runCommand(command, { timeoutMs: 30000 });
  return {
    id,
    status: result.status === 0 ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status === 0 ? "" : result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
  };
}

export async function syntaxCheck() {
  const files = [
    selfCheckPath("bin", "kova.mjs"),
    ...(await listModuleFiles(selfCheckPath("src")))
  ];
  const workerCount = Math.min(8, files.length);
  const failures = [];
  const startedAt = Date.now();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < files.length) {
      const file = files[nextIndex];
      nextIndex += 1;
      const result = await runCommand(`node --check ${quoteShell(file)}`, { timeoutMs: 30000 });
      if (result.status !== 0) {
        failures.push({
          file: relative(repoRoot, file),
          message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  failures.sort((left, right) => left.file.localeCompare(right.file));
  return {
    id: "syntax",
    status: failures.length === 0 ? "PASS" : "FAIL",
    command: `node --check (${files.length} files, ${workerCount} workers)`,
    durationMs: Date.now() - startedAt,
    message: failures.map((failure) => `${failure.file}: ${failure.message}`).join("\n")
  };
}

async function listModuleFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listModuleFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

export async function failingCommandCheck(id, command, expectedMessage) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id,
    status: result.status !== 0 && output.includes(expectedMessage) ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes(expectedMessage)
      ? ""
      : `expected failure containing ${JSON.stringify(expectedMessage)}, got status ${result.status}: ${output.trim()}`
  };
}

export async function jsonFailureCommandCheck(id, command, expectedMessage) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    const data = JSON.parse(result.stderr);
    assertEqual(result.status !== 0, true, "JSON failure exits nonzero");
    assertEqual(data.schemaVersion, "kova.error.v1", "JSON error schema");
    assertEqual(data.ok, false, "JSON error status");
    assertEqual(data.error?.message, expectedMessage, "JSON error message");
    return {
      id,
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function jsonCommandCheck(id, command, validate) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  if (result.status !== 0) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    await validate(data);
    return {
      id,
      status: "PASS",
      command,
      durationMs: result.durationMs,
      data
    };
  } catch (error) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function inlineCheck(id, validate) {
  const startedAt = Date.now();
  try {
    await validate();
    return {
      id,
      status: "PASS",
      command: "inline self-check",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      id,
      status: "FAIL",
      command: "inline self-check",
      durationMs: Date.now() - startedAt,
      message: error.message
    };
  }
}

export async function assertPathMissing(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label}: ${path} still exists`);
}

export function validateReport(report) {
  try {
    assertEqual(report.schemaVersion, "kova.report.v1", "report schema");
    assertEqual(report.mode, "dry-run", "report mode");
    assertEqual(report.summary?.statuses?.["DRY-RUN"], 2, "report dry-run count");
    assertEqual(Object.hasOwn(report, "resolvedCoverage"), false, "report does not include planner-only resolved coverage");
    assertEqual(report.performance?.repeat, 2, "report repeat count");
    assertEqual(report.performance?.groupCount, 1, "report performance group count");
    assertArrayNotEmpty(report.records, "report records");
    const ledger = report.records[0]?.evidenceLedger;
    assertEqual(ledger?.schemaVersion, "kova.evidenceLedger.v1", "evidence ledger schema");
    assertEqual(ledger?.completeness, "not-evaluated", "evidence ledger initial completeness");
    assertEqual((ledger?.summary?.required ?? 0) > 0, true, "evidence ledger required command entries");
    assertEqual(ledger?.summary?.byStatus?.skipped > 0, true, "dry-run command ledger entries are skipped");
    assertArrayNotEmpty(ledger?.entries, "evidence ledger entries");
    const summary = buildReportSummary(report);
    assertEqual(summary.proof?.requiredTotal > 0, true, "summary proof required total");
    assertEqual(summary.proof?.completeness?.["not-evaluated"] > 0, true, "summary proof dry-run completeness");
    const dirs = report.records[0]?.collectorArtifactDirs;
    assertEqual(dirs?.schemaVersion, "kova.collectorArtifactDirs.v1", "collector artifact dirs schema");
    assertString(dirs?.resourceSamples, "collector resource samples dir");
    assertString(dirs?.openclaw, "collector OpenClaw dir");
    assertString(dirs?.nodeProfiles, "collector node profiles dir");
    return {
      id: "dry-run-report-file",
      status: "PASS",
      command: "read generated JSON report",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "dry-run-report-file",
      status: "FAIL",
      command: "read generated JSON report",
      durationMs: 0,
      message: error.message
    };
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

export function assertArrayNotEmpty(value, label) {
  assertArray(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}
