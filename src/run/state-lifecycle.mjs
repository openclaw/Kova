import { collectEnvMetrics } from "../metrics.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
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
  // clone would replace them, so those runs keep the full per-repeat setup.
  if (total <= 1 || !(context.state?.setup ?? []).some((step) => step.repeatRestoreCommands) ||
      resolveOcmTransport({ ...process.env, ...context.commandEnv })) {
    return null;
  }
  return {
    envName: envNameFor(scenario.id, `${context.state.id}-template`, context.runId),
    ready: false
  };
}

export async function removeStateTemplate(template, context) {
  if (!template?.ready || context.keepEnv) {
    return;
  }
  // A failed removal leaves one disposable Kova env; teardown never blocks the report on it.
  await runCommand(`ocm env destroy ${quoteShell(template.envName)} --yes --json`, {
    timeoutMs: context.timeoutMs,
    env: context.commandEnv
  });
}

export async function executeStateSetupAfterPhase(context, envName, phaseId, scenario, artifactDir, authPolicy) {
  const steps = (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phaseId));
  if (steps.length === 0) {
    return null;
  }

  const template = context.stateTemplate;
  const reusable = template && steps.every((step) => step.repeatRestoreCommands);
  if (reusable && template.ready) {
    const restoreSteps = steps.map((step) => ({
      ...step,
      commands: [
        "ocm env destroy {env} --yes --json",
        `ocm env clone ${quoteShell(template.envName)} {env} --json`,
        ...step.repeatRestoreCommands
      ]
    }));
    const phase = await executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, restoreSteps, artifactDir, phaseId, authPolicy);
    phase.restoredFromStateTemplate = template.envName;
    return phase;
  }

  const phase = await executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, steps, artifactDir, phaseId, authPolicy);
  if (reusable && phase.results.every((result) => result.status === 0)) {
    const command = `ocm env clone ${quoteShell(envName)} ${quoteShell(template.envName)} --json`;
    const result = await runScenarioCommand(command, context, envName, artifactDir, phase, phase.commands.length, authPolicy);
    // Without a template, later repeats keep running the full setup.
    template.ready = result.status === 0;
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
