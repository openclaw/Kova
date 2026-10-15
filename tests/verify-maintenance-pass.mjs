import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { atomicJson } from "../support/verify/background.mjs";
import { definition, maintenanceCapSize, readMaintenanceRows, runMaintenancePass } from "../support/verify/session-maintenance-pass.mjs";
import { parseScriptArgs } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const DAY = 86400000;
const active = (entry) => entry.archivedAt === undefined;
const activity = (entry) => Math.max(...["updatedAt", "lastInteractionAt", "lastActivityAt", "sessionStartedAt"].map((field) => entry[field] ?? 0));

async function setup(t, { disk = false, wrongReason = false, losePin = false, cancelDisk = false, failRestoreResume = false, turnCompletion = "ok" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kova-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, ".openclaw"), configPath = join(state, "openclaw.json");
  await mkdir(state);
  const original = Buffer.from('{ // preserve the original formatting\n "session": {"maintenance":{"mode":"warn","maxEntries":5000}}, "note":"unchanged"\n}\n');
  await writeFile(configPath, original);
  const options = parseScriptArgs(definition, ["--env", "kova-scripts-maintenance", "--agent", "research", "--gateway-handle", join(root, "gateway.json"), "--timeout", "240000", ...(disk ? ["--disk-budget"] : [])]);
  const target = { root, state, configPath, db: join(state, "agents/research/agent/openclaw-agent.sqlite"), sessions: join(state, "agents/research/sessions"), agentId: "research", runtime: {} };
  const unrelatedKey = "agent:research:existing";
  const unrelated = { sessionId: randomUUID(), label: "existing", updatedAt: Date.now() };
  const rows = new Map([[unrelatedKey, unrelated]]), runs = new Map(), controller = new AbortController();
  let result = {}, paused = false, pressure, deleted = false, cleaned = false;
  const calls = [];
  const context = {
    signal: controller.signal, remaining: () => 240000, runtime: () => target.runtime,
    record(value) { result = structuredClone(value); }
  };
  const dependencies = {
    inspect: async () => target,
    async lifecycle(argv, { signal }) {
      signal.throwIfAborted();
      assert.deepEqual(argv.slice(1, 5), ["--env", options.env, "--gateway-handle", options["gateway-handle"]]);
      const action = argv[0]; calls.push(action);
      if (action === "resume" && failRestoreResume && cleaned) return { exitCode: 1, output: { error: "resume failed", result: { ready: false } } };
      paused = action === "pause";
      return { exitCode: 0, output: { method: `gateway.${action}`, error: null, result: { paused, ready: !paused, refused: false } } };
    },
    async readRows() {
      if (cancelDisk && deleted && !paused) controller.abort(new Error("cancelled during disk observation"));
      return structuredClone(rows);
    },
    async fixtures(_target, items, controls) {
      assert.equal(paused, true);
      controls.signal.throwIfAborted();
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).session.maintenance.mode, "warn");
      for (const item of items) {
        const saved = rows.get(item.key);
        assert.equal(saved.sessionId, item.sessionId);
        if (item.remove) {
          if (!wrongReason && !losePin && !cancelDisk && turnCompletion === "ok") assert.ok(result.observations, "cleanup follows the completed product observation");
          rows.delete(item.key); cleaned = true;
        } else {
          assert.equal(saved.label, item.label);
          Object.assign(saved, item.fields);
        }
      }
    },
    async rpc(method, params) {
      schemas.check(method, params);
      assert.equal(paused, false);
      calls.push(method);
      const policy = JSON.parse(await readFile(configPath, "utf8")).session.maintenance;
      if (method !== "agent.wait") assert.equal(params.agentId, "research");
      if (method === "sessions.create") {
        assert.equal(policy.mode, "warn");
        assert.equal(rows.has(params.key), false);
        const entry = { sessionId: randomUUID(), label: params.label, updatedAt: Date.now() };
        rows.set(params.key, entry);
        return { key: params.key, sessionId: entry.sessionId };
      }
      if (method === "sessions.send") {
        const entry = rows.get(params.key);
        assert.ok(entry);
        assert.match(params.message, /KOVA_MAINTENANCE_OK/);
        assert.equal(typeof params.idempotencyKey, "string");
        assert.equal(policy.mode, "enforce");
        entry.updatedAt = Date.now();
        const runId = randomUUID();
        runs.set(runId, { key: params.key });
        return { runId, status: "started" };
      }
      if (method === "agent.wait") {
        assert.ok(runs.has(params.runId));
        if (turnCompletion === "wrong-run") return { runId: randomUUID(), status: "ok" };
        if (turnCompletion === "error") return { runId: params.runId, status: "error" };
        assert.equal(policy.mode, "enforce");
        if (policy.pruneAfter === "30d") {
          assert.equal(policy.archiveDashboardAfter, "7d");
          for (const [key, entry] of rows) {
            if (entry.pinnedAt) {
              if (losePin) entry.archivedAt = Date.now();
              continue;
            }
            if (entry.updatedAt < Date.now() - 30 * DAY) Object.assign(entry, { archivedAt: Date.now(), archiveReason: wrongReason ? "active-session-cap" : "age-retention" });
            else if (key.includes(":dashboard:") && activity(entry) < Date.now() - 7 * DAY) Object.assign(entry, { archivedAt: Date.now(), archiveReason: "stale-dashboard" });
          }
        } else {
          assert.equal(policy.archiveDashboardAfter, false);
          assert.equal(policy.pruneAfter, "1000000d");
          const live = [...rows].filter(([, entry]) => active(entry));
          assert.ok(live.length >= policy.maxEntries + Math.max(25, Math.ceil(policy.maxEntries * 0.1)));
          for (const [key, entry] of live.toReversed().filter(([, entry]) => !entry.pinnedAt).sort((a, b) => activity(a[1]) - activity(b[1])).slice(0, live.length - policy.maxEntries)) {
            assert.match(key, /kova-maintenance-.*-cap-\d+$/);
            Object.assign(entry, { archivedAt: Date.now(), archiveReason: "active-session-cap" });
          }
        }
        return { runId: params.runId, status: "ok" };
      }
      const value = rows.get(params.key);
      assert.equal(value.sessionId, params.expectedSessionId);
      if (method === "sessions.delete") {
        assert.equal(params.deleteTranscript, true);
        assert.equal(policy.mode, "enforce");
        assert.equal(params.key.endsWith("-victim"), true);
        assert.ok(pressure);
        await readFile(pressure);
        rows.delete(params.key); deleted = true;
        if (!cancelDisk) await rm(pressure);
        return { ok: true, deleted: true, archived: [] };
      }
      assert.equal(method, "sessions.patch");
      // The native patch engine skips maintenance. Metadata changes must never
      // satisfy the ordinary-turn observation, even when enforcement is enabled.
      if (params.pinned) { value.pinnedAt = Date.now(); return { ok: true }; }
      value.label = params.label;
      return { ok: true };
    },
    async pressureArchive(_target, source) {
      assert.equal(paused, true);
      assert.ok(!source.key.endsWith("-victim"));
      await mkdir(target.sessions, { recursive: true });
      pressure = join(target.sessions, `${source.sessionId}.jsonl.reset.2000-01-01T00-00-00.000Z`);
      const file = await open(pressure, "wx");
      try { await file.truncate(8 * 1024 * 1024); } finally { await file.close(); }
      return pressure;
    },
    async diskBytes() {
      let pressureBytes = 0;
      if (pressure) {
        try { pressureBytes = (await readFile(pressure)).length; } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return { bytes: 100000 + pressureBytes, oldest: Date.now() - 90 * DAY };
    }
  };
  return { root, target, options, original, rows, runs, unrelatedKey, unrelated, context, dependencies, calls, result: () => result, paused: () => paused };
}

