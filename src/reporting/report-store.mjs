import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { reportsDir } from "../paths.mjs";

export async function readReportReference(reference) {
  const path = await resolveReportReference(reference);
  return JSON.parse(await readFile(path, "utf8"));
}

export async function resolveReportReference(reference) {
  if (!reference || typeof reference !== "string") {
    throw new Error("report reference is required");
  }
  if (looksLikePath(reference)) {
    return resolveUserPath(reference);
  }

  const direct = join(reportsDir, `${reference}.json`);
  if (await pathExists(direct)) {
    return direct;
  }

  const candidates = await findReportCandidates(reference);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new Error(`report reference '${reference}' matched multiple reports: ${candidates.map((item) => basename(item, ".json")).join(", ")}`);
  }

  throw new Error(`report '${reference}' was not found in ${reportsDir}`);
}

export async function listStoredReports(options = {}) {
  const limit = positiveLimit(options.limit ?? 20);
  let entries;
  try {
    entries = await readdir(reportsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const reports = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".summary.json")) {
      continue;
    }
    const path = join(reportsDir, entry);
    try {
      const [data, fileStat] = await Promise.all([
        readFile(path, "utf8"),
        stat(path)
      ]);
      const report = JSON.parse(data);
      reports.push({
        runId: report.runId ?? basename(entry, ".json"),
        path,
        generatedAt: report.generatedAt ?? null,
        target: report.target ?? null,
        profile: report.profile?.id ?? report.profile ?? null,
        mode: report.mode ?? null,
        status: reportStatus(report),
        scenarios: report.summary?.total ?? report.records?.length ?? 0,
        mtimeMs: fileStat.mtimeMs
      });
    } catch {
      continue;
    }
  }

  reports.sort((left, right) => (Date.parse(right.generatedAt ?? "") || right.mtimeMs) - (Date.parse(left.generatedAt ?? "") || left.mtimeMs));
  return reports.slice(0, limit);
}

export function resolveUserPath(path) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(process.cwd(), path);
}

function looksLikePath(reference) {
  return reference.includes("/") || reference.startsWith(".") || reference.startsWith("~") || reference.endsWith(".json");
}

async function findReportCandidates(reference) {
  let entries;
  try {
    entries = await readdir(reportsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".summary.json"))
    .filter((entry) => {
      const id = basename(entry, ".json");
      return id === reference || id.startsWith(`${reference}-`);
    })
    .map((entry) => join(reportsDir, entry));
}

async function pathExists(path) {
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

function reportStatus(report) {
  if (report.gate?.verdict) {
    return report.gate.verdict;
  }
  const statuses = report.summary?.statuses ?? {};
  if ((statuses.FAIL ?? 0) > 0) return "FAIL";
  if ((statuses.BLOCKED ?? 0) > 0) return "BLOCKED";
  if ((statuses.INCOMPLETE ?? 0) > 0) return "INCOMPLETE";
  if ((statuses["DRY-RUN"] ?? 0) > 0) return "DRY-RUN";
  if ((statuses.PASS ?? 0) > 0) return "PASS";
  return "UNKNOWN";
}

function positiveLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(parsed, 200);
}
