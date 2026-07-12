import { isAbsolute, resolve } from "node:path";
import { repoRoot } from "./paths.mjs";
import { maxOcmEnvNameLength } from "./run/env-name.mjs";

const allowedScenarioExecutables = new Set(["ocm", "node", "rm"]);
const delegatedCommandNodeScripts = new Set([
  "support/assert-command-output.mjs",
  "support/expect-command-fails.mjs"
].map((path) => resolve(repoRoot, path)));
const allowedNodeScenarioScripts = new Set([
  "scripts/large-session-fixture.mjs",
  "support/agent-network-offline.mjs",
  "support/assert-command-output.mjs",
  "support/browser-automation-smoke.mjs",
  "support/channel-conformance/run.mjs",
  "support/ensure-gateway-running.mjs",
  "support/expect-command-fails.mjs",
  "support/install-channel-adapter-package.mjs",
  "support/mcp-bridge-smoke.mjs",
  "support/mcp-tool-call-smoke.mjs",
  "support/media-understanding-timeout.mjs",
  "support/restore-first-ocm-upgrade-snapshot.mjs",
  "support/run-adversarial-inputs.mjs",
  "support/run-channel-adapter-conformance.mjs",
  "support/run-channel-capability-preflight.mjs",
  "support/run-channel-probe-turn.mjs",
  "support/run-concurrent-agent-turns.mjs",
  "support/run-cron-runtime-smoke.mjs",
  "support/run-doctor-repair.mjs",
  "support/run-exec-tool-safety.mjs",
  "support/run-gateway-session-send-turn.mjs",
  "support/run-official-plugin-install.mjs",
  "support/run-openai-compatible-turn.mjs",
  "support/run-openclaw-release-age-upgrade.mjs",
  "support/run-soak-loop.mjs",
  "support/run-tui-message-turn.mjs",
  "support/tui-smoke.mjs"
].map((path) => resolve(repoRoot, path)));
const ocmMutationRules = [
  { matches: (words) => hasPrefix(words, ["ocm", "start"]), targetIndex: 2, label: "ocm start" },
  { matches: (words) => hasPrefix(words, ["ocm", "upgrade"]), targetIndex: 2, label: "ocm upgrade" },
  { matches: (words) => hasPrefix(words, ["ocm", "rollback"]), targetIndex: 2, label: "ocm rollback" },
  { matches: (words) => hasPrefix(words, ["ocm", "logs"]), targetIndex: 2, label: "ocm logs" },
  {
    matches: (words) =>
      hasPrefix(words, ["ocm", "service"]) && ["status", "start", "stop", "restart"].includes(words[2]),
    targetIndex: 3,
    label: "ocm service"
  },
  {
    matches: (words) =>
      hasPrefix(words, ["ocm", "env"]) && ["destroy", "exec", "run", "use"].includes(words[2]),
    targetIndex: 3,
    label: "ocm env"
  },
  {
    matches: (words) => hasPrefix(words, ["ocm", "env", "clone"]),
    targetIndex: 3,
    label: "ocm env clone source",
    allowSourceClone: true
  },
  {
    matches: (words) => hasPrefix(words, ["ocm", "env", "clone"]),
    targetIndex: 4,
    label: "ocm env clone destination"
  }
];

export function assertSafeScenarioCommand(command, context, envName, artifactDir = null) {
  const trimmed = String(command ?? "").trim();
  const words = assertSingleTopLevelShellCommand(trimmed);
  assertDirectScenarioCommand(words, context, envName, artifactDir);
  assertOcmMutationTargets(words, context);

  if (trimmed.includes(envName) && !isKovaEnvName(envName)) {
    throw new Error(`unsafe Kova env name ${JSON.stringify(envName)}; generated envs must start with kova-`);
  }
}

function assertOcmMutationTargets(words, context) {
  for (const rule of ocmMutationRules) {
    if (!rule.matches(words)) {
      continue;
    }
    const value = words[rule.targetIndex];
    if (rule.allowSourceClone && value === context.sourceEnv) {
      continue;
    }
    assertKovaEnvName(value, `${rule.label} target`);
  }

  if (words[0] === "ocm" && words[1]?.startsWith("@")) {
    assertKovaEnvName(words[1].slice(1), "ocm @ target");
  }
}

export function assertKovaEnvName(value, label = "env") {
  if (!isKovaEnvName(value)) {
    throw new Error(`refusing to mutate non-Kova ${label}: ${JSON.stringify(value)}`);
  }
  if (String(value).length > maxOcmEnvNameLength()) {
    throw new Error(`refusing to mutate overlong Kova ${label}: ${JSON.stringify(value)}`);
  }
}

export function isKovaEnvName(value) {
  const text = String(value ?? "");
  return text.length <= maxOcmEnvNameLength() && /^kova-[a-z0-9][a-z0-9-]*$/i.test(text);
}

