import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { conditionOwnedPath } from "../support/verify/condition.mjs";
import { memoryRollbackSearch } from "../support/verify/memory-rollback-search.mjs";
import { sessionWorkerCancel, workerMockModel, workerReplyObservation } from "../support/verify/session-worker-cancel.mjs";

function editDatabase(path, callback) {
  const db = new DatabaseSync(path);
  try { return callback(db); } finally { db.close(); }
}

async function memoryFixture(t, mode = "rebuild") {
  const root = await mkdtemp(join(tmpdir(), "kova-condition-state-"));
  const workspace = join(root, "workspace");
  const database = join(root, "agent.sqlite");
  const configPath = join(root, "openclaw.json");
  await mkdir(workspace);
  await writeFile(join(workspace, "retained.txt"), "untouched workspace content\n");
  const originalConfig = `// Preserve the original formatting as well as its values.\n${JSON.stringify({ agents: { entries: { main: { workspace } } }, memory: { search: { enabled: false } } }, null, 2)}\n`;
  await writeFile(configPath, originalConfig);
  const initializeDatabase = (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS memory_index_meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS retained (value TEXT);");
    db.prepare("INSERT OR IGNORE INTO memory_index_meta VALUES (?, ?)").run("memory_index_meta_v1", JSON.stringify({ provenanceVersion: 1, owner: "fixture" }));
    db.prepare("INSERT INTO retained SELECT ? WHERE NOT EXISTS (SELECT 1 FROM retained)").run("before indexing");
  };
  if (mode !== "absent") editDatabase(database, initializeDatabase);
  await writeFile(`${database}.reindex-lock.sqlite`, "original lock bytes");
  const originalDatabase = mode === "absent" ? null : await readFile(database);
  const controller = new AbortController();
  const cleanups = [], lifecycle = [];
  let cleaned = false, clientClosed = false, pauseCount = 0, resumeCount = 0;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const callback of cleanups.reverse()) await callback();
  };
  t.after(async () => {
    try { await cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const embedding = async (inputType, input) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const response = await fetch(`${config.memory.search.remote.baseUrl}/embeddings`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.memory.search.model, input_type: inputType, input }),
      signal: AbortSignal.timeout(2000)
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, input.length);
  };
  const ctx = {
    runtime: { root, configPath },
    options: { env: "kova-run-condition-test", "gateway-handle": join(root, "gateway.json") },
    signal: controller.signal,
    remaining() { controller.signal.throwIfAborted(); return 60000; },
    ownedPath: (path, options) => conditionOwnedPath(root, path, options),
    cleanup: (callback) => cleanups.push(callback),
    connect: async () => ({ close() { clientClosed = true; } }),
    async observe(_client, method, params) {
      assert.equal(method, "memory.search");
      assert.deepEqual(params, { agentId: "main", query: "KOVA_MEMORY_ROLLBACK", minScore: 0 });
      assert.equal(editDatabase(database, (db) => JSON.parse(db.prepare("SELECT value FROM memory_index_meta").get().value).provenanceVersion), 2);
      if (mode === "stale") return { status: "completed", elapsedMs: 1, result: { stale: true, results: [], warning: "Memory index is stale", action: "Rebuilding may call the embedding provider and incur provider cost." } };
      await embedding("document", ["retained memo", "Alpha KOVA_MEMORY_ROLLBACK"]);
      await embedding("query", ["KOVA_MEMORY_ROLLBACK"]);
      editDatabase(database, (db) => db.prepare("UPDATE memory_index_meta SET value = ?").run(JSON.stringify({ provenanceVersion: 1, owner: "rebuilt" })));
      const fixture = (await readdir(join(workspace, "memory"))).find((name) => name.startsWith(".kova-memory-"));
      return { status: "completed", elapsedMs: 2, result: { results: [{ path: `memory/${fixture}` }] } };
    }
  };
  const dependencies = {
    async requestGatewayLifecycle(options) {
      assert.equal(options.env, ctx.options.env);
      assert.equal(options["gateway-handle"], ctx.options["gateway-handle"]);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120000);
      lifecycle.push(options.operation);
      if (options.operation === "pause") pauseCount++;
      else resumeCount++;
      if (mode === "pause-failure" && pauseCount === 2 && options.operation === "pause" || mode === "resume-failure" && resumeCount === 1 && options.operation === "resume") return { exitCode: 1, output: { error: "fixture lifecycle refusal" } };
      return { exitCode: 0, output: { result: { paused: options.operation === "pause", ready: options.operation === "resume" }, elapsedMs: 1 } };
    },
    async productCommand(_ctx, args) {
      if (args[1] === "status") return JSON.stringify([{ agentId: "main", status: { dbPath: database } }]);
      assert.deepEqual(args, ["memory", "index", "--agent", "main", "--force"]);
      await embedding("document", ["retained memo", "Alpha KOVA_MEMORY_ROLLBACK"]);
      editDatabase(database, (db) => {
        initializeDatabase(db);
        db.prepare("UPDATE retained SET value = ?").run("modified by index");
        db.prepare("UPDATE memory_index_meta SET value = ?").run(JSON.stringify({ provenanceVersion: 1, owner: "indexed" }));
      });
      await writeFile(`${database}.reindex-lock.sqlite`, "modified lock bytes");
      await writeFile(`${database}.reindex-lock.sqlite-shm`, "temporary lock member");
      if (mode === "abort-index") {
        controller.abort(new Error("interrupted indexing"));
        controller.signal.throwIfAborted();
      }
      return "";
    }
  };
  return {
    root, workspace, database, configPath, ctx, dependencies, cleanup, lifecycle,
    clientClosed: () => clientClosed,
    async assertRestored() {
      if (originalDatabase) assert.deepEqual(await readFile(database), originalDatabase);
      else await assert.rejects(readFile(database), { code: "ENOENT" });
      assert.equal(await readFile(configPath, "utf8"), originalConfig);
      assert.equal(await readFile(`${database}.reindex-lock.sqlite`, "utf8"), "original lock bytes");
      await assert.rejects(readFile(`${database}.reindex-lock.sqlite-shm`), { code: "ENOENT" });
      assert.deepEqual(await readdir(workspace), ["retained.txt"]);
      assert.equal((await readdir(root)).some((name) => name.startsWith(".kova-memory-")), false);
    }
  };
}

