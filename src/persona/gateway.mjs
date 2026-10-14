import { setTimeout as sleep } from "node:timers/promises";
import { createBoundedOutputAccumulator, quoteShell, spawnOwnedProcess } from "../commands.mjs";
import { ocmInvocation } from "../ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../../support/gateway-endpoint.mjs";

export function createForegroundGateway(env, call, options = {}) {
  let processHandle;
  async function stop() {
    if (!processHandle) return;
    await processHandle.stop();
    processHandle = undefined;
  }
  return {
    stop,
    async start() {
      await stop();
      const metadata = JSON.parse((await call(`ocm env show ${quoteShell(env)} --json`)).stdout);
      const endpoint = resolveGatewayEndpoint(metadata, null, { protocol: "http" });
      const invocation = (options.invocation ?? ocmInvocation)([`@${env}`, "--", "gateway", "run", "--port", String(endpoint.port)]);
      const output = createBoundedOutputAccumulator({ limit: 16000 });
      processHandle = spawnOwnedProcess(invocation.file, invocation.args, { env: invocation.env });
      processHandle.child.stdout.on("data", (chunk) => output.write(chunk));
      processHandle.child.stderr.on("data", (chunk) => output.write(chunk));
      let ended;
      processHandle.closed.then((result) => { ended = result; });
      const deadline = Date.now() + (options.timeoutMs ?? 120000);
      try {
        while (Date.now() < deadline) {
          if (ended) throw new Error(`Gateway exited: ${ended.error?.message ?? ended.status ?? ended.signal}`);
          try {
            const response = await fetch(`${endpoint.url}/readyz`, { signal: AbortSignal.timeout(2000) });
            await response.body?.cancel();
            if (response.ok && !ended) return;
          } catch {}
          await sleep(100);
        }
        throw new Error("Gateway did not become healthy before timeout");
      } catch (error) {
        await stop();
        throw new Error(`${error.message}: ${output.finish().text}`);
      }
    }
  };
}
