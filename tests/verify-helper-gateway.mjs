import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const exec = promisify(execFile);
const schemas = await loadGatewaySchemaAssertions();
const envName = "kova-helpers-subprocess";
const token = "synthetic-helper-token";

async function fixture(t, { selectedToken = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kova-helper-gateway-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const artifacts = join(root, "artifacts");
  const requests = join(root, "requests.jsonl");
  const commands = join(root, "commands.jsonl");
  const providerRequests = join(artifacts, "mock-openai", "requests.jsonl");
  const foreignConfig = join(root, "foreign-openclaw.json");
  await Promise.all([bin, join(root, "runtime"), join(root, ".openclaw"), join(artifacts, "mock-openai")].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([
    copyFile(new URL("./fixtures/verify-helper-ocm.mjs", import.meta.url), join(bin, "ocm")),
    writeFile(join(bin, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(join(root, ".openclaw", "openclaw.json"), JSON.stringify({ gateway: { auth: selectedToken ? { token } : {} } })),
    writeFile(foreignConfig, JSON.stringify({ gateway: { auth: { token: "synthetic-foreign-config-token" } } })),
    ...[requests, commands, providerRequests].map((path) => writeFile(path, ""))
  ]);
  await chmod(join(bin, "ocm"), 0o755);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("OPENCLAW_") && !key.startsWith("KOVA_OCM_") && !key.startsWith("KOVA_NETWORK_FRONTAGE_")
  ));
  Object.assign(childEnv, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${new URL("./fixtures/verify-helper-socket.mjs", import.meta.url).href}`,
    OPENCLAW_CONFIG_PATH: foreignConfig,
    OPENCLAW_GATEWAY_TOKEN: "synthetic-foreign-env-token",
    OPENCLAW_GATEWAY_PASSWORD: "synthetic-foreign-password",
    KOVA_HELPER_ROOT: root,
    KOVA_HELPER_REQUESTS: requests,
    KOVA_HELPER_COMMANDS: commands,
    KOVA_HELPER_PROVIDER_REQUESTS: providerRequests
  });
  return {
    root, artifacts,
    async run(name, flags, { exitCode = 0 } = {}) {
      const result = await exec(process.execPath, [
        fileURLToPath(new URL(`../support/verify/${name}.mjs`, import.meta.url)),
        "--env", envName, "--timeout", "10000", ...flags
      ], { cwd: root, env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 }).catch((error) => error);
      const captured = await readJsonl(requests);
      // Check outside subprocess error handling: a schema failure must never
      // masquerade as an expected helper refusal or timeout.
      for (const { producer, cwd, frame } of captured) {
        assert.equal(basename(producer), `run-${name === "session-send-turn" ? "gateway-session-send-turn" : name}.mjs`);
        assert.equal(cwd, name === "cron-runtime-smoke" ? root : join(root, "runtime"));
        assert.equal(frame.type, "req");
        assert.equal(typeof frame.id, "string");
        schemas.check(frame.method, frame.params);
        if (frame.method === "connect") assert.deepEqual(frame.params.auth, { token });
      }
      assert.equal(result instanceof Error, exitCode !== 0, result.stderr || result.stdout || result.message);
      assert.equal(result.code ?? 0, exitCode, result.stderr || result.stdout || result.message);
      assert.equal(result.stderr, "");
      return { output: JSON.parse(result.stdout), frames: captured.map(({ frame }) => frame), commands: await readJsonl(commands) };
    }
  };
}

async function readJsonl(path) {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

for (const createSession of [true, false]) test(`session adapter isolates ambient credentials with create-session=${createSession}`, async (t) => {
  const sandbox = await fixture(t);
  const key = "agent:main:wrapped-helper";
  const { output, frames } = await sandbox.run("session-send-turn", ["--session-key", key, "--create-session", String(createSession), "--message", "Reply with KOVA_AGENT_OK"]);
  const canonicalKey = createSession ? `${key}:canonical` : key;
  assert.deepEqual(frames.map(({ method }) => method), ["connect", ...(createSession ? ["sessions.create"] : []), "sessions.send", "agent.wait", "chat.history"]);
  assert.equal(frames[0].params.auth.token, token);
  assert.equal(frames.find(({ method }) => method === "sessions.send").params.key, canonicalKey);
  assert.equal(frames.at(-1).params.sessionKey, canonicalKey);
  assert.equal(output.sessionKey, canonicalKey);
  assert.equal(output.reply, "KOVA_AGENT_OK");
  const submitted = frames.find(({ method }) => method === "sessions.send").params.idempotencyKey;
  assert.match(submitted, /^kova-gateway-session-[a-f0-9-]+$/);
  assert.deepEqual(output.createdIds, [submitted]);
});

test("session adapter refuses a tokenless clone without falling back to ambient credentials", async (t) => {
  const sandbox = await fixture(t, { selectedToken: false });
  const { output, frames } = await sandbox.run("session-send-turn", ["--session-key", "agent:main:wrapped-helper"], { exitCode: 1 });
  assert.deepEqual(frames, []);
  assert.match(output.error, /direct Gateway RPC requires a gateway auth token/);
});

test("channel adapter isolates ambient credentials and resolves relative artifacts before the helper changes directory", async (t) => {
  const sandbox = await fixture(t);
  const resets = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      resets.push({ method: request.method, url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  await writeFile(join(sandbox.artifacts, "mock-openai", "port"), String(provider.address().port));
  const { output, frames } = await sandbox.run("channel-probe-turn", ["--case", "text-final", "--artifact-dir", "artifacts"]);
  assert.deepEqual(frames.map(({ method }) => method), ["connect", "kova.channelProbe.status", "kova.channelProbe.reset", "kova.channelProbe.inject", "kova.channelProbe.observations"]);
  assert.equal(frames[0].params.auth.token, token);
  const injected = frames.find(({ method }) => method === "kova.channelProbe.inject").params;
  assert.equal(injected.replyToId, injected.inboundEventId);
  assert.match(injected.targetId, /^dm:/);
  assert.equal(output.case, "text-final");
  assert.equal(output.reply[0].inboundEvent.id, injected.inboundEventId);
  assert.equal(output.reply[0].outboundRecords[0].text, "KOVA_AGENT_OK");
  const artifact = JSON.parse(await readFile(join(sandbox.artifacts, "channel-probe-turn-text-final.json"), "utf8"));
  assert.deepEqual(artifact.observations, output.reply);
  assert.equal(artifact.runtimeContext.packageRoot, join(sandbox.root, "runtime"));
  await assert.rejects(readFile(join(sandbox.root, "runtime", "artifacts", "channel-probe-turn-text-final.json")), { code: "ENOENT" });
  assert.equal(resets.length, 1);
  assert.equal(resets[0].method, "POST");
  assert.equal(resets[0].url, "/admin/script");
  assert.equal(JSON.parse(resets[0].body).id, "kova-channel-workflow:text-final");
});

test("cron adapter preserves CLI arguments and emits schema-valid direct pairing requests", async (t) => {
  const sandbox = await fixture(t);
  const { output, frames, commands } = await sandbox.run("cron-runtime-smoke", ["--artifact-dir", sandbox.artifacts]);
  assert.deepEqual(frames.map(({ method }) => method), ["connect", "device.pair.approve"]);
  assert.equal(frames[0].params.auth.token, token);
  assert.equal(frames[1].params.requestId, "11111111-1111-4111-8111-111111111111");
  // Normal cron RPC parameters belong to OpenClaw's CLI. Assert this helper's
  // actual argv without fabricating protocol requests on the CLI's behalf.
  const cron = commands.filter((args) => args[0] === `@${envName}`);
  const gateway = ["--url", "ws://127.0.0.1:18789", "--token", token];
  assert.deepEqual(cron.map((args) => args[3]), ["status", "add", "add", "run", "runs", "rm"]);
  const add = cron[1].slice(4);
  assert.equal(add[0], "--name");
  assert.match(add[1], /^kova-cron-runtime-\d+-[a-f0-9-]{36}$/);
  assert.deepEqual(add.slice(2), ["--at", "1m", "--system-event", "KOVA_CRON_RUNTIME_OK", "--delete-after-run", ...gateway, "--json"]);
  assert.deepEqual(cron[2], cron[1]);
  assert.deepEqual(cron[0].slice(4), [...gateway, "--json"]);
  assert.deepEqual(cron[3].slice(4), ["fixture-job", "--wait", "--wait-timeout", "60s", "--poll-interval", "1s", ...gateway]);
  assert.deepEqual(cron[4].slice(4), ["--id", "fixture-job", "--limit", "5", ...gateway]);
  assert.deepEqual(cron[5].slice(4), ["fixture-job", ...gateway, "--json"]);
  assert.deepEqual(output.jobs, [{ id: "fixture-job", runId: "fixture-run", status: "ok", completed: true, timedOut: false, triggerAttributed: true }]);
});

test("wrapped helper Gateway requests satisfy the pinned schemas", (t) => schemas.report(t));
