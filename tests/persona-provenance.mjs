import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCommand, runWithCommandEnv } from "../src/commands.mjs";
import { captureOcmProvenance } from "../src/persona/provenance.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kova-persona-provenance-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const native = await realpath(process.execPath);
  return { root, bin, native, env: { PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/sh", KOVA_OCM_TRANSPORT_JSON: undefined } };
}

const capture = (env) => runWithCommandEnv(env, () => captureOcmProvenance(async (command) => {
  const result = await runCommand(command);
  assert.equal(result.status, 0, result.stderr);
  return result;
}));

let nativeDigest;
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

test("OCM provenance resolves the executor's PATH and hashes the native symlink target", async (t) => {
  const f = await fixture(t);
  await symlink(f.native, join(f.bin, "ocm"));
  const record = await capture(f.env);
  nativeDigest = await digest(f.native);
  assert.deepEqual(record, { binary: f.native, version: process.version, sha256: nativeDigest });
});

test("transport provenance probes through its prefix and target environment instead of the PATH shim", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.bin, "ocm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const home = join(f.root, "target-home"), cwd = join(home, "working");
  await mkdir(cwd, { recursive: true });
  const log = join(f.root, "prefix.json"), prefix = join(f.root, "prefix.mjs");
  await writeFile(prefix, `
    import { writeFileSync } from "node:fs";
    import { spawn } from "node:child_process";
    import assert from "node:assert/strict";
    const args = process.argv.slice(2);
    assert.equal(args.shift(), "/usr/bin/env");
    assert.equal(args.shift(), "-C");
    const cwd = args.shift();
    assert.equal(args.shift(), "-i");
    const env = {};
    while (args[0]?.includes("=") && !args[0].startsWith("/")) {
      const pair = args.shift(), index = pair.indexOf("=");
      env[pair.slice(0, index)] = pair.slice(index + 1);
    }
    writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd, env, args }));
    const child = spawn(args.shift(), args, { cwd, env, stdio: "inherit" });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    child.on("exit", code => { process.exitCode = code ?? 1; });
  `);
  const record = await capture({ ...f.env, MUST_STAY_WITH_RUNNER: "runner-only", KOVA_OCM_TRANSPORT_JSON: JSON.stringify({
    prefix: [process.execPath, prefix], binary: f.native, cwd,
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  }) });
  assert.deepEqual(record, { binary: f.native, version: process.version, sha256: nativeDigest ?? await digest(f.native) });
  const invocation = JSON.parse(await readFile(log, "utf8"));
  assert.equal(invocation.cwd, cwd);
  assert.equal(invocation.env.HOME, home);
  assert.equal(invocation.env.MUST_STAY_WITH_RUNNER, undefined);
  assert.equal(invocation.env.KOVA_OCM_TRANSPORT_JSON, undefined);
  assert.deepEqual(invocation.args.slice(0, 4), ["/usr/bin/env", "node", "--input-type=module", "-e"]);
});

test("OCM npm launcher provenance identifies its platform executable", async (t) => {
  const f = await fixture(t);
  const platform = `${process.platform}-${process.arch}`;
  const target = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" }[platform];
  if (!target) return t.skip("OCM npm does not support this platform");
  const packageRoot = join(f.root, "node_modules", "@openclaw", "ocm");
  const platformRoot = join(f.root, "node_modules", "@openclaw", `ocm-${platform}`);
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(platformRoot, "vendor", target, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openclaw/ocm", bin: { ocm: "bin/ocm.cjs" } }));
  await writeFile(join(platformRoot, "package.json"), JSON.stringify({ name: `@openclaw/ocm-${platform}` }));
  await symlink(f.native, join(platformRoot, "vendor", target, "bin", "ocm"));
  const launcher = join(packageRoot, "bin", "ocm.cjs");
  await writeFile(launcher, `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process"); process.stdout.write(execFileSync(${JSON.stringify(f.native)}, process.argv.slice(2)));\n`, { mode: 0o755 });
  await symlink(launcher, join(f.bin, "ocm"));
  const record = await capture(f.env);
  assert.equal(record.binary, f.native);
  assert.equal(record.sha256, nativeDigest ?? await digest(f.native));
  assert.notEqual(record.sha256, await digest(launcher));
});

test("unknown OCM script wrappers are refused instead of recorded as the binary", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.bin, "ocm"), "#!/bin/sh\nprintf '0.3.3'\n", { mode: 0o755 });
  await assert.rejects(capture(f.env), /requires the native executable/);
});
