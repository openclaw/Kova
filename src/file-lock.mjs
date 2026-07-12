import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_RETRY_MS = 25;

export async function withFileLock(lockPath, callback, options = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const startedAt = Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  while (true) {
    try {
      await acquireLock(lockPath, token);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await removeAbandonedLock(lockPath, staleMs)) {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for Kova file lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await callback();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

async function acquireLock(lockPath, token) {
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      token,
      pid: process.pid,
      createdAt: new Date().toISOString()
    })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeAbandonedLock(lockPath, staleMs) {
  let metadata;
  try {
    const [raw, info] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath)
    ]);
    metadata = {
      owner: JSON.parse(raw),
      ageMs: Date.now() - info.mtimeMs
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    return false;
  }

  const ownerAlive = processIsAlive(metadata.owner?.pid);
  if (ownerAlive || metadata.ageMs < staleMs) {
    return false;
  }
  try {
    await rm(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function releaseOwnedLock(lockPath, token) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (owner?.token === token) {
      await rm(lockPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
