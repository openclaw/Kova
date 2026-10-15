import { loadCatalogue } from "../src/catalogue.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertCorruptGeneration, checkCorruptGeneration, checkQuarantinedGeneration,
  corruptFixtureSha256, recoverCorruptGeneration, stageCorruptGeneration,
} from "../support/persona/quarantine-generation.mjs";
import { checkStaleLockFiles, writeStaleLockFiles } from "../support/persona/write-stale-locks.mjs";

async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), "kova-store-fixtures-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const agent = join(state, "agents", "main", "agent");
  await mkdir(agent, { recursive: true });
  const live = join(agent, "openclaw-agent.sqlite");
  await writeFile(live, "live database sentinel");
  return { state, agent, live, directory: join(agent, "fixtures") };
}

test("corrupt generation has a damaged SQLite header, proves corruption and never overwrites live or staged files", async (t) => {
  const value = await fixture(t);
  const staged = await stageCorruptGeneration(value.state);
  assert.equal(staged.path, join(value.directory, "corrupt-generation.sqlite"));
  const { catalogue } = await loadCatalogue("openclaw");
  assert.deepEqual(catalogue.entries.find((entry) => entry.id === "persona-generation-stage-corrupt").creates.toSorted(), Object.keys(staged).map((key) => `/${key}`).toSorted());
  assert.deepEqual(await checkCorruptGeneration(value.state), staged);
  const bytes = await readFile(staged.path);
  assert.equal(bytes.subarray(0, 16).toString("binary"), "\0QLite format 3\0");
  assert.equal(bytes[4096], 0x0d);
  assert.equal(bytes.length, 8192);
  await assert.rejects(stageCorruptGeneration(value.state), /EEXIST/);
  assert.equal(await readFile(value.live, "utf8"), "live database sentinel");
  const altered = Buffer.from(bytes);
  altered[0] = 0x53;
  await writeFile(staged.path, altered);
  await assert.rejects(checkCorruptGeneration(value.state), /differs from the documented/);
});

test("fixture staging rejects symlink ancestors and sidecars without following them", async (t) => {
  const value = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "kova-store-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, value.directory);
  await assert.rejects(stageCorruptGeneration(value.state), /symbolic links/);
  await assert.rejects(readFile(join(outside, "corrupt-generation.sqlite")), { code: "ENOENT" });
  await rm(value.directory);
  await mkdir(value.directory);
  const staged = join(value.directory, "corrupt-generation.sqlite");
  await symlink(join(outside, "wal"), `${staged}-wal`);
  await assert.rejects(stageCorruptGeneration(value.state), /already exists/);
  await assert.rejects(readFile(staged), { code: "ENOENT" });
  await assert.rejects(stageCorruptGeneration("relative-state"), /absolute persona state/);
});

test("fixture checks refuse file aliases", async (t) => {
  const value = await fixture(t);
  const staged = await stageCorruptGeneration(value.state);
  const alias = join(value.directory, "alias.sqlite");
  await link(staged.path, alias);
  await assert.rejects(checkCorruptGeneration(value.state), /without hard links/);
  await rm(alias);
  await rename(staged.path, alias);
  await symlink(alias, staged.path);
  await assert.rejects(checkCorruptGeneration(value.state));
});

function reportFor(source, preserved) {
  return { mode: "recover", totals: { targets: 1, issues: 0 }, targets: [{
    agentId: "main", storePath: source, sqlitePath: source, issues: [],
    corruptRecovery: { movedFiles: [preserved], skippedFiles: [] },
  }] };
}

