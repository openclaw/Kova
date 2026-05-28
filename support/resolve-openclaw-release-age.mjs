#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const AGE_DAYS = {
  day: 1,
  "day-ago": 1,
  week: 7,
  "week-ago": 7,
  month: 30,
  "month-ago": 30
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const days = resolveDays(options);
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`invalid --now date: ${options.now}`);
  }
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const timeMap = await loadTimeMap(options);
  const version = resolveVersionAtOrBefore(timeMap, cutoff);
  if (!version) {
    throw new Error(`no ${options.packageName} version found at or before ${cutoff.toISOString()}`);
  }

  if (options.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.openclawReleaseAge.v1",
      packageName: options.packageName,
      age: options.age ?? null,
      days,
      now: now.toISOString(),
      cutoff: cutoff.toISOString(),
      version,
      publishedAt: timeMap[version]
    }, null, 2));
    return;
  }
  console.log(version);
}

function parseArgs(args) {
  const options = {
    packageName: "openclaw",
    registryUrl: "https://registry.npmjs.org/openclaw",
    age: null,
    days: null,
    now: null,
    timeFile: process.env.KOVA_OPENCLAW_VERSION_TIMES_PATH || null,
    json: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--age" || arg === "--days" || arg === "--now" || arg === "--package" || arg === "--registry-url" || arg === "--time-file") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--age") options.age = value;
      if (arg === "--days") options.days = value;
      if (arg === "--now") options.now = value;
      if (arg === "--package") options.packageName = value;
      if (arg === "--registry-url") options.registryUrl = value;
      if (arg === "--time-file") options.timeFile = value;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function resolveDays(options) {
  if (options.days !== null) {
    const days = Number(options.days);
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("--days must be a positive integer");
    }
    return days;
  }
  const age = String(options.age ?? "").trim();
  if (!age || !(age in AGE_DAYS)) {
    throw new Error("--age must be one of day, week, month or pass --days <n>");
  }
  return AGE_DAYS[age];
}

async function loadTimeMap(options) {
  if (options.timeFile) {
    const parsed = JSON.parse(await readFile(options.timeFile, "utf8"));
    return parsed.time && typeof parsed.time === "object" ? parsed.time : parsed;
  }
  const response = await fetch(options.registryUrl, {
    headers: {
      "accept": "application/json",
      "user-agent": "kova-release-age-resolver"
    }
  });
  if (!response.ok) {
    throw new Error(`npm registry request failed: HTTP ${response.status}`);
  }
  const manifest = await response.json();
  if (!manifest.time || typeof manifest.time !== "object") {
    throw new Error("npm registry manifest did not include a time map");
  }
  return manifest.time;
}

function resolveVersionAtOrBefore(timeMap, cutoff) {
  const cutoffMs = cutoff.getTime();
  return Object.entries(timeMap)
    .filter(([version]) => version !== "created" && version !== "modified")
    .map(([version, publishedAt]) => ({ version, publishedAt, time: new Date(publishedAt).getTime() }))
    .filter((entry) => Number.isFinite(entry.time) && entry.time <= cutoffMs)
    .sort((left, right) => right.time - left.time || compareVersionsDesc(left.version, right.version))[0]?.version ?? null;
}

function compareVersionsDesc(left, right) {
  return right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" });
}

main().catch((error) => {
  console.error(`kova release age resolver: ${error.message}`);
  process.exitCode = 1;
});
