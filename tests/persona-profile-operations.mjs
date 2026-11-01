import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeHeartbeat } from "../support/persona/environment-content.mjs";

test("heartbeat content writes only workspace instructions without invoking a product command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kova-heartbeat-content-"));
  try {
    assert.deepEqual(await writeHeartbeat({ workspace }), {});
    assert.deepEqual(await readdir(workspace), ["HEARTBEAT.md"]);
    assert.equal(await readFile(join(workspace, "HEARTBEAT.md"), "utf8"), "# Notebook heartbeat\n\nCheck the notebook scratch and reply HEARTBEAT_OK.\n");
  } finally { await rm(workspace, { recursive: true, force: true }); }
  await assert.rejects(writeHeartbeat({ workspace: join(workspace, "missing") }), (error) => {
    assert.equal(error.exitCode, 1);
    assert.equal(error.message, "could not write persona heartbeat instructions");
    return true;
  });
});

test("removed compound commands and invalid operation flags stop with JSON usage errors", () => {
  const cases = [
    ["configure-environment.mjs", ["dm-scope", "--env", "unused-env"]],
    ["share-readonly-session.mjs", ["--env", "unused-env", "--key", "agent:main:shared", "--member-profile-id", "unused-profile"]],
    ["share-readonly-session.mjs", ["create", "--env", "unused-env", "--key", "agent:main:shared", "--visibility", "read-only"]],
    ["share-readonly-session.mjs", ["visibility", "--env", "unused-env", "--key", "agent:main:shared", "--visibility", "public"]],
    ["pair-cli-profile.mjs", ["--env", "unused-env"]],
    ["make-session.mjs", ["--env", "unused-env", "--label", "generated", "--session-label", "not-allowed", "--messages", "1"]],
  ];
  for (const [file, args] of cases) {
    const script = fileURLToPath(new URL(`../support/persona/${file}`, import.meta.url));
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined, file);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).error.code, "usage");
  }
});
