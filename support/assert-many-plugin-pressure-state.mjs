#!/usr/bin/env node
import { spawn } from "node:child_process";

const options = parseArgs(process.argv.slice(2));
const expectedIds = Array.from(
  { length: options.expectedCount },
  (_, index) => `kova-plugin-${index}`
);

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

console.log(
  JSON.stringify(
    {
      schemaVersion: "kova.manyPluginPressure.assertion.v1",
      env: options.env,
      expectedCount: options.expectedCount,
      doctorStatus: doctor.status,
      registryStatus: registry.status,
      listStatus: list.status,
      canonicalInstallRecordCount: countExpected(expectedIds, installRecordIds),
      registryPluginCount: countExpected(expectedIds, registryPluginIds),
      listedPluginCount: countExpected(expectedIds, listedPluginIds),
      missingInstallRecords,
      missingRegistryPlugins,
      missingListedPlugins,
      errors: ok
        ? []
        : [
            failureSummary("doctor", doctor),
            failureSummary("registry refresh", registry),
            failureSummary("plugin list", list)
          ].filter(Boolean)
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

function parseArgs(args) {
  const options = {
    env: null,
    expectedCount: 80
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
  return options;
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
