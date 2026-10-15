import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectSessionStatusCursor } from "../support/verify/session-status-cursor.mjs";

const helper = fileURLToPath(new URL("../support/verify/session-status-cursor.mjs", import.meta.url));
function records() {
  return {
    caller: { method: "sessions.create", result: { key: "agent:main:caller" }, error: null },
    target: { method: "sessions.create", result: { key: "agent:main:watched" }, error: null },
    source: {
      callerSessionKey: "agent:main:caller",
      toolCall: { name: "session_status", args: { sessionKey: "agent:main:watched" } },
      toolResult: { isError: false, details: { sessionKey: "agent:main:watched", stateVersion: 7 }, content: [{ text: "unrelated display text" }] },
      error: null
    }
  };
}
const project = ({ source, caller, target }) => projectSessionStatusCursor(source, caller, target);

test("projects only the watched session and native status cursor", () => {
  for (const version of [0, 7, Number.MAX_SAFE_INTEGER]) {
    const input = records();
    input.source.toolResult.details.stateVersion = version;
    assert.deepEqual(project(input), { sessionKey: "agent:main:watched", changesSince: version });
    assert.equal(input.source.toolResult.details.stateVersion, version);
    assert.equal(input.source.toolResult.details.changesSince, undefined);
  }
});

test("refuses failed, missing, or mismatched input identities", () => {
  const cases = [
    (input) => { input.source.error = "turn failed"; },
    (input) => { delete input.source.error; },
    (input) => { input.source.callerSessionKey = "agent:main:other"; },
    (input) => { input.source.toolCall.name = "sessions_send"; },
    (input) => { input.source.toolCall.args.sessionKey = "agent:main:other"; },
    (input) => { delete input.source.toolCall; },
    (input) => { input.source.toolResult.details.sessionKey = "agent:main:other"; },
    (input) => { delete input.source.toolResult.details.sessionKey; },
    (input) => { input.source.toolResult.isError = true; },
    (input) => { input.source.toolResult.isError = "false"; },
    (input) => { input.source.toolResult = null; },
    (input) => { input.caller.error = "creation failed"; },
    (input) => { input.target.error = "creation failed"; },
    (input) => { input.caller.method = "sessions.describe"; },
    (input) => { input.target.result.key = ""; },
    (input) => { delete input.target.error; }
  ];
  for (const change of cases) {
    const input = records();
    change(input);
    assert.throws(() => project(input));
  }
});

test("refuses absent, fractional, negative, or unsafe cursors", () => {
  for (const version of [undefined, null, "7", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = records();
    input.source.toolResult.details.stateVersion = version;
    assert.throws(() => project(input), /stateVersion/);
  }
});

test("CLI writes identical JSON once and preserves files when refusing input or output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-status-cursor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = records();
  const paths = Object.fromEntries(["source", "caller", "target"].map((name) => [name, join(directory, `${name}.json`)]));
  for (const name of Object.keys(paths)) await writeFile(paths[name], JSON.stringify(input[name]));
  const args = ["--from", paths.source, "--session-from", paths.caller, "--target-from", paths.target];
  const run = (out, extra = []) => spawnSync(process.execPath, [helper, ...args, "--out", out, ...extra], { encoding: "utf8", timeout: 10000 });
  const out = join(directory, "cursor.json");
  const success = run(out);
  assert.ifError(success.error);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, '{"sessionKey":"agent:main:watched","changesSince":7}\n');
  assert.equal(await readFile(out, "utf8"), success.stdout);

  for (const existing of [out, paths.source, paths.target]) {
    const before = await readFile(existing, "utf8");
    const refused = run(existing);
    assert.ifError(refused.error);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /already exists/);
    assert.equal(await readFile(existing, "utf8"), before);
  }

  const invalidOut = join(directory, "invalid.json");
  const repeated = run(invalidOut, ["--from", paths.source]);
  assert.equal(repeated.status, 2);
  assert.match(repeated.stderr, /repeated flag/);
  await assert.rejects(access(invalidOut), { code: "ENOENT" });

  input.source.toolResult.details.sessionKey = "agent:main:other";
  await writeFile(paths.source, JSON.stringify(input.source));
  const mismatched = run(invalidOut);
  assert.equal(mismatched.status, 2);
  assert.equal(mismatched.stdout, "");
  assert.match(mismatched.stderr, /different or missing watched session/);
  await assert.rejects(access(invalidOut), { code: "ENOENT" });

  input.source.toolResult.details.sessionKey = "agent:main:watched";
  input.source.toolResult.isError = true;
  await writeFile(paths.source, JSON.stringify(input.source));
  const failed = run(invalidOut);
  assert.ifError(failed.error);
  assert.equal(failed.status, 2);
  assert.equal(failed.stdout, "");
  await assert.rejects(access(invalidOut), { code: "ENOENT" });
});
