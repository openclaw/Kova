import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isKnownPlatformCoverageKey } from "../platform.mjs";
import {
  knownTargetKinds,
  requirementsForScenario,
  scenarioSupportsState,
  targetKindsForRequirements
} from "./surface-requirements.mjs";

export async function loadJsonRegistry({ dir, kind, selectedId, validate }) {
  const names = await readdir(dir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const items = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(dir, name), "utf8");
    const item = JSON.parse(raw);
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

export function validateRegistryReferences({ scenarios, states, profiles, surfaces, processRoles, metrics = [] }) {
  const errors = [];
  const scenarioIds = idSet(scenarios);
  const stateIds = idSet(states);
  const surfaceIds = idSet(surfaces);
  const processRoleIds = idSet(processRoles);
  const metricIds = idSet(metrics);
  const traitIds = new Set(states.flatMap((state) => state.traits ?? []));
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const stateById = new Map(states.map((state) => [state.id, state]));
  const surfaceById = new Map(surfaces.map((surface) => [surface.id, surface]));

  for (const scenario of scenarios) {
    if (!surfaceIds.has(scenario.surface)) {
      errors.push(`scenario '${scenario.id}' references unknown surface '${scenario.surface}'`);
      continue;
    }
    validateScenarioContract(scenario, surfaceById.get(scenario.surface), { stateIds, processRoleIds, metricIds, traitIds }, errors);
  }

  for (const state of states) {
    for (const surface of state.incompatibleSurfaces ?? []) {
      if (!surfaceIds.has(surface)) {
        errors.push(`state '${state.id}' incompatibleSurfaces references unknown surface '${surface}'`);
      }
    }
  }

  for (const surface of surfaces) {
    for (const role of surface.processRoles ?? []) {
      if (!processRoleIds.has(role)) {
        errors.push(`surface '${surface.id}' references unknown process role '${role}'`);
      }
    }
    for (const role of Object.keys(surface.roleThresholds ?? {})) {
      if (!processRoleIds.has(role)) {
        errors.push(`surface '${surface.id}' roleThresholds references unknown process role '${role}'`);
      }
    }
    validateSurfaceRequirements(surface, { stateIds, traitIds, metricIds }, errors);
    validateThresholdMetrics(surface.thresholds ?? {}, metricIds, errors, `surface '${surface.id}' thresholds`);
    for (const [role, thresholds] of Object.entries(surface.roleThresholds ?? {})) {
      validateThresholdMetrics(thresholds, metricIds, errors, `surface '${surface.id}' roleThresholds.${role}`);
    }
  }

  for (const profile of profiles) {
    validateProfileReferences(profile, { scenarioIds, stateIds, surfaceIds, processRoleIds, metricIds, traitIds, scenarioById, stateById, surfaceById }, errors);
  }

  if (errors.length > 0) {
    throw new Error(`registry references are invalid:\n- ${errors.join("\n- ")}`);
  }
}

function validateScenarioContract(scenario, surface, refs, errors) {
  for (const state of scenario.states ?? []) {
    if (!refs.stateIds.has(state)) {
      errors.push(`scenario '${scenario.id}' states references unknown state '${state}'`);
    }
  }
  for (const role of scenario.processRoles ?? []) {
    if (!refs.processRoleIds.has(role)) {
      errors.push(`scenario '${scenario.id}' processRoles references unknown process role '${role}'`);
    }
  }
  const scenarioRequirements = requirementsForScenario(surface, scenario);
  const surfaceTargetKinds = new Set(targetKindsForRequirements(scenarioRequirements));
  for (const targetKind of scenario.targetKinds ?? []) {
    if (surfaceTargetKinds.size > 0 && !surfaceTargetKinds.has(targetKind)) {
      errors.push(`scenario '${scenario.id}' targetKinds references '${targetKind}' which is not supported by proved requirements on surface '${surface.id}'`);
    }
  }
  const requirementIds = new Set((surface.requirements ?? []).map((requirement) => requirement.id));
  if ((scenario.proves ?? []).length === 0) {
    errors.push(`scenario '${scenario.id}' must prove at least one requirement for surface '${surface.id}'`);
  }
  for (const requirement of scenario.proves ?? []) {
    if (requirementIds.size > 0 && !requirementIds.has(requirement)) {
      errors.push(`scenario '${scenario.id}' proves unknown surface requirement '${surface.id}.${requirement}'`);
    }
  }
  validateThresholdMetrics(
    scenario.thresholds ?? {},
    refs.metricIds,
    errors,
    `scenario '${scenario.id}' thresholds`,
    refs.processRoleIds
  );
}

function validateSurfaceRequirements(surface, refs, errors) {
  for (const requirement of surface.requirements ?? []) {
    const prefix = `surface '${surface.id}' requirement '${requirement.id}'`;
    for (const state of requirement.states ?? []) {
      if (!refs.stateIds.has(state)) {
        errors.push(`${prefix} references unknown state '${state}'`);
      }
    }
    for (const trait of requirement.stateTraits ?? []) {
      if (!refs.traitIds.has(trait)) {
        errors.push(`${prefix} references unknown state trait '${trait}'`);
      }
    }
    for (const targetKind of requirement.targetKinds ?? []) {
      if (!knownTargetKinds.includes(targetKind)) {
        errors.push(`${prefix} targetKinds references unknown target kind '${targetKind}'`);
      }
    }
    validateMetricList(requirement.metrics ?? [], refs.metricIds, errors, `${prefix} metrics`);
  }
}

function validateMetricList(metrics, metricIds, errors, prefix) {
  for (const metric of metrics) {
    if (!metricIds.has(metric)) {
      errors.push(`${prefix} references unknown metric '${metric}'`);
    }
  }
}

function validateThresholdMetrics(thresholds, metricIds, errors, prefix, processRoleIds) {
  for (const [metric, value] of Object.entries(thresholds ?? {})) {
    if (metric === "roleThresholds") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${prefix}.roleThresholds must be an object`);
        continue;
      }
      for (const [role, roleThresholds] of Object.entries(value ?? {})) {
        if (processRoleIds && !processRoleIds.has(role)) {
          errors.push(`${prefix}.roleThresholds references unknown process role '${role}'`);
        }
        if (!roleThresholds || typeof roleThresholds !== "object" || Array.isArray(roleThresholds)) {
          errors.push(`${prefix}.roleThresholds.${role} must be an object`);
          continue;
        }
        validateThresholdMetrics(
          roleThresholds,
          metricIds,
          errors,
          `${prefix}.roleThresholds.${role}`,
          processRoleIds
        );
      }
      continue;
    }
    if (!metricIds.has(metric)) {
      errors.push(`${prefix} references unknown metric '${metric}'`);
    }
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${prefix}.${metric} must be a finite non-negative number`);
    }
  }
}

