import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ENV_COLLECTOR_IDS, resolveCollectionPolicy } from "../collection-policy.mjs";
import { collectEnvMetrics } from "../metrics.mjs";
import { assertEqual } from "./harness.mjs";

export async function collectionPolicyResolverCheck(tmp, scope) {
  const policy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "fresh-install",
    surface: "fresh-install",
    phaseId: "provision",
    phaseHealthScope: "readiness",
    measurementScope: "product",
    resultStatus: "success"
  });
  assertEqual(policy.schemaVersion, "kova.collectionPolicy.v1", "collection policy schema");
  assertEqual(policy.mode, "full", "collection policy default mode");
  assertEqual(policy.context.scenario, "fresh-install", "collection policy scenario context");
  assertEqual(policy.context.phaseId, "provision", "collection policy phase context");
  for (const collector of ENV_COLLECTOR_IDS) {
    assertEqual(policy.collectors[collector], true, `collection policy keeps ${collector}`);
  }
  assertEqual(policy.skipped.length, 0, "scenario phase collection policy skips nothing");
  const postReadyWithoutIntentPolicy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "agent-cold-warm-message",
    surface: "agent-cli-local-turn",
    phaseId: "post-agent-health",
    phaseHealthScope: "post-ready",
    measurementScope: "product",
    resultStatus: "success"
  });
  assertEqual(postReadyWithoutIntentPolicy.mode, "full", "post-ready healthScope without collection intent keeps full collection");

  const postReadyPolicy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "agent-cold-warm-message",
    surface: "agent-cli-local-turn",
    phaseId: "post-agent-health",
    phaseHealthScope: "post-ready",
    measurementScope: "product",
    collectionIntent: "post-ready-health",
    resultStatus: "success"
  });
  assertEqual(postReadyPolicy.mode, "post-ready-health", "post-ready phase policy mode");
  assertEqual(postReadyPolicy.context.collectionIntent, "post-ready-health", "post-ready phase records collection intent");
  assertEqual(postReadyPolicy.readiness, "none", "post-ready phase skips readiness wait");
  assertEqual(postReadyPolicy.healthSamples, true, "post-ready phase keeps health samples");
  assertEqual(postReadyPolicy.collectors.logs, true, "post-ready phase keeps logs");
  assertEqual(postReadyPolicy.collectors.timeline, true, "post-ready phase keeps timeline");

  const authPreparePolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-prepare",
    measurementScope: "harness",
    collectionIntent: "skip-env",
    resultStatus: "success"
  });
  assertEqual(authPreparePolicy.mode, "skip-env", "successful auth prepare skips env metrics");
  assertEqual(authPreparePolicy.collectors.service, false, "successful auth prepare skips service collector");
  assertEqual(authPreparePolicy.skipped.length, ENV_COLLECTOR_IDS.length, "auth prepare skipped collector list");

  const failedAuthCleanupPolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-cleanup",
    measurementScope: "cleanup",
    collectionIntent: "skip-env",
    resultStatus: "failure"
  });
  assertEqual(failedAuthCleanupPolicy.mode, "full", "failed auth cleanup keeps full collection");

  const authSetupPolicy = resolveCollectionPolicy({
    kind: "auth-phase",
    phaseId: "auth-setup",
    measurementScope: "harness",
    collectionIntent: "service-only",
    resultStatus: "success"
  });
  assertEqual(authSetupPolicy.mode, "service-only", "successful auth setup uses service-only collection");
  assertEqual(authSetupPolicy.collectors.service, true, "auth setup keeps service collector");
  assertEqual(authSetupPolicy.collectors.process, true, "auth setup keeps process collector");
  assertEqual(authSetupPolicy.collectors.logs, false, "auth setup skips logs collector");
  assertEqual(authSetupPolicy.collectors.timeline, false, "auth setup skips timeline collector");

  const noServicePolicy = resolveCollectionPolicy({
    kind: "scenario-phase",
    scenario: "gateway-session-send-turn",
    surface: "gateway-session-send-turn",
    phaseId: "provision",
    phaseHealthScope: "none",
    measurementScope: "product",
    collectionIntent: "service-only",
    resultStatus: "success",
    hasNoServiceCommand: true
  });
  assertEqual(noServicePolicy.mode, "service-only", "successful no-service phase uses service-only collection");
  assertEqual(noServicePolicy.collectors.service, true, "no-service phase keeps service collector");
  assertEqual(noServicePolicy.collectors.readiness, false, "no-service phase skips readiness collector");
  assertEqual(noServicePolicy.collectors.logs, false, "no-service phase skips logs collector");

  const stateSetupPolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    scenario: "gateway-session-send-turn",
    surface: "gateway-session-send-turn",
    phaseId: "provision",
    measurementScope: "harness",
    lifecycleKind: "state-provision",
    collectionIntent: "service-only",
    resultStatus: "success"
  });
  assertEqual(stateSetupPolicy.mode, "service-only", "successful state setup uses service-only collection");
  assertEqual(stateSetupPolicy.context.lifecycleKind, "state-provision", "state setup policy records lifecycle kind");
  assertEqual(stateSetupPolicy.collectors.service, true, "state setup keeps service collector");
  assertEqual(stateSetupPolicy.collectors.readiness, false, "state setup skips readiness collector");
  assertEqual(stateSetupPolicy.collectors.logs, false, "state setup skips logs collector");

  const failedStateSetupPolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    phaseId: "provision",
    measurementScope: "harness",
    lifecycleKind: "state-provision",
    collectionIntent: "service-only",
    resultStatus: "failure"
  });
  assertEqual(failedStateSetupPolicy.mode, "full", "failed state setup keeps full collection");

  const hostStatePreparePolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    phaseId: null,
    measurementScope: "harness",
    lifecycleKind: "prepare",
    lifecycleCommandScope: "host",
    collectionIntent: "skip-env",
    resultStatus: "success"
  });
  assertEqual(hostStatePreparePolicy.mode, "skip-env", "successful host-only state prepare skips env metrics");
  assertEqual(hostStatePreparePolicy.context.lifecycleCommandScope, "host", "host state prepare records command scope");
  assertEqual(hostStatePreparePolicy.collectors.service, false, "host state prepare skips service collector");

  const envStatePreparePolicy = resolveCollectionPolicy({
    kind: "state-lifecycle",
    phaseId: null,
    measurementScope: "harness",
    lifecycleKind: "prepare",
    lifecycleCommandScope: "env",
    collectionIntent: "skip-env",
    resultStatus: "success"
  });
  assertEqual(envStatePreparePolicy.mode, "skip-env", "collection intent, not command scope, drives env state prepare collection");

  const skippedMetrics = await collectEnvMetrics(`${scope.envName}-skip`, {
    collectionPolicy: authPreparePolicy
  });
  assertEqual(skippedMetrics.service, null, "skipped env metrics avoid service collection");
  assertEqual(
    skippedMetrics.collectors.every((collector) => collector.status === "SKIPPED"),
    true,
    "skipped env metrics records skipped collectors"
  );
  assertEqual(skippedMetrics.collectors.length, ENV_COLLECTOR_IDS.length, "skipped env metrics receipt count");

  const hostStatePrepareMetrics = await collectEnvMetrics(`${scope.envName}-host-prepare`, {
    collectionPolicy: hostStatePreparePolicy
  });
  assertEqual(hostStatePrepareMetrics.service, null, "host state prepare metrics avoid service collection");
  assertEqual(
    hostStatePrepareMetrics.collectors.every((collector) => collector.status === "SKIPPED"),
    true,
    "host state prepare metrics records skipped collectors"
  );

  const authSetupMetrics = await collectPostReadySelfCheckMetrics(tmp, scope, authSetupPolicy);
  assertEqual(authSetupMetrics.service?.gatewayState, "running", "auth setup service-only keeps service state");
  assertEqual(Boolean(authSetupMetrics.process), true, "auth setup service-only keeps process metrics");
  assertEqual(authSetupMetrics.logs, null, "auth setup service-only skips logs payload");
  assertEqual(authSetupMetrics.timeline, null, "auth setup service-only skips timeline payload");
  assertEqual(authSetupMetrics.diagnostics, null, "auth setup service-only skips diagnostics payload");
  assertEqual(
    authSetupMetrics.collectors.some((collector) => collector.id === "logs" && collector.status === "SKIPPED"),
    true,
    "auth setup service-only records skipped logs"
  );
  assertEqual(
    authSetupMetrics.collectors.some((collector) => collector.id === "timeline" && collector.status === "SKIPPED"),
    true,
    "auth setup service-only records skipped timeline"
  );

  const stateSetupMetrics = await collectPostReadySelfCheckMetrics(tmp, scope, stateSetupPolicy);
  assertEqual(stateSetupMetrics.service?.gatewayState, "running", "state setup service-only keeps service state");
  assertEqual(Boolean(stateSetupMetrics.process), true, "state setup service-only keeps process metrics");
  assertEqual(stateSetupMetrics.logs, null, "state setup service-only skips logs payload");
  assertEqual(stateSetupMetrics.timeline, null, "state setup service-only skips timeline payload");
  assertEqual(stateSetupMetrics.diagnostics, null, "state setup service-only skips diagnostics payload");
  assertEqual(
    stateSetupMetrics.collectors.some((collector) => collector.id === "logs" && collector.status === "SKIPPED"),
    true,
    "state setup service-only records skipped logs"
  );

  const postReadyMetrics = await collectPostReadySelfCheckMetrics(tmp, scope, postReadyPolicy);
  assertEqual(postReadyMetrics.readiness?.attempts, 0, "post-ready metrics do not run readiness attempts");
  assertEqual(postReadyMetrics.healthSummary?.count, 2, "post-ready metrics keep health samples");
  assertEqual(postReadyMetrics.healthSummary?.failureCount, 0, "post-ready metrics health samples pass");
  assertEqual(
    postReadyMetrics.collectors.some((collector) => collector.id === "readiness" && collector.status === "INFO"),
    true,
    "post-ready metrics records readiness as not applicable"
  );
  assertEqual(
    postReadyMetrics.collectors.some((collector) => collector.id === "health" && collector.status === "PASS"),
    true,
    "post-ready metrics records health collector"
  );

  const finalPolicy = resolveCollectionPolicy({ kind: "final" });
  const finalMetrics = await collectPostReadySelfCheckMetrics(tmp, scope, finalPolicy);
  assertEqual(finalMetrics.readiness?.attempts, 0, "final metrics avoid a zero-deadline readiness wait");
  assertEqual(finalMetrics.healthSummary?.count, 2, "final metrics keep post-ready health samples");
  assertEqual(
    finalMetrics.collectors.some((collector) => collector.id === "health" && collector.status === "PASS"),
    true,
    "final metrics record health proof before cleanup"
  );

  const frontagePostReadyMetrics = await collectPostReadySelfCheckMetrics(tmp, scope, postReadyPolicy, {
    useNetworkFrontage: true
  });
  assertEqual(frontagePostReadyMetrics.service?.gatewayPort, 9, "frontage metrics preserve raw service gateway port");
  assertEqual(frontagePostReadyMetrics.healthSummary?.failureCount, 0, "frontage metrics health samples pass");
  assertEqual(frontagePostReadyMetrics.healthSamples?.[0]?.source, "network-frontage", "frontage metrics health uses frontage source");
  assertEqual(frontagePostReadyMetrics.healthSamples?.[0]?.port !== 9, true, "frontage metrics health avoids raw gateway port");
  return {
    id: "collection-policy-resolver",
    status: "PASS"
  };
}

