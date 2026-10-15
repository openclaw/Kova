import { setTimeout as sleep } from "node:timers/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { createBoundedOutputAccumulator, quoteShell, spawnOwnedProcess } from "../commands.mjs";
import { ocmInvocation } from "../ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../../support/gateway-endpoint.mjs";
import { openDirectGatewayRpcClient } from "../../support/openclaw-runtime.mjs";
import { personaGatewayEnvironment } from "../../support/persona/environment-content.mjs";

async function requireUnusedPort(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.once("connect", () => finish(new Error(`Gateway port ${port} already has a listener`)));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? null : error));
    socket.setTimeout(2000, () => finish(new Error("Gateway port availability could not be established")));
  });
}

export function createForegroundGateway(env, call, options = {}) {
  let processHandle;
  let connection;
  let expectedPath;
  let ended;
  async function stop() {
    connection?.client.close();
    connection = undefined;
    if (!processHandle) return;
    await processHandle.stop();
    processHandle = undefined;
  }
  async function assertOwned() {
    options.signal?.throwIfAborted();
    const checkProcess = () => {
      if (!processHandle || ended || processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
        throw new Error(`owned Gateway exited: ${ended?.error?.message ?? ended?.status ?? ended?.signal ?? "not running"}`);
      }
    };
    checkProcess();
    if (!connection) throw new Error("owned Gateway connection is absent");
    const snapshot = await connection.client.request("config.get", {}, { timeoutMs: 5000 });
    if (typeof snapshot?.path !== "string" || !isAbsolute(snapshot.path) || resolve(snapshot.path) !== expectedPath) {
      throw new Error(`Gateway does not belong to persona environment ${env}`);
    }
    options.signal?.throwIfAborted();
    checkProcess();
  }
  return {
    stop,
    assertOwned,
    async start() {
      options.signal?.throwIfAborted();
      await stop();
      const metadata = JSON.parse((await call(`ocm env show ${quoteShell(env)} --json`)).stdout);
      const port = Number(metadata.gatewayPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid persona Gateway port");
      await requireUnusedPort(port);
      options.signal?.throwIfAborted();
      const endpoint = resolveGatewayEndpoint(metadata, null, { protocol: "http" });
      expectedPath = resolve(metadata.configPath ?? join(metadata.root, ".openclaw", "openclaw.json"));
      const invocation = (options.invocation ?? ocmInvocation)([`@${env}`, "--", "gateway", "run", "--port", String(port)]);
      const output = createBoundedOutputAccumulator({ limit: 16000 });
      const processEnvironment = { ...invocation.env, ...await personaGatewayEnvironment(metadata) };
      options.environment?.(processEnvironment);
      processHandle = spawnOwnedProcess(invocation.file, invocation.args, { env: processEnvironment });
      processHandle.child.stdout.on("data", (chunk) => output.write(chunk));
      processHandle.child.stderr.on("data", (chunk) => output.write(chunk));
      ended = undefined;
      processHandle.closed.then((result) => { ended = result; });
      const deadline = Date.now() + (options.timeoutMs ?? 120000);
      try {
        while (Date.now() < deadline) {
          options.signal?.throwIfAborted();
          if (ended) throw new Error(`Gateway exited: ${ended.error?.message ?? ended.status ?? ended.signal}`);
          let healthy = false;
          try {
            const response = await fetch(`${endpoint.url}/readyz`, { signal: AbortSignal.timeout(2000) });
            await response.body?.cancel();
            healthy = response.ok;
          } catch {}
          if (healthy && !ended) {
            connection = await (options.connect ?? openDirectGatewayRpcClient)({ ...metadata, envName: env });
            await assertOwned();
            return;
          }
          await sleep(100, undefined, { signal: options.signal });
        }
        throw new Error("Gateway did not become healthy before timeout");
      } catch (error) {
        await stop();
        throw new Error(`${error.message}: ${output.finish().text}`);
      }
    }
  };
}
