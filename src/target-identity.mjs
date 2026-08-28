import { Buffer } from "node:buffer";
import { quoteShell, runCommand } from "./commands.mjs";

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512_SRI = /^sha512-([A-Za-z0-9+/]{86}==)$/;

function isCanonicalSha512Integrity(value) {
  const match = typeof value === "string" ? SHA512_SRI.exec(value) : null;
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64");
  return decoded.length === 64 && decoded.toString("base64") === match[1];
}

// Only the generated target operation can attest a binding. Source setup,
// rollback, inventory, and later version probes cannot substitute for it.
function targetBindingOperation(command, targetPlan, envName) {
  if (targetPlan?.kind !== "npm" || !EXACT_VERSION.test(targetPlan.value)) return null;
  const selector = `--version ${quoteShell(targetPlan.value)}`;
  const start = `ocm start ${quoteShell(envName)} ${selector}`;
  if (command === `${start} --json` || command === `${start} --no-service --json`) return "start";
  if (command === `ocm upgrade ${quoteShell(envName)} ${selector} --json`) return "upgrade";
  return null;
}

function successfulJson(result) {
  if (result?.status !== 0 || result.timedOut || result.signal || result.outputBudget?.truncated) return null;
  try {
    const payload = JSON.parse(result.stdout);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export async function captureTargetIdentity(result, targetPlan, envName, options = {}) {
  const operation = targetBindingOperation(result.command, targetPlan, envName);
  if (!operation) return;
  result.targetIdentity = null;
  const binding = successfulJson(result);
  if (binding?.envName !== envName) return;
  if (operation === "upgrade" && (
    binding.bindingKind !== "runtime" ||
    !["switched", "updated", "up-to-date"].includes(binding.outcome) ||
    binding.rollback != null || binding.runtimeReleaseVersion !== targetPlan.value
  )) return;
  const runtimeName = operation === "start" ? binding.defaultRuntime : binding.bindingName;
  if (typeof runtimeName !== "string" || !runtimeName || (operation === "start" && binding.defaultLauncher)) return;

  // Resolve this receipt's named runtime before another command can roll it
  // back or remove it. Never search global inventory by version or selector.
  const execute = options.execute ?? runCommand;
  const metadata = successfulJson(await execute(`ocm runtime show ${quoteShell(runtimeName)} --json`, {
    timeoutMs: options.timeoutMs ?? 30000,
    env: options.env,
    redactValues: options.redactValues,
    maxOutputChars: 1000000
  }));
  if (metadata?.name !== runtimeName || metadata.sourceKind !== "installed" ||
      metadata.releaseVersion !== targetPlan.value || !isCanonicalSha512Integrity(metadata.sourceIntegrity)) return;
  result.targetIdentity = {
    schemaVersion: "kova.target.identity.v1",
    requestedSelector: targetPlan.selector,
    resolvedVersion: metadata.releaseVersion,
    npmIntegrity: metadata.sourceIntegrity,
    gitSha: null,
    buildDigest: null
  };
}

export function commonTargetIdentity(items) {
  const identity = items[0]?.targetIdentity;
  if (!identity || !items.every((item) => JSON.stringify(item.targetIdentity) === JSON.stringify(identity))) return null;
  return identity;
}

export function recordTargetIdentity(record) {
  const bindings = (record.phases ?? []).flatMap((phase) => phase.results ?? [])
    .filter((result) => Object.hasOwn(result, "targetIdentity"));
  return commonTargetIdentity(bindings);
}

export function reportTargetIdentity(records) {
  return commonTargetIdentity(records.filter((record) => !["DRY-RUN", "SKIPPED"].includes(record.status)));
}
