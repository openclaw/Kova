import { randomUUID } from "node:crypto";
import { access, mkdir, open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { checkCommand, runCommand } from "./commands.mjs";
import {
  externalCliVerificationSummary,
  impliedExternalCliForProvider,
  resolveExternalCliName,
  verifyExternalCliAuth
} from "./external-cli-auth.mjs";
import { platformInfo } from "./platform.mjs";
import { artifactsDir, credentialsDir, liveEnvPath, providersPath, reportsDir, repoRoot } from "./paths.mjs";
import { configureCredentialProvider, ensureCredentialStore } from "./auth.mjs";
import { renderSetup } from "./reporting/render-setup.mjs";

const requiredNodeMajor = 22;

export async function runSetup(flags = {}) {
  rejectRemovedSetupFlags(flags);
  if (flags._?.[0] === "auth") {
    await runAuthSetup(flags);
    return;
  }

  const checks = [];
  const auth = await setupAuth(flags);

  checks.push(nodeVersionCheck());
  checks.push(commandAvailableCheck("ocm", ["--version"], { required: true }));
  checks.push(await jsonCommandCheck("ocm-env-list", "ocm env list --json", {
    required: true,
    validate: (data) => Array.isArray(data)
  }));
  checks.push(await jsonCommandCheck("ocm-runtime-list", "ocm runtime list --json", {
    required: true,
    validate: (data) => Array.isArray(data)
  }));
  checks.push(await directoryCheck("reports-dir", reportsDir));
  checks.push(await directoryCheck("artifacts-dir", artifactsDir));
  checks.push(await mockProviderPackageCheck());
  checks.push(await credentialStoreCheck(auth));
  checks.push(skillGuidanceCheck());

  const ok = checks.every((check) => !check.required || check.status === "PASS");
  const result = {
    schemaVersion: "kova.setup.v1",
    generatedAt: new Date().toISOString(),
    mode: flags.ci ? "ci" : "local",
    ok,
    platform: platformInfo(),
    auth,
    checks,
    nextCommands: [
      "kova self-check",
      "kova plan --json",
      "kova matrix plan --profile smoke --target runtime:stable",
      "kova matrix run --profile smoke --target runtime:stable --execute --json"
    ]
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (flags.plain === true) {
    for (const check of checks) {
      console.log(`${check.status} ${check.id}: ${check.message}`);
    }
    console.log("");
    console.log("Next:");
    for (const command of result.nextCommands) {
      console.log(`  ${command}`);
    }
  } else {
    console.log(renderSetup(result, flags));
  }

  if (!ok) {
    throw new Error("setup found missing required prerequisites");
  }
}

function rejectRemovedSetupFlags(flags) {
  if (flags.fallback_policy !== undefined) {
    throw new Error("--fallback-policy is not supported");
  }
}

async function runAuthSetup(flags) {
  const auth = await configureAuthFromFlags(flags, { defaultMethod: "mock" });

  const response = {
    schemaVersion: "kova.setup.auth.v1",
    generatedAt: new Date().toISOString(),
    ok: true,
    auth
  };

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  if (flags.plain === true) {
    console.log(`PASS credentials-dir: ${credentialsDir}`);
    console.log(`PASS providers: ${providersPath}`);
    console.log(`PASS live-env: ${liveEnvPath}`);
    console.log(`PASS provider ${response.auth.provider}: ${response.auth.method}`);
    return;
  }

  const authResult = {
    schemaVersion: "kova.setup.v1",
    generatedAt: response.generatedAt,
    mode: "auth",
    ok: true,
    auth: response.auth,
    checks: [
      { id: "credentials-dir", status: "PASS", message: credentialsDir },
      { id: "providers",       status: "PASS", message: providersPath },
      { id: "live-env",        status: "PASS", message: liveEnvPath },
      { id: `provider:${response.auth.provider}`, status: "PASS", message: response.auth.method },
    ],
    nextCommands: ["kova self-check", "kova plan --json"],
  };
  console.log(renderSetup(authResult, flags));
}

async function setupAuth(flags) {
  if (flags.ci === true && flags.auth === undefined && flags.method === undefined) {
    return configureAuthFromFlags({ ...flags, auth: "mock" }, { defaultMethod: "mock" });
  }
  if (flags.non_interactive === true || flags.auth !== undefined || flags.method !== undefined) {
    return configureAuthFromFlags(flags, { defaultMethod: "mock" });
  }
  if (!process.stdin.isTTY) {
    throw new Error("kova setup requires --non-interactive or --ci when stdin is not a TTY");
  }
  return interactiveAuthSetup(flags);
}

async function configureAuthFromFlags(flags, options = {}) {
  const method = setupAuthMethod(flags, options.defaultMethod ?? "mock");
  const provider = normalizeProvider(flags.provider ? String(flags.provider) : "openai");
  const envVar = flags.env_var ? String(flags.env_var) : undefined;
  const externalCli = method === "external-cli"
    ? resolveExternalCliName(provider, flags.external_cli ? String(flags.external_cli) : undefined)
    : undefined;
  const verification = method === "external-cli"
    ? await verifyExternalCliAuth(externalCli)
    : null;
  if (verification && !verification.verified) {
    throw new Error(`external-cli ${externalCli} is not usable: ${verification.reason}`);
  }
  const summary = await configureCredentialProvider({
    provider,
    method,
    envVar,
    value: flags.value ? String(flags.value) : undefined,
    externalCli
  });
  return {
    schemaVersion: "kova.setup.auth.result.v1",
    mode: method === "skip" ? "skip" : method === "mock" ? "mock" : "live",
    method,
    provider,
    externalCli: externalCli ?? null,
    verification: verification ? externalCliVerificationSummary(verification) : null,
    envVar: envVar ?? defaultEnvVarForProvider(provider),
    credentials: summary
  };
}

function setupAuthMethod(flags, defaultMethod) {
  const raw = flags.auth ?? flags.method ?? defaultMethod;
  const method = normalizeAuthMethod(String(raw));
  if (method === "live") {
    throw new Error("--auth live is for runs; setup needs --auth api-key, env-only, external-cli, oauth, mock, or skip");
  }
  return method;
}

async function interactiveAuthSetup(flags) {
  const output = flags.json ? process.stderr : process.stdout;
  writePromptLine(output, "Kova auth setup");
  writePromptLine(output);
  writePromptLine(output, "Choose provider:");
  writePromptLine(output, "  1. openai (default)");
  writePromptLine(output, "  2. anthropic");
  writePromptLine(output, "  3. custom-openai");
  writePromptLine(output, "  4. skip");
  const providerChoice = flags.provider
    ? String(flags.provider)
    : (await prompt("Provider [openai]: ", output)).trim().toLowerCase();
  const provider = providerFromChoice(providerChoice);
  if (provider === "skip") {
    return configureAuthFromFlags({
      ...flags,
      auth: "skip",
      provider: "openai"
    }, { defaultMethod: "mock" });
  }

  writePromptLine(output);
  writePromptLine(output, "Choose auth method:");
  writePromptLine(output, "  1. mock (default)");
  writePromptLine(output, "  2. env-only");
  writePromptLine(output, "  3. api-key");
  writePromptLine(output, "  4. external-cli");
  writePromptLine(output, "  5. oauth");
  writePromptLine(output, "  6. skip");
  const choice = (await prompt("Auth method [mock]: ", output)).trim().toLowerCase();
  const method = methodFromChoice(choice);
  const externalCli = method === "external-cli"
    ? externalCliForProvider(provider)
    : undefined;
  const envVar = method === "api-key" || method === "env-only"
    ? (await prompt(`Env var [${defaultEnvVarForProvider(provider)}]: `, output)).trim() || defaultEnvVarForProvider(provider)
    : undefined;
  const value = method === "api-key"
    ? await promptSecret(`Value for ${envVar} (leave empty to read host env): `, output)
    : undefined;
  return configureAuthFromFlags({
    ...flags,
    auth: method,
    provider,
    external_cli: externalCli,
    env_var: envVar,
    value: value || undefined
  }, { defaultMethod: "mock" });
}

function externalCliForProvider(provider) {
  const implied = impliedExternalCliForProvider(provider);
  if (implied) {
    return implied;
  }
  throw new Error("external-cli auth is only supported for provider openai or anthropic");
}

function methodFromChoice(choice) {
  if (!choice) {
    return "mock";
  }
  const byNumber = {
    1: "mock",
    2: "env-only",
    3: "api-key",
    4: "external-cli",
    5: "oauth",
    6: "skip"
  };
  if (byNumber[choice]) {
    return byNumber[choice];
  }
  return normalizeAuthMethod(choice);
}

function normalizeAuthMethod(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  const methods = new Set(["mock", "env-only", "api-key", "external-cli", "oauth", "skip"]);
  if (methods.has(normalized)) {
    return normalized;
  }
  throw new Error(`unknown auth method: ${value}`);
}

function providerFromChoice(choice) {
  const normalized = String(choice ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (!normalized) {
    return "openai";
  }
  const byNumber = {
    1: "openai",
    2: "anthropic",
    3: "custom-openai",
    4: "skip"
  };
  if (byNumber[normalized]) {
    return byNumber[normalized];
  }
  return normalizeProvider(normalized);
}

function normalizeProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  const providers = new Set(["openai", "anthropic", "custom-openai", "skip"]);
  if (providers.has(normalized)) {
    return normalized;
  }
  throw new Error(`unknown provider: ${value}`);
}

function prompt(question, output = process.stdout) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      cleanup();
      resolve(chunk.toString("utf8").replace(/\r?\n$/, ""));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("input ended before a value was submitted"));
    };
    process.stdin.once("data", onData);
    process.stdin.once("error", onError);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
    output.write(question);
  });
}

