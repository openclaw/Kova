#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseSupportArgs, readTimeoutMs } from "../openclaw-runtime.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const channelId = requiredArg(args, "channel");
const tier = args.tier ?? "adapter-shim";
const caseSet = args["case-set"] ?? "declared-workflows";
const continueOnFailure = args["continue-on-failure"] === "true";
const timeoutMs = readTimeoutMs(args["timeout-ms"], 180000);
const artifactPath = join(artifactDir, `channel-conformance-${safeArtifactSegment(channelId)}.json`);

let result;
try {
  const driver = await loadChannelDriver(channelId);
  const channelRegistry = await readJson(join(repoRoot, "channel-capabilities", `${channelId}.json`));
  const workflowCatalog = await readJson(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"));
  const selectedCases = selectWorkflowCases({ channelRegistry, workflowCatalog, caseSet });
  result = {
    ok: false,
    rows: selectedCases.map((workflowCase) => blockedRow(workflowCase, `${channelId} channel conformance runner is not implemented yet`)),
    artifact: {
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId,
      tier,
      caseSet,
      workflowCaseCatalogId: workflowCatalog.id,
      selectedCaseIds: selectedCases.map((workflowCase) => workflowCase.id),
      driverContract: Object.keys(driver).sort(),
      error: `${channelId} channel conformance runner is not implemented yet`
    }
  };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  result = {
    ok: false,
    rows: [],
    artifact: {
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId,
      tier,
      caseSet,
      error: message
    }
  };
}

await mkdir(artifactDir, { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  schemaVersion: "kova.channelCapabilityRun.v1",
  proofMode: "channel-platform-conformance",
  artifactPath,
  ownerArea: `${channelId} adapter/runtime`,
  channelId,
  capabilities: result.rows.map((row) => ({
    channelId,
    group: "workflow",
    capabilityId: row.id,
    required: true,
    status: row.status,
    proofMode: "channel-platform-conformance",
    summary: row.summary,
    reason: row.reason,
    ownerArea: row.ownerArea,
    artifactPath
  }))
}, null, 2)}\n`);

process.exit(result.ok || continueOnFailure ? 0 : 1);

async function loadChannelDriver(id) {
  if (!/^[a-z0-9-]+$/u.test(id)) {
    throw new Error(`invalid channel id: ${id}`);
  }
  const modulePath = join(repoRoot, "support", "channels", id, "driver.mjs");
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(`channel driver '${id}' is unavailable at ${modulePath}: ${error.message}`);
  }
  const required = [
    "startPlatform",
    "configureOpenClaw",
    "startOpenClaw",
    "enqueueUserEvent",
    "enqueueBotEcho",
    "readPlatformCalls",
    "normalizeObservations",
    "stopPlatform"
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") {
      throw new Error(`channel driver '${id}' does not export ${name}()`);
    }
  }
  return mod;
}

function selectWorkflowCases({ channelRegistry, workflowCatalog, caseSet: requestedCaseSet }) {
  const cases = Array.isArray(workflowCatalog?.cases) ? workflowCatalog.cases : [];
  const casesById = new Map(cases.map((workflowCase) => [workflowCase.id, workflowCase]));
  const ids = requestedCaseSet === "declared-workflows"
    ? channelRegistry.workflowCaseIds ?? []
    : requestedCaseSet.split(",").map((id) => id.trim()).filter(Boolean);
  const selected = ids.map((id) => casesById.get(id)).filter(Boolean);
  if (selected.length !== ids.length) {
    const unknown = ids.filter((id) => !casesById.has(id));
    throw new Error(`unknown workflow case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return selected;
}

function blockedRow(workflowCase, reason) {
  return {
    id: workflowCase.id,
    status: "blocked",
    summary: `${workflowCase.id} channel workflow is blocked`,
    reason,
    ownerArea: workflowCase.ownerArea ?? "OpenClaw channel adapter/runtime"
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function safeArtifactSegment(value) {
  return String(value ?? "all").replace(/[^a-zA-Z0-9._-]+/g, "-");
}