test("maintenance forms require a disposable clone, agent and original Gateway handle", () => {
  const common = ["--env", "kova-run-copy", "--agent", "main", "--gateway-handle", "gateway.json"];
  assert.equal(parseScriptArgs(definition, common).timeoutMs, 1200000);
  assert.equal(parseScriptArgs(definition, [...common, "--disk-budget", "--out", "result.json"])["disk-budget"], true);
  for (const argv of [[], ["--env", "durable", ...common.slice(2)], ["--env", "kova-run-copy", "--agent", "../main", "--gateway-handle", "x"], common.slice(0, 4), [...common, "--cleanup"]]) assert.throws(() => parseScriptArgs(definition, argv));
  assert.deepEqual(maintenanceCapSize(5500), { maxEntries: 5500, fillers: 551 });
  assert.throws(() => maintenanceCapSize(19999), /bound/);
});

test("ordinary writes prove distinct archive reasons and preserve existing active sessions", async (t) => {
  const f = await setup(t);
  const output = await runMaintenancePass(f.options, f.context, f.dependencies);
  assert.equal(output.observations.trigger, "sessions.send");
  assert.equal(f.runs.size, 2);
  assert.notEqual(output.observations.turns.ageDashboard.runId, output.observations.turns.cap.runId);
  for (const turn of Object.values(output.observations.turns)) {
    assert.equal(f.runs.get(turn.runId)?.key, turn.sessionKey);
    assert.ok(output.createdIds.includes(turn.runId));
    assert.equal(turn.status, "ok");
  }
  assert.equal(output.observations.ageReason, "age-retention");
  assert.equal(output.observations.dashboardReason, "stale-dashboard");
  assert.equal(output.observations.capReason, "active-session-cap");
  assert.equal(output.observations.activeAfter, output.observations.maxEntries);
  assert.ok(output.observations.activeBefore > output.observations.activeAfter);
  assert.equal(output.observations.pinnedPreserved, true);
  assert.equal(output.fixturesRemoved, true);
  assert.equal(output.policyRestored, true);
  assert.equal(output.gatewayReady, true);
  assert.deepEqual(await readFile(f.target.configPath), f.original);
  assert.deepEqual([...f.rows], [[f.unrelatedKey, f.unrelated]]);
  assert.equal(f.calls.filter((call) => call === "sessions.delete").length, 0);
  assert.equal(f.calls.filter((call) => call === "sessions.patch").length, 1, "only the pinned control uses the maintenance-skipping patch path");
  assert.equal(f.calls.filter((call) => call === "agent.wait").length, 2);
});

