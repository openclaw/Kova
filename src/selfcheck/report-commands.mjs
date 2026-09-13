import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { syntheticPerformanceRecord, syntheticPerformanceReport } from "./fixtures.mjs";
import { assertEqual, assertString, jsonCommandCheck } from "./harness.mjs";

export async function reportCompareExitStatusCheck(tmp) {
  const modes = [
    { name: "dashboard", flag: "" },
    { name: "plain", flag: "--plain" },
    { name: "fixer", flag: "--fixer" },
    { name: "json", flag: "--json" }
  ];
  let durationMs = 0;
  try {
    const fixtureDir = join(tmp, "report-compare-exit-status");
    const baselinePath = join(fixtureDir, "baseline.json");
    const currentPath = join(fixtureDir, "current.json");
    const platform = {
      os: process.platform,
      arch: process.arch,
      release: "self-check",
      node: process.version
    };
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      baselinePath,
      `${JSON.stringify(syntheticPerformanceReport({
        runId: "report-compare-exit-baseline",
        platform,
        target: "runtime:stable",
        records: [syntheticPerformanceRecord(1, { peakRssMb: 400 })]
      }), null, 2)}\n`
    );
    await writeFile(
      currentPath,
      `${JSON.stringify(syntheticPerformanceReport({
        runId: "report-compare-exit-current",
        platform,
        target: "runtime:stable",
        records: [syntheticPerformanceRecord(1, { peakRssMb: 900 })]
      }), null, 2)}\n`
    );
    for (const mode of modes) {
      const command = [
        "node bin/kova.mjs report compare",
        quoteShell(baselinePath),
        quoteShell(currentPath),
        mode.flag
      ].filter(Boolean).join(" ");
      const result = await runCommand(command, {
        timeoutMs: 30000,
        maxOutputChars: 1000000
      });
      durationMs += result.durationMs;
      assertEqual(result.status, 1, `${mode.name} failed comparison exit`);
      if (mode.name === "json") {
        assertEqual(JSON.parse(result.stdout).ok, false, "JSON failed comparison body");
      } else {
        assertEqual(result.stdout.trim().length > 0, true, `${mode.name} failed comparison body`);
      }
    }
    return {
      id: "report-compare-exit-status",
      status: "PASS",
      command: "verify failed comparison exits across render formats",
      durationMs
    };
  } catch (error) {
    return {
      id: "report-compare-exit-status",
      status: "FAIL",
      command: "verify failed comparison exits across render formats",
      durationMs,
      message: error.message
    };
  }
}

export async function reportRunIdReferenceCheck(tmp) {
  const home = join(tmp, "report-run-id-home");
  const prefix = `KOVA_HOME=${quoteShell(home)}`;
  try {
    const run = await jsonCommandCheck(
      "report-run-id-source",
      `${prefix} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "run receipt schema");
        assertString(data.runId, "run id");
      }
    );
    if (run.status !== "PASS") {
      return {
        ...run,
        id: "report-run-id-reference"
      };
    }
    const runId = run.data.runId;
    const report = await jsonCommandCheck(
      "report-run-id-render",
      `${prefix} node bin/kova.mjs report ${quoteShell(runId)} --json`,
      (data) => {
        assertEqual(data.runId, runId, "report run id");
      }
    );
    if (report.status !== "PASS") {
      return { ...report, id: "report-run-id-reference" };
    }
    const compare = await jsonCommandCheck(
      "report-run-id-compare",
      `${prefix} node bin/kova.mjs report compare ${quoteShell(runId)} ${quoteShell(runId)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.compare.v1", "compare schema");
        assertEqual(data.ok, true, "same run id compare ok");
      }
    );
    if (compare.status !== "PASS") {
      return { ...compare, id: "report-run-id-reference" };
    }
    const list = await jsonCommandCheck(
      "reports-list-json",
      `${prefix} node bin/kova.mjs reports --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.reports.v1", "reports schema");
        assertEqual(data.reports.some((item) => item.runId === runId), true, "run id listed");
      }
    );
    return {
      id: "report-run-id-reference",
      status: list.status,
      command: "run, list, render, and compare by runId",
      durationMs: run.durationMs + report.durationMs + compare.durationMs + list.durationMs,
      message: list.message
    };
  } catch (error) {
    return {
      id: "report-run-id-reference",
      status: "FAIL",
      command: "run, list, render, and compare by runId",
      durationMs: 0,
      message: error.message
    };
  }
}
