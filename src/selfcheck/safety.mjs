import { assertSafeScenarioCommand, assertSingleTopLevelShellCommand } from "../safety.mjs";
import { assertEqual } from "./harness.mjs";

export function safetyGuardCheck() {
  try {
    assertSafeScenarioCommand("ocm start kova-safe-test --runtime stable --json", {}, "kova-safe-test");
    assertSafeScenarioCommand("ocm --version", {}, "kova-safe-test");
    assertSafeScenarioCommand("ocm env clone 'Team Env' kova-safe-test --json", { sourceEnv: "Team Env" }, "kova-safe-test");
    assertSafeScenarioCommand("node support/run-soak-loop.mjs --env kova-safe-test", {}, "kova-safe-test");
    assertSafeScenarioCommand(
      "node support/expect-command-fails.mjs -- ocm @kova-safe-test -- agent --local --message hi",
      {},
      "kova-safe-test"
    );
    assertSafeScenarioCommand(
      "rm -rf '/tmp/kova-self-check-artifacts/import'",
      {},
      "kova-safe-test",
      "/tmp/kova-self-check-artifacts"
    );
    assertSingleTopLevelShellCommand("ocm env exec kova-safe-test -- sh -lc 'printf \"a;b|c&&d\" >&2'");
    const blockedCases = [
      "ocm env destroy Violet --yes",
      "ocm upgrade Violet --channel beta --json",
      "ocm @Violet -- status",
      "ocm env clone 'Team Env' Violet --json"
    ];
    let blocked = 0;
    for (const command of blockedCases) {
      try {
        assertSafeScenarioCommand(command, { sourceEnv: "Team Env" }, "kova-safe-test");
      } catch (error) {
        if (/refusing to mutate non-Kova/.test(error.message)) {
          blocked += 1;
        }
      }
    }
    assertEqual(blocked, blockedCases.length, "durable env mutation cases blocked");
    let wrongSourceBlocked = false;
    try {
      assertSafeScenarioCommand("ocm env clone Other kova-safe-test --json", { sourceEnv: "Team Env" }, "kova-safe-test");
    } catch (error) {
      wrongSourceBlocked = /refusing to mutate non-Kova/.test(error.message);
    }
    assertEqual(wrongSourceBlocked, true, "unexpected source env clone blocked");
    const compoundCases = [
      "ocm logs kova-safe-test; ocm env destroy Violet --yes",
      "true && ocm env destroy Violet --yes",
      "true | ocm env destroy Violet --yes",
      "sleep 10 & ocm env destroy Violet --yes",
      "true\nocm env destroy Violet --yes"
    ];
    let compoundBlocked = 0;
    for (const command of compoundCases) {
      try {
        assertSafeScenarioCommand(command, {}, "kova-safe-test");
      } catch (error) {
        if (/refusing (?:compound )?scenario command/.test(error.message)) {
          compoundBlocked += 1;
        }
      }
    }
    assertEqual(compoundBlocked, compoundCases.length, "top-level compound commands blocked");
    const shellEvaluationCases = [
      "echo \"$(ocm env destroy Violet --yes)\"",
      "echo `ocm env destroy Violet --yes`",
      "cat <(ocm env destroy Violet --yes)",
      "sh -c 'ocm env destroy Violet --yes'",
      "env ocm env destroy Violet --yes",
      "KOVA_MODE=test ocm env destroy Violet --yes",
      "\"$OCM\" env destroy Violet --yes",
      "/usr/local/bin/ocm env destroy Violet --yes",
      "! ocm env destroy Violet --yes",
      "(ocm env destroy Violet --yes)",
      "> /tmp/kova-redirection ocm env destroy Violet --yes",
      "timeout 30 ocm env destroy Violet --yes",
      "node -e 'require(\"node:child_process\").execFileSync(\"ocm\", [\"env\", \"destroy\", \"Violet\", \"--yes\"])'",
      "node /tmp/support/run-soak-loop.mjs --env kova-safe-test",
      "node support/prepare-many-plugin-pressure-state.mjs --expected-count 80",
      "node support/run-openclaw-release-age-upgrade.mjs --env Violet --age day --json",
      "node support/run-openclaw-release-age-upgrade.mjs --env=Violet --age day --json",
      "node support/run-doctor-repair.mjs --env kova-safe-test --env Violet",
      "node support/expect-command-fails.mjs -- ocm env destroy Violet --yes",
      "node support/assert-command-output.mjs --contains done -- ocm logs Violet --tail 20 --raw",
      "ocm env des\\\ntroy Violet --yes",
      "ocm --json env destroy Violet --yes",
      "ocm e?? d?????? Violet --yes",
      "rm -rf \"/tmp/kova-self-check-artifacts/im\\port\""
    ];
    let shellEvaluationBlocked = 0;
    for (const command of shellEvaluationCases) {
      try {
        assertSafeScenarioCommand(command, {}, "kova-safe-test");
      } catch (error) {
        if (/^refusing /.test(error.message)) {
          shellEvaluationBlocked += 1;
        }
      }
    }
    assertEqual(shellEvaluationBlocked, shellEvaluationCases.length, "shell evaluation bypasses blocked");
    const artifactCleanupCases = [
      ["rm -rf relative/import", "relative"],
      ["rm -rf ~/kova-self-check-artifacts/import", "/tmp/kova-self-check-artifacts"]
    ];
    for (const [command, artifactDir] of artifactCleanupCases) {
      let blocked = false;
      try {
        assertSafeScenarioCommand(command, {}, "kova-safe-test", artifactDir);
      } catch (error) {
        blocked = /unapproved artifact cleanup/.test(error.message);
      }
      assertEqual(blocked, true, `unsafe artifact cleanup path blocked: ${command}`);
    }
    let obfuscatedMutationBlocked = false;
    try {
      assertSafeScenarioCommand("ocm e''nv des''troy Violet --yes", {}, "kova-safe-test");
    } catch (error) {
      obfuscatedMutationBlocked = /refusing to mutate non-Kova/.test(error.message);
    }
    assertEqual(obfuscatedMutationBlocked, true, "quoted OCM mutation words are canonicalized");
    return {
      id: "durable-env-mutation-guard",
      status: "PASS",
      command: "evaluate synthetic command guard cases",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "durable-env-mutation-guard",
      status: "FAIL",
      command: "evaluate synthetic command guard cases",
      durationMs: 0,
      message: error.message
    };
  }
}