test("an admitted maintenance turn needs its own successful native completion", async (t) => {
  for (const turnCompletion of ["wrong-run", "error"]) {
    const f = await setup(t, { turnCompletion });
    await assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), (error) => {
      assert.match(error.message, /different run identity|did not complete successfully/);
      assert.equal(error.exitCode, 1);
      return true;
    });
    assert.equal(f.runs.size, 1);
    assert.equal(f.result().observations, null);
    assert.ok(f.result().createdIds.includes([...f.runs.keys()][0]));
    assert.equal(f.result().policyRestored, true);
    assert.equal(f.result().fixturesRemoved, true);
    assert.deepEqual(await readFile(f.target.configPath), f.original);
  }
});

test("wrong archive reason or a lost pinned control fails while restoring exact policy", async (t) => {
  for (const options of [{ wrongReason: true }, { losePin: true }]) {
    const f = await setup(t, options);
    await assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), (error) => {
      assert.match(error.message, /different reason|pinned control/);
      assert.equal(error.exitCode, 1);
      return true;
    });
    assert.deepEqual(await readFile(f.target.configPath), f.original);
    assert.equal(f.result().policyRestored, true);
    assert.equal(f.result().fixturesRemoved, true);
    assert.equal(f.result().gatewayReady, true);
    assert.equal(f.result().observations, null);
  }
});

test("disk deletion must reclaim a distinct fresh archive before manual cleanup", async (t) => {
  const f = await setup(t, { disk: true });
  const output = await runMaintenancePass(f.options, f.context, f.dependencies);
  const observation = output.observations;
  assert.equal(observation.trigger, "sessions.delete");
  assert.notEqual(observation.victimSessionId, observation.pressureSessionId);
  assert.equal(observation.nonVictimReclaimed, true);
  assert.ok(observation.bytesBefore > observation.maxDiskBytes);
  assert.ok(observation.bytesAfter < observation.bytesBefore);
  assert.equal(output.policyRestored, true);
  assert.equal(output.fixturesRemoved, true);
  assert.deepEqual(await readFile(f.target.configPath), f.original);
  assert.deepEqual([...f.rows], [[f.unrelatedKey, f.unrelated]]);
});

test("cancellation without non-victim reclamation cannot become success through cleanup", async (t) => {
  const f = await setup(t, { disk: true, cancelDisk: true });
  await assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), /abort|cancelled/i);
  assert.equal(f.result().observations, null);
  assert.equal(f.result().policyRestored, true);
  assert.equal(f.result().fixturesRemoved, true);
  assert.equal(f.result().gatewayReady, true);
  assert.deepEqual(await readFile(f.target.configPath), f.original);
});

