#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(repoRoot, "support", "assert-command-output.mjs");

const literal = runHelper([
  "--contains",
  "READY+NOW",
  "--",
  process.execPath,
  "-e",
  "console.log('ready+now')"
]);
assert.equal(literal.status, 0, literal.stderr);
assert.deepEqual(JSON.parse(literal.stdout), {
  schemaVersion: "kova.commandOutputAssertion.v2",
  command: `${process.execPath} -e console.log('ready+now')`,
  status: 0,
  expectedText: "READY+NOW",
  attempts: 1,
  matched: true,
  matchedLine: "ready+now"
});

const noRegexEvaluation = runHelper([
  "--contains",
  "ready+now",
  "--",
  process.execPath,
  "-e",
  "console.log('readynow')"
]);
assert.equal(noRegexEvaluation.status, 1);
assert.match(noRegexEvaluation.stderr, /expected command output to contain "ready\+now"/);

console.log("assert-command-output tests passed");

function runHelper(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