async function collectPostReadySelfCheckMetrics(tmp, scope, collectionPolicy, options = {}) {
  const fakeBin = join(tmp, "post-ready-policy-bin");
  const fakeOcm = join(fakeBin, "ocm");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeOcm, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'service' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({ gatewayState: 'running', running: true, desiredRunning: true, childPid: Number(process.env.KOVA_FAKE_CHILD_PID), gatewayPort: Number(process.env.KOVA_FAKE_PORT), runtimeReleaseVersion: 'self-check', runtimeReleaseChannel: 'test' }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'logs') {",
    "  process.stdout.write('gateway ready\\n');",
    "  process.exit(0);",
    "}",
    "process.stdout.write('\\n');"
  ].join("\n"), "utf8");
  await chmod(fakeOcm, 0o755);

  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const reportedGatewayPort = options.useNetworkFrontage === true ? 9 : port;
  try {
    return await collectEnvMetrics(`${scope.envName}-post-ready`, {
      collectionPolicy,
      timeoutMs: 1000,
      healthSamples: 2,
      healthIntervalMs: 0,
      readinessTimeoutMs: 0,
      commandEnv: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SHELL: "/bin/sh",
        KOVA_FAKE_PORT: String(reportedGatewayPort),
        KOVA_FAKE_CHILD_PID: String(process.pid)
      },
      networkFrontageAllocation: options.useNetworkFrontage === true
        ? {
            status: "active",
            frontageHost: "127.0.0.1",
            frontagePort: port
          }
        : null
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
