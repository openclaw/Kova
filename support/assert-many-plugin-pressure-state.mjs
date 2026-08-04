#!/usr/bin/env node
import { spawn } from "node:child_process";

const DEFAULT_MINIMUM_OPENCLAW_VERSION = "2026.6.1";
const options = parseArgs(process.argv.slice(2));
const expectedIds = Array.from(
  { length: options.expectedCount },
  (_, index) => `kova-plugin-${index}`
);

const version = await runProcess("ocm", [`@${options.env}`, "--", "--version"]);
const openclawVersion = parseOpenClawVersion(`${version.stdout}\n${version.stderr}`);

if (version.status !== 0) {
  finish({
    ok: false,
    failureDomain: "openclaw",
    recordStatus: "FAIL",
    error: failureSummary("OpenClaw version", version),
    versionStatus: version.status,
    openclawVersion,
    minimumOpenClawVersion: options.minimumOpenClawVersion,
    doctorStatus: null,
    registryStatus: null,
    listStatus: null
  });
}

if (!openclawVersion) {
  finish({
    ok: false,
    failureDomain: "kova-harness",
    recordStatus: "BLOCKED",
    error: "could not determine the target OpenClaw version",
    versionStatus: version.status,
    openclawVersion: null,
    minimumOpenClawVersion: options.minimumOpenClawVersion,
    doctorStatus: null,
    registryStatus: null,
    listStatus: null
  });
}

if (compareCalendarVersions(openclawVersion, options.minimumOpenClawVersion) < 0) {
  finish({
    ok: false,
    failureDomain: "kova-harness",
    recordStatus: "BLOCKED",
    error: `many-bundled-plugins requires OpenClaw >= ${options.minimumOpenClawVersion}; target reports ${openclawVersion}`,
    versionStatus: version.status,
    openclawVersion,
    minimumOpenClawVersion: options.minimumOpenClawVersion,
    doctorStatus: null,
    registryStatus: null,
    listStatus: null
  });
}

if (options.versionOnly) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: "kova.manyPluginPressure.assertion.v1",
        ok: true,
        failureDomain: null,
        recordStatus: null,
        error: null,
        env: options.env,
        expectedCount: options.expectedCount,
        versionStatus: version.status,
        openclawVersion,
        minimumOpenClawVersion: options.minimumOpenClawVersion,
        doctorStatus: null,
        registryStatus: null,
        listStatus: null,
        canonicalInstallRecordCount: 0,
        registryPluginCount: 0,
        listedPluginCount: 0,
        missingInstallRecords: [],
        missingRegistryPlugins: [],
        missingListedPlugins: [],
        errors: []
      },
      null,
      2
    )
  );
  process.exit(0);
}

const doctor = await runProcess("ocm", [
  `@${options.env}`,
  "--",
  "doctor",
  "--fix",
  "--non-interactive"
]);
const registry = doctor.status === 0
  ? await runProcess("ocm", [
      `@${options.env}`,
      "--",
      "plugins",
      "registry",
      "--refresh",
      "--json"
    ])
  : skippedResult();
const list = registry.status === 0
  ? await runProcess("ocm", [`@${options.env}`, "--", "plugins", "list", "--json"])
  : skippedResult();

const registryPayload = parseJsonPayload(registry.stdout);
const listPayload = parseJsonPayload(list.stdout);
const installRecordIds = Object.keys(registryPayload?.registry?.installRecords ?? {});
const registryPluginIds = (registryPayload?.registry?.plugins ?? [])
  .map((plugin) => plugin?.pluginId)
  .filter(Boolean);
const listedPluginIds = (listPayload?.plugins ?? []).map((plugin) => plugin?.id).filter(Boolean);
const missingInstallRecords = missingIds(expectedIds, installRecordIds);
const missingRegistryPlugins = missingIds(expectedIds, registryPluginIds);
const missingListedPlugins = missingIds(expectedIds, listedPluginIds);
const ok =
  doctor.status === 0 &&
  registry.status === 0 &&
  list.status === 0 &&
  missingInstallRecords.length === 0 &&
  missingRegistryPlugins.length === 0 &&
  missingListedPlugins.length === 0;
