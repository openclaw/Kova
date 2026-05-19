import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelCapabilitiesDir } from "../paths.mjs";
import { assertNoShapeErrors, requireArray, requireKebabId, requireString, validateStringArray } from "./validate.mjs";

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
  "preflight",
  "shared-runtime-smoke",
  "baseline",
  "deterministic-shim",
  "live-smoke",
  "unsupported-fallback"
];

export async function loadChannelCapabilityCatalog(selectedId) {
  return loadChannelCapabilityDocuments({
    schemaVersion: "kova.channelCapabilityCatalog.v1",
    kind: "channel capability catalog",
    selectedId,
    validate: validateChannelCapabilityCatalogShape
  });
}

export async function loadChannelCapabilityDocuments({ schemaVersion, kind, selectedId, validate }) {
  const names = await readdir(channelCapabilitiesDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const items = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(channelCapabilitiesDir, name), "utf8");
    const item = JSON.parse(raw);
    if (item.schemaVersion !== schemaVersion) {
      continue;
    }
    validate(item, name);
    if (ids.has(item.id)) {
      throw new Error(`duplicate ${kind} id '${item.id}' in ${name}`);
    }
    ids.add(item.id);
    items.push(item);
  }

  const filtered = selectedId ? items.filter((item) => item.id === selectedId) : items;
  if (filtered.length === 0) {
    throw new Error(`no ${kind} found for ${selectedId}`);
  }
  return filtered;
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
