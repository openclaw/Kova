import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runScenarioCommand } from "./command-executor.mjs";
import { collectEnvMetrics } from "../metrics.mjs";
import { phaseResultStatus, measuredProductPhase } from "../measurement-contract.mjs";
import { collectorArtifactDirs } from "../collectors/artifacts.mjs";
import { sampleGatewayTreeRss } from "../collectors/resources.mjs";
import { startStartupResourceSampler } from "../collectors/startup-resources.mjs";
import { safeSegment } from "./phase-commands.mjs";

// This boundary owns commands and their post-command collection, not teardown.
export async function executeScenarioPhase(phase, context, envName, artifactDir, authPolicy, options, onResult, signal) {
  const optionsFor = (status) => typeof options === "function" ? options(status) : options;
  const initialOptions = optionsFor("success");
  const policy = initialOptions.collectionPolicy;
  const observeStartup = phase.commands.length > 0 && measuredProductPhase(phase) &&
    context.resourceSampling !== false && initialOptions.readinessTimeoutMs > 0 &&
    policy?.readiness !== "none" && policy?.collectors?.readiness !== false && policy?.collectors?.service !== false;
  const startup = observeStartup ? startStartupResourceSampler({
    envName, commandEnv: context.commandEnv, intervalMs: context.resourceSampleIntervalMs,
    processRoles: context.processRoles ?? [],
    redactValues: authPolicy?.redactionValues ?? context.auth?.redactionValues ?? [],
    artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, safeSegment(phase.id) + "-startup.jsonl")
  }) : null;
  const completed = { ...phase, results: [], ...(startup && process.platform === "linux" ? { startupResourceExpected: true } : {}) };
  let failure;
  try {
    for (const [commandIndex, command] of phase.commands.entries()) {
      const result = await runScenarioCommand(command, context, envName, artifactDir, phase, commandIndex, authPolicy);
      completed.results.push(result);
      await onResult?.(result, commandIndex);
      if (result.status !== 0) break;
    }
    completed.metrics = await collectEnvMetrics(envName, {
      ...optionsFor(phaseResultStatus(completed.results)),
      signal,
      onReadiness: startup ? async (readiness) => {
        const commandFailed = phaseResultStatus(completed.results) !== "success";
        completed.startupResources = await startup.stop({ readiness, commandFailed });
        if (phase.settledRssAfterMs && process.platform === "linux") {
          const readyAt = Date.parse(readiness.readyAt);
          const targetMs = phase.settledRssAfterMs;
          if (commandFailed || !readiness.identityMatched || !Number.isFinite(readyAt)) {
            completed.startupResources.settledRss = {
              status: "unavailable", reason: "readiness-identity-unavailable", targetMs
            };
          } else {
            await delay(Math.max(0, targetMs - (Date.now() - readyAt)), undefined, { signal });
            const sample = sampleGatewayTreeRss(readiness.processIdentity,
              authPolicy?.redactionValues ?? context.auth?.redactionValues ?? []);
            completed.startupResources.settledRss = {
              ...sample, targetMs,
              ...(sample.sampledAt ? { elapsedMs: Date.parse(sample.sampledAt) - readyAt } : {})
            };
          }
        }
      } : undefined
    });
    return completed;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (startup && !completed.startupResources) {
      completed.startupResources = await startup.stop({
        error: failure ?? (completed.metrics?.error ? new Error(completed.metrics.error) : null),
        readiness: completed.metrics?.readiness,
        commandFailed: phaseResultStatus(completed.results) !== "success"
      });
    }
    if (failure && completed.startupResources) failure.startupResources = completed.startupResources;
  }
}
