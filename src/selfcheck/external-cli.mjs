import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { assertEqual } from "./harness.mjs";

export async function writeExternalCliFixture(directory, cli, options = {}) {
  const expectedArgs = cli === "codex"
    ? ["login", "status"]
    : ["auth", "status"];
  const lines = [
    `const args = process.argv.slice(2);`
  ];
  if (cli === "claude") {
    lines.push(
      `if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["auth", "status", "--help"]))}) {`,
      `  process.exit(${options.helpStatus ?? 0});`,
      `}`
    );
  }
  lines.push(
    `if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(expectedArgs))}) {`,
    `  process.exit(42);`,
    `}`
  );
  if (options.stderr) {
    lines.push(`console.error(${JSON.stringify(options.stderr)});`);
  }
  if (options.statusPayload) {
    lines.push(`console.log(${JSON.stringify(JSON.stringify(options.statusPayload))});`);
  }
  lines.push(`process.exit(${options.status ?? 0});`);

  const source = `${lines.join("\n")}\n`;
  if (process.platform === "win32") {
    const scriptName = `${cli}-fixture.mjs`;
    await writeFile(join(directory, scriptName), source, "utf8");
    await writeFile(
      join(directory, `${cli}.cmd`),
      `@echo off\r\nnode "%~dp0${scriptName}" %*\r\n`,
      "utf8"
    );
    return;
  }

  const executable = join(directory, cli);
  await writeFile(executable, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(executable, 0o755);
}

export function runNodeProcess(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/kova.mjs", ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: 127, stdout, stderr: error.message });
    });
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

