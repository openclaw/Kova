import { measuredProductPhase, measurementScopeForPhase } from "../measurement-contract.mjs";
import { commandMatchesPerformanceMetric } from "../performance/instrumentation.mjs";

export const isColdReadyCommand = (command) =>
  commandMatchesPerformanceMetric("coldReadyMs", command);

export const isWarmReadyCommand = (command) =>
  commandMatchesPerformanceMetric("warmReadyMs", command);

export const isUpgradeCommand = (command) =>
  commandMatchesPerformanceMetric("upgradeMs", command);

export const isStatusCommand = (command) =>
  commandMatchesPerformanceMetric("statusMs", command);

export const isPluginsListCommand = (command) =>
  commandMatchesPerformanceMetric("pluginsListMs", command);

export const isPluginUpdateDryRunCommand = (command) =>
  commandMatchesPerformanceMetric("pluginUpdateDryRunMs", command);

export const isModelsListCommand = (command) =>
  commandMatchesPerformanceMetric("modelsListMs", command);

export const isDoctorFixCommand = (command) =>
  commandMatchesPerformanceMetric("doctorFixMs", command);

export function summarizeMeasurementScopes(record) {
  const phases = { product: 0, harness: 0, cleanup: 0 };
  const results = { product: 0, harness: 0, cleanup: 0 };
  for (const phase of record.phases ?? []) {
    const phaseScope = measurementScopeForPhase(phase);
    phases[phaseScope] += 1;
    results[phaseScope] += phase.results?.length ?? 0;
  }
  return {
    schemaVersion: "kova.measurementScopeSummary.v1",
    productPhaseCount: phases.product,
    harnessPhaseCount: phases.harness,
    cleanupPhaseCount: phases.cleanup,
    productCommandCount: results.product,
    harnessCommandCount: results.harness,
    cleanupCommandCount: results.cleanup
  };
}

export function collectResults(record, options = {}) {
  return collectPhaseResults(record, options, (result) => result);
}

export function collectPhaseResultEntries(record, options = {}) {
  return collectPhaseResults(record, options, (result, phase) => ({ phase, result }));
}

function collectPhaseResults(record, options, project) {
  const excludePhaseIds = new Set(options.excludePhaseIds ?? []);
  const entries = [];
  for (const phase of record.phases ?? []) {
    if (excludePhaseIds.has(phase.id)) {
      continue;
    }
    if (options.productOnly === true && !measuredProductPhase(phase)) {
      continue;
    }
    for (const result of phase.results ?? []) {
      entries.push(project(result, phase));
    }
  }
  return entries;
}
