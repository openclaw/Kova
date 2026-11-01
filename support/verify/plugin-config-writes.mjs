import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import JSON5 from "json5";
import { commandEnvironment } from "../../src/command-environment.mjs";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { openDirectGatewayRpcClient } from "../openclaw-runtime.mjs";
import { abortable, CallError, readOperation } from "./background.mjs";
import { requestGatewayLifecycle } from "./gateway-fixture-client.mjs";
import { disposableEnv } from "./helper.mjs";
import { definition as toolTurn, observedTool } from "./agent-tool-turn.mjs";
import { entrypoint, nonempty } from "./script.mjs";
import { hasExactActiveRun, sendTurn } from "./turn.mjs";

// This is deliberately one workflow, not a general terminal/approval driver.
// The PTY child owns and reaps its session even when its parent is cancelled.
const migrationPty = String.raw`
import errno,json,os,pty,re,select,signal,sys,time
args=json.loads(sys.argv[1]); pid=None; status=None; exact=False; confirmed=False; text=""
def interrupted(*_): raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
try:
 pid,fd=pty.fork()
 if pid==0: os.execv(args[0],args)
 end=time.monotonic()+75
 while status is None and time.monotonic()<end:
  ready,_,_=select.select([fd],[],[],0.1)
  if ready:
   try: chunk=os.read(fd,8192)
   except OSError as error:
    if error.errno!=errno.EIO: raise
    chunk=b""
   text+=chunk.decode("utf-8",errors="replace")
   if len(text)>65536: raise RuntimeError("terminal output limit")
   plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
   if not exact and "Remove this permission" in plain:
    os.write(fd,b"\r"); exact=True; text=""
   elif exact and not confirmed and "Apply this migration?" in plain:
    os.write(fd,b"\r"); confirmed=True; text=""
  done,code=os.waitpid(pid,os.WNOHANG)
  if done: status=os.waitstatus_to_exitcode(code)
finally:
 if pid and status is None:
  try: os.killpg(pid,signal.SIGTERM)
  except ProcessLookupError: pass
  end=time.monotonic()+1
  while time.monotonic()<end:
   done,code=os.waitpid(pid,os.WNOHANG)
   if done: status=os.waitstatus_to_exitcode(code); break
   time.sleep(0.02)
  if status is None:
   try: os.killpg(pid,signal.SIGKILL)
   except ProcessLookupError: pass
   _,code=os.waitpid(pid,0); status=os.waitstatus_to_exitcode(code)
print(json.dumps({"status":status,"exact":exact,"confirmed":confirmed}))
`;

