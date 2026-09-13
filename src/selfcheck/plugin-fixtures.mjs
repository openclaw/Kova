import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { materializeLifecycleStepCommands } from "../run/phase-commands.mjs";
import { assertSafeScenarioCommand } from "../safety.mjs";
import { assertEqual, inlineCheck } from "./harness.mjs";

export async function pluginInstallIndexFixturesCheck(tmp) {
  return inlineCheck("plugin-install-index-fixtures", async () => {
    const manyPluginIds = Array.from({ length: 80 }, (_, index) => `kova-plugin-${index}`);
    const manyPluginState = JSON.parse(
      await readFile(join(repoRoot, "states", "many-bundled-plugins.json"), "utf8")
    );
    const manyPluginStep = manyPluginState.setup?.[0];
    assertEqual(manyPluginStep?.afterPhases?.includes("env-create"), true, "many-plugin setup precedes startup");
    assertEqual(manyPluginStep?.afterPhases?.includes("cold-start"), false, "many-plugin setup does not follow cold start");
    assertEqual(manyPluginStep?.commands?.length, 3, "many-plugin setup command count");
    assertEqual(
      manyPluginStep.commands[0],
      "node {kovaRoot}/support/assert-many-plugin-pressure-state.mjs --env {env} --expected-count 80 --minimum-openclaw-version 2026.6.1 --version-only",
      "many-plugin version preflight command"
    );
    assertEqual(
      manyPluginStep.commands[1],
      "ocm env exec {env} -- node {kovaRoot}/support/prepare-many-plugin-pressure-state.mjs --expected-count 80",
      "many-plugin prepare command"
    );
    assertEqual(
      manyPluginStep.commands[2],
      "node {kovaRoot}/support/assert-many-plugin-pressure-state.mjs --env {env} --expected-count 80 --minimum-openclaw-version 2026.6.1",
      "many-plugin assertion command"
    );
    const safetyArtifactDir = join(tmp, "many-bundled-plugins-safety");
    const materializedCommands = materializeLifecycleStepCommands(
      manyPluginStep,
      {
        sourceEnv: "",
        targetPlan: {
          repoPath: "",
          startSelector: "stable",
          upgradeSelector: "stable"
        }
      },
      "kova-safe-test",
      safetyArtifactDir
    );
    for (const command of materializedCommands) {
      assertSafeScenarioCommand(command, {}, "kova-safe-test", safetyArtifactDir);
    }

    const manyPluginHome = join(tmp, "many-bundled-plugins-home");
    const prepareResult = await runCommand(
      `${quoteShell(process.execPath)} ${quoteShell(join(repoRoot, "support", "prepare-many-plugin-pressure-state.mjs"))} --expected-count 80`,
      {
        env: { OPENCLAW_STATE_DIR: manyPluginHome },
        timeoutMs: 30000,
        maxOutputChars: 100000
      }
    );
    if (prepareResult.status !== 0) {
      throw new Error(
        `many-bundled-plugins setup failed: ${prepareResult.stderr.trim() || prepareResult.stdout.trim() || `exit ${prepareResult.status}`}`
      );
    }
    await assertPluginFixtureFiles(
      manyPluginHome,
      "plugins/installs.json",
      "many-bundled-plugins",
      manyPluginIds
    );
    await assertManyPluginPressureHelper(tmp, manyPluginIds);

    const pluginIndexState = JSON.parse(
      await readFile(join(repoRoot, "states", "plugin-index.json"), "utf8")
    );
    const pluginIndexCommands = pluginIndexState.setup?.flatMap((step) => step.commands ?? []) ?? [];
    assertEqual(pluginIndexCommands.length, 1, "plugin-index setup command count");
    const prefix = "ocm env exec {env} -- node -e '";
    const command = pluginIndexCommands[0];
    if (!command.startsWith(prefix) || !command.endsWith("'")) {
      throw new Error("plugin-index setup command is not an embedded Node script");
    }

    const pluginIndexHome = join(tmp, "plugin-index-home");
    const pluginIndexResult = await runCommand(
      `${quoteShell(process.execPath)} -e ${quoteShell(command.slice(prefix.length, -1))}`,
      {
        env: { OPENCLAW_HOME: pluginIndexHome },
        timeoutMs: 30000,
        maxOutputChars: 100000
      }
    );
    if (pluginIndexResult.status !== 0) {
      throw new Error(
        `plugin-index setup failed: ${pluginIndexResult.stderr.trim() || pluginIndexResult.stdout.trim() || `exit ${pluginIndexResult.status}`}`
      );
    }
    for (const relativePath of ["plugins/installs.json", ".openclaw/plugins/installs.json"]) {
      await assertPluginFixtureFiles(
        pluginIndexHome,
        relativePath,
        "plugin-index",
        ["kova-index-alpha", "kova-index-beta", "kova-index-gamma"]
      );
    }
  });
}

