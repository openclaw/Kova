import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCommand } from "../src/commands.mjs";

const hangProbeMs = 8000;
const checkTimeoutMs = 1000;
const commandsHref = pathToFileURL(fileURLToPath(new URL("../src/commands.mjs", import.meta.url))).href;

export async function runCheckCommandTimeoutChecks(parentDir) {
  const hangScript = join(parentDir, "hang.mjs");
  await writeFile(hangScript, "setTimeout(() => {}, 120000);\n", "utf8");

  const probeScript = join(parentDir, "probe.mjs");
  await writeFile(
    probeScript,
    `import { checkCommand } from ${JSON.stringify(commandsHref)};
const result = checkCommand(process.execPath, ${JSON.stringify([hangScript])}, { timeoutMs: ${checkTimeoutMs} });
process.stdout.write(JSON.stringify({
  status: result.status,
  timedOut: result.timedOut === true,
  errorCode: result.error?.code ?? result.signal ?? null
}));
`,
    "utf8"
  );

  let hangProbeTimer;
  const child = spawn(process.execPath, [probeScript], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const outcome = await Promise.race([
    new Promise((resolveOutcome, rejectOutcome) => {
      child.once("error", rejectOutcome);
      child.once("close", (status) => {
        resolveOutcome({ kind: "completed", status, stdout, stderr });
      });
    }),
    new Promise((resolveOutcome) => {
      hangProbeTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveOutcome({ kind: "hung" });
      }, hangProbeMs);
    })
  ]);
  clearTimeout(hangProbeTimer);

  assert.equal(outcome.kind, "completed", "stuck ocm --version helper must be timed out instead of hanging checkCommand");
  assert.equal(outcome.status, 0, `timeout probe must exit cleanly: ${outcome.stderr}`);
  const result = JSON.parse(outcome.stdout);
  assert.equal(result.timedOut, true, "timed-out helper must surface timedOut");
  assert.notEqual(result.status, 0, "timed-out helper must not report success");
  assert.equal(
    result.errorCode === "ETIMEDOUT" || result.errorCode === "SIGTERM",
    true,
    "timed-out helper must surface a child timeout"
  );

  const healthy = checkCommand(process.execPath, ["--version"]);
  assert.equal(healthy.status, 0, "node --version must still succeed");
  assert.equal(healthy.timedOut, false, "fast --version must not report timedOut");
  assert.match(healthy.stdout, /^v\d+/);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const root = await mkdtemp(join(tmpdir(), "kova-check-command-timeout-"));
  try {
    await runCheckCommandTimeoutChecks(root);
    console.log("PASS check command timeout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
