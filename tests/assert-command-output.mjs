#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const firstAttempt = runHelper([
  "--contains", "ready", "--retries", "3", "--delay-ms", "0",
  "--", process.execPath, "-e", "console.log('ready')"
]);
assert.equal(firstAttempt.status, 0, firstAttempt.stderr);
assert.equal(JSON.parse(firstAttempt.stdout).attempts, 1, "receipt counts executions, not the retry budget");

const root = mkdtempSync(join(tmpdir(), "kova-command-assertion-"));
try {
  const counter = join(root, "attempts");
  const child = `
const fs = require("node:fs");
const path = process.argv[1];
const attempt = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) + 1 : 1;
fs.writeFileSync(path, String(attempt));
console.log(attempt >= 3 ? "ready" : "waiting");
process.exitCode = attempt >= 3 ? 0 : 1;
`;
  const retried = runHelper([
    "--contains", "ready", "--retries", "5", "--delay-ms", "0",
    "--", process.execPath, "-e", child, counter
  ]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).attempts, 3);
  assert.equal(readFileSync(counter, "utf8"), "3");

  rmSync(counter);
  const exhausted = runHelper([
    "--contains", "ready", "--retries", "2", "--delay-ms", "0",
    "--", process.execPath, "-e", child, counter
  ]);
  assert.equal(exhausted.status, 1);
  assert.equal(readFileSync(counter, "utf8"), "2", "failure stops at the configured budget");
} finally {
  rmSync(root, { recursive: true, force: true });
}

for (const [flag, value] of [
  ["--retries", "1junk"],
  ["--retries", "1.5"],
  ["--expect-status", "0junk"],
  ["--delay-ms", "0junk"]
]) {
  const invalid = runHelper([
    "--contains", "ready", flag, value,
    "--", process.execPath, "-e", "console.log('ready')"
  ]);
  assert.equal(invalid.status, 1, `${flag} rejects ${value}`);
  assert.match(invalid.stderr, new RegExp(`${flag} must be .*integer`));
}

console.log("assert-command-output tests passed");

function runHelper(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
