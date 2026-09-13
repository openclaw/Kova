import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { assertEqual } from "./harness.mjs";

export async function concurrentAgentRunnerCheck(tmp, scope) {
  const fakeBin = join(tmp, "concurrent-agent-runner-bin");
  const fakeOcm = join(fakeBin, "ocm");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({ finalAssistantVisibleText: 'KOVA_AGENT_OK' }) + '\\n');"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const command = `node support/run-concurrent-agent-turns.mjs --env ${quoteShell(scope.envName)} --count 2 --session-prefix ${quoteShell(scope.sessionPrefix)} --message hi --expected-text KOVA_AGENT_OK --timeout 5`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 10000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`
    }
  });
  try {
    if (result.status !== 0) {
      throw new Error(`concurrent agent runner failed: ${result.stderr || result.stdout}`);
    }
    const summary = JSON.parse(result.stdout);
    assertEqual(summary.schemaVersion, "kova.concurrentAgentTurns.v1", "concurrent runner schema");
    assertEqual(summary.ok, true, "concurrent runner ok");
    assertEqual(summary.count, 2, "concurrent runner count");
    assertEqual(summary.successCount, 2, "concurrent runner success count");
    assertEqual(summary.turns.every((turn) => turn.expectedTextPresent === true), true, "all concurrent turns included expected text");
    return {
      id: "concurrent-agent-runner",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "concurrent-agent-runner",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function officialPluginInstallRunnerCheck(tmp, scope) {
  const fakeBin = join(tmp, "official-plugin-runner-bin");
  const fakeOcm = join(fakeBin, "ocm");
  const artifactDir = join(tmp, "official-plugin-runner-artifacts");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const text = process.argv.slice(2).join(' ');",
    "const envName = process.env.KOVA_SELF_CHECK_ENV;",
    "if (text.includes('@' + envName + ' -- plugins install @openclaw/discord')) {",
    "  if (process.env.KOVA_FAKE_OCM_SECURITY_BLOCK === '1') {",
    "    process.stderr.write('WARNING: Plugin \"discord\" contains dangerous code patterns: credential harvesting\\n');",
    "    process.exit(1);",
    "  }",
    "  process.stdout.write('installed @openclaw/discord\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('@' + envName + ' -- plugins list')) {",
    "  process.stdout.write('discord @openclaw/discord\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('@' + envName + ' -- plugins registry --refresh --json')) {",
    "  process.stdout.write(JSON.stringify({ plugins: [{ id: 'discord' }] }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('@' + envName + ' -- status')) {",
    "  process.stdout.write('status ok\\n');",
    "  process.exit(0);",
    "}",
    "if (text.includes('logs ' + envName + ' --tail 400 --raw')) {",
    "  process.stdout.write('[plugins] diagnostic log line\\n');",
    "  process.exit(0);",
    "}",
    "process.stderr.write('unexpected fake ocm command: ' + text + '\\n');",
    "process.exit(2);"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const commandEnv = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    KOVA_SELF_CHECK_ENV: scope.envName
  };
  const successCommand = `node support/run-official-plugin-install.mjs --env ${quoteShell(scope.envName)} --state states/official-plugins.json --artifact-dir ${quoteShell(artifactDir)} --timeout-ms 5000`;
  const success = await runCommand(successCommand, {
    shell: "/bin/sh",
    timeoutMs: 10000,
    maxOutputChars: 1000000,
    env: commandEnv
  });
  const blockedCommand = `node support/run-official-plugin-install.mjs --env ${quoteShell(scope.envName)} --state states/official-plugins.json --artifact-dir ${quoteShell(join(tmp, "official-plugin-blocked-artifacts"))} --timeout-ms 5000`;
  const blocked = await runCommand(blockedCommand, {
    shell: "/bin/sh",
    timeoutMs: 10000,
    maxOutputChars: 1000000,
    env: {
      ...commandEnv,
      KOVA_FAKE_OCM_SECURITY_BLOCK: "1"
    }
  });

  try {
    if (success.status !== 0) {
      throw new Error(`official plugin runner success path failed: ${success.stderr || success.stdout}`);
    }
    const successSummary = JSON.parse(success.stdout);
    assertEqual(successSummary.schemaVersion, "kova.officialPluginInstall.v1", "official plugin runner schema");
    assertEqual(successSummary.ok, true, "official plugin runner ok");
    assertEqual(successSummary.pluginCount >= 1, true, "official plugin runner plugin count");
    assertEqual(successSummary.pluginResults?.[0]?.package, "@openclaw/discord", "official plugin package");

    if (blocked.status === 0) {
      throw new Error("official plugin runner security-block path should fail");
    }
    const blockedSummary = JSON.parse(blocked.stdout);
    assertEqual(blockedSummary.securityBlocked, true, "official plugin runner security blocked");
    assertEqual(blockedSummary.securityBlockCount, 1, "official plugin runner security block count");
    assertEqual(blockedSummary.failureEvidence?.length, 1, "official plugin runner failure evidence");
    assertEqual(blockedSummary.failureEvidence?.[0]?.diagnostics?.some((step) => step.id === "diagnostic-logs:discord"), true, "official plugin runner diagnostic logs");
    return {
      id: "official-plugin-install-runner",
      status: "PASS",
      command: successCommand,
      durationMs: success.durationMs + blocked.durationMs
    };
  } catch (error) {
    return {
      id: "official-plugin-install-runner",
      status: "FAIL",
      command: successCommand,
      durationMs: success.durationMs + blocked.durationMs,
      message: error.message
    };
  }
}

export async function soakLoopRunnerCheck(tmp, scope) {
  const fakeBin = join(tmp, "soak-loop-runner-bin");
  const fakeOcm = join(fakeBin, "ocm");
  const gatewayPort = 39291;
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'service' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({ gatewayState: 'running', running: true, gatewayPort: Number(process.env.KOVA_FAKE_PORT) }) + '\\n');",
    "  process.exit(0);",
    "}",
    "process.stdout.write('ok\\n');"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const frontagePort = server.address().port;
  const command = `node support/run-soak-loop.mjs --env ${quoteShell(scope.envName)} --duration-ms 50 --interval-ms 0 --timeout-ms 5000`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 10000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      KOVA_FAKE_PORT: String(gatewayPort),
      KOVA_NETWORK_FRONTAGE_ENABLED: "1",
      KOVA_NETWORK_FRONTAGE_HOST: "127.0.0.1",
      KOVA_NETWORK_FRONTAGE_PORT: String(frontagePort)
    }
  });
  try {
    if (result.status !== 0) {
      throw new Error(`soak loop runner failed: ${result.stderr || result.stdout}`);
    }
    const summary = JSON.parse(result.stdout);
    assertEqual(summary.schemaVersion, "kova.soakLoop.v1", "soak loop schema");
    assertEqual(summary.iterations >= 1, true, "soak loop iterations");
    assertEqual(summary.commandSummary.failureCount, 0, "soak loop command failures");
    assertEqual(summary.healthSummary.failureCount, 0, "soak loop health failures");
    assertEqual(summary.commandSummary.byId.status.count >= 1, true, "soak loop status command count");
    assertEqual(summary.healthSamples?.[0]?.gatewayPort, gatewayPort, "soak loop preserves gateway metadata port");
    assertEqual(summary.healthSamples?.[0]?.gateway?.source, "network-frontage", "soak loop health uses frontage endpoint");
    assertEqual(summary.healthSamples?.[0]?.gateway?.port, frontagePort, "soak loop health uses frontage port");
    return {
      id: "soak-loop-runner",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "soak-loop-runner",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function openAiCompatibleTurnFrontageCheck(tmp, scope) {
  const fakeBin = join(tmp, "openai-compatible-frontage-bin");
  const fakeOcm = join(fakeBin, "ocm");
  const home = join(tmp, "openai-compatible-frontage-home");
  const packageRoot = join(tmp, "openai-compatible-frontage-runtime");
  const gatewayPort = 39292;
  let hitCount = 0;
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(home, ".openclaw"), { recursive: true });
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify({
    gateway: {
      port: gatewayPort,
      auth: { token: "kova-openai-compatible-token" }
    }
  }), "utf8");
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'env' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({ root: process.env.KOVA_FAKE_ROOT, gatewayPort: Number(process.env.KOVA_FAKE_GATEWAY_PORT) }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'env' && args[1] === 'resolve') {",
    "  process.stdout.write(JSON.stringify({ binaryPath: process.env.KOVA_FAKE_BINARY_PATH, bindingKind: 'runtime', bindingName: 'stable', runtimeReleaseVersion: 'self-check', runtimeReleaseChannel: 'stable', runtimeSourceKind: 'mock' }) + '\\n');",
    "  process.exit(0);",
    "}",
    "console.error('unexpected ocm args: ' + args.join(' '));",
    "process.exit(1);"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const server = createServer((request, response) => {
    hitCount += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: "KOVA_AGENT_OK"
        }
      }]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const frontagePort = server.address().port;
  const command = `node support/run-openai-compatible-turn.mjs --env ${quoteShell(scope.envName)} --expected-text KOVA_AGENT_OK --timeout 5000`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 10000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      KOVA_FAKE_ROOT: home,
      KOVA_FAKE_GATEWAY_PORT: String(gatewayPort),
      KOVA_FAKE_BINARY_PATH: join(packageRoot, "bin", "openclaw"),
      KOVA_NETWORK_FRONTAGE_ENABLED: "1",
      KOVA_NETWORK_FRONTAGE_HOST: "127.0.0.1",
      KOVA_NETWORK_FRONTAGE_PORT: String(frontagePort)
    },
    redactValues: ["kova-openai-compatible-token"]
  });
  try {
    if (result.status !== 0) {
      throw new Error(`OpenAI-compatible frontage check failed: ${result.stderr || result.stdout}`);
    }
    const summary = JSON.parse(result.stdout);
    assertEqual(hitCount, 1, "OpenAI-compatible helper uses injected frontage endpoint");
    assertEqual(summary.ok, true, "OpenAI-compatible helper ok");
    assertEqual(summary.expectedTextPresent, true, "OpenAI-compatible expected text present");
    assertEqual(summary.gateway?.source, "network-frontage", "OpenAI-compatible gateway source");
    assertEqual(summary.gateway?.port, frontagePort, "OpenAI-compatible gateway frontage port");
    return {
      id: "openai-compatible-turn-frontage",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "openai-compatible-turn-frontage",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
