import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelPlatformsDir, channelProofPolicyPath } from "../paths.mjs";
import {
  channelCapabilityCatalogMap,
  channelCapabilityGroups,
  channelCapabilityProofModes,
  loadChannelCapabilityCatalog
} from "./channel-capability-catalog.mjs";
import { loadChannelWorkflowCaseCatalog } from "./channel-workflow-cases.mjs";
import {
  buildChannelWorkflowCoverage,
  workflowSupportedAtomKeysFromPlatformCapabilities
} from "./channel-workflow-coverage.mjs";
import {
  assertNoShapeErrors,
  requireArray,
  requireKebabId,
  requireObject,
  requireString,
  validateStringArray
} from "./validate.mjs";

export const channelCapabilityRequiredLevels = [
  "blocking",
  "warning",
  "optional",
  "experimental"
];

export const channelSupportStatuses = [
  "supported",
  "experimental"
];

export async function loadChannelCapabilities(selectedId) {
  const platforms = await loadChannelPlatforms();
  const filtered = selectedId ? platforms.filter((platform) => platform.id === selectedId) : platforms;
  if (filtered.length === 0) {
    throw new Error(`no channel capability found for ${selectedId}`);
  }
  const [capabilityCatalogs, proofPolicy, workflowCatalogs] = await Promise.all([
    loadChannelCapabilityCatalog(),
    loadChannelProofPolicy(),
    loadChannelWorkflowCaseCatalog()
  ]);
  const catalogMap = channelCapabilityCatalogMap(capabilityCatalogs);
  validateChannelProofPolicyReferences(proofPolicy, capabilityCatalogs);
  const workflowCases = workflowCatalogs.flatMap((catalog) => catalog.cases ?? []);
  return filtered.map((platform) => channelCapabilityFromPlatform(platform, catalogMap, proofPolicy, workflowCases));
}

async function loadChannelPlatforms() {
  const names = await readdir(channelPlatformsDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const items = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(channelPlatformsDir, name), "utf8");
    const item = JSON.parse(raw);
    validateChannelPlatformShape(item, name);
    if (ids.has(item.id)) {
      throw new Error(`duplicate channel platform id '${item.id}' in ${name}`);
    }
    ids.add(item.id);
    items.push(item);
  }

  return items;
}

async function loadChannelProofPolicy() {
  const raw = await readFile(channelProofPolicyPath, "utf8");
  const policy = JSON.parse(raw);
  validateChannelProofPolicyShape(policy, "proof-policy.json");
  return policy;
}

function channelCapabilityFromPlatform(platform, catalogMap, proofPolicy, workflowCases) {
  const { adapter, capabilities: platformCapabilities, schemaVersion, sources, ...channel } = platform;
  const workflowCoverage = buildChannelWorkflowCoverage({
    channelId: platform.id,
    supportedAtomKeys: workflowSupportedAtomKeysFromPlatformCapabilities(platformCapabilities),
    workflowCases
  });
  const capabilityRows = platformCapabilityEntries(platformCapabilities).map(({ group, id }) => {
    const catalogId = `${group}:${id}`;
    const catalogCapability = catalogMap.get(catalogId);
    const proof = proofPolicyForCapability(proofPolicy, catalogId);
    return {
      id,
      group,
      catalogId,
      title: catalogCapability?.capability?.title ?? catalogId,
      requiredLevel: proof.requiredLevel,
      proofModes: proof.proofModes,
      declarationSource: declarationSourceFor(platform, group)
    };
  });

  return {
    ...channel,
    schemaVersion: "kova.channelCapability.v1",
    adapterId: platform.id,
    supportStatus: "supported",
    adapterDistribution: adapter,
    declarationSources: sources,
    workflowCoverage,
    workflowCaseIds: workflowCoverage.selected.map((testCase) => testCase.id),
    capabilities: capabilityRows
  };
}

function validateChannelPlatformShape(platform, sourceName = "channel platform") {
  const errors = [];
  requireString(platform, "schemaVersion", errors);
  if (platform?.schemaVersion !== "kova.channelPlatform.v1") {
    errors.push("schemaVersion must be kova.channelPlatform.v1");
  }
  requireKebabId(platform, "id", errors);
  requireString(platform, "title", errors);
  validateAdapterDistribution(platform?.adapter, "adapter", errors);
  validateStringArray(platform?.sources, "sources", errors, { nonEmpty: true });
  requireObject(platform, "capabilities", errors);
  validatePlatformCapabilities(platform, errors);
  assertNoShapeErrors(errors, sourceName);
}

export function validateChannelCapabilityShape(channel, sourceName = "channel capability") {
  const errors = [];
  requireString(channel, "schemaVersion", errors);
  if (channel?.schemaVersion !== "kova.channelCapability.v1") {
    errors.push("schemaVersion must be kova.channelCapability.v1");
  }
  validateChannelBaseShape(channel, errors);
  requireArray(channel, "capabilities", errors);
  validateCapabilities(channel, errors);
  assertNoShapeErrors(errors, sourceName);
}