test("memory rollback separates indexing costs from ordinary search and restores SQLite bytes", async (t) => {
  const fixture = await memoryFixture(t);
  const result = await memoryRollbackSearch(fixture.ctx, fixture.dependencies);
  assert.equal(result.conditionEstablished, true);
  assert.deepEqual(result.provenance, { initialVersion: 1, newerVersion: 2, afterSearchVersion: 1 });
  assert.deepEqual(result.embeddingRequests.map((request) => request.phase), ["index", "search", "search"]);
  assert.equal(result.searchDocumentInputs, 2);
  assert.equal(result.searchQueryInputs, 1);
  assert.equal(result.searchEmbeddingRequests, 2);
  assert.equal(result.rebuiltDuringSearch, true);
  assert.equal(result.costWarning, false);
  assert.equal(result.search.fixtureFound, true);
  assert.equal(result.restored, false);
  await fixture.cleanup();
  assert.equal(result.restored, true);
  assert.equal(fixture.clientClosed(), true);
  assert.deepEqual(fixture.lifecycle, ["pause", "resume", "pause", "resume"]);
  await fixture.assertRestored();
});

test("memory rollback retains a stale index and cost warning without search embedding calls", async (t) => {
  const fixture = await memoryFixture(t, "stale");
  const result = await memoryRollbackSearch(fixture.ctx, fixture.dependencies);
  assert.equal(result.provenance.afterSearchVersion, 2);
  assert.equal(result.rebuiltDuringSearch, false);
  assert.equal(result.costWarning, true);
  assert.equal(result.searchEmbeddingRequests, 0);
  assert.equal(result.searchDocumentInputs, 0);
  assert.equal(result.searchQueryInputs, 0);
  await fixture.cleanup();
  await fixture.assertRestored();
});

