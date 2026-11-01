#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../support/process.mjs";

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
  for (const [script, args, artifact] of [
    ["install-channel-adapter-package.mjs", ["--channel", "discord"], "channel-adapter-install-discord.json"],
    ["ensure-gateway-running.mjs", ["--timeout-ms", "1", "--interval-ms", "1"], "gateway-ready.json"]
  ]) {
    const failed = spawnSync(process.execPath, [join(repoRoot, "support", script), "--env", "kova-process-test", "--artifact-dir", root, ...args], {
      env: { ...process.env, PATH: root }, encoding: "utf8", timeout: 5000
    });
    assert.equal(failed.status, 1, failed.stderr);
    const summary = JSON.parse(readFileSync(join(root, artifact), "utf8"));
    assert.equal(summary.ok, false);
    assert.ok(summary.commands.some((command) => command.status === 127), "missing OCM is recorded in the failure artifact");
  }

  writeFileSync(join(root, "ocm"), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[2] === "list") {
  if (process.env.KOVA_SNAPSHOT_TEST === "failure") { console.error("snapshot failure"); process.exit(9); }
  if (process.env.KOVA_SNAPSHOT_TEST === "malformed") { console.log("{"); process.exit(0); }
  const bytes = Buffer.from(JSON.stringify({ snapshots: [
    { id: "new", label: "pre-upgrade", createdAt: "2" },
    { id: "manual", label: "manual", createdAt: "0" },
    { id: "old-🦊", label: "pre-upgrade", createdAt: "1" }
  ] }));
  const split = bytes.indexOf(Buffer.from("🦊")) + 1;
  process.stdout.write(bytes.subarray(0, split));
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 100);
} else console.log(JSON.stringify({ id: a[4] }));
`, { mode: 0o755 });
  for (const mode of ["success", "failure", "malformed"]) {
    const restored = spawnSync(process.execPath, [join(repoRoot, "support/restore-first-ocm-upgrade-snapshot.mjs"), "--env", "kova-process-test"], {
      env: { ...process.env, PATH: root, KOVA_SNAPSHOT_TEST: mode }, encoding: "utf8", timeout: 5000
    });
    assert.equal(restored.status, mode === "success" ? 0 : 1, restored.stderr);
    if (mode === "success") {
      const summary = JSON.parse(restored.stdout);
      assert.equal(summary.snapshotId, "old-🦊");
      assert.equal(summary.restored.id, "old-🦊");
    } else assert.match(restored.stderr, mode === "failure" ? /failed with status 9: snapshot failure/ : /did not return JSON/);
  }

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

const inheritedEnv = await runProcess(process.execPath, ["-e", "console.log(process.env.PATH)"]);
assert.equal(inheritedEnv.status, 0);
assert.equal(inheritedEnv.stdout.trim(), process.env.PATH);

const captured = await runProcess(process.execPath, ["-e", `
  console.log(process.env.KOVA_PROCESS_TEST);
  console.error("diagnostic");
  process.exitCode = 7;
`], 10000, { KOVA_PROCESS_TEST: "overridden" });
assert.equal(captured.status, 7);
assert.equal(captured.stdout.trim(), "overridden");
assert.equal(captured.stderr.trim(), "diagnostic");
assert.equal(captured.timedOut, false);
assert.equal(captured.signal, null);
assert.ok(captured.durationMs >= 0);

const missing = await runProcess(join(repoRoot, "missing-kova-test-command"), [], 10000);
assert.equal(missing.status, 127);
assert.equal(missing.timedOut, false);
assert.match(missing.stderr, /ENOENT/);

const signaled = await runProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], 10000);
assert.equal(signaled.status, 1);
assert.equal(signaled.signal, "SIGTERM");
assert.equal(signaled.timedOut, false);

const timeout = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 200);
assert.equal(timeout.status, 124);
assert.equal(timeout.signal, "SIGTERM");
assert.equal(timeout.timedOut, true);

const splitUnicode = await runProcess(process.execPath, ["-e", `
  const out = Buffer.from("🦊"), err = Buffer.from("é");
  process.stdout.write(out.subarray(0, 1)); process.stderr.write(err.subarray(0, 1));
  setTimeout(() => { process.stdout.write(out.subarray(1)); process.stderr.write(err.subarray(1)); }, 100);
`]);
assert.equal(splitUnicode.stdout, "🦊");
assert.equal(splitUnicode.stderr, "é");

const inDirectory = await runProcess(process.execPath, ["-e", "console.log(process.cwd())"], 10000, {}, { cwd: repoRoot });
assert.equal(inDirectory.stdout.trim(), repoRoot);

const rawSignal = await runProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], 10000, {}, { normalizeStatus: false });
assert.equal(rawSignal.status, null);
assert.equal(rawSignal.signal, "SIGTERM");

await assert.rejects(runProcess(join(repoRoot, "missing-kova-test-command"), [], undefined, {}, { rejectOnError: true }), { code: "ENOENT" });

const delayedTermination = ["-e", `
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150));
  setInterval(() => {}, 1000);
`];
for (const [killGraceMs, status, signal] of [[50, null, "SIGKILL"], [null, 0, null]]) {
  const result = await runProcess(process.execPath, delayedTermination, 1000, {}, { killGraceMs, normalizeStatus: false });
  assert.equal(result.status, status);
  assert.equal(result.signal, signal);
  assert.equal(result.timedOut, true);
}

console.log("assert-command-output tests passed");

function runHelper(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
