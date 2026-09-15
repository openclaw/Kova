import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { triggerDiagnosticSession } from "../collectors/diagnostics.mjs";
import { assertEqual, restoreEnv } from "./harness.mjs";

export async function diagnosticTriggerValidationCheck(tmp) {
  const root = join(tmp, "diagnostic-trigger");
  const binDir = join(root, "bin");
  const openclawHome = join(root, "openclaw-home");
  const invocationLog = join(root, "ocm.log");
  const previousPath = process.env.PATH;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousOcmLog = process.env.KOVA_FAKE_OCM_LOG;
  const previousOcmHang = process.env.KOVA_FAKE_OCM_HANG;
  let child = null;
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(openclawHome, { recursive: true });
    await writeFile(join(openclawHome, "stale.heapsnapshot"), "stale");
    await Promise.all(Array.from({ length: 60 }, (_, index) =>
      writeFile(join(openclawHome, `report.stale-${index}.json`), "{}\n")
    ));
    await writeFile(join(openclawHome, "diagnostic.fixed.json"), "{\"generation\":0}\n");
    const futureTimestamp = new Date(Date.now() + 60000);
    await utimes(join(openclawHome, "stale.heapsnapshot"), futureTimestamp, futureTimestamp);
    await utimes(join(openclawHome, "report.stale-0.json"), futureTimestamp, futureTimestamp);
    await writeFile(join(binDir, "ocm"), `#!/bin/sh
printf '%s env=%s\\n' "$*" "\${KOVA_FAKE_WRAPPER_ENV:-}" >> "$KOVA_FAKE_OCM_LOG"
if [ "\${KOVA_FAKE_OCM_HANG:-}" = "1" ]; then exec sleep 10; fi
if [ -n "\${KOVA_FAKE_OCM_DELAY:-}" ]; then sleep "$KOVA_FAKE_OCM_DELAY"; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] || exit 2
shift
exec "$@"
`);
    await chmod(join(binDir, "ocm"), 0o755);
    process.env.PATH = `${binDir}:${previousPath}`;
    process.env.OPENCLAW_HOME = `${openclawHome}/`;
    process.env.KOVA_FAKE_OCM_LOG = invocationLog;
    child = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.OPENCLAW_HOME;
let signalCount = 0;
function diagnosticStamp(signal) {
  return "0101" + String(signal).padStart(2, "0");
}
function heapName(signal) {
  return "Heap.20260712." + diagnosticStamp(signal) + "." + process.pid + ".0." + String(signal).padStart(3, "0") + ".heapsnapshot";
}
function reportName(signal) {
  return "report.20260712." + diagnosticStamp(signal) + "." + process.pid + ".0." + String(signal).padStart(3, "0") + ".json";
}
process.on("SIGUSR2", () => {
  const currentSignal = ++signalCount;
  const outputHome = currentSignal === 1
    ? path.join(home, "depth-1", "depth-2", "depth-3", "depth-4", "depth-5")
    : home;
  if (currentSignal === 4) {
    setTimeout(() => {
      fs.writeFileSync(
        path.join(home, "report.20260712.010101.999999.0.004.json"),
        "{\\"header\\":{\\"processId\\":999999}}\\n"
      );
    }, 100);
    setTimeout(() => {
      fs.writeFileSync(path.join(home, reportName(currentSignal)), "{\\"delayed\\":true}\\n");
    }, 700);
    return;
  }
  if (currentSignal === 5) {
    const slowHeap = path.join(home, heapName(currentSignal));
    setTimeout(() => {
      fs.writeFileSync(slowHeap, "{\\"heap\\":\\"head\\"");
    }, 200);
    setTimeout(() => {
      fs.appendFileSync(slowHeap, ",\\"tail\\":true}\\n");
    }, 2800);
    return;
  }
  if (currentSignal === 6) {
    setTimeout(() => {
      fs.writeFileSync(
        path.join(home, "diagnostic.fixed.json"),
        JSON.stringify({ header: { processId: process.pid }, generation: 1 }) + "\\n"
      );
    }, 400);
    return;
  }
  if (currentSignal === 7) {
    setTimeout(() => {
      fs.writeFileSync(path.join(home, reportName(currentSignal)), "{\\"late\\":true}\\n");
    }, 1200);
    return;
  }
  const heapPath = path.join(outputHome, heapName(currentSignal));
  const reportPath = path.join(outputHome, reportName(currentSignal));
  setTimeout(() => {
    fs.mkdirSync(outputHome, { recursive: true });
    fs.writeFileSync(heapPath, "{\\"heap\\":");
    if (currentSignal === 3) {
      return;
    }
    if (currentSignal === 2) {
      const oversized = path.join(home, "report.00-oversized.json");
      fs.writeFileSync(oversized, "{");
      fs.truncateSync(oversized, (16 * 1024 * 1024) + 1);
      for (let index = 0; index < 30; index += 1) {
        fs.writeFileSync(
          path.join(home, \`report.01-incomplete-\${String(index).padStart(2, "0")}.json\`),
          "{"
        );
      }
    }
    fs.writeFileSync(reportPath, "{");
    if (currentSignal === 1) {
      const excludedHome = path.join(outputHome, "depth-6");
      fs.mkdirSync(excludedHome, { recursive: true });
      fs.writeFileSync(path.join(excludedHome, "excluded.heapsnapshot"), "{\\"excluded\\":true}\\n");
      fs.writeFileSync(path.join(excludedHome, "report.excluded.json"), "{\\"excluded\\":true}\\n");
      fs.writeFileSync(
        path.join(home, "Heap.20260712.010101.999999.0.001.heapsnapshot"),
        "{\\"snapshot\\":{},\\"nodes\\":[]}\\n"
      );
      fs.writeFileSync(
        path.join(home, "report.20260712.010101.999999.0.001.json"),
        "{\\"header\\":{\\"processId\\":999999}}\\n"
      );
    }
  }, 400);
  setTimeout(() => {
    fs.appendFileSync(heapPath, "\\"fresh\\"}\\n");
    if (currentSignal !== 3) {
      fs.appendFileSync(reportPath, "\\"fresh\\":true}\\n");
    }
  }, 800);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForChildReady(child);
    // This case validates filtering and retention. Separate minimum-deadline
    // coverage below keeps loaded macOS CI from turning it into a timing test.
    const triggered = await triggerDiagnosticSession("kova-self-check", child.pid, 5000, root, {
      heapSnapshot: true,
      diagnosticReport: true
    });
    assertEqual(triggered.heapSnapshot.commandStatus, 0, "heap snapshot signal succeeds");
    assertEqual(triggered.diagnosticReport.commandStatus, 0, "diagnostic report signal succeeds");
    assertEqual(triggered.heapSnapshot.fileCount, 1, "only fresh heap snapshot retained");
    assertEqual(triggered.diagnosticReport.fileCount, 1, "only fresh diagnostic report retained");
    assertEqual(triggered.heapSnapshot.files[0].includes("depth-5"), true, "diagnostic scan includes files at depth six");
    assertEqual(triggered.diagnosticReport.files[0].includes("depth-5"), true, "report scan includes files at depth six");
    assertEqual(triggered.heapSnapshot.files.some((path) => path.includes("excluded")), false, "diagnostic scan prunes files below depth six");
    assertEqual(triggered.diagnosticReport.files.some((path) => path.includes("excluded")), false, "report scan prunes files below depth six");
    assertEqual(triggered.heapSnapshot.files.some((path) => path.endsWith("stale.heapsnapshot")), false, "stale heap snapshot excluded");
    assertEqual(triggered.heapSnapshot.files.some((path) => path.includes("999999")), false, "heap snapshot from another process excluded");
    assertEqual(triggered.diagnosticReport.files.some((path) => path.includes("999999")), false, "diagnostic report from another process excluded");
    const firstInvocationLog = (await readFile(invocationLog, "utf8")).trim();
    assertEqual(firstInvocationLog.split("\n").length, 1, "one OCM session triggers both artifacts");
    assertEqual(firstInvocationLog.includes("-maxdepth"), false, "diagnostic scan avoids GNU-only find depth flags");
    JSON.parse(await readFile(triggered.diagnosticReport.artifacts[0], "utf8"));
    await Promise.all(Array.from({ length: 60 }, (_, index) =>
      writeFile(join(openclawHome, `historical-${index}.heapsnapshot`), "{}\n")
    ));
    const reportOnly = await triggerDiagnosticSession("kova-self-check", child.pid, 3500, root, {
      diagnosticReport: true,
      commandEnv: { KOVA_FAKE_WRAPPER_ENV: "preserved" }
    });
    assertEqual(reportOnly.diagnosticReport.commandStatus, 0, "partial diagnostic report stabilizes");
    assertEqual(reportOnly.diagnosticReport.artifacts.length, 1, "valid report survives sibling stabilization failure");
    assertEqual(reportOnly.diagnosticReport.error.includes("did not stabilize"), true, "partial report failure retained");
    assertEqual(reportOnly.diagnosticReport.error.includes("exceeds"), true, "oversized report returns a structured validation error");
    const wrapperInvocation = (await readFile(invocationLog, "utf8")).trim().split("\n").at(-1);
    assertEqual(wrapperInvocation.endsWith("env=preserved"), true, "report wrapper preserves command environment");
    JSON.parse(await readFile(reportOnly.diagnosticReport.artifacts[0], "utf8"));
    const heapOnly = await triggerDiagnosticSession("kova-self-check", child.pid, 3000, root, {
      heapSnapshot: true,
      diagnosticReport: true,
      commandEnv: { KOVA_FAKE_OCM_DELAY: "0.6" }
    });
    assertEqual(heapOnly.heapSnapshot.commandStatus, 0, "partial trigger keeps successful command status");
    assertEqual(heapOnly.heapSnapshot.artifacts.length, 1, "emitted heap survives missing report");
    assertEqual(heapOnly.diagnosticReport.commandStatus, 0, "missing report does not rewrite command status");
    assertEqual(heapOnly.diagnosticReport.artifacts.length, 0, "missing report retains no artifact");
    assertEqual(heapOnly.diagnosticReport.error.includes("was not emitted"), true, "missing sibling is reported");
    const tooShort = await triggerDiagnosticSession("kova-self-check", child.pid, 1000, root, {
      heapSnapshot: true
    });
    assertEqual(tooShort.heapSnapshot.commandStatus, 1, "unsupported short timeout fails before OCM");
    assertEqual(tooShort.heapSnapshot.error.includes("at least 2500ms"), true, "minimum timeout is explicit");
    const invocationCount = (await readFile(invocationLog, "utf8")).trim().split("\n").length;
    const unrequested = await triggerDiagnosticSession("kova-self-check", child.pid, "3000", root);
    assertEqual(unrequested.heapSnapshot.requested, false, "empty session requests no heap snapshot");
    assertEqual(unrequested.diagnosticReport.requested, false, "empty session requests no diagnostic report");
    assertEqual(
      (await readFile(invocationLog, "utf8")).trim().split("\n").length,
      invocationCount,
      "empty session does not invoke OCM"
    );
    process.env.KOVA_FAKE_OCM_HANG = "1";
    const hungStartedAt = Date.now();
    const hung = await triggerDiagnosticSession("kova-self-check", child.pid, 2500, root, {
      heapSnapshot: true
    });
    const hungElapsedMs = Date.now() - hungStartedAt;
    restoreEnv({ KOVA_FAKE_OCM_HANG: previousOcmHang });
    assertEqual(hung.heapSnapshot.commandStatus, 124, "hung OCM command times out");
    assertEqual(hung.heapSnapshot.timedOut, true, "hung OCM timeout is retained");
    assertEqual(hungElapsedMs < 2500, true, "hung OCM command honors the diagnostic deadline");
    const delayedReport = await triggerDiagnosticSession("kova-self-check", child.pid, 2500, root, {
      diagnosticReport: true
    });
    assertEqual(delayedReport.diagnosticReport.artifacts.length, 1, "minimum timeout discovers a delayed report");
    assertEqual(
      delayedReport.diagnosticReport.files.some((path) => path.endsWith("0.004.json")),
      true,
      "unattributed report does not end diagnostic polling"
    );
    // The final write is delayed by 2.8s, then discovery and a full stability
    // interval still need time on loaded hosts. Deadline checks live above.
    const slowHeap = await triggerDiagnosticSession("kova-self-check", child.pid, 10000, root, {
      heapSnapshot: true
    });
    assertEqual(slowHeap.heapSnapshot.artifacts.length, 1, `slow-growing heap snapshot stabilizes (${slowHeap.heapSnapshot.error ?? "no error"})`);
    assertEqual(
      await readFile(slowHeap.heapSnapshot.artifacts[0], "utf8"),
      '{"heap":"head","tail":true}\n',
      "heap snapshot is copied only after the final write"
    );
    const fixedReport = await triggerDiagnosticSession("kova-self-check", child.pid, 3000, null, {
      diagnosticReport: true
    });
    assertEqual(fixedReport.diagnosticReport.fileCount, 1, "validated sources remain visible without artifact copying");
    assertEqual(fixedReport.diagnosticReport.artifacts.length, 0, "disabled artifact copying retains no copy");
    assertEqual(
      fixedReport.diagnosticReport.files[0].endsWith("diagnostic.fixed.json"),
      true,
      "rewritten fixed-path report differs from its baseline identity"
    );
    assertEqual(fixedReport.diagnosticReport.error, null, "rewritten fixed-path report succeeds");
    const lateBudgetReport = await triggerDiagnosticSession("kova-self-check", child.pid, 3000, root, {
      diagnosticReport: true
    });
    assertEqual(
      lateBudgetReport.diagnosticReport.files.some((path) => path.endsWith("0.007.json")),
      true,
      "final partial polling interval discovers a late report"
    );
    const failed = await triggerDiagnosticSession("kova-self-check", 99999999, 5000, root, {
      heapSnapshot: true,
      diagnosticReport: true
    });
    assertEqual(failed.heapSnapshot.commandStatus === 0, false, "failed signal retains nonzero status");
    assertEqual(failed.heapSnapshot.fileCount, 0, "failed signal retains no stale heap files");
    assertEqual(failed.diagnosticReport.fileCount, 0, "failed signal retains no stale report files");
    const invalid = await triggerDiagnosticSession("kova-self-check", 0, 1000, root, {
      heapSnapshot: true,
      diagnosticReport: true
    });
    assertEqual(invalid.heapSnapshot.commandStatus, 1, "invalid heap snapshot pid fails before OCM");
    assertEqual(invalid.heapSnapshot.error.includes("invalid diagnostic target pid"), true, "invalid pid error retained");
    return {
      id: "diagnostic-trigger-validation",
      status: "PASS",
      command: "capture fresh diagnostics through one trigger session",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostic-trigger-validation",
      status: "FAIL",
      command: "capture fresh diagnostics through one trigger session",
      durationMs: 0,
      message: error.message
    };
  } finally {
    child?.kill("SIGTERM");
    restoreEnv({
      PATH: previousPath,
      OPENCLAW_HOME: previousOpenClawHome,
      KOVA_FAKE_OCM_LOG: previousOcmLog,
      KOVA_FAKE_OCM_HANG: previousOcmHang
    });
  }
}

function waitForChildReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("diagnostic fixture process did not become ready")), 3000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`diagnostic fixture process exited early (${code ?? signal})`));
    });
    child.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
