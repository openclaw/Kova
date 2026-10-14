import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareWorkspace, populateWorkspace, checkWorkspace } from "../support/persona/workspace-content.mjs";

const digest = (content) => createHash("sha256").update(content).digest("hex");
const git = (root, ...args) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) {
  const state = await realpath(await mkdtemp(join(tmpdir(), "kova-persona-workspace-")));
  t.after(() => rm(state, { recursive: true, force: true }));
  const workspace = join(state, "workspace"); await mkdir(workspace);
  const key = "agent:main:workspace-fixture", sessionId = "saved-workspace-session";
  const repo = await prepareWorkspace({ state, workspace, key });
  const root = join(state, "managed"); git(repo, "worktree", "add", "-b", "workspace-fixture", root);
  const session = { key, sessionId, spawnedCwd: root, workspaceDir: root, worktree: { id: "managed-id", repoRoot: repo, canonicalWorkspaceDir: repo, branch: "workspace-fixture" } };
  const record = { id: "managed-id", repoRoot: repo, path: root, branch: "workspace-fixture", ownerKind: "session", ownerId: key };
  const calls = [];
  const rpc = async ({ method, params }) => {
    calls.push(method);
    if (method === "config.get") return { path: join(state, "openclaw.json") };
    if (method === "sessions.describe") return { session };
    if (method === "worktrees.list") return { worktrees: [record] };
    if (method === "sessions.files.list") {
      const entries = await readdir(join(root, params.path), { withFileTypes: true });
      return { root, gitCheckout: true, browser: { entries: entries.map((entry) => ({ path: params.path ? `${params.path}/${entry.name}` : entry.name, kind: entry.isDirectory() ? "directory" : "file" })) } };
    }
    if (method === "sessions.files.get") {
      const content = await readFile(join(root, params.path), "utf8");
      return { root, file: { content, contentEncoding: "utf8", hash: digest(content) } };
    }
    if (method === "sessions.files.set") {
      const path = join(root, params.path), before = await readFile(path);
      assert.equal(params.expectedHash, digest(before));
      await writeFile(path, params.content);
      return { sessionKey: key, root, file: { hash: digest(params.content) } };
    }
    if (method === "sessions.diff") return { root, files: git(root, "diff", "--name-only").split("\n").filter(Boolean).map((path) => ({ path, status: "modified", patch: git(root, "diff", "--", path) })) };
    assert.fail(method);
  };
  return { state, workspace, key, sessionId, repo, root, session, record, calls, rpc };
}

test("workspace edits retain the managed binding and expose real bytes and hashes", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await checkWorkspace({ ...f, expected: { kind: "worktree", state: f.state } }), { key: f.key, workspaceDir: f.root });
  const result = await populateWorkspace(f);
  assert.deepEqual(result, { key: f.key, sessionId: f.sessionId, filePath: "notes.txt", fileHash: digest(await readFile(join(f.root, "notes.txt"))), htmlPath: "index.html" });
  assert.equal(f.calls.filter((method) => method === "sessions.files.set").length, 4);
  assert.match(await readFile(join(f.root, "index.html"), "utf8"), /href="\.\/style\.css"/);
  assert.match(await readFile(join(f.root, "style.css"), "utf8"), /font-family: sans-serif/);
  assert.deepEqual(await checkWorkspace({ ...f, expected: { kind: "worktree", state: f.state } }), { key: f.key, workspaceDir: f.root }, "the binding trait survives the later changes trait");
  await assert.rejects(populateWorkspace(f), /bytes differ/, "a repeated population cannot overwrite changed content");
  await writeFile(join(f.root, "assets/mark.svg"), "<svg/>\n");
  await assert.rejects(checkWorkspace({ ...f, expected: { kind: "changes", state: f.state } }), /bytes differ/, "the relative SVG must retain its saved bytes");
});

test("workspace checks reject source paths and wrong owners before reading or writing files", async (t) => {
  const f = await fixture(t);
  f.record.path = join(tmpdir(), "different-persona", "managed");
  await assert.rejects(populateWorkspace(f), /outside the current environment/);
  assert.ok(!f.calls.some((method) => method.startsWith("sessions.files.")));
  f.record.path = f.root; f.record.ownerId = "agent:main:another-session";
  await assert.rejects(checkWorkspace({ ...f, expected: { kind: "worktree", state: f.state } }), /does not own/);
  f.record.ownerId = f.key; f.session.worktree.canonicalWorkspaceDir = join(tmpdir(), "old-persona", "repository");
  await assert.rejects(checkWorkspace({ ...f, expected: { kind: "worktree", state: f.state } }), /outside the current environment/);
  f.session.worktree.canonicalWorkspaceDir = f.repo;
  const other = await fixture(t);
  await writeFile(join(f.root, ".git"), `gitdir: ${join(other.repo, ".git")}\n`);
  await assert.rejects(checkWorkspace({ ...f, expected: { kind: "worktree", state: f.state } }), /outside the current environment/);
  assert.ok(!f.calls.includes("sessions.files.get"));
});

test("workspace preparation refuses existing repositories and escaping parent links", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareWorkspace(f), { code: "EEXIST" });
  const state = await mkdtemp(join(tmpdir(), "kova-persona-linked-"));
  const outside = await mkdtemp(join(tmpdir(), "kova-persona-outside-"));
  t.after(() => Promise.all([rm(state, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, join(state, "kova-persona"));
  await assert.rejects(prepareWorkspace({ state, key: f.key }), /outside the current environment/);
  assert.deepEqual(await readdir(outside), []);
});
