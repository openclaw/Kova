import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { safeParseRelease } from "../web-payload-contract.mjs";
import { assertEqual } from "./harness.mjs";

export async function webPayloadContractCheck(tmp) {
  const inputPath = join(tmp, "web-payload-input.json");
  const outDir = join(tmp, "web-payload-output");
  const payload = {
    ver: "2026.7.12-self-check",
    releaseDate: "2026-07-12",
    date: "2026-07-12",
    sha: "self-check",
    passed: true,
    runCount: 1,
    coldReadyDeltaPct: -12.5,
    scenarios: [{
      id: "release-runtime-startup",
      value: -1,
      unit: "ms",
      threshold: 1000.5,
      state: "pass",
      spark: [-2, 0, 2]
    }],
    runs: [{
      id: "self-check-run",
      runtime: "npm:2026.7.12",
      profile: "release",
      startedAt: "2026-07-12T01:02:03Z",
      durationMs: 0,
      entryCount: 0,
      state: "pass",
      scenarios: [{
        id: "release-runtime-startup",
        state: "pass",
        sampleCount: 0
      }],
      bundle: {
        name: "self-check.tar.gz",
        bytes: 0,
        href: "/bundles/self-check.tar.gz"
      }
    }]
  };

  assertEqual(safeParseRelease(payload).ok, true, "valid web payload");
  assertEqual(
    safeParseRelease({ ...payload, coldReadyDeltaPercent: payload.coldReadyDeltaPct }).ok,
    false,
    "unknown web payload field rejected"
  );
  assertEqual(
    safeParseRelease({
      ...payload,
      runs: [{ ...payload.runs[0], durationMs: -1 }]
    }).ok,
    false,
    "negative duration rejected"
  );
  assertEqual(
    safeParseRelease({
      ...payload,
      runs: [{ ...payload.runs[0], entryCount: 1.5 }]
    }).ok,
    false,
    "fractional count rejected"
  );
  assertEqual(
    safeParseRelease({
      ...payload,
      scenarios: [{ ...payload.scenarios[0], threshold: -1 }]
    }).ok,
    false,
    "negative threshold rejected"
  );
  assertEqual(
    safeParseRelease({ ...payload, releaseDate: null }).ok,
    false,
    "null release date rejected"
  );
  assertEqual(
    safeParseRelease({ ...payload, releaseDate: 0 }).ok,
    false,
    "numeric release date rejected"
  );
  assertEqual(
    safeParseRelease({ ...payload, releaseDate: "2026-02-30" }).ok,
    false,
    "invalid calendar release date rejected"
  );
  assertEqual(
    safeParseRelease({ ...payload, releaseDate: "0" }).ok,
    false,
    "numeric string release date rejected"
  );
  assertEqual(
    safeParseRelease({
      ...payload,
      runs: [{ ...payload.runs[0], startedAt: null }]
    }).ok,
    false,
    "null run date rejected"
  );

  await writeFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const result = await runCommand(
    `node bin/kova.mjs publish ${quoteShell(inputPath)} --out-dir ${quoteShell(outDir)} --no-augment --json`,
    { timeoutMs: 30000, maxOutputChars: 1000000 }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `publish exited ${result.status}`);
  }
  const receipt = JSON.parse(result.stdout);
  const published = JSON.parse(await readFile(join(outDir, `${payload.ver}.json`), "utf8"));
  assertEqual(receipt.releaseDate, "2026-07-12T00:00:00.000Z", "publish receipt uses canonical release date");
  assertEqual(published.releaseDate, "2026-07-12T00:00:00.000Z", "publish writes canonical release date");
  assertEqual(published.runs[0].startedAt, "2026-07-12T01:02:03.000Z", "publish writes canonical run date");
  return {
    id: "web-payload-contract",
    status: "PASS",
    command: "validate and publish canonical web payload",
    durationMs: result.durationMs
  };
}
