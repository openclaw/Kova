import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_RETRY_MS = 25;
const MAX_DIAGNOSTIC_FIELD_LENGTH = 160;
const CURRENT_PROCESS_IDENTITY = readProcessIdentity(process.pid);
const CURRENT_EXECUTION_DOMAIN = readExecutionDomainIdentity();

export async function withFileLock(lockPath, callback, options = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const startedAt = Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const fileMode = options.fileMode ?? 0o600;
  const linkFile = options.linkFile ?? link;
  const openFallbackFile = options.openFallbackFile ?? open;
  let releaseAcquisitionHandle = null;

  while (true) {
    if (await reclamationInProgress(lockPath, staleMs)) {
      await waitForRetry(startedAt, timeoutMs, retryMs, lockPath);
      continue;
    }
    try {
      releaseAcquisitionHandle = await writeExclusiveMetadata(
        lockPath,
        lockMetadata(token),
        fileMode,
        linkFile,
        openFallbackFile
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (
        await reclaimAbandonedLock(
          lockPath,
          staleMs,
          fileMode,
          linkFile,
          openFallbackFile
        )
      ) {
        continue;
      }
      await waitForRetry(startedAt, timeoutMs, retryMs, lockPath);
    }
  }

  try {
    return await callback();
  } finally {
    if (releaseAcquisitionHandle) {
      await releaseAcquisitionHandle();
    }
    await removeOwnedFile(lockPath, token);
  }
}

async function reclaimAbandonedLock(
  lockPath,
  staleMs,
  fileMode,
  linkFile,
  openFallbackFile
) {
  const snapshot = await readSnapshot(lockPath);
  if (!snapshot || !isAbandoned(snapshot, staleMs)) {
    return false;
  }

  const claimPath = `${lockPath}.reclaim-${snapshot.fingerprint}`;
  const claimToken = randomUUID();
  let releaseClaimHandle = null;
  try {
    releaseClaimHandle = await writeExclusiveMetadata(
      claimPath,
      lockMetadata(claimToken),
      fileMode,
      linkFile,
      openFallbackFile
    );
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
    if (releaseClaimHandle) {
      await releaseClaimHandle();
    }
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
    if (isLegacyReclaimCandidate(name, prefix)) {
      if (snapshot.ageMs >= staleMs) {
        await removeSnapshot(path, snapshot);
      }
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

async function writeExclusiveMetadata(
  path,
  metadata,
  fileMode,
  linkFile,
  openFallbackFile
) {
  const candidatePath = join(
    dirname(path),
    `.${basename(path)}.candidate-${metadata.token}`
  );
  const content = `${JSON.stringify(metadata)}\n`;
  const handle = await open(candidatePath, "wx", fileMode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(fileMode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Linking a fully written candidate makes the visible lock complete at
    // creation time and preserves O_EXCL semantics across processes.
    await linkFile(candidatePath, path);
  } catch (error) {
    if (!linkIsUnsupported(error)) {
      throw error;
    }
    // O_EXCL still preserves mutual exclusion on filesystems without hard
    // links. Peers treat the brief incomplete-write window as fail-closed.
    return await writeExclusiveMetadataWithoutLink(
      path,
      content,
      fileMode,
      openFallbackFile
    );
  } finally {
    await rm(candidatePath, { force: true });
  }
  return null;
}

function linkIsUnsupported(error) {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(error?.code);
}

async function writeExclusiveMetadataWithoutLink(
  path,
  content,
  fileMode,
  openFallbackFile
) {
  const handle = await openFallbackFile(path, "wx", fileMode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(fileMode);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    // A partial visible lock must remain fail-closed. Portable pathname APIs
    // cannot prove ownership again before unlinking a possible replacement.
    throw error;
  }
  try {
    await handle.close();
    return null;
  } catch (error) {
    if (error?.code === "EBADF") {
      return null;
    }
    return async () => {
      await handle.close().catch((closeError) => {
        if (closeError?.code !== "EBADF") {
          throw closeError;
        }
      });
    };
  }
}

function isLegacyReclaimCandidate(name, prefix) {
  const suffix = name.slice(prefix.length);
  const separator = ".candidate-";
  const separatorIndex = suffix.indexOf(separator);
  if (separatorIndex === -1) {
    return false;
  }
  const fingerprint = suffix.slice(0, separatorIndex);
  const token = suffix.slice(separatorIndex + separator.length);
  return (
    /^[a-f0-9]{64}$/.test(fingerprint) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token)
  );
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
  const ownerDomain = snapshot.owner?.executionDomainIdentity;
  const domainRelation = classifyExecutionDomain(ownerDomain, CURRENT_EXECUTION_DOMAIN);
  if (domainRelation === "unknown" || domainRelation === "foreign") {
    return false;
  }
  if (domainRelation === "rebooted") {
    return true;
  }
  const pid = snapshot.owner?.pid;
  if (Number.isInteger(pid) && pid > 0) {
    if (!processIsAlive(pid)) {
      return true;
    }
    const ownerIdentity = snapshot.owner?.processIdentity;
    if (!ownerIdentity) {
      return snapshot.owner?.processIdentityUnavailable === true
        ? false
        : snapshot.ageMs >= staleMs;
    }
    const currentIdentity = readProcessIdentity(pid);
    return Boolean(currentIdentity && ownerIdentity !== currentIdentity);
  }
  return snapshot.ageMs >= staleMs;
}

export function currentExecutionDomainIdentity() {
  return CURRENT_EXECUTION_DOMAIN
    ? structuredClone(CURRENT_EXECUTION_DOMAIN)
    : null;
}

export function classifyExecutionDomain(owner, current) {
  if (
    !owner ||
    !current ||
    typeof owner !== "object" ||
    typeof current !== "object"
  ) {
    return "unknown";
  }
  for (const domain of [owner, current]) {
    for (const field of [
      "host",
      "hardwareMachine",
      "installationMachine",
      "boot",
      "pidNamespace"
    ]) {
      if (domain[field] !== undefined && domain[field] !== null && typeof domain[field] !== "string") {
        return "unknown";
      }
    }
  }
  if (owner.host && current.host && owner.host !== current.host) {
    return "foreign";
  }
  for (const field of ["hardwareMachine", "installationMachine"]) {
    if (owner[field] && current[field] && owner[field] !== current[field]) {
      return "foreign";
    }
  }
  const hardwareMachineMatch = Boolean(
    owner.hardwareMachine &&
    current.hardwareMachine &&
    owner.hardwareMachine === current.hardwareMachine
  );
  const ownerNamespace = owner.pidNamespace ?? null;
  const currentNamespace = current.pidNamespace ?? null;
  if (Boolean(ownerNamespace) !== Boolean(currentNamespace)) {
    return "unknown";
  }
  if (ownerNamespace && ownerNamespace !== currentNamespace) {
    return "foreign";
  }
  if (
    hardwareMachineMatch &&
    owner.boot &&
    current.boot &&
    owner.boot !== current.boot
  ) {
    return ownerNamespace ? "rebooted" : "unknown";
  }
  if (
    !hardwareMachineMatch &&
    (!owner.boot || !current.boot || owner.boot !== current.boot)
  ) {
    // Matching current boot IDs are the only fallback proof when a stable
    // machine identity is unavailable.
    return "unknown";
  }
  return "local";
}

function lockMetadata(token) {
  return {
    token,
    pid: process.pid,
    processIdentity: CURRENT_PROCESS_IDENTITY,
    processIdentityUnavailable: CURRENT_PROCESS_IDENTITY === null,
    executionDomainIdentity: CURRENT_EXECUTION_DOMAIN,
    createdAt: new Date().toISOString()
  };
}

function readExecutionDomainIdentity() {
  const host = hostname() || null;
  const machineIdentities = readMachineIdentities();
  if (process.platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const pidNamespace = readlinkSync("/proc/self/ns/pid");
      return {
        host,
        hardwareMachine: machineIdentities.hardware,
        installationMachine: machineIdentities.installation,
        boot: bootId || null,
        pidNamespace: pidNamespace || null
      };
    } catch {
      // Fall through to the host identity when procfs is unavailable.
    }
  }
  return host || machineIdentities.hardware || machineIdentities.installation
    ? {
        host,
        hardwareMachine: machineIdentities.hardware,
        installationMachine: machineIdentities.installation,
        boot: null,
        pidNamespace: null
      }
    : null;
}

function readMachineIdentities() {
  let hardware = "";
  let installation = "";
  if (process.platform === "linux") {
    try {
      hardware = normalizeMachineIdentity(
        readFileSync("/sys/class/dmi/id/product_uuid", "utf8")
      );
    } catch {
      // DMI is optional in containers and on some architectures.
    }
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        installation = normalizeMachineIdentity(readFileSync(path, "utf8"));
        if (installation) {
          break;
        }
      } catch {
        // Try the next standard machine identity path.
      }
    }
  } else if (process.platform === "darwin") {
    const result = spawnSync("/usr/sbin/ioreg", [
      "-rd1",
      "-c",
      "IOPlatformExpertDevice"
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000
    });
    hardware = result.status === 0
      ? normalizeMachineIdentity(
          result.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? ""
        )
      : "";
  } else if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot) {
      const powershell = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const result = spawnSync(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID"
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000
      });
      hardware = result.status === 0
        ? normalizeMachineIdentity(result.stdout)
        : "";
    }
  }
  return {
    hardware: machineIdentityToken(hardware),
    installation: machineIdentityToken(installation)
  };
}

