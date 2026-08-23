import { runCommand } from "./commands.mjs";
import { Buffer } from "node:buffer";

const TARGET_IDENTITY_SCHEMA = "kova.target.identity.v1";
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512_SRI = /^sha512-([A-Za-z0-9+/]{86}==)$/;

function isCanonicalSha512Integrity(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = SHA512_SRI.exec(value);
  if (!match) {
    return false;
  }
  const decoded = Buffer.from(match[1], "base64");
  return decoded.length === 64 && decoded.toString("base64") === match[1];
}

export async function resolveTargetIdentity(targetPlan, options = {}) {
  const versionOnly = versionOnlyIdentity(targetPlan);
  if (!versionOnly || options.execute !== true) {
    return versionOnly;
  }

  const result = await runCommand("ocm runtime list --json", {
    timeoutMs: options.timeoutMs ?? 30000,
    maxOutputChars: 1000000
  });
  if (result.status !== 0 || result.outputBudget?.truncated === true) {
    return versionOnly;
  }
  try {
    return targetIdentityFromRuntimeList(targetPlan, JSON.parse(result.stdout)) ?? versionOnly;
  } catch {
    return versionOnly;
  }
}

export function targetIdentityFromRuntimeList(targetPlan, runtimes) {
  const versionOnly = versionOnlyIdentity(targetPlan);
  if (!versionOnly || !Array.isArray(runtimes)) {
    return versionOnly;
  }
  const matches = runtimes.filter((runtime) => (
    runtime &&
    typeof runtime === "object" &&
    runtime.releaseVersion === targetPlan.value &&
    runtime.releaseSelectorKind === "version" &&
    runtime.releaseSelectorValue === targetPlan.value &&
    runtime.sourceKind === "installed" &&
    isCanonicalSha512Integrity(runtime.sourceIntegrity)
  ));
  if (matches.length !== 1) {
    return versionOnly;
  }
  return {
    ...versionOnly,
    npmIntegrity: matches[0].sourceIntegrity
  };
}

function versionOnlyIdentity(targetPlan) {
  if (
    targetPlan?.kind !== "npm" ||
    typeof targetPlan.value !== "string" ||
    !EXACT_VERSION.test(targetPlan.value)
  ) {
    return null;
  }
  return {
    schemaVersion: TARGET_IDENTITY_SCHEMA,
    requestedSelector: `npm:${targetPlan.value}`,
    resolvedVersion: targetPlan.value,
    npmIntegrity: null,
    gitSha: null,
    buildDigest: null
  };
}