export async function externalCliSetupCheck(tmp) {
  const home = join(tmp, "external-cli-home");
  const fakeBin = join(tmp, "fake-bin");
  const kovaHome = join(tmp, "external-cli-kova-home");
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExternalCliFixture(fakeBin, "codex", {
    stderr: "authenticated by native status"
  });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    "node bin/kova.mjs setup --non-interactive --provider openai --auth external-cli --json"
  ].join(" ");
  const result = await runCommand(command, { shell: "/bin/sh", timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "external cli setup schema");
    assertEqual(data.auth?.provider, "openai", "external cli provider");
    assertEqual(data.auth?.method, "external-cli", "external cli method");
    assertEqual(data.auth?.externalCli, "codex", "external cli name");
    assertEqual(data.auth?.verification?.verified, true, "external cli verification");
    assertEqual(data.auth?.verification?.authFiles?.length, 0, "external CLI verification avoids auth files");
    const credential = data.checks?.find((check) => check.id === "credentials");
    if (!credential || !credential.message.includes("external-cli codex verified")) {
      throw new Error(`credential check did not report verified external CLI: ${credential?.message ?? "missing"}`);
    }
    return {
      id: "setup-external-cli-verification",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "setup-external-cli-verification",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function externalCliProviderPairingCheck(tmp) {
  const directHome = join(tmp, "external-cli-mismatch-home");
  const direct = await runCommand(
    `KOVA_HOME=${quoteShell(directHome)} node bin/kova.mjs setup auth --provider openai --method external-cli --external-cli claude --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  const persistedHome = join(tmp, "external-cli-persisted-mismatch-home");
  const credentials = join(persistedHome, "credentials");
  await mkdir(credentials, { recursive: true });
  await writeFile(join(credentials, "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "external-cli",
        envVars: [],
        externalCli: "claude",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(credentials, "live.env"), "", { encoding: "utf8", mode: 0o600 });
  const persisted = await runCommand(
    `KOVA_HOME=${quoteShell(persistedHome)} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  const directOutput = `${direct.stdout}\n${direct.stderr}`;
  const persistedOutput = `${persisted.stdout}\n${persisted.stderr}`;
  const ok = direct.status !== 0 &&
    directOutput.includes("provider openai uses external CLI codex") &&
    persisted.status !== 0 &&
    persistedOutput.includes("provider openai uses external CLI codex");
  return {
    id: "external-cli-provider-pairing",
    status: ok ? "PASS" : "FAIL",
    command: "reject direct and persisted OpenAI/Claude CLI mismatches",
    durationMs: direct.durationMs + persisted.durationMs,
    message: ok ? "" : `direct: ${directOutput.trim()}\npersisted: ${persistedOutput.trim()}`
  };
}

export async function directCredentialProviderPairingCheck(tmp) {
  const home = join(tmp, "direct-credential-provider-home");
  const scriptPath = join(tmp, "direct-credential-provider.mjs");
  await writeFile(scriptPath, `import { configureCredentialProvider } from ${JSON.stringify(new URL("../auth.mjs", import.meta.url).href)};
await configureCredentialProvider({ provider: "openai", method: "external-cli" });
await configureCredentialProvider({ provider: "anthropic", method: "external-cli" });
`, "utf8");
  const command = `KOVA_HOME=${quoteShell(home)} node ${quoteShell(scriptPath)}`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const providers = JSON.parse(await readFile(join(home, "credentials", "providers.json"), "utf8"));
    assertEqual(providers.providers?.openai?.externalCli, "codex", "direct OpenAI CLI pairing");
    assertEqual(providers.providers?.anthropic?.externalCli, "claude", "direct Anthropic CLI pairing");
    return {
      id: "credential-provider-direct-pairing",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "credential-provider-direct-pairing",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function claudeCliLoggedOutCheck(tmp) {
  const fakeBin = join(tmp, "logged-out-claude-bin");
  const home = join(tmp, "logged-out-claude-home");
  await mkdir(fakeBin, { recursive: true });
  await writeExternalCliFixture(fakeBin, "claude", {
    statusPayload: {
      loggedIn: false,
      email: "must-not-leak@example.invalid"
    }
  });
  const command = [
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(home)}`,
    "node bin/kova.mjs setup --non-interactive --provider anthropic --auth external-cli --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  await writeExternalCliFixture(fakeBin, "claude", {
    helpStatus: 42
  });
  const unsupportedCommand = [
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(join(tmp, "unsupported-claude-home"))}`,
    "node bin/kova.mjs setup --non-interactive --provider anthropic --auth external-cli --json"
  ].join(" ");
  const unsupported = await runCommand(unsupportedCommand, {
    timeoutMs: 30000,
    maxOutputChars: 1000000
  });
  const unsupportedOutput = `${unsupported.stdout}\n${unsupported.stderr}`;
  const ok = result.status !== 0 &&
    output.includes("external-cli claude is not usable") &&
    !output.includes("must-not-leak@example.invalid") &&
    unsupported.status !== 0 &&
    unsupportedOutput.includes("update Claude Code");
  return {
    id: "claude-cli-native-logged-out-status",
    status: ok ? "PASS" : "FAIL",
    command: `${command}; ${unsupportedCommand}`,
    durationMs: result.durationMs + unsupported.durationMs,
    message: ok
      ? ""
      : `logged out: ${result.status}: ${output.trim()}\nunsupported: ${unsupported.status}: ${unsupportedOutput.trim()}`
  };
}

export async function externalCliSetupRejectsUnauthenticatedCheck(tmp) {
  const fakeBin = join(tmp, "unauthenticated-codex-bin");
  const home = join(tmp, "unauthenticated-codex-home");
  await mkdir(fakeBin, { recursive: true });
  await writeExternalCliFixture(fakeBin, "codex", {
    status: 1
  });
  const command = [
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(home)}`,
    "node bin/kova.mjs setup --non-interactive --provider openai --auth external-cli --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id: "setup-external-cli-verifies-auth",
    status: result.status !== 0 && output.includes("external-cli codex is not usable") ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes("external-cli codex is not usable")
      ? ""
      : `expected native auth status failure, got ${result.status}: ${output.trim()}`
  };
}

export async function externalCliOpenClawConfigCheck(tmp) {
  const home = join(tmp, "external-cli-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider openai --auth-method external-cli --external-cli codex"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.agents?.defaults?.model?.primary, "codex/gpt-5.5", "external cli model ref");
    assertEqual(config.agents?.defaults?.agentRuntime?.id, "codex", "external cli runtime id");
    assertEqual(config.agents?.defaults?.agentRuntime?.fallback, "none", "external cli runtime fallback");
    assertEqual(config.plugins?.entries?.codex?.enabled, true, "external cli codex plugin enabled");
    if (config.models?.providers?.openai !== undefined) {
      throw new Error("Codex external CLI config must not write an OpenAI provider override");
    }
    if (config.models?.providers?.codex !== undefined) {
      throw new Error("Codex external CLI config must use the bundled codex provider instead of writing a provider override");
    }
    return {
      id: "external-cli-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "external-cli-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function anthropicApiKeyOpenClawConfigCheck(tmp) {
  const home = join(tmp, "anthropic-api-key-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider anthropic --env-var ANTHROPIC_API_KEY"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.anthropic?.apiKey?.id, "ANTHROPIC_API_KEY", "anthropic env ref");
    assertEqual(
      config.models?.providers?.anthropic?.agentRuntime?.id,
      "openclaw",
      "anthropic API-key provider runtime id"
    );
    assertEqual(config.agents?.defaults?.model?.primary, "anthropic/claude-sonnet-4-5", "anthropic default model");
    return {
      id: "anthropic-api-key-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "anthropic-api-key-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function mockAuthOpenClawConfigCheck(tmp) {
  const portFile = join(tmp, "mock-auth-port");
  await writeFile(portFile, "12345\n", "utf8");
  const contracts = [
    {
      id: "canonical",
      configContract: "canonical",
      home: join(tmp, "mock-auth-config-canonical"),
      providerId: "openai"
    },
    {
      id: "legacy-list",
      configContract: "legacy-list",
      home: join(tmp, "mock-auth-config-legacy"),
      providerId: "openai"
    },
    {
      id: "canonical-provider-alias",
      configContract: "canonical",
      home: join(tmp, "mock-auth-config-provider-alias"),
      providerId: "x-ai"
    }
  ];
  const commands = [];
  let durationMs = 0;
  try {
    for (const contract of contracts) {
      if (contract.providerId === "x-ai") {
        const stateDir = join(contract.home, ".openclaw");
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          join(stateDir, "openclaw.json"),
          `${JSON.stringify({
            models: {
              providers: {
                openai: {
                  request: {
                    openaiOnly: true
                  }
                },
                "x-ai": {
                  request: {
                    aliasOnly: true
                  }
                }
              }
            }
          }, null, 2)}\n`,
          "utf8"
        );
      }
      const command = [
        `KOVA_OPENCLAW_CONFIG_CONTRACT=${contract.configContract}`,
        `OPENCLAW_HOME=${quoteShell(contract.home)}`,
        `node support/configure-openclaw-mock-auth.mjs --port-file ${quoteShell(portFile)} --provider-id ${contract.providerId} --skip-health-check --gateway-http-endpoint chatCompletions`
      ].join(" ");
      commands.push(command);
      const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
      durationMs += result.durationMs;
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
      }
      const config = JSON.parse(
        await readFile(join(contract.home, ".openclaw", "openclaw.json"), "utf8")
      );
      const provider = config.models?.providers?.[contract.providerId];
      assertEqual(provider?.baseUrl, "http://127.0.0.1:12345/v1", `${contract.id} mock provider base URL`);
      assertEqual(
        config.agents?.defaults?.model?.primary,
        `${contract.providerId}/gpt-5.5`,
        `${contract.id} mock default model`
      );
      assertEqual(config.gateway?.auth?.mode, "token", "mock gateway token mode");
      assertEqual(config.gateway?.auth?.token, "kova-mock-gateway-token", "mock gateway auth token");
      assertEqual(config.gateway?.remote?.token, "kova-mock-gateway-token", "mock gateway remote token");
      assertEqual(config.gateway?.http?.endpoints?.chatCompletions?.enabled, true, "mock gateway chat completions endpoint enabled");
      if (contract.providerId === "x-ai") {
        assertEqual(provider?.request?.aliasOnly, true, "provider alias request settings");
        assertEqual(provider?.request?.openaiOnly, undefined, "provider alias excludes OpenAI request settings");
      }
      if (contract.id === "legacy-list") {
        assertEqual(Array.isArray(config.agents?.list), true, "legacy mock config agent list");
        assertEqual(config.agents?.entries, undefined, "legacy mock config omits agent entries");
        assertEqual(
          config.agents?.defaults?.imageGenerationModel?.primary,
          `${contract.providerId}/gpt-image-1`,
          `${contract.id} mock image model`
        );
        assertEqual(config.agents?.defaults?.mediaModels, undefined, "legacy mock config omits media models");
      } else {
        assertEqual(config.agents?.entries?.main?.default, true, "canonical mock config agent entry");
        assertEqual(config.agents?.list, undefined, "canonical mock config omits agent list");
        assertEqual(
          config.agents?.defaults?.mediaModels?.image?.primary,
          `${contract.providerId}/gpt-image-1`,
          `${contract.id} mock image model`
        );
        assertEqual(
          config.agents?.defaults?.mediaModels?.video?.primary,
          `${contract.providerId}/sora-2`,
          `${contract.id} mock video model`
        );
        assertEqual(
          config.agents?.defaults?.imageGenerationModel,
          undefined,
          "canonical mock config omits legacy image model"
        );
      }
    }
    return {
      id: "mock-auth-openclaw-config",
      status: "PASS",
      command: commands.join(" && "),
      durationMs
    };
  } catch (error) {
    return {
      id: "mock-auth-openclaw-config",
      status: "FAIL",
      command: commands.join(" && "),
      durationMs,
      message: error.message
    };
  }
}

export async function claudeCliOpenClawConfigCheck(tmp) {
  const home = join(tmp, "claude-cli-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider anthropic --auth-method external-cli --external-cli claude"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.agents?.defaults?.model?.primary, "anthropic/claude-sonnet-4-5", "claude cli model ref");
    assertEqual(config.agents?.defaults?.agentRuntime?.id, "claude-cli", "claude cli runtime id");
    assertEqual(config.agents?.defaults?.agentRuntime?.fallback, "none", "claude cli runtime fallback");
    assertEqual(config.plugins?.entries?.anthropic?.enabled, true, "claude cli anthropic plugin enabled");
    if (config.models?.providers?.anthropic !== undefined) {
      throw new Error("Claude CLI config must use the bundled Anthropic provider instead of writing a provider override");
    }
    return {
      id: "claude-cli-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "claude-cli-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function externalCliRunAuthVerificationCheck(tmp) {
  const home = join(tmp, "stale-external-cli-home");
  const kovaHome = join(tmp, "stale-external-cli-kova-home");
  const fakeBin = join(tmp, "stale-external-cli-bin");
  const credentials = join(kovaHome, "credentials");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(credentials, { recursive: true });
  await writeExternalCliFixture(fakeBin, "codex", {
    status: 1,
    stderr: "stale auth rejected"
  });
  await writeFile(join(credentials, "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "external-cli",
        envVars: [],
        externalCli: "codex",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(credentials, "live.env"), "", { encoding: "utf8", mode: 0o600 });
  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id: "run-external-cli-revalidates-auth",
    status: result.status !== 0 && output.includes("external-cli codex is not usable") ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes("external-cli codex is not usable")
      ? ""
      : `expected stale external CLI failure, got status ${result.status}: ${output.trim()}`
  };
}
