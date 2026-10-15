import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkArchiveContent, archiveKeys, patchArchiveSession } from "../support/persona/inflate-archives.mjs";
import { checkPersonaTraits, needsStoppedPersonaGateway } from "../src/persona/lifecycle.mjs";
import { loadCatalogue } from "../src/catalogue.mjs";

async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), "kova-store-traits-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  for (const path of ["agents/main/agent", "agents/main/sessions", "kova-persona"]) await mkdir(join(state, path), { recursive: true });
  await writeFile(join(state, "openclaw.json"), '{ // saved hand edit\n "session":{"maintenance":{"mode":"warn","preserveRecent":false,"maxDiskBytes":"1mb"}}}');
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(state, "agents/main/agent/openclaw-agent.sqlite"));
  db.exec("CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT); CREATE TABLE session_windows(session_id TEXT, session_key TEXT); CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT)");
  const insert = (key, id, entry) => db.prepare("INSERT INTO session_nodes VALUES (?,?,?)").run(key, id, JSON.stringify({ sessionId: id, updatedAt: Date.now() - 100 * 86400000, ...entry }));
  for (const kind of ["reset", "history", "cap", "victim"]) insert(archiveKeys[kind], `id-${kind}`, { label: `kova-persona-budget-${kind}`, ...(kind === "cap" ? { archivedAt: 1, archiveReason: "active-session-cap" } : {}) });
  db.prepare("INSERT INTO session_windows VALUES (?,?)").run("old-history", archiveKeys.history);
  db.prepare("INSERT INTO session_windows VALUES (?,?)").run("id-history", archiveKeys.history);
  db.prepare("INSERT INTO transcript_events VALUES (?,?,?)").run("old-history", 0, '{"type":"message"}');
  db.close();
  await writeFile(join(state, "kova-persona/deleted-archive.json"), JSON.stringify({ sessionId: "id-deleted" }));
  await writeFile(join(state, "kova-persona/unreferenced-history.json"), JSON.stringify({ key: archiveKeys.history, previousId: "old-history", sessionId: "id-history" }));
  const stamp = "2000-01-01T00-00-00.000Z";
  const reset = join(state, `agents/main/sessions/id-reset.jsonl.reset.${stamp}`);
  const archive = (id, content) => [{ type: "session", id }, { type: "message", message: { role: "user", content } }, { type: "message", message: { role: "assistant", content: "Saved reply" } }].map(JSON.stringify).join("\n") + "\n";
  await writeFile(reset, archive("id-reset", "x".repeat(1024 * 1024)));
  await writeFile(join(state, `agents/main/sessions/id-deleted.jsonl.deleted.${stamp}`), archive("id-deleted", "saved deleted archive"));
  return { state, reset, DatabaseSync };
}

test("disk fixture requires durable over-budget files and genuinely unreferenced history", async (t) => {
  const { state, reset, DatabaseSync } = await fixture(t);
  assert.deepEqual(await checkArchiveContent({ state }), { victimKey: archiveKeys.victim, victimSessionId: "id-victim" });
  const db = new DatabaseSync(join(state, "agents/main/agent/openclaw-agent.sqlite"));
  db.prepare("UPDATE session_nodes SET entry_json = json_set(entry_json, '$.previousSessionId', ?) WHERE session_key = ?").run("old-history", archiveKeys.history);
  await assert.rejects(checkArchiveContent({ state }), /remains referenced/);
  db.prepare("UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.previousSessionId') WHERE session_key = ?").run(archiveKeys.history);
  db.close();
  await writeFile(reset, [{ type: "session", id: "id-reset" }, { type: "message", message: { role: "user" } }, { type: "message", message: { role: "assistant" } }].map(JSON.stringify).join("\n"));
  assert.ok((await lstat(reset)).size < 1024 * 1024);
  await assert.rejects(checkArchiveContent({ state }), /do not exceed/);
});

test("historical database writes pause the existing foreground owner and damage checks retain Doctor output", async () => {
  const actions = [], context = { env: "kova-store-test", run: "/tmp/store-check", kovaRoot: "/repo", traits: {} };
  const command = "node {kovaRoot}/support/persona/cold-storage.mjs age --env {env} --key agent:main:kova-persona-cold";
  assert.equal(needsStoppedPersonaGateway(command), true);
  assert.equal(needsStoppedPersonaGateway("ocm @{env} -- config set session.maintenance.coldStorage.enabled true"), true);
  assert.equal(needsStoppedPersonaGateway(command.replace(" age ", " check ")), false);
  const loaded = { traits: [{ id: "store-corrupt-generation", needs: [], keys: {}, builder: [command], check: "check-trait" }] };
  const gateway = { async assertOwned() {}, async identityMode() {}, async stop() { actions.push("stop"); }, async start() { actions.push("start"); } };
  const call = async (cmd, label) => {
    actions.push(label ?? cmd);
    if (cmd.includes("env show")) return { stdout: JSON.stringify({ root: "/tmp/no-saved-mock", stateDir: "/tmp/no-saved-mock" }) };
    if (cmd.startsWith("cat ")) return { stdout: "12345" };
    return { stdout: label?.startsWith("Doctor") ? "Doctor passed" : "{}" };
  };
  await checkPersonaTraits(loaded, context, call, { build: true, gateway });
  const buildIndex = actions.indexOf("trait store-corrupt-generation builder");
  assert.equal(actions[buildIndex - 1], "stop");
  assert.ok(actions.indexOf("start", buildIndex) < actions.indexOf("trait store-corrupt-generation check"));
  assert.equal(context.doctorChecks[0], "After store-corrupt-generation:\nDoctor passed");
  assert.ok(actions.indexOf("Doctor after store-corrupt-generation") < actions.indexOf("trait store-corrupt-generation check after Doctor"));
});

test("historical rotation declares every generated output identity", async (t) => {
  const { state } = await fixture(t);
  await rm(join(state, "kova-persona/unreferenced-history.json"));
  const result = await patchArchiveSession({ env: {}, state, kind: "history", writeFixture: async () => async (request) => {
    assert.equal(request.sessionId, "id-history");
    assert.match(request.nextSessionId, /^[a-f0-9-]{36}$/);
    assert.equal(request.fields.usageFamilySessionIds, undefined);
    assert.equal(request.fields.compactionCheckpoints, undefined);
  } });
  const { catalogue } = await loadCatalogue("openclaw");
  assert.deepEqual(catalogue.entries.find((entry) => entry.id === "persona-archives-history").creates.toSorted(), Object.keys(result).map((key) => `/${key}`).toSorted());
});
