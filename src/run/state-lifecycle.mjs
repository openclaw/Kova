import { collectEnvMetrics } from "../metrics.mjs";
import { runCleanupCommand } from "../cleanup.mjs";
import { quoteShell } from "../commands.mjs";
import { isMissingOcmResource } from "../ocm/missing-resource.mjs";
import { ocmEnvDestroy } from "../ocm/commands.mjs";
import { phaseResultStatus } from "../measurement-contract.mjs";
import { metricOptions } from "./metric-options.mjs";
import { envNameFor } from "./env-name.mjs";
import {
  buildStateLifecyclePhase,
  stateLifecycleCollectionIntent,
  stateLifecycleCommandScope,
  stateStepMatchesPhase
} from "./phase-plan.mjs";
import { runScenarioCommand } from "./command-executor.mjs";
import { resolveOcmTransport } from "../ocm/transport.mjs";

// Setup steps with repeatRestoreCommands are harness preparation, not
// measurement. The first repeat runs them and clones the prepared env; later
// repeats replace their fresh env with a clone of it, then run only the
// restore commands to verify the copy.
export function createStateTemplate(scenario, context, total) {
  // Cross-user transport prepares per-env diagnostics at `ocm start`; a restored
  // clone would replace them. --keep-env retains every env it creates under
  // retention protection, so it keeps the full per-repeat setup instead of
  // leaving an unprotected template behind.
  if (total <= 1 || context.keepEnv || resolveOcmTransport({ ...process.env, ...context.commandEnv })) {
    return null;
  }
  // A restore replaces the whole env, so it is only safe at a scenario's single
  // setup checkpoint; a later checkpoint could follow Gateway startup.
  const reusable = (context.state?.setup ?? []).filter((step) => step.repeatRestoreCommands);
  const checkpoints = scenario.phases.filter((phase) => reusable.some((step) => stateStepMatchesPhase(step, phase.id)));
  if (reusable.length === 0 || checkpoints.length !== 1) {
    return null;
  }
  return {
    envName: envNameFor(scenario.id, `${context.state.id}-template`, context.runId),
    ready: false
  };
}

// The template belongs to the run's last record, which reports its cleanup
// like the record's own env: a failed destroy blocks an otherwise passing record.
export async function removeStateTemplate(template, context, records) {
  const record = records.at(-1);
  if (!template?.ready || !record) {
    return;
  }
  const result = await runCleanupCommand(ocmEnvDestroy(template.envName), {
    timeoutMs: context.timeoutMs,
    env: context.commandEnv
  });
  const cleanup = result.status === 0
    ? "destroyed"
    : isMissingOcmResource(result, "environment", template.envName) ? "already-absent" : "destroy-failed";
  record.stateTemplateCleanup = { envName: template.envName, cleanup, result };
  if (cleanup === "destroy-failed" && record.status === "PASS") {
    record.status = "BLOCKED";
  }
}

export async function executeStateSetupAfterPhase(context, envName, phaseId, scenario, artifactDir, authPolicy) {
  const steps = (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phaseId));
  if (steps.length === 0) {
    return null;
  }

  const template = context.stateTemplate;
  const reusable = template && !template.unavailable && steps.every((step) => step.repeatRestoreCommands);
  if (reusable && template.ready) {
    const restoreSteps = steps.map((step) => ({
      ...step,
      commands: [
        "ocm env destroy {env} --yes --json",
        `ocm env clone ${quoteShell(template.envName)} {env} --keep-identity --json`,
        ...step.repeatRestoreCommands
      ]
    }));
    const phase = await executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, restoreSteps, artifactDir, phaseId, authPolicy);
    phase.restoredFromStateTemplate = template.envName;
    return phase;
  }

  const phase = await executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, steps, artifactDir, phaseId, authPolicy);
  if (reusable && phase.results.every((result) => result.status === 0)) {
    // --keep-identity keeps the client credentials OpenClaw's state database is
    // bound to. An OCM without it fails here, and later repeats keep the full setup.
    const command = `ocm env clone ${quoteShell(envName)} ${quoteShell(template.envName)} --keep-identity --json`;
    const result = await runScenarioCommand(command, context, envName, artifactDir, phase, phase.commands.length, authPolicy);
    template.ready = result.status === 0;
    template.unavailable = !template.ready;
    phase.stateTemplate = { envName: template.envName, command, status: result.status, stderr: result.stderr };
  }
  return phase;
}

export async function executeStateLifecycleSteps(context, envName, scenario, kind, steps, artifactDir, phaseId = null, authPolicy = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const results = [];
  const phase = buildStateLifecyclePhase(context, envName, scenario, kind, steps, artifactDir, phaseId);
  const commands = phase.commands;

  for (const [commandIndex, command] of commands.entries()) {
    const result = await runScenarioCommand(command, context, envName, artifactDir, phase, commandIndex, authPolicy);
    results.push(result);
    if (result.status !== 0) {
      break;
    }
  }

  return {
    ...phase,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: phaseId }, artifactDir, {
      kind: "state-lifecycle",
      measurementPhase: phase,
      lifecycleKind: kind,
      lifecycleCommandScope: stateLifecycleCommandScope(commands),
      collectionIntent: stateLifecycleCollectionIntent(steps),
      redactValues: authPolicy?.redactionValues ?? [],
      resultStatus: phaseResultStatus(results)
    }))
  };
}
