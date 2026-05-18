import { quoteShell } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { materializeCommands } from "../registries/scenarios.mjs";

export function materializeScenarioPhaseCommands(phase, context, envName, artifactDir) {
  return materializeCommands(phase.commands ?? [], commandValues(context, envName, artifactDir));
}

export function materializeLifecycleCommands(steps, context, envName, artifactDir) {
  const commands = [];
  const evidence = [];
  for (const step of steps ?? []) {
    commands.push(...materializeLifecycleStepCommands(step, context, envName, artifactDir));
    evidence.push(...(step.evidence ?? []));
  }
  return { commands, evidence };
}

export function materializeLifecycleStepCommands(step, context, envName, artifactDir) {
  return materializeCommands(step.commands ?? [], commandValues(context, envName, artifactDir));
}

export function commandValues(context, envName, artifactDir = "") {
  return {
    env: quoteShell(envName),
    target: context.target,
    from: context.from ?? "",
    sourceEnv: quoteShell(context.sourceEnv ?? ""),
    artifactDir: artifactDir ? quoteShell(artifactDir) : "",
    kovaRoot: quoteShell(repoRoot),
    startSelector: context.targetPlan.startSelector,
    upgradeSelector: context.targetPlan.upgradeSelector,
    fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
  };
}

export function safeSegment(value) {
  return String(value ?? "phase").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase";
}
