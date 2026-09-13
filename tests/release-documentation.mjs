#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.argv[2], "usage: node tests/release-documentation.mjs <installed-package>");
const root = await realpath(process.argv[2]);
const readmePath = join(root, "README.md");
const readme = await readFile(readmePath, "utf8");
const links = [
  ...Array.from(readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g), (match) => match[1]),
  ...Array.from(readme.matchAll(/\b(?:src|href)=["']([^"']+)["']/g), (match) => match[1])
];
const paths = new Set();
for (const link of links) {
  const url = new URL(link, pathToFileURL(readmePath));
  if (url.protocol !== "file:") continue;
  url.hash = "";
  url.search = "";
  paths.add(fileURLToPath(url));
}

const failures = [];
for (const path of paths) {
  try {
    const resolved = await realpath(path);
    const local = relative(root, resolved);
    assert.ok(local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local), "link escapes the package");
    assert.ok((await stat(resolved)).isFile(), "link is not a file");
  } catch (error) {
    failures.push(`${relative(root, path)}: ${error.message}`);
  }
}
assert.deepEqual(failures, [], "installed README links must resolve without the source checkout");
console.log(`PASS: ${paths.size} local README documentation and image links resolve in the installed package`);
