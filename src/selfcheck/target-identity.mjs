import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { resolveTarget } from "../targets.mjs";
import { captureTargetIdentity, recordTargetIdentity, reportTargetIdentity } from "../target-identity.mjs";

const version = "2026.7.1-2";
const plan = resolveTarget(`npm:${version}`, "target");
const digest = `sha512-${Buffer.alloc(64, 0x5a).toString("base64")}`;
const otherDigest = `sha512-${Buffer.alloc(64, 0x6b).toString("base64")}`;
const envName = "kova-identity-check";
const metadata = { name: "bound", sourceKind: "installed", releaseVersion: version, sourceIntegrity: digest };
const success = (payload, extra = {}) => ({ status: 0, stdout: JSON.stringify(payload), ...extra });
const start = () => success({ envName, defaultRuntime: "bound" }, {
  command: `ocm start '${envName}' --version '${version}' --json`
});
const upgrade = () => success({ envName, bindingKind: "runtime", bindingName: "bound", outcome: "switched", runtimeReleaseVersion: version }, {
  command: `ocm upgrade '${envName}' --version '${version}' --json`
});

export async function checkTargetIdentityBinding() {
  const calls = [];
  const execute = async (command) => {
    calls.push(command);
    assert.equal(command, "ocm runtime show 'bound' --json");
    return success(metadata);
  };
  const bound = start();
  await captureTargetIdentity(bound, plan, envName, { execute });
  assert.equal(bound.targetIdentity.npmIntegrity, digest);
  const upgraded = upgrade();
  await captureTargetIdentity(upgraded, plan, envName, { execute });
  assert.deepEqual(upgraded.targetIdentity, bound.targetIdentity);

  for (const result of [
    { ...start(), status: 1 }, { ...start(), timedOut: true },
    { ...start(), signal: "SIGTERM" }, { ...start(), outputBudget: { truncated: true } },
    { ...start(), stdout: "not json" },
    { ...start(), stdout: JSON.stringify({ envName: "unrelated", defaultRuntime: "bound" }) },
    { ...upgrade(), stdout: JSON.stringify({ envName, bindingKind: "runtime", bindingName: "bound", outcome: "rolled-back", runtimeReleaseVersion: version }) }
  ]) {
    await captureTargetIdentity(result, plan, envName, { execute });
    assert.equal(result.targetIdentity, null);
  }
  assert.equal(calls.length, 2, "failed provisioning never looks up runtime identity");
  for (const result of [
    success({ ...metadata, name: "unrelated" }), success({ ...metadata, releaseVersion: "1.2.3" }),
    success({ ...metadata, sourceKind: "registered" }), success({ ...metadata, sourceIntegrity: otherDigest.slice(0, -4) }),
    success({ ...metadata, sourceIntegrity: `${digest.slice(0, -2)}A=` }),
    success(metadata, { status: 1 }), success(metadata, { outputBudget: { truncated: true } }),
    { status: 0, stdout: "not json" }
  ]) {
    const receipt = start();
    await captureTargetIdentity(receipt, plan, envName, { execute: async () => result });
    assert.equal(receipt.targetIdentity, null);
  }
  const source = { ...start(), command: `ocm start '${envName}' --channel stable --json` };
  await captureTargetIdentity(source, plan, envName, { execute });
  assert.equal(Object.hasOwn(source, "targetIdentity"), false);
  const moving = start();
  await captureTargetIdentity(moving, resolveTarget("release:stable", "target"), envName, { execute });
  assert.equal(Object.hasOwn(moving, "targetIdentity"), false);

  const identity = recordTargetIdentity({ phases: [{ results: [source, bound] }, { results: [{ command: "rollback" }] }] });
  assert.deepEqual(identity, bound.targetIdentity, "rollback does not replace captured candidate");
  assert.equal(recordTargetIdentity({ phases: [{ results: [bound, { targetIdentity: null }] }] }), null);
  const records = [{ status: "PASS", targetIdentity: identity }, { status: "SKIPPED" }];
  assert.deepEqual(reportTargetIdentity(records), identity);
  assert.equal(reportTargetIdentity([...records, { status: "BLOCKED" }]), null);
  assert.equal(reportTargetIdentity([...records, { status: "PASS", targetIdentity: { ...identity, npmIntegrity: otherDigest } }]), null);
  assert.equal(reportTargetIdentity([{ status: "DRY-RUN" }]), null);
}

