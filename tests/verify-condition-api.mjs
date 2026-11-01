import assert from "node:assert/strict";
import { appendFileSync, lstatSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitConditionRuntime, conditionOwnedPath } from "../support/verify/condition.mjs";
import { runIncognitoSend } from "../support/verify/session-incognito-send.mjs";
import { runColdFork } from "../support/verify/session-cold-fork.mjs";
import { runPlacementReconcile } from "../support/verify/session-placement-reconcile.mjs";

const liveKey = "agent:main:dashboard:incognito-api-test";
const liveId = "api-test-live-session";
const runId = "api-test-run";
const warning = "worker placement session evidence resolution failed; treating all as unknown";

function context({ connect, options = {}, runtime = {}, controller = new AbortController() }) {
  const cleanups = [];
  return {
    connect, options, runtime, signal: controller.signal,
    remaining: () => 180000,
    ownedPath: (path, flags) => conditionOwnedPath(runtime.root, path, flags),
    cleanup: (fn) => cleanups.push(fn),
    async observe(client, method, params, limits) {
      try { return { status: "completed", result: await client.request(method, params, limits), elapsedMs: 1 }; }
      catch (error) { return { status: "error", error: error.message, elapsedMs: 1 }; }
    },
    async finish() {
      const errors = [];
      while (cleanups.length) {
        try { await cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "condition cleanup failed");
    },
  };
}

test("Incognito admission keeps one connection and preserves a rejected send as evidence", async (t) => {
  for (const rejected of [false, true]) await t.test(rejected ? "send rejected" : "turn completed", async () => {
    const methods = [];
    let connections = 0;
    const client = { async request(method, params) {
      methods.push(method);
      if (method === "sessions.create") {
        assert.equal(params.incognito, true);
        return { key: liveKey, sessionId: liveId };
      }
      if (method === "sessions.delete") {
        assert.equal(params.key, liveKey);
        assert.equal(params.expectedSessionId, liveId);
        return { ok: true, deleted: true };
      }
      if (method === "agent.wait") {
        assert.equal(params.runId, runId);
        return { status: "ok", terminalReply: { text: "not-for-report" } };
      }
      assert.equal(params.sessionKey, liveKey);
      if (method === "chat.send") {
        if (rejected) throw new Error("chat.send INVALID_REQUEST: session changed before chat.send; retry the request");
        return { runId, status: "started" };
      }
      assert.equal(method, "chat.history");
      return { messages: [{ role: "user", content: "not-for-report" }, { role: "assistant", content: [{ type: "text", text: "KOVA_AGENT_OK" }] }] };
    } };
    const ctx = context({ connect: async () => { connections++; return client; } });
    const observe = ctx.observe;
    ctx.observe = (actual, ...args) => { assert.equal(actual, client); return observe(actual, ...args); };
    try {
      const output = await runIncognitoSend(ctx);
      assert.equal(connections, 1);
      assert.equal(output.sendAccepted, !rejected);
      assert.equal(output.error, undefined);
      assert.deepEqual(output.createdIds, rejected ? [liveKey, liveId] : [liveKey, liveId, runId]);
      if (rejected) {
        assert.match(output.send.error, /session changed before chat.send/);
        assert.deepEqual(methods, ["sessions.create", "chat.send"]);
      } else {
        assert.equal(output.turnCompleted, true);
        assert.equal(output.replyVisible, true);
        assert.deepEqual(methods, ["sessions.create", "chat.send", "agent.wait", "chat.history"]);
        assert.ok(!JSON.stringify(output).includes("not-for-report"), "full reply and history content must not be retained");
      }
    } finally { await ctx.finish(); }
    assert.equal(methods.at(-1), "sessions.delete");
  });
});

test("cold fork compares the first admission with the immediate retry under read/write scopes", async (t) => {
  for (const rejected of [false, true]) await t.test(rejected ? "first fork rejected" : "both forks accepted", async () => {
    const methods = [], deleted = [], requestedScopes = [];
    let forks = 0;
    const options = { "session-key": "agent:main:cold-source", "entry-id": "cold-user-entry" };
    const admin = { async request(method, params) { assert.equal(method, "sessions.delete"); deleted.push(params.key); return { ok: true }; } };
    const narrow = {
      grantedScopes: ["operator.read", "operator.write"],
      async request(method, params) {
        methods.push(method);
        if (method === "sessions.preview") return { previews: [{ key: options["session-key"], status: "cold" }] };
        assert.equal(method, "sessions.fork", "no intervening history read may warm the source");
        assert.deepEqual(params, { sessionKey: options["session-key"], entryId: options["entry-id"] });
        forks++;
        if (rejected && forks === 1) throw new Error("sessions.fork INVALID_REQUEST: session changed before sessions.fork; retry the request");
        return { sessionKey: `agent:main:dashboard:fork-${forks}`, editorText: "not-for-report" };
      },
    };
    const ctx = context({ options, connect: async (scopes) => { requestedScopes.push(scopes); return scopes ? narrow : admin; } });
    let output;
    try {
      output = await runColdFork(ctx);
      assert.deepEqual(requestedScopes, [undefined, ["operator.read", "operator.write"]]);
      assert.deepEqual(methods, ["sessions.preview", "sessions.fork", "sessions.fork"]);
      assert.equal(output.firstForkAccepted, !rejected);
      assert.equal(output.secondForkAccepted, true);
      assert.equal(output.error, undefined);
      assert.deepEqual(output.createdIds, rejected ? ["agent:main:dashboard:fork-2"] : ["agent:main:dashboard:fork-1", "agent:main:dashboard:fork-2"]);
      assert.ok(!JSON.stringify(output).includes("not-for-report"));
    } finally { await ctx.finish(); }
    assert.deepEqual(deleted, [...output.createdIds].reverse());
    assert.ok(!deleted.includes(options["session-key"]));
  });
});

test("cold fork refuses elevated scopes and a source that is already warm", async (t) => {
  for (const elevated of [true, false]) await t.test(elevated ? "elevated scope" : "warm source", async () => {
    const methods = [];
    const narrow = {
      grantedScopes: ["operator.read", "operator.write", ...(elevated ? ["operator.admin"] : [])],
      async request(method) {
        methods.push(method);
        assert.equal(method, "sessions.preview");
        return { previews: [{ key: "agent:main:cold-source", status: "ok" }] };
      },
    };
    const ctx = context({ options: { "session-key": "agent:main:cold-source", "entry-id": "entry" }, connect: async (scopes) => scopes ? narrow : {} });
    try { await assert.rejects(runColdFork(ctx), elevated ? /exactly operator.read and operator.write/ : /cold preview/); }
    finally { await ctx.finish(); }
    assert.deepEqual(methods, elevated ? [] : ["sessions.preview"]);
  });
});

async function directories(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kova-condition-api-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "clone");
  const stateDir = join(root, ".openclaw");
  await mkdir(join(stateDir, "state"), { recursive: true });
  await mkdir(join(stateDir, "agents"));
  const configPath = join(stateDir, "openclaw.json");
  const logPath = join(stateDir, "gateway.log");
  await writeFile(configPath, JSON.stringify({ logging: { file: logPath } }));
  await writeFile(logPath, `${warning}\n`);
  return { directory, root, stateDir, configPath, logPath, databasePath: join(stateDir, "state", "openclaw.sqlite") };
}

