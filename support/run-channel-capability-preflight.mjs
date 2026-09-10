#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { resolveOcmTransport } from "../src/ocm/transport.mjs";
import {
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";

if (resolveOcmTransport()) throw new Error("cross-user channel preflight cannot import candidate modules");

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const artifactPath = join(artifactDir, "channel-capability-preflight.json");
const catalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "openclaw-message.json"), "utf8"));

let result;
try {
  const runtimeContext = await resolveRuntimeContext(args);
  const probe = await probeRuntimeChannelMessageContracts({
    catalog,
    packageRoot: runtimeContext.packageRoot
  });
  result = buildResult({
    catalog,
    runtimeContext,
    probe,
    error: null,
    timeoutMs
  });
} catch (error) {
  result = buildResult({
    catalog,
    runtimeContext: null,
    probe: null,
    error,
    timeoutMs
  });
}

await mkdir(artifactDir, { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  schemaVersion: "kova.channelCapabilityRun.v1",
  proofMode: "preflight",
  artifactPath,
  ownerArea: "OpenClaw",
  capabilities: result.rows.map((row) => ({
    ...row,
    artifactPath
  }))
}, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);

async function resolveRuntimeContext(parsed) {
  if (parsed["package-root"]) {
    return {
      source: "package-root",
      packageRoot: resolve(parsed["package-root"]),
      runtime: null
    };
  }

  const envName = requiredArg(parsed, "env");
  const context = prepareOpenClawRuntimeFromOcmEnv(envName);
  return {
    source: "ocm-env",
    envName: context.envName,
    root: context.root,
    gatewayPort: context.gatewayPort,
    binaryPath: context.binaryPath,
    packageRoot: context.packageRoot,
    runtime: context.runtime
  };
}

async function probeRuntimeChannelMessageContracts({ catalog: catalogValue, packageRoot }) {
  const channelMessage = await importOpenClawChannelMessage(packageRoot);
  const groups = groupCatalogCapabilities(catalogValue);
  const groupResults = {};

  groupResults["durable-final"] = await proveGroup({
    group: "durable-final",
    capabilities: groups.get("durable-final") ?? [],
    list: channelMessage.listDeclaredDurableFinalCapabilities,
    verify: (capabilities, proofs) => channelMessage.verifyDurableFinalCapabilityProofs({
      adapterName: "Kova OpenClaw preflight",
      capabilities,
      proofs
    })
  });

  groupResults["live-preview"] = await proveGroup({
    group: "live-preview",
    capabilities: groups.get("live-preview") ?? [],
    list: channelMessage.listDeclaredChannelMessageLiveCapabilities,
    verify: (capabilities, proofs) => channelMessage.verifyChannelMessageLiveCapabilityProofs({
      adapterName: "Kova OpenClaw preflight",
      capabilities,
      proofs
    })
  });

  groupResults["live-finalizer"] = await proveGroup({
    group: "live-finalizer",
    capabilities: groups.get("live-finalizer") ?? [],
    list: channelMessage.listDeclaredLivePreviewFinalizerCapabilities,
    verify: (capabilities, proofs) => channelMessage.verifyLivePreviewFinalizerCapabilityProofs({
      adapterName: "Kova OpenClaw preflight",
      capabilities,
      proofs
    })
  });

  groupResults.ack = await proveReceiveAckGroup({
    capabilities: groups.get("ack") ?? [],
    list: channelMessage.listDeclaredReceiveAckPolicies,
    verify: (receive, proofs) => channelMessage.verifyChannelMessageReceiveAckPolicyProofs({
      adapterName: "Kova OpenClaw preflight",
      receive,
      proofs
    })
  });

  return {
    packageRoot,
    exportPath: await resolvePackageExportPath(packageRoot, "./plugin-sdk/channel-message"),
    groupResults
  };
}

async function importOpenClawChannelMessage(packageRoot) {
  const exportPath = await resolvePackageExportPath(packageRoot, "./plugin-sdk/channel-message");
  const mod = await import(pathToFileURL(exportPath).href);
  const requiredExports = [
    "listDeclaredDurableFinalCapabilities",
    "listDeclaredChannelMessageLiveCapabilities",
    "listDeclaredLivePreviewFinalizerCapabilities",
    "listDeclaredReceiveAckPolicies",
    "verifyDurableFinalCapabilityProofs",
    "verifyChannelMessageLiveCapabilityProofs",
    "verifyLivePreviewFinalizerCapabilityProofs",
    "verifyChannelMessageReceiveAckPolicyProofs"
  ];
  const missing = requiredExports.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`openclaw/plugin-sdk/channel-message is missing exports: ${missing.join(", ")}`);
  }
  return mod;
}

async function resolvePackageExportPath(packageRoot, exportName) {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const exportEntry = packageJson.exports?.[exportName];
  const relativePath = typeof exportEntry === "string"
    ? exportEntry
    : exportEntry?.default;
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(`OpenClaw package does not export ${exportName}`);
  }
  return join(packageRoot, relativePath);
}