function machineIdentityToken(identity) {
  return identity
    ? `machine:${createHash("sha256").update(identity).digest("hex")}`
    : null;
}

export function normalizeMachineIdentity(value) {
  const compact = String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "");
  if (
    !/^[0-9a-f]{32}$/.test(compact) ||
    /^0+$/.test(compact) ||
    /^f+$/.test(compact)
  ) {
    return "";
  }
  return compact;
}

function readProcessIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return fields[19] && bootId ? `proc:${bootId}:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) {
      return null;
    }
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    });
    const startedAt = result.status === 0 ? result.stdout.trim() : "";
    return /^\d+$/.test(startedAt) ? `windows:${startedAt}` : null;
  }
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000
  });
  const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
  return startedAt ? `ps:${startedAt}` : null;
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
    const snapshot = await readSnapshot(lockPath);
    const ownerSummary = describeLockOwner(snapshot);
    const recovery = snapshot
      ? "The lock fails closed across execution domains. Recovery requires quiescing all Kova " +
        "writers, verifying the owner process or host is dead, and re-reading the lock immediately " +
        "before removal to confirm its owner and fingerprint still match this timeout."
      : "The lock disappeared during the timeout; retry without removing any file.";
    throw new Error(
      `timed out waiting for Kova file lock: ${formatDiagnosticField(lockPath)}${ownerSummary}. ` +
      recovery
    );
  }
  await new Promise((resolve) => setTimeout(resolve, retryMs));
}

function describeLockOwner(snapshot) {
  if (!snapshot) {
    return " (owner disappeared during timeout)";
  }
  const owner = snapshot.owner;
  if (!owner || typeof owner !== "object") {
    return (
      ` (owner metadata invalid; ageMs=${Math.max(0, Math.round(snapshot.ageMs))}, ` +
      `fingerprint=${snapshot.fingerprint})`
    );
  }
  const domain = owner.executionDomainIdentity;
  const fields = [
    Number.isInteger(owner.pid) && owner.pid > 0 ? `pid=${owner.pid}` : null,
    ownerField("host", domain && typeof domain === "object" ? domain.host : null),
    domain && typeof domain === "object" && domain.hardwareMachine
      ? ownerField("hardwareMachine", domain.hardwareMachine)
      : null,
    domain && typeof domain === "object" && domain.installationMachine
      ? ownerField("installationMachine", domain.installationMachine)
      : null,
    `ageMs=${Math.max(0, Math.round(snapshot.ageMs))}`,
    `fingerprint=${snapshot.fingerprint}`
  ].filter(Boolean);
  return ` (owner ${fields.join(", ")})`;
}

function ownerField(name, value) {
  return typeof value === "string" && value
    ? `${name}=${formatDiagnosticField(value, MAX_DIAGNOSTIC_FIELD_LENGTH)}`
    : null;
}

function formatDiagnosticField(value, maxLength) {
  const characters = Array.from(String(value));
  const bounded =
    maxLength && characters.length > maxLength
      ? [...characters.slice(0, maxLength), ".", ".", "."]
      : characters;
  let encoded = '"';
  for (const character of bounded) {
    const codePoint = character.codePointAt(0);
    if (character === '"' || character === "\\") {
      encoded += `\\${character}`;
    } else if (codePoint >= 0x20 && codePoint <= 0x7e) {
      encoded += character;
    } else if (codePoint <= 0xffff) {
      encoded += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      const offset = codePoint - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      encoded += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  }
  return `${encoded}"`;
}
