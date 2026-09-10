import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { quoteShell, runCommand } from "../src/commands.mjs";
import { repoRoot } from "../src/paths.mjs";

export async function verifyRuntimeBoundaries({ root, home, env, transport, binary }) {
  const failures = [];
  const check = async (name, run) => {
    try {
      await run();
      console.log(`PASS runtime boundary: ${name}`);
    } catch (error) {
      console.error(`FAIL runtime boundary: ${name}: ${error.message}`);
      failures.push(error);
    }
  };
  const envName = "kova-credentials";
  const candidate = join(home, "envs", envName);
  const evaluator = join(root, "evaluator-config");
  const packageRoot = join(root, "runtime-package");
  await mkdir(join(candidate, ".openclaw"), { recursive: true });
  await mkdir(join(evaluator, ".openclaw"), { recursive: true });
  await mkdir(packageRoot);
  const candidateConfig = join(candidate, ".openclaw/openclaw.json");
  const evaluatorConfig = join(evaluator, ".openclaw/openclaw.json");
  const config = (token) => JSON.stringify({ gateway: { auth: { token } } });
  await writeFile(evaluatorConfig, config("synthetic-evaluator-config"));

  const gateway = await fixtureGateway();
  const binding = {
    KOVA_TEST_ROOT: evaluator,
    KOVA_TEST_PORT: String(gateway.port),
    KOVA_TEST_BINARY: join(packageRoot, "openclaw.mjs")
  };
  const configured = {
    ...env,
    OPENCLAW_GATEWAY_TOKEN: "synthetic-evaluator-env",
    OPENCLAW_CONFIG_PATH: "",
    KOVA_NETWORK_FRONTAGE_ENABLED: "0",
    KOVA_OCM_TRANSPORT_JSON: JSON.stringify({ ...transport, env: { ...transport.env, ...binding } })
  };
  const nativeBin = join(root, "native-fixture-bin");
  await mkdir(nativeBin);
  await writeFile(join(nativeBin, "ocm"), await readFile(binary), { mode: 0o755 });
  const native = {
    ...configured, ...binding, KOVA_TEST_LOG: transport.env.KOVA_TEST_LOG,
    PATH: `${nativeBin}:${process.env.PATH}`, KOVA_OCM_TRANSPORT_JSON: undefined
  };
  const invoke = async (surface, commandEnv, extra = []) => {
    const args = surface === "rpc" ? [
      "--input-type=module", "-e",
      `import { prepareOpenClawRuntimeFromOcmEnv, openDirectGatewayRpcClient } from ${JSON.stringify(join(repoRoot, "support/openclaw-runtime.mjs"))};
       const { client } = await openDirectGatewayRpcClient(prepareOpenClawRuntimeFromOcmEnv(${JSON.stringify(envName)}));
       client.close();`
    ] : [
      join(repoRoot, "support", surface === "http" ? "run-openai-compatible-turn.mjs" : "run-adversarial-inputs.mjs"),
      ...(extra.length ? extra : ["--env", envName]), "--timeout", "2000"
    ];
    return runCommand([process.execPath, ...args].map(quoteShell).join(" "), {
      env: commandEnv, timeoutMs: 5000
    });
  };
  try {
    for (const surface of ["rpc", "http", "adversarial"]) {
      for (const [label, text] of [["missing", null], ["malformed", "{"], ["tokenless", "{}"]]) {
        await check(`${surface} rejects ${label} exported config without evaluator credentials`, async () => {
          if (text === null) await rm(candidateConfig, { force: true });
          else await writeFile(candidateConfig, text);
          gateway.seen.length = 0;
          const connections = gateway.connections;
          const result = await invoke(surface, configured);
          assert.deepEqual([...gateway.seen], [], "candidate received an evaluator credential");
          assert.equal(gateway.connections, connections, "invalid config must fail before connecting");
          assert.notEqual(result.status, 0, "invalid transported config must fail closed");
        });
      }
      await check(`${surface} uses only the exported candidate token`, async () => {
        await writeFile(candidateConfig, config("synthetic-candidate"));
        gateway.seen.length = 0;
        const result = await invoke(surface, configured);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.ok(gateway.seen.length > 0);
        assert.ok(gateway.seen.every((token) => token === "synthetic-candidate"), JSON.stringify(gateway.seen));
      });
      await check(`${surface} never reads candidate-selected evaluator config`, async () => {
        await writeFile(candidateConfig, "{}");
        gateway.seen.length = 0;
        const result = await invoke(surface, { ...configured, OPENCLAW_GATEWAY_TOKEN: "" });
        assert.deepEqual([...gateway.seen], []);
        assert.notEqual(result.status, 0);
      });
      await check(`${surface} preserves native credential precedence`, async () => {
        gateway.seen.length = 0;
        const result = await invoke(surface, native);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const expected = surface === "rpc" ? "synthetic-evaluator-config" : "synthetic-evaluator-env";
        assert.ok(gateway.seen.length > 0);
        assert.ok(gateway.seen.every((token) => token === expected));
      });
    }
    await check("native RPC custom config and parse-failure fallback", async () => {
      const custom = join(root, "custom-config.json");
      for (const [text, expected] of [[config("synthetic-custom"), "synthetic-custom"], ["{", "synthetic-evaluator-env"]]) {
        await writeFile(custom, text);
        gateway.seen.length = 0;
        assert.equal((await invoke("rpc", { ...native, OPENCLAW_CONFIG_PATH: custom })).status, 0);
        assert.deepEqual(gateway.seen, [expected]);
      }
    });
    for (const surface of ["http", "adversarial"]) {
      await check(`${surface} preserves native anonymous requests`, async () => {
        await writeFile(evaluatorConfig, "{}");
        gateway.seen.length = 0;
        assert.equal((await invoke(surface, { ...native, OPENCLAW_GATEWAY_TOKEN: "" })).status, 0);
        assert.ok(gateway.seen.length > 0);
        assert.ok(gateway.seen.every((token) => token === null));
        await writeFile(evaluatorConfig, config("synthetic-evaluator-config"));
      });
    }
    const direct = ["--openclaw-home", evaluator, "--gateway-port", String(gateway.port)];
    await check("native adversarial direct-home config remains supported", async () => {
      await writeFile(join(evaluator, "openclaw.json"), config("synthetic-direct-config"));
      gateway.seen.length = 0;
      assert.equal((await invoke("adversarial", { ...native, OPENCLAW_GATEWAY_TOKEN: "" }, direct)).status, 0);
      assert.ok(gateway.seen.every((token) => token === "synthetic-direct-config"));
    });
    await check("transported adversarial direct-home requires an OCM env", async () => {
      gateway.seen.length = 0;
      const result = await invoke("adversarial", configured, direct);
      assert.deepEqual(gateway.seen, []);
      assert.notEqual(result.status, 0);
    });
    await verifyImportBoundaries({ check, root, packageRoot, configured, native });
  } finally {
    await gateway.close();
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} runtime boundary failures`);
}

async function verifyImportBoundaries({ check, root, packageRoot, configured, native }) {
  const marker = join(root, "candidate-imported");
  const canary = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported");\n`;
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    type: "module", exports: { "./plugin-sdk/channel-message": "./channel-message.mjs" }
  }));
  await writeFile(join(packageRoot, "channel-message.mjs"), canary + `
    export const listDeclaredDurableFinalCapabilities = Object.keys;
    export const listDeclaredChannelMessageLiveCapabilities = Object.keys;
    export const listDeclaredLivePreviewFinalizerCapabilities = Object.keys;
    export const listDeclaredReceiveAckPolicies = value => value.supportedAckPolicies;
    export const verifyDurableFinalCapabilityProofs = () => {};
    export const verifyChannelMessageLiveCapabilityProofs = () => {};
    export const verifyLivePreviewFinalizerCapabilityProofs = () => {};
    export const verifyChannelMessageReceiveAckPolicyProofs = () => {};
  `);
  const { loadChannelCapabilities } = await import("../src/registries/channel-capabilities.mjs");
  const [channel] = await loadChannelCapabilities("telegram");
  const adapter = join(packageRoot, channel.adapterDistribution.modulePath);
  await mkdir(dirname(adapter), { recursive: true });
  await writeFile(adapter, canary + `export const ${channel.adapterDistribution.exportName} = { message: {} };\n`);
  const cases = [
    ["preflight env", "run-channel-capability-preflight.mjs", ["--env", "kova-credentials"]],
    ["preflight package-root", "run-channel-capability-preflight.mjs", ["--package-root", packageRoot]],
    ["adapter", "run-channel-adapter-conformance.mjs", ["--env", "kova-credentials"]],
    ["adapter continue-on-failure", "run-channel-adapter-conformance.mjs", ["--env", "kova-credentials", "--continue-on-failure", "true"]]
  ];
  for (const [label, script, args] of cases) {
    const invoke = (env) => runCommand([
      process.execPath, join(repoRoot, "support", script), ...args, "--artifact-dir", join(root, "import-artifacts")
    ].map(quoteShell).join(" "), { env, timeoutMs: 5000 });
    await check(`${label} rejects transport before candidate import`, async () => {
      await rm(marker, { force: true });
      const result = await invoke(configured);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.notEqual(result.status, 0, "continue-on-failure must not override admission");
      assert.match(result.stderr + result.stdout, /cross-user.*import/i);
    });
    await check(`${label} preserves native import`, async () => {
      await rm(marker, { force: true });
      const result = await invoke(native);
      assert.equal(await readFile(marker, "utf8"), "imported");
      if (label.startsWith("preflight") || label.includes("continue-on-failure")) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
    });
  }
}

async function fixtureGateway() {
  const seen = [];
  const sockets = new Set();
  let connections = 0;
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization?.replace(/^Bearer /, "") ?? null);
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "KOVA_AGENT_OK" } }] }));
  });
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (value) => {
      const payload = Buffer.from(JSON.stringify(value));
      assert.ok(payload.length < 126);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    send({ type: "event", event: "connect.challenge" });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2) return;
      if ((buffered[0] & 15) === 8) { socket.end(); return; }
      const shortLength = buffered[1] & 127;
      if (shortLength === 126 && buffered.length < 4) return;
      const length = shortLength === 126 ? buffered.readUInt16BE(2) : shortLength;
      const offset = shortLength === 126 ? 4 : 2;
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < length; index++) payload[index] ^= mask[index % 4];
      buffered = buffered.subarray(offset + 4 + length);
      const frame = JSON.parse(payload.toString());
      seen.push(frame.params.auth.token);
      send({ type: "res", id: frame.id, ok: true, payload: {} });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port, seen,
    get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