test("cancelled resume requires a fresh acknowledged pause before restoration writes", async (t) => {
  for (const acknowledge of [true, false]) {
    const f = await setup(t, { disk: true });
    const cancelled = new AbortController();
    f.context.signal = cancelled.signal;
    const lifecycle = f.dependencies.lifecycle;
    let resumes = 0, interruptedConfig, fixtureCalls = 0, releasePause, requestPause;
    const pauseRequested = new Promise((accept) => { requestPause = accept; });
    const pauseReleased = new Promise((accept) => { releasePause = accept; });
    f.dependencies.lifecycle = async (argv, control) => {
      if (argv[0] === "resume" && ++resumes === 2) {
        // The owner really resumed, but cancellation hid its successful reply.
        await lifecycle(argv, control);
        interruptedConfig = await readFile(f.target.configPath);
        cancelled.abort(new Error("cancelled after Gateway resumed"));
        return { exitCode: 3, output: { error: cancelled.signal.reason.message, result: null } };
      }
      if (argv[0] === "pause" && cancelled.signal.aborted) {
        assert.notEqual(control.signal, cancelled.signal);
        assert.equal(control.signal.aborted, false);
        requestPause();
        await pauseReleased;
        assert.deepEqual(await readFile(f.target.configPath), interruptedConfig);
        if (!acknowledge) return { exitCode: 1, output: { error: "pause unavailable", result: null } };
      }
      return lifecycle(argv, control);
    };
    f.dependencies.fixtures = async (_target, items, control) => {
      assert.equal(f.paused(), true);
      assert.equal(control.signal.aborted, false);
      fixtureCalls++;
      for (const item of items) {
        assert.equal(item.remove, true);
        assert.equal(f.rows.get(item.key)?.sessionId, item.sessionId);
        f.rows.delete(item.key);
      }
    };
    const finished = assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), (error) => {
      assert.match(error.message, /cancelled after Gateway resumed/);
      assert.equal(error.exitCode, 3);
      if (!acknowledge) assert.match(error.cleanupError, /pause was not confirmed/);
      return true;
    });
    t.after(async () => { releasePause(); await finished.catch(() => {}); });
    await Promise.race([pauseRequested, finished.then(() => assert.fail("restoration did not request a new pause"))]);
    assert.equal(f.paused(), false);
    assert.equal(fixtureCalls, 0);
    assert.deepEqual(await readFile(f.target.configPath), interruptedConfig);
    releasePause();
    await finished;
    assert.equal(fixtureCalls, acknowledge ? 1 : 0);
    assert.equal(f.result().policyRestored, acknowledge);
    assert.equal(f.result().fixturesRemoved, acknowledge);
    assert.equal(f.result().gatewayReady, acknowledge);
    assert.deepEqual(await readFile(f.target.configPath), acknowledge ? f.original : interruptedConfig);
  }
});

test("an unconfirmed restored Gateway is a failure even after successful maintenance", async (t) => {
  const f = await setup(t, { disk: true, failRestoreResume: true });
  await assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), (error) => {
    assert.match(error.cleanupError, /resume/);
    assert.equal(error.exitCode, 1);
    return true;
  });
  assert.equal(f.result().policyRestored, true);
  assert.equal(f.result().gatewayReady, false);
  assert.deepEqual(await readFile(f.target.configPath), f.original);
});

test("metadata reads distinguish native retained nodes from malformed live entries", async (t) => {
  const f = await setup(t);
  await mkdir(join(f.target.state, "agents/research/agent"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.target.db);
  db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, entry_valid INTEGER, updated_at INTEGER); CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT)");
  db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, 1, ?)").run(f.unrelatedKey, f.unrelated.sessionId, JSON.stringify(f.unrelated), f.unrelated.updatedAt);
  const retiredKey = "agent:research:retained", retiredId = randomUUID();
  db.prepare("INSERT INTO session_nodes VALUES (?, ?, '{}', -1, 1)").run(retiredKey, retiredId);
  db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(retiredId, retiredKey);
  db.close();
  assert.deepEqual(await readMaintenanceRows(f.target), f.rows);
  const wrong = new DatabaseSync(f.target.db);
  wrong.prepare("DELETE FROM session_windows WHERE session_id = ?").run(retiredId);
  await assert.rejects(readMaintenanceRows(f.target), /identity/, "an orphan empty entry is not a retained node");
  wrong.prepare("INSERT INTO session_windows VALUES (?, ?)").run(retiredId, retiredKey);
  wrong.prepare("UPDATE session_windows SET session_key = ?").run("agent:research:different");
  await assert.rejects(readMaintenanceRows(f.target), /identity/, "a window belonging to another key cannot certify a retained node");
  wrong.prepare("UPDATE session_windows SET session_key = ?").run(retiredKey);
  wrong.prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?").run(retiredKey);
  await assert.rejects(readMaintenanceRows(f.target), /identity/, "an unvalidated empty entry is not a native tombstone");
  wrong.prepare("UPDATE session_nodes SET entry_valid = -1, entry_json = 'null' WHERE session_key = ?").run(retiredKey);
  await assert.rejects(readMaintenanceRows(f.target), /identity/, "only the native empty-object marker is eligible");
  wrong.prepare("UPDATE session_nodes SET entry_json = '{}' WHERE session_key = ?").run(retiredKey);
  wrong.prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?").run("different", f.unrelatedKey); wrong.close();
  await assert.rejects(readMaintenanceRows(f.target), /identity/);
  const alias = `${f.target.db}.alias`;
  await symlink(f.target.db, alias);
  await assert.rejects(readMaintenanceRows({ ...f.target, db: alias }), /unaliased/);
});