test("memory rollback can build an initially absent index and removes it afterward", async (t) => {
  const fixture = await memoryFixture(t, "absent");
  const result = await memoryRollbackSearch(fixture.ctx, fixture.dependencies);
  assert.equal(result.conditionEstablished, true);
  assert.equal(result.rebuiltDuringSearch, true);
  await fixture.cleanup();
  assert.equal(result.restored, true);
  await fixture.assertRestored();
});

test("interrupted indexing restores the database and configuration before resuming", async (t) => {
  const fixture = await memoryFixture(t, "abort-index");
  await assert.rejects(memoryRollbackSearch(fixture.ctx, fixture.dependencies), /interrupted indexing/);
  await fixture.cleanup();
  assert.deepEqual(fixture.lifecycle, ["pause", "resume"]);
  await fixture.assertRestored();
});

test("uncertain startup is paused again before restoring the memory fixture", async (t) => {
  const fixture = await memoryFixture(t, "resume-failure");
  const result = await memoryRollbackSearch(fixture.ctx, fixture.dependencies);
  assert.equal(result.startup.status, "error");
  assert.equal(result.conditionEstablished, false);
  await fixture.cleanup();
  assert.deepEqual(fixture.lifecycle, ["pause", "resume", "pause", "resume"]);
  await fixture.assertRestored();
});

test("failed pause prevents writing the saved database over a possibly running Gateway", async (t) => {
  const fixture = await memoryFixture(t, "pause-failure");
  const result = await memoryRollbackSearch(fixture.ctx, fixture.dependencies);
  await assert.rejects(fixture.cleanup(), /Gateway pause failed/);
  assert.equal(result.restored, false);
  assert.equal(editDatabase(fixture.database, (db) => db.prepare("SELECT value FROM retained").get().value), "modified by index");
  assert.equal(JSON.parse(await readFile(fixture.configPath, "utf8")).memory.search.enabled, true);
  assert.equal((await readdir(fixture.root)).some((name) => name.startsWith(".kova-memory-")), true);
  assert.equal(fixture.clientClosed(), true);
  assert.deepEqual(fixture.lifecycle, ["pause", "resume", "pause"]);
});

test("memory restoration rejects a replaced configuration alias and keeps its target unchanged", async (t) => {
  const fixture = await memoryFixture(t);
  const result = await memoryRollbackSearch(fixture.ctx, fixture.dependencies);
  const protectedFile = join(fixture.root, "unrelated-config.json");
  await writeFile(protectedFile, "unrelated configuration\n");
  await unlink(fixture.configPath);
  await symlink(protectedFile, fixture.configPath);
  await assert.rejects(fixture.cleanup(), /restoration was incomplete/);
  assert.equal(result.restored, false);
  assert.equal(await readFile(protectedFile, "utf8"), "unrelated configuration\n");
  assert.deepEqual(fixture.lifecycle, ["pause", "resume", "pause"]);
});

test("worker reply observations distinguish new duplicates, prior replies and an absent follow-up", () => {
  const previous = [{ id: "earlier", role: "assistant", content: "KOVA_AGENT_OK" }];
  const duplicates = [
    ...previous,
    { id: "worker-commit", role: "assistant", content: [{ type: "text", text: "KOVA_AGENT_OK" }], __openclaw: { runId: "run-one" } },
    { id: "gateway-reply", role: "assistant", content: "KOVA_AGENT_OK", __openclaw: { runId: "run-one" } }
  ];
  const ordinary = workerReplyObservation(previous, duplicates);
  assert.equal(ordinary.assistantCount, 2);
  assert.equal(ordinary.expectedReplyCount, 2);
  assert.deepEqual(ordinary.assistantRows.map((row) => row.id), ["worker-commit", "gateway-reply"]);
  assert.equal(ordinary.assistantRows.some((row) => Object.hasOwn(row, "content")), false);
  const followup = workerReplyObservation(duplicates, [...duplicates, { id: "new-user", role: "user", content: "follow-up" }]);
  assert.equal(followup.assistantCount, 0);
  assert.equal(workerReplyObservation([], [{ role: "assistant", content: "KOVA_AGENT_OK" }]).assistantCount, null);
});

