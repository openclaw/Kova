import { loadRegistryContext } from "../registries/context.mjs";

export const REPEATED_WORK_AUDIT_SCHEMA = "kova.repeatedWorkAudit.v1";

export async function buildRepeatedWorkAudit(options = {}) {
  const registry = options.registry ?? await loadRegistryContext();
  const phaseUses = collectPhaseUses(registry.scenarios);
  const profiles = buildProfileAudit(registry.profiles, registry.scenarios);
  return {
    schemaVersion: REPEATED_WORK_AUDIT_SCHEMA,
    generatedAt: new Date().toISOString(),
    scenarioCount: registry.scenarios.length,
    phaseCount: phaseUses.length,
    profileCount: registry.profiles.length,
    profiles,
    duplicateCommands: duplicateCommandAudit(phaseUses),
    duplicatePhaseIds: duplicatePhaseIdAudit(phaseUses),
    healthScopes: countHealthScopes(phaseUses),
    explicitEvidenceCommands: explicitEvidenceCommandAudit(phaseUses),
    commandReceiptLocks: []
  };
}

function collectPhaseUses(scenarios) {
  const uses = [];
  for (const scenario of scenarios) {
    for (const phase of scenario.phases ?? []) {
      uses.push({
        scenario: scenario.id,
        surface: scenario.surface,
        phaseId: phase.id,
        healthScope: phase.healthScope ?? "unknown",
        commands: phase.commands ?? []
      });
    }
  }
  return uses;
}

function buildProfileAudit(profiles, scenarios) {
  const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return Object.fromEntries(profiles
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((profile) => {
      const entries = profile.entries ?? [];
      const scenarioPhases = entries.reduce((total, entry) => {
        const scenario = scenariosById.get(entry.scenario);
        return total + (scenario?.phases?.length ?? 0);
      }, 0);
      return [profile.id, {
        entries: entries.length,
        scenarioPhases,
        minimumCollectEnvMetrics: scenarioPhases + entries.length,
        repeatedScenarioRefs: repeatedScenarioRefs(entries)
      }];
    }));
}

function repeatedScenarioRefs(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.scenario, (counts.get(entry.scenario) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([scenario, count]) => ({ scenario, count }))
    .toSorted((left, right) => (right.count - left.count) || left.scenario.localeCompare(right.scenario));
}

function duplicateCommandAudit(phaseUses) {
  const byCommand = new Map();
  for (const phase of phaseUses) {
    for (const command of phase.commands) {
      const entry = byCommand.get(command) ?? {
        command,
        count: 0,
        uses: []
      };
      entry.count += 1;
      entry.uses.push({
        scenario: phase.scenario,
        phaseId: phase.phaseId,
        surface: phase.surface
      });
      byCommand.set(command, entry);
    }
  }
  return [...byCommand.values()]
    .filter((entry) => entry.count > 1)
    .toSorted((left, right) => (right.count - left.count) || left.command.localeCompare(right.command));
}

function duplicatePhaseIdAudit(phaseUses) {
  const counts = new Map();
  for (const phase of phaseUses) {
    const entry = counts.get(phase.phaseId) ?? {
      phaseId: phase.phaseId,
      count: 0,
      scenarios: []
    };
    entry.count += 1;
    entry.scenarios.push(phase.scenario);
    counts.set(phase.phaseId, entry);
  }
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .toSorted((left, right) => (right.count - left.count) || left.phaseId.localeCompare(right.phaseId));
}

function countHealthScopes(phaseUses) {
  const counts = {};
  for (const phase of phaseUses) {
    counts[phase.healthScope] = (counts[phase.healthScope] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts)
    .toSorted(([left], [right]) => left.localeCompare(right)));
}

function explicitEvidenceCommandAudit(phaseUses) {
  const commands = [];
  for (const phase of phaseUses) {
    for (const command of phase.commands) {
      const kind = explicitEvidenceCommandKind(command);
      if (!kind) {
        continue;
      }
      commands.push({
        kind,
        scenario: phase.scenario,
        surface: phase.surface,
        phaseId: phase.phaseId,
        command
      });
    }
  }
  return commands.toSorted((left, right) =>
    left.kind.localeCompare(right.kind) ||
    left.scenario.localeCompare(right.scenario) ||
    left.phaseId.localeCompare(right.phaseId) ||
    left.command.localeCompare(right.command)
  );
}

function explicitEvidenceCommandKind(command) {
  if (/^ocm\s+service\s+status\s+/.test(command)) {
    return "service-status";
  }
  if (/^ocm\s+logs\s+/.test(command)) {
    return "logs";
  }
  return null;
}
