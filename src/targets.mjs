import { randomBytes } from "node:crypto";
import { ocmTargetSelector } from "./ocm/commands.mjs";

export function resolveTarget(selector, role) {
  const [kind, ...rest] = selector.split(":");
  const value = rest.join(":");

  if (!value) {
    throw new Error(`${role} selector must use kind:value, got ${selector}`);
  }

  if (kind === "npm") {
    const target = {
      kind,
      value,
      selector: `${kind}:${value}`,
      requestedSelector: selector
    };
    return withOcmSelectors(target);
  }

  if (kind === "release") {
    const target = {
      kind: "release",
      value,
      selector: `release:${value}`,
      requestedSelector: selector
    };
    return withOcmSelectors(target);
  }

  if (kind === "runtime") {
    const target = {
      kind,
      value,
      selector: `${kind}:${value}`,
      requestedSelector: selector
    };
    return withOcmSelectors(target);
  }

  if (kind === "local-build") {
    const runtimeName = [
      "kova-local",
      Date.now().toString(36),
      process.pid.toString(36),
      randomBytes(4).toString("hex")
    ].join("-");
    const target = {
      kind,
      value,
      repoPath: value,
      runtimeName,
      selector: `${kind}:${value}`,
      requestedSelector: selector
    };
    return withOcmSelectors(target);
  }

  throw new Error(`unsupported ${role} selector kind: ${kind}`);
}

function withOcmSelectors(target) {
  return {
    ...target,
    startSelector: ocmTargetSelector(target, "start"),
    upgradeSelector: ocmTargetSelector(target, "upgrade")
  };
}
