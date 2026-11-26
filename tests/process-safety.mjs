import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const moduleUrl = new URL("../src/process-safety.mjs", import.meta.url).href;
const childSource = `
  import { readFile, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  const { mockProviderOwnerRecord, mockProviderStopFile, mockProviderSupervisorArgs,
    resolveOwnedMockProviderPid, stopOwnedMockProvider } = await import(process.env.KOVA_TEST_MODULE);
  const owner = mockProviderOwnerRecord(process.env.KOVA_TEST_PROBE === "real" ? process.pid : 424242,
    "00000000-0000-4000-8000-000000000001");
  process.env.KOVA_TEST_PID = String(owner.pid);
  const options = {
    pidFile: join(process.env.KOVA_TEST_DIRECTORY, "pid"),
    supervisorPath: "/fixture/supervisor.mjs",
    scriptPath: "/fixture/script.json",
    requestLog: "/fixture/requests.jsonl",
    serverLog: "/fixture/server.log"
  };
  process.env.KOVA_TEST_PS_OUTPUT = ["node", ...mockProviderSupervisorArgs(options)].join(" ");
  const ownerText = JSON.stringify(owner) + "\\n";
  const stopFile = mockProviderStopFile(options.pidFile, owner);
  await writeFile(options.pidFile, ownerText);
  await writeFile(stopFile, "existing stop request");
  let probes = 0;
  let signals = 0;
  let stopRequests = 0;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid !== owner.pid || signal !== 0) {
      signals++;
      throw new Error("unexpected signal");
    }
    probes++;
    if (process.env.KOVA_TEST_PROBE === "real") return originalKill(pid, signal);
    if (process.env.KOVA_TEST_PROBE !== "live") {
      const error = new Error("fixture probe error");
      error.code = process.env.KOVA_TEST_PROBE;
      throw error;
    }
    return true;
  };
  let result;
  let failure;
  try {
    result = process.env.KOVA_TEST_ACTION === "resolve"
      ? await resolveOwnedMockProviderPid(options)
      : await stopOwnedMockProvider({ ...options, stopTimeoutMs: 0,
          requestStop: async () => { stopRequests++; } });
  } catch (error) {
    failure = error;
  } finally {
    process.kill = originalKill;
  }
  const readOrMissing = async (path) => {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  console.log(JSON.stringify({ result, code: failure?.code, message: failure?.message,
    failed: Boolean(failure), probes, signals, stopRequests,
    ownerPreserved: await readOrMissing(options.pidFile) === ownerText,
    stopPreserved: await readOrMissing(stopFile) === "existing stop request" }));
`;

async function observe(t, mode, probe, action = "stop") {
  const directory = await mkdtemp(join(tmpdir(), "kova-process-safety-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  if (mode !== "missing-executable") {
    // Keep fixture startup outside Node's cold-start cost and inside the real
    // reader's unchanged two-second subprocess deadline.
    await writeFile(join(bin, "ps"), `#!/bin/sh
      test "$#" = 5 && test "$1" = -ww && test "$2" = -p &&
        test "$3" = "$KOVA_TEST_PID" && test "$4" = -o && test "$5" = command= || exit 99
      case "$KOVA_TEST_PS_MODE" in
        empty) printf ' \\n';;
        exit-one) exit 1;;
        exit-two) printf 'fixture ps failure' >&2; exit 2;;
        timeout) exec /bin/sleep 10;;
        overflow) exec /usr/bin/head -c 1048577 /dev/zero;;
        command) printf '%s\\n' "$KOVA_TEST_PS_OUTPUT";;
        *) exit 99;;
      esac
    `, { mode: 0o700 });
  }
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", childSource], {
    timeout: 8000,
    env: { ...process.env, PATH: bin, KOVA_TEST_DIRECTORY: directory,
      KOVA_TEST_MODULE: moduleUrl, KOVA_TEST_PS_MODE: mode,
      KOVA_TEST_PROBE: probe, KOVA_TEST_ACTION: action }
  });
  return JSON.parse(stdout);
}

for (const mode of ["empty", "exit-one"]) {
  for (const probe of ["live", "ESRCH", "EPERM", "EIO"]) {
    test(`${mode} inspection confirms ${probe} before cleanup`, async (t) => {
      const result = await observe(t, mode, probe);
      assert.equal(result.signals, 0);
      assert.equal(result.stopRequests, 0);
      assert.equal(result.ownerPreserved, probe !== "ESRCH");
      assert.equal(result.stopPreserved, probe !== "ESRCH");
      assert.equal(result.probes, 1);
      if (probe === "ESRCH") {
        assert.equal(result.failed, false);
        assert.equal(result.result.status, "not-running");
      } else {
        assert.equal(result.failed, true);
        assert.equal(result.code, probe === "live" ? "ERR_PROCESS_INSPECTION_INCOMPLETE" : probe);
      }
    });
  }
}

for (const [mode, code] of [["exit-two", 2], ["missing-executable", "ENOENT"], ["timeout", null], ["overflow", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]]) {
  test(`${mode} inspection failure propagates without an absence probe`, async (t) => {
    const result = await observe(t, mode, "ESRCH");
    assert.equal(result.failed, true);
    if (code !== null) assert.equal(result.code, code);
    assert.equal(result.probes, 0);
    assert.equal(result.signals, 0);
    assert.equal(result.stopRequests, 0);
    assert.equal(result.ownerPreserved, true);
    assert.equal(result.stopPreserved, true);
  });
}

