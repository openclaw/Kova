import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scriptMain } from "../support/verify/script.mjs";
import { definition } from "../support/verify/plugin-config-writes.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";
import { checkCatalogueCommands, parseCatalogueCommand } from "../src/catalogue.mjs";

// A subprocess CLI fixture mutates actual files through the public command
// boundary. The transport fixture below supplies independent Gateway replies;
// these tests qualify the harness, not OpenClaw's native writer implementation.
async function cliFixture() {
  const args = process.argv.slice(2), path = process.env.OPENCLAW_CONFIG_PATH;
  const root = process.env.KOVA_WRITER_FIXTURE_ROOT;
  const read = async () => JSON.parse(await readFile(path, "utf8"));
  const save = async (config) => { await copyFile(path, `${path}.bak`); await writeFile(path, JSON.stringify(config)); };
  if (args[0] === "node" && args[1] === "run") {
    await writeFile(join(root, "node.json"), JSON.stringify({ name: args[args.indexOf("--display-name") + 1], pid: process.pid, nodeId: "fixture-node" }));
    setInterval(() => {}, 1000);
  } else if (args[0] === "node" && args[1] === "identity") {
    console.log(JSON.stringify({ deviceId: "fixture-node", publicKey: "synthetic-key" }));
  } else if (args[0] === "browser") {
    const config = await read(), name = args[args.indexOf("--name") + 1];
    if (args[1] === "create-profile") {
      config.browser.profiles ??= {};
      config.browser.profiles[name] = { cdpPort: 18891 };
    } else if (args[1] === "delete-profile") delete config.browser.profiles[name];
    else throw new Error("unexpected browser command");
    await save(config); console.log(JSON.stringify({ ok: true, profile: name, deleted: false }));
  } else if (args.join(" ") === "file-transfer approvals migrate") {
    assert.equal(process.stdin.isTTY, true, "migration must cross a real PTY");
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write("Require exact reapproval\r\nKeep as an intentional wildcard\r\nRemove this permission\r\n");
    let answers = 0;
    process.stdin.on("data", async (input) => {
      if (!input.includes(13)) return;
      if (++answers === 1) process.stdout.write("Apply this migration?\r\n");
      else if (answers === 2) {
        const config = await read(), policy = config.plugins.entries["file-transfer"].config;
        const [selector, rules] = Object.entries(policy.nodes)[0];
        policy.pendingReapprovals = [{ selector, kind: "read", path: rules.allowReadPaths[0] }];
        rules.allowReadPaths = []; policy.policyVersion = 2;
        await save(config); process.stdin.pause(); process.stdin.setRawMode(false); process.exit(0);
      }
    });
  } else throw new Error("unexpected writer fixture command");
}

