import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { directoryCheck } from "../setup.mjs";
import { assertEqual, assertString } from "./harness.mjs";

export async function setupDirectoryWriteProbeCheck(tmp) {
  const path = join(tmp, "directory-write-probe");
  const startedAt = Date.now();
  if (process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0)) {
    return {
      id: "setup-directory-child-write-probe",
      status: "PASS",
      command: "directoryCheck against mode 0222 fixture",
      durationMs: Date.now() - startedAt,
      message: process.platform === "win32"
        ? "skipped POSIX permission fixture on Windows"
        : "skipped permission fixture as root"
    };
  }
  await mkdir(path, { recursive: true });
  await chmod(path, 0o222);
  try {
    const result = await directoryCheck("write-probe", path);
    assertEqual(result.status, "FAIL", "directory child creation failure");
    return {
      id: "setup-directory-child-write-probe",
      status: "PASS",
      command: "directoryCheck against mode 0222 fixture",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      id: "setup-directory-child-write-probe",
      status: "FAIL",
      command: "directoryCheck against mode 0222 fixture",
      durationMs: Date.now() - startedAt,
      message: error.message
    };
  } finally {
    await chmod(path, 0o700).catch(() => {});
  }
}

export async function setupTtySecretInputCheck(tmp) {
  const expectPath = (await runCommand("command -v expect", { timeoutMs: 5000 })).stdout.trim();
  const startedAt = Date.now();
  if (!expectPath) {
    return {
      id: "setup-tty-secret-input",
      status: "PASS",
      command: "expect PTY setup flow",
      durationMs: Date.now() - startedAt,
      message: "expect unavailable; PTY proof skipped"
    };
  }

  const dir = join(tmp, "setup-tty");
  const fakeBin = join(dir, "bin");
  const wrapperPath = join(dir, "run-setup.sh");
  const expectScriptPath = join(dir, "drive-setup.exp");
  const sentinel = "dummy";
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, "ocm"), `#!/bin/sh
case "$1:$2" in
  --version:) echo "ocm self-check"; exit 0 ;;
  env:list|runtime:list) echo "[]"; exit 0 ;;
esac
exit 1
`, "utf8");
  await chmod(join(fakeBin, "ocm"), 0o755);
  await writeFile(wrapperPath, `#!/bin/sh
before="$(stty -g)"
cd "$KOVA_REPO_ROOT" || exit 1
node bin/kova.mjs setup --json >"$KOVA_TTY_STDOUT"
status=$?
after="$(stty -g)"
printf '\\nKOVA_TTY_BEFORE=%s\\nKOVA_TTY_AFTER=%s\\n' "$before" "$after" >&2
exit "$status"
`, "utf8");
  await chmod(wrapperPath, 0o755);
  await writeFile(expectScriptPath, `#!/usr/bin/expect -f
set timeout 20
set wrapper [lindex $argv 0]
set repo [lindex $argv 1]
set home [lindex $argv 2]
set fakebin [lindex $argv 3]
set stdoutfile [lindex $argv 4]
set transcript [lindex $argv 5]
set sentinel [lindex $argv 6]
set mode [lindex $argv 7]
log_file -noappend $transcript
spawn -noecho env "KOVA_HOME=$home" "PATH=$fakebin:$env(PATH)" "KOVA_TTY_STDOUT=$stdoutfile" "KOVA_REPO_ROOT=$repo" $wrapper
expect -exact {Provider [openai]: }
send -- "\\r"
expect -exact {Auth method [mock]: }
send -- "3\\r"
expect -exact {Env var [OPENAI_API_KEY]: }
send -- "\\r"
expect -exact {Value for OPENAI_API_KEY (leave empty to read host env): }
if {$mode eq "cancel"} {
  send -- "\\003"
} else {
  send -- "$sentinel\\r"
}
expect eof
set result [wait]
exit [lindex $result 3]
`, "utf8");
  await chmod(expectScriptPath, 0o755);

  try {
    const success = await runSetupTtyCase({
      expectPath,
      expectScriptPath,
      wrapperPath,
      repo: repoRoot,
      fakeBin,
      home: join(dir, "success-home"),
      stdoutPath: join(dir, "success.json"),
      transcriptPath: join(dir, "success.log"),
      sentinel,
      mode: "success"
    });
    assertEqual(success.status, 0, "interactive setup exit");
    assertTtySetupState(success.transcript, sentinel);
    const setup = JSON.parse(success.stdout);
    assertEqual(setup.ok, true, "interactive JSON setup");
    assertEqual(setup.auth?.method, "api-key", "interactive auth method");
    assertEqual(success.stdout.includes("Kova auth setup"), false, "interactive prompts excluded from stdout");
    const liveEnv = await readFile(join(dir, "success-home", "credentials", "live.env"), "utf8");
    assertEqual(liveEnv.includes(sentinel), true, "interactive secret persisted");

    const cancelled = await runSetupTtyCase({
      expectPath,
      expectScriptPath,
      wrapperPath,
      repo: repoRoot,
      fakeBin,
      home: join(dir, "cancel-home"),
      stdoutPath: join(dir, "cancel.json"),
      transcriptPath: join(dir, "cancel.log"),
      sentinel,
      mode: "cancel"
    });
    assertEqual(cancelled.status !== 0, true, "cancelled setup exits nonzero");
    assertEqual(cancelled.transcript.includes("secret input cancelled"), true, "cancelled setup reports cancellation");
    assertTtySetupState(cancelled.transcript, sentinel);

    return {
      id: "setup-tty-secret-input",
      status: "PASS",
      command: "expect PTY setup success and Ctrl-C cancellation",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      id: "setup-tty-secret-input",
      status: "FAIL",
      command: "expect PTY setup success and Ctrl-C cancellation",
      durationMs: Date.now() - startedAt,
      message: error.message
    };
  }
}

