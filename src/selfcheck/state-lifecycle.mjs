import { join } from "node:path";
import { quoteShell } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { executeStateLifecycleSteps } from "../run/state-lifecycle.mjs";
import { assertEqual, assertPathMissing } from "./harness.mjs";

export async function stateLifecycleCommandIndexesCheck(tmp) {
  const artifactDir = join(tmp, "state-lifecycle-command-indexes");
  try {
    const phase = await executeStateLifecycleSteps(
      {
        target: "runtime:stable",
        targetPlan: {
          kind: "runtime",
          value: "stable",
          startSelector: "stable",
          upgradeSelector: "stable"
        },
        state: { id: "multi-step-state" },
        timeoutMs: 30000,
        resourceSampleIntervalMs: 250,
        processRoles: []
      },
      "kova-self-check",
      {
        id: "state-lifecycle-index-check",
        surface: "fresh-install"
      },
      "prepare",
      [
        {
          commands: [
            "node --version",
            "node --version"
          ],
          evidence: [],
          collectionIntent: "skip-env"
        },
        {
          commands: ["node --version"],
          evidence: [],
          collectionIntent: "skip-env"
        }
      ],
      artifactDir
    );
    const artifactPaths = phase.results.map((result) => result.resourceSamples?.artifactPath);
    assertEqual(phase.results.length, 3, "state lifecycle result count");
    assertEqual(new Set(artifactPaths).size, 3, "state lifecycle command artifact paths are unique");
    assertEqual(artifactPaths[0]?.endsWith("prepare-1.jsonl"), true, "first lifecycle command index");
    assertEqual(artifactPaths[1]?.endsWith("prepare-2.jsonl"), true, "second lifecycle command index");
    assertEqual(artifactPaths[2]?.endsWith("prepare-3.jsonl"), true, "third lifecycle command index");
    return {
      id: "state-lifecycle-command-indexes",
      status: "PASS",
      command: "execute multi-step state lifecycle with phase-wide command indexes",
      durationMs: phase.results.reduce((total, result) => total + result.durationMs, 0)
    };
  } catch (error) {
    return {
      id: "state-lifecycle-command-indexes",
      status: "FAIL",
      command: "execute multi-step state lifecycle with phase-wide command indexes",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function stateLifecycleFailureShortCircuitCheck(tmp) {
  const artifactDir = join(tmp, "state-lifecycle-failure-short-circuit");
  const markerPath = join(artifactDir, "unexpected-preparer");
  try {
    const phase = await executeStateLifecycleSteps(
      {
        target: "runtime:stable",
        targetPlan: {
          kind: "runtime",
          value: "stable",
          startSelector: "stable",
          upgradeSelector: "stable"
        },
        state: { id: "failed-preflight-state" },
        timeoutMs: 30000,
        resourceSampleIntervalMs: 250,
        processRoles: []
      },
      "kova-self-check",
      {
        id: "state-lifecycle-failure-short-circuit-check",
        surface: "fresh-install"
      },
      "prepare",
      [
        {
          commands: [
            `node ${quoteShell(join(repoRoot, "support", "tui-smoke.mjs"))}`,
            `node ${quoteShell(join(repoRoot, "scripts", "large-session-fixture.mjs"))} prepare --root ${quoteShell(markerPath)} --shape valid`
          ],
          evidence: [],
          collectionIntent: "skip-env"
        }
      ],
      artifactDir
    );
    assertEqual(phase.commands.length, 2, "state lifecycle planned command count");
    assertEqual(phase.results.length, 1, "state lifecycle stops after failed preflight");
    assertEqual(phase.results[0]?.status, 2, "state lifecycle preserves failed preflight status");
    await assertPathMissing(markerPath, "state lifecycle skipped command marker");
    return {
      id: "state-lifecycle-failure-short-circuit",
      status: "PASS",
      command: "stop state lifecycle after a failed preflight",
      durationMs: phase.results[0]?.durationMs ?? 0
    };
  } catch (error) {
    return {
      id: "state-lifecycle-failure-short-circuit",
      status: "FAIL",
      command: "stop state lifecycle after a failed preflight",
      durationMs: 0,
      message: error.message
    };
  }
}
