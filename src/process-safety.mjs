import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const mockProviderOwnerSchema = "kova.mock-provider-owner.v1";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function positiveProcessId(value, label = "pid") {
  const text = typeof value === "string" ? value.trim() : value;
  const pid = typeof text === "number" ? text : Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return pid;
}

export function isOwnedMockProviderSupervisorCommand(command, expected) {
  const text = String(command ?? "").trim();
  const args = mockProviderSupervisorArgs(expected).map(escapeRegExp).join("\\s+");
  const invocation = new RegExp(
    `^(?:node|\\S*[\\\\/]node)\\s+${args}\\s*$`
  );
  return invocation.test(text);
}

export function isOwnedLegacyMockProviderCommand(command, expected) {
  const text = String(command ?? "").trim();
  const executable = escapeRegExp(expected.legacyExecutablePath);
  const script = escapeRegExp(expected.scriptPath);
  const requestLog = escapeRegExp(expected.requestLog);
  const invocation = new RegExp(
    `^(?:(?:node|\\S*[\\\\/]node)\\s+)?${executable}\\s+serve\\s+--providers\\s+openai\\s+--script\\s+${script}\\s+--port\\s+0\\s+--request-log\\s+${requestLog}\\s*$`
  );
  return invocation.test(text);
}

export function mockProviderSupervisorArgs(expected) {
  return [
    expected.supervisorPath,
    "--script", expected.scriptPath,
    "--request-log", expected.requestLog,
    "--server-log", expected.serverLog,
    "--pid-file", expected.pidFile
  ];
}

export function mockProviderOwnerRecord(pid, token) {
  return {
    schemaVersion: mockProviderOwnerSchema,
    pid: positiveProcessId(pid, "mock provider pid"),
    token: validOwnerToken(token)
  };
}

export function mockProviderStopFile(pidFile, owner) {
  const pid = positiveProcessId(owner.pid, "mock provider pid");
  return `${pidFile}.stop.${pid}.${validOwnerToken(owner.token)}`;
}

export async function stopOwnedMockProvider(options) {
  const {
    pidFile,
    supervisorPath,
    legacyExecutablePath,
    scriptPath,
    requestLog,
    serverLog,
    inspectProcess = readProcessCommand,
    requestStop = writeStopRequest,
    signalProcess = process.kill,
    stopTimeoutMs = 5000,
    pollIntervalMs = 50,
    wait = sleep
  } = options;
  const expectedCommand = {
    supervisorPath,
    legacyExecutablePath,
    scriptPath,
    requestLog,
    serverLog,
    pidFile
  };
  let rawOwner;
  try {
    rawOwner = await readFile(pidFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "already-absent", pid: null };
    }
    throw error;
  }

  let result;
  let owner;
  let pid;
  let legacy = false;
  try {
    owner = parseMockProviderOwner(rawOwner);
    pid = owner.pid;
  } catch {
    try {
      pid = positiveProcessId(rawOwner, "legacy mock provider pid");
      legacy = true;
    } catch {
      result = { status: "invalid-pid", pid: null };
    }
  }

  if (!result) {
    const command = await inspectProcess(pid);
    if (command === null) {
      result = { status: legacy ? "legacy-not-running" : "not-running", pid };
    } else if (legacy) {
      if (!isOwnedLegacyMockProviderCommand(command, expectedCommand)) {
        throw new Error(`legacy mock provider pid ${pid} does not match the expected command; retaining ${pidFile}`);
      }
      try {
        signalProcess(pid, "SIGTERM");
      } catch (error) {
        if (error.code === "ESRCH") {
          result = { status: "legacy-not-running", pid };
        } else {
          throw error;
        }
      }
      if (!result) {
        const stopped = await waitForProcessExit({
          pid,
          isExpectedCommand: (currentCommand) => isOwnedLegacyMockProviderCommand(currentCommand, expectedCommand),
          inspectProcess,
          stopTimeoutMs,
          pollIntervalMs,
          wait
        });
        if (!stopped) {
          throw new Error(`legacy mock provider ${pid} did not stop within ${stopTimeoutMs}ms`);
        }
        result = { status: "legacy-stopped", pid };
      }
    } else if (!isOwnedMockProviderSupervisorCommand(command, expectedCommand)) {
      result = { status: "identity-mismatch", pid };
    } else {
      const stopFile = mockProviderStopFile(pidFile, owner);
      await requestStop(stopFile);
      const stopped = await waitForProcessExit({
        pid,
        isExpectedCommand: (currentCommand) => isOwnedMockProviderSupervisorCommand(currentCommand, expectedCommand),
        inspectProcess,
        stopTimeoutMs,
        pollIntervalMs,
        wait
      });
      if (!stopped) {
        throw new Error(`mock provider supervisor ${pid} did not stop within ${stopTimeoutMs}ms`);
      }
      result = { status: "stopped", pid };
    }
  }

  await removeOwnedControlFiles({
    pidFile,
    rawOwner,
    stopFile: owner ? mockProviderStopFile(pidFile, owner) : null
  });
  return result;
}

function parseMockProviderOwner(rawOwner) {
  const parsed = JSON.parse(rawOwner);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mock provider owner must be an object");
  }
  if (parsed.schemaVersion !== mockProviderOwnerSchema) {
    throw new Error(`unsupported mock provider owner schema: ${String(parsed.schemaVersion)}`);
  }
  return mockProviderOwnerRecord(parsed.pid, parsed.token);
}

async function removeOwnedControlFiles({ pidFile, rawOwner, stopFile }) {
  if (stopFile) {
    await rm(stopFile, { force: true });
  }
  await removeMockProviderOwnerFile(pidFile, rawOwner);
}

export async function removeMockProviderOwnerFile(pidFile, expectedOwner) {
  let currentOwner;
  try {
    currentOwner = await readFile(pidFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      return;
    }
    throw error;
  }
  if (currentOwner !== expectedOwner) {
    return;
  }

  // Claim the path atomically, then verify the claimed generation. If a
  // replacement won the race, restore its record without overwriting a newer one.
  const claimedFile = `${pidFile}.cleanup.${randomUUID()}`;
  try {
    await rename(pidFile, claimedFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    const claimedOwner = await readFile(claimedFile, "utf8");
    if (claimedOwner !== expectedOwner) {
      try {
        await link(claimedFile, pidFile);
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
    }
  } finally {
    await rm(claimedFile, { force: true });
  }
}

async function waitForProcessExit(options) {
  const {
    pid,
    isExpectedCommand,
    inspectProcess,
    stopTimeoutMs,
    pollIntervalMs,
    wait
  } = options;
  const deadline = Date.now() + Math.max(0, stopTimeoutMs);

  while (true) {
    const command = await inspectProcess(pid);
    if (command === null || !isExpectedCommand(command)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await wait(Math.min(Math.max(1, pollIntervalMs), deadline - Date.now()));
  }
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

async function writeStopRequest(stopFile) {
  await writeFile(stopFile, `${Date.now()}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validOwnerToken(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error(`mock provider owner token must be a UUID, got ${JSON.stringify(value)}`);
  }
  return value;
}
