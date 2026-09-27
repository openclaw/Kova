import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { kovaHome, repoRoot } from "../paths.mjs";

const payloadHashes = {
  arm64: "1e3a2a4fabdf3589fe74ab500f49ac98c4a074c0bad1756b3839d373e696c1f7",
  x64: "2e1026e711769fbdb02d1f7ef320937863bc70ea1c29e884abaa43a9c709561a"
};
let commandOwner;

export function linuxCommandOwnerInvocation(node, args) {
  const expectedHash = payloadHashes[process.arch];
  if (!expectedHash) {
    // Kova already accounted commands on every Linux architecture. Keep that
    // direct helper path until this architecture has a bundled subreaper.
    return { file: node, args };
  }
  if (!commandOwner) {
    const payloadPath = join(repoRoot, "support", "bin", `linux-${process.arch}`, "resource-command-owner.b64");
    const payload = gunzipSync(Buffer.from(readFileSync(payloadPath, "utf8"), "base64"));
    const actualHash = createHash("sha256").update(payload).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Linux CPU accounting helper failed integrity verification for ${process.arch}`);
    }
    const commandOwnerDir = join(kovaHome, "libexec");
    mkdirSync(commandOwnerDir, { recursive: true, mode: 0o700 });
    commandOwner = join(commandOwnerDir, `resource-command-owner-${expectedHash.slice(0, 12)}-${randomUUID()}`);
    writeFileSync(commandOwner, payload, { flag: "wx", mode: 0o700 });
    process.once("exit", removeCommandOwner);
  }
  return { file: commandOwner, args: [node, ...args] };
}

function removeCommandOwner() {
  if (commandOwner) {
    rmSync(commandOwner, { force: true });
  }
}
