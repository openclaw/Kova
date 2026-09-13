import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { copyCollectorArtifacts } from "../collectors/artifacts.mjs";
import { collectStateFixtureAccounting } from "../collectors/state-fixtures.mjs";
import { assertEqual, sleep } from "./harness.mjs";

export async function stateFixtureCollectorFailureCheck(tmp) {
  const artifactDir = join(tmp, "state-fixture-collector");
  try {
    await mkdir(artifactDir, { recursive: true });
    const invalidJsonPath = join(artifactDir, "invalid.json");
    await writeFile(invalidJsonPath, "{invalid-json}\n");
    const artifactOnlyDir = join(artifactDir, "artifact-only-output");
    await mkdir(artifactOnlyDir, { recursive: true });
    await writeFile(join(artifactOnlyDir, "artifact-only.json"), "{}\n");
    const accounting = await collectStateFixtureAccounting({
      id: "collector-failure-self-check",
      fixtureAccounting: {
        kind: "session-store",
        files: [
          {
            id: "unresolved-home",
            path: "{openclawHome}/sessions.json",
            expectedShape: "openclaw-session-store"
          },
          {
            id: "invalid-json",
            path: "{artifactDir}/invalid.json",
            expectedShape: "openclaw-session-store"
          }
        ]
      }
    }, "kova-self-check", artifactDir, {
      resolveEnvInfo: async () => ({
        error: "service-status-failed",
        status: 17
      })
    });
    assertEqual(accounting.envResolution.status, "error", "OCM resolution failure retained");
    assertEqual(accounting.envResolution.commandStatus, 17, "OCM resolution status retained");
    assertEqual(accounting.files[0]?.shape?.kind, "environment-unavailable", "OCM failure is not a missing fixture");
    assertEqual(accounting.files[1]?.shape?.kind, "invalid-json", "malformed fixture remains distinct");
    assertEqual(accounting.findings.some((finding) => finding.kind === "harness"), true, "OCM failure creates harness finding");
    assertEqual(
      accounting.findings.some((finding) => finding.fileId === "unresolved-home" && finding.message.includes("missing")),
      false,
      "OCM failure creates no missing-fixture warning"
    );
    assertEqual((await stat(accounting.artifactPath)).isFile(), true, "malformed fixture accounting artifact retained");
    const nullResolution = await collectStateFixtureAccounting({
      id: "null-resolution-self-check",
      fixtureAccounting: {
        files: [{
          id: "unresolved-home",
          path: "{openclawHome}/sessions.json",
          expectedShape: "openclaw-session-store"
        }]
      }
    }, "kova-self-check", join(artifactDir, "null-resolution"), {
      resolveEnvInfo: async () => null
    });
    assertEqual(nullResolution.envResolution.status, "error", "null OCM resolution is harness failure");
    assertEqual(nullResolution.status, "error", "null OCM resolution fails accounting");
    let artifactOnlyResolutionCalls = 0;
    const artifactOnly = await collectStateFixtureAccounting({
      id: "artifact-only-self-check",
      fixtureAccounting: {
        files: [{
          id: "artifact-only",
          path: "{artifactDir}/artifact-only.json",
          expectedShape: "openclaw-session-store"
        }]
      }
    }, "kova-self-check", artifactOnlyDir, {
      resolveEnvInfo: async () => {
        artifactOnlyResolutionCalls += 1;
        return { error: "service-status-failed", status: 17 };
      }
    });
    assertEqual(artifactOnlyResolutionCalls, 0, "artifact-only accounting skips OCM resolution");
    assertEqual(artifactOnly.envResolution.status, "not-required", "artifact-only accounting records no environment dependency");
    assertEqual(artifactOnly.status, "ok", "unrelated OCM availability cannot fail artifact-only accounting");
    assertEqual(artifactOnly.files[0]?.exists, true, "artifact-only fixture remains inspectable");
    const unresolvedPath = await collectStateFixtureAccounting({
      id: "unresolved-path-self-check",
      fixtureAccounting: {
        files: [{
          id: "unresolved-path",
          path: "",
          expectedShape: "openclaw-session-store"
        }]
      }
    }, "kova-self-check", join(artifactDir, "unresolved-path"), {
      resolveEnvInfo: async () => ({ runDir: artifactDir })
    });
    assertEqual(unresolvedPath.files[0]?.shape?.kind, "unresolved-path", "invalid fixture path remains distinct");
    assertEqual(
      unresolvedPath.findings.some((finding) => finding.fileId === "unresolved-path" && finding.kind === "harness"),
      true,
      "unresolved fixture path creates harness finding"
    );
    return {
      id: "state-fixture-collector-failures",
      status: "PASS",
      command: "classify OCM and malformed fixture failures",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "state-fixture-collector-failures",
      status: "FAIL",
      command: "classify OCM and malformed fixture failures",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function collectorArtifactCollisionCheck(tmp) {
  const root = join(tmp, "collector-artifact-collision");
  const left = join(root, "left", "report.json");
  const right = join(root, "right", "report.json");
  const output = join(root, "retained");
  try {
    await mkdir(join(root, "left"), { recursive: true });
    await mkdir(join(root, "right"), { recursive: true });
    await writeFile(left, "left");
    await writeFile(right, "right-side");
    const copied = await copyCollectorArtifacts([left, right], output);
    assertEqual(copied.artifacts.length, 2, "same-basename artifacts retained separately");
    assertEqual(new Set(copied.artifacts).size, 2, "retained artifact paths are unique");
    const contents = await Promise.all(copied.artifacts.map((path) => readFile(path, "utf8")));
    assertEqual(contents.toSorted().join(","), "left,right-side", "same-basename artifact contents survive");
    assertEqual(copied.artifactBytes, 14, "retained artifact bytes reflect unique targets");
    assertEqual((await stat(copied.artifacts[0])).mode & 0o777, 0o600, "retained artifacts use private permissions");
    const longName = `${"x".repeat(250)}.json`;
    const longSource = join(root, "long", longName);
    await mkdir(join(root, "long"), { recursive: true });
    await writeFile(longSource, "long-name");
    const longCopied = await copyCollectorArtifacts([longSource], output);
    assertEqual(longCopied.artifacts.length, 1, "maximum-length source basename is retained");
    assertEqual(
      Buffer.byteLength(basename(longCopied.artifacts[0])) <= 255,
      true,
      "retained basename respects filesystem byte limit"
    );
    assertEqual(await readFile(longCopied.artifacts[0], "utf8"), "long-name", "maximum-length artifact content survives");
    const utf8Name = `${"\u{1f642}".repeat(62)}.json`;
    const utf8Source = join(root, "long", utf8Name);
    await writeFile(utf8Source, "utf8-name");
    const utf8Copied = await copyCollectorArtifacts([utf8Source], output);
    assertEqual(
      Buffer.byteLength(basename(utf8Copied.artifacts[0])) <= 255,
      true,
      "retained UTF-8 basename respects filesystem byte limit"
    );
    assertEqual(basename(utf8Copied.artifacts[0]).includes("\u{fffd}"), false, "retained basename preserves UTF-8 boundaries");
    const expiredOutput = join(root, "expired");
    let deadlineError = null;
    try {
      await copyCollectorArtifacts([left], expiredOutput, {
        deadlineEpochMs: Date.now() + 10,
        beforeCopy: () => sleep(25)
      });
    } catch (error) {
      deadlineError = error;
    }
    assertEqual(deadlineError?.message.includes("exceeded deadline"), true, "artifact copy honors its deadline");
    assertEqual((await readdir(expiredOutput)).length, 0, "expired artifact copy leaves no partial target");
    const preservedOutput = join(root, "preserved");
    const preserved = await copyCollectorArtifacts([left], preservedOutput);
    await rm(left);
    await mkdir(left);
    let refreshError = null;
    try {
      await copyCollectorArtifacts([left], preservedOutput, {
        deadlineEpochMs: Date.now() + 1000
      });
    } catch (error) {
      refreshError = error;
    }
    assertEqual(refreshError === null, false, "failed artifact refresh reports its source error");
    assertEqual(await readFile(preserved.artifacts[0], "utf8"), "left", "failed refresh preserves retained evidence");
    assertEqual((await readdir(preservedOutput)).length, 1, "failed refresh removes only its temporary artifact");
    return {
      id: "collector-artifact-collision",
      status: "PASS",
      command: "retain same-basename collector artifacts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "collector-artifact-collision",
      status: "FAIL",
      command: "retain same-basename collector artifacts",
      durationMs: 0,
      message: error.message
    };
  }
}
