import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { definition as cursor, projectSessionStatusCursor } from "../support/verify/session-status-cursor.mjs";
import { definition as session } from "../support/verify/session-send-turn.mjs";
import { scriptMain } from "../support/verify/script.mjs";
import { toolArguments } from "../support/verify/agent-tool-turn.mjs";
import { compactionInput, CompactionInputError, prepareAutomaticCompaction } from "../support/automatic-compaction.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const exec = promisify(execFile);
const key = "agent:main:threshold";
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsSessionContent = nodeMajor > 22 || nodeMajor === 22 && nodeMinor >= 19;
const schemas = await loadGatewaySchemaAssertions();
const budget = (headroom = 4978) => ({ key, sessionId: "window", contextBudgetStatus: {
  sessionId: "window", estimatedPromptTokens: 76000 - headroom,
  promptBudgetBeforeReserve: 76000, route: "fits", shouldCompact: false
} });

function records() {
  return {
    caller: { method: "sessions.create", result: { key: "agent:main:caller" }, error: null },
    target: { method: "sessions.create", result: { key: "agent:main:watched" }, error: null },
    source: {
      callerSessionKey: "agent:main:caller",
      toolCall: { name: "session_status", args: { sessionKey: "agent:main:watched" } },
      toolResult: { isError: false, details: { sessionKey: "agent:main:watched", stateVersion: 7 } },
      error: null
    }
  };
}
const project = ({ source, caller, target }) => projectSessionStatusCursor(source, caller, target);

function dispatchedRecords() {
  const input = records();
  // agent-tool-turn keeps the native dispatcher result and normalizes the call.
  input.source.toolCall.arguments = { id: "session_status", args: { ...input.source.toolCall.args } };
  input.source.toolResult = { isError: false, toolName: "tool_call", details: {
    tool: { id: "openclaw:core:session_status", name: "session_status", source: "openclaw" },
    result: input.source.toolResult
  } };
  return input;
}

