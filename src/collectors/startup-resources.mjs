import { startResourceSampler } from "./resources.mjs";

export const STARTUP_RESOURCES_SCHEMA = "kova.startupResources.v1";

export function startStartupResourceSampler(options) {
  const startedAt = new Date().toISOString();
  const platform = process.platform;
  // No command root: only the supervised Gateway and its descendants belong
  // to this independent observation. Command accounting keeps its own windows.
  const sampler = platform === "linux"
    ? startResourceSampler(null, { ...options, captureGatewayIdentity: true }) : null;
  let completion;
  return {
    stop(outcome = {}) {
      completion ??= finish(outcome);
      return completion;
    }
  };

  async function finish(outcome) {
    let resources;
    let collectionError = false;
    try {
      resources = await sampler?.stop() ?? { available: false };
    } catch (error) {
      collectionError = true;
      resources = { available: false, cpuCoverageComplete: false, errors: [error.message] };
    }
    const readiness = outcome.readiness;
    const readyIdentity = readiness?.processIdentity ?? null;
    const identities = resources.gatewayIdentities ?? [];
    const terminal = resources.terminal;
    const reason = platform !== "linux" ? "unsupported-platform" : outcome.error ? "collector-error" : outcome.commandFailed ? "command-failed" :
      readiness?.ready === false ? "readiness-timeout" : readiness?.ready !== true ? "readiness-missing" :
      collectionError || resources.failedSampleCount > 0 ? "resource-collection-error" :
      !readyIdentity ? "readiness-identity-missing" :
      readiness.identityMatched !== true ? "readiness-identity-mismatch" :
      !identities.some((identity) => sameIdentity(identity, readyIdentity)) ||
      !sameIdentity(terminal?.gatewayIdentity, readyIdentity) ? "gateway-identity-mismatch" :
      !terminal?.cpuTerminal || resources.cpuCoverageComplete !== true ? "cpu-incomplete" : null;
    return {
      schemaVersion: STARTUP_RESOURCES_SCHEMA,
      scope: "gateway-tree",
      budgetPolicy: "independent-evidence-not-additive",
      startedAt,
      finishedAt: new Date().toISOString(),
      coverage: { status: platform !== "linux" ? "not-applicable" : reason ? "incomplete" : "complete", reason, readyIdentity,
        readyAt: readiness?.readyAt ?? null, terminalAt: terminal?.timestamp ?? null,
        error: outcome.error?.message ?? null },
      resources
    };
  }
}

function sameIdentity(left, right) {
  return left != null && right != null && Number.isSafeInteger(left.startTicks) &&
    left.pid === right.pid && left.startTicks === right.startTicks;
}
