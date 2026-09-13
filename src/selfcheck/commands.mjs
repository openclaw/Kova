import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundedLogSnippet, collectLogMetrics } from "../collectors/logs.mjs";
import { createBoundedOutputAccumulator, quoteShell, runCommand } from "../commands.mjs";
import { assertEqual, sleep } from "./harness.mjs";

export async function commandTimeoutContractCheck(tmp) {
  const command = "node -e 'setTimeout(() => console.log(\"default-timeout-ok\"), 20)'";
  try {
    const result = await runCommand(command, { maxOutputChars: 100000 });
    assertEqual(result.status, 0, "default timeout command status");
    assertEqual(result.timedOut, false, "default timeout should not expire immediately");
    assertEqual(result.stdout.trim(), "default-timeout-ok", "default timeout command output");
    let invalidRejected = false;
    try {
      await runCommand("node -e 'process.exit(0)'", { timeoutMs: 0 });
    } catch (error) {
      invalidRejected = /timeoutMs must be a positive integer/.test(error.message);
    }
    assertEqual(invalidRejected, true, "invalid timeout rejected");
    if (process.platform !== "win32") {
      const pidPath = join(tmp, "timed-out-command.pid");
      const stubbornTree = [
        "trap '' TERM",
        "sleep 30 & child=$!",
        `printf '%s %s' "$$" "$child" > ${quoteShell(pidPath)}`,
        "wait"
      ].join("; ");
      const timedOut = await runCommand(stubbornTree, {
        timeoutMs: 500,
        maxOutputChars: 1000
      });
      assertEqual(timedOut.status, 124, "timed out command status");
      assertEqual(timedOut.timedOut, true, "timed out command marker");
      const pids = (await readFile(pidPath, "utf8")).trim().split(/\s+/).map(Number);
      assertEqual(pids.length, 2, "timed out process tree pids captured");
      for (const pid of pids) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            alive = false;
          } else {
            throw error;
          }
        }
        assertEqual(alive, false, `timed out process ${pid} is closed`);
      }
      await assertShutdownSignalCleansProcessTree(tmp);
    }
    return {
      id: "command-timeout-contract",
      status: "PASS",
      command: "evaluate runCommand timeout defaults",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "command-timeout-contract",
      status: "FAIL",
      command,
      durationMs: 0,
      message: error.message
    };
  }
}

