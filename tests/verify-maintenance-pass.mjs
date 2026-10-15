import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { definition, maintenanceCapSize, readMaintenanceRows, runMaintenancePass } from "../support/verify/session-maintenance-pass.mjs";
import { parseScriptArgs } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const DAY = 86400000;
const active = (entry) => entry.archivedAt === undefined;
const activity = (entry) => Math.max(...["updatedAt", "lastInteractionAt", "lastActivityAt", "sessionStartedAt"].map((field) => entry[field] ?? 0));

async function setup(t, { disk = false, wrongReason = false, losePin = false, cancelDisk = false, failRestoreResume = false } = {}) {
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
  const rows = new Map([[unrelatedKey, unrelated]]), controller = new AbortController();
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
          if (!wrongReason && !losePin && !cancelDisk) assert.ok(result.observations, "cleanup follows the completed product observation");
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
      assert.equal(params.agentId, "research");
      calls.push(method);
      const policy = JSON.parse(await readFile(configPath, "utf8")).session.maintenance;
      if (method === "sessions.create") {
        assert.equal(policy.mode, "warn");
        assert.equal(rows.has(params.key), false);
        const entry = { sessionId: randomUUID(), label: params.label, updatedAt: Date.now() };
        rows.set(params.key, entry);
        return { key: params.key, sessionId: entry.sessionId };
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
      if (params.pinned) { value.pinnedAt = Date.now(); return { ok: true }; }
      value.label = params.label;
      assert.equal(policy.mode, "enforce");
      if (params.label.endsWith("-age-trigger")) {
        assert.equal(policy.pruneAfter, "30d");
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
        assert.equal(params.label.endsWith("-cap-trigger"), true);
        assert.equal(policy.archiveDashboardAfter, false);
        assert.equal(policy.pruneAfter, "1000000d");
        const live = [...rows].filter(([, entry]) => active(entry));
        assert.ok(live.length >= policy.maxEntries + Math.max(25, Math.ceil(policy.maxEntries * 0.1)));
        for (const [key, entry] of live.toReversed().filter(([, entry]) => !entry.pinnedAt).sort((a, b) => activity(a[1]) - activity(b[1])).slice(0, live.length - policy.maxEntries)) {
          assert.match(key, /kova-maintenance-.*-cap-\d+$/);
          Object.assign(entry, { archivedAt: Date.now(), archiveReason: "active-session-cap" });
        }
      }
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
  return { root, target, options, original, rows, unrelatedKey, unrelated, context, dependencies, calls, result: () => result, paused: () => paused };
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
  assert.equal(output.observations.trigger, "sessions.patch");
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
});

test("wrong archive reason or a lost pinned control fails while restoring exact policy", async (t) => {
  for (const options of [{ wrongReason: true }, { losePin: true }]) {
    const f = await setup(t, options);
    await assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), /different reason|pinned control/);
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

test("an unconfirmed restored Gateway is a failure even after successful maintenance", async (t) => {
  const f = await setup(t, { disk: true, failRestoreResume: true });
  await assert.rejects(runMaintenancePass(f.options, f.context, f.dependencies), (error) => /resume/.test(error.cleanupError));
  assert.equal(f.result().policyRestored, true);
  assert.equal(f.result().gatewayReady, false);
  assert.deepEqual(await readFile(f.target.configPath), f.original);
});

test("bounded metadata reads reject aliased files and mismatched session identities", async (t) => {
  const f = await setup(t);
  await mkdir(join(f.target.state, "agents/research/agent"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.target.db);
  db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT)");
  db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(f.unrelatedKey, f.unrelated.sessionId, JSON.stringify(f.unrelated));
  db.close();
  assert.deepEqual(await readMaintenanceRows(f.target), f.rows);
  const wrong = new DatabaseSync(f.target.db);
  wrong.prepare("UPDATE session_nodes SET current_session_id = ?").run("different"); wrong.close();
  await assert.rejects(readMaintenanceRows(f.target), /identity/);
  const alias = `${f.target.db}.alias`;
  await symlink(f.target.db, alias);
  await assert.rejects(readMaintenanceRows({ ...f.target, db: alias }), /unaliased/);
});

test("maintenance Gateway requests match the pinned schemas", (t) => schemas.report(t));
