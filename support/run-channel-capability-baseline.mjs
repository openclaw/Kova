#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDirectGatewayRpcClient,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const capabilityGroup = args.group ?? "all";
const continueOnFailedCapabilities = args["continue-on-failed-capabilities"] === "true";
const artifactPath = join(artifactDir, `channel-capability-baseline-${safeArtifactSegment(capabilityGroup)}.json`);
const catalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "openclaw-message.json"), "utf8"));

async function main() {
  let result;
  let clientHandle = null;
  try {
    const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(envName);
    clientHandle = await openDirectGatewayRpcClient(runtimeContext);
    if (!clientHandle.client) {
      throw new Error(`gateway direct RPC unavailable: ${clientHandle.fallbackReason ?? "unknown"}`);
    }
    await waitForBaselineChannel(clientHandle.client, timeoutMs);
    const baseline = await clientHandle.client.request(
      "kova.channelBaseline.run",
      capabilityGroup === "all" ? {} : { group: capabilityGroup },
      { timeoutMs }
    );
    result = buildResult({
      catalog,
      runtimeContext,
      baseline,
      error: null,
      timeoutMs
    });
  } catch (error) {
    result = buildResult({
      catalog,
      runtimeContext: null,
      baseline: null,
      error,
      timeoutMs
    });
  } finally {
    clientHandle?.client?.close?.();
  }

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "kova.channelCapabilityRun.v1",
    proofMode: "baseline",
    artifactPath,
    ownerArea: "OpenClaw",
    group: capabilityGroup,
    capabilities: result.rows.map((row) => ({
      ...row,
      artifactPath
    }))
  }, null, 2)}\n`);
  process.exit(result.ok || continueOnFailedCapabilities ? 0 : 1);
}

async function waitForBaselineChannel(client, commandTimeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < commandTimeoutMs) {
    try {
      const status = await client.request("kova.channelBaseline.status", {}, { timeoutMs: 5000 });
      if (status?.ok === true) {
        return status;
      }
      lastError = new Error("kova channel baseline plugin registered but channel runtime is not started");
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError ?? new Error("timed out waiting for kova channel baseline runtime");
}

function buildResult({ catalog: catalogValue, runtimeContext, baseline, error, timeoutMs: commandTimeoutMs }) {
  const proofByCapability = new Map((baseline?.proofs ?? []).map((proof) => [`${proof.group}:${proof.capabilityId}`, proof]));
  const runError = error ? error.message : baseline?.error ?? null;
  const rows = [];
  let ok = !runError && baseline?.ok === true;

  for (const capability of baselineCapabilities(catalogValue)) {
    if (capabilityGroup !== "all" && capability.group !== capabilityGroup) {
      continue;
    }
    const proof = proofByCapability.get(`${capability.group}:${capability.id}`) ?? null;
    const status = runError ? "failed" : proof?.status ?? "missing";
    if (status !== "passed") {
      ok = false;
    }
    rows.push({
      channelId: "openclaw",
      group: capability.group,
      capabilityId: capability.id,
      required: true,
      status,
      proofMode: "baseline",
      summary: `OpenClaw runtime channel baseline ${capability.group}/${capability.id}`,
      reason: status === "passed"
        ? null
        : (runError ?? proof?.reason ?? `OpenClaw runtime channel baseline did not emit proof for ${capability.group}/${capability.id}`),
      ownerArea: "OpenClaw"
    });
  }

  return {
    ok,
    rows,
    artifact: {
      schemaVersion: "kova.channelCapabilityBaselineArtifact.v1",
      catalogId: catalogValue.id,
      catalogCapabilityCount: catalogValue.capabilities.length,
      baselineCapabilityCount: baselineCapabilities(catalogValue).length,
      group: capabilityGroup,
      runtimeContext: compactRuntimeContext(runtimeContext),
      timeoutMs: commandTimeoutMs,
      baseline: baseline ? {
        schemaVersion: baseline.schemaVersion ?? null,
        channelId: baseline.channelId ?? null,
        accountId: baseline.accountId ?? null,
        groups: baseline.groups ?? null,
        proofCount: baseline.proofCount ?? baseline.proofs?.length ?? 0,
        passed: (baseline.proofs ?? []).filter((proof) => proof.status === "passed").length,
        failed: (baseline.proofs ?? []).filter((proof) => proof.status === "failed").length,
        missing: (baseline.proofs ?? []).filter((proof) => proof.status === "missing").length,
        outboundRecordCount: baseline.outboundRecords?.length ?? 0,
        deliveryRecordCount: baseline.deliveryRecords?.length ?? 0
      } : null,
      error: runError,
      proofs: baseline?.proofs ?? [],
      outboundRecords: baseline?.outboundRecords ?? [],
      deliveryRecords: baseline?.deliveryRecords ?? [],
      capabilities: rows
    }
  };
}

function baselineCapabilities(catalogValue) {
  return (catalogValue.capabilities ?? []).filter((capability) =>
    (capability.proofModes ?? []).includes("baseline")
  );
}

function safeArtifactSegment(value) {
  return String(value ?? "all").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function compactRuntimeContext(context) {
  if (!context) {
    return null;
  }
  return {
    source: "ocm-env",
    envName: context.envName ?? null,
    packageRoot: context.packageRoot,
    runtime: context.runtime ?? null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

await main();
