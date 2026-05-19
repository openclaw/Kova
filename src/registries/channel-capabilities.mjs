import { channelCapabilitiesDir } from "../paths.mjs";
import {
  assertNoShapeErrors,
  loadJsonRegistry,
  requireArray,
  requireKebabId,
  requireString,
  validateStringArray
} from "./validate.mjs";

export const channelCapabilityGroups = [
  "receive",
  "routing",
  "ack",
  "durable-final",
  "receipt",
  "live-preview",
  "native-platform",
  "failure-recovery"
];

export const channelCapabilityRequiredLevels = [
  "blocking",
  "warning",
  "optional",
  "experimental"
];

export const channelCapabilityProofModes = [
  "baseline",
  "deterministic-shim",
  "live-smoke",
  "unsupported-fallback"
];

export const channelSupportStatuses = [
  "supported",
  "experimental",
  "deprecated"
];

export async function loadChannelCapabilities(selectedId) {
  return loadJsonRegistry({
    dir: channelCapabilitiesDir,
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
  validateStringArray(channel?.declarationSources, "declarationSources", errors, { nonEmpty: true });
  requireArray(channel, "capabilities", errors);
  validateCapabilities(channel, errors);
  assertNoShapeErrors(errors, sourceName);
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
