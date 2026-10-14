import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { quoteShell, runCommand } from "../../src/commands.mjs";
import { EntryError } from "./common.mjs";

const filePath = "notes.txt";
const htmlPath = "index.html";
const assetPath = "assets/mark.svg";
const baselineText = "Workspace notes\nStatus: draft\n";
const changedText = "Workspace notes\nStatus: reviewed\nThe preview includes a relative SVG image.\n";
const baselineHtml = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Workspace draft</title></head><body><p>Draft preview.</p></body></html>\n';
const changedHtml = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Workspace preview</title></head><body><h1>Workspace preview</h1><img src="assets/mark.svg" alt="Blue square"><p>The notes have been reviewed.</p></body></html>\n';
const baselineAsset = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#888888"/></svg>\n';
const changedAsset = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#2458a6"/></svg>\n';
const files = [
  { path: filePath, baseline: baselineText, content: changedText },
  { path: htmlPath, baseline: baselineHtml, content: changedHtml },
  { path: assetPath, baseline: baselineAsset, content: changedAsset }
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requiredText = (value, description) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${description} is absent`);
  return value;
};

function inside(root, path, description) {
  if (!isAbsolute(path)) throw new Error(`${description} is not absolute`);
  const local = relative(root, path);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`${description} points outside the current environment`);
  }
}

async function ownedPath(state, path, description) {
  inside(state, path, description);
  const actual = await realpath(path);
  inside(state, actual, description);
  return actual;
}

async function git(repo, args) {
  const command = [
    "git", "-C", repo,
    "-c", "user.name=Kova",
    "-c", "user.email=kova@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${join(repo, ".git", "hooks")}`,
    "-c", "core.autocrlf=false",
    "-c", "gc.auto=0",
    "-c", "core.fsmonitor=false",
    ...args
  ];
  const result = await runCommand(command.map(quoteShell).join(" "), { timeoutMs: 30000, maxOutputChars: 16000 });
  if (result.timedOut) throw new EntryError("workspace Git command timed out", 3);
  if (result.status || result.signal || result.outputBudget?.truncated) {
    throw new Error(`workspace Git command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** Create only the repository that the product will use to create its managed checkout. */
export async function prepareWorkspace({ state, workspace, key }) {
  requiredText(key, "session key");
  const stateRoot = await realpath(requiredText(state, "environment state directory"));
  if (workspace !== undefined) await ownedPath(stateRoot, workspace, "agent workspace");
  let parent = stateRoot;
  for (const part of ["kova-persona", "repositories"]) {
    parent = join(parent, part);
    try { await mkdir(parent); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await ownedPath(stateRoot, parent, "workspace repository directory");
  }
  const repo = join(parent, hash(key));
  // An existing directory is not an invitation to replace another build's files.
  await mkdir(repo);
  await mkdir(join(repo, "assets"));
  for (const file of files) await writeFile(join(repo, file.path), file.baseline, { flag: "wx" });
  await writeFile(join(repo, ".gitattributes"), "* text eol=lf\n", { flag: "wx" });
  await git(repo, ["init", "--initial-branch=main", "--template="]);
  await git(repo, ["add", "--", ".gitattributes", ...files.map((file) => file.path)]);
  await git(repo, ["commit", "--quiet", "-m", "docs: add workspace baseline"]);
  return repo;
}

/** Request factories keep the builder and the schema check on the same payloads. */
export function workspaceRequests(key) {
  return {
    config: { method: "config.get", params: {} },
    describe: { method: "sessions.describe", params: { key } },
    worktrees: { method: "worktrees.list", params: {} },
    list: { method: "sessions.files.list", params: { sessionKey: key, path: "" } },
    assetsList: { method: "sessions.files.list", params: { sessionKey: key, path: "assets" } },
    files: files.map(({ path }) => ({ method: "sessions.files.get", params: { sessionKey: key, path } })),
    diff: { method: "sessions.diff", params: { sessionKey: key, scope: "uncommitted" } }
  };
}

export function workspaceSetRequest({ key, path, content, expectedHash }) {
  return { method: "sessions.files.set", params: { sessionKey: key, path, content, expectedHash } };
}

const request = (rpc, descriptor) => rpc(descriptor);

async function readWorkspace({ rpc, key, state, sessionId }) {
  const requests = workspaceRequests(key);
  const [config, description, registry] = await Promise.all([
    request(rpc, requests.config), request(rpc, requests.describe), request(rpc, requests.worktrees)
  ]);
  const configPath = requiredText(config?.path, "Gateway configuration path");
  if (!isAbsolute(configPath)) throw new Error("Gateway configuration path is not absolute");
  const stateRoot = await realpath(dirname(configPath));
  if (state !== undefined && stateRoot !== await realpath(state)) {
    throw new Error("Gateway workspace belongs to a different environment");
  }
  const session = description?.session;
  requiredText(session?.sessionId, "persisted session id");
  if (session.key !== key || (sessionId !== undefined && session.sessionId !== sessionId)) {
    throw new Error("workspace session identity changed");
  }
  const worktreeId = requiredText(session.worktree?.id, "managed worktree id");
  const matches = registry?.worktrees?.filter((entry) => entry.id === worktreeId) ?? [];
  if (matches.length !== 1 || matches[0].removedAt !== undefined || matches[0].ownerKind !== "session" || matches[0].ownerId !== key) {
    throw new Error("session does not own one active managed worktree");
  }
  const record = matches[0];
  const root = await ownedPath(stateRoot, requiredText(record.path, "managed worktree path"), "managed worktree");
  const repo = await ownedPath(stateRoot, requiredText(record.repoRoot, "managed repository path"), "managed repository");
  if (await realpath(requiredText(session.worktree.repoRoot, "session repository path")) !== repo || session.worktree.branch !== record.branch) {
    throw new Error("session and managed worktree repository differ");
  }
  if (session.worktree.canonicalWorkspaceDir !== undefined && await ownedPath(stateRoot, session.worktree.canonicalWorkspaceDir, "canonical workspace") !== repo) {
    throw new Error("canonical workspace differs from its repository");
  }
  // Check persisted roots before asking the file handler to open a workspace.
  for (const path of [session.spawnedCwd, session.spawnedWorkspaceDir, session.workspaceDir].filter((path) => path !== undefined)) {
    if (await ownedPath(stateRoot, path, "session workspace") !== root) throw new Error("session workspace root differs from its managed worktree");
  }
  const listing = await request(rpc, requests.list);
  if (await ownedPath(stateRoot, requiredText(listing?.root, "Gateway workspace root"), "Gateway workspace") !== root || listing.gitCheckout !== true) {
    throw new Error("Gateway workspace is not the managed Git checkout");
  }
  // Absolute Git links can survive a copied database even when display paths relocate.
  const commonDir = await git(root, ["rev-parse", "--git-common-dir"]);
  if (await ownedPath(stateRoot, resolve(root, commonDir), "workspace Git directory") !== await realpath(join(repo, ".git"))) {
    throw new Error("workspace Git metadata belongs to a different repository");
  }
  return { requests, session, root, listing };
}

function verifiedFile(result, root, expected) {
  if (result?.root !== root || result.file?.missing || result.file?.contentEncoding !== "utf8" || result.file.content !== expected) {
    throw new Error("Gateway workspace file bytes differ from the saved content");
  }
  const actualHash = hash(Buffer.from(result.file.content, "utf8"));
  if (result.file.hash !== actualHash) throw new Error("Gateway workspace file hash differs from its bytes");
  return actualHash;
}

/** Populate through hash-checked product edits to files in the actual managed checkout. */
export async function populateWorkspace({ rpc, key, state }) {
  const { root, requests } = await readWorkspace({ rpc, key, state });
  for (const [index, file] of files.entries()) {
    const current = await request(rpc, requests.files[index]);
    const expectedHash = verifiedFile(current, root, file.baseline);
    const updated = await request(rpc, workspaceSetRequest({ key, path: file.path, content: file.content, expectedHash }));
    if (updated?.sessionKey !== key || updated.root !== root || updated.file?.hash !== hash(file.content)) {
      throw new Error("Gateway workspace edit did not return the saved file hash");
    }
  }
  return checkWorkspace({ rpc, key, expected: { kind: "changes", state } });
}

/** Read-only checks reject stale source paths after persona import instead of repairing them. */
export async function checkWorkspace({ rpc, key, expected = {} }) {
  if (expected.kind !== "worktree" && expected.kind !== "changes") throw new Error("workspace check kind must be worktree or changes");
  const { root, requests, session, listing } = await readWorkspace({ rpc, key, state: expected.state, sessionId: expected.sessionId });
  if (expected.kind === "worktree") return { key: session.key, workspaceDir: root };
  const responses = await Promise.all(requests.files.map((read) => request(rpc, read)));
  const hashes = responses.map((response, index) => verifiedFile(response, root, files[index].content));
  const diff = await request(rpc, requests.diff);
  if (diff?.unavailableReason || diff?.root !== root || diff?.truncated || !Array.isArray(diff?.files)) throw new Error("Gateway workspace diff is unavailable or incomplete");
  const assetsListing = await request(rpc, requests.assetsList);
  for (const [page, paths] of [[listing, [filePath, htmlPath]], [assetsListing, [assetPath]]]) {
    if (page?.root !== root || page?.browser?.truncated || paths.some((path) => !page?.browser?.entries?.some((entry) => entry.path === path && entry.kind === "file"))) {
      throw new Error("Gateway workspace browser omitted saved files");
    }
  }
  for (const file of files) {
    const entry = diff.files.find((entry) => entry.path === file.path);
    const addedLine = file.content.split("\n").find((line) => !file.baseline.split("\n").includes(line));
    if (entry?.status !== "modified" || entry.binary || entry.truncated || typeof entry.patch !== "string" || !entry.patch.includes(`+${addedLine}`)) {
      throw new Error(`Gateway diff does not contain the saved edit to ${file.path}`);
    }
  }
  return { key: session.key, sessionId: session.sessionId, filePath, fileHash: hashes[0], htmlPath };
}
