import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureOpenClawStateSnapshot } from "../collectors/openclaw-state.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
import { buildUpgradeLogDerivedInvariants, buildUpgradeStateSnapshotInvariants } from "../evidence/invariants.mjs";
import { syntheticCollectorReceipt, upgradeSnapshotRecord, zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export async function openClawStateSnapshotCheck(tmp) {
  const home = join(tmp, "snapshot-openclaw-home");
  try {
    await mkdir(join(home, "config"), { recursive: true });
    await mkdir(join(home, "plugins", "browser", "node_modules", "large-package"), { recursive: true });
    await writeFile(join(home, "config", "settings.json"), JSON.stringify({
      schemaVersion: "kova.fixture.settings.v1",
      provider: "openai",
      model: "gpt-5.5",
      authMethod: "env-var",
      workspaceRoot: "/Users/self-check/project",
      apiKey: "sk-kova-secret-value",
      nested: {
        refreshToken: "refresh-secret-value"
      }
    }, null, 2));
    await writeFile(join(home, "plugins", "installs.json"), JSON.stringify({
      schemaVersion: "kova.fixture.plugins.v1",
      plugins: [{ id: "browser", source: "bundled", enabled: true }]
    }, null, 2));
    await writeFile(join(home, "config", "version.json"), JSON.stringify({
      schemaVersion: "kova.fixture.old-release.v1",
      release: "2026.4.20",
      channel: "stable"
    }, null, 2));
    await writeFile(join(home, "plugins", "legacy-index.json"), JSON.stringify({
      plugins: ["browser"]
    }, null, 2));
    await writeFile(join(home, "plugins", "browser", "package.json"), JSON.stringify({
      name: "browser",
      version: "1.0.0"
    }, null, 2));
    await writeFile(join(home, "plugins", "browser", "node_modules", "large-package", "index.js"), "secret dependency content");
    await writeFile(join(home, "config", "models.json"), `${"x".repeat(1024)}\n`);

    const snapshot = await captureOpenClawStateSnapshot({
      home,
      label: "self-check",
      runtime: {
        targetKind: "local-build",
        targetValue: "/tmp/openclaw checkout",
        runtimeName: "kova-local-self-check"
      },
      service: {
        desired: "running",
        state: "running",
        pid: 1234,
        port: 4321,
        restartCount: 2,
        readiness: "ready"
      },
      cleanup: {
        expected: true,
        state: "planned",
        reason: "self-check"
      },
      limits: {
        maxFileBytes: 512
      }
    });
    const serialized = JSON.stringify(snapshot);
    assertEqual(snapshot.schemaVersion, "kova.openclawStateSnapshot.v1", "OpenClaw state snapshot schema");
    assertEqual(snapshot.home.present, true, "OpenClaw state snapshot home present");
    assertEqual(snapshot.budget.truncatedCount > 0, true, "OpenClaw state snapshot truncates large files");
    assertEqual(snapshot.redaction.secretKeyCount, 2, "OpenClaw state snapshot redacts secret keys");
    assertEqual(serialized.includes("sk-kova-secret-value"), false, "OpenClaw state snapshot does not include API key value");
    assertEqual(serialized.includes("refresh-secret-value"), false, "OpenClaw state snapshot does not include refresh token value");
    assertEqual(snapshot.plugins.installIndexes.length, 1, "OpenClaw state snapshot includes plugin install index");
    assertEqual(snapshot.files.some((file) => file.path === "config/version.json"), true, "OpenClaw state snapshot includes legacy version marker");
    assertEqual(snapshot.files.some((file) => file.path === "plugins/legacy-index.json"), true, "OpenClaw state snapshot includes legacy plugin index marker");
    assertEqual(snapshot.plugins.installed?.[0]?.id, "browser", "OpenClaw state snapshot summarizes installed plugin ids");
    assertEqual(snapshot.plugins.pluginDirs.some((plugin) => plugin.nodeModulesPresent), true, "OpenClaw state snapshot records node_modules presence");
    assertEqual(snapshot.files.some((file) => file.path.includes("node_modules")), false, "OpenClaw state snapshot excludes dependency trees");
    assertEqual(snapshot.runtime.targetKind, "local-build", "OpenClaw state snapshot runtime target kind");
    assertEqual(snapshot.runtime.targetValue, null, "OpenClaw state snapshot redacts local-build target path");
    assertEqual(typeof snapshot.runtime.targetValueHash, "string", "OpenClaw state snapshot hashes local-build target path");
    assertEqual(snapshot.service.state, "running", "OpenClaw state snapshot service state");
    assertEqual(snapshot.auth.providerIds.includes("openai"), true, "OpenClaw state snapshot auth provider shape");
    assertEqual(snapshot.auth.authMethodShapes.includes("env-var"), true, "OpenClaw state snapshot auth method shape");
    assertEqual(snapshot.models.modelIds.includes("gpt-5.5"), true, "OpenClaw state snapshot model shape");
    assertEqual(snapshot.workspace.allowedRootCount, 1, "OpenClaw state snapshot workspace boundary count");
    assertEqual(snapshot.cleanup.expected, true, "OpenClaw state snapshot cleanup expectation");

    return {
      id: "openclaw-state-snapshot",
      status: "PASS",
      command: "capture bounded redacted OpenClaw state snapshot",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "openclaw-state-snapshot",
      status: "FAIL",
      command: "capture bounded redacted OpenClaw state snapshot",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function openClawStateSymlinkContainmentCheck(tmp) {
  const home = join(tmp, "snapshot-containment-home");
  const outside = join(tmp, "snapshot-containment-outside");
  try {
    await mkdir(join(home, "config"), { recursive: true });
    await mkdir(join(home, ".openclaw"), { recursive: true });
    await mkdir(join(home, "plugins"), { recursive: true });
    await mkdir(join(home, "plugins", "z-plugin"), { recursive: true });
    await mkdir(join(home, "plugins", "zz-plugin"), { recursive: true });
    await mkdir(join(outside, "plugins", "escaped-plugin"), { recursive: true });
    await symlink("z-plugin", join(home, "plugins", "a-contained-alias"));
    await symlink("zz-plugin", join(home, "plugins", "b-contained-alias"));
    await writeFile(
      join(outside, "settings.json"),
      JSON.stringify({ schemaVersion: "KOVA_KNOWN_FILE_ESCAPE_CANARY" }),
      "utf8"
    );
    await writeFile(
      join(outside, "plugins", "escaped-plugin", "package.json"),
      JSON.stringify({ name: "KOVA_PLUGIN_ESCAPE_CANARY" }),
      "utf8"
    );
    await symlink(join(outside, "settings.json"), join(home, "settings.json"));
    await symlink(join(outside, "plugins"), join(home, ".openclaw", "plugins"));
    await symlink(
      join(outside, "plugins", "escaped-plugin"),
      join(home, "plugins", "escaped-plugin")
    );
    for (let index = 0; index < 4; index += 1) {
      await symlink(
        join(outside, "plugins", "escaped-plugin"),
        join(home, "plugins", `escaped-plugin-${index}`)
      );
    }

    const snapshot = await captureOpenClawStateSnapshot({
      home,
      limits: { maxPluginDirs: 2 }
    });
    const serialized = JSON.stringify(snapshot);
    assertEqual(serialized.includes("KOVA_KNOWN_FILE_ESCAPE_CANARY"), false, "known-file symlink escape is not read");
    assertEqual(serialized.includes("KOVA_PLUGIN_ESCAPE_CANARY"), false, "plugin symlink escape is not read");
    assertEqual(snapshot.files.some((file) => file.path === "settings.json"), false, "escaped known file is omitted");
    assertEqual(snapshot.plugins.roots.some((root) => root.path === ".openclaw/plugins"), false, "escaped plugin root is omitted");
    assertEqual(snapshot.plugins.pluginDirs.some((plugin) => plugin.path === "plugins/escaped-plugin"), false, "escaped plugin directory is omitted");
    assertEqual(snapshot.plugins.pluginDirs.some((plugin) => plugin.path === "plugins/z-plugin"), true, "contained symlinks do not consume the plugin budget");
    assertEqual(snapshot.plugins.pluginDirs.some((plugin) => plugin.path === "plugins/zz-plugin"), true, "the plugin budget counts real directories");
    assertEqual(snapshot.budget.excludedPaths.includes("settings.json"), true, "escaped known file is recorded");
    assertEqual(snapshot.budget.excludedPaths.includes(".openclaw/plugins"), true, "escaped plugin root is recorded");
    assertEqual(snapshot.budget.excludedPaths.includes("plugins/escaped-plugin"), false, "escaped plugin directory name is not retained");
    assertEqual(
      snapshot.budget.excludedPaths.filter((path) => path.startsWith("plugins/escaped-plugin")).length,
      0,
      "escaped plugin names do not enter snapshot metadata"
    );

    return {
      id: "openclaw-state-symlink-containment",
      status: "PASS",
      command: "reject OpenClaw state symlink escapes",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "openclaw-state-symlink-containment",
      status: "FAIL",
      command: "reject OpenClaw state symlink escapes",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function doctorUpgradeSnapshotEvidenceCheck(tmp) {
  const home = join(tmp, "doctor-upgrade-snapshot-openclaw-home");
  const state = "legacy-channel-config-doctor-2026-5-7";
  try {
    const writeResult = await runCommand(
      `node support/write-doctor-upgrade-state.mjs --state ${quoteShell(state)}`,
      {
        env: { OPENCLAW_HOME: home },
        timeoutMs: 30000
      }
    );
    if (writeResult.status !== 0) {
      throw new Error(`doctor fixture writer failed: ${writeResult.stderr || writeResult.stdout}`);
    }

    const captureResult = await runCommand(
      `node support/capture-openclaw-state.mjs --home ${quoteShell(home)} --label doctor-fixture`,
      {
        timeoutMs: 30000,
        maxOutputChars: 200000
      }
    );
    if (captureResult.status !== 0) {
      throw new Error(`doctor fixture snapshot failed: ${captureResult.stderr || captureResult.stdout}`);
    }
    const snapshot = JSON.parse(captureResult.stdout);
    const files = new Set((snapshot.files ?? []).map((file) => file.path));
    assertEqual(files.has(".openclaw/openclaw.json"), true, "doctor fixture snapshot includes legacy OpenClaw config");
    assertEqual(files.has("config/kova-doctor-upgrade-evidence.json"), true, "doctor fixture snapshot includes Kova evidence marker");
    assertEqual(
      snapshot.config?.files?.includes("config/kova-doctor-upgrade-evidence.json"),
      true,
      "doctor fixture evidence marker is summarized as config"
    );

    return {
      id: "doctor-upgrade-snapshot-evidence",
      status: "PASS",
      command: "write doctor fixture and capture OpenClaw state snapshot",
      durationMs: writeResult.durationMs + captureResult.durationMs
    };
  } catch (error) {
    return {
      id: "doctor-upgrade-snapshot-evidence",
      status: "FAIL",
      command: "write doctor fixture and capture OpenClaw state snapshot",
      durationMs: 0,
      message: error.message
    };
  }
}

export function upgradeStateSnapshotInvariantsCheck() {
  try {
    const baseSnapshot = {
      runtime: { targetKind: "local-build", targetValueHash: "runtime-hash" },
      service: { desired: "running", state: "running", readiness: "ready", pid: 100, restartCount: 1 },
      auth: { providerIds: ["openai"], authMethodShapes: ["env-var"] },
      models: { providerIds: ["openai"], modelIds: ["gpt-5.5"] },
      workspace: { rootHashes: ["workspace-hash"] },
      installedPluginIds: ["browser", "memory-core"],
      pluginInstallIndexCount: 1,
      pluginDirCount: 2
    };
    const record = upgradeSnapshotRecord({
      pre: baseSnapshot,
      post: {
        ...baseSnapshot,
        service: { desired: "running", state: "running", readiness: "ready", pid: 200, restartCount: 2 },
        pluginDirCount: 3
      }
    });
    const passing = buildUpgradeStateSnapshotInvariants(record);
    assertEqual(passing.every((invariant) => invariant.status === "passed"), true, "preserved upgrade state invariants pass");

    const missing = buildUpgradeStateSnapshotInvariants(upgradeSnapshotRecord({
      pre: {},
      post: {}
    }));
    const missingById = Object.fromEntries(missing.map((invariant) => [invariant.id, invariant]));
    for (const id of [
      "plugin-install-index-preserved",
      "plugin-directory-count-not-decreased",
      "provider-ids-preserved",
      "model-ids-preserved",
      "auth-method-shape-preserved",
      "installed-plugin-ids-preserved",
      "workspace-roots-preserved",
      "runtime-target-kind-stable"
    ]) {
      assertEqual(missingById[id]?.status, "missing", `upgrade invariant ${id} requires captured inputs`);
    }
    for (const id of [
      "local-build-target-hash-stable",
      "service-desired-state-preserved",
      "service-running-state-preserved",
      "service-readiness-preserved"
    ]) {
      assertEqual(missingById[id]?.status, "passed", `optional upgrade invariant ${id} permits both inputs absent`);
    }

    const partialProviderRecord = upgradeSnapshotRecord({
      pre: {
        ...baseSnapshot,
        models: { modelIds: ["gpt-5.5"] }
      },
      post: {
        ...baseSnapshot,
        models: { modelIds: ["gpt-5.5"] }
      }
    });
    const partialProvider = buildUpgradeStateSnapshotInvariants(partialProviderRecord)
      .find((invariant) => invariant.id === "provider-ids-preserved");
    assertEqual(partialProvider?.status, "missing", "provider id union requires auth and model provider inputs");

    const malformedRecord = upgradeSnapshotRecord({
      pre: {
        ...baseSnapshot,
        runtime: { ...baseSnapshot.runtime, targetKind: false },
        models: { ...baseSnapshot.models, modelIds: [null] },
        pluginInstallIndexCount: -1
      },
      post: {
        ...baseSnapshot,
        runtime: { ...baseSnapshot.runtime, targetKind: false },
        models: { ...baseSnapshot.models, modelIds: [null] },
        pluginInstallIndexCount: -1
      }
    });
    const malformedById = Object.fromEntries(
      buildUpgradeStateSnapshotInvariants(malformedRecord)
        .map((invariant) => [invariant.id, invariant])
    );
    assertEqual(malformedById["plugin-install-index-preserved"]?.status, "missing", "negative snapshot count is missing evidence");
    assertEqual(malformedById["model-ids-preserved"]?.status, "missing", "malformed snapshot set is missing evidence");
    assertEqual(malformedById["runtime-target-kind-stable"]?.status, "missing", "malformed equality input is missing evidence");

    const failingRecord = upgradeSnapshotRecord({
      pre: baseSnapshot,
      post: {
        ...baseSnapshot,
        auth: { providerIds: [], authMethodShapes: [] },
        models: { providerIds: [], modelIds: [] },
        workspace: { rootHashes: [] },
        service: { desired: "running", state: "stopped", readiness: "not-ready", pid: 300, restartCount: 3 },
        installedPluginIds: ["browser"],
        pluginInstallIndexCount: 0,
        pluginDirCount: 1
      }
    });
    const failing = buildUpgradeStateSnapshotInvariants(failingRecord);
    const failedIds = failing.filter((invariant) => invariant.status === "failed").map((invariant) => invariant.id);
    for (const id of [
      "plugin-install-index-preserved",
      "plugin-directory-count-not-decreased",
      "provider-ids-preserved",
      "model-ids-preserved",
      "auth-method-shape-preserved",
      "installed-plugin-ids-preserved",
      "workspace-roots-preserved",
      "service-running-state-preserved",
      "service-readiness-preserved"
    ]) {
      assertEqual(failedIds.includes(id), true, `upgrade invariant ${id} fails on state loss`);
    }

    return {
      id: "upgrade-state-snapshot-invariants",
      status: "PASS",
      command: "evaluate upgrade state snapshot invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "upgrade-state-snapshot-invariants",
      status: "FAIL",
      command: "evaluate upgrade state snapshot invariants",
      durationMs: 0,
      message: error.message
    };
  }
}

export function upgradeLogDerivedInvariantsCheck() {
  try {
    const clean = buildUpgradeLogDerivedInvariants({
      status: "PASS",
      measurements: {
        missingDependencyErrors: 0,
        pluginLoadFailures: 0
      },
      phases: [{
        id: "post-upgrade",
        metrics: {
          collectors: [
            syntheticCollectorReceipt("logs", { artifacts: ["/tmp/kova/logs/gateway-tail.log"] })
          ],
          logs: {
            ...zeroLogMetrics(),
            commandStatus: 0,
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          }
        },
        results: [{
          command: "ocm @kova-self-check -- doctor --fix",
          status: 0,
          stdout: "doctor ok\n",
          stderr: ""
        }]
      }]
    });
    assertEqual(clean.every((invariant) => invariant.status === "passed"), true, "clean upgrade log invariants pass");

    const bad = buildUpgradeLogDerivedInvariants({
      status: "PASS",
      measurements: {
        missingDependencyErrors: 2,
        pluginLoadFailures: 1
      },
      phases: [{
        id: "post-upgrade",
        results: [{
          command: "ocm @kova-self-check -- doctor --fix",
          status: 0,
          stdout: "",
          stderr: ""
        }]
      }]
    });
    const byId = Object.fromEntries(bad.map((invariant) => [invariant.id, invariant]));
    assertEqual(byId["no-missing-runtime-dependency-errors"].status, "failed", "missing dependency invariant fails");
    assertEqual(byId["no-plugin-load-failures"].status, "failed", "plugin load invariant fails");
    assertEqual(byId["doctor-output-captured"].status, "missing", "missing doctor output is incomplete proof");

    return {
      id: "upgrade-log-derived-invariants",
      status: "PASS",
      command: "evaluate upgrade log-derived invariants",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "upgrade-log-derived-invariants",
      status: "FAIL",
      command: "evaluate upgrade log-derived invariants",
      durationMs: 0,
      message: error.message
    };
  }
}
