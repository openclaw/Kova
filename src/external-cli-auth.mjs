import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

export function resolveExternalCliName(provider, requested) {
  const implied = impliedExternalCliForProvider(provider);
  if (implied) {
    if (requested && externalCliFromChoice(requested) !== implied) {
      throw new Error(`provider ${provider} uses external CLI ${implied}; do not pass a different --external-cli value`);
    }
    return implied;
  }
  throw new Error(`external-cli auth is only supported for provider openai or anthropic`);
}

export function impliedExternalCliForProvider(provider) {
  if (provider === "openai") {
    return "codex";
  }
  if (provider === "anthropic") {
    return "claude";
  }
  return null;
}

export function externalCliFromChoice(choice) {
  const normalized = String(choice ?? "").trim().toLowerCase().replaceAll("_", "-");
  const supported = new Set(["codex", "claude"]);
  if (supported.has(normalized)) {
    return normalized;
  }
  throw new Error(`unknown external CLI: ${choice}`);
}

export async function verifyExternalCliAuth(cli) {
  const normalizedCli = externalCliFromChoice(cli);
  const binary = await commandPath(normalizedCli);
  const checks = [{
    id: `${normalizedCli}-binary`,
    ok: Boolean(binary),
    path: binary,
    message: binary ? binary : `${normalizedCli} binary not found on PATH`
  }];

  const authStatus = binary
    ? await nativeAuthStatus(normalizedCli, binary)
    : {
        ok: false,
        check: {
          id: `${normalizedCli}-auth-status`,
          ok: false,
          message: `${normalizedCli} binary not found on PATH`
        }
      };
  checks.push(authStatus.check);

  const verified = Boolean(binary) && authStatus.ok;
  return {
    schemaVersion: "kova.external-cli.verification.v1",
    cli: normalizedCli,
    verified,
    binaryPath: binary,
    authFiles: [],
    reason: verified ? "verified" : firstFailedReason(checks),
    checks
  };
}

export function externalCliVerificationSummary(verification) {
  return {
    schemaVersion: verification.schemaVersion,
    cli: verification.cli,
    verified: verification.verified,
    binaryPath: verification.binaryPath,
    authFiles: verification.authFiles,
    reason: verification.reason,
    checks: verification.checks.map((check) => ({
      id: check.id,
      ok: check.ok,
      path: check.path,
      envVar: check.envVar,
      required: check.required !== false,
      message: check.message
    }))
  };
}

async function commandPath(command) {
  const names = commandNames(command);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = resolve(directory || ".", name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function commandNames(command) {
  if (process.platform !== "win32" || extname(command)) {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${command}${extension}`);
}

async function nativeAuthStatus(cli, binary) {
  if (cli === "claude") {
    const help = await execFileResult(binary, ["auth", "status", "--help"]);
    if (help.status !== 0) {
      return {
        ok: false,
        check: {
          id: `${cli}-auth-status`,
          ok: false,
          message: "claude auth status is unavailable; update Claude Code to a release that supports it"
        }
      };
    }
  }
  const args = cli === "codex" ? ["login", "status"] : ["auth", "status"];
  const result = await execFileResult(binary, args);
  const ok = cli === "claude"
    ? result.status === 0 && claudeStatusIsLoggedIn(result.stdout)
    : result.status === 0;
  return {
    ok,
    check: {
      id: `${cli}-auth-status`,
      ok,
      message: ok
        ? `${cli} reported an authenticated session`
        : cli === "claude" && result.status === 0
          ? "claude auth status did not report loggedIn true"
          : `${cli} auth status exited ${result.status ?? "without a status"}`
    }
  };
}

function execFileResult(binary, args) {
  const invocation = executableInvocation(binary, args);
  return new Promise((resolve) => {
    execFile(invocation.binary, invocation.args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 20000,
      windowsHide: true,
      env: invocation.env
    }, (error, stdout) => {
      resolve({
        status: error
          ? Number.isInteger(error.code)
            ? error.code
            : error.killed
              ? 124
              : 1
          : 0,
        stdout: stdout ?? ""
      });
    });
  });
}

function executableInvocation(binary, args) {
  if (process.platform !== "win32") {
    return { binary, args, env: process.env };
  }
  const extension = extname(binary).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return {
      binary: windowsCommandProcessorPath(),
      args: ["/d", "/s", "/c", `"%KOVA_EXTERNAL_CLI_BINARY%" ${args.join(" ")}`],
      env: {
        ...process.env,
        KOVA_EXTERNAL_CLI_BINARY: binary
      }
    };
  }
  if (extension === ".ps1") {
    return {
      binary: windowsPowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", binary, ...args],
      env: process.env
    };
  }
  return { binary, args, env: process.env };
}

function windowsCommandProcessorPath() {
  if (process.env.ComSpec && isAbsolute(process.env.ComSpec)) {
    return process.env.ComSpec;
  }
  return join(windowsSystemRoot(), "System32", "cmd.exe");
}

function windowsPowerShellPath() {
  return join(windowsSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsSystemRoot() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot must be an absolute path");
  }
  return systemRoot;
}

function claudeStatusIsLoggedIn(stdout) {
  try {
    return JSON.parse(stdout)?.loggedIn === true;
  } catch {
    return false;
  }
}

function firstFailedReason(checks) {
  const failedRequired = checks.find((check) => check.ok !== true && check.required !== false);
  const failed = failedRequired ?? checks.find((check) => check.ok !== true);
  return failed?.message ?? "verification failed";
}