async function directory(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("status cursor requires successful matching caller, requested target and returned target", () => {
  for (const version of [0, 7, Number.MAX_SAFE_INTEGER]) {
    const input = records();
    input.source.toolResult.details.stateVersion = version;
    assert.deepEqual(project(input), { sessionKey: "agent:main:watched", changesSince: version });
  }
  const cases = [
    (input) => { input.source.error = "turn failed"; },
    (input) => { delete input.source.error; },
    (input) => { input.source.callerSessionKey = "agent:main:other"; },
    (input) => { input.source.toolCall.name = "sessions_send"; },
    (input) => { input.source.toolCall.args.sessionKey = "agent:main:other"; },
    (input) => { delete input.source.toolCall; },
    (input) => { input.source.toolResult.details.sessionKey = "agent:main:other"; },
    (input) => { delete input.source.toolResult.details.sessionKey; },
    (input) => { input.source.toolResult.isError = true; },
    (input) => { input.source.toolResult.isError = "false"; },
    (input) => { input.source.toolResult = null; },
    (input) => { input.caller.error = "creation failed"; },
    (input) => { input.target.error = "creation failed"; },
    (input) => { input.caller.method = "sessions.describe"; },
    (input) => { input.target.result.key = ""; },
    (input) => { delete input.target.error; }
  ];
  for (const edit of cases) {
    const input = records(); edit(input);
    assert.throws(() => project(input), (error) => error.exitCode === 2);
  }
  for (const version of [undefined, null, "7", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = records(); input.source.toolResult.details.stateVersion = version;
    assert.throws(() => project(input), /stateVersion/);
  }
});

test("status cursor projects native dispatcher results without accepting failed or unrelated tools", () => {
  const input = dispatchedRecords();
  input.source.toolResult.details.result.details.stateVersion = 0;
  const before = structuredClone(input);
  assert.deepEqual(project(input), { sessionKey: "agent:main:watched", changesSince: 0 });
  assert.deepEqual(input, before);
  for (const edit of [
    (s) => { s.error = "turn failed"; },
    (s) => { s.callerSessionKey = "agent:main:other"; },
    (s) => { s.toolCall.args.sessionKey = "agent:main:other"; },
    (s) => { s.toolResult.isError = true; },
    (s) => { s.toolResult.isError = "false"; },
    (s) => { s.toolResult.details.result.isError = true; },
    (s) => { s.toolResult.details.result.isError = "false"; },
    (s) => { s.toolResult.details.result.details.sessionKey = "agent:main:other"; },
    (s) => { s.toolResult.details.result.details.stateVersion = -1; },
    (s) => { s.toolResult.details.tool.source = "plugin"; },
    (s) => { s.toolResult.details.tool.id = "openclaw:core:sessions_send"; },
    (s) => { s.toolResult.details.tool.name = "sessions_send"; },
    (s) => { delete s.toolResult.details.result; },
    (s) => { s.toolResult.details.result = []; }
  ]) {
    const invalid = dispatchedRecords(); edit(invalid.source);
    assert.throws(() => project(invalid), (error) => error.exitCode === 2);
  }
});

test("cursor CLI publishes only tool arguments, emits declared JSON and preserves existing files", async (t) => {
  const root = await directory(t, "kova-status-cursor-");
  const input = dispatchedRecords();
  const paths = Object.fromEntries(["source", "caller", "target"].map((name) => [name, join(root, `${name}.json`)]));
  for (const name of Object.keys(paths)) await writeFile(paths[name], JSON.stringify(input[name]));
  const args = ["--from", paths.source, "--session-from", paths.caller, "--target-from", paths.target];
  const invoke = async (out, extra = []) => {
    const result = await exec(process.execPath, [fileURLToPath(cursor.url), ...args, "--out", out, ...extra], { timeout: 10000 }).catch((error) => error);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["changesSince", "error", "sessionKey"]);
    return { output, exitCode: result.code ?? 0 };
  };
  const out = join(root, "cursor.json");
  const success = await invoke(out);
  assert.equal(success.exitCode, 0, success.output.error);
  assert.deepEqual(success.output, { sessionKey: "agent:main:watched", changesSince: 7, error: null });
  const saved = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(saved, { sessionKey: "agent:main:watched", changesSince: 7 });
  assert.deepEqual(await toolArguments({ args: "{}", "merge-from": out }, { read: async () => saved }, "agent:main:caller"), saved);

  for (const existing of [out, paths.source, paths.caller, paths.target]) {
    const before = await readFile(existing, "utf8");
    const result = await invoke(existing);
    assert.equal(result.exitCode, 2);
    assert.deepEqual({ ...result.output, error: null }, { sessionKey: null, changesSince: null, error: null });
    assert.equal(await readFile(existing, "utf8"), before);
  }
  const invalid = join(root, "invalid.json");
  assert.equal((await invoke(invalid, ["--from", paths.source])).exitCode, 2);
  await assert.rejects(access(invalid), { code: "ENOENT" });
  input.source.toolResult.details.result.details.sessionKey = "agent:main:other";
  await writeFile(paths.source, JSON.stringify(input.source));
  assert.equal((await invoke(invalid)).exitCode, 2);
  await assert.rejects(access(invalid), { code: "ENOENT" });
  await writeFile(paths.source, "not JSON");
  assert.equal((await invoke(invalid)).exitCode, 2);
  await assert.rejects(access(invalid), { code: "ENOENT" });
});

test("session adapter forwards compaction only when requested and rejects malformed combinations", async () => {
  for (const value of [undefined, "false", "true"]) {
    let args;
    const flags = ["--env", "kova-helpers-compaction", "--session-key", key, "--create-session", "false"];
    if (value !== undefined) flags.push("--require-auto-compaction", value);
    const result = await scriptMain(session, flags, { context: { helper: async (name, received) => {
      assert.equal(name, "run-gateway-session-send-turn"); args = received;
      return { status: 0, value: { ok: true, sessionKey: key, runId: "submitted-run", finalAssistantVisibleText: "KOVA_AGENT_OK" } };
    } } });
    assert.equal(result.exitCode, 0, result.output.error);
    const index = args.indexOf("--require-auto-compaction");
    if (value === undefined) assert.equal(index, -1);
    else assert.equal(args[index + 1], value);
  }
  for (const extra of [["--require-auto-compaction", "true"], ["--require-auto-compaction", "yes"], ["--require-auto-compaction"]]) {
    const result = await scriptMain(session, ["--env", "kova-helpers-compaction", "--session-key", key, ...extra], { context: {
      helper() { assert.fail("invalid compaction call must not launch a helper"); }
    } });
    assert.equal(result.exitCode, 2);
  }
});

test("compaction input crosses measured headroom but rejects stale and excessive budgets", () => {
  for (const headroom of [0, 300, 4978, 20000]) {
    const value = compactionInput(budget(headroom), key, "Reply KOVA_AGENT_OK.");
    assert.equal(value.headroom, headroom);
    assert.ok(value.fillerCharacters / 4 > headroom);
    assert.equal(value.inputCharacters, value.message.length);
    assert.ok(value.message.endsWith("\nReply KOVA_AGENT_OK."));
    assert.match(value.message, /^KOVA_AUTOMATIC_COMPACTION_USAGE$/m);
    assert.ok(value.message.length <= 1000000);
  }
  for (const edit of [
    (s) => { s.key = "agent:main:other"; },
    (s) => { s.contextBudgetStatus.sessionId = "old"; },
    (s) => { s.contextBudgetStatus.estimatedPromptTokens = NaN; },
    (s) => { s.contextBudgetStatus.estimatedPromptTokens = -1; },
    (s) => { s.contextBudgetStatus.promptBudgetBeforeReserve = 100; },
    (s) => { s.contextBudgetStatus.promptBudgetBeforeReserve = 1000000; },
    (s) => { s.contextBudgetStatus.shouldCompact = true; },
    (s) => { s.contextBudgetStatus.route = "compact"; }
  ]) {
    const value = budget(); edit(value);
    assert.throws(() => compactionInput(value, key, "Reply."), CompactionInputError);
  }
});

test("compaction evidence requires a fresh native event after the observed sequence", { skip: !supportsSessionContent }, async () => {
  const record = (seq, id, extra = {}) => ({ seq, event: { type: "compaction", id, ...extra } });
  const before = { key, sessionId: "window", events: [record(2, "old"), { seq: 10, event: { type: "message" } }] };
  const prepare = async (after) => {
    let reads = 0;
    return prepareAutomaticCompaction({ key, state: "/fixture", message: "Reply.",
      request: async () => ({ session: budget() }), readSession: async () => reads++ === 0 ? before : after });
  };
  const control = await prepare({ ...before, events: [...before.events, record(11, "new")] });
  assert.deepEqual((await control.finish("submitted-run")).newEntryIds, ["new"]);
  for (const events of [before.events, [...before.events, record(11, "old")], [...before.events, record(11, "custom", { type: "custom" })], [...before.events, record(9, "earlier")]]) {
    const failed = await prepare({ ...before, events });
    await assert.rejects(failed.finish("submitted-run"), (error) => error.compaction.newAutomaticCompactions === 0);
  }
  const changed = await prepare({ ...before, sessionId: "other", events: [record(11, "new")] });
  await assert.rejects(changed.finish("submitted-run"), /identity changed/);
});

test("opt-in helper reads the native store and fails when the completed turn adds no compaction", { skip: !supportsSessionContent }, async (t) => {
  const root = await directory(t, "kova-compaction-helper-");
  const state = join(root, "state");
  const agent = join(state, "agents", "main", "agent");
  await mkdir(agent, { recursive: true });
  const database = join(agent, "openclaw-agent.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT);
    CREATE TABLE session_windows (session_key TEXT, session_id TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT);`);
  db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(key, "window", JSON.stringify({ sessionId: "window" }));
  db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(key, "window");
  db.close();
  const calls = join(root, "calls.jsonl");
  const runtimeUrl = new URL("../support/openclaw-runtime.mjs", import.meta.url).href;
  const mockRuntime = join(root, "runtime.mjs");
  // Substitute the transport and environment lookup only. The executable helper,
  // budget calculation and bounded SQLite reader remain the production code.
  await writeFile(mockRuntime, `
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
let submittedRunId;
export { extractAssistantVisibleText, failJson, finishJson, parseSupportArgs, readTimeoutMs, sleep } from ${JSON.stringify(`${runtimeUrl}?original`)};
export const prepareOpenClawRuntimeFromOcmEnv = (envName) => ({ envName, runtime: {} });
export const runOcmJson = () => ({ stateDir: ${JSON.stringify(state)} });
export const openDirectGatewayRpcClient = async () => ({ transport: "fixture", client: {
  close() {},
  async request(method, params) {
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method, params }) + "\\n");
    if (method === "sessions.describe") return { session: ${JSON.stringify(budget())} };
    if (method === "sessions.send") { submittedRunId = params.idempotencyKey; return { runId: submittedRunId }; }
    if (method === "agent.wait") {
      if (process.env.KOVA_COMPACTION_CASE === "success") {
        const db = new DatabaseSync(${JSON.stringify(database)});
        try { db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run("window", 11, JSON.stringify({ type: "compaction", id: "new" })); } finally { db.close(); }
      }
      return { runId: params.runId, status: "ok" };
    }
    if (method === "chat.history") return { messages: [{ role: "assistant", content: "KOVA_AGENT_OK", __openclaw: { runId: submittedRunId } }] };
    throw new Error("unexpected method: " + method);
  }
} });
`);
  const loader = join(root, "loader.mjs");
  await writeFile(loader, `export function resolve(specifier, context, next) {
    if (new URL(specifier, context.parentURL).href === ${JSON.stringify(runtimeUrl)}) return { url: ${JSON.stringify(pathToFileURL(mockRuntime).href)}, shortCircuit: true };
    return next(specifier, context);
  }`);
  const register = join(root, "register.mjs");
  await writeFile(register, `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const helper = fileURLToPath(new URL("../support/run-gateway-session-send-turn.mjs", import.meta.url));
  const run = async (enabled, mode) => {
    const db = new DatabaseSync(database);
    try { db.exec("DELETE FROM transcript_events"); } finally { db.close(); }
    await writeFile(calls, "");
    const result = await exec(process.execPath, ["--import", register, helper, "--env", "kova-helpers-compaction", "--session-key", key,
      "--create-session", "false", "--timeout", "1500", ...(enabled === undefined ? [] : ["--require-auto-compaction", String(enabled)])],
    { env: { ...process.env, KOVA_COMPACTION_CASE: mode }, timeout: 10000 }).catch((error) => error);
    const captured = (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    for (const { method, params } of captured) schemas.check(method, params);
    return { output: JSON.parse(result.stdout), exitCode: result.code ?? 0, calls: captured };
  };
  for (const enabled of [undefined, false]) {
    const result = await run(enabled, "success");
    assert.equal(result.exitCode, 0, result.output.error);
    assert.deepEqual(result.calls.map(({ method }) => method), ["sessions.send", "agent.wait", "chat.history"]);
    assert.equal(result.output.compaction, undefined);
    assert.equal(result.calls[0].params.message, "Reply with exact ASCII text KOVA_AGENT_OK only.");
  }
  const success = await run(true, "success");
  assert.equal(success.exitCode, 0, success.output.error);
  assert.deepEqual(success.calls.map(({ method }) => method), ["sessions.describe", "sessions.send", "agent.wait", "chat.history"]);
  assert.match(success.calls[1].params.message, /^KOVA_AUTOMATIC_COMPACTION_USAGE$/m);
  assert.deepEqual(success.output.compaction.newEntryIds, ["new"]);
  assert.equal(success.output.compaction.runId, success.calls[1].params.idempotencyKey);
  const absent = await run(true, "absent");
  assert.equal(absent.exitCode, 1);
  assert.equal(absent.output.recordStatus, "FAIL");
  assert.equal(absent.output.runId, absent.calls[1].params.idempotencyKey);
  assert.equal(absent.output.compaction.newAutomaticCompactions, 0);
  assert.match(absent.output.error, /without a new native automatic compaction/);
});

test("automatic compaction helper requests satisfy the pinned schemas", { skip: !supportsSessionContent }, (t) => schemas.report(t));
