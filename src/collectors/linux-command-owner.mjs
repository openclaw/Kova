import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { repoRoot } from "../paths.mjs";

const payloadHashes = {
  arm64: "cd0c4364a99ed53cf5c14d15d93a6564ba252dcff6a8bb85258a3af8a48fa5dd",
  x64: "b6fac1fb18070edfea1070e8682e8c3091d875690d326c16e79f92f89151e83d"
};
const commandOwnerProbeTimeoutMs = 5000;
const commandOwners = new Map();
let cleanupRegistered = false;

export function linuxCommandOwnerInvocation(node, args, home, env) {
  const expectedHash = payloadHashes[process.arch];
  if (!expectedHash) {
    // Kova already accounted commands on every Linux architecture. Keep that
    // direct helper path until this architecture has a bundled subreaper.
    return { file: node, args };
  }
  const commandOwnerDir = resolve(home, "libexec");
  if (!commandOwners.has(commandOwnerDir)) {
    const payloadPath = join(repoRoot, "support", "bin", `linux-${process.arch}`, "resource-command-owner.b64");
    const payload = gunzipSync(Buffer.from(readFileSync(payloadPath, "utf8"), "base64"));
    const actualHash = createHash("sha256").update(payload).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Linux CPU accounting helper failed integrity verification for ${process.arch}`);
    }
    const commandOwner = join(commandOwnerDir, `resource-command-owner-${expectedHash.slice(0, 12)}-${randomUUID()}`);
    try {
      mkdirSync(commandOwnerDir, { recursive: true, mode: 0o700 });
      writeFileSync(commandOwner, payload, { flag: "wx", mode: 0o700 });
    } catch {
      // Filesystem policy must not remove the existing direct accounting path.
      rmSync(commandOwner, { force: true });
      commandOwners.set(commandOwnerDir, null);
      return { file: node, args };
    }
    const probe = spawnSync(commandOwner, [node, "-e", ""], {
      env,
      stdio: "ignore",
      timeout: commandOwnerProbeTimeoutMs,
      killSignal: "SIGKILL"
    });
    const unavailable = probe.error?.code === "EACCES" || probe.error?.code === "ETIMEDOUT" || probe.status === 70;
    if (unavailable) {
      // noexec homes and restricted kernels worked before the native owner.
      // Preserve the direct helper instead of turning host policy fatal.
      rmSync(commandOwner, { force: true });
      commandOwners.set(commandOwnerDir, null);
    } else if (probe.error || probe.status !== 0) {
      rmSync(commandOwner, { force: true });
      throw probe.error ?? new Error(`Linux CPU accounting helper probe exited ${probe.status}`);
    } else {
      commandOwners.set(commandOwnerDir, commandOwner);
      if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once("exit", removeCommandOwners);
      }
    }
  }
  const commandOwner = commandOwners.get(commandOwnerDir);
  return commandOwner ? { file: commandOwner, args: [node, ...args] } : { file: node, args };
}

function removeCommandOwners() {
  for (const commandOwner of commandOwners.values()) {
    if (commandOwner) {
      rmSync(commandOwner, { force: true });
    }
  }
}
