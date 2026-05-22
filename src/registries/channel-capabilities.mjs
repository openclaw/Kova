import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelPlatformsDir } from "../paths.mjs";
import {
  channelCapabilityCatalogMap,
  channelCapabilityGroups,
  channelCapabilityProofModes,
  loadChannelCapabilityCatalog
} from "./channel-capability-catalog.mjs";
import {
  assertNoShapeErrors,
  requireArray,
  requireKebabId,
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
  const catalogMap = channelCapabilityCatalogMap(await loadChannelCapabilityCatalog());
  return filtered.map((platform) => channelCapabilityFromPlatform(platform, catalogMap));
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

function channelCapabilityFromPlatform(platform, catalogMap) {
  const { claims, schemaVersion, ...channel } = platform;
  return {
    ...channel,
    schemaVersion: "kova.channelCapability.v1",
    capabilities: claims.flatMap((claim) => claim.ids.map((id) => {
      const catalogId = `${claim.group}:${id}`;
      const catalogCapability = catalogMap.get(catalogId);
      return {
        id,
        group: claim.group,
        catalogId,
        title: catalogCapability?.title ?? catalogId,
        requiredLevel: claim.requiredLevel,
        proofModes: claim.proofModes,
        declarationSource: claim.declarationSource
      };
    }))
  };
}

function validateChannelPlatformShape(platform, sourceName = "channel platform") {
  const errors = [];
  requireString(platform, "schemaVersion", errors);
  if (platform?.schemaVersion !== "kova.channelPlatform.v1") {
    errors.push("schemaVersion must be kova.channelPlatform.v1");
  }
  validateChannelBaseShape(platform, errors);
  requireArray(platform, "claims", errors);
  validateClaims(platform, errors);
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
  validateDeterministicShim(channel?.deterministicShim, "deterministicShim", errors);
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

function validateDeterministicShim(value, prefix, errors) {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  for (const key of ["conversationId", "threadId", "replyToId"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) {
      errors.push(`${prefix}.${key} must be a non-empty string when set`);
    }
  }
  if (value.accountId !== undefined && (typeof value.accountId !== "string" || value.accountId.length === 0)) {
    errors.push(`${prefix}.accountId must be a non-empty string when set`);
  }
  if (value.platform !== undefined) {
    validateDeterministicShimPlatform(value.platform, `${prefix}.platform`, errors);
  }
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

function validateDeterministicShimPlatform(value, prefix, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  for (const key of ["replyOptionField", "threadOptionField", "threadTarget"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) {
      errors.push(`${prefix}.${key} must be a non-empty string when set`);
    }
  }
  for (const key of ["replyOptionValue", "threadOptionValue"]) {
    if (value[key] !== undefined && !["string", "number", "boolean"].includes(typeof value[key])) {
      errors.push(`${prefix}.${key} must be a string, number, or boolean when set`);
    }
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

function validateClaims(platform, errors) {
  if (!Array.isArray(platform?.claims)) {
    return;
  }
  if (platform.claims.length === 0) {
    errors.push("claims must not be empty");
    return;
  }

  const declarationSources = new Set(platform.declarationSources ?? []);
  const seen = new Set();
  for (const [index, claim] of platform.claims.entries()) {
    const prefix = `claims[${index}]`;
    requireString(claim, "group", errors, prefix);
    validateKnownValue(claim?.group, channelCapabilityGroups, `${prefix}.group`, errors);
    validateStringArray(claim?.ids, `${prefix}.ids`, errors, { nonEmpty: true });
    requireString(claim, "requiredLevel", errors, prefix);
    validateKnownValue(claim?.requiredLevel, channelCapabilityRequiredLevels, `${prefix}.requiredLevel`, errors);
    validateStringArray(claim?.proofModes, `${prefix}.proofModes`, errors, { nonEmpty: true });
    for (const [proofIndex, mode] of (claim?.proofModes ?? []).entries()) {
      validateKnownValue(mode, channelCapabilityProofModes, `${prefix}.proofModes[${proofIndex}]`, errors);
    }
    requireString(claim, "declarationSource", errors, prefix);
    if (typeof claim?.declarationSource === "string" && !declarationSources.has(claim.declarationSource)) {
      errors.push(`${prefix}.declarationSource must reference declarationSources`);
    }

    for (const [idIndex, id] of (claim?.ids ?? []).entries()) {
      validateKebabValue(id, `${prefix}.ids[${idIndex}]`, errors);
      const key = `${claim?.group}:${id}`;
      if (typeof claim?.group === "string" && typeof id === "string") {
        if (seen.has(key)) {
          errors.push(`duplicate claimed capability '${key}'`);
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
