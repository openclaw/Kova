import { surfacesDir } from "../paths.mjs";
import { validatePurposes } from "./purposes.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireObject, requireString } from "./validate.mjs";
import { knownTargetKinds } from "./surface-requirements.mjs";

export async function loadSurfaces(selectedId) {
  return loadJsonRegistry({
    dir: surfacesDir,
    kind: "surface",
    selectedId,
    validate: validateSurfaceShape
  });
}

export function validateSurfaceShape(surface, sourceName = "surface") {
  const errors = [];
  requireKebabId(surface, "id", errors);
  requireString(surface, "title", errors);
  requireString(surface, "ownerArea", errors);
  requireString(surface, "description", errors);
  requireArray(surface, "processRoles", errors);
  requireObject(surface, "thresholds", errors);
  requireObject(surface, "diagnostics", errors);
  requireArray(surface, "requirements", errors);
  validatePurposes(surface.purposes, "purposes", errors, { optional: true });

  for (const key of ["requiredStates", "targetKinds", "requiredMetrics"]) {
    if (surface[key] !== undefined) {
      errors.push(`${key} is not supported on surfaces; put requirement-specific contract data in requirements[]`);
    }
  }

  for (const key of ["processRoles"]) {
    if (surface[key] === undefined) {
      continue;
    }
    if (!Array.isArray(surface[key])) {
      errors.push(`${key} must be an array when set`);
      continue;
    }
    for (const [index, value] of surface[key].entries()) {
      if (typeof value !== "string" || value.length === 0) {
        errors.push(`${key}[${index}] must be a non-empty string`);
      }
    }
  }

  if (surface.diagnostics && typeof surface.diagnostics === "object" && !Array.isArray(surface.diagnostics)) {
    if (surface.diagnostics.timelineRequiredForSourceBuild !== undefined &&
      typeof surface.diagnostics.timelineRequiredForSourceBuild !== "boolean") {
      errors.push("diagnostics.timelineRequiredForSourceBuild must be boolean when set");
    }
    if (surface.diagnostics.expectedSpans !== undefined && !Array.isArray(surface.diagnostics.expectedSpans)) {
      errors.push("diagnostics.expectedSpans must be an array when set");
    }
    validateMissingExpectedSpanSeverity(surface.diagnostics.missingExpectedSpanSeverity, "diagnostics.missingExpectedSpanSeverity", errors);
  }
  validateRoleThresholds(surface.roleThresholds, "roleThresholds", errors);
  validateRequirements(surface.requirements, errors);

  assertNoShapeErrors(errors, sourceName);
}

function validateMissingExpectedSpanSeverity(value, prefix, errors) {
  if (value === undefined) {
    return;
  }
  if (!["diagnostic-gap", "warn", "fail"].includes(value)) {
    errors.push(`${prefix} must be one of diagnostic-gap, warn, fail`);
  }
}

function validateRequirements(requirements, errors) {
  if (!Array.isArray(requirements)) {
    return;
  }
  if (requirements.length === 0) {
    errors.push("requirements must not be empty");
  }

  const ids = new Set();
  for (const [index, requirement] of requirements.entries()) {
    const prefix = `requirements[${index}]`;
    requireKebabId(requirement, "id", errors, prefix);
    if (typeof requirement?.id === "string") {
      if (ids.has(requirement.id)) {
        errors.push(`requirements duplicate id '${requirement.id}'`);
      }
      ids.add(requirement.id);
    }
    validateStringArray(requirement?.states, `${prefix}.states`, errors, { optional: true });
    validateStringArray(requirement?.stateTraits, `${prefix}.stateTraits`, errors, { optional: true });
    if (!Array.isArray(requirement?.states) && !Array.isArray(requirement?.stateTraits)) {
      errors.push(`${prefix} must define states or stateTraits`);
    }
    validateStringArray(requirement?.targetKinds, `${prefix}.targetKinds`, errors);
    validateKnownTargetKinds(requirement?.targetKinds, `${prefix}.targetKinds`, errors);
    validateStringArray(requirement?.metrics, `${prefix}.metrics`, errors);
    validatePurposes(requirement?.purposes, `${prefix}.purposes`, errors, { optional: true });
  }
}

function validateKnownTargetKinds(values, prefix, errors) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const [index, value] of values.entries()) {
    if (typeof value === "string" && !knownTargetKinds.includes(value)) {
      errors.push(`${prefix}[${index}] references unknown target kind '${value}'`);
    }
  }
}

function validateRoleThresholds(value, prefix, errors) {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  for (const [role, thresholds] of Object.entries(value)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) {
      errors.push(`${prefix}.${role} must use a kebab-case process role id`);
    }
    if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
      errors.push(`${prefix}.${role} must be an object`);
      continue;
    }
    for (const key of ["peakRssMb", "maxCpuPercent"]) {
      if (thresholds[key] !== undefined && (typeof thresholds[key] !== "number" || thresholds[key] < 0)) {
        errors.push(`${prefix}.${role}.${key} must be a non-negative number when set`);
      }
    }
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
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${key}[${index}] must be a non-empty string`);
    }
  }
}