test("Doctor recovery selects only its separate copy and checks survive an exported path", async (t) => {
  const value = await fixture(t);
  const staged = await stageCorruptGeneration(value.state);
  const recovery = await stageCorruptGeneration(value.state, { recovery: true });
  const { catalogue } = await loadCatalogue("openclaw");
  assert.deepEqual(catalogue.entries.find((entry) => entry.id === "persona-generation-stage-recovery").creates.toSorted(), Object.keys(recovery).map((key) => `/${key}`).toSorted());
  assert.notEqual(recovery.path, staged.path);
  const preserved = `${recovery.path}.corrupt-1792020000000`;
  let calls = 0;
  assert.deepEqual(await recoverCorruptGeneration({ state: value.state, envName: "fixture", run: async (env, args) => {
    calls++;
    assert.equal(env, "fixture");
    assert.deepEqual(args, ["doctor", "--session-sqlite", "recover", "--session-sqlite-store", recovery.path, "--session-sqlite-agent", "main", "--json"]);
    await rename(recovery.path, preserved);
    return reportFor(recovery.path, preserved);
  } }), {});
  assert.equal(calls, 1);
  assert.deepEqual(await checkQuarantinedGeneration(value.state), {});
  assert.deepEqual(await checkCorruptGeneration(value.state), staged);
  assert.equal(await readFile(value.live, "utf8"), "live database sentinel");
  const receipt = JSON.parse(await readFile(join(value.directory, "recovery-generation.json"), "utf8"));
  assert.equal(receipt.sha256, corruptFixtureSha256);
  assert.equal(receipt.preserved, "recovery-generation.sqlite.corrupt-1792020000000");
  const clone = await fixture(t);
  await cp(value.directory, clone.directory, { recursive: true });
  assert.deepEqual(await checkQuarantinedGeneration(clone.state), {});
  await writeFile(join(clone.directory, receipt.preserved), "not the retained generation");
  await assert.rejects(checkQuarantinedGeneration(clone.state), /differs from the documented/);
});

test("recovery refuses unrelated Doctor metadata and does not fabricate a receipt", async (t) => {
  const value = await fixture(t);
  await stageCorruptGeneration(value.state);
  const recovery = await stageCorruptGeneration(value.state, { recovery: true });
  const outside = join(value.agent, "outside.sqlite.corrupt-1792020000000");
  await assert.rejects(recoverCorruptGeneration({ state: value.state, envName: "fixture", run: async () => reportFor(recovery.path, outside) }), /outside the selected/);
  await assert.rejects(readFile(join(value.directory, "recovery-generation.json")), { code: "ENOENT" });
  await assertCorruptGeneration(recovery.path);
  await assert.rejects(recoverCorruptGeneration({ state: value.state, envName: "fixture", run: async () => ({ ...reportFor(recovery.path, `${recovery.path}.corrupt-1792020000000`), totals: { issues: 1 } }) }), /did not report recovery/);
});

test("quarantine receipts cannot point outside their fixed fixture directory", async (t) => {
  const value = await fixture(t);
  await stageCorruptGeneration(value.state);
  await writeFile(join(value.directory, "recovery-generation.json"), JSON.stringify({
    version: 1, source: "recovery-generation.sqlite", preserved: "../openclaw-agent.sqlite", sha256: corruptFixtureSha256,
  }));
  await assert.rejects(checkQuarantinedGeneration(value.state), /invalid recovered generation receipt/);
  assert.equal(await readFile(value.live, "utf8"), "live database sentinel");
});

test("legacy lock fixtures contain expired residue and reject changed ownership", async (t) => {
  const value = await fixture(t);
  assert.deepEqual(await writeStaleLockFiles(value.state), {});
  assert.deepEqual(await checkStaleLockFiles(value.state), {});
  await assert.rejects(writeStaleLockFiles(value.state), /already exists/);
  const lock = join(dirname(value.agent), "sessions", "kova-stale-one.jsonl.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" }));
  await assert.rejects(checkStaleLockFiles(value.state), /residue is absent or changed/);
});

test("store fixture commands reject malformed calls before resolving an environment", () => {
  for (const name of ["quarantine-generation", "write-stale-locks"]) {
    for (const args of [[], ["unknown", "--env", "unused"], ["check", "--env", "unused", "--path", "/outside"]]) {
      const result = spawnSync(process.execPath, [new URL(`../support/persona/${name}.mjs`, import.meta.url).pathname, ...args], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, "usage");
    }
  }
});