async function assertShutdownSignalCleansProcessTree(tmp) {
  const shutdownSignal = "SIGQUIT";
  const expectedExitCode = 131;
  const pidPath = join(tmp, "shutdown-forwarding-command.pid");
  const commandsModuleUrl = new URL("../commands.mjs", import.meta.url).href;
  const command = [
    "trap '' TERM INT HUP QUIT",
    "(trap '' TERM INT HUP QUIT; sleep 30) & child=$!",
    `printf '%s %s' "$$" "$child" > ${quoteShell(pidPath)}`,
    "wait"
  ].join("; ");
  const runnerCode = [
    `import { runCommand } from ${JSON.stringify(commandsModuleUrl)};`,
    `process.on(${JSON.stringify(shutdownSignal)}, () => {});`,
    `await runCommand(${JSON.stringify(command)}, { timeoutMs: 60000 });`
  ].join("\n");
  const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerCode], {
    stdio: "ignore"
  });
  const closed = new Promise((resolve, reject) => {
    runner.once("error", reject);
    runner.once("close", (status, signal) => resolve({ status, signal }));
  });
  let pids = null;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const raw = (await readFile(pidPath, "utf8")).trim();
        if (/^\d+ \d+$/.test(raw)) {
          pids = raw.split(" ").map(Number);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      await sleep(25);
    }
    assertEqual(pids?.length, 2, "shutdown forwarding process tree pids captured");
    runner.kill(shutdownSignal);
    const result = await Promise.race([
      closed,
      sleep(5000).then(() => {
        throw new Error("shutdown forwarding runner did not exit");
      })
    ]);
    assertEqual(result.status, expectedExitCode, "shutdown forwarding returns the conventional signal exit code");
    for (const pid of pids) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          alive = false;
        } else {
          throw error;
        }
      }
      assertEqual(alive, false, `shutdown-forwarded process ${pid} is closed`);
    }
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGTERM");
      await Promise.race([closed.catch(() => null), sleep(1500)]);
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGKILL");
      }
    }
    if (pids?.[0]) {
      try {
        process.kill(-pids[0], "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  }
}

export async function commandOutputBudgetCheck() {
  try {
    const result = await runCommand("node -e 'process.stdout.write(\"x\".repeat(1000000)); process.stderr.write(\"y\".repeat(100000));'", {
      timeoutMs: 10000,
      maxOutputChars: 20
    });
    assertEqual(result.status, 0, "command output budget command status");
    assertEqual(result.outputBudget?.schemaVersion, "kova.commandOutputBudget.v1", "command output budget schema");
    assertEqual(result.outputBudget?.stdout?.truncated, true, "stdout budget truncates");
    assertEqual(result.outputBudget?.stderr?.truncated, true, "stderr budget truncates");
    assertEqual(result.outputBudget?.stdout?.omittedChars, 999980, "stdout omitted chars");
    assertEqual(result.outputBudget?.stderr?.omittedChars, 99980, "stderr omitted chars");
    const redactionValue = "kova-sensitive-marker";
    const accumulator = createBoundedOutputAccumulator({
      limit: 20,
      redactValues: [redactionValue]
    });
    accumulator.write("prefix-kova-sensitive-");
    accumulator.write("marker-suffix-that-is-truncated");
    const redacted = accumulator.finish();
    assertEqual(redacted.text.includes(redactionValue), false, "streaming accumulator redacts split secrets");
    assertEqual(redacted.text.startsWith("prefix-[REDACTED]"), true, "streaming accumulator retains redaction marker");
    assertEqual(redacted.truncated, true, "streaming redacted output remains bounded");
    assertEqual(redacted.retainedChars, 20, "streaming redacted output cap");
    return {
      id: "command-output-budget",
      status: "PASS",
      command: "evaluate command output truncation metadata",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "command-output-budget",
      status: "FAIL",
      command: "evaluate command output truncation metadata",
      durationMs: 0,
      message: error.message
    };
  }
}

export function logSnippetBudgetCheck() {
  try {
    const snippet = boundedLogSnippet(`${"a".repeat(40)}tail`, 10);
    assertEqual(snippet.text.startsWith("[truncated 34 chars]"), true, "log snippet truncation marker");
    assertEqual(snippet.text.endsWith("aaaaaatail"), true, "log snippet retains tail");
    assertEqual(snippet.budget.truncated, true, "log snippet budget truncated");
    assertEqual(snippet.budget.retainedBytes, 10, "log snippet retained bytes");
    assertEqual(snippet.budget.omittedBytes, 34, "log snippet omitted bytes");
    return {
      id: "log-snippet-budget",
      status: "PASS",
      command: "evaluate log snippet truncation metadata",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "log-snippet-budget",
      status: "FAIL",
      command: "evaluate log snippet truncation metadata",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function logArtifactRedactionCheck(tmp) {
  const fakeBin = join(tmp, "log-redaction-bin");
  const artifactDir = join(tmp, "log-redaction-artifacts");
  const headerCanary = ["kova", "header", "canary"].join("-");
  const prefixedHeaderCanary = ["kova", "prefixed", "header", "canary"].join("-");
  const jsonCanary = ["kova", "json", "canary"].join("-");
  const envCanary = ["kova", "env", "canary"].join("-");
  const cliCanary = ["kova", "cli", "canary"].join("-");
  const exactRedactionValue = ["kova", "exact", "canary"].join("-");
  const genericJsonCanary = ["kova", "generic", "json", "canary"].join("-");
  const quotedAssignmentTail = ["quoted", "tail", "canary"].join("-");
  const punctuatedAssignmentTail = ["punctuated", "tail", "canary"].join("-");
  const genericTokenKey = ["to", "ken"].join("");
  const sessionTokenKey = ["SESSION", "TOKEN"].join("_");
  const databasePasswordKey = ["DB", "PASSWORD"].join("_");
  const escapedJsonTail = ["escaped", "json", "tail", "canary"].join("-");
  const escapedCliTail = ["escaped", "cli", "tail", "canary"].join("-");
  const unquotedFieldTail = ["unquoted", "field", "tail", "canary"].join("-");
  const pemBodyCanary = ["pem", "body", "canary"].join("-");
  const truncatedPemBodyCanary = ["truncated", "pem", "body", "canary"].join("-");
  const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
  const compoundCliCanary = ["compound", "cli", "canary"].join("-");
  const timeoutTokenCanary = ["timeout", "token", "canary"].join("-");
  const yamlContinuationCanary = ["yaml", "continuation", "canary"].join("-");
  const plainContinuationHeadCanary = ["plain", "continuation", "head", "canary"].join("-");
  const plainContinuationTailCanary = ["plain", "continuation", "tail", "canary"].join("-");
  const cliContinuationCanary = ["cli", "continuation", "canary"].join("-");
  const urlPasswordCanary = ["url", "password", "canary@"].join("-");
  const encodedUrlPasswordCanary = encodeURIComponent(urlPasswordCanary);
  const dotenvMultilineCanary = ["dotenv", "multiline", "canary"].join("-");
  const structuredJsonCanary = ["structured", "json", "canary"].join("-");
  const structuredEmbeddedCanary = ["structured", "embedded", "canary"].join("-");
  const timestampCredentialCanary = ["2026-07-11", "T12:34:56Z"].join("");
  const multilineSuffixCanary = ["multiline", "suffix", "canary"].join("-");
  const clientSecretFlag = ["--client", "secret"].join("-");
  const canaries = [
    headerCanary,
    prefixedHeaderCanary,
    jsonCanary,
    envCanary,
    cliCanary,
    exactRedactionValue,
    genericJsonCanary,
    quotedAssignmentTail,
    punctuatedAssignmentTail,
    escapedJsonTail,
    escapedCliTail,
    unquotedFieldTail,
    pemBodyCanary,
    truncatedPemBodyCanary,
    compoundCliCanary,
    timeoutTokenCanary,
    yamlContinuationCanary,
    plainContinuationHeadCanary,
    plainContinuationTailCanary,
    cliContinuationCanary,
    encodedUrlPasswordCanary,
    dotenvMultilineCanary,
    structuredJsonCanary,
    structuredEmbeddedCanary,
    timestampCredentialCanary,
    multilineSuffixCanary
  ];
  const fakeLogs = [
    `Authorization${": "}Bearer ${headerCanary}`,
    `INFO request x-api-key${": "}${prefixedHeaderCanary}`,
    JSON.stringify({ access_token: jsonCanary, message: "safe" }),
    `OPENAI_API_KEY${"="}${envCanary}`,
    `command --token ${cliCanary}`,
    `exact=${exactRedactionValue}`,
    JSON.stringify({ [genericTokenKey]: genericJsonCanary }),
    `${sessionTokenKey}="kova ${quotedAssignmentTail}"`,
    `${databasePasswordKey}=kova,${punctuatedAssignmentTail};done`,
    JSON.stringify({ [genericTokenKey]: `prefix"${escapedJsonTail}` }),
    `command --token ${JSON.stringify(`prefix"${escapedCliTail}`)}`,
    `${databasePasswordKey.toLowerCase()}: kova ${unquotedFieldTail}`,
    [
      `private_${["key"].join("")}: -----BEGIN ${privateKeyLabel}-----`,
      pemBodyCanary,
      `-----END ${privateKeyLabel}-----`
    ].join("\n"),
    `command ${clientSecretFlag} ${compoundCliCanary}`,
    JSON.stringify({ [genericTokenKey]: timeoutTokenCanary, message: "provider timed out" }),
    `${sessionTokenKey}: |2-\n  ${yamlContinuationCanary}`,
    `${sessionTokenKey}: ${plainContinuationHeadCanary}\n  ${plainContinuationTailCanary}`,
    `command --token ${"\\"}\n  ${cliContinuationCanary}`,
    `postgresql://alice:${encodedUrlPasswordCanary}@db.example/kova`,
    `${databasePasswordKey}="first line\n${dotenvMultilineCanary}" ${sessionTokenKey}=${multilineSuffixCanary}`,
    `${databasePasswordKey}=${timestampCredentialCanary}`,
    JSON.stringify({
      [genericTokenKey]: structuredJsonCanary,
      command: `tool --${databasePasswordKey.toLowerCase()} ${structuredEmbeddedCanary}`,
      openclawDiagnostic: true,
      category: "redaction-self-check"
    }),
    [
      `-----BEGIN ${privateKeyLabel}-----`,
      truncatedPemBodyCanary
    ].join("\n")
  ].join("\n");
  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "ocm"), `#!/bin/sh
printf '%s\n' "$KOVA_FAKE_LOGS"
`, "utf8");
    await chmod(join(fakeBin, "ocm"), 0o755);

    const metrics = await collectLogMetrics("kova-self-check", 5000, artifactDir, {
      commandEnv: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        KOVA_FAKE_LOGS: fakeLogs
      },
      redactValues: [exactRedactionValue, urlPasswordCanary]
    });
    const artifact = await readFile(join(artifactDir, "collectors", "gateway-tail.log"), "utf8");
    const serialized = JSON.stringify(metrics);
    for (const canary of canaries) {
      assertEqual(artifact.includes(canary), false, `log artifact redacts ${canary}`);
      assertEqual(serialized.includes(canary), false, `log metrics redact ${canary}`);
    }
    assertEqual(artifact.includes("[REDACTED]"), true, "log artifact contains redaction markers");
    assertEqual(metrics.providerTimeoutMentions, 1, "log metrics preserve signals after sensitive fields");
    assertEqual(
      metrics.structuredEvents.some((event) => event.category === "redaction-self-check"),
      true,
      "log metrics preserve structured fields beside secrets"
    );

    return {
      id: "log-artifact-redaction",
      status: "PASS",
      command: "redact auth canaries before log artifact writes",
      durationMs: metrics.durationMs
    };
  } catch (error) {
    return {
      id: "log-artifact-redaction",
      status: "FAIL",
      command: "redact auth canaries before log artifact writes",
      durationMs: 0,
      message: error.message
    };
  }
}
