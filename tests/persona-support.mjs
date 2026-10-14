import "./persona-store-read.mjs";
import "./persona-gateway-schema.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { loadCatalogue, resolveCatalogueEntry } from "../src/catalogue.mjs";

const definition = JSON.parse(await readFile(new URL("../personas/openclaw-verification-user.json", import.meta.url), "utf8"));
const { catalogue } = await loadCatalogue("openclaw");
const scripts = ["add-agent", "write-mock-script", "check-agents", "check-mock-provider", "check-channels", "check-plugins", "check-config", "check-mock-script", "make-session", "session-keys"];
function invoke(name, args, env = process.env) {
  return spawnSync(process.execPath, [new URL(`../support/persona/${name}.mjs`, import.meta.url).pathname, ...args], { env, encoding: "utf8", timeout: 10000 });
}

test("each persona check has a distinct catalogue head and exactly its declared success fields", () => {
  const entries = definition.traits.map((trait) => resolveCatalogueEntry(catalogue, trait.check));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, definition.traits.length);
  definition.traits.forEach((trait, index) => assert.deepEqual(entries[index].prints, Object.keys(trait.keys)));
});

test("persona support commands report malformed calls as JSON with exit 2", () => {
  for (const name of scripts) {
    for (const args of [[], ["--env", "unused", "--unknown", "value"]]) {
      const result = invoke(name, args);
      assert.equal(result.status, 2, `${name}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).error.code, "usage");
      assert.equal(result.stderr, "");
    }
  }
  for (const [name, args] of [
    ["make-session", ["--env", "unused", "--messages", "1"]],
    ["make-session", ["--env", "unused", "--messages", "1", "--key", "agent:main:example", "--kind", "unknown"]],
    ["make-session", ["--env", "unused", "--messages", "1", "--key", "agent:main:example", "--kind", "session-idle-expired"]],
    ["session-keys", ["unknown", "--env", "unused", "--key", "agent:main:example"]],
  ]) {
    const malformed = invoke(name, args);
    assert.equal(malformed.status, 2, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).error.code, "usage");
  }
  for (const args of [["--add-held-turn", "--marker", "VERIFY_HOLD", "--hold-ms", "90000"], ["--env", "unused"], ["--env", "unused", "--add-held-turn", "--marker", "VERIFY_HOLD", "--hold-ms", "NaN"]]) {
    const malformed = spawnSync(process.execPath, [new URL("../support/write-mock-ai-provider-script.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
    assert.equal(malformed.status, 2, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).error.code, "usage");
  }
  const result = invoke("check-channels", ["--env", "unused", "--timeout", "0"]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "usage");
});

test("mock table commands emit their fixed success shape and JSON product errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-persona-support-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); await mkdir(bin);
  const fake = `#!/usr/bin/env node\nif (process.argv[2] !== 'env' || process.argv[3] !== 'show') process.exit(1);\nconsole.log(JSON.stringify({root:${JSON.stringify(root)},workspaceDir:${JSON.stringify(join(root, "workspace"))}}));\n`;
  await writeFile(join(bin, "ocm"), fake, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SHELL: "/bin/bash" };
  delete env.KOVA_OCM_TRANSPORT_JSON;
  let result = invoke("check-mock-script", ["--env", "fixture", "--marker", "KOVA_AGENT_OK"], env);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "product");
  assert.equal(result.stderr, "");
  result = invoke("write-mock-script", ["--env", "fixture"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["path"]);
  const initial = JSON.parse(await readFile(join(root, "workspace", "kova-persona", "mock-script.json"), "utf8"));
  assert.deepEqual(initial.kovaPersona, { version: 1 });
  result = spawnSync(process.execPath, [new URL("../support/write-mock-ai-provider-script.mjs", import.meta.url).pathname, "--env", "fixture", "--add-held-turn", "--marker", "VERIFY_HOLD", "--hold-ms", "90000", "--progress-card"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["path"]);
  const saved = JSON.parse(await readFile(join(root, "workspace", "kova-persona", "mock-script.json"), "utf8"));
  assert.deepEqual(saved.kovaPersona.heldTurn, { marker: "VERIFY_HOLD", holdMs: 90000, progressCard: true });
  result = invoke("check-mock-script", ["--env", "fixture", "--marker", "KOVA_AGENT_OK"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["present", "entry"]);
  result = invoke("check-mock-script", ["--env", "fixture", "--marker", "KOVA_ABSENT"], env);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "product");
  assert.equal(result.stderr, "");
});