async function fileState(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CallError("writer fixture requires regular unaliased config files");
    return { bytes: await readFile(path), mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function replace(path, value) {
  await fileState(path);
  if (!value) return await rm(path, { force: true });
  const temporary = `${path}.kova-${randomUUID()}`;
  try {
    await writeFile(temporary, value.bytes, { flag: "wx", mode: value.mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function command(file, args, env, controls, label) {
  controls.remaining();
  const owned = spawnOwnedProcess(file, args, { env, finishOnShutdown: true });
  let stdout = "", bytes = 0;
  const overflow = new AbortController();
  owned.child.stdout.on("data", (chunk) => {
    if ((bytes += chunk.length) > 1024 * 1024) overflow.abort(new CallError(`${label} output exceeded its bound`, 1));
    else stdout += chunk.toString();
  });
  owned.child.stderr.resume();
  try {
    const result = await abortable(owned.closed, AbortSignal.any([controls.signal, overflow.signal]));
    if (result.error || result.status !== 0 || result.signal) throw new CallError(`${label} failed`, 1);
    try { return JSON.parse(stdout); } catch { throw new CallError(`${label} did not return JSON`, 1); }
  } finally { await owned.stop(); }
}

async function target(options, context) {
  if (resolveOcmTransport() || process.platform === "win32") throw new CallError("BLOCKED: plugin writer fixture requires a local POSIX clone with python3", 2);
  const runtime = context.runtime();
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.env !== options.env || operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || !operation.handle?.ref) throw new CallError("writer fixture requires the selected foreground Gateway");
  const root = await realpath(runtime.root);
  const state = join(root, ".openclaw"), path = join(state, "openclaw.json");
  const ref = operation.handle.ref;
  if (resolve(runtime.root) !== root || resolve(ref.root ?? "") !== root || runtime.configPath !== path || ref.configPath !== path || ref.port !== runtime.gatewayPort || await realpath(state) !== state) throw new CallError("writer fixture requires the clone's default unaliased config and state");
  const original = await fileState(path);
  if (!original) throw new CallError("writer fixture configuration is absent");
  let config;
  try { config = JSON5.parse(original.bytes.toString()); } catch { throw new CallError("writer fixture configuration is invalid"); }
  if (!config || Array.isArray(config) || JSON.stringify(config).includes('"$include"') || config.gateway?.mode === "remote") throw new CallError("BLOCKED: plugin writer fixture requires directly authored local config", 2);
  return { runtime, root, state, path };
}

export const definition = {
  id: "plugin-config-writes", url: import.meta.url, cancellationExitCode: 3,
  flags: ["env", "gateway-handle", "session-key", "busy-session-key", "out", "timeout"],
  empty: () => ({ dreaming: [], browser: null, migration: null, standingGrant: null, busyRunId: null, cleanupComplete: false, retainedFixture: null, elapsedMs: 0 }),
  validate(options) {
    disposableEnv(options);
    for (const flag of ["gateway-handle", "session-key", "busy-session-key", "out", "timeout"]) if (!nonempty(options[flag])) throw new CallError(`--${flag} is required`);
    if (options["session-key"] === options["busy-session-key"]) throw new CallError("writer and held turn require distinct sessions");
    if (options.timeoutMs < 180000) throw new CallError("writer fixture needs at least 180000ms including restoration");
  },
  async run(options, context) {
    const selected = await target(options, context);
    const { runtime, root, state, path } = selected;
    const deadline = Date.now() + context.remaining();
    const workUntil = deadline - 60000;
    const workSignal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, workUntil - Date.now()))]);
    let stepUntil = workUntil, stepSignal = workSignal;
    const controls = {
      get signal() { return stepSignal; },
      remaining() { stepSignal.throwIfAborted(); if (Date.now() >= stepUntil) throw new CallError("writer work timeout", 3); return stepUntil - Date.now(); },
      pause: (ms) => sleep(ms, undefined, { signal: stepSignal })
    };
    const step = async (timeoutMs, action) => {
      stepUntil = Math.min(workUntil, Date.now() + timeoutMs);
      stepSignal = AbortSignal.any([workSignal, AbortSignal.timeout(Math.max(1, stepUntil - Date.now()))]);
      try { return await action(); }
      finally { stepUntil = workUntil; stepSignal = workSignal; }
    };
    const cleanupSignal = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const rpc = async (method, params, cleanup = false) => {
      const timeoutMs = cleanup ? Math.max(1, deadline - Date.now()) : controls.remaining();
      const signal = cleanup ? cleanupSignal() : controls.signal;
      const { client } = await openDirectGatewayRpcClient(runtime, { authFromRuntimeConfig: true, timeoutMs, signal });
      try {
        signal.throwIfAborted();
        return await abortable(client.request(method, params, { timeoutMs }), signal, () => client.close());
      }
      catch (error) { signal.throwIfAborted(); throw new CallError(`${method} failed`, error.exitCode ?? 1); }
      finally { client.close(); }
    };
    const lifecycle = async (operation, cleanup = false) => {
      const result = await (context.requestLifecycle ?? requestGatewayLifecycle)({ env: options.env, "gateway-handle": options["gateway-handle"], operation, timeoutMs: cleanup ? Math.max(1, deadline - Date.now()) : controls.remaining() }, { signal: cleanup ? cleanupSignal() : workSignal });
      if (result.exitCode || result.output?.error) throw new CallError(`Gateway ${operation} failed`, result.exitCode || 1);
    };
    const scope = commandEnvironment({ OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path, OPENCLAW_GATEWAY_PORT: String(runtime.gatewayPort), OPENCLAW_NO_AUTO_UPDATE: "1" });
    const cli = (args) => command(process.execPath, [runtime.binaryPath, ...args], scope, controls, "OpenClaw command");
    const readConfig = async () => JSON5.parse((await readFile(path)).toString());
    const policy = async () => (await readConfig()).plugins?.entries?.["file-transfer"]?.config;
    const output = definition.empty();
    const originals = new Map();
    const writerRuns = new Set();
    let directory, node, nodeId, busy, tool, busyRunId, busyUntilMs, toolRunId, paused = false, changed = false, enrollmentIssued = false, failure;
    const work = { ...context, ...controls, rpc, record: undefined, submittedTurn: async (key, receipt) => { if (key === options["session-key"]) writerRuns.add(receipt.runId); } };
    const active = async (minimumMs = 1) => {
      const remaining = () => Math.min(busyUntilMs, workUntil) - Date.now();
      if (remaining() < minimumMs) throw new CallError("independent held turn has insufficient remaining time", 1);
      const row = (await rpc("sessions.describe", { key: options["busy-session-key"] }))?.session;
      if (row?.key !== options["busy-session-key"] || !await hasExactActiveRun(work, row, busyRunId)) throw new CallError("independent held turn is no longer active", 1);
      if (remaining() < minimumMs) throw new CallError("independent held turn has insufficient remaining time", 1);
    };
    const write = async (timeoutMs, action) => {
      await active(timeoutMs + 5000);
      const result = await step(timeoutMs, action);
      await active();
      return result;
    };
    const stage = async (next) => {
      changed = true;
      await replace(path, { bytes: Buffer.from(`${JSON.stringify(next, null, 2)}\n`), mode: 0o600 });
    };
    try {
      try { await command("python3", ["-c", "import pty,json; print(json.dumps({}))"], scope, controls, "PTY prerequisite"); }
      catch { throw new CallError("BLOCKED: plugin writer fixture requires python3 with POSIX pty support", 2); }
      paused = true; await lifecycle("pause");
      for (const suffix of ["", ".bak", ".bak.1", ".bak.2", ".bak.3", ".bak.4"]) originals.set(`${path}${suffix}`, await fileState(`${path}${suffix}`));
      directory = await mkdtemp(join(state, "kova-plugin-writers-"));
      const data = join(directory, "directory");
      await mkdir(data); await writeFile(join(data, "kova-marker.txt"), "synthetic file-transfer fixture\n", { mode: 0o600 });
      const fixture = await readConfig();
      fixture.plugins ??= {}; fixture.plugins.entries ??= {};
      for (const id of ["browser", "file-transfer", "memory-core"]) {
        fixture.plugins.entries[id] = { ...fixture.plugins.entries[id], enabled: true };
        if (Array.isArray(fixture.plugins.allow) && !fixture.plugins.allow.includes(id)) fixture.plugins.allow.push(id);
      }
      fixture.browser = { ...fixture.browser, enabled: true };
      fixture.gateway ??= {}; fixture.gateway.nodes ??= {};
      fixture.gateway.nodes.browser = { ...fixture.gateway.nodes.browser, mode: "off" };
      fixture.gateway.nodes.commands = { ...fixture.gateway.nodes.commands, allow: [...new Set([...(fixture.gateway.nodes.commands?.allow ?? []), "dir.list"])], deny: (fixture.gateway.nodes.commands?.deny ?? []).filter((id) => id !== "dir.list") };
      const enableTools = (owner) => { owner.tools = { ...owner.tools, profile: "full", allow: ["*"], deny: [] }; };
      enableTools(fixture);
      const agentId = /^agent:([^:]+):/.exec(options["session-key"])?.[1];
      if (fixture.agents?.entries?.[agentId]) enableTools(fixture.agents.entries[agentId]);
      await stage(fixture); await lifecycle("resume"); paused = false;
      enrollmentIssued = true;
      const enrollment = await rpc("device.pair.setupCode", { bootstrapProfile: "node", includeQr: false, joinUrl: true, publicUrl: `ws://127.0.0.1:${runtime.gatewayPort}` });
      if (!nonempty(enrollment?.joinUrl)) throw new CallError("node enrollment returned no join URL", 1);
      const nodeHome = join(directory, "node"), nodeState = join(nodeHome, ".openclaw"), nodeConfig = join(nodeState, "openclaw.json");
      await mkdir(nodeState, { recursive: true });
      await writeFile(nodeConfig, JSON.stringify({ browser: { enabled: false }, plugins: { allow: ["file-transfer"], entries: { "file-transfer": { enabled: true } } }, nodeHost: { autoUpdate: { enabled: false } } }), { mode: 0o600 });
      const name = `kova-writer-${randomUUID()}`;
      const nodeEnv = commandEnvironment({ OPENCLAW_HOME: nodeHome, OPENCLAW_STATE_DIR: nodeState, OPENCLAW_CONFIG_PATH: nodeConfig, OPENCLAW_NO_AUTO_UPDATE: "1" });
      for (const key of ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_PROFILE"]) delete nodeEnv[key];
      node = spawnOwnedProcess(process.execPath, [runtime.binaryPath, "node", "run", "--pair", enrollment.joinUrl, "--commands", "dir.list", "--display-name", name, "--no-share-installed-apps"], { env: nodeEnv, finishOnShutdown: true });
      node.child.stdout.resume(); node.child.stderr.resume();
      for (;;) {
        controls.remaining();
        const nodes = (await rpc("node.list", {}))?.nodes;
        const found = Array.isArray(nodes) && nodes.find((entry) => entry.displayName === name && entry.connected === true && entry.commands?.includes("dir.list"));
        if (found) {
          const self = await command(process.execPath, [runtime.binaryPath, "node", "identity", "--json"], nodeEnv, controls, "node identity");
          if (!nonempty(self?.deviceId) || self.deviceId !== found.nodeId) throw new CallError("connected node differs from the fixture identity", 1);
          nodeId = self.deviceId; break;
        }
        if (node.child.exitCode !== null || node.child.signalCode !== null) throw new CallError("fixture node exited before admission", 1);
        await controls.pause(100);
      }
      paused = true; await lifecycle("pause");
      fixture.plugins.entries["file-transfer"].config = { nodes: { [nodeId]: { ask: "off", allowReadPaths: [data] } } };
      await stage(fixture); await lifecycle("resume"); paused = false;
      let submitted;
      const admission = new Promise((accept) => { submitted = accept; });
      if (controls.remaining() < 90000) throw new CallError("insufficient work budget after writer setup", 3);
      const holdMs = Math.min(280000, controls.remaining() - 1000);
      busy = sendTurn(work, options["busy-session-key"], `KOVA_VERIFY_HOLD ${JSON.stringify({ holdMs, progressCards: false })}`, { method: "sessions.send", onSubmitted: async (receipt, { submittedAtMs }) => { busyRunId = receipt.runId; busyUntilMs = submittedAtMs + holdMs; submitted(); } }).then((value) => ({ value }), (error) => ({ error }));
      const accepted = await Promise.race([admission.then(() => true), busy.then(() => false)]);
      if (!accepted) throw new CallError("held turn was not admitted", 1);
      output.busyRunId = busyRunId; context.record(output);
      for (;;) { try { await active(); break; } catch (error) { controls.remaining(); if ((await rpc("agent.wait", { runId: busyRunId, timeoutMs: 1 }))?.status !== "pending") throw error; await controls.pause(100); } }
      for (const enabled of [true, false]) {
        await write(30000, () => sendTurn(work, options["session-key"], `/dreaming ${enabled ? "on" : "off"}`));
        if ((await readConfig()).plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled !== enabled) throw new CallError("dreaming command did not persist its setting", 1);
        output.dreaming.push({ enabled }); context.record(output); await active();
      }
      const profile = `kova-writer-${randomUUID()}`;
      await write(40000, () => cli(["browser", "create-profile", "--name", profile, "--json"]));
      const created = (await readConfig()).browser?.profiles?.[profile];
      if (!Number.isInteger(created?.cdpPort)) throw new CallError("browser profile creation was not persisted", 1);
      await active();
      await write(40000, () => cli(["browser", "delete-profile", "--name", profile, "--json"]));
      if (Object.hasOwn((await readConfig()).browser?.profiles ?? {}, profile)) throw new CallError("browser profile deletion was not persisted", 1);
      output.browser = { profile, created, removed: true }; context.record(output);
      await active();
      const migration = await write(85000, () => command("python3", ["-c", migrationPty, JSON.stringify([process.execPath, runtime.binaryPath, "file-transfer", "approvals", "migrate"])], scope, controls, "file-transfer migration PTY"));
      const migrated = await policy();
      if (migration.status !== 0 || migration.exact !== true || migration.confirmed !== true || migrated?.policyVersion !== 2 || migrated.nodes?.[nodeId]?.allowReadPaths?.length !== 0 || migrated.pendingReapprovals?.length !== 1 || migrated.pendingReapprovals[0].selector !== nodeId || migrated.pendingReapprovals[0].kind !== "read" || migrated.pendingReapprovals[0].path !== data || migrated.literalGrants?.length) throw new CallError("interactive migration did not persist the exact reapproval", 1);
      if (!(await fileState(`${path}.bak`))) throw new CallError("interactive migration produced no adjacent backup", 1);
      output.migration = { policyVersion: 2, selector: nodeId, kind: "read", path: relative(root, data), legacyAllowRemoved: true, pendingReapproval: true, backupPresent: true }; context.record(output);
      await active();
      await write(65000, async () => {
        const toolContext = { ...work, submittedTurn: async (key, receipt) => { await work.submittedTurn(key, receipt); toolRunId = receipt.runId; } };
        tool = toolTurn.run({ "session-key": options["session-key"], tool: "dir_list", args: JSON.stringify({ node: nodeId, path: data, maxEntries: 1 }) }, toolContext).then((value) => ({ value }), (error) => ({ error }));
        let approvalId;
        for (;;) {
          const pending = await rpc("plugin.approval.list", {});
          if (!Array.isArray(pending)) throw new CallError("plugin approval listing is invalid", 1);
          const matches = pending.filter((entry) => entry.request?.pluginId === "file-transfer" && entry.request.runId === toolRunId && entry.request.sessionKey === options["session-key"] && entry.request.toolName === "dir.list" && entry.request.description?.includes(`\nPath: ${data}\nNode ID: ${nodeId}\n`));
          if (matches.length > 1) throw new CallError("file-transfer approval is ambiguous", 1);
          if (matches.length === 1 && nonempty(toolRunId) && nonempty(matches[0].id)) { approvalId = matches[0].id; break; }
          const settled = await Promise.race([tool, controls.pause(100).then(() => null)]);
          if (settled) throw settled.error ?? new CallError("file-transfer turn completed without its approval", 1);
        }
        await active();
        await rpc("plugin.approval.resolve", { id: approvalId, decision: "allow-always" });
        const completed = await tool;
        if (completed.error) throw completed.error;
        const outer = completed.value.toolResult;
        const wrapped = outer?.details;
        // Tool Search gives bundled plugin tools their plugin namespace, rather
        // than the core namespace handled by the general helper's projection.
        const native = wrapped?.tool?.id === "openclaw:file-transfer:dir_list" && wrapped.tool.name === "dir_list" && wrapped.tool.source === "openclaw" ? wrapped.result : undefined;
        const observed = native ? { name: "dir_list", result: { ...native, ...(outer.isError ? { isError: true } : {}) }, details: native.details } : observedTool(completed.value.toolCall, outer);
        if (observed.name !== "dir_list" || observed.result?.isError === true || observed.details?.path !== await realpath(data) || !observed.details?.entries?.some((entry) => entry.name === "kova-marker.txt")) throw new CallError("real dir_list did not return the fixture marker", 1);
        const final = await policy();
        const grants = final?.literalGrants?.filter((grant) => grant.nodeId === nodeId && grant.command === "dir.list" && grant.requestedPath === data && grant.canonicalPath === observed.details.path);
        if (grants?.length !== 1 || final.pendingReapprovals?.some((pending) => pending.selector === nodeId && pending.kind === "read" && pending.path === data)) throw new CallError("successful transfer did not persist its exact standing grant", 1);
        await active();
        output.standingGrant = { nodeId, command: "dir.list", requestedPath: relative(root, data), canonicalMatchesFixture: true, approvalId, runId: toolRunId, markerReturned: true, pendingReapprovalRemoved: true }; context.record(output);
      });
    } catch (error) { failure = error; }
    finally {
      const errors = [];
      const clean = async (action) => { try { await action(); } catch { errors.push("writer resource restoration failed"); } };
      const runs = [...writerRuns].map((runId) => [options["session-key"], runId]);
      if (busyRunId) runs.push([options["busy-session-key"], busyRunId]);
      for (const [key, runId] of runs) await clean(async () => {
        await rpc("chat.abort", { sessionKey: key, runId, preserveSideRuns: true }, true);
        const completed = await rpc("agent.wait", { runId, timeoutMs: Math.max(1, deadline - Date.now()) }, true);
        if (completed?.runId !== runId || ["pending", "timeout"].includes(completed?.status)) throw new Error("turn cleanup incomplete");
      });
      if (tool) await clean(async () => { await abortable(tool, cleanupSignal()); });
      if (busy) await clean(async () => { await abortable(busy, cleanupSignal()); });
      if (node) await clean(() => node.stop());
      if (nodeId) await clean(async () => { await rpc("node.pair.remove", { nodeId }, true); });
      if (changed) {
        let confirmed = false;
        // Pause is idempotent. Reconfirm it even after a cancelled resume,
        // whose child may already have started before the response was lost.
        await clean(async () => { await lifecycle("pause", true); paused = true; confirmed = true; });
        if (confirmed) await clean(async () => { for (const [file, original] of originals) await replace(file, original); });
      }
      if (paused) await clean(() => lifecycle("resume", true));
      // Public pairing APIs remove an admitted node. An interrupted bootstrap
      // without a confirmed identity cannot be settled by guessing an ID.
      if (enrollmentIssued && !nodeId) errors.push("node admission identity was not confirmed");
      if (directory && errors.length === 0) await clean(() => rm(directory, { recursive: true, force: true }));
      if (directory && errors.length) output.retainedFixture = relative(root, directory);
      output.cleanupComplete = errors.length === 0; context.record(output);
      if (errors.length) { failure ??= new CallError("writer cleanup failed", 1); failure.cleanupError = errors.join("; "); }
    }
    if (failure) throw failure;
    return output;
  }
};
await entrypoint(definition);