test("worker model guard rejects external providers and inherited fallbacks before pairing", () => {
  const config = { agents: { defaults: { model: "openai/mock" } }, models: { providers: { openai: { baseUrl: "http://127.0.0.1:32123/v1" } } } };
  assert.equal(workerMockModel(config), "openai/mock");
  for (const baseUrl of ["https://api.openai.com/v1", "http://127.0.0.1.example/v1", "http://fixture:fixture@127.0.0.1/v1"]) {
    const candidate = structuredClone(config);
    candidate.models.providers.openai.baseUrl = baseUrl;
    assert.throws(() => workerMockModel(candidate), /mock provider/);
  }
  const fallback = structuredClone(config);
  fallback.agents.defaults.model = { primary: "openai/mock", fallbacks: ["other/model"] };
  assert.throws(() => workerMockModel(fallback), /without provider fallbacks/);
});

test("paired worker refuses another clone's foreground handle before filesystem or pairing effects", async () => {
  const ctx = {
    options: { env: "kova-run-selected", "gateway-handle": "/fixture/gateway.json" },
    runtime: { root: "/fixture/selected", gatewayPort: 32123 },
    ownedPath() { assert.fail("must reject before opening clone files"); },
    connect() { assert.fail("must reject before pairing"); }
  };
  await assert.rejects(sessionWorkerCancel(ctx, { readOperation: async () => ({ entry: "foreground-gateway-start", method: "gateway.start", env: "kova-run-other", expiresAt: new Date(Date.now() + 60000).toISOString(), handle: { ref: { root: ctx.runtime.root, port: ctx.runtime.gatewayPort } } }) }), /this clone's running foreground Gateway/);
});


test("paired worker removes private files even when pairing cleanup fails", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kova-worker-cleanup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, ".openclaw"), configPath = join(stateDir, "openclaw.json");
  await mkdir(join(stateDir, "state"), { recursive: true });
  await writeFile(join(stateDir, "state", "openclaw.sqlite"), "unused placement database");
  await writeFile(configPath, JSON.stringify({ agents: { defaults: { model: "openai/mock" } }, models: { providers: { openai: { baseUrl: "http://127.0.0.1:12345/v1" } } } }));
  const cleanup = [];
  let workerRoot;
  const client = { url: "ws://127.0.0.1:12346", ws: new EventTarget(), async request() { throw new Error("pairing status unavailable"); } };
  const ctx = {
    options: { env: "kova-run-selected", "gateway-handle": join(root, "gateway.json") },
    runtime: { root, stateDir, configPath, gatewayPort: 12346 },
    signal: new AbortController().signal,
    remaining: () => 300000,
    ownedPath: (path, flags) => conditionOwnedPath(root, path, flags),
    cleanup: fn => cleanup.push(fn),
    async connect() {
      workerRoot = join(root, (await readdir(root)).find(name => name.startsWith(".kova-worker-")));
      await writeFile(join(workerRoot, "target"), "test-only-pairing-value");
      await writeFile(join(workerRoot, "tmp"), "block worker preparation");
      return client;
    },
    async observe() { return { status: "completed", result: { setupCode: "test-only-pairing-value", setupId: "test-setup" } }; }
  };
  await assert.rejects(sessionWorkerCancel(ctx, { readOperation: async () => ({
    entry: "foreground-gateway-start", method: "gateway.start", env: ctx.options.env,
    directory: root, expiresAt: new Date(Date.now() + 60000).toISOString(),
    handle: { ref: { root, port: 12346 } }
  }) }), /EEXIST/);
  const failures = [];
  for (const finish of cleanup.reverse()) try { await finish(); } catch (error) { failures.push(error); }
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /cleanup was incomplete/);
  await assert.rejects(readFile(join(workerRoot, "target")), { code: "ENOENT" });
  assert.ok(!(await readdir(root)).some(name => name.startsWith(".kova-worker-")));
});