test("readable command resolves ownership without an absence probe", async (t) => {
  const result = await observe(t, "command", "EPERM", "resolve");
  assert.equal(result.failed, false);
  assert.equal(result.result, 424242);
  assert.equal(result.probes, 0);
  assert.equal(result.ownerPreserved, true);
});

for (const probe of ["live", "ESRCH"]) {
  test(`ownership lookup preserves its record after ${probe} observation`, async (t) => {
    const result = await observe(t, "empty", probe, "resolve");
    assert.equal(result.probes, 1);
    assert.equal(result.ownerPreserved, true);
    assert.equal(result.failed, probe === "live");
    if (probe === "ESRCH") assert.equal(result.result, null);
  });
}

test("empty inspection of the fixture's own live PID preserves ownership", async (t) => {
  const result = await observe(t, "empty", "real");
  assert.equal(result.failed, true);
  assert.equal(result.code, "ERR_PROCESS_INSPECTION_INCOMPLETE");
  assert.equal(result.probes, 1);
  assert.equal(result.signals, 0);
  assert.equal(result.stopRequests, 0);
  assert.equal(result.ownerPreserved, true);
  assert.equal(result.stopPreserved, true);
});

async function observeOwnerCleanup(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), "kova-owner-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const { mockProviderOwnerRecord, removeMockProviderOwnerFile } = await import(process.env.KOVA_TEST_MODULE);
    const original = { ...fs };
    const mode = process.env.KOVA_TEST_MODE;
    const pidFile = join(process.env.KOVA_TEST_DIRECTORY, "pid");
    const owners = Object.fromEntries(["A", "B", "C"].map((label, index) =>
      [label, JSON.stringify(mockProviderOwnerRecord(12345 + index,
        "00000000-0000-4000-8000-00000000000" + (index + 1))) + "\\n"]));
    await original.writeFile(pidFile, mode === "initial-replacement" ? owners.B : owners.A);
    const injected = Object.assign(new Error("fixture cleanup failure"), {
      code: mode === "restore-full" ? "ENOSPC" : mode === "read-denied" ? "EACCES" : "EIO"
    });
    fs.rename = async (from, to) => {
      if (from === pidFile && mode !== "expected" && mode !== "read-expected") {
        await original.writeFile(pidFile, owners.B);
      }
      return original.rename(from, to);
    };
    fs.readFile = async (path, ...args) => {
      if (String(path).startsWith(pidFile + ".cleanup.") && mode.startsWith("read-")) throw injected;
      return original.readFile(path, ...args);
    };
    fs.link = async (from, to) => {
      if (to === pidFile) {
        if (mode.startsWith("restore-")) throw injected;
        if (mode === "successor") await original.writeFile(pidFile, owners.C);
      }
      return original.link(from, to);
    };
    syncBuiltinESMExports();
    let failure;
    try { await removeMockProviderOwnerFile(pidFile, owners.A); }
    catch (error) { failure = error; }
    finally {
      fs.rename = original.rename;
      fs.readFile = original.readFile;
      fs.link = original.link;
      syncBuiltinESMExports();
    }
    const ownerAt = async (path) => {
      let text;
      try { text = await original.readFile(path, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      return Object.keys(owners).find((label) => owners[label] === text) ?? "unexpected bytes";
    };
    const claims = (await original.readdir(process.env.KOVA_TEST_DIRECTORY))
      .filter((name) => name.startsWith("pid.cleanup."));
    console.log(JSON.stringify({ failed: Boolean(failure), code: failure?.code,
      originalError: failure === injected, owner: await ownerAt(pidFile),
      claims: await Promise.all(claims.map((name) => ownerAt(join(process.env.KOVA_TEST_DIRECTORY, name)))) }));
  `;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", source], {
    timeout: 8000,
    env: { ...process.env, KOVA_TEST_MODULE: moduleUrl,
      KOVA_TEST_DIRECTORY: directory, KOVA_TEST_MODE: mode }
  });
  return JSON.parse(stdout);
}

for (const [mode, owner] of [["expected", null], ["initial-replacement", "B"], ["replacement", "B"], ["successor", "C"]]) {
  test(`owner cleanup preserves the ${mode} generation outcome`, async (t) => {
    const result = await observeOwnerCleanup(t, mode);
    assert.equal(result.failed, false);
    assert.equal(result.owner, owner);
    assert.deepEqual(result.claims, []);
  });
}

for (const [mode, code, owner] of [["restore-error", "EIO", "B"], ["restore-full", "ENOSPC", "B"], ["read-denied", "EACCES", "B"], ["read-expected", "EIO", "A"]]) {
  test(`${mode} retains claimed owner bytes and the original failure`, async (t) => {
    const result = await observeOwnerCleanup(t, mode);
    assert.equal(result.failed, true);
    assert.equal(result.code, code);
    assert.equal(result.originalError, true);
    assert.equal(result.owner, null);
    assert.deepEqual(result.claims, [owner]);
  });
}
