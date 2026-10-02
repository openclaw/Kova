import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { materializeLifecycleStepCommands } from "../run/phase-commands.mjs";
import { assertSafeScenarioCommand } from "../safety.mjs";
import { assertEqual, fileExists, inlineCheck } from "./harness.mjs";

export async function pluginInstallIndexFixturesCheck(tmp) {
  return inlineCheck("plugin-install-index-fixtures", async () => {
    const manyPluginIds = Array.from({ length: 80 }, (_, index) => `kova-plugin-${index}`);
    const manyPluginState = JSON.parse(
      await readFile(join(repoRoot, "states", "many-bundled-plugins.json"), "utf8")
    );
    const manyPluginStep = manyPluginState.setup?.[0];
    assertEqual(manyPluginStep?.afterPhases?.includes("env-create"), true, "many-plugin setup precedes startup");
    assertEqual(manyPluginStep?.afterPhases?.includes("cold-start"), false, "many-plugin setup does not follow cold start");
    assertEqual(manyPluginStep?.commands?.length, 83, "many-plugin setup command count");
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
      manyPluginStep.commands.at(-1),
      "node {kovaRoot}/support/assert-many-plugin-pressure-state.mjs --env {env} --expected-count 80 --minimum-openclaw-version 2026.6.1",
      "many-plugin assertion command"
    );
    assertEqual(
      manyPluginStep.commands.slice(2, -1).map((command) => Number(command.match(/--plugin-index (\d+)$/)?.[1])).join(","),
      Array.from({ length: 80 }, (_, index) => index).join(","),
      "each prepared plugin has its own ordered runner command"
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
    assertEqual(await fileExists(join(manyPluginHome, "plugins", "installs.json")), false, "pressure setup does not create retired installation state");
    for (const id of manyPluginIds) {
      await assertPluginPackageFiles(manyPluginHome, "many-bundled-plugins", id);
    }
    await assertManyPluginInstallHelper(tmp);
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

    await assertPluginPackageFiles(home, fixtureId, id);
  }
}

async function assertPluginPackageFiles(home, fixtureId, id) {
  const pluginDir = join(home, "fixture-plugins", id);
  const packageJson = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
  assertEqual(packageJson.name, `@kova/${id}`, `${fixtureId} ${id} package name`);
  assertEqual(packageJson.version, "0.0.0", `${fixtureId} ${id} version`);
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

async function assertManyPluginInstallHelper(tmp) {
  const binDir = join(tmp, "many-plugin-install-bin");
  const receiptPath = join(tmp, "many-plugin-installs.jsonl");
  await mkdir(binDir, { recursive: true });
  const fakeOcm = join(binDir, "ocm");
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "env" && args[1] === "exec") {',
    '  const result = spawnSync(process.execPath, args.slice(5), { env: process.env, stdio: "inherit" });',
    '  process.exit(result.status ?? 1);',
    '}',
    'if (args.slice(2).join(" ") === "plugins install --help") {',
    '  console.log(process.env.KOVA_TEST_INSTALL_MODE === "legacy" ? "--link --force" : "--link --force --accept-capabilities");',
    '  process.exit(0);',
    '}',
    'if (args[0] === "@kova-install-check" && args[1] === "--" && args[2] === "plugins" && args[3] === "install") {',
    '  const manifest = JSON.parse(fs.readFileSync(require("node:path").join(args[4], "openclaw.plugin.json")));',
    '  fs.appendFileSync(process.env.KOVA_TEST_INSTALL_RECEIPT, JSON.stringify({ id: manifest.id, flags: args.slice(5) }) + "\\n");',
    '  if (process.env.KOVA_TEST_INSTALL_MODE === "fail") { console.error("synthetic install rejected"); process.exit(1); }',
    '  process.exit(0);',
    '}',
    'throw new Error(`unexpected OCM command: ${args.join(" ")}`);'
  ].join("\n"));
  await chmod(fakeOcm, 0o755);
  for (const mode of ["legacy", "modern", "fail"]) {
    await writeFile(receiptPath, "");
    const result = await runCommand(
      `${quoteShell(process.execPath)} ${quoteShell(join(repoRoot, "support", "install-many-plugin-pressure-state.mjs"))} --env kova-install-check --expected-count 80 --plugin-index 1`,
      {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_STATE_DIR: join(tmp, "many-bundled-plugins-home"),
          KOVA_TEST_INSTALL_MODE: mode,
          KOVA_TEST_INSTALL_RECEIPT: receiptPath
        },
        timeoutMs: 30000
      }
    );
    const receipts = (await readFile(receiptPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assertEqual(result.status, mode === "fail" ? 1 : 0, `${mode} install result`);
    assertEqual(receipts.map((receipt) => receipt.id).join(","), "kova-plugin-1", `${mode} installs only the selected prepared package`);
    for (const receipt of receipts) {
      assertEqual(receipt.flags.join(" "), mode === "legacy" ? "--link --force" : "--link --force --accept-capabilities", `${mode} public installer options`);
    }
    const payload = JSON.parse(result.stdout);
    if (mode === "fail") {
      assertEqual(payload.ok, false, "failed installation cannot report prepared state");
      assertEqual(payload.stderr.includes("synthetic install rejected"), true, "failed installation retains diagnostics");
    } else {
      assertEqual(payload.installedCount, 1, `${mode} installation receipt count`);
    }
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