async function promptSecret(question, output = process.stdout) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("secret input requires a TTY");
  }

  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();

  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      try {
        input.setRawMode(wasRaw);
      } catch (restoreError) {
        error ??= restoreError;
      }
      if (wasPaused) {
        input.pause();
      }
      output.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("secret input cancelled"));
          return;
        }
        if (character === "\u0004") {
          finish(new Error("secret input ended before a value was submitted"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    };
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error("secret input ended before a value was submitted"));

    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onEnd);
    try {
      input.setRawMode(true);
      input.resume();
      output.write(question);
    } catch (error) {
      finish(error);
    }
  });
}

function nodeVersionCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= requiredNodeMajor;
  return {
    id: "node-version",
    required: true,
    status: ok ? "PASS" : "FAIL",
    expected: `>= ${requiredNodeMajor}`,
    actual: process.version,
    message: ok ? `Node ${process.version}` : `Node ${process.version}; expected >= ${requiredNodeMajor}`
  };
}

function commandAvailableCheck(command, args, options = {}) {
  const result = checkCommand(command, args);
  return {
    id: `${command}-available`,
    required: options.required === true,
    status: result.status === 0 ? "PASS" : "FAIL",
    command: [command, ...args].join(" "),
    message: result.status === 0 ? result.stdout.trim() : result.stderr.trim() || "not available"
  };
}

