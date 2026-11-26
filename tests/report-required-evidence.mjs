import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { attachEvidenceLedger, applyEvidenceLedgerGating } from "../src/evidence-ledger.mjs";
import { summarizeRecords } from "../src/reporting/report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const recordStatus of ["PASS", "DRY-RUN", "SKIPPED"]) for (const required of [true, false]) {
  test(`report CLI preserves ${required ? "required" : "optional"} skipped evidence in ${recordStatus}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-report-evidence-"));
    try {
      const report = JSON.parse(readFileSync(new URL("fixtures/reports/pass.json", import.meta.url), "utf8"));
      const record = report.records[0];
      record.status = recordStatus;
      const missing = recordStatus === "PASS" && required;
      const completeness = recordStatus === "DRY-RUN" ? "not-evaluated" : missing ? "incomplete" : "complete";
      record.phases = [{ id: "proof", commands: ["inspect"], results: [{
        status: 0, evidenceStatus: "skipped", evidenceRequired: required
      }] }];
      record.finalMetrics = {
        error: null, service: { gatewayState: "running" },
        health: { ok: true, durationMs: 5 }, healthSamples: [{ ok: true, durationMs: 5 }],
        healthSummary: { count: 1, failureCount: 0 }
      };
      attachEvidenceLedger(record);
      applyEvidenceLedgerGating(record);
      report.records = [record];
      report.summary = summarizeRecords(report.records);
      const path = join(dir, "report.json");
      writeFileSync(path, JSON.stringify(report));
      const run = (args) => {
        const result = spawnSync(process.execPath, ["bin/kova.mjs", "report", ...args], {
          cwd: root, encoding: "utf8", timeout: 30000,
          env: { ...process.env, KOVA_HOME: dir, NO_COLOR: "1" }
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const summary = JSON.parse(run([path, "--json"]));
      assert.equal(summary.decision.verdict, missing ? "INCOMPLETE" : recordStatus === "PASS" ? "PASS" : recordStatus);
      assert.equal(summary.decision.ok, !missing && recordStatus !== "SKIPPED");
      assert.equal(summary.decision.blockingFindingCount, missing ? 1 : 0);
      assert.equal(summary.proof.requiredMissing, missing ? 1 : 0);
      assert.equal(summary.proof.completeness[completeness], 1);
      assert.equal(summary.proof.missingRequired.length, missing ? 1 : 0);
      if (missing) assert.equal(summary.proof.missingRequired[0].status, "skipped");
      const plain = run(["summarize", path, "--plain"]);
      assert.match(plain, new RegExp(`Proof: ${completeness}=1; required \\d+, missing ${missing ? 1 : 0}`));
      assert.match(plain, new RegExp(`- ${missing ? "INCOMPLETE" : recordStatus}: 1`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