test("placement observation preserves unrelated state and cleans fixtures on completion and interruption", async (t) => {
  for (const mode of ["retired", "retained", "interrupted"]) await t.test(mode, { timeout: 5000 }, async (t) => {
    const paths = await directories(t);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(paths.databasePath);
    db.exec(`CREATE TABLE worker_session_placements (
      session_id TEXT PRIMARY KEY, agent_id TEXT, session_key TEXT, execution_mode TEXT,
      state TEXT, transition_generation INTEGER, created_at_ms INTEGER,
      updated_at_ms INTEGER, state_changed_at_ms INTEGER
    )`);
    const seed = db.prepare("INSERT INTO worker_session_placements VALUES (?, 'main', ?, NULL, 'local', 0, 1, 1, 1)");
    seed.run("unrelated-session", "agent:main:unrelated");
    seed.run(liveId, liveKey);
    const controller = new AbortController();
    const client = { async request(method, params) {
      if (method === "sessions.create") return { key: liveKey, sessionId: liveId };
      if (method === "chat.send") return { runId };
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history") return { sessionId: liveId, messages: [{ role: "user" }, { role: "assistant" }] };
      assert.equal(method, "sessions.delete");
      assert.equal(params.expectedSessionId, liveId);
      db.prepare("DELETE FROM worker_session_placements WHERE session_id = ? AND session_key = ?").run(liveId, params.key);
      return { ok: true, deleted: true };
    } };
    const ctx = context({ runtime: paths, options: { "wait-ms": "150" }, controller, connect: async () => client });
    let seen, observationError;
    const observer = setInterval(() => {
      if (seen || observationError) return;
      try {
        const rows = db.prepare("SELECT * FROM worker_session_placements WHERE session_id NOT IN (?, 'unrelated-session')").all(liveId);
        if (!rows.length) return;
        assert.equal(rows.length, 2, "both fixtures must be inserted together");
        const invalid = rows.find((row) => row.agent_id !== "main");
        const absent = rows.find((row) => row.agent_id === "main");
        assert.ok(lstatSync(join(paths.stateDir, "agents", invalid.agent_id, "agent", "openclaw-agent.sqlite")).isDirectory());
        assert.match(absent.session_key, /:incognito-/);
        seen = rows;
        if (mode === "retired") db.prepare("DELETE FROM worker_session_placements WHERE session_id = ?").run(absent.session_id);
        if (mode === "retained") appendFileSync(paths.logPath, `${warning}\n`);
        if (mode === "interrupted") controller.abort();
      } catch (error) { observationError = error; controller.abort(); }
    }, 5);
    try {
      if (mode === "interrupted") await assert.rejects(runPlacementReconcile(ctx), /aborted/i);
      else {
        const output = await runPlacementReconcile(ctx);
        assert.equal(output.absentRetired, mode === "retired");
        assert.equal(output.invalidRetained, true);
        assert.equal(output.liveRetained, true);
        assert.equal(output.liveHistory.sessionIdMatches, true);
        assert.equal(output.broadWarnings, mode === "retained" ? 1 : 0, "old warnings must not count toward this observation");
        for (const row of seen ?? []) assert.ok(output.createdIds.includes(row.session_id));
      }
      assert.ifError(observationError);
      assert.ok(seen, "the observer must see both committed fixtures");
    } finally {
      clearInterval(observer);
      try {
        await ctx.finish();
        assert.deepEqual(db.prepare("SELECT session_id FROM worker_session_placements").all().map((row) => row.session_id), ["unrelated-session"]);
        assert.deepEqual(await readdir(join(paths.stateDir, "agents")), []);
      } finally { db.close(); }
    }
  });
});