async function jsonCommandCheck(id, command, options) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  if (result.status !== 0) {
    return {
      id,
      required: options.required === true,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    if (!options.validate(data)) {
      throw new Error("unexpected JSON shape");
    }
    return {
      id,
      required: options.required === true,
      status: "PASS",
      command,
      durationMs: result.durationMs,
      message: "ok"
    };
  } catch (error) {
    return {
      id,
      required: options.required === true,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function directoryCheck(id, path) {
  const probePath = join(path, `.kova-write-probe-${process.pid}-${randomUUID()}`);
  let probe;
  try {
    await mkdir(path, { recursive: true });
    probe = await open(probePath, "wx", 0o600);
    await probe.writeFile("kova-write-probe\n", "utf8");
    await probe.close();
    probe = null;
    await unlink(probePath);
    return {
      id,
      required: true,
      status: "PASS",
      path,
      message: path
    };
  } catch (error) {
    await probe?.close().catch(() => {});
    await unlink(probePath).catch(() => {});
    return {
      id,
      required: true,
      status: "FAIL",
      path,
      message: error.message
    };
  }
}

function writePromptLine(output, value = "") {
  output.write(`${value}\n`);
}

async function mockProviderPackageCheck() {
  const bin = `${repoRoot}/node_modules/.bin/mock-ai-provider`;
  try {
    await access(bin, constants.X_OK);
    return {
      id: "mock-ai-provider",
      required: true,
      status: "PASS",
      path: bin,
      message: "local mock-ai-provider package is installed"
    };
  } catch (error) {
    return {
      id: "mock-ai-provider",
      required: true,
      status: "FAIL",
      path: bin,
      message: "Kova requires the npm package mock-ai-provider; run npm install in the Kova repo"
    };
  }
}

async function credentialStoreCheck(auth) {
  try {
    if (auth?.method === "external-cli" && auth?.verification?.verified !== true) {
      throw new Error(`external-cli ${auth?.externalCli ?? "unknown"} is not verified`);
    }
    const summary = await ensureCredentialStore();
    return {
      id: "credentials",
      required: true,
      status: "PASS",
      path: credentialsDir,
      providersPath,
      liveEnvPath,
      message: credentialStoreMessage(auth, summary)
    };
  } catch (error) {
    return {
      id: "credentials",
      required: true,
      status: "FAIL",
      path: credentialsDir,
      providersPath,
      liveEnvPath,
      message: error.message
    };
  }
}

function credentialStoreMessage(auth, summary) {
  const provider = auth?.provider ?? summary.defaultProvider;
  const method = auth?.method ?? summary.providers?.[summary.defaultProvider]?.method ?? "mock";
  if (method === "external-cli") {
    return `${provider} external-cli ${auth.externalCli} verified`;
  }
  return `${provider} ${method}`;
}

function defaultEnvVarForProvider(providerId) {
  if (providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return "OPENAI_API_KEY";
}

function skillGuidanceCheck() {
  return {
    id: "ocm-operator-skill",
    required: false,
    status: "INFO",
    message: "For Codex/agent runs from this repo, use .agents/skills/kova-operator and .agents/skills/ocm-operator"
  };
}
