import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCatalog, checkCron, catalogThread, catalogWord } from "../support/persona/environment-content.mjs";
import { checkCompanion, cleanupCompanion } from "../support/persona/companion-environment.mjs";

test("catalog checks require complete content, not merely a discovered filename", async () => {
  const listing = { catalogs: [{ id: "claude", hosts: [{ hostId: "gateway:local", sessions: [{ threadId: catalogThread }] }] }] };
  const content = { threadId: catalogThread, items: [{ text: catalogWord }, { text: "Saved reply." }] };
  const rpc = async ({ method, params }) => {
    if (method.endsWith("list")) return listing;
    assert.ok(params.limit >= 1 && params.limit <= 50, "the Anthropic catalog provider accepts pages of at most 50 items");
    return content;
  };
  assert.equal((await checkCatalog(rpc)).threadId, catalogThread);
  content.nextCursor = "another-page";
  await assert.rejects(checkCatalog(rpc), /incomplete/);
  delete content.nextCursor;
  content.items[0].truncated = true;
  await assert.rejects(checkCatalog(rpc), /incomplete/);
  delete content.items[0].truncated;
  listing.catalogs[0].hosts[0].error = { message: "unavailable" };
  await assert.rejects(checkCatalog(rpc), /absent/);
});

test("cron check rejects disabled, duplicate or externally delivered content", async () => {
  const job = { id: "saved-job", name: "kova-persona-isolated", enabled: true, sessionTarget: "isolated", payload: { kind: "agentTurn" }, delivery: { mode: "announce", channel: "kova-channel-probe" } };
  const rpc = async () => ({ jobs: [job] });
  assert.deepEqual(await checkCron(rpc), { jobId: "saved-job" });
  job.enabled = false;
  await assert.rejects(checkCron(rpc), /differs/);
  job.enabled = true; job.delivery.channel = "external";
  await assert.rejects(checkCron(rpc), /differs/);
  await assert.rejects(checkCron(async () => ({ jobs: [job, job] })), /duplicated/);
});

test("a copied companion record cannot delete the source environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "persona-companion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "kova-persona"));
  await writeFile(join(root, "kova-persona", "companion-environment.json"), JSON.stringify({ source: "source-persona", env: "source-persona-second" }));
  const calls = [];
  const call = async (command) => { calls.push(command); return { stdout: JSON.stringify({ name: command.split("'")[1], stateDir: root }) }; };
  await cleanupCompanion("verification-copy", call);
  assert.deepEqual(calls, ["ocm env show 'verification-copy' --json"]);
  calls.length = 0;
  await cleanupCompanion("source-persona", call);
  assert.ok(calls.some((command) => command === "ocm env destroy 'source-persona-second' --yes --json"));
  assert.ok(!calls.some((command) => command.includes("destroy 'source-persona'")));
});

test("companion checks use an explicit imported destination without reading the protected source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "persona-companion-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "kova-persona"));
  await writeFile(join(root, "kova-persona", "companion-environment.json"), JSON.stringify({ source: "source-persona", env: "source-persona-second" }));
  const env = { name: "primary-copy", defaultRuntime: "release-runtime", gatewayPort: 12000 };
  const calls = [];
  const metadata = { name: "companion-copy", defaultRuntime: "release-runtime", gatewayPort: 12001, protected: false };
  const inspect = async (command) => { calls.push(command); return { stdout: JSON.stringify(metadata) }; };
  const context = { env, state: root, args: { "companion-env": "companion-copy" } };
  assert.deepEqual(await checkCompanion(context, inspect), { env: "companion-copy" });
  assert.deepEqual(calls, ["ocm env show 'companion-copy' --json"]);
  metadata.gatewayPort = env.gatewayPort;
  await assert.rejects(checkCompanion(context, inspect), /port differs/);
  metadata.gatewayPort = 12001;
  metadata.name = "source-persona-second";
  await assert.rejects(checkCompanion({ env, state: root }, inspect), /protection/);
  metadata.protected = true;
  assert.deepEqual(await checkCompanion({ env, state: root }, inspect), { env: "source-persona-second" });
  await assert.rejects(checkCompanion({ ...context, args: { "companion-env": env.name } }, inspect), /destination/);
});