async function assertPluginFixtureFiles(home, relativePath, fixtureId, expectedIds) {
  const index = JSON.parse(await readFile(join(home, relativePath), "utf8"));
  assertEqual(Array.isArray(index.plugins), false, `${fixtureId} omits private plugins array`);
  const records = index.installRecords;
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw new Error(`${fixtureId} ${relativePath} has no installRecords object`);
  }
  assertEqual(
    Object.keys(records).sort().join("\n"),
    [...expectedIds].sort().join("\n"),
    `${fixtureId} install record ids`
  );
  for (const id of expectedIds) {
    const pluginDir = join(home, "fixture-plugins", id);
    assertEqual(records[id]?.source, "path", `${fixtureId} ${id} source`);
    assertEqual(records[id]?.sourcePath, pluginDir, `${fixtureId} ${id} source path`);
    assertEqual(records[id]?.installPath, pluginDir, `${fixtureId} ${id} install path`);
    assertEqual(records[id]?.version, "0.0.0", `${fixtureId} ${id} version`);
    assertEqual(records[id]?.spec, undefined, `${fixtureId} ${id} has no package spec`);

    const packageJson = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
    assertEqual(packageJson.name, `@kova/${id}`, `${fixtureId} ${id} package name`);
    assertEqual(packageJson.version, "0.0.0", `${fixtureId} ${id} package version`);
    assertEqual(
      packageJson.openclaw?.extensions?.join("\n"),
      "./index.js",
      `${fixtureId} ${id} package entry`
    );
    const manifest = JSON.parse(await readFile(join(pluginDir, "openclaw.plugin.json"), "utf8"));
    assertEqual(manifest.id, id, `${fixtureId} ${id} manifest id`);
    assertEqual(
      (await readFile(join(pluginDir, "index.js"), "utf8")).includes(`id: ${JSON.stringify(id)}`),
      true,
      `${fixtureId} ${id} runtime entry`
    );
  }
}

async function assertManyPluginPressureHelper(tmp, expectedIds) {
  const binDir = join(tmp, "many-plugin-pressure-bin");
  const fakeOcm = join(binDir, "ocm");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    fakeOcm,
    [
      "#!/usr/bin/env node",
      `const ids = ${JSON.stringify(expectedIds)};`,
      'const command = process.argv.slice(2).join(" ");',
      'if (command === "@kova-self-check -- --version") {',
      '  console.log("OpenClaw 2026.6.1 (selfcheck)");',
      "  process.exit(0);",
      "}",
      'if (command === "@kova-self-check -- doctor --fix --non-interactive") {',
      '  console.log("doctor repair complete");',
      "  process.exit(0);",
      "}",
      'if (command === "@kova-self-check -- plugins registry --refresh --json") {',
      "  console.log(JSON.stringify({ refreshed: true, registry: { installRecords: Object.fromEntries(ids.map((id) => [id, { source: \"path\" }])), plugins: ids.map((pluginId) => ({ pluginId })) } }));",
      "  process.exit(0);",
      "}",
      'if (command === "@kova-self-check -- plugins list --json") {',
      "  console.log(JSON.stringify({ plugins: ids.map((id) => ({ id })) }));",
      "  process.exit(0);",
      "}",
      'console.error(`unexpected fake ocm command: ${command}`);',
      "process.exit(1);"
    ].join("\n")
  );
  await chmod(fakeOcm, 0o755);

  const versionOnly = await runCommand(
    `${quoteShell(process.execPath)} ${quoteShell(join(repoRoot, "support", "assert-many-plugin-pressure-state.mjs"))} --env kova-self-check --expected-count 80 --minimum-openclaw-version 2026.6.1 --version-only`,
    {
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      timeoutMs: 30000,
      maxOutputChars: 100000
    }
  );
  assertEqual(versionOnly.status, 0, "many-plugin release preflight succeeds at the floor");
  const versionPayload = JSON.parse(versionOnly.stdout);
  assertEqual(versionPayload.ok, true, "many-plugin release preflight accepts the floor");
  assertEqual(versionPayload.doctorStatus, null, "many-plugin release preflight skips doctor");
  assertEqual(versionPayload.registryStatus, null, "many-plugin release preflight skips registry");
  assertEqual(versionPayload.listStatus, null, "many-plugin release preflight skips plugin list");

  const result = await runCommand(
    `${quoteShell(process.execPath)} ${quoteShell(join(repoRoot, "support", "assert-many-plugin-pressure-state.mjs"))} --env kova-self-check --expected-count 80 --minimum-openclaw-version 2026.6.1`,
    {
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      timeoutMs: 30000,
      maxOutputChars: 100000
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `many-plugin assertion helper failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`
    );
  }
  const payload = JSON.parse(result.stdout);
  assertEqual(payload.ok, true, "many-plugin assertion succeeds at the minimum release");
  assertEqual(payload.openclawVersion, "2026.6.1", "many-plugin target version");
  assertEqual(payload.minimumOpenClawVersion, "2026.6.1", "many-plugin minimum target version");
  assertEqual(payload.canonicalInstallRecordCount, 80, "many-plugin canonical record count");
  assertEqual(payload.registryPluginCount, 80, "many-plugin registry count");
  assertEqual(payload.listedPluginCount, 80, "many-plugin listed count");

  const belowFloor = await runCommand(
    `${quoteShell(process.execPath)} ${quoteShell(join(repoRoot, "support", "assert-many-plugin-pressure-state.mjs"))} --env kova-self-check --expected-count 80 --minimum-openclaw-version 2026.6.2`,
    {
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      timeoutMs: 30000,
      maxOutputChars: 100000
    }
  );
  assertEqual(belowFloor.status, 1, "many-plugin unsupported release exits nonzero");
  const blocked = JSON.parse(belowFloor.stdout);
  assertEqual(blocked.ok, false, "many-plugin unsupported release is not accepted");
  assertEqual(blocked.failureDomain, "kova-harness", "many-plugin release floor is harness-owned");
  assertEqual(blocked.recordStatus, "BLOCKED", "many-plugin unsupported release blocks the record");
  assertEqual(blocked.openclawVersion, "2026.6.1", "many-plugin blocked target version");
  assertEqual(blocked.minimumOpenClawVersion, "2026.6.2", "many-plugin blocked minimum version");
  assertEqual(blocked.doctorStatus, null, "many-plugin unsupported release skips doctor");
  assertEqual(blocked.registryStatus, null, "many-plugin unsupported release skips registry refresh");
  assertEqual(blocked.listStatus, null, "many-plugin unsupported release skips plugin list");
}
