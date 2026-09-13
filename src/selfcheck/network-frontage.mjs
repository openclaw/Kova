import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { resolveGatewayEndpoint } from "../../support/gateway-endpoint.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
import { measurementScopeForPhase } from "../measurement-contract.mjs";
import {
  assertNetworkFrontageCommandSafe,
  networkFrontageCommandEnv,
  stopNetworkFrontage,
  waitForProxyReady,
  waitForTcp
} from "../network-frontage.mjs";
import { ocmEnvProtect } from "../ocm/commands.mjs";
import { runScenarioCommand } from "../run/command-executor.mjs";
import { assertEqual, restoreEnv, selfCheckPath, snapshotEnv } from "./harness.mjs";

export async function networkFrontageNoChildTcpCheck() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await waitForTcp("127.0.0.1", address.port, 1000);
    return {
      id: "network-frontage-no-child-tcp",
      status: "PASS",
      command: "wait for TCP validation probe without child process",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-frontage-no-child-tcp",
      status: "FAIL",
      command: "wait for TCP validation probe without child process",
      durationMs: 0,
      message: error.message
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export function networkFrontageProductGuardCheck() {
  try {
    const context = {
      networkFrontage: {
        enabled: true
      }
    };
    const authProbe = "node -e 'fetch(\"http://127.0.0.1:12345/health\")'";
    const productProbe = "node -e 'fetch(\"http://127.0.0.1:12345/health\")'";
    let productRejected = false;

    if (measurementScopeForPhase({ id: "auth-prepare", commands: [authProbe] }) === "product") {
      assertNetworkFrontageCommandSafe(authProbe, context);
    }
    try {
      if (measurementScopeForPhase({ id: "agent-turn", commands: [productProbe] }) === "product") {
        assertNetworkFrontageCommandSafe(productProbe, context);
      }
    } catch (error) {
      productRejected = /forbids fixed loopback URLs/.test(error.message);
    }
    assertEqual(productRejected, true, "product fixed loopback URL is rejected");

    return {
      id: "network-frontage-product-guard",
      status: "PASS",
      command: "verify network frontage guard applies only to product commands",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-frontage-product-guard",
      status: "FAIL",
      command: "verify network frontage guard applies only to product commands",
      durationMs: 0,
      message: error.message
    };
  }
}

export function networkFrontageRuntimeEnvCheck() {
  try {
    const env = networkFrontageCommandEnv({
      networkFrontage: { enabled: true },
      networkFrontageAllocation: {
        status: "active",
        frontageHost: "127.0.1.17",
        frontagePort: 19876
      }
    });
    assertEqual(env.KOVA_NETWORK_FRONTAGE_ENABLED, "1", "frontage env enabled");
    assertEqual(env.KOVA_NETWORK_FRONTAGE_HOST, "127.0.1.17", "frontage env host");
    assertEqual(env.KOVA_NETWORK_FRONTAGE_PORT, "19876", "frontage env port");
    assertEqual(env.KOVA_NETWORK_FRONTAGE_WS_URL, "ws://127.0.1.17:19876", "frontage env websocket URL");
    assertEqual(Object.keys(networkFrontageCommandEnv({ networkFrontage: { enabled: true } })).length, 0, "inactive frontage env omitted");

    return {
      id: "network-frontage-runtime-env",
      status: "PASS",
      command: "verify active network frontage env contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-frontage-runtime-env",
      status: "FAIL",
      command: "verify active network frontage env contract",
      durationMs: 0,
      message: error.message
    };
  }
}

export function networkFrontageHelperEndpointCheck() {
  const previous = snapshotEnv([
    "KOVA_NETWORK_FRONTAGE_ENABLED",
    "KOVA_NETWORK_FRONTAGE_HOST",
    "KOVA_NETWORK_FRONTAGE_PORT",
    "KOVA_NETWORK_FRONTAGE_WS_URL"
  ]);
  try {
    delete process.env.KOVA_NETWORK_FRONTAGE_ENABLED;
    delete process.env.KOVA_NETWORK_FRONTAGE_HOST;
    delete process.env.KOVA_NETWORK_FRONTAGE_PORT;
    delete process.env.KOVA_NETWORK_FRONTAGE_WS_URL;
    const fallback = resolveGatewayEndpoint({ gatewayPort: 18789 }, { gateway: { port: 18789 } }, { protocol: "ws" });
    assertEqual(fallback.source, "ocm-env-metadata", "helper fallback source");
    assertEqual(fallback.url, "ws://127.0.0.1:18789", "helper fallback URL");

    process.env.KOVA_NETWORK_FRONTAGE_ENABLED = "1";
    process.env.KOVA_NETWORK_FRONTAGE_HOST = "127.0.1.17";
    process.env.KOVA_NETWORK_FRONTAGE_PORT = "19876";
    const frontage = resolveGatewayEndpoint({ gatewayPort: 18789 }, { gateway: { port: 18789 } }, { protocol: "ws" });
    assertEqual(frontage.source, "network-frontage", "helper frontage source");
    assertEqual(frontage.url, "ws://127.0.1.17:19876", "helper frontage URL");

    return {
      id: "network-frontage-helper-endpoint",
      status: "PASS",
      command: "verify helpers prefer active network frontage endpoint",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-frontage-helper-endpoint",
      status: "FAIL",
      command: "verify helpers prefer active network frontage endpoint",
      durationMs: 0,
      message: error.message
    };
  } finally {
    restoreEnv(previous);
  }
}

export async function mcpToolCallSmokeRedactsGatewayTokenCheck(tmp, scope) {
  const fakeBin = join(tmp, "mcp-tool-redaction-bin");
  const home = join(tmp, "mcp-tool-redaction-home");
  const artifactDir = join(tmp, "mcp-tool-redaction-artifacts");
  const configPath = join(home, ".openclaw", "openclaw.json");
  const fakeOcm = join(fakeBin, "ocm");
  const token = "kova-self-check-mcp-gateway-token";
  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(join(home, ".openclaw"), { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      gateway: {
        port: 43123,
        auth: { token }
      }
    }), "utf8");
    await writeFile(fakeOcm, `#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "env" && args[1] === "show") {
  console.log(JSON.stringify({ configPath: ${JSON.stringify(configPath)}, gatewayPort: 43123 }));
  process.exit(0);
}
if (args[0] === ${JSON.stringify(`@${scope.envName}`)} && args[1] === "--" && args[2] === "status") {
  console.log("ready");
  process.exit(0);
}
if (args[0] === ${JSON.stringify(`@${scope.envName}`)} && args[1] === "--" && args[2] === "mcp" && args[3] === "serve") {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp" } } });
    } else if (message.method === "tools/list") {
      write({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "cron", inputSchema: { type: "object" } }] } });
    } else if (message.method === "tools/call" && message.params?.name === "cron") {
      const gatewayToken = message.params?.arguments?.gatewayToken ?? "";
      write({ jsonrpc: "2.0", id: message.id, result: { isError: false, content: [{ type: "text", text: "echoed " + gatewayToken }], auth: { token: gatewayToken } } });
    } else if (message.method === "tools/call") {
      write({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "unknown tool" }] } });
    }
  });
  function write(value) {
    process.stdout.write(JSON.stringify(value) + "\\n");
  }
} else {
  console.error("unexpected mock ocm command: " + args.join(" "));
  process.exit(2);
}
`, "utf8");
    await chmod(fakeOcm, 0o755);

    const result = await runCommand(
      `node support/mcp-tool-call-smoke.mjs --env ${quoteShell(scope.envName)} --artifact-dir ${quoteShell(artifactDir)} --timeout-ms 5000`,
      {
        shell: "/bin/sh",
        timeoutMs: 30000,
        maxOutputChars: 1000000,
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        }
      }
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const summary = JSON.parse(result.stdout);
    const artifact = await readFile(join(artifactDir, "mcp-tool-call-smoke.json"), "utf8");
    assertEqual(result.stdout.includes(token), false, "MCP tool-call stdout redacts gateway token");
    assertEqual(artifact.includes(token), false, "MCP tool-call artifact redacts gateway token");
    assertEqual(summary.safeToolResultSnippet.includes("<redacted>"), true, "MCP tool result snippet contains redaction marker");
    assertEqual(JSON.stringify(summary.transcript).includes("<redacted>"), true, "MCP transcript contains redaction marker");

    return {
      id: "mcp-tool-call-smoke-redacts-gateway-token",
      status: "PASS",
      command: "run MCP tool-call smoke against token-echoing fake MCP bridge",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "mcp-tool-call-smoke-redacts-gateway-token",
      status: "FAIL",
      command: "run MCP tool-call smoke against token-echoing fake MCP bridge",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function networkFrontageProductPreflightBlocksPendingCheck(tmp, scope) {
  const fakeBin = join(tmp, "network-frontage-pending-bin");
  const artifactDir = join(tmp, "network-frontage-pending-artifacts");
  const sentinel = join(artifactDir, "import");
  const fakeOcm = join(fakeBin, "ocm");
  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await mkdir(sentinel, { recursive: true });
    await writeFile(fakeOcm, `#!/bin/sh
if [ "$1:$2" = "service:status" ]; then
  printf '{"gatewayPort":43123,"gatewayState":"starting","running":false}\\n'
  exit 0
fi
echo "unexpected mock ocm command: $*" >&2
exit 2
`, "utf8");
    await chmod(fakeOcm, 0o755);
    const result = await runScenarioCommand(
      `rm -rf ${quoteShell(sentinel)}`,
      {
        timeoutMs: 5000,
        networkFrontage: {
          enabled: true,
          mode: "loopback-frontage",
          workerId: 7
        },
        commandEnv: {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SHELL: "/bin/sh"
        }
      },
      scope.envName,
      artifactDir,
      { id: "agent-turn", measurementScope: "product" },
      0
    );

    let commandRan = false;
    try {
      await stat(sentinel);
    } catch (error) {
      if (error.code === "ENOENT") {
        commandRan = true;
      } else {
        throw error;
      }
    }

    assertEqual(result.status, 1, "pending network frontage blocks product command");
    assertEqual(result.harnessBlocker, true, "pending network frontage is a harness blocker");
    assertEqual(result.networkFrontage?.status, "pending", "pending network frontage result is attached");
    assertEqual(/network frontage is pending/.test(result.stderr), true, "pending network frontage reason reported");
    assertEqual(commandRan, false, "product command is not spawned before active network frontage");

    return {
      id: "network-frontage-product-preflight-blocks-pending",
      status: "PASS",
      command: "run product command with pending network frontage",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "network-frontage-product-preflight-blocks-pending",
      status: "FAIL",
      command: "run product command with pending network frontage",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function networkFrontageBootstrapCommandsBypassPreflightCheck(tmp, scope) {
  const fakeBin = join(tmp, "network-frontage-bootstrap-bin");
  const artifactDir = join(tmp, "network-frontage-bootstrap-artifacts");
  const commandLog = join(tmp, "network-frontage-bootstrap-commands.log");
  const fakeOcm = join(fakeBin, "ocm");
  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(fakeOcm, `#!/bin/sh
printf '%s\\n' "$*" >> ${quoteShell(commandLog)}
if [ "$1" = "start" ]; then
  printf '{"env":"%s","started":true}\\n' "$2"
  exit 0
fi
if [ "$1:$2" = "service:start" ]; then
  printf '{"env":"%s","serviceStarted":true}\\n' "$3"
  exit 0
fi
echo "unexpected mock ocm command: $*" >&2
exit 2
`, "utf8");
    await chmod(fakeOcm, 0o755);
    const context = {
      timeoutMs: 5000,
      networkFrontage: {
        enabled: true,
        mode: "loopback-frontage",
        workerId: 7
      },
      networkFrontageAllocation: {
        status: "BLOCKED",
        reason: "preexisting frontage blocker"
      },
      commandEnv: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SHELL: "/bin/sh"
      }
    };
    const startResult = await runScenarioCommand(
      `ocm start ${quoteShell(scope.envName)} --json`,
      context,
      scope.envName,
      artifactDir,
      { id: "source", measurementScope: "product" },
      0
    );
    const serviceStartResult = await runScenarioCommand(
      `ocm service start ${quoteShell(scope.envName)} --json`,
      context,
      scope.envName,
      artifactDir,
      { id: "restart", measurementScope: "product" },
      1
    );
    const log = await readFile(commandLog, "utf8");
    assertEqual(startResult.status, 0, "ocm start bypasses frontage preflight outside provision phase");
    assertEqual(serviceStartResult.status, 0, "ocm service start bypasses frontage preflight outside gateway-start phase");
    assertEqual(log.includes(`start ${scope.envName} --json`), true, "ocm start command spawned");
    assertEqual(
      log.includes(`service start ${scope.envName} --json`),
      true,
      "ocm service start command spawned"
    );

    return {
      id: "network-frontage-bootstrap-commands-bypass-preflight",
      status: "PASS",
      command: "run bootstrap commands with preexisting blocked network frontage",
      durationMs: startResult.durationMs + serviceStartResult.durationMs
    };
  } catch (error) {
    return {
      id: "network-frontage-bootstrap-commands-bypass-preflight",
      status: "FAIL",
      command: "run bootstrap commands with preexisting blocked network frontage",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function adversarialInputHelperExactFrontageCheck(tmp, scope) {
  let hitCount = 0;
  const server = createServer((request, response) => {
    hitCount += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: "prefix KOVA_AGENT_OK suffix"
        }
      }]
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const root = join(tmp, "adversarial-frontage-home");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "openclaw.json"), JSON.stringify({
      gateway: {
        port: 9,
        auth: { token: "kova-self-check-token" }
      }
    }), "utf8");
    const address = server.address();
    const command = `KOVA_NETWORK_FRONTAGE_ENABLED=1 KOVA_NETWORK_FRONTAGE_HOST=127.0.0.1 KOVA_NETWORK_FRONTAGE_PORT=${address.port} node support/run-adversarial-inputs.mjs --openclaw-home ${quoteShell(root)} --gateway-port 9 --expected-text KOVA_AGENT_OK --timeout 5000`;
    const result = await runCommand(command, {
      shell: "/bin/sh",
      timeoutMs: 30000,
      maxOutputChars: 1000000
    });
    const summary = JSON.parse(result.stdout);
    assertEqual(hitCount, 5, "adversarial helper uses injected frontage endpoint");
    assertEqual(result.status !== 0, true, "adversarial helper rejects non-exact marker text");
    assertEqual(summary.gateway?.source, "network-frontage", "adversarial helper reports frontage endpoint source");
    assertEqual(summary.finalAssistantVisibleText, "prefix KOVA_AGENT_OK suffix", "adversarial helper preserves actual final text");
    assertEqual(summary.expectedTextPresent, false, "adversarial helper does not mark containing text as exact");

    return {
      id: "adversarial-input-helper-exact-frontage",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "adversarial-input-helper-exact-frontage",
      status: "FAIL",
      command: "run adversarial input helper against fake frontage endpoint",
      durationMs: 0,
      message: error.message
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function cronGatewayTokenEnvCheck(tmp, scope) {
  const fakeBin = join(tmp, "cron-token-env-bin");
  const artifactDir = join(tmp, "cron-token-env-artifacts");
  const configPath = join(tmp, "cron-token-env-openclaw.json");
  const ocmLog = join(tmp, "cron-token-env-ocm.log");
  const envLog = join(tmp, "cron-token-env-seen.log");
  const token = "kova-self-check-gateway-token";
  await mkdir(fakeBin, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ gateway: { port: 18789, auth: { token } } }), "utf8");
  const fakeOcm = join(fakeBin, "ocm");
  await writeFile(fakeOcm, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
if [ "\${OPENCLAW_GATEWAY_TOKEN:-}" = "$KOVA_EXPECTED_GATEWAY_TOKEN" ]; then
  printf 'token-env-present\\n' >> "$KOVA_MOCK_ENV_LOG"
fi
case "$1:$2" in
  env:show)
    printf '{"configPath":%s,"gatewayPort":18789}\\n' "$KOVA_FAKE_CONFIG_JSON"
    exit 0
    ;;
esac
if [ "$2" = "--" ]; then
  shift 2
fi
case "$1:$2" in
  cron:status) printf '{"enabled":true}\\n'; exit 0 ;;
  cron:add) printf '{"id":"job-1"}\\n'; exit 0 ;;
  cron:run) printf '{"runId":"run-1","status":"ok","cronId":"job-1"}\\n'; exit 0 ;;
  cron:runs) printf '{"entries":[{"runId":"run-1","status":"ok","cronId":"job-1","action":"finished"}]}\\n'; exit 0 ;;
  cron:rm) printf '{"removed":true}\\n'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(fakeOcm, 0o755);

  const command = `node support/run-cron-runtime-smoke.mjs --env ${quoteShell(scope.envName)} --artifact-dir ${quoteShell(artifactDir)} --timeout-ms 5000`;
  const result = await runCommand(command, {
    shell: "/bin/sh",
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      KOVA_EXPECTED_GATEWAY_TOKEN: token,
      KOVA_FAKE_CONFIG_JSON: JSON.stringify(configPath),
      KOVA_MOCK_OCM_LOG: ocmLog,
      KOVA_MOCK_ENV_LOG: envLog,
      KOVA_NETWORK_FRONTAGE_ENABLED: "1",
      KOVA_NETWORK_FRONTAGE_HOST: "127.0.1.17",
      KOVA_NETWORK_FRONTAGE_PORT: "19876"
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const summary = JSON.parse(result.stdout);
    const log = await readFile(ocmLog, "utf8");
    const artifact = await readFile(join(artifactDir, "cron-runtime-smoke.json"), "utf8");
    const envHits = await readFile(envLog, "utf8");
    assertEqual(summary.gateway?.source, "network-frontage", "cron helper uses frontage endpoint source");
    assertEqual(summary.gateway?.url, "ws://127.0.1.17:19876", "cron helper uses frontage endpoint URL");
    assertEqual(log.includes("--token"), true, "cron helper passes explicit token flag with explicit URL");
    assertEqual(log.includes(token), true, "cron helper passes explicit gateway token to cron CLI");
    assertEqual(result.stdout.includes(token), false, "cron helper redacts gateway token from stdout summary");
    assertEqual(artifact.includes(token), false, "cron helper redacts gateway token from artifact summary");
    assertEqual(envHits.trim().split(/\r?\n/).filter(Boolean).length >= 5, true, "cron helper passes gateway token through child env");

    return {
      id: "cron-gateway-token-env",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "cron-gateway-token-env",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function networkFrontagePartialStartupCleanupInvariantCheck() {
  try {
    const source = await readFile(selfCheckPath("src", "network-frontage.mjs"), "utf8");
    const pattern = /const proxy = startProxy\(allocation\);[\s\S]+context\.networkFrontageProxy = proxy;[\s\S]+await proxy\.ready;/;
    assertEqual(pattern.test(source), true, "network frontage proxy registered before readiness wait");
    assertEqual(
      /attachProxyLogStream\(log,\s*child\.stderr\)/.test(source),
      true,
      "proxy log and stderr stream errors are handled"
    );
    const blocker = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not-kova-frontage");
    });
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const blockedPort = blocker.address().port;
    const proxy = spawn(process.execPath, [
      selfCheckPath("support", "network-frontage-proxy.mjs"),
      "--listen-host", "127.0.0.1",
      "--listen-port", String(blockedPort),
      "--target-host", "127.0.0.1",
      "--target-port", String(blockedPort)
    ], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    try {
      await waitForProxyReady(proxy, 1000);
      throw new Error("occupied frontage was accepted as ready");
    } catch (error) {
      assertEqual(/bind failed|exited before listening/.test(error.message), true, "occupied frontage bind is rejected");
    } finally {
      proxy.kill("SIGTERM");
      await new Promise((resolve) => blocker.close(resolve));
    }
    const teardownSource = await readFile(selfCheckPath("src", "run", "teardown.mjs"), "utf8");
    const retentionPattern = /id: "network-frontage-cleanup"[\s\S]+let retainEnv = shouldRetainEnv\(context, record\)/;
    assertEqual(retentionPattern.test(teardownSource), true, "retain-on-failure is computed after network frontage cleanup can update status");
    const protectionPattern = /let retainEnv = shouldRetainEnv\(context, record\);[\s\S]+retainEnv = await protectRetainedEnv\(record, context, envName\);[\s\S]+if \(retainEnv\)[\s\S]+record\.cleanup = "retained"/;
    assertEqual(protectionPattern.test(teardownSource), true, "retained env is protected before retention is published");
    assertEqual(
      ocmEnvProtect("kova-retained", true),
      "ocm env protect 'kova-retained' on --json",
      "retention protection command"
    );
    let proxyClosed = false;
    let resolveProxyClosed;
    const context = {
      networkFrontageAllocation: {
        status: "active",
        frontageHost: "127.0.0.1",
        frontagePort: 43123,
        loopbackAlias: { createdByKova: false }
      },
      networkFrontageProxy: {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {
            setTimeout(() => {
              proxyClosed = true;
              resolveProxyClosed();
            }, 10);
          }
        },
        closed: new Promise((resolve) => {
          resolveProxyClosed = resolve;
        })
      }
    };
    const result = await stopNetworkFrontage(context);
    assertEqual(result.status, 0, "synthetic network frontage cleanup status");
    assertEqual(proxyClosed, true, "network frontage cleanup awaits proxy exit");
    assertEqual(context.networkFrontageAllocation.status, "stopped", "network frontage allocation top-level status is stopped after cleanup");
    assertEqual(context.networkFrontageAllocation.cleanup.status, "stopped", "network frontage cleanup status is stopped");
    return {
      id: "network-frontage-partial-startup-cleanup-invariant",
      status: "PASS",
      command: "verify partial network frontage allocation is cleanup-visible",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-frontage-partial-startup-cleanup-invariant",
      status: "FAIL",
      command: "verify partial network frontage allocation is cleanup-visible",
      durationMs: 0,
      message: error.message
    };
  }
}
