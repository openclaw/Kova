// Renderer snapshot smoke tests.
//
// Locks the rendered output of each report-shaped surface so that future
// polish passes can't silently regress wrap, width, findings phrasing, or
// proves rendering. Each case shells out to `node bin/kova.mjs ...` with
// NO_COLOR=1 to capture deterministic output, normalizes machine-specific
// strings (home paths, repo paths), and diffs against a committed `.snap`
// file under tests/snapshots/.
//
// Run:
//   node tests/render-snapshots.mjs            # check; exits non-zero on diff
//   UPDATE_SNAPSHOTS=1 node tests/render-snapshots.mjs  # write/update snapshots

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const snapDir = join(here, "snapshots");
mkdirSync(snapDir, { recursive: true });

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const PASS_REPORT = "artifacts/phase9-deep-profile-run2/kova-2026-04-30T031128Z.json";
const FAIL_REPORT = "artifacts/phase9-timeline-proof/kova-2026-04-30T040505Z.json";

const cases = [
  { name: "report-pass-compact", args: ["report", PASS_REPORT] },
  { name: "report-pass-full", args: ["report", "--full", PASS_REPORT] },
  { name: "report-fail-compact", args: ["report", FAIL_REPORT] },
  { name: "report-fail-full", args: ["report", "--full", FAIL_REPORT] },
  { name: "compare-pass-vs-fail", args: ["report", "compare", PASS_REPORT, FAIL_REPORT] },
  { name: "compare-pass-vs-fail-full", args: ["report", "compare", "--full", PASS_REPORT, FAIL_REPORT] },
  { name: "plan-default", args: ["plan"] },
  { name: "help-default", args: ["help"] },
  // JSON contracts (agent-facing). Locks the machine-readable shape so
  // future renderer-only changes can't silently drift the JSON payload.
  { name: "report-fail-json", args: ["report", "--json", FAIL_REPORT] },
  { name: "report-pass-json", args: ["report", "--json", PASS_REPORT] },
  { name: "compare-json", args: ["report", "compare", "--json", PASS_REPORT, FAIL_REPORT] },
  { name: "plan-json", args: ["plan", "--json"] },
  // Dry-run receipts (run + matrix) and matrix plan. These exercise the
  // KPI strip, scenarios rollup, and artifact-pointer renderers — none of
  // which were previously pinned by snapshots.
  { name: "run-receipt-dry", args: ["run", "--target", "runtime:stable", "--scenario", "fresh-install"] },
  { name: "run-receipt-dry-json", args: ["run", "--target", "runtime:stable", "--scenario", "fresh-install", "--json"] },
  { name: "matrix-run-receipt-dry", args: ["matrix", "run", "--profile", "smoke", "--target", "runtime:stable"] },
  { name: "matrix-run-receipt-dry-json", args: ["matrix", "run", "--profile", "smoke", "--target", "runtime:stable", "--json"] },
  { name: "matrix-plan", args: ["matrix", "plan", "--profile", "smoke", "--target", "runtime:stable"] },
  { name: "matrix-plan-json", args: ["matrix", "plan", "--profile", "smoke", "--target", "runtime:stable", "--json"] },
];

function normalize(out) {
  // Make snapshots portable: scrub machine-specific paths and unstable times.
  const home = homedir();
  return out
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(home, "<home>")
    // ISO-like timestamps in the meta strip, e.g. "2026-05-17 02:23 UTC".
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\b/g, "<ts>")
    // generatedAt-style ISO timestamps in plan output.
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<iso>")
    // Run IDs: historical compact ISO ids and current short timestamp+entropy
    // ids. Each run mints a fresh runId, so pin it to a stable token.
    .replace(/kova-\d{4}-\d{2}-\d{2}T\d{6}Z/g, "kova-<runId>")
    .replace(/kova-\d{4}-\d{2}-\d{2}t\d{6}z/g, "kova-<runid>")
    .replace(/kova-\d{6}-\d{6}-[a-f0-9]{6}/g, "kova-<runId>")
    .replace(/kova-\d{6}-\d{6}-[a-f0-9]{6}/gi, (match) => match === match.toLowerCase() ? "kova-<runid>" : "kova-<runId>")
    // Strip trailing whitespace per line (renderer already does, defensive).
    .split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
}

function runCase(c) {
  // spawnSync semantics: tolerate non-zero exits (e.g., compare exits 1
  // on regressions — that's expected output).
  const r = spawnSync("node", ["bin/kova.mjs", ...c.args], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", COLUMNS: "80" },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return normalize(r.stdout || "");
}

function diff(expected, actual) {
  const eLines = expected.split("\n");
  const aLines = actual.split("\n");
  const max = Math.max(eLines.length, aLines.length);
  const lines = [];
  for (let i = 0; i < max; i += 1) {
    if (eLines[i] !== aLines[i]) {
      lines.push(`  line ${i + 1}:`);
      lines.push(`    - ${JSON.stringify(eLines[i] ?? "")}`);
      lines.push(`    + ${JSON.stringify(aLines[i] ?? "")}`);
      if (lines.length > 30) { lines.push("    ... (more diff truncated)"); break; }
    }
  }
  return lines.join("\n");
}

let pass = 0;
let fail = 0;
let wrote = 0;
const failures = [];

for (const c of cases) {
  const snapPath = join(snapDir, `${c.name}.snap`);
  let actual;
  try {
    actual = runCase(c);
  } catch (err) {
    failures.push({ name: c.name, reason: `command failed: ${err.message}` });
    fail += 1;
    continue;
  }

  if (UPDATE || !existsSync(snapPath)) {
    writeFileSync(snapPath, actual, "utf8");
    wrote += 1;
    console.log(`✓ WROTE  ${c.name}`);
    continue;
  }

  const expected = readFileSync(snapPath, "utf8");
  if (expected === actual) {
    pass += 1;
    console.log(`✓ PASS   ${c.name}`);
  } else {
    fail += 1;
    failures.push({ name: c.name, diff: diff(expected, actual) });
    console.log(`✗ FAIL   ${c.name}`);
  }
}

console.log("");
console.log(`summary: ${pass} pass, ${fail} fail, ${wrote} written (${cases.length} total)`);
if (failures.length > 0 && !UPDATE) {
  console.log("");
  for (const f of failures) {
    console.log(`--- ${f.name} ---`);
    if (f.reason) console.log(f.reason);
    if (f.diff) console.log(f.diff);
    console.log("");
  }
  console.log("Re-run with UPDATE_SNAPSHOTS=1 to refresh snapshots.");
  process.exit(1);
}
