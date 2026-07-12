import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/commands.mjs";
import {
  cleanupSelfCheckWorkspace,
  createSelfCheckScope,
  createSelfCheckWorkspace,
  runInSelfCheckScope
} from "../src/selfcheck-scope.mjs";
import { resolveCollectionPolicy } from "../src/collection-policy.mjs";
import { collectEnvMetrics } from "../src/metrics.mjs";
import { runScenarioCommand } from "../src/run/command-executor.mjs";
import { executeTargetSetup } from "../src/run/target-setup.mjs";
import { resolveTarget } from "../src/targets.mjs";

const root = await mkdtemp(join(tmpdir(), "kova-selfcheck-isolation-test-"));

try {
  await verifyConcurrentInvocationHomes(root);

  const scopes = [createSelfCheckScope(), createSelfCheckScope()];
  assert.notEqual(scopes[0].id, scopes[1].id);
  assert.notEqual(scopes[0].envName, scopes[1].envName);
  assert.notEqual(scopes[0].runtimeName, scopes[1].runtimeName);

  const probes = await Promise.all(scopes.map((scope) => runProbe(root, scope)));
  for (const [index, probe] of probes.entries()) {
    const logText = probe.log.join("\n");
    assert.equal(probe.log.every((line) => line.startsWith(`${scopes[index].envName}|`)), true);
    assert.match(logText, new RegExp(`runtime build-local ${scopes[index].runtimeName} `));
    assert.match(logText, new RegExp(`@${scopes[index].envName} -- status`));
    assert.match(logText, new RegExp(`service status ${scopes[index].envName} --json`));
  }

  await assert.rejects(
    cleanupSelfCheckWorkspace(scopes[0], probes[1].workspace),
    /refusing to clean self-check workspace/
  );

  await cleanupSelfCheckWorkspace(scopes[0], probes[0].workspace);
  await assert.rejects(stat(probes[0].workspace.root), { code: "ENOENT" });
  await stat(probes[1].workspace.root);
  await cleanupSelfCheckWorkspace(scopes[1], probes[1].workspace);

  const runtimeNames = Array.from(
    { length: 64 },
    () => resolveTarget("local-build:/tmp/openclaw", "target").runtimeName
  );
  assert.equal(new Set(runtimeNames).size, runtimeNames.length);
  assert.equal(runtimeNames.every((name) => /^kova-local-[a-z0-9-]+$/.test(name)), true);

  console.log("PASS self-check concurrent isolation");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function verifyConcurrentInvocationHomes(parentDir) {
  let readyCount = 0;
  let releaseBoth;
  let releaseSecond;
  let secondRoot;
  const bothReady = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const holdSecond = new Promise((resolve) => {
    releaseSecond = resolve;
  });

  const invoke = (index) => runInSelfCheckScope(async ({ scope, workspace }) => {
    if (index === 1) {
      secondRoot = workspace.root;
    }
    readyCount += 1;
    if (readyCount === 2) {
      releaseBoth();
    }
    await bothReady;

    const result = await runCommand(
      "node -e 'process.stdout.write(process.env.KOVA_HOME ?? \"\")'",
      { timeoutMs: 15000 }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, workspace.kovaHome);

    if (index === 1) {
      await holdSecond;
      await stat(workspace.root);
    }
    return {
      scopeId: scope.id,
      root: workspace.root,
      kovaHome: result.stdout
    };
  }, parentDir);

  const firstPromise = invoke(0);
  const secondPromise = invoke(1);
  const first = await firstPromise;
  await assert.rejects(stat(first.root), { code: "ENOENT" });
  await stat(secondRoot);
  releaseSecond();
  const second = await secondPromise;
  await assert.rejects(stat(second.root), { code: "ENOENT" });
  assert.notEqual(first.scopeId, second.scopeId);
  assert.notEqual(first.kovaHome, second.kovaHome);
}

async function runProbe(parentDir, scope) {
  const workspace = await createSelfCheckWorkspace(scope, parentDir);
  const binDir = join(workspace.root, "bin");
  const logPath = join(workspace.root, "ocm.log");
  const fakeOcm = join(binDir, "ocm");
  await mkdir(binDir, { recursive: true });
  await writeFile(fakeOcm, `#!/bin/sh
printf '%s|%s\\n' "$KOVA_ENV_NAME" "$*" >> "$KOVA_PROBE_LOG"
sleep 0.1
if [ "$1:$2" = "service:status" ]; then
  printf '{"gatewayState":"stopped","running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null}\\n'
  exit 0
fi
printf '{"ok":true}\\n'
`, "utf8");
  await chmod(fakeOcm, 0o755);

  const commandEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    KOVA_ENV_NAME: scope.envName,
    KOVA_PROBE_LOG: logPath
  };
  const results = await executeTargetSetup({
    targetPlan: {
      kind: "local-build",
      runtimeName: scope.runtimeName,
      repoPath: "/tmp/openclaw"
    },
    timeoutMs: 15000,
    resourceSampling: false,
    commandEnv,
    targetSetup: {
      completed: false,
      failed: false,
      results: [],
      inFlight: null
    }
  }, scope.envName, workspace.root);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 0);

  const scenarioResult = await runScenarioCommand(
    `ocm @${scope.envName} -- status`,
    {
      timeoutMs: 15000,
      openclawDiagnostics: false,
      resourceSampling: false,
      commandEnv
    },
    scope.envName,
    workspace.root,
    {
      id: "probe",
      measurementScope: "harness"
    },
    0
  );
  assert.equal(scenarioResult.status, 0);

  const collectionPolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-setup",
    measurementScope: "harness",
    collectionIntent: "service-only",
    resultStatus: "success"
  });
  const metrics = await collectEnvMetrics(scope.envName, {
    timeoutMs: 15000,
    collectionPolicy,
    commandEnv
  });
  assert.equal(metrics.service?.gatewayState, "stopped");

  return {
    workspace,
    log: (await readFile(logPath, "utf8")).trim().split("\n")
  };
}
