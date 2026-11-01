import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("release rehearsal accepts current main and rejects publishing, stale refs and version drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "kova-release-dry-run-"));
  const script = resolve("scripts/verify-release-dry-run.sh");
  const sha = "a".repeat(40);
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.2" }));
    writeFileSync(join(dir, "git"), `#!/bin/sh\n[ "$*" = "rev-parse origin/main" ] || exit 1\nprintf '%s\\n' '${sha}'\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DRY_RUN: "true", GITHUB_REF: "refs/heads/main", REQUESTED_VERSION: "0.2.2", GITHUB_SHA: sha };
    const run = overrides => spawnSync("bash", [script], { cwd: dir, env: { ...env, ...overrides }, encoding: "utf8" });
    assert.equal(run({}).status, 0);
    for (const overrides of [
      { DRY_RUN: "false" },
      { GITHUB_REF: "refs/heads/topic" },
      { GITHUB_REF: "refs/tags/v0.2.2" },
      { REQUESTED_VERSION: "0.2.3" },
      { GITHUB_SHA: "b".repeat(40) },
    ]) {
      const result = run(overrides);
      assert.notEqual(result.status, 0, JSON.stringify(overrides));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
