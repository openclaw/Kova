import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function positiveProcessId(value, label = "pid") {
  const text = typeof value === "string" ? value.trim() : value;
  const pid = typeof text === "number" ? text : Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return pid;
}

export function isOwnedMockProviderCommand(command, expected) {
  const text = String(command ?? "").trim();
  const executable = escapeRegExp(expected.executablePath);
  const script = escapeRegExp(expected.scriptPath);
  const requestLog = escapeRegExp(expected.requestLog);
  const invocation = new RegExp(
    `^(?:\\S*node\\s+)?${executable}\\s+serve\\s+--providers\\s+openai\\s+--script\\s+${script}\\s+--port\\s+0\\s+--request-log\\s+${requestLog}(?=\\s|$)`
  );
  return invocation.test(text);
}

export async function stopOwnedMockProvider(options) {
  const {
    pidFile,
    executablePath,
    scriptPath,
    requestLog,
    inspectProcess = readProcessCommand,
    signalProcess = process.kill
  } = options;

  let rawPid;
  try {
    rawPid = await readFile(pidFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "already-absent", pid: null };
    }
    throw error;
  }

  let result;
  let pid;
  try {
    pid = positiveProcessId(rawPid, "mock provider pid");
  } catch {
    result = { status: "invalid-pid", pid: null };
  }

  if (!result) {
    const command = await inspectProcess(pid);
    if (command === null) {
      result = { status: "not-running", pid };
    } else if (!isOwnedMockProviderCommand(command, { executablePath, scriptPath, requestLog })) {
      result = { status: "identity-mismatch", pid };
    } else {
      try {
        signalProcess(pid, "SIGTERM");
        result = { status: "signaled", pid };
      } catch (error) {
        if (error.code === "ESRCH") {
          result = { status: "not-running", pid };
        } else {
          throw error;
        }
      }
    }
  }

  await rm(pidFile, { force: true });
  return result;
}

async function readProcessCommand(pid) {
  try {
    const result = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const command = result.stdout.trim();
    return command || null;
  } catch (error) {
    if (typeof error.code === "number" && error.code === 1) {
      return null;
    }
    throw error;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
