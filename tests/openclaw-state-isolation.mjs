import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCommand, quoteShell, runCommand, runWithCommandEnv } from "../src/commands.mjs";
import { runInSelfCheckScope } from "../src/selfcheck-scope.mjs";

const helper = new URL("../support/configure-openclaw-mock-auth.mjs", import.meta.url).pathname;
const args = [helper, "--port", "12345", "--skip-health-check"];

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "kova-state-regression-"));
  const production = join(root, "production");
  await mkdir(production);
  const originals = { "openclaw.json": '{"production":true}\n', ".env": "PRODUCTION_SENTINEL=original\n" };
  for (const [file, content] of Object.entries(originals)) await writeFile(join(production, file), content);
  const inherited = {
    OPENCLAW_HOME: join(root, "service-home"),
    OPENCLAW_STATE_DIR: production,
    OPENCLAW_CONFIG_PATH: join(production, "openclaw.json"),
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_PROFILE: "production",
    OPENCLAW_GATEWAY_TOKEN: "synthetic-production-token",
    OCM_ACTIVE_ENV: "durable-user",
    OCM_ACTIVE_ENV_ROOT: production,
    INVOCATION_ID: "synthetic-systemd-invocation",
    NOTIFY_SOCKET: "/synthetic-service-notify",
    KOVA_OPENCLAW_SCOPE_OWNER: "inherited-parent-run"
  };
  try {
    await callback({ root, production, inherited });
  } finally {
    try {
      for (const [file, content] of Object.entries(originals)) {
        assert.equal(await readFile(join(production, file), "utf8"), content, `production ${file} must stay byte-identical`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("self-check child environment isolates inherited production paths and service identity", async () => {
  await fixture(async ({ root, inherited }) => {
    const saved = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
    Object.assign(process.env, inherited);
    try {
      await runInSelfCheckScope(async ({ workspace }) => {
        const home = join(workspace.root, "openclaw-home");
        await runWithCommandEnv({ OPENCLAW_HOME: home }, async () => {
          const probe = checkCommand(process.execPath, ["-e", 'console.log(JSON.stringify(process.env))']);
          assert.equal(probe.status, 0, probe.stderr);
          const env = JSON.parse(probe.stdout);
          assert.notEqual(env.KOVA_OPENCLAW_SCOPE_OWNER, inherited.KOVA_OPENCLAW_SCOPE_OWNER);
          for (const key of Object.keys(inherited).filter((key) => key !== "OPENCLAW_HOME" && key !== "KOVA_OPENCLAW_SCOPE_OWNER")) {
            assert.equal(env[key], undefined, `checkCommand inherited ${key}`);
          }
          const result = await runCommand([process.execPath, ...args].map(quoteShell).join(" "));
          assert.equal(result.status, 0, result.stderr);
          const config = JSON.parse(await readFile(join(home, ".openclaw/openclaw.json"), "utf8"));
          assert.equal(config.models.providers.openai.baseUrl, "http://127.0.0.1:12345/v1");
          assert.match(await readFile(join(home, ".openclaw/.env"), "utf8"), /OPENAI_API_KEY=kova-mock-key/);
        });
      }, root);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

test("mock writer refuses inherited production service targets before either write", async () => {
  await fixture(async ({ inherited, production }) => {
    const result = spawnSync(process.execPath, args, { env: { ...process.env, ...inherited }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isolated scopes/);
    assert.ok(result.stderr.includes(production));
  });
});

test("mock writer refuses an unmarked scope even without service markers", async () => {
  await fixture(async ({ root, production }) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCLAW_")));
    const result = spawnSync(process.execPath, args, {
      env: { ...env, KOVA_HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: production }, encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isolated scopes/);
  });
});

test("guard validates both destinations, symlinks, hardlinks, and current-run ownership", async () => {
  const { assertOwnedOpenClawWrite, ownedOpenClawPaths } = await import("../support/openclaw-scope.mjs");
  const { symlink, link } = await import("node:fs/promises");
  await fixture(async ({ root, production }) => {
    await runInSelfCheckScope(async ({ workspace }) => {
      const home = join(workspace.root, "home");
      const stateDir = join(home, ".openclaw");
      await mkdir(stateDir, { recursive: true });
      const env = { HOME: root, OPENCLAW_HOME: home };
      assert.doesNotThrow(() => ownedOpenClawPaths(env));
      assert.throws(() => ownedOpenClawPaths({ ...env, OPENCLAW_STATE_DIR: production }), /isolated scopes/);
      assert.throws(() => ownedOpenClawPaths({ ...env, OPENCLAW_CONFIG_PATH: join(production, "openclaw.json") }), /isolated scopes/);
      assert.throws(() => ownedOpenClawPaths({ ...env, OPENCLAW_SERVICE_KIND: "gateway" }), /service identity/);
      assert.throws(() => ownedOpenClawPaths({ ...env, OPENCLAW_SERVICE_MARKER: "" }), /service identity/);
      assert.throws(() => ownedOpenClawPaths({ ...env, KOVA_OPENCLAW_SCOPE_OWNER: "another-run" }), /another Kova run/);
      const config = join(stateDir, "openclaw.json");
      await symlink(join(production, "openclaw.json"), config);
      assert.throws(() => ownedOpenClawPaths(env), /isolated scopes/);
      await rm(config);
      await link(join(production, "openclaw.json"), config);
      assert.throws(() => ownedOpenClawPaths(env), /hard links/);
      await rm(config);
      await symlink(join(production, "not-yet-created"), join(stateDir, ".env"));
      assert.throws(() => ownedOpenClawPaths(env), /isolated scopes/);
      assert.doesNotThrow(() => assertOwnedOpenClawWrite(join(stateDir, "safe.json"), env));
    }, root);
  });
});

test("guard rejects a marked target configured by a user service or drop-in", async () => {
  const { ownedOpenClawPaths } = await import("../support/openclaw-scope.mjs");
  await fixture(async ({ root }) => {
    await runInSelfCheckScope(async ({ workspace }) => {
      const home = join(workspace.root, "home");
      const config = join(home, ".openclaw/openclaw.json");
      const serviceDir = join(root, ".config/systemd/user/openclaw-gateway.service.d");
      await mkdir(serviceDir, { recursive: true });
      await writeFile(join(serviceDir, "paths.conf"), `[Service]\nEnvironment="OPENCLAW_CONFIG_PATH=${config}"\n`);
      assert.throws(() => ownedOpenClawPaths({ HOME: root, OPENCLAW_HOME: home }), /configured by service.*paths.conf/);
      await rm(serviceDir, { recursive: true });
      const launchDir = join(root, "Library/LaunchAgents");
      await mkdir(launchDir, { recursive: true });
      await writeFile(join(launchDir, "openclaw.plist"), `<key>OPENCLAW_STATE_DIR</key><string>${join(home, ".openclaw")}</string>`);
      assert.throws(() => ownedOpenClawPaths({ HOME: root, OPENCLAW_HOME: home }), /configured by service.*openclaw.plist/);
    }, root);
  });
});

test("OCM scope markers require the current run and clones receive a new owner", async () => {
  const { markOpenClawScope, ownedOpenClawPaths } = await import("../support/openclaw-scope.mjs");
  const { cp } = await import("node:fs/promises");
  await fixture(async ({ root }) => {
    const source = join(root, "source-env");
    const clone = join(root, "clone-env");
    const env = { HOME: root, OPENCLAW_HOME: source };
    markOpenClawScope(source, "source-run", { HOME: root });
    assert.throws(() => ownedOpenClawPaths(env), /another Kova run/);
    assert.throws(() => ownedOpenClawPaths({ ...env, KOVA_OPENCLAW_SCOPE_OWNER: "stale-run" }), /another Kova run/);
    assert.doesNotThrow(() => ownedOpenClawPaths({ ...env, KOVA_OPENCLAW_SCOPE_OWNER: "source-run" }));
    await cp(source, clone, { recursive: true });
    markOpenClawScope(clone, "clone-run", { HOME: root });
    assert.doesNotThrow(() => ownedOpenClawPaths({ HOME: root, OPENCLAW_HOME: clone, KOVA_OPENCLAW_SCOPE_OWNER: "clone-run" }));
    assert.throws(() => ownedOpenClawPaths({ ...env, KOVA_OPENCLAW_SCOPE_OWNER: "clone-run" }), /another Kova run/);
  });
});
