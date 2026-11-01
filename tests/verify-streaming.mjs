import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRows, checkpointDamage } from "../src/verify/rows.mjs";
import { sha256 } from "../src/verify/plan.mjs";

const normalization = { text: value => value, id: value => value };
test("streamed checkpoint records preserve split UTF-8, CRLF, blank and damaged lines", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kova-streaming-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "state"));
  await writeFile(join(directory, "commands.json"), "[]");
  // The emoji crosses the read boundary; a later CRLF crosses another one.
  const first = JSON.stringify({ text: "a".repeat(65523) + "😀" });
  const prefix = Buffer.from("\uFEFF" + first + "\r\n\n");
  const second = JSON.stringify({ text: "b".repeat(131071 - prefix.length - 11) });
  const damaged = Buffer.from([34, 0xc3, 0x28, 34]);
  await writeFile(join(directory, "state", "records.jsonl"), Buffer.concat([prefix, Buffer.from(second + "\r\n"), damaged, Buffer.from("\n42\r")]));
  const phase = { id: "sessions/read", commands: [], checkpoint: ["state:records.jsonl"] };
  const result = await checkpointRows(directory, phase, { compressed: [], stateIds: [] }, normalization, 0);
  const items = [...result.items.values()].filter(item => item.signal === "state");
  assert.equal(items.find(item => item.at === "records.jsonl/0/text").value, JSON.parse(first).text);
  assert.equal(items.find(item => item.at === "records.jsonl/2/text").value, JSON.parse(second).text);
  assert.deepEqual(items.find(item => item.at === "records.jsonl/3").value, { invalidJSONLBytes: sha256(damaged) });
  assert.equal(items.find(item => item.at === "records.jsonl/4").value, 42);
  assert.equal(items.some(item => item.at === "records.jsonl/1"), false);
  await writeFile(join(directory, "logs.txt"), Buffer.concat([Buffer.from("a".repeat(65535)), Buffer.from([0xf0, 0x9f, 0x98])]));
  assert.deepEqual((await checkpointDamage(directory, { ...phase, checkpoint: ["logs"] })).map(item => item.file), ["logs.txt"]);
});

test("sharing equal phase items keeps different values and shapes independent", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kova-sharing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "state"));
  await writeFile(join(directory, "commands.json"), "[]");
  const path = join(directory, "state", "value.json"), shared = new Map();
  const phase = { id: "sessions/read", commands: [], checkpoint: ["state:value.json"] };
  const read = () => checkpointRows(directory, phase, { compressed: [], stateIds: [] }, normalization, 0, [], () => {}, shared);
  await writeFile(path, JSON.stringify({ same: "kept", changed: "before", shape: ["entry"] }));
  const before = await read(), copy = await read();
  for (const [key, value] of before.items) assert.equal(copy.items.get(key), value);
  await writeFile(path, JSON.stringify({ same: "kept", changed: "after", shape: { 0: "entry" } }));
  const after = await read();
  const at = (result, address) => [...result.items.values()].find(item => item.at === address);
  assert.equal(at(after, "value.json/same"), at(before, "value.json/same"));
  assert.notEqual(at(after, "value.json/changed"), at(before, "value.json/changed"));
  assert.notEqual(at(after, "value.json/shape/0"), at(before, "value.json/shape/0"));
});
