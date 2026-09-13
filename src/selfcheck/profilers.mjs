import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeHeapProfiles } from "../collectors/heap.mjs";
import { summarizeCpuProfiles } from "../collectors/node-profiles.mjs";
import { buildDiagnosticsCommandEnv } from "../run/command-executor.mjs";
import { syntheticCpuProfile, syntheticHeapProfile } from "./fixtures.mjs";
import { assertEqual, selfCheckPath } from "./harness.mjs";

export async function cpuProfileParserCheck(tmp) {
  try {
    const summary = await summarizeCpuProfiles(
      [selfCheckPath("fixtures", "diagnostics", "sample.cpuprofile")],
      { limit: 3 }
    );
    assertEqual(summary.profileCount, 1, "CPU profile count");
    assertEqual(summary.parseErrorCount, 0, "CPU profile parse errors");
    assertEqual(summary.topFunctions[0]?.functionName, "collectBundledPluginMetadata", "top CPU function");
    assertEqual(summary.topFunctions[0]?.selfMs, 7, "top CPU self ms");
    const aggregateDir = join(tmp, "cpu-profile-aggregate");
    const firstPath = join(aggregateDir, "first.cpuprofile");
    const secondPath = join(aggregateDir, "second.cpuprofile");
    await mkdir(aggregateDir, { recursive: true });
    await writeFile(firstPath, JSON.stringify(syntheticCpuProfile("first-only")));
    await writeFile(secondPath, JSON.stringify(syntheticCpuProfile("second-only")));
    const aggregate = await summarizeCpuProfiles(
      [firstPath, secondPath],
      { limit: 1 }
    );
    assertEqual(aggregate.profiles[0].topFunctions[0]?.functionName, "first-only", "first profile keeps its local top function");
    assertEqual(aggregate.profiles[1].topFunctions[0]?.functionName, "second-only", "second profile keeps its local top function");
    assertEqual(aggregate.topFunctions[0]?.functionName, "shared", "CPU aggregation includes functions below each profile limit");
    assertEqual(aggregate.topFunctions[0]?.selfMs, 8, "CPU aggregation sums shared function time");
    return {
      id: "cpu-profile-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/sample.cpuprofile",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "cpu-profile-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/sample.cpuprofile",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function heapProfileParserCheck(tmp) {
  try {
    const summary = await summarizeHeapProfiles(
      [selfCheckPath("fixtures", "diagnostics", "sample.heapprofile")],
      { limit: 3 }
    );
    assertEqual(summary.profileCount, 1, "heap profile count");
    assertEqual(summary.parseErrorCount, 0, "heap profile parse errors");
    assertEqual(summary.topFunctions[0]?.functionName, "loadBundledPluginMetadata", "top heap function");
    assertEqual(summary.topFunctions[0]?.selfSizeMb, 7, "top heap size mb");
    const aggregateDir = join(tmp, "heap-profile-aggregate");
    const firstPath = join(aggregateDir, "first.heapprofile");
    const secondPath = join(aggregateDir, "second.heapprofile");
    await mkdir(aggregateDir, { recursive: true });
    await writeFile(firstPath, JSON.stringify(syntheticHeapProfile("first-only")));
    await writeFile(secondPath, JSON.stringify(syntheticHeapProfile("second-only")));
    const aggregate = await summarizeHeapProfiles(
      [firstPath, secondPath],
      { limit: 1 }
    );
    assertEqual(aggregate.profiles[0].topFunctions[0]?.functionName, "first-only", "first heap profile keeps its local top function");
    assertEqual(aggregate.profiles[1].topFunctions[0]?.functionName, "second-only", "second heap profile keeps its local top function");
    assertEqual(aggregate.topFunctions[0]?.functionName, "shared", "heap aggregation includes functions below each profile limit");
    assertEqual(aggregate.topFunctions[0]?.selfSizeBytes, 120, "heap aggregation sums shared allocation size");
    return {
      id: "heap-profile-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/sample.heapprofile",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "heap-profile-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/sample.heapprofile",
      durationMs: 0,
      message: error.message
    };
  }
}

export function diagnosticProfilerMeasurementScopeCheck(tmp) {
  try {
    const context = {
      runId: "self-check-profile-scope",
      nodeProfile: true
    };
    const heapOnlyContext = {
      runId: "self-check-heap-scope",
      heapSnapshot: true,
      affectsPerformanceMeasurements: true
    };
    const artifactDir = join(tmp, "diagnostic-profile-scope");
    const product = buildDiagnosticsCommandEnv(
      context,
      "profile-product",
      artifactDir,
      "product",
      "ocm @profile-product -- models list"
    );
    const serviceStart = buildDiagnosticsCommandEnv(
      context,
      "profile-service",
      artifactDir,
      "product",
      "ocm service install profile-service --json || ocm service start profile-service --json"
    );
    const serviceRestart = buildDiagnosticsCommandEnv(
      context,
      "profile-service",
      artifactDir,
      "product",
      "ocm service restart profile-service"
    );
    const gatewayStart = buildDiagnosticsCommandEnv(
      context,
      "profile-service",
      artifactDir,
      "product",
      "ocm start profile-service"
    );
    const noServiceStart = buildDiagnosticsCommandEnv(
      context,
      "profile-product",
      artifactDir,
      "product",
      "ocm start profile-product --no-service"
    );
    const harness = buildDiagnosticsCommandEnv(
      context,
      "profile-harness",
      artifactDir,
      "harness"
    );
    const cleanup = buildDiagnosticsCommandEnv(
      context,
      "profile-cleanup",
      artifactDir,
      "cleanup"
    );
    const heapOnly = buildDiagnosticsCommandEnv(
      heapOnlyContext,
      "profile-heap",
      artifactDir,
      "product",
      "ocm @profile-heap -- models list"
    );

    assertEqual(
      product.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.endsWith("timeline.jsonl"),
      true,
      "product diagnostics keep timeline output"
    );
    assertEqual(
      harness.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.endsWith("timeline.jsonl"),
      true,
      "harness diagnostics keep timeline output"
    );
    assertEqual(
      cleanup.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.endsWith("timeline.jsonl"),
      true,
      "cleanup diagnostics keep timeline output"
    );
    assertEqual(
      heapOnly.NODE_OPTIONS,
      undefined,
      "heap-only diagnostics do not inject the Node profiler"
    );
    assertEqual(
      product.NODE_OPTIONS.includes("--cpu-prof") &&
        product.NODE_OPTIONS.includes("--heap-prof") &&
        product.NODE_OPTIONS.includes("--trace-events-enabled") &&
        product.NODE_OPTIONS.includes(
          "--trace-event-categories=node.perf,node.async_hooks,v8"
        ),
      true,
      "product diagnostics enable bounded node profilers"
    );
    assertEqual(
      typeof product.KOVA_NODE_PROFILE_DIR,
      "string",
      "product diagnostics expose node profile directory"
    );
    assertEqual(
      serviceStart.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.endsWith("timeline.jsonl"),
      true,
      "service start diagnostics keep timeline output"
    );
    assertEqual(
      serviceRestart.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.endsWith("timeline.jsonl"),
      true,
      "service restart diagnostics keep timeline output"
    );
    assertEqual(
      serviceStart.NODE_OPTIONS,
      undefined,
      "service start diagnostics omit node profilers"
    );
    assertEqual(
      serviceStart.KOVA_NODE_PROFILE_DIR,
      undefined,
      "service start diagnostics omit node profile directory"
    );
    assertEqual(
      serviceRestart.NODE_OPTIONS,
      undefined,
      "service restart diagnostics omit node profilers"
    );
    assertEqual(
      serviceRestart.KOVA_NODE_PROFILE_DIR,
      undefined,
      "service restart diagnostics omit node profile directory"
    );
    assertEqual(gatewayStart.NODE_OPTIONS, undefined, "gateway start diagnostics omit node profilers");
    assertEqual(
      gatewayStart.KOVA_NODE_PROFILE_DIR,
      undefined,
      "gateway start diagnostics omit node profile directory"
    );
    assertEqual(
      noServiceStart.NODE_OPTIONS.includes("--cpu-prof"),
      true,
      "no-service product start keeps node profilers"
    );
    assertEqual(
      typeof noServiceStart.KOVA_NODE_PROFILE_DIR,
      "string",
      "no-service product start keeps node profile directory"
    );
    assertEqual(harness.NODE_OPTIONS, undefined, "harness diagnostics omit node profilers");
    assertEqual(
      harness.KOVA_NODE_PROFILE_DIR,
      undefined,
      "harness diagnostics omit node profile directory"
    );
    assertEqual(cleanup.NODE_OPTIONS, undefined, "cleanup diagnostics omit node profilers");
    assertEqual(
      cleanup.KOVA_NODE_PROFILE_DIR,
      undefined,
      "cleanup diagnostics omit node profile directory"
    );

    return {
      id: "diagnostic-profiler-measurement-scope",
      status: "PASS",
      command: "verify node profilers apply only to product measurement phases",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostic-profiler-measurement-scope",
      status: "FAIL",
      command: "verify node profilers apply only to product measurement phases",
      durationMs: 0,
      message: error.message
    };
  }
}
