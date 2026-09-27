import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kovaHome } from "../paths.mjs";

const commandOwnerDir = join(kovaHome, "libexec");
const commandOwner = join(commandOwnerDir, "resource-command-owner");

export function prepareLinuxCommandOwner() {
  if (process.platform !== "linux") {
    return {
      id: "linux-command-owner",
      required: false,
      status: "INFO",
      message: "Linux-only CPU accounting owner is not needed on this platform"
    };
  }
  const source = fileURLToPath(new URL("../../support/resource-command-owner.c", import.meta.url));
  const temporary = `${commandOwner}.${process.pid}`;
  mkdirSync(commandOwnerDir, { recursive: true });
  rmSync(temporary, { force: true });
  const compiled = spawnSync("cc", ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", temporary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (compiled.status !== 0) {
    rmSync(temporary, { force: true });
    return {
      id: "linux-command-owner",
      required: true,
      status: "FAIL",
      message: `Linux CPU accounting setup requires a C compiler: ${compiled.stderr || compiled.stdout || compiled.error?.message || "cc failed"}`
    };
  }
  chmodSync(temporary, 0o700);
  renameSync(temporary, commandOwner);
  return {
    id: "linux-command-owner",
    required: true,
    status: "PASS",
    path: commandOwner,
    message: commandOwner
  };
}

export function linuxCommandOwnerInvocation(node, args) {
  try {
    accessSync(commandOwner, constants.X_OK);
  } catch {
    throw new Error("Linux CPU accounting is not prepared; run kova setup --ci");
  }
  return { file: commandOwner, args: [node, ...args] };
}