function validateChannelBaseShape(channel, errors) {
  requireKebabId(channel, "id", errors);
  requireString(channel, "title", errors);
  requireString(channel, "adapterId", errors);
  requireString(channel, "supportStatus", errors);
  validateKnownValue(channel?.supportStatus, channelSupportStatuses, "supportStatus", errors);
  validateAdapterDistribution(channel?.adapterDistribution, "adapterDistribution", errors);
  validateStringArray(channel?.declarationSources, "declarationSources", errors, { nonEmpty: true });
  validateStringArray(channel?.workflowCaseIds, "workflowCaseIds", errors, { optional: true });
}

export function validateChannelCapabilityCatalogReferences(channels, catalogs) {
  const catalogMap = channelCapabilityCatalogMap(catalogs);
  const errors = [];
  for (const channel of channels ?? []) {
    for (const capability of channel.capabilities ?? []) {
      const expectedCatalogId = `${capability.group}:${capability.id}`;
      if (capability.catalogId !== expectedCatalogId) {
        errors.push(`${channel.id}.${capability.group}:${capability.id} catalogId must be ${expectedCatalogId}`);
      }
      if (!catalogMap.has(expectedCatalogId)) {
        errors.push(`${channel.id}.${expectedCatalogId} is not defined in the OpenClaw channel capability catalog`);
      }
    }
  }
  assertNoShapeErrors(errors, "channel capability catalog references");
}

export function validateChannelProofPolicyReferences(policy, catalogs) {
  const catalogMap = channelCapabilityCatalogMap(catalogs);
  const errors = [];
  for (const field of ["blockingCapabilities", "liveSmokeCapabilities"]) {
    for (const key of policy?.[field] ?? []) {
      if (!catalogMap.has(key)) {
        errors.push(`${field} references unknown channel capability '${key}'`);
      }
    }
  }
  assertNoShapeErrors(errors, "channel proof policy references");
}

export function validateChannelCapabilityWorkflowReferences(channels, workflowCatalogs) {
  const workflowCaseMap = new Map();
  for (const catalog of workflowCatalogs ?? []) {
    for (const testCase of catalog.cases ?? []) {
      workflowCaseMap.set(testCase.id, testCase);
    }
  }

  const errors = [];
  for (const channel of channels ?? []) {
    const supportedAtoms = new Set((channel.capabilities ?? []).map((capability) => `${capability.group}:${capability.id}`));
    const provenAtoms = new Set();
    const seen = new Set();
    for (const caseId of channel.workflowCaseIds ?? []) {
      if (seen.has(caseId)) {
        errors.push(`${channel.id}.workflowCaseIds duplicates '${caseId}'`);
        continue;
      }
      seen.add(caseId);
      const testCase = workflowCaseMap.get(caseId);
      if (!testCase) {
        errors.push(`${channel.id}.workflowCaseIds references unknown channel workflow case '${caseId}'`);
        continue;
      }
      for (const atom of testCase.atoms ?? []) {
        if (atom.group === "workflow") {
          continue;
        }
        const key = `${atom.group}:${atom.id}`;
        if (!supportedAtoms.has(key)) {
          errors.push(`${channel.id}.workflowCaseIds '${caseId}' requires unsupported adapter atom ${key}`);
          continue;
        }
        provenAtoms.add(key);
      }
    }
    for (const capability of channel.capabilities ?? []) {
      if (capability.requiredLevel !== "blocking") {
        continue;
      }
      const key = `${capability.group}:${capability.id}`;
      if (!provenAtoms.has(key)) {
        errors.push(`${channel.id}.${key} is blocking but has no declared runtime workflow proof`);
      }
    }
  }

  assertNoShapeErrors(errors, "channel capability workflow references");
}

function validateAdapterDistribution(value, prefix, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  requireString(value, "kind", errors, prefix);
  validateKnownValue(value?.kind, ["bundled", "external"], `${prefix}.kind`, errors);
  requireString(value, "modulePath", errors, prefix);
  requireString(value, "exportName", errors, prefix);
  if (value.kind === "external") {
    requireString(value, "packageName", errors, prefix);
    requireString(value, "pluginId", errors, prefix);
    requireString(value, "localBuildPath", errors, prefix);
  }
}

