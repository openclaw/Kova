import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { writeExternalCliFixture } from "./external-cli.mjs";
import { fakeOcmScript } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export async function liveApiKeyExecutionCheck(tmp) {
  const home = join(tmp, "live-api-key-home");
  const reportDir = join(tmp, "live-api-key-report");
  const openclawHome = join(tmp, "live-api-key-openclaw-home");
  const binDir = join(tmp, "live-api-key-bin");
  const ocmLog = join(tmp, "live-api-key-ocm.log");
  const secret = "kova-live-secret-selfcheck";
  await mkdir(join(home, "credentials"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(home, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "api-key",
        envVars: ["OPENAI_API_KEY"],
        externalCli: null,
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(home, "credentials", "live.env"), `OPENAI_API_KEY=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(binDir, "ocm"), fakeOcmScript(), "utf8");
  await chmod(join(binDir, "ocm"), 0o755);

  const command = [
    `KOVA_HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${binDir}:${process.env.PATH}`)}`,
    `KOVA_FAKE_OPENCLAW_HOME=${quoteShell(openclawHome)}`,
    `KOVA_MOCK_OCM_LOG=${quoteShell(ocmLog)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --model gpt-5.6 --execute --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { shell: "/bin/sh", timeoutMs: 30000, maxOutputChars: 1000000, redactValues: [secret] });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const reportText = await readFile(receipt.jsonPath, "utf8");
    if (reportText.includes(secret)) {
      throw new Error("live API key leaked into JSON report");
    }
    const report = JSON.parse(reportText);
    const record = report.records?.[0];
    assertEqual(report.auth?.requestedMode, "live", "report requested live auth");
    assertEqual(report.auth?.modelId, "gpt-5.6", "report requested live model");
    assertEqual(report.auth?.live?.environmentDependent, true, "top-level live env-dependent flag");
    assertEqual(record?.auth?.mode, "live", "record live auth mode");
    assertEqual(record?.auth?.source, "api-key", "record live auth source");
    assertEqual(record?.auth?.setupKind, "openclaw-onboard", "record live setup kind");
    assertEqual(record?.auth?.modelId, "gpt-5.6", "record requested live model");
    assertEqual(record?.auth?.environmentDependent, true, "record live env-dependent flag");
    assertEqual(record?.auth?.secretValues, "redacted", "record secret values redacted");
    assertEqual(record?.providerEvidence?.environmentDependent, true, "provider evidence live env-dependent flag");
    const config = JSON.parse(await readFile(join(openclawHome, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.openai?.apiKey?.id, "OPENAI_API_KEY", "OpenClaw live config env ref");
    assertEqual(
      config.models?.providers?.openai?.agentRuntime?.id,
      "openclaw",
      "OpenClaw live provider stays on the timeline-emitting harness"
    );
    assertEqual(config.agents?.defaults?.model?.primary, "openai/gpt-5.6", "OpenClaw live model override");
    assertEqual(
      config.models?.providers?.openai?.models?.some((model) => model.id === "gpt-5.6"),
      true,
      "OpenClaw live model registration"
    );
    const authSetupCommands = record.phases
      ?.find((phase) => phase.id === "auth-setup")
      ?.commands ?? [];
    assertEqual(authSetupCommands.length, 2, "live model override runs after OpenClaw onboarding");
    assertEqual(authSetupCommands[0]?.includes("onboard"), true, "live model override keeps OpenClaw onboarding");
    assertEqual(
      authSetupCommands[1]?.includes("configure-openclaw-live-auth.mjs") &&
        authSetupCommands[1]?.includes("--model") &&
        authSetupCommands[1]?.includes("gpt-5.6"),
      true,
      "live model override registers the explicit provider model"
    );
    const serializedConfig = JSON.stringify(config);
    if (serializedConfig.includes(secret)) {
      throw new Error("live API key leaked into OpenClaw config");
    }
    const statusResult = record.phases
      ?.flatMap((phase) => phase.results ?? [])
      ?.find((item) => item.command.includes(" -- status"));
    if (!statusResult || statusResult.stdout.includes(secret) || !statusResult.stdout.includes("[REDACTED]")) {
      throw new Error("live command env was not redacted in command output");
    }
    const overrideResult = await runCommand([
      `KOVA_HOME=${quoteShell(home)}`,
      `PATH=${quoteShell(`${binDir}:${process.env.PATH}`)}`,
      `KOVA_FAKE_OPENCLAW_HOME=${quoteShell(openclawHome)}`,
      `KOVA_MOCK_OCM_LOG=${quoteShell(ocmLog)}`,
      `node bin/kova.mjs run --target runtime:stable --scenario agent-cold-warm-message --state mock-openai-provider --auth live --model gpt-5.6 --report-dir ${quoteShell(reportDir)} --json`
    ].join(" "), {
      shell: "/bin/sh",
      timeoutMs: 30000,
      maxOutputChars: 1000000,
      redactValues: [secret]
    });
    if (overrideResult.status !== 0) {
      throw new Error(overrideResult.stderr.trim() || overrideResult.stdout.trim() || `override exit ${overrideResult.status}`);
    }
    const overrideReceipt = JSON.parse(overrideResult.stdout);
    const overrideReport = JSON.parse(await readFile(overrideReceipt.jsonPath, "utf8"));
    assertEqual(overrideReport.records?.[0]?.auth?.mode, "live", "explicit live auth overrides mock state auth");
    return {
      id: "live-api-key-execution",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-api-key-execution",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function liveExternalCliDryRunCheck(tmp) {
  const home = join(tmp, "live-external-cli-home");
  const kovaHome = join(tmp, "live-external-cli-kova-home");
  const fakeBin = join(tmp, "live-external-cli-bin");
  const reportDir = join(tmp, "live-external-cli-report");
  await mkdir(home, { recursive: true });
  await mkdir(join(kovaHome, "credentials"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExternalCliFixture(fakeBin, "codex", {
    stderr: "native codex auth status"
  });
  await writeFile(join(kovaHome, "credentials", "providers.json"), `${JSON.stringify({
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
  await writeFile(join(kovaHome, "credentials", "live.env"), "", { encoding: "utf8", mode: 0o600 });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --model gpt-5.6 --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { shell: "/bin/sh", timeoutMs: 30000, maxOutputChars: 1000000 });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const record = report.records?.[0];
    assertEqual(report.auth?.requestedMode, "live", "external cli requested live auth");
    assertEqual(report.auth?.live?.method, "external-cli", "external cli live method");
    assertEqual(report.auth?.live?.verification?.verified, true, "external cli verification");
    assertEqual(record?.auth?.mode, "live", "external cli record live mode");
    assertEqual(record?.auth?.source, "external-cli", "external cli record source");
    assertEqual(record?.auth?.externalCli, "codex", "external cli record name");
    assertEqual(record?.auth?.setupKind, "fixture-config-patch", "codex cli fixture setup kind");
    assertEqual(record?.auth?.modelId, "gpt-5.6", "external cli requested model");
    const authSetupCommands = record.phases
      ?.find((phase) => phase.id === "auth-setup")
      ?.commands ?? [];
    const authSetupCommand = authSetupCommands
      .find((item) => item.includes("configure-openclaw-live-auth.mjs")) ?? "";
    if (!/'?--auth-method'?\s+'?external-cli'?/.test(authSetupCommand) || !/'?--external-cli'?\s+'?codex'?/.test(authSetupCommand)) {
      throw new Error(`external-cli auth setup command missing expected args: ${authSetupCommand}`);
    }
    assertEqual(
      authSetupCommand.includes("--model") && authSetupCommand.includes("gpt-5.6"),
      true,
      "external cli config registers the requested model"
    );
    return {
      id: "live-external-cli-dry-run",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-external-cli-dry-run",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function liveAnthropicExternalCliDryRunCheck(tmp) {
  const home = join(tmp, "live-anthropic-cli-home");
  const kovaHome = join(tmp, "live-anthropic-cli-kova-home");
  const fakeBin = join(tmp, "live-anthropic-cli-bin");
  const reportDir = join(tmp, "live-anthropic-cli-report");
  await mkdir(home, { recursive: true });
  await mkdir(join(kovaHome, "credentials"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExternalCliFixture(fakeBin, "claude", {
    statusPayload: {
      loggedIn: true,
      email: "must-not-leak@example.invalid"
    }
  });
  await writeFile(join(kovaHome, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        id: "anthropic",
        method: "external-cli",
        envVars: [],
        externalCli: "claude",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(kovaHome, "credentials", "live.env"), "", { encoding: "utf8", mode: 0o600 });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { shell: "/bin/sh", timeoutMs: 30000, maxOutputChars: 1000000 });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const record = report.records?.[0];
    assertEqual(report.auth?.live?.method, "external-cli", "anthropic external cli live method");
    assertEqual(report.auth?.live?.externalCli, "claude", "anthropic external cli name");
    assertEqual(record?.auth?.mode, "live", "anthropic cli record live mode");
    assertEqual(record?.auth?.providerId, "anthropic", "anthropic cli provider");
    assertEqual(record?.auth?.setupKind, "openclaw-onboard", "anthropic cli onboard setup");
    const authSetupCommand = record.phases
      ?.flatMap((phase) => phase.commands ?? [])
      ?.find((item) => item.includes("onboard")) ?? "";
    if (!authSetupCommand.includes("--auth-choice") || !authSetupCommand.includes("anthropic-cli")) {
      throw new Error(`anthropic external-cli auth setup command missing OpenClaw onboard path: ${authSetupCommand}`);
    }
    return {
      id: "live-anthropic-external-cli-dry-run",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-anthropic-external-cli-dry-run",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}