export async function checkTargetIdentityOutputs(parent) {
  const root = join(parent, "identity-outputs");
  const bin = join(root, "bin");
  const eventsPath = join(root, "events.jsonl");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ocm"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.IDENTITY_EVENTS, JSON.stringify(args) + '\\n');
if (args[0] === 'start') {
  if (process.env.IDENTITY_FAIL === '1') process.exit(1);
  console.log(JSON.stringify({envName: args[1], defaultRuntime: 'bound'}));
} else if (args[0] === 'runtime' && args[1] === 'show') {
  console.log(JSON.stringify(${JSON.stringify(metadata)}));
} else if (args[0] === 'runtime' && args[1] === 'list') {
  console.log(JSON.stringify([${JSON.stringify({ ...metadata, name: 'unrelated', sourceIntegrity: otherDigest })}]));
} else if (args[0] === 'env' && args[1] === 'destroy') {
  console.log('{}');
} else process.exit(1);
`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, KOVA_HOME: join(root, "home"), IDENTITY_EVENTS: eventsPath };
  for (const matrix of [false, true]) {
    for (const mode of ["failed", "bound", "dry"]) {
      await writeFile(eventsPath, "");
      const args = matrix ? "matrix run --profile smoke --include scenario:fresh-install" : "run --scenario fresh-install";
      const result = await runCommand(`node bin/kova.mjs ${args} --target npm:${version} --auth skip --timeout-ms 2000 --health-samples 1 --report-dir ${quoteShell(root)} ${mode === "dry" ? "" : "--execute"} --json`, {
        env: { ...env, IDENTITY_FAIL: mode === "failed" ? "1" : "0" }, timeoutMs: 60000, maxOutputChars: 1000000
      });
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
      const bundleResult = matrix ? null : await runCommand(`node bin/kova.mjs report bundle ${quoteShell(receipt.jsonPath)} --json`, { env, timeoutMs: 30000 });
      if (bundleResult) assert.equal(bundleResult.status, 0, bundleResult.stderr);
      const bundlePath = receipt.bundlePath ?? JSON.parse(bundleResult.stdout).outputPath;
      const archiveList = await runCommand(`tar -tzf ${quoteShell(bundlePath)}`);
      assert.equal(archiveList.status, 0, archiveList.stderr);
      const manifestPath = archiveList.stdout.split("\n").find((name) => name.endsWith("/manifest.json"));
      assert.ok(manifestPath);
      const manifestResult = await runCommand(`tar -xOzf ${quoteShell(bundlePath)} ${quoteShell(manifestPath)}`);
      assert.equal(manifestResult.status, 0, manifestResult.stderr);
      const manifest = JSON.parse(manifestResult.stdout);
      for (const output of [receipt, report, manifest, ...report.records]) {
        if (mode === "bound") assert.equal(output.targetIdentity?.npmIntegrity, digest);
        else assert.equal(Object.hasOwn(output, "targetIdentity"), false);
      }
      assert.deepEqual(receipt.targetIdentity, report.targetIdentity);
      assert.deepEqual(manifest.targetIdentity, report.targetIdentity);
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.equal(events.some((args) => args[0] === "runtime" && args[1] === "list"), false);
      const show = events.findIndex((args) => args[0] === "runtime" && args[1] === "show");
      if (mode === "bound") {
        assert.ok(show > 0);
        assert.ok(show < events.findIndex((args) => args[0] === "env" && args[1] === "destroy"));
        assert.notEqual(report.records[0].cleanup, "retained");
      } else assert.equal(show, -1);
    }
  }
}
