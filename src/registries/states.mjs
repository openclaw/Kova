import { statesDir } from "../paths.mjs";
import { validateCollectionIntent } from "../collection-contract.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireObject, requireString } from "./validate.mjs";

export const knownStateTraits = [
  "agent-state",
  "baseline",
  "channel-state",
  "config-state",
  "configured-auth",
  "existing-user",
  "external-plugin",
  "failure-state",
  "filesystem-pressure",
  "fresh-user",
  "memory-pressure",
  "migration-state",
  "missing-auth",
  "mock-provider",
  "old-release",
  "onboarded-user",
  "official-plugin",
  "performance-pressure",
  "platform-specific",
  "plugin-pressure",
  "provider-pressure",
  "runtime-deps",
  "service-state",
  "session-state",
  "upgraded-user",
  "workspace-pressure"
];

export async function loadStates(selectedId) {
  return loadJsonRegistry({
    dir: statesDir,
    kind: "state",
    selectedId,
    validate: validateStateShape
  });
}

export async function loadState(selectedId = "fresh") {
  const [state] = await loadStates(selectedId);
  return state;
}

export function validateStateShape(state, sourceName = "state") {
  const errors = [];

  requireKebabId(state, "id", errors);
  requireString(state, "title", errors);
  requireString(state, "objective", errors);
  requireArray(state, "tags", errors);
  requireArray(state, "traits", errors);
  requireString(state, "riskArea", errors);
  requireString(state, "ownerArea", errors);
  requireArray(state, "setupEvidence", errors);
  requireArray(state, "cleanupGuarantees", errors);
  if (state.prepare !== undefined) {
    requireArray(state, "prepare", errors);
  }
  requireArray(state, "setup", errors);
  if (state.cleanup !== undefined) {
    requireArray(state, "cleanup", errors);
  }

  validateSteps(state.prepare, "prepare", errors, { phaseBinding: false });
  validateSteps(state.setup, "setup", errors, { phaseBinding: true });
  validateSteps(state.cleanup, "cleanup", errors, { phaseBinding: false });
  if (state.compatibleSurfaces !== undefined) {
    errors.push("compatibleSurfaces is not supported; surface requirements own positive state compatibility");
  }
  validateStringArray(state.incompatibleSurfaces, "incompatibleSurfaces", errors, { optional: true });
  validateStringArray(state.traits, "traits", errors);
  validateStringArray(state.setupEvidence, "setupEvidence", errors, { nonEmpty: true });
  validateStringArray(state.cleanupGuarantees, "cleanupGuarantees", errors, { nonEmpty: true });
  validateKnownTraits(state.traits, errors);
  if (state.source !== undefined) {
    validateSource(state.source, errors);
  }
  if (state.auth !== undefined) {
    validateAuth(state.auth, errors);
  }
  if (state.officialPlugins !== undefined) {
    validateOfficialPlugins(state.officialPlugins, errors);
  }

  assertNoShapeErrors(errors, sourceName);
}

function validateOfficialPlugins(plugins, errors) {
  if (!Array.isArray(plugins)) {
    errors.push("officialPlugins must be an array");
    return;
  }
  if (plugins.length === 0) {
    errors.push("officialPlugins must not be empty");
  }
  const ids = new Set();
  for (const [index, plugin] of plugins.entries()) {
    const prefix = `officialPlugins[${index}]`;
    requireObject({ plugin }, "plugin", errors, prefix);
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      continue;
    }
    requireKebabId(plugin, "id", errors, prefix);
    requireString(plugin, "package", errors, prefix);
    requireString(plugin, "title", errors, prefix);
    if (typeof plugin.id === "string") {
      if (ids.has(plugin.id)) {
        errors.push(`${prefix}.id duplicates official plugin id '${plugin.id}'`);
      }
      ids.add(plugin.id);
    }
    if (typeof plugin.package === "string" && !/^@openclaw\/[a-z0-9][a-z0-9-]*$/.test(plugin.package)) {
      errors.push(`${prefix}.package must be a scoped @openclaw/<name> package`);
    }
    if (plugin.required !== undefined && typeof plugin.required !== "boolean") {
      errors.push(`${prefix}.required must be a boolean when set`);
    }
    if (plugin.riskArea !== undefined && (typeof plugin.riskArea !== "string" || plugin.riskArea.length === 0)) {
      errors.push(`${prefix}.riskArea must be a non-empty string when set`);
    }
  }
}

function validateAuth(auth, errors) {
  requireObject({ auth }, "auth", errors);
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return;
  }
  if (auth.mode !== undefined && !["default", "mock", "live", "skip", "missing", "broken", "none"].includes(auth.mode)) {
    errors.push("auth.mode must be one of default, mock, live, skip, missing, broken, none");
  }
  if (auth.reason !== undefined && (typeof auth.reason !== "string" || auth.reason.length === 0)) {
    errors.push("auth.reason must be a non-empty string when set");
  }
}

function validateKnownTraits(traits, errors) {
  if (!Array.isArray(traits)) {
    return;
  }
  const known = new Set(knownStateTraits);
  for (const [index, trait] of traits.entries()) {
    if (typeof trait === "string" && !known.has(trait)) {
      errors.push(`traits[${index}] references unknown trait '${trait}'`);
    }
  }
}

function validateSource(source, errors) {
  requireObject({ source }, "source", errors);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  requireKebabId(source, "kind", errors, "source");
  for (const [key, value] of Object.entries(source)) {
    if (key === "kind") {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`source.${key} must be a non-empty string`);
    }
  }
}

function validateSteps(steps, key, errors, options) {
  if (steps === undefined) {
    return;
  }
  if (!Array.isArray(steps)) {
    return;
  }
  for (const [index, step] of steps.entries()) {
    const prefix = `${key}[${index}]`;
    requireKebabId(step, "id", errors, prefix);
    requireString(step, "title", errors, prefix);
    requireString(step, "intent", errors, prefix);
    if (options.phaseBinding) {
      if (step.afterPhase !== undefined && step.afterPhases !== undefined) {
        errors.push(`${prefix} must use afterPhase or afterPhases, not both`);
      }
      if (step.afterPhases !== undefined) {
        requireArray(step, "afterPhases", errors, prefix);
      } else {
        requireString(step, "afterPhase", errors, prefix);
      }
    }
    requireArray(step, "commands", errors, prefix);
    requireArray(step, "evidence", errors, prefix);
    validateStringArray(step.afterPhases, `${prefix}.afterPhases`, errors, { optional: true });
    validateStringArray(step.commands, `${prefix}.commands`, errors);
    validateStringArray(step.evidence, `${prefix}.evidence`, errors);
    validateCollectionIntent(step.collectionIntent, prefix, errors);
  }
}

function validateStringArray(values, key, errors, options = {}) {
  if (values === undefined && options.optional) {
    return;
  }
  if (!Array.isArray(values)) {
    errors.push(`${key} must be an array`);
    return;
  }
  if (options.nonEmpty && values.length === 0) {
    errors.push(`${key} must not be empty`);
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${key}[${index}] must be a non-empty string`);
    }
  }
}