async function runSetupTtyCase(options) {
  await mkdir(options.home, { recursive: true });
  const result = await runCommand([
    quoteShell(options.expectPath),
    quoteShell(options.expectScriptPath),
    quoteShell(options.wrapperPath),
    quoteShell(options.repo),
    quoteShell(options.home),
    quoteShell(options.fakeBin),
    quoteShell(options.stdoutPath),
    quoteShell(options.transcriptPath),
    quoteShell(options.sentinel),
    quoteShell(options.mode)
  ].join(" "), { timeoutMs: 30000, maxOutputChars: 1000000 });
  return {
    ...result,
    stdout: await readFile(options.stdoutPath, "utf8").catch(() => ""),
    transcript: await readFile(options.transcriptPath, "utf8").catch(() => result.stdout)
  };
}

function assertTtySetupState(transcript, sentinel) {
  assertEqual(transcript.includes("Kova auth setup"), true, "interactive prompt transcript");
  assertEqual(transcript.includes(sentinel), false, "secret echo suppression");
  const before = transcript.match(/KOVA_TTY_BEFORE=([^\r\n]+)/)?.[1];
  const after = transcript.match(/KOVA_TTY_AFTER=([^\r\n]+)/)?.[1];
  assertString(before, "TTY state before setup");
  assertEqual(after, before, "TTY state restored");
}

export async function setupNumericFlagsRejectedCheck(tmp) {
  const home = join(tmp, "numeric-auth-home");
  const command = `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs setup --non-interactive --provider 2 --auth 3 --value kova-selfcheck-key --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status === 0) {
      throw new Error("numeric setup provider/auth flags were accepted");
    }
    const output = `${result.stderr}\n${result.stdout}`;
    if (!output.includes("unknown auth method: 3")) {
      throw new Error(output.trim() || `unexpected exit ${result.status}`);
    }
    return {
      id: "setup-numeric-flags-rejected",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "setup-numeric-flags-rejected",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}
