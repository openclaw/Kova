import { channelCapabilityCatalogDir } from "../paths.mjs";
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
  "live-finalizer",
  "native-platform",
  "failure-recovery"
];

export const channelCapabilityProofModes = [
  "baseline",
  "deterministic-shim",
  "live-smoke",
  "unsupported-fallback"
];

export async function loadChannelCapabilityCatalog(selectedId) {
  return loadJsonRegistry({
    dir: channelCapabilityCatalogDir,
    kind: "channel capability catalog",
    selectedId,
    validate: validateChannelCapabilityCatalogShape
  });
}

export function validateChannelCapabilityCatalogShape(catalog, sourceName = "channel capability catalog") {
  const errors = [];
  requireString(catalog, "schemaVersion", errors);
  if (catalog?.schemaVersion !== "kova.channelCapabilityCatalog.v1") {
    errors.push("schemaVersion must be kova.channelCapabilityCatalog.v1");
  }
  requireKebabId(catalog, "id", errors);
  requireString(catalog, "title", errors);
  validateStringArray(catalog?.declarationSources, "declarationSources", errors, { nonEmpty: true });
  requireArray(catalog, "capabilities", errors);
  validateCatalogCapabilities(catalog, errors);
  assertNoShapeErrors(errors, sourceName);
}

export function channelCapabilityCatalogMap(catalogs) {
  const map = new Map();
  for (const catalog of catalogs ?? []) {
    for (const capability of catalog.capabilities ?? []) {
      map.set(`${capability.group}:${capability.id}`, { catalog, capability });
    }
  }
  return map;
}

function validateCatalogCapabilities(catalog, errors) {
  if (!Array.isArray(catalog?.capabilities)) {
    return;
  }
  if (catalog.capabilities.length === 0) {
    errors.push("capabilities must not be empty");
    return;
  }

  const declarationSources = new Set(catalog.declarationSources ?? []);
  const seen = new Set();
  for (const [index, capability] of catalog.capabilities.entries()) {
    const prefix = `capabilities[${index}]`;
    requireKebabId(capability, "id", errors, prefix);
    requireString(capability, "group", errors, prefix);
    validateKnownValue(capability?.group, channelCapabilityGroups, `${prefix}.group`, errors);
    requireString(capability, "title", errors, prefix);
    requireString(capability, "sourceSymbol", errors, prefix);
    requireString(capability, "baselineExpectation", errors, prefix);
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
        errors.push(`duplicate catalog capability '${key}'`);
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