const errors = ok
  ? []
  : [
      failureSummary("doctor", doctor),
      failureSummary("registry refresh", registry),
      failureSummary("plugin list", list)
    ].filter(Boolean);

console.log(
  JSON.stringify(
    {
      schemaVersion: "kova.manyPluginPressure.assertion.v1",
      ok,
      failureDomain: ok ? null : "openclaw",
      recordStatus: ok ? null : "FAIL",
      error: errors[0] ?? null,
      env: options.env,
      expectedCount: options.expectedCount,
      versionStatus: version.status,
      openclawVersion,
      minimumOpenClawVersion: options.minimumOpenClawVersion,
      doctorStatus: doctor.status,
      registryStatus: registry.status,
      listStatus: list.status,
      canonicalInstallRecordCount: countExpected(expectedIds, installRecordIds),
      registryPluginCount: countExpected(expectedIds, registryPluginIds),
      listedPluginCount: countExpected(expectedIds, listedPluginIds),
      missingInstallRecords,
      missingRegistryPlugins,
      missingListedPlugins,
      errors
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

function parseArgs(args) {
  const options = {
    env: null,
    expectedCount: 80,
    minimumOpenClawVersion: DEFAULT_MINIMUM_OPENCLAW_VERSION,
    versionOnly: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env") {
      options.env = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--expected-count") {
      options.expectedCount = Number.parseInt(args[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === "--minimum-openclaw-version") {
      options.minimumOpenClawVersion = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--version-only") {
      options.versionOnly = true;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(String(options.env ?? ""))) {
    throw new Error(`--env must be a disposable Kova env, got ${JSON.stringify(options.env)}`);
  }
  if (
    !Number.isInteger(options.expectedCount) ||
    options.expectedCount <= 0 ||
    options.expectedCount > 500
  ) {
    throw new Error("--expected-count must be an integer between 1 and 500");
  }
  if (!parseCalendarVersion(options.minimumOpenClawVersion)) {
    throw new Error("--minimum-openclaw-version must use YYYY.M.D");
  }
  return options;
}

function finish(result) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: "kova.manyPluginPressure.assertion.v1",
        env: options.env,
        expectedCount: options.expectedCount,
        canonicalInstallRecordCount: 0,
        registryPluginCount: 0,
        listedPluginCount: 0,
        missingInstallRecords: [],
        missingRegistryPlugins: [],
        missingListedPlugins: [],
        errors: result.error ? [result.error] : [],
        ...result
      },
      null,
      2
    )
  );
  process.exit(1);
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ status: 127, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

function skippedResult() {
  return { status: 1, stdout: "", stderr: "skipped because a prerequisite command failed" };
}

function parseJsonPayload(output) {
  const text = String(output ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function missingIds(expected, actual) {
  const actualIds = new Set(actual);
  return expected.filter((id) => !actualIds.has(id));
}

function countExpected(expected, actual) {
  const actualIds = new Set(actual);
  return expected.filter((id) => actualIds.has(id)).length;
}

function parseOpenClawVersion(value) {
  const match = String(value ?? "").match(/\b(\d{4}\.\d{1,2}\.\d{1,2})(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[1] ?? null;
}

function parseCalendarVersion(value) {
  const match = String(value ?? "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  return match ? match.slice(1).map((part) => Number.parseInt(part, 10)) : null;
}

function compareCalendarVersions(left, right) {
  const leftParts = parseCalendarVersion(left);
  const rightParts = parseCalendarVersion(right);
  if (!leftParts || !rightParts) {
    throw new Error(`cannot compare OpenClaw versions ${JSON.stringify(left)} and ${JSON.stringify(right)}`);
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function failureSummary(label, result) {
  if (result.status === 0) {
    return null;
  }
  const detail = firstNonEmptyLine(`${result.stderr}\n${result.stdout}`);
  return `${label} exited ${result.status}${detail ? `: ${detail}` : ""}`;
}

function firstNonEmptyLine(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}