function validateProfileReferences(profile, refs, errors) {
  for (const [index, entry] of (profile.entries ?? []).entries()) {
    if (!refs.scenarioIds.has(entry.scenario)) {
      errors.push(`profile '${profile.id}' entries[${index}] references unknown scenario '${entry.scenario}'`);
    }
    if (!refs.stateIds.has(entry.state)) {
      errors.push(`profile '${profile.id}' entries[${index}] references unknown state '${entry.state}'`);
    }
    validateScenarioStatePair({
      profileId: profile.id,
      location: `entries[${index}]`,
      scenarioId: entry.scenario,
      stateId: entry.state,
      refs,
      errors
    });
  }

  for (const key of ["blocking", "warning"]) {
    for (const [index, entry] of (profile.gate?.[key] ?? []).entries()) {
      if (!refs.scenarioIds.has(entry.scenario)) {
        errors.push(`profile '${profile.id}' gate.${key}[${index}] references unknown scenario '${entry.scenario}'`);
      }
      if (entry.state !== undefined && !refs.stateIds.has(entry.state)) {
        errors.push(`profile '${profile.id}' gate.${key}[${index}] references unknown state '${entry.state}'`);
      }
      if (entry.state !== undefined) {
        validateScenarioStatePair({
          profileId: profile.id,
          location: `gate.${key}[${index}]`,
          scenarioId: entry.scenario,
          stateId: entry.state,
          refs,
          errors
        });
      }
    }
  }

  validatePlatformCoverageRefs(profile, errors);
  validateRequirementCoverageRefs(profile, refs, errors);
  validateCalibrationRefs(profile, refs, errors);
}

function validateCalibrationRefs(profile, refs, errors) {
  const calibration = profile.calibration;
  if (!calibration) {
    return;
  }
  for (const role of Object.keys(calibration.roles ?? {})) {
    if (!refs.processRoleIds.has(role)) {
      errors.push(`profile '${profile.id}' calibration.roles references unknown process role '${role}'`);
      continue;
    }
    validateThresholdMetrics(calibration.roles[role], refs.metricIds, errors, `profile '${profile.id}' calibration.roles.${role}`);
  }
  for (const [surfaceId, surfaceCalibration] of Object.entries(calibration.surfaces ?? {})) {
    if (!refs.surfaceIds.has(surfaceId)) {
      errors.push(`profile '${profile.id}' calibration.surfaces references unknown surface '${surfaceId}'`);
      continue;
    }
    validateThresholdMetrics(surfaceCalibration.thresholds ?? {}, refs.metricIds, errors, `profile '${profile.id}' calibration.surfaces.${surfaceId}.thresholds`);
    for (const [role, thresholds] of Object.entries(surfaceCalibration.roleThresholds ?? {})) {
      if (!refs.processRoleIds.has(role)) {
        errors.push(`profile '${profile.id}' calibration.surfaces.${surfaceId}.roleThresholds references unknown process role '${role}'`);
        continue;
      }
      validateThresholdMetrics(thresholds, refs.metricIds, errors, `profile '${profile.id}' calibration.surfaces.${surfaceId}.roleThresholds.${role}`);
    }
  }
}