function hasPrefix(words, prefix) {
  return prefix.every((word, index) => words[index] === word);
}

export function assertSingleTopLevelShellCommand(command) {
  const text = String(command ?? "");
  const executable = text.match(/^([A-Za-z0-9_./+-]+)(?:\s|$)/)?.[1] ?? "";
  if (!allowedScenarioExecutables.has(executable)) {
    throw shellEvaluationError("non-direct scenario executable");
  }
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        throw shellEvaluationError("backslash in double-quoted argument");
      } else if (char === "`" || char === "$") {
        throw shellEvaluationError("shell expansion");
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= text.length) {
        throw shellEvaluationError("dangling escape");
      }
      if (text[index + 1] === "\n" || text[index + 1] === "\r") {
        throw shellEvaluationError("line continuation");
      }
      index += 1;
      continue;
    }
    if (char === "`" || char === "$") {
      throw shellEvaluationError("shell expansion");
    }
    if (char === "*" || char === "?" || char === "[" || char === "]") {
      throw shellEvaluationError("pathname expansion");
    }
    if (char === "{" && hasBraceExpansion(text, index)) {
      throw shellEvaluationError("brace expansion");
    }
    if (char === "(" || char === ")") {
      throw shellEvaluationError(`top-level ${char}`);
    }
    if (char === "\n" || char === "\r" || char === ";" || char === "|" || char === "&" || char === "<" || char === ">") {
      throw compoundCommandError(char);
    }
  }
  if (quote !== null) {
    throw shellEvaluationError("unterminated quote");
  }
  return parseShellWords(text);
}

function hasBraceExpansion(command, startIndex) {
  const endIndex = command.indexOf("}", startIndex + 1);
  if (endIndex < 0) {
    return false;
  }
  const body = command.slice(startIndex + 1, endIndex);
  return body.includes(",") || body.includes("..");
}

function assertDirectScenarioCommand(words, context, envName, artifactDir) {
  if (words[0] === "ocm" && words[1]?.startsWith("-")) {
    if (words.length === 2 && words[1] === "--version") {
      return;
    }
    throw shellEvaluationError("OCM global options before a subcommand");
  }
  if (words[0] === "node") {
    if (words.length === 2 && words[1] === "--version") {
      return;
    }
    const script = resolve(repoRoot, String(words[1] ?? ""));
    if (!allowedNodeScenarioScripts.has(script)) {
      throw shellEvaluationError("unapproved Node scenario entry point");
    }
    assertNodeHelperEnvTargets(words, envName);
    assertDelegatedNodeCommand(words, script, context);
    return;
  }
  if (words[0] === "rm") {
    const expectedPath = artifactDir && isAbsolute(artifactDir) ? resolve(artifactDir, "import") : null;
    const operand = words[2];
    if (
      words.length !== 3 ||
      words[1] !== "-rf" ||
      !expectedPath ||
      !isAbsolute(operand ?? "") ||
      resolve(operand) !== expectedPath
    ) {
      throw shellEvaluationError("unapproved artifact cleanup");
    }
  }
}

function assertDelegatedNodeCommand(words, script, context) {
  if (!delegatedCommandNodeScripts.has(script)) {
    return;
  }
  const separatorIndex = words.indexOf("--", 2);
  const delegated = separatorIndex >= 0 ? words.slice(separatorIndex + 1) : [];
  if (delegated[0] !== "ocm") {
    throw shellEvaluationError("unapproved delegated scenario command");
  }
  if (delegated[1]?.startsWith("-")) {
    throw shellEvaluationError("OCM global options before a delegated subcommand");
  }
  assertOcmMutationTargets(delegated, context);
}

function assertNodeHelperEnvTargets(words, envName) {
  for (let index = 2; index < words.length; index += 1) {
    if (words[index].startsWith("--env=")) {
      throw shellEvaluationError("unsupported inline Node helper --env");
    }
    if (words[index] !== "--env") {
      continue;
    }
    const target = words[index + 1];
    assertKovaEnvName(target, "Node helper --env");
    if (target !== envName) {
      throw new Error(
        `refusing Node helper --env outside active Kova env ${JSON.stringify(envName)}: ${JSON.stringify(target)}`
      );
    }
    index += 1;
  }
}

function parseShellWords(command) {
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (quote === '"' && char === "\\") {
        const next = command[index + 1] ?? "";
        if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
          index += 1;
          word += next;
        } else {
          word += char;
        }
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      index += 1;
      word += command[index] ?? "";
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (started) {
    words.push(word);
  }
  return words;
}

function compoundCommandError(operator) {
  const label = operator === "\n" || operator === "\r" ? "newline" : operator;
  return new Error(`refusing compound scenario command with top-level ${JSON.stringify(label)}; use one command per step`);
}

function shellEvaluationError(kind) {
  return new Error(`refusing scenario command with ${kind}; use a direct command with inert arguments`);
}
