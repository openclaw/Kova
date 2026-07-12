import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runWithCommandEnv } from "./commands.mjs";

export function createSelfCheckScope() {
  const suffix = `${process.pid.toString(36)}-${randomBytes(6).toString("hex")}`;
  const id = `kova-self-check-${suffix}`;
  return Object.freeze({
    id,
    envName: id,
    runtimeName: `kova-local-self-check-${suffix}`,
    sessionPrefix: `${id}-session`
  });
}

export async function createSelfCheckWorkspace(scope, parentDir = tmpdir()) {
  const root = await mkdtemp(join(parentDir, `${scope.id}-`));
  return Object.freeze({
    ownerId: scope.id,
    root,
    kovaHome: join(root, "kova-home")
  });
}

export async function cleanupSelfCheckWorkspace(scope, workspace) {
  if (
    workspace?.ownerId !== scope.id ||
    !basename(workspace?.root ?? "").startsWith(`${scope.id}-`)
  ) {
    throw new Error(`refusing to clean self-check workspace not owned by ${scope.id}`);
  }
  await rm(workspace.root, { recursive: true, force: true });
}

export async function runInSelfCheckScope(callback, parentDir = tmpdir()) {
  const scope = createSelfCheckScope();
  const workspace = await createSelfCheckWorkspace(scope, parentDir);
  try {
    return await runWithCommandEnv(
      { KOVA_HOME: workspace.kovaHome },
      () => callback({ scope, workspace })
    );
  } finally {
    await cleanupSelfCheckWorkspace(scope, workspace);
  }
}