function validatePlatformCoverageRefs(profile, errors) {
  const coverage = profile.gate?.coverage?.platforms;
  if (!coverage) {
    return;
  }
  for (const level of ["blocking", "warning"]) {
    for (const value of coverage[level] ?? []) {
      if (!isKnownPlatformCoverageKey(value)) {
        errors.push(`profile '${profile.id}' gate.coverage.platforms.${level} references unknown platform coverage key '${value}'`);
      }
    }
  }
}

function validateScenarioStatePair({ profileId, location, scenarioId, stateId, refs, errors }) {
  const scenario = refs.scenarioById.get(scenarioId);
  const state = refs.stateById.get(stateId);
  if (!scenario || !state) {
    return;
  }
  const surface = refs.surfaceById.get(scenario.surface);
  if (!surface) {
    return;
  }
  const stateResult = scenarioSupportsState({ scenario, surface, state });
  if (!stateResult.ok) {
    errors.push(`profile '${profileId}' ${location} pairs scenario '${scenario.id}' with state '${state.id}', but ${stateResult.reason}`);
  }
  if ((state.incompatibleSurfaces ?? []).includes(scenario.surface)) {
    errors.push(`profile '${profileId}' ${location} pairs state '${state.id}' with explicitly incompatible surface '${scenario.surface}'`);
  }
}

function validateRequirementCoverageRefs(profile, refs, errors) {
  const coverage = profile.gate?.coverage?.requirements;
  if (!coverage) {
    return;
  }
  for (const level of ["blocking", "warning"]) {
    for (const value of coverage[level] ?? []) {
      const [surface, requirement, extra] = String(value).split(":");
      if (!surface || !requirement || extra !== undefined) {
        errors.push(`profile '${profile.id}' gate.coverage.requirements.${level} must use surface:requirement, got '${value}'`);
        continue;
      }
      const surfaceContract = refs.surfaceById.get(surface);
      if (!surfaceContract) {
        errors.push(`profile '${profile.id}' gate.coverage.requirements.${level} references unknown surface '${surface}'`);
        continue;
      }
      const requirementIds = new Set((surfaceContract.requirements ?? []).map((item) => item.id));
      if (!requirementIds.has(requirement)) {
        errors.push(`profile '${profile.id}' gate.coverage.requirements.${level} references unknown requirement '${surface}:${requirement}'`);
      }
    }
  }
}

function idSet(items) {
  return new Set(items.map((item) => item.id));
}

export function requireString(value, key, errors, prefix = "") {
  if (typeof value?.[key] !== "string" || value[key].length === 0) {
    errors.push(`${path(prefix, key)} must be a non-empty string`);
  }
}

export function requireArray(value, key, errors, prefix = "") {
  if (!Array.isArray(value?.[key])) {
    errors.push(`${path(prefix, key)} must be an array`);
  }
}

export function requireObject(value, key, errors, prefix = "") {
  if (!value?.[key] || typeof value[key] !== "object" || Array.isArray(value[key])) {
    errors.push(`${path(prefix, key)} must be an object`);
  }
}

export function requireKebabId(value, key, errors, prefix = "") {
  requireString(value, key, errors, prefix);
  if (typeof value?.[key] === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value[key])) {
    errors.push(`${path(prefix, key)} must be kebab-case lowercase alphanumeric`);
  }
}

export function validateStringArray(values, key, errors, options = {}) {
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

export function validatePlatforms(platforms, prefix, errors) {
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of ["include", "exclude"]) {
    validateStringArray(platforms[key], `${prefix}.${key}`, errors, { optional: true });
  }
}

export function validateAuthContract(auth, prefix, errors, options = {}) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (auth.mode !== undefined && !["default", "mock", "live", "skip", "missing", "broken", "none"].includes(auth.mode)) {
    errors.push(`${prefix}.mode must be one of default, mock, live, skip, missing, broken, none`);
  }
  if (options.reason && auth.reason !== undefined && (typeof auth.reason !== "string" || auth.reason.length === 0)) {
    errors.push(`${prefix}.reason must be a non-empty string when set`);
  }
}

export function validateMissingExpectedSpanSeverity(value, prefix, errors) {
  if (value === undefined) {
    return;
  }
  if (!["diagnostic-gap", "warn", "fail"].includes(value)) {
    errors.push(`${prefix} must be one of diagnostic-gap, warn, fail`);
  }
}

export function assertNoShapeErrors(errors, sourceName) {
  if (errors.length > 0) {
    throw new Error(`${sourceName} is invalid:\n- ${errors.join("\n- ")}`);
  }
}

function path(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}