function validateCapabilities(channel, errors) {
  if (!Array.isArray(channel?.capabilities)) {
    return;
  }
  if (channel.capabilities.length === 0) {
    errors.push("capabilities must not be empty");
    return;
  }

  const declarationSources = new Set(channel.declarationSources ?? []);
  const seen = new Set();
  for (const [index, capability] of channel.capabilities.entries()) {
    const prefix = `capabilities[${index}]`;
    requireKebabId(capability, "id", errors, prefix);
    requireString(capability, "group", errors, prefix);
    validateKnownValue(capability?.group, channelCapabilityGroups, `${prefix}.group`, errors);
    requireString(capability, "catalogId", errors, prefix);
    requireString(capability, "title", errors, prefix);
    requireString(capability, "requiredLevel", errors, prefix);
    validateKnownValue(capability?.requiredLevel, channelCapabilityRequiredLevels, `${prefix}.requiredLevel`, errors);
    validateStringArray(capability?.proofModes, `${prefix}.proofModes`, errors, { nonEmpty: true });
    for (const [proofIndex, mode] of (capability?.proofModes ?? []).entries()) {
      validateKnownValue(mode, channelCapabilityProofModes, `${prefix}.proofModes[${proofIndex}]`, errors);
    }
    requireString(capability, "declarationSource", errors, prefix);
    if (typeof capability?.declarationSource === "string" && !declarationSources.has(capability.declarationSource)) {
      errors.push(`${prefix}.declarationSource must reference declarationSources`);
    }
    const key = `${capability?.group}:${capability?.id}`;
    if (typeof capability?.group === "string" && typeof capability?.id === "string") {
      if (seen.has(key)) {
        errors.push(`duplicate capability '${key}'`);
      }
      seen.add(key);
    }
  }
}

function validatePlatformCapabilities(platform, errors) {
  if (!platform?.capabilities || typeof platform.capabilities !== "object" || Array.isArray(platform.capabilities)) {
    return;
  }
  const entries = Object.entries(platform.capabilities);
  if (entries.length === 0) {
    errors.push("capabilities must not be empty");
    return;
  }

  const seen = new Set();
  for (const [group, ids] of entries) {
    validateKnownValue(group, channelCapabilityGroups, `capabilities.${group}`, errors);
    validateStringArray(ids, `capabilities.${group}`, errors, { nonEmpty: true });
    for (const [idIndex, id] of (Array.isArray(ids) ? ids : []).entries()) {
      validateKebabValue(id, `capabilities.${group}[${idIndex}]`, errors);
      const key = `${group}:${id}`;
      if (typeof id === "string") {
        if (seen.has(key)) {
          errors.push(`duplicate platform capability '${key}'`);
        }
        seen.add(key);
      }
    }
  }
}

function validateKnownValue(value, allowed, label, errors) {
  if (typeof value === "string" && !allowed.includes(value)) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
  }
}

function validateKebabValue(value, label, errors) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    errors.push(`${label} must be a kebab id`);
  }
}

function validateChannelProofPolicyShape(policy, sourceName = "channel proof policy") {
  const errors = [];
  requireString(policy, "schemaVersion", errors);
  if (policy?.schemaVersion !== "kova.channelProofPolicy.v1") {
    errors.push("schemaVersion must be kova.channelProofPolicy.v1");
  }
  requireKebabId(policy, "id", errors);
  requireString(policy, "defaultRequiredLevel", errors);
  validateKnownValue(policy?.defaultRequiredLevel, channelCapabilityRequiredLevels, "defaultRequiredLevel", errors);
  validateStringArray(policy?.defaultProofModes, "defaultProofModes", errors, { nonEmpty: true });
  validateStringArray(policy?.blockingCapabilities, "blockingCapabilities", errors, { nonEmpty: true });
  validateStringArray(policy?.liveSmokeCapabilities, "liveSmokeCapabilities", errors, { nonEmpty: true });
  for (const [index, mode] of (policy?.defaultProofModes ?? []).entries()) {
    validateKnownValue(mode, channelCapabilityProofModes, `defaultProofModes[${index}]`, errors);
  }
  for (const key of [
    ...(policy?.blockingCapabilities ?? []),
    ...(policy?.liveSmokeCapabilities ?? [])
  ]) {
    validateCapabilityKey(key, errors);
  }
  assertNoShapeErrors(errors, sourceName);
}

function validateCapabilityKey(key, errors) {
  if (typeof key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
    errors.push(`capability key '${key}' must be group:id`);
  }
}

function platformCapabilityEntries(capabilities) {
  return Object.entries(capabilities ?? {}).flatMap(([group, ids]) =>
    (Array.isArray(ids) ? ids : []).map((id) => ({ group, id }))
  );
}

function proofPolicyForCapability(policy, catalogId) {
  const blocking = new Set(policy.blockingCapabilities ?? []);
  const liveSmoke = new Set(policy.liveSmokeCapabilities ?? []);
  return {
    requiredLevel: blocking.has(catalogId) ? "blocking" : policy.defaultRequiredLevel,
    proofModes: uniqueOrdered([
      ...(policy.defaultProofModes ?? []),
      ...(liveSmoke.has(catalogId) ? ["live-smoke"] : [])
    ])
  };
}

function declarationSourceFor(platform, group) {
  const sources = platform.sources ?? [];
  if (group === "durable-final") {
    return sourceIncluding(sources, "outbound-adapter.ts") ?? sources[0];
  }
  if (group === "native-platform") {
    return sourceIncluding(sources, "channel-actions.contract.test.ts")
      ?? sourceIncluding(sources, "channel-actions.ts")
      ?? sources[0];
  }
  return sourceIncluding(sources, "channel.ts") ?? sources[0];
}

function sourceIncluding(sources, segment) {
  return sources.find((source) => source.includes(segment));
}

function uniqueOrdered(values) {
  return [...new Set(values)];
}