if (["node", "browser", "file-transfer"].includes(process.argv[2])) {
  await cliFixture();
} else {
  const schemas = await loadGatewaySchemaAssertions();
  for (const mode of ["saved", "missing-grant", "held-ended", "cancelled"]) test(`plugin writer workflow: ${mode}`, { skip: process.platform === "win32" }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kova-plugin-writer-test-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, ".openclaw"), path = join(state, "openclaw.json"), handle = join(root, "gateway.json"), directory = `${handle}.d`;
    await mkdir(state); await mkdir(directory);
    const original = '{ gateway: { auth: { token: "synthetic-owner-token" } }, browser: { profiles: { preserved: { cdpPort: 18890 } } } }\n';
    await writeFile(path, original); await writeFile(`${path}.bak.2`, "original backup\n");
    const env = "kova-helpers-plugin-writers", busyKey = "agent:main:busy", writerKey = "agent:main:writer";
    await writeFile(handle, JSON.stringify({ entry: "foreground-gateway-start", ref: { id: "gateway", directory, root, configPath: path, port: 18789 } }));
    await writeFile(join(directory, "operation.json"), JSON.stringify({ schema: "kova.gateway.operation.v1", id: "gateway", entry: "foreground-gateway-start", method: "gateway.start", env, directory, handlePath: handle }));
    const runtime = { root, stateDir: state, configPath: path, gatewayPort: 18789, binaryPath: fileURLToPath(import.meta.url), envName: env };
    const controller = new AbortController(), requests = [], waiters = [];
    let busyActive = false, toolDone = false, nodeRemoved = false, toolArgs, resolved = 0, paused = false;
    const readConfig = async () => JSON.parse(await readFile(path, "utf8"));
    const pending = () => ({ id: "plugin:owned", request: { pluginId: "file-transfer", runId: "tool-run", sessionKey: writerKey, toolName: "dir.list", description: `Allow listing\nPath: ${toolArgs.path}\nNode ID: fixture-node\n\nStanding approval` } });
    const result = () => ({ content: [{ type: "text", text: "fixture listing" }], details: { path: toolArgs.path, entries: [{ name: "kova-marker.txt", isDir: false }] } });
    const invoke = async (method, params) => {
      // Plugin-owned approval RPC has no core ParamsSchema. Its exact public
      // request contract is asserted below, alongside the matched approval ID.
      if (method !== "plugin.approval.resolve") schemas.check(method, params);
      requests.push({ method, params });
      if (method === "connect") return { ok: true };
      if (method === "device.pair.setupCode") {
        assert.deepEqual(params, { bootstrapProfile: "node", includeQr: false, joinUrl: true, publicUrl: "ws://127.0.0.1:18789" });
        return { joinUrl: "oc-join://synthetic-private-bearer" };
      }
      if (method === "node.list") {
        let owned; try { owned = JSON.parse(await readFile(join(root, "node.json"), "utf8")); } catch {}
        return { nodes: owned && !nodeRemoved ? [{ nodeId: owned.nodeId, displayName: owned.name, connected: true, commands: ["dir.list"] }] : [] };
      }
      if (method === "sessions.send") { busyActive = true; return { runId: "busy-run" }; }
      if (method === "sessions.describe") return { session: { key: busyKey, sessionId: "busy-session", status: busyActive ? "running" : "done", hasActiveRun: busyActive, activeRunIds: busyActive ? ["busy-run"] : [] } };
      if (method === "chat.send") {
        if (params.message.startsWith("/dreaming")) {
          const config = await readConfig();
          config.plugins.entries["memory-core"].config = { dreaming: { enabled: params.message.endsWith("on") } };
          if (mode === "held-ended") busyActive = false;
          await writeFile(path, JSON.stringify(config)); return { status: "ok" };
        }
        toolArgs = JSON.parse(params.message.slice("KOVA_TOOL_CALL ".length)).arguments;
        return { runId: "tool-run" };
      }
      if (method === "agent.wait") {
        if (params.runId === "busy-run" ? busyActive : !toolDone) await new Promise((accept) => waiters.push({ runId: params.runId, accept }));
        return { runId: params.runId, status: "ok" };
      }
      if (method === "chat.history") return { sessionKey: params.sessionKey, sessionId: "writer-session", messages: toolArgs && params.sessionKey === writerKey ? [{ role: "assistant", __openclaw: { runId: "tool-run" }, content: [{ type: "toolCall", id: "tool-call", name: "tool_call", arguments: { id: "dir_list", args: toolArgs } }] }] : [] };
      if (method === "sessions.get") return { messages: [{ role: "toolResult", toolName: "tool_call", toolCallId: "tool-call", __openclaw: { runId: "tool-run" }, details: { tool: { id: "openclaw:file-transfer:dir_list", name: "dir_list", source: "openclaw" }, result: result() } }] };
      if (method === "plugin.approval.list") {
        const unrelated = { id: "plugin:unrelated", request: { pluginId: "file-transfer", runId: "another-run", sessionKey: writerKey, toolName: "dir.list", description: "unrelated" } };
        if (toolArgs && mode === "cancelled") controller.abort(new Error("fixture cancellation"));
        return toolArgs ? [unrelated, pending()] : [unrelated];
      }
      if (method === "plugin.approval.resolve") {
        assert.deepEqual(Object.keys(params).sort(), ["decision", "id"]);
        assert.equal(params.id, "plugin:owned"); assert.equal(params.decision, "allow-always"); resolved++;
        const config = await readConfig();
        if (mode !== "missing-grant") {
          const policy = config.plugins.entries["file-transfer"].config;
          policy.literalGrants = [{ nodeId: "fixture-node", command: "dir.list", requestedPath: toolArgs.path, canonicalPath: toolArgs.path }];
          policy.pendingReapprovals = [];
          await writeFile(path, JSON.stringify(config));
        }
        toolDone = true;
        for (const waiter of waiters.filter((entry) => entry.runId === "tool-run")) waiter.accept();
        return { ok: true };
      }
      if (method === "chat.abort") {
        assert.equal(params.runId, params.sessionKey === busyKey ? "busy-run" : "tool-run");
        if (params.runId === "busy-run") busyActive = false; else toolDone = true;
        for (const waiter of waiters.filter((entry) => entry.runId === params.runId)) waiter.accept();
        return { ok: true };
      }
      if (method === "node.pair.remove") { assert.equal(params.nodeId, "fixture-node"); nodeRemoved = true; return { nodeId: params.nodeId }; }
      throw new Error(`unexpected writer request: ${method}`);
    };
    const previousSocket = globalThis.WebSocket, previousRoot = process.env.KOVA_WRITER_FIXTURE_ROOT;
    class Socket extends EventTarget {
      static OPEN = 1;
      constructor() { super(); this.readyState = Socket.OPEN; queueMicrotask(() => this.receive({ type: "event", event: "connect.challenge" })); }
      receive(value) { if (this.readyState === Socket.OPEN) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
      send(raw) {
        const frame = JSON.parse(raw);
        invoke(frame.method, frame.params).then((payload) => this.receive({ type: "res", id: frame.id, ok: true, payload }), (error) => this.receive({ type: "res", id: frame.id, ok: false, error: { message: error.message } }));
      }
      close() { this.readyState = 3; }
    }
    globalThis.WebSocket = Socket; process.env.KOVA_WRITER_FIXTURE_ROOT = root;
    t.after(() => { globalThis.WebSocket = previousSocket; if (previousRoot === undefined) delete process.env.KOVA_WRITER_FIXTURE_ROOT; else process.env.KOVA_WRITER_FIXTURE_ROOT = previousRoot; });
    const execution = await scriptMain(definition, ["--env", env, "--gateway-handle", handle, "--session-key", writerKey, "--busy-session-key", busyKey, "--timeout", "240000", "--out", join(root, "result.json")], {
      prepare: () => runtime, signal: controller.signal,
      context: { requestLifecycle: async ({ operation }) => { assert.notEqual(paused, operation === "pause"); paused = operation === "pause"; return { exitCode: 0, output: { error: null } }; } }
    });
    assert.equal(execution.exitCode, mode === "saved" ? 0 : 1, execution.output.error);
    if (mode === "missing-grant") assert.match(execution.output.error, /did not persist its exact standing grant/);
    if (mode === "held-ended") assert.match(execution.output.error, /held turn is no longer active/);
    if (mode === "cancelled") assert.match(execution.output.error, /fixture cancellation/);
    assert.equal(execution.output.cleanupComplete, true, execution.output.error);
    assert.equal(execution.output.retainedFixture, null);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(await readFile(`${path}.bak.2`, "utf8"), "original backup\n");
    for (const suffix of [".bak", ".bak.1", ".bak.3", ".bak.4"]) await assert.rejects(readFile(`${path}${suffix}`), { code: "ENOENT" });
    assert.equal((await readdir(state)).some((name) => name.startsWith("kova-plugin-writers-")), false);
    assert.equal(paused, false); assert.equal(nodeRemoved, true); assert.equal(busyActive, false);
    assert.equal(resolved, ["cancelled", "held-ended"].includes(mode) ? 0 : 1);
    const child = JSON.parse(await readFile(join(root, "node.json"), "utf8"));
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    assert.doesNotMatch(JSON.stringify(execution.output), /synthetic-private-bearer|synthetic-owner-token/);
    if (mode === "saved") {
      assert.deepEqual(execution.output.dreaming, [{ enabled: true }, { enabled: false }]);
      assert.equal(execution.output.browser.removed, true);
      assert.equal(execution.output.migration.pendingReapproval, true);
      assert.equal(execution.output.standingGrant.canonicalMatchesFixture, true);
      assert.equal(execution.output.standingGrant.pendingReapprovalRemoved, true);
    }
    assert.equal(requests.some((request) => request.method === "plugin.approval.resolve" && request.params.id === "plugin:unrelated"), false);
  });
  test("plugin writer Gateway requests satisfy pinned core schemas", (t) => schemas.report(t));

  test("config operations declare bounded held groups and catalogue-supported writer forms", async () => {
    const template = JSON.parse(await readFile(new URL("../verify/templates/config/template.json", import.meta.url)));
    const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
    const standard = JSON.parse(await readFile(new URL("../verify/standard.json", import.meta.url)));
    const option = (command, name) => {
      const tokens = parseCatalogueCommand(command).tokens, index = tokens.indexOf(name);
      return index < 0 ? undefined : tokens[index + 1];
    };
    const gateway = option(standard.before.find((phase) => phase.id === "start-gateway").commands[0], "--handle");
    const service = catalogue.entries.find((entry) => entry.id === "ensure-gateway-running-service");
    assert.equal(service.status, "toWrite");
    assert.equal(service.command, "node {kovaRoot}/support/verify/ensure-gateway-running.mjs service --env {env}");
    assert.deepEqual(Object.keys(service.flags).sort(), ["--artifact-dir", "--env", "--timeout"]);
    const foregroundReadiness = new Set(["setup-gateway", "event-restart-cooldown", "event-write-echo", "event-reload-restartreq"]);
    const emitted = [];
    let serviceCalls = 0;
    for (const phase of template.phases) {
      let held, enclosedMs = 0;
      for (let i = 0; i < phase.commands.length; i++) {
        const command = phase.commands[i];
        if (command.includes("plugin-config-writes.mjs") || command.includes("support/verify/ensure-gateway-running.mjs")) {
          if (command.includes("ensure-gateway-running.mjs service ")) {
            serviceCalls++;
            assert.equal(foregroundReadiness.has(phase.id), false, "foreground readiness must keep its implemented owner");
            assert.equal(option(command, "--gateway-handle"), undefined, "deferred service readiness must not borrow a foreground owner");
          } else {
            if (command.includes("ensure-gateway-running.mjs")) assert.ok(foregroundReadiness.has(phase.id), "service lifecycle cannot be routed through the foreground owner");
            assert.equal(option(command, "--gateway-handle"), gateway, "writers and foreground readiness must reuse the standard Gateway");
          }
          assert.equal(option(command, "--timeout-ms"), undefined);
          emitted.push({ command });
        }
        if (command.includes("session-turn-hold.mjs")) emitted.push({ command });
        if (phase.kind !== "operation") continue;
        if (command.includes("session-turn-hold.mjs") && option(command, "--hold-ms")) {
          assert.equal(held, undefined, phase.id);
          held = option(command, "--handle"); enclosedMs = 0;
          assert.ok(Number(option(command, "--hold-ms")) <= 300000, phase.id);
          assert.ok(Number(option(command, "--timeout")) > Number(option(command, "--hold-ms")), phase.id);
        } else if (held && command.includes("--method chat.abort")) {
          assert.ok(enclosedMs <= 280000, `${phase.id}: enclosed command bounds ${enclosedMs}`);
          const joined = phase.commands[++i];
          assert.equal(option(joined, "--wait"), held, phase.id);
          emitted.push({ command: joined });
          held = undefined;
        } else if (held && !command.includes("session-turn-hold.mjs")) {
          const bound = Number(option(command, "--timeout") ?? phase.timeoutMs) + Number(option(command, "--after-ms") ?? 0);
          const before = phase.commands[i - 1], after = phase.commands[i + 1];
          for (const guard of [before, after]) {
            assert.ok(guard.includes("--require-active"), phase.id);
            assert.equal(option(guard, "--from"), held, phase.id);
          }
          assert.ok(Number(option(before, "--min-remaining-ms")) >= bound + 5000, phase.id);
          assert.ok(Number(option(after, "--min-remaining-ms")) > 0, phase.id);
          enclosedMs += bound;
        } else if (held) enclosedMs += Number(option(command, "--timeout"));
      }
      assert.equal(held, undefined, `${phase.id}: unjoined hold`);
    }
    emitted.push({ command: "ocm @{env} -- browser create-profile --name kova-owned --json" }, { command: "ocm @{env} -- browser delete-profile --name kova-owned --json" });
    assert.equal(serviceCalls, 139);
    // Only the explicitly deferred service entry is allowed to remain
    // unimplemented. Unknown commands or other findings must fail this check.
    const findings = checkCatalogueCommands(catalogue, emitted);
    assert.equal(findings.filter((finding) => finding.code === "toWrite" && finding.entryId === service.id).length, serviceCalls);
    assert.deepEqual(findings.filter((finding) => finding.code !== "toWrite" || finding.entryId !== service.id), []);
  });
}