test("placement refuses aliased SQLite files before connecting or writing", async (t) => {
  for (const alias of ["hardlink", "sidecar symlink"]) await t.test(alias, async (t) => {
    const paths = await directories(t);
    const source = join(paths.directory, "protected.sqlite");
    await writeFile(source, "preserve-source");
    if (alias === "hardlink") await link(source, paths.databasePath);
    else {
      await writeFile(paths.databasePath, "unused-clone-file");
      await symlink(source, `${paths.databasePath}-wal`);
    }
    let connected = false;
    const ctx = context({ runtime: paths, connect: async () => { connected = true; throw new Error("must not connect"); } });
    try { await assert.rejects(runPlacementReconcile(ctx), /alias|regular/i); }
    finally { await ctx.finish(); }
    assert.equal(connected, false);
    assert.equal(await readFile(source, "utf8"), "preserve-source");
  });
});

test("clone admission rejects symlinked agent paths and an external custom session store", async (t) => {
  const paths = await directories(t);
  const external = await realpath(await mkdtemp(join(tmpdir(), "kova-condition-source-")));
  t.after(() => rm(external, { recursive: true, force: true }));
  const linked = join(paths.root, "linked-agent");
  await symlink(external, linked);
  const safeWorkspace = join(paths.root, "workspace");
  await mkdir(safeWorkspace);
  await writeFile(paths.configPath, JSON.stringify({ agents: { defaults: { workspace: safeWorkspace } } }));
  assert.equal((await admitConditionRuntime(paths)).root, paths.root);
  for (const field of ["workspace", "agentDir"]) {
    await writeFile(paths.configPath, JSON.stringify({ agents: { list: [{ id: "main", [field]: linked }] } }));
    await assert.rejects(admitConditionRuntime(paths), /alias|external|clone|path/i);
  }
  await writeFile(paths.configPath, JSON.stringify({ session: { store: join(external, "sessions.json") } }));
  await assert.rejects(admitConditionRuntime(paths), /external|clone|store|path/i);
});
