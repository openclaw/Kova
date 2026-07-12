import { quoteShell } from "../commands.mjs";

export function ocmTargetSelector(targetPlan, commandKind = "start") {
  if (commandKind !== "start" && commandKind !== "upgrade") {
    throw new Error(`unsupported OCM target selector command kind: ${commandKind}`);
  }

  if (targetPlan.kind === "npm") {
    return `--version ${quoteShell(targetPlan.value)}`;
  }
  if (targetPlan.kind === "release") {
    return `--channel ${quoteShell(targetPlan.value)}`;
  }
  if (targetPlan.kind === "runtime" || targetPlan.kind === "local-build") {
    const runtimeName = targetPlan.runtimeName ?? targetPlan.value;
    return `--runtime ${quoteShell(runtimeName)}`;
  }
  throw new Error(`unsupported OCM target kind: ${targetPlan.kind}`);
}

export function ocmEnvDestroy(envName, options = {}) {
  if (options.force === true && options.stateRevision !== undefined) {
    throw new Error("ocm env destroy cannot combine force with a state token");
  }
  if (
    options.stateRevision !== undefined &&
    (typeof options.stateRevision !== "string" || options.stateRevision.length === 0)
  ) {
    throw new Error("ocm env destroy state token must be a non-empty string");
  }
  const args = ["ocm env destroy", quoteShell(envName)];
  if (options.json === true) args.push("--json");
  args.push("--yes");
  if (options.force === true) args.push("--force");
  if (options.stateRevision !== undefined) {
    args.push("--if-state-token", quoteShell(options.stateRevision));
  }
  return args.join(" ");
}

export function ocmEnvDestroyPreviewJson(envName) {
  return `ocm env destroy ${quoteShell(envName)} --json`;
}

export function ocmEnvProtect(envName, protectedValue) {
  return `ocm env protect ${quoteShell(envName)} ${protectedValue ? "on" : "off"} --json`;
}

export function ocmEnvExec(envName, args) {
  return `ocm env exec ${quoteShell(envName)} -- ${quoteArgs(args)}`;
}

export function ocmEnvExecShell(envName, script) {
  return ocmEnvExec(envName, ["sh", "-lc", script]);
}

export function ocmAt(envName, args) {
  return `ocm @${quoteShell(envName)} -- ${quoteArgs(args)}`;
}

export function ocmLogs(envName, options = {}) {
  const args = ["logs", quoteShell(envName)];
  if (options.tail !== undefined) {
    args.push("--tail", quoteShell(options.tail));
  }
  if (options.raw === true) {
    args.push("--raw");
  }
  return `ocm ${args.join(" ")}`;
}

export function ocmServiceStatusJson(envName) {
  return `ocm service status ${quoteShell(envName)} --json`;
}

export function ocmServiceStatusAllJson() {
  return "ocm service status --all --json";
}

export function ocmEnvListJson() {
  return "ocm env list --json";
}

export function ocmRuntimeBuildLocal(runtimeName, repoPath) {
  return `ocm runtime build-local ${quoteShell(runtimeName)} --repo ${quoteShell(repoPath)} --force`;
}

export function ocmRuntimeRemoveJson(runtimeName) {
  return `ocm runtime remove ${quoteShell(runtimeName)} --json`;
}

function quoteArgs(args) {
  return args.map((arg) => quoteShell(arg)).join(" ");
}
