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

import { strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { platformCoverageKeys, platformInfo } from "../src/platform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const snapDir = join(here, "snapshots");
mkdirSync(snapDir, { recursive: true });

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
const SNAPSHOT_KOVA_HOME = mkdtempSync(join(tmpdir(), "kova-snapshots-"));
const SNAPSHOT_WIDTH = 80;

const PASS_REPORT = "tests/fixtures/reports/pass.json";
const FAIL_REPORT = "tests/fixtures/reports/fail.json";
const REPORT_PLATFORM = JSON.parse(
  readFileSync(join(repoRoot, PASS_REPORT), "utf8")
).platform;
const RELEASE_PLATFORM_COVERAGE = JSON.parse(
  readFileSync(join(repoRoot, "profiles/release.json"), "utf8")
).gate.coverage.platforms;
const HOST_PLATFORM = platformInfo();
const HOST_PLATFORM_KEYS = [...platformCoverageKeys(HOST_PLATFORM)].sort();
const RELEASE_PLATFORM_REQUIREMENTS = [
  ...RELEASE_PLATFORM_COVERAGE.blocking,
  ...RELEASE_PLATFORM_COVERAGE.warning
].sort();
const HOST_PLATFORM_GAPS = RELEASE_PLATFORM_REQUIREMENTS.filter(
  (platformKey) => !HOST_PLATFORM_KEYS.includes(platformKey)
);
const HOST_PLATFORM_REPLACEMENTS = new Map([
  [HOST_PLATFORM.arch, "<arch>"],
  [HOST_PLATFORM.os, "<os>"],
  [`${HOST_PLATFORM.os}-${HOST_PLATFORM.arch}`, "<os-arch>"],
  ...(HOST_PLATFORM_KEYS.includes("wsl2") ? [["wsl2", "<wsl2>"]] : [])
]);
// Raw platform keys sort differently by OS; snapshots use one semantic order.
const PLATFORM_PLACEHOLDER_ORDER = ["<arch>", "<os>", "<os-arch>", "<wsl2>"];
const HOST_PLATFORM_PLACEHOLDERS = canonicalPlatformPlaceholders(
  HOST_PLATFORM_KEYS,
  HOST_PLATFORM_REPLACEMENTS
);

const cases = [
  { name: "report-pass-compact", args: ["report", PASS_REPORT] },
  { name: "report-pass-full", args: ["report", "--full", PASS_REPORT] },
  { name: "report-fail-compact", args: ["report", FAIL_REPORT] },
  { name: "report-fail-full", args: ["report", "--full", FAIL_REPORT] },
  { name: "compare-pass-vs-fail", args: ["report", "compare", PASS_REPORT, FAIL_REPORT], allowNonZero: true },
  { name: "compare-pass-vs-fail-full", args: ["report", "compare", "--full", PASS_REPORT, FAIL_REPORT], allowNonZero: true },
  { name: "plan-default", args: ["plan"], normalizePlanPlatform: true },
  { name: "help-default", args: ["help"] },
  // JSON contracts (agent-facing). Locks the machine-readable shape so
  // future renderer-only changes can't silently drift the JSON payload.
  { name: "report-fail-json", args: ["report", "--json", FAIL_REPORT], normalizeReportPlatform: REPORT_PLATFORM },
  { name: "report-pass-json", args: ["report", "--json", PASS_REPORT], normalizeReportPlatform: REPORT_PLATFORM },
  { name: "compare-json", args: ["report", "compare", "--json", PASS_REPORT, FAIL_REPORT], allowNonZero: true },
  { name: "plan-json", args: ["plan", "--json"], normalizeHostPlatform: true },
  // Dry-run receipts (run + matrix) and matrix plan. These exercise the
  // KPI strip, scenarios rollup, and artifact-pointer renderers — none of
  // which were previously pinned by snapshots.
  { name: "run-receipt-dry", args: ["run", "--target", "runtime:stable", "--scenario", "fresh-install"] },
  { name: "run-receipt-dry-json", args: ["run", "--target", "runtime:stable", "--scenario", "fresh-install", "--json"] },
  { name: "matrix-run-receipt-dry", args: ["matrix", "run", "--profile", "smoke", "--target", "runtime:stable"] },
  { name: "matrix-run-receipt-dry-json", args: ["matrix", "run", "--profile", "smoke", "--target", "runtime:stable", "--json"] },
  { name: "matrix-plan", args: ["matrix", "plan", "--profile", "smoke", "--target", "runtime:stable"] },
  { name: "matrix-plan-json", args: ["matrix", "plan", "--profile", "smoke", "--target", "runtime:stable", "--json"], normalizeHostPlatform: true },
  // Publish dry-run receipt. Pins the kova.web-payload.v1 contract output
  // so changes to the projector / contract version are caught immediately.
  { name: "publish-dry-existing", args: ["publish", "web/src/content/releases/2026.5.26.json", "--dry-run"] },
  { name: "publish-dry-existing-json", args: ["publish", "web/src/content/releases/2026.5.26.json", "--dry-run", "--json"] },
  { name: "publish-dry-internal-report", args: ["publish", PASS_REPORT, "--ver", "2026.4.30-internal", "--release-date", "2026-04-30", "--sha", "local-build", "--dry-run", "--json"] },
];

function normalize(out, snapshotCase) {
  // Make snapshots portable: scrub machine-specific paths and unstable times.
  const home = homedir();
  let structured = snapshotCase.normalizeHostPlatform || snapshotCase.normalizeReportPlatform
    ? normalizeJsonPlatform(out, snapshotCase)
    : out;
  if (snapshotCase.normalizePlanPlatform) {
    structured = normalizePlanPlatformLine(structured);
  }
  const normalized = structured
    .replaceAll(SNAPSHOT_KOVA_HOME, "<kova-home>")
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(home, "<home>")
    .replaceAll(HOST_PLATFORM.release, "<os-release>")
    .replaceAll(process.version, "<node>")
    .replace(/("node"\s*:\s*")v\d+\.\d+\.\d+(")/g, "$1<node>$2")
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
  return normalized;
}

function normalizeJsonPlatform(out, snapshotCase) {
  if (snapshotCase.normalizeHostPlatform) {
    return replacePlatformGaps(
      replaceCurrentPlatformKeys(
        replaceExactPlatformBlock(out, HOST_PLATFORM, {
          os: "<os>",
          arch: "<arch>",
          release: "<os-release>",
          node: "<node>"
        })
      )
    );
  }
  return replaceExactPlatformBlock(out, snapshotCase.normalizeReportPlatform, {
    ...snapshotCase.normalizeReportPlatform,
    release: "<os-release>"
  });
}

function replaceExactPlatformBlock(out, expected, replacement) {
  const expectedBlock = platformBlock(expected);
  if (!out.includes(expectedBlock)) {
    return out;
  }
  return out.replace(expectedBlock, platformBlock(replacement));
}

function platformBlock(platform) {
  const entries = Object.entries(platform);
  return [
    '  "platform": {',
    ...entries.map(([key, value], index) =>
      `    ${JSON.stringify(key)}: ${JSON.stringify(value)}${index === entries.length - 1 ? "" : ","}`
    ),
    "  },"
  ].join("\n");
}

function replaceCurrentPlatformKeys(out) {
  return replaceExactCurrentPlatformKeys(
    out,
    HOST_PLATFORM_KEYS,
    HOST_PLATFORM_REPLACEMENTS
  );
}

function replaceExactCurrentPlatformKeys(out, expectedKeys, replacements) {
  const expectedItems = expectedKeys.map((platformKey, index) =>
    `\\1  ${escapeRegExp(JSON.stringify(platformKey))}${index === expectedKeys.length - 1 ? "" : ","}`
  ).join("\\n");
  const exactBlock = new RegExp(
    `^(\\s*)"currentPlatformKeys": \\[\\n${expectedItems}\\n\\1\\]`,
    "gm"
  );
  const placeholders = canonicalPlatformPlaceholders(expectedKeys, replacements);
  return out.replace(exactBlock, (_, indent) => [
    `${indent}"currentPlatformKeys": [`,
    ...placeholders.map((platformKey, index) =>
      `${indent}  ${JSON.stringify(platformKey)}${index === placeholders.length - 1 ? "" : ","}`
    ),
    `${indent}]`
  ].join("\n"));
}

function canonicalPlatformPlaceholders(expectedKeys, replacements) {
  return expectedKeys
    .map((platformKey) => replacements.get(platformKey))
    .sort((left, right) =>
      PLATFORM_PLACEHOLDER_ORDER.indexOf(left) - PLATFORM_PLACEHOLDER_ORDER.indexOf(right)
    );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePlatformGaps(out) {
  return out.replace(
    platformGapBlock(HOST_PLATFORM_GAPS),
    platformGapBlock(["<platform-gaps-for-current-host>"])
  );
}

function platformGapBlock(platforms) {
  return [
    '        "gaps": {',
    '          "surfaces": [],',
    '          "scenarios": [],',
    '          "states": [],',
    '          "traits": [],',
    '          "platforms": [',
    ...platforms.map((platformKey, index) =>
      `            ${JSON.stringify(platformKey)}${index === platforms.length - 1 ? "" : ","}`
    ),
    "          ],"
  ].join("\n");
}

function normalizePlanPlatformLine(out) {
  const hostMeta =
    `${HOST_PLATFORM.os} ${HOST_PLATFORM.release} · ${HOST_PLATFORM.arch} · ${HOST_PLATFORM.node}`;
  const canonicalMeta = "<os> <os-release> · <arch> · <node>";
  return out
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s+\d+ scenarios · \d+ surfaces)/);
      if (!match || line !== alignedPlanLine(match[1], hostMeta)) {
        return line;
      }
      return alignedPlanLine(match[1], canonicalMeta);
    })
    .join("\n");
}

