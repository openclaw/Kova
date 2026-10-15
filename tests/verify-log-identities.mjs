import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRows, normalizeText } from "../src/verify/rows.mjs";

const advertised = (counter, extra = {}) => `bonjour: advertised gateway fqdn=${extra.name ?? "lab-host"}${counter ? ` (${counter})` : ""}._openclaw-gw._tcp.local. host=lab-host${counter ? `-(${counter})` : ""}.local. port=22341 state=${extra.state ?? "announcing"}`;

test("Bonjour collision counters normalize with an identity audit and retain product text", () => {
  const audits = [];
  const normalized = (text) => normalizeText(text, value => value, () => {}, (...item) => audits.push(item));
  assert.equal(normalized(advertised(8)), normalized(advertised(9)));
  assert.equal(normalized(advertised(8)), normalized(advertised(0)));
  assert.equal(normalized('bonjour: gateway name conflict resolved; newName="lab-host (8)"'), 'bonjour: gateway name conflict resolved; newName="lab-host"');
  assert.equal(normalized('bonjour: gateway hostname conflict resolved; newHostname="lab-host-(8)"'), 'bonjour: gateway hostname conflict resolved; newHostname="lab-host"');
  assert.ok(audits.length > 0);
  assert.ok(audits.every(([reason, before, after]) => reason === "Bonjour collision counter in run-environment identity" && before !== after));
  assert.notEqual(normalized(advertised(8)), normalized(advertised(9, { name: "wrong-host" })));
  assert.notEqual(normalized(advertised(8)), normalized(advertised(9, { state: "unannounced" })));
  for (const text of [
    'bonjour: advertise failed; newName="lab-host (8)"',
    'product message: bonjour: gateway name conflict resolved; newName="lab-host (8)"',
    'bonjour: gateway name conflict resolved; newName="lab-host (8)" unexpected'
  ]) assert.equal(normalized(text), text);
  assert.equal(normalized(advertised(8).replace("_openclaw-gw", "_different-service")), advertised(8).replace("_openclaw-gw", "_different-service").replace("22341", "<port>"));
});

test("recorded Bonjour lines preserve warning severity, count and source-address identity audits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-log-identities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "commands.json"), "[]");
  const message = 'bonjour: gateway hostname conflict resolved; newHostname="lab-host-(8)"';
  const raw = JSON.stringify({ level: "warn", message });
  await writeFile(join(directory, "logs.txt"), `${raw}\n${raw}\n2026-10-15T16:51:50.603+02:00 [plugins] ${advertised(8)}\n`);
  const audit = [];
  const result = await checkpointRows(directory, { id: "standard/use-target", commands: [], checkpoint: ["logs"] }, {}, { text: value => value }, 0, [], item => audit.push(item));
  const logs = [...result.items.values()].filter(item => item.signal === "logs");
  assert.equal(logs.length, 2);
  const warning = logs.find(item => item.failure);
  assert.equal(warning.value, 2);
  assert.equal(JSON.parse(warning.at).message, 'bonjour: gateway hostname conflict resolved; newHostname="lab-host"');
  assert.match(logs.find(item => !item.failure).at, /^<time> \[plugins\] bonjour:/);
  const identities = audit.filter(item => item.category === "declaredIds");
  assert.equal(identities.length, 3);
  assert.ok(identities.every(item => item.signal === "logs" && item.at.includes("(8)")));
  assert.ok(identities.every(item => item.reason === "Bonjour collision counter in run-environment identity" && item.before !== item.after));
});

test("nested cron storeKey strings reach path normalization without suppressing job payloads", () => {
  const root = "/tmp/envs/clone-a", normalizedRoot = "/tmp/envs/<env:0>";
  const store = JSON.stringify({ module: "cron", storeKey: `${root}/.openclaw/cron/jobs.json` });
  const raw = JSON.stringify({ 0: store, 1: { jobId: "generated-job-a", nextWakeAtMs: 1792075952897 }, _meta: { name: store }, message: "cron: started" });
  const visited = [];
  const result = JSON.parse(normalizeText(raw, value => { visited.push(value); return value.replaceAll(root, normalizedRoot); }));
  assert.equal(JSON.parse(result[0]).storeKey, `${normalizedRoot}/.openclaw/cron/jobs.json`);
  assert.equal(JSON.parse(result._meta.name).storeKey, `${normalizedRoot}/.openclaw/cron/jobs.json`);
  assert.ok(visited.includes(`${root}/.openclaw/cron/jobs.json`));
  assert.deepEqual(result[1], { jobId: "generated-job-a", nextWakeAtMs: 1792075952897 });
  assert.equal(result.message, "cron: started");
  const wrongPath = JSON.parse(normalizeText(raw.replaceAll("jobs.json", "wrong.json"), value => value.replaceAll(root, normalizedRoot)));
  assert.notEqual(result[0], wrongPath[0]);
});