test("retained nodes still count toward the metadata observation bound", async (t) => {
  const f = await setup(t);
  await mkdir(join(f.target.state, "agents/research/agent"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.target.db);
  db.exec(`CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, entry_valid INTEGER, updated_at INTEGER);
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT);
    WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 20001)
      INSERT INTO session_nodes SELECT 'agent:research:retained-' || n, 'session-' || n, '{}', -1, 1 FROM ids;
    INSERT INTO session_windows SELECT current_session_id, session_key FROM session_nodes;`);
  db.close();
  await assert.rejects(readMaintenanceRows(f.target), /observation bound/);
});

test("maintenance Gateway requests match the pinned schemas", (t) => schemas.report(t));

test("maintenance CLI SIGTERM confirms restoration pause and returns shared exit code 3", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-maintenance-signal-"));
  const configPath = join(root, ".openclaw/openclaw.json"), bin = join(root, "bin");
  const handlePath = join(root, "gateway.json"), directory = `${handlePath}.d`, envName = "kova-scripts-maintenance-signal";
  const original = Buffer.from('{ // untouched before the first pause\n "note":"retained"\n}\n');
  await mkdir(join(root, ".openclaw/agents/main/agent"), { recursive: true });
  await mkdir(bin);
  await writeFile(configPath, original);
  await writeFile(join(root, ".openclaw/agents/main/agent/openclaw-agent.sqlite"), "not opened before pause acknowledgement");
  const ocm = join(bin, "ocm");
  await writeFile(ocm, `#!/usr/bin/env node
console.log(JSON.stringify({ root: process.env.KOVA_MAINTENANCE_TEST_ROOT, configPath: process.env.KOVA_MAINTENANCE_TEST_CONFIG, gatewayPort: 31299, binaryPath: process.execPath }));
`);
  await chmod(ocm, 0o755);
  const id = randomUUID();
  await atomicJson(join(directory, "operation.json"), { schema: "kova.gateway.operation.v1", id, entry: "foreground-gateway-start", method: "gateway.start", env: envName, handlePath, directory, expiresAt: new Date(Date.now() + 240000).toISOString() });
  await atomicJson(handlePath, { entry: "foreground-gateway-start", env: envName, ref: { id, directory, root, configPath, port: 31299 } });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, KOVA_MAINTENANCE_TEST_ROOT: root, KOVA_MAINTENANCE_TEST_CONFIG: configPath };
  delete env.KOVA_OCM_TRANSPORT_JSON;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../support/verify/session-maintenance-pass.mjs", import.meta.url)), "--env", envName, "--agent", "main", "--gateway-handle", handlePath, "--timeout", "240000"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed.catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const waitJson = async (path, predicate = () => true) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { const value = JSON.parse(await readFile(path, "utf8")); if (predicate(value)) return value; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < deadline, stderr || stdout || "maintenance mailbox request was not observed");
      await sleep(10);
    }
  };
  const requestPath = join(directory, "fixture-request.json");
  const answer = async (request, action) => {
    assert.equal(request.options.operation, action);
    await rm(requestPath);
    await atomicJson(join(directory, `fixture-result-${request.id}.json`), { output: { method: `gateway.${action}`, result: { paused: action === "pause", ready: action === "resume", refused: false }, error: null, elapsedMs: 0 }, exitCode: 0 });
  };
  const first = await waitJson(requestPath);
  assert.equal(child.kill("SIGTERM"), true);
  await waitJson(join(directory, `fixture-cancel-${first.id}.json`));
  await answer(first, "pause");
  const restoration = await waitJson(requestPath, (request) => request.id !== first.id);
  assert.deepEqual(await readFile(configPath), original);
  await answer(restoration, "pause");
  const resumed = await waitJson(requestPath, (request) => request.id !== restoration.id);
  await answer(resumed, "resume");
  assert.deepEqual(await closed, { code: 3, signal: null });
  const output = JSON.parse(stdout);
  assert.equal(output.error, "interrupted by SIGTERM");
  assert.equal(output.gatewayReady, true);
  assert.deepEqual(output.createdIds, []);
  assert.deepEqual(await readFile(configPath), original);
});
