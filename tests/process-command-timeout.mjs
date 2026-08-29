import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mockProviderOwnerRecord, resolveOwnedMockProviderPid } from "../src/process-safety.mjs";

const hangProbeMs = 8000;

export async function runProcessCommandTimeoutChecks(parentDir) {
  const binDir = join(parentDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "ps"), "#!/bin/sh\nexec sleep 60\n", "utf8");
  await chmod(join(binDir, "ps"), 0o755);

  const pidFile = join(parentDir, "pid");
  await writeFile(pidFile, `${JSON.stringify(mockProviderOwnerRecord(process.pid, randomUUID()))}\n`, "utf8");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  try {
    let settled = "pending";
    let inspectError = null;
    const inspect = resolveOwnedMockProviderPid({
      pidFile,
      supervisorPath: join(parentDir, "supervisor.mjs"),
      scriptPath: join(parentDir, "script.json"),
      requestLog: join(parentDir, "requests.jsonl"),
      serverLog: join(parentDir, "server.log")
    }).then(
      (pid) => {
        settled = "resolved";
        return pid;
      },
      (error) => {
        settled = "rejected";
        inspectError = error;
        throw error;
      }
    );

    const outcome = await Promise.race([
      inspect.then(() => "completed").catch(() => "completed"),
      new Promise((resolveOutcome) => {
        setTimeout(() => resolveOutcome("hung"), hangProbeMs);
      })
    ]);

    assert.equal(outcome, "completed", "stuck ps must be timed out instead of hanging inspect");
    assert.equal(settled, "rejected", "timed-out ps must fail inspect instead of returning a command");
    assert.equal(
      inspectError?.killed === true || inspectError?.code === "ETIMEDOUT" || inspectError?.code === "ETIME",
      true,
      "timed-out ps must surface a child timeout"
    );
  } finally {
    process.env.PATH = previousPath;
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const root = await mkdtemp(join(tmpdir(), "kova-process-command-timeout-"));
  try {
    await runProcessCommandTimeoutChecks(root);
    console.log("PASS process command timeout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