async function proveGroup({ group, capabilities, list, verify }) {
  const runtimeKeys = capabilities.map(runtimeCapabilityKey);
  const capabilityMap = Object.fromEntries(runtimeKeys.map((key) => [key, true]));
  const proofs = Object.fromEntries(runtimeKeys.map((key) => [key, () => undefined]));
  const expected = capabilities.map((capability) => capability.id);
  const actual = list(capabilityMap).map(kebabValue);
  let verifyError = null;
  try {
    await verify(capabilityMap, proofs);
  } catch (error) {
    verifyError = error.message;
  }
  return compareGroup({ group, expected, actual, verifyError });
}

async function proveReceiveAckGroup({ capabilities, list, verify }) {
  const runtimeKeys = capabilities.map(runtimeCapabilityKey);
  const receive = { supportedAckPolicies: runtimeKeys };
  const proofs = Object.fromEntries(runtimeKeys.map((key) => [key, () => undefined]));
  const expected = capabilities.map((capability) => capability.id);
  const actual = list(receive).map(kebabValue);
  let verifyError = null;
  try {
    await verify(receive, proofs);
  } catch (error) {
    verifyError = error.message;
  }
  return compareGroup({ group: "ack", expected, actual, verifyError });
}

function compareGroup({ group, expected, actual, verifyError }) {
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  return {
    group,
    expected,
    actual,
    missing,
    unexpected,
    verifyError,
    ok: missing.length === 0 && unexpected.length === 0 && !verifyError
  };
}

function buildResult({ catalog: catalogValue, runtimeContext, probe, error, timeoutMs: commandTimeoutMs }) {
  const groups = groupCatalogCapabilities(catalogValue);
  const probeError = error ? error.message : null;
  const groupResults = probe?.groupResults ?? {};
  const rows = [];
  let ok = !probeError;

  for (const [group, capabilities] of groups.entries()) {
    const groupResult = groupResults[group] ?? null;
    if (!groupResult?.ok) {
      ok = false;
    }
    for (const capability of capabilities) {
      const status = rowStatus(capability, groupResult, probeError);
      rows.push({
        channelId: "openclaw",
        group: capability.group,
        capabilityId: capability.id,
        required: true,
        status,
        proofMode: "preflight",
        summary: `OpenClaw runtime preflight ${capability.group}/${capability.id}`,
        reason: status === "passed" ? null : rowReason(capability, groupResult, probeError),
        ownerArea: "OpenClaw"
      });
    }
  }

  return {
    ok,
    rows,
    artifact: {
      schemaVersion: "kova.channelCapabilityPreflightArtifact.v1",
      catalogId: catalogValue.id,
      catalogCapabilityCount: catalogValue.capabilities.length,
      runtimeContext: compactRuntimeContext(runtimeContext),
      timeoutMs: commandTimeoutMs,
      probe: probe ? {
        packageRoot: probe.packageRoot,
        exportPath: probe.exportPath,
        groupResults: probe.groupResults
      } : null,
      error: probeError,
      capabilities: rows
    }
  };
}

function rowStatus(capability, groupResult, probeError) {
  if (probeError || groupResult?.verifyError) {
    return "failed";
  }
  if (!groupResult || groupResult.missing?.includes(capability.id)) {
    return "missing";
  }
  if (groupResult.unexpected?.length > 0) {
    return "failed";
  }
  return "passed";
}

function rowReason(capability, groupResult, probeError) {
  if (probeError) {
    return probeError;
  }
  if (groupResult?.verifyError) {
    return groupResult.verifyError;
  }
  if (!groupResult) {
    return `OpenClaw runtime did not expose ${capability.group} contract helpers`;
  }
  if (groupResult.missing?.includes(capability.id)) {
    return `OpenClaw runtime did not declare expected ${capability.group}/${capability.id}`;
  }
  if (groupResult.unexpected?.length > 0) {
    return `OpenClaw runtime declared unexpected ${capability.group} capabilities: ${groupResult.unexpected.join(", ")}`;
  }
  return null;
}

function groupCatalogCapabilities(catalogValue) {
  const groups = new Map();
  for (const capability of catalogValue.capabilities ?? []) {
    if (!(capability.proofModes ?? []).includes("preflight")) {
      continue;
    }
    const values = groups.get(capability.group) ?? [];
    values.push(capability);
    groups.set(capability.group, values);
  }
  return groups;
}

function runtimeCapabilityKey(capability) {
  const raw = capability.sourceSymbol?.split(".").pop();
  if (raw) {
    return raw;
  }
  if (capability.group === "ack") {
    return capability.id.replaceAll("-", "_");
  }
  return capability.id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function kebabValue(value) {
  return String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replaceAll("_", "-");
}

function compactRuntimeContext(context) {
  if (!context) {
    return null;
  }
  return {
    source: context.source,
    envName: context.envName ?? null,
    packageRoot: context.packageRoot,
    runtime: context.runtime ?? null
  };
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}
