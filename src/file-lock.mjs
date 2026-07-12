import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
    if (await reclamationInProgress(lockPath, staleMs)) {
      await waitForRetry(startedAt, timeoutMs, retryMs, lockPath);
      continue;
    }
    try {
      await writeExclusiveMetadata(lockPath, lockMetadata(token));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await reclaimAbandonedLock(lockPath, staleMs)) {
        continue;
      }
      await waitForRetry(startedAt, timeoutMs, retryMs, lockPath);
    }
  }

  try {
    return await callback();
  } finally {
    await removeOwnedFile(lockPath, token);
  }
}

async function reclaimAbandonedLock(lockPath, staleMs) {
  const snapshot = await readSnapshot(lockPath);
  if (!snapshot || !isAbandoned(snapshot, staleMs)) {
    return false;
  }

  const claimPath = `${lockPath}.reclaim-${snapshot.fingerprint}`;
  const claimToken = randomUUID();
  try {
    await writeExclusiveMetadata(claimPath, lockMetadata(claimToken));
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    const current = await readSnapshot(lockPath);
    if (!current) {
      return true;
    }
    if (current.fingerprint !== snapshot.fingerprint || !isAbandoned(current, staleMs)) {
      return false;
    }
    await rm(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  } finally {
    await removeOwnedFile(claimPath, claimToken);
  }
}

async function reclamationInProgress(lockPath, staleMs) {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reclaim-`;
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  let active = false;
  for (const name of names.filter((entry) => entry.startsWith(prefix))) {
    const path = join(directory, name);
    const snapshot = await readSnapshot(path);
    if (!snapshot) {
      continue;
    }
    if (isAbandoned(snapshot, staleMs)) {
      await removeSnapshot(path, snapshot);
      continue;
    }
    active = true;
  }
  return active;
}

async function writeExclusiveMetadata(path, metadata) {
  const candidatePath = `${path}.candidate-${metadata.token}`;
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Linking a fully written candidate makes the visible lock complete at
    // creation time and preserves O_EXCL semantics across processes.
    await link(candidatePath, path);
  } finally {
    await rm(candidatePath, { force: true });
  }
}

async function readSnapshot(path) {
  try {
    const [raw, info] = await Promise.all([
      readFile(path, "utf8"),
      stat(path)
    ]);
    let owner = null;
    try {
      owner = JSON.parse(raw);
    } catch {
      // Malformed lock files remain blocking until their age proves abandonment.
    }
    return {
      owner,
      ageMs: Date.now() - info.mtimeMs,
      fingerprint: createHash("sha256")
        .update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${raw}`)
        .digest("hex")
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeSnapshot(path, snapshot) {
  const current = await readSnapshot(path);
  if (current?.fingerprint === snapshot.fingerprint) {
    await rm(path).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function removeOwnedFile(path, token) {
  const snapshot = await readSnapshot(path);
  if (snapshot?.owner?.token === token) {
    await removeSnapshot(path, snapshot);
  }
}

function isAbandoned(snapshot, staleMs) {
  const pid = snapshot.owner?.pid;
  if (Number.isInteger(pid) && pid > 0) {
    return !processIsAlive(pid);
  }
  return snapshot.ageMs >= staleMs;
}

function lockMetadata(token) {
  return {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForRetry(startedAt, timeoutMs, retryMs, lockPath) {
  if (Date.now() - startedAt >= timeoutMs) {
    throw new Error(`timed out waiting for Kova file lock: ${lockPath}`);
  }
  await new Promise((resolve) => setTimeout(resolve, retryMs));
}
