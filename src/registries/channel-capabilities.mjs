import {
  channelCapabilityCatalogMap,
  channelCapabilityGroups,
  channelCapabilityProofModes,
  loadChannelCapabilityDocuments
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
  "experimental",
  "deprecated"
];

export async function loadChannelCapabilities(selectedId) {
  return loadChannelCapabilityDocuments({
    schemaVersion: "kova.channelCapability.v1",
    kind: "channel capability",
    selectedId,
    validate: validateChannelCapabilityShape
  });
}

export function validateChannelCapabilityShape(channel, sourceName = "channel capability") {
  const errors = [];
  requireString(channel, "schemaVersion", errors);
  if (channel?.schemaVersion !== "kova.channelCapability.v1") {
    errors.push("schemaVersion must be kova.channelCapability.v1");
  }
  requireKebabId(channel, "id", errors);
  requireString(channel, "title", errors);
  requireString(channel, "adapterId", errors);
  requireString(channel, "supportStatus", errors);
  validateKnownValue(channel?.supportStatus, channelSupportStatuses, "supportStatus", errors);
  validateAdapterDistribution(channel?.adapterDistribution, "adapterDistribution", errors);
  validateStringArray(channel?.declarationSources, "declarationSources", errors, { nonEmpty: true });
  validateStringArray(channel?.workflowCaseIds, "workflowCaseIds", errors, { optional: true });
  validateWorkflowOverrides(channel?.workflowOverrides, "workflowOverrides", errors);
  validateDeterministicShim(channel?.deterministicShim, "deterministicShim", errors);
  requireArray(channel, "capabilities", errors);
  validateCapabilities(channel, errors);
  assertNoShapeErrors(errors, sourceName);
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
        }
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

function validateWorkflowOverrides(value, prefix, errors) {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  for (const [caseId, override] of Object.entries(value)) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      errors.push(`${prefix}.${caseId} must be an object`);
      continue;
    }
    for (const key of ["visibleDeliveries", "textDeliveryIndex", "mediaDeliveryIndex"]) {
      if (override[key] !== undefined && (!Number.isInteger(override[key]) || override[key] < 0)) {
        errors.push(`${prefix}.${caseId}.${key} must be a non-negative integer when set`);
      }
    }
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

function validateKnownValue(value, allowed, label, errors) {
  if (typeof value === "string" && !allowed.includes(value)) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
  }
}
