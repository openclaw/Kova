import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixtureGateway } from "../src/selfcheck/gateway-fixture.mjs";
import { DirectGatewayRpcClient, openDirectGatewayRpcClient } from "../support/openclaw-runtime.mjs";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static latest = null;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    FakeSocket.latest = this;
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }
}

export async function runGatewayRpcFrameChecks() {
  await gatewayAuthReferenceChecks();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  const client = new DirectGatewayRpcClient({ url: "ws://127.0.0.1/gateway", token: "fixture" });
  try {
    const connected = client.connect(2000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeSocket.latest;
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "event", event: "connect.challenge" })
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectFrame = socket.sent.find((frame) => frame.method === "connect");
    assert.ok(connectFrame, "client must answer the connect challenge");
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "res", id: connectFrame.id, ok: true, payload: {} })
    }));
    await connected;
    for (const data of ["not-json{", new Blob(["not-json{"])]) {
      const requests = ["health", "status"].map((method) =>
        assert.rejects(client.request(method, {}, { timeoutMs: 2000 }), SyntaxError));
      socket.dispatchEvent(new MessageEvent("message", { data }));
      await Promise.all(requests);
      assert.equal(client.pending.size, 0);
      const recovered = client.request("health", {}, { timeoutMs: 2000 });
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "res", id: socket.sent.at(-1).id, ok: true, payload: { ok: true } })
      }));
      assert.deepEqual(await recovered, { ok: true });
    }
    socket.dispatchEvent(new MessageEvent("message", { data: "idle malformed frame" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    client.close();
    process.off("unhandledRejection", onRejection);
    globalThis.WebSocket = previous;
  }
}

async function gatewayAuthReferenceChecks() {
  const root = await mkdtemp(join(tmpdir(), "kova Gateway auth "));
  const stateDir = join(root, ".openclaw");
  const packageRoot = join(root, "runtime");
  const bin = join(root, "bin");
  const configPath = join(stateDir, "openclaw.json");
  const sdkToken = "synthetic-sdk-resolved-gateway-token";
  const keys = ["PATH", "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "KOVA_OCM_TRANSPORT_JSON", "KOVA_NETWORK_FRONTAGE_ENABLED"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const gateway = await fixtureGateway();
  try {
    await Promise.all([stateDir, packageRoot, bin].map((dir) => mkdir(dir)));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "openclaw", type: "module",
      exports: { "./plugin-sdk/secret-input-runtime": "./secret-input.mjs" }
    }));
    // The SDK is an external contract here; the actual owner is exercised by live proof.
    await writeFile(join(packageRoot, "secret-input.mjs"), `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      export async function resolveConfiguredSecretInputString({ config, env, value, path }) {
        assert.equal(env.OPENCLAW_STATE_DIR, ${JSON.stringify(stateDir)});
        assert.equal(value, config.gateway[path.split(".")[1]].token);
        assert.equal(value.source, "store");
        try { return { value: readFileSync(join(env.OPENCLAW_STATE_DIR, "fixture-token"), "utf8") }; }
        catch { console.error(${JSON.stringify(sdkToken)}); return { unresolvedRefReason: "fixture unavailable" }; }
      }
    `);
    await writeFile(join(bin, "ocm"), `#!${process.execPath}
      import { spawnSync } from "node:child_process";
      import { readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      if (args[1] === "artifact") {
        process.stdout.write(readFileSync(${JSON.stringify(configPath)}));
      } else {
        const child = spawnSync(args[4], args.slice(5), {
          env: { ...process.env, OPENCLAW_CONFIG_PATH: ${JSON.stringify(configPath)},
            OPENCLAW_HOME: ${JSON.stringify(root)}, OPENCLAW_STATE_DIR: ${JSON.stringify(stateDir)} },
          stdio: ["ignore", "pipe", "pipe"]
        });
        process.stdout.write(child.stdout ?? "");
        process.stderr.write(child.stderr ?? "");
        process.exitCode = child.status ?? 1;
      }
    `);
    await chmod(join(bin, "ocm"), 0o755);
    // A package marker gives the extensionless fake OCM executable ESM semantics.
    await writeFile(join(bin, "package.json"), '{"type":"module"}');
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_GATEWAY_TOKEN = "ambient-token-must-not-replace-ref";
    process.env.KOVA_NETWORK_FRONTAGE_ENABLED = "0";
    const context = { root, envName: "fixture", packageRoot, gatewayPort: gateway.port };
    for (const transported of [false, true]) {
      if (transported) {
        process.env.KOVA_OCM_TRANSPORT_JSON = JSON.stringify({
          prefix: [], binary: join(bin, "ocm"),
          env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }
        });
      } else delete process.env.KOVA_OCM_TRANSPORT_JSON;
      await writeFile(configPath, JSON.stringify({ gateway: { auth: {
        token: { source: "store", provider: "default", id: "fixture-token" }
      } } }));
      await writeFile(join(stateDir, "fixture-token"), sdkToken);
      const connection = await openDirectGatewayRpcClient(context);
      try {
        assert.equal(gateway.seen.at(-1), sdkToken, "handshake consumes the runtime SDK credential");
      } finally { connection.client.close(); }
      await rm(join(stateDir, "fixture-token"));
      const connections = gateway.connections;
      await assert.rejects(openDirectGatewayRpcClient(context), (error) => {
        assert.match(error.message, /could not resolve configured Gateway authentication/);
        assert.equal(error.message.includes(sdkToken), false, "SDK diagnostics stay private");
        return true;
      });
      assert.equal(gateway.connections, connections, "unresolved refs never connect with ambient credentials");
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runGatewayRpcFrameChecks();
  console.log("PASS bad gateway frame does not exit the process");
}