function alignedPlanLine(headline, meta) {
  const padding = " ".repeat(Math.max(2, SNAPSHOT_WIDTH - headline.length - meta.length));
  return `${headline}${padding}${meta}`;
}

function assertSnapshotNormalizers() {
  const hostJson = [
    "{",
    platformBlock(HOST_PLATFORM),
    '  "coverage": {',
    '    "currentPlatformKeys": [',
    ...HOST_PLATFORM_KEYS.map((platformKey, index) =>
      `      ${JSON.stringify(platformKey)}${index === HOST_PLATFORM_KEYS.length - 1 ? "" : ","}`
    ),
    "    ]",
    "  }",
    "}"
  ].join("\n");
  const normalizedHostJson = normalizeJsonPlatform(hostJson, { normalizeHostPlatform: true });
  strictEqual(normalizedHostJson.includes('"os": "<os>"'), true);
  strictEqual(normalizedHostJson.includes('"release": "<os-release>"'), true);
  strictEqual(
    normalizedHostJson.includes([
      '"currentPlatformKeys": [',
      ...HOST_PLATFORM_PLACEHOLDERS.map((platformKey, index) =>
        `      ${JSON.stringify(platformKey)}${index === HOST_PLATFORM_PLACEHOLDERS.length - 1 ? "" : ","}`
      ),
      "    ]"
    ].join("\n")),
    true
  );

  const malformedJson = hostJson.replace(
    `    "os": ${JSON.stringify(HOST_PLATFORM.os)},`,
    `    "os": "unexpected",\n    "os": ${JSON.stringify(HOST_PLATFORM.os)},`
  );
  strictEqual(
    normalizeJsonPlatform(malformedJson, { normalizeHostPlatform: true }).includes('"os": "<os>"'),
    false
  );

  const extraKeyJson = hostJson.replace(
    `${JSON.stringify(HOST_PLATFORM_KEYS.at(-1))}\n    ]`,
    `${JSON.stringify(HOST_PLATFORM_KEYS.at(-1))},\n      "unexpected"\n    ]`
  );
  strictEqual(
    normalizeJsonPlatform(extraKeyJson, { normalizeHostPlatform: true })
      .includes(`"currentPlatformKeys": [\n      ${JSON.stringify(HOST_PLATFORM_KEYS[0])}`),
    true
  );
  const firstKeySuffix = HOST_PLATFORM_KEYS.length === 1 ? "" : ",";
  const wrongKeyJson = hostJson.replace(
    `      ${JSON.stringify(HOST_PLATFORM_KEYS[0])}${firstKeySuffix}`,
    `      "unexpected"${firstKeySuffix}`
  );
  const normalizedWrongKeyJson = normalizeJsonPlatform(
    wrongKeyJson,
    { normalizeHostPlatform: true }
  );
  strictEqual(
    normalizedWrongKeyJson.includes([
      '"currentPlatformKeys": [',
      `      "unexpected"${firstKeySuffix}`,
      ...HOST_PLATFORM_KEYS.slice(1).map((platformKey, index) =>
        `      ${JSON.stringify(platformKey)}${index === HOST_PLATFORM_KEYS.length - 2 ? "" : ","}`
      ),
      "    ]"
    ].join("\n")),
    true
  );

  const darwinKeys = ["arm64", "darwin", "darwin-arm64"];
  const linuxKeys = ["linux", "linux-x64", "x64"];
  const canonicalKeysBlock = [
    '    "currentPlatformKeys": [',
    '      "<arch>",',
    '      "<os>",',
    '      "<os-arch>"',
    "    ]"
  ].join("\n");
  strictEqual(
    replaceExactCurrentPlatformKeys(
      currentPlatformKeysBlock(darwinKeys),
      darwinKeys,
      new Map([
        ["arm64", "<arch>"],
        ["darwin", "<os>"],
        ["darwin-arm64", "<os-arch>"]
      ])
    ),
    canonicalKeysBlock
  );
  strictEqual(
    replaceExactCurrentPlatformKeys(
      currentPlatformKeysBlock(linuxKeys),
      linuxKeys,
      new Map([
        ["linux", "<os>"],
        ["linux-x64", "<os-arch>"],
        ["x64", "<arch>"]
      ])
    ),
    canonicalKeysBlock
  );

  const platformGaps = platformGapBlock(HOST_PLATFORM_GAPS);
  strictEqual(
    normalizeJsonPlatform(platformGaps, { normalizeHostPlatform: true })
      .includes('"<platform-gaps-for-current-host>"'),
    true
  );
  strictEqual(
    normalizeJsonPlatform(
      platformGaps.replace("          ],", '            "unexpected"\n          ],'),
      { normalizeHostPlatform: true }
    ).includes('"<platform-gaps-for-current-host>"'),
    false
  );

  const fixtureJson = `{\n${platformBlock(REPORT_PLATFORM)}\n}`;
  strictEqual(
    normalizeJsonPlatform(fixtureJson, { normalizeReportPlatform: REPORT_PLATFORM })
      .includes('"release": "<os-release>"'),
    true
  );

  const headline = "   61 scenarios · 41 surfaces";
  const hostMeta =
    `${HOST_PLATFORM.os} ${HOST_PLATFORM.release} · ${HOST_PLATFORM.arch} · ${HOST_PLATFORM.node}`;
  const line = normalizePlanPlatformLine(alignedPlanLine(headline, hostMeta));
  strictEqual(line.length, SNAPSHOT_WIDTH);
  strictEqual(line.endsWith("<os> <os-release> · <arch> · <node>"), true);
  strictEqual(
    normalizePlanPlatformLine(`${headline}  unexpected ${hostMeta}`),
    `${headline}  unexpected ${hostMeta}`
  );
}

function currentPlatformKeysBlock(platformKeys) {
  return [
    '    "currentPlatformKeys": [',
    ...platformKeys.map((platformKey, index) =>
      `      ${JSON.stringify(platformKey)}${index === platformKeys.length - 1 ? "" : ","}`
    ),
    "    ]"
  ].join("\n");
}

function runCase(c) {
  // spawnSync semantics: tolerate non-zero exits (e.g., compare exits 1
  // on regressions — that's expected output).
  const r = spawnSync("node", ["bin/kova.mjs", ...c.args], {
    cwd: repoRoot,
    env: { ...process.env, KOVA_HOME: SNAPSHOT_KOVA_HOME, NO_COLOR: "1", FORCE_COLOR: "0", COLUMNS: "80" },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && c.allowNonZero !== true) {
    const output = [r.stderr, r.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`exit ${r.status}${output ? `: ${output}` : ""}`);
  }
  return normalize(r.stdout || "", c);
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

assertSnapshotNormalizers();

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
