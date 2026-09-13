import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTimelineMetrics, parseTimelineText } from "../collectors/timeline.mjs";
import { compactEvaluatedTimelineEvidence, evaluateRecord } from "../evaluator.mjs";
import { renderPasteSummary, renderReportSummary } from "../reporting/report.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual, selfCheckPath } from "./harness.mjs";

export async function diagnosticsTimelineCheck() {
  try {
    const text = await readFile(selfCheckPath("fixtures", "diagnostics", "timeline.jsonl"), "utf8");
    const timeline = parseTimelineText(text);
    assertEqual(timeline.available, true, "timeline available");
    assertEqual(timeline.eventCount, 9, "timeline event count");
    assertEqual(timeline.parseErrorCount, 0, "timeline parse errors");
    assertEqual(
      timeline.repeatedSpans.some((span) => span.name === "plugins.metadata.scan"),
      true,
      "repeated plugin metadata span"
    );
    assertEqual(timeline.runtimeDeps.slowest?.pluginId, "browser", "runtime deps slowest plugin");
    assertEqual(timeline.runtimeDeps.byPlugin[1]?.pluginId, "memory-core", "runtime deps by plugin");
    assertEqual(timeline.eventLoop.maxMs, 214, "event loop max");
    assertEqual(timeline.providers.maxDurationMs, 1220, "provider duration");
    assertEqual(timeline.childProcesses.failedCount, 1, "child process failures");
    assertEqual(timeline.keySpans["gateway.startup"].maxDurationMs, 2450, "gateway startup key span");
    assertEqual(timeline.keySpans["plugins.load"].maxDurationMs, 820, "plugin load key span");
    const whitespaceNumbers = parseTimelineText(
      `${JSON.stringify({
        type: "provider.request",
        name: "provider.request",
        timestampEpochMs: " ",
        durationMs: "\t"
      })}\n`
    );
    assertEqual(whitespaceNumbers.events[0]?.durationMs, undefined, "whitespace timeline duration is unavailable");
    assertEqual(
      whitespaceNumbers.turnAttributionEvents[0]?.timestampEpochMs,
      null,
      "whitespace timeline timestamp is unavailable"
    );
    return {
      id: "diagnostics-timeline-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/timeline.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-timeline-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/timeline.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function diagnosticsOpenSpanCheck() {
  let artifactDir = null;
  try {
    const text = await readFile(
      selfCheckPath("fixtures", "diagnostics", "timeline-open-span.jsonl"),
      "utf8"
    );
    const timeline = parseTimelineText(text);
    assertEqual(timeline.available, true, "open timeline available");
    assertEqual(timeline.openSpanCount, 1, "open span count");
    assertEqual(timeline.openSpans[0]?.name, "runtimeDeps.stage", "open span name");
    assertEqual(timeline.openSpans[0]?.ageMs, 5000, "open span age");
    assertEqual(timeline.openSpans[0]?.pid, 100, "open span pid");
    assertEqual(timeline.keySpans["runtimeDeps.stage"].openCount, 1, "key open span count");
    const partialPidTimeline = parseTimelineText([
      '{"type":"span.start","timestamp":"2026-04-29T15:30:00.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","pid":100}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:01.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","durationMs":1000}'
    ].join("\n"));
    assertEqual(partialPidTimeline.openSpanCount, 0, "span pair tolerates PID omitted from one event");
    const duplicatePartialPidTimeline = parseTimelineText([
      '{"type":"span.start","timestamp":"2026-04-29T15:30:00.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","pid":100}',
      '{"type":"span.start","timestamp":"2026-04-29T15:30:01.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","pid":200}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:02.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","durationMs":1000}'
    ].join("\n"));
    assertEqual(duplicatePartialPidTimeline.openSpanCount, 1, "PID-less terminal closes newest reused span");
    assertEqual(duplicatePartialPidTimeline.openSpans[0]?.pid, 100, "prior reused span stays open");
    const terminalBeforeReuseTimeline = parseTimelineText([
      '{"type":"span.start","timestamp":"2026-04-29T15:30:00.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","pid":100}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:01.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","durationMs":1000}',
      '{"type":"span.start","timestamp":"2026-04-29T15:30:02.000Z","name":"runtimeDeps.stage","spanId":"partial-pid","pid":200}'
    ].join("\n"));
    assertEqual(terminalBeforeReuseTimeline.openSpanCount, 1, "earlier terminal cannot close later reused span");
    assertEqual(terminalBeforeReuseTimeline.openSpans[0]?.pid, 200, "later reused span stays open");
    const partialPidNoIdTimeline = parseTimelineText([
      '{"type":"span.start","timestamp":"2026-04-29T15:30:00.000Z","name":"runtimeDeps.stage","pid":100}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:01.000Z","name":"runtimeDeps.stage","durationMs":1000}'
    ].join("\n"));
    assertEqual(partialPidNoIdTimeline.openSpanCount, 0, "name fallback tolerates PID omitted from one event");
    artifactDir = await mkdtemp(join(tmpdir(), "kova-timeline-"));
    await mkdir(join(artifactDir, "openclaw"));
    await writeFile(join(artifactDir, "openclaw", "timeline.jsonl"), [
      '{"type":"span.end","timestamp":"2026-04-29T15:30:00.000Z","name":"gateway.startup","spanId":"ordinary","pid":100,"durationMs":100}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:01.000Z","name":"gateway.startup","spanId":"ordinary","pid":200,"durationMs":100}'
    ].join("\n"));
    const collected = await collectTimelineMetrics(artifactDir);
    assertEqual(collected.gatewayPids.join(","), "100,200", "collector gateway PID history");
    assertEqual(collected.terminalGatewayPid, 200, "collector terminal gateway PID");
    return {
      id: "diagnostics-open-span-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/timeline-open-span.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-open-span-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/timeline-open-span.jsonl",
      durationMs: 0,
      message: error.message
    };
  } finally {
    if (artifactDir) {
      await rm(artifactDir, { recursive: true, force: true });
    }
  }
}

export async function malformedTimelineCheck(tmp) {
  const artifactDir = join(tmp, "malformed-timeline");
  try {
    await mkdir(join(artifactDir, "openclaw"), { recursive: true });
    await writeFile(join(artifactDir, "openclaw", "timeline.jsonl"), "{not-json}\n[]\n");
    const timeline = await collectTimelineMetrics(artifactDir);
    assertEqual(timeline.available, false, "malformed timeline has no valid events");
    assertEqual(timeline.parseErrorCount, 2, "malformed timeline parse errors retained");
    assertEqual(timeline.parseErrors.length, 2, "malformed timeline parse error details retained");
    assertEqual(timeline.artifacts.length, 1, "malformed timeline artifact retained");
    assertEqual(timeline.statusLabel, "WARN", "malformed timeline is warning-classified");
    assertEqual(timeline.error.includes("contained no valid events"), true, "malformed timeline is not reported missing");
    await writeFile(
      join(artifactDir, "openclaw", "timeline.jsonl"),
      '{"schemaVersion":"openclaw.diagnostics.v1","type":"span.end","timestamp":"2026-04-29T15:30:00.000Z","name":"gateway.startup","spanId":"1","durationMs":10}\n{not-json}\n'
    );
    const partial = await collectTimelineMetrics(artifactDir);
    assertEqual(partial.available, true, "partially malformed timeline retains valid events");
    assertEqual(partial.eventCount, 1, "partially malformed timeline counts valid events");
    assertEqual(partial.parseErrorCount, 1, "partially malformed timeline retains parse failures");
    assertEqual(partial.statusLabel, "WARN", "partial corruption takes precedence over availability");
    assertEqual(partial.error.includes("1 malformed record"), true, "partial corruption is explained");
    return {
      id: "malformed-timeline-evidence",
      status: "PASS",
      command: "collect malformed timeline evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "malformed-timeline-evidence",
      status: "FAIL",
      command: "collect malformed timeline evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

export function diagnosticsTimelineEvaluationCheck() {
  try {
    const missingTimelineRecord = {
      scenario: "diagnostic-missing-timeline",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: {
          available: false,
          eventCount: 0,
          parseErrorCount: 0,
          openSpanCount: 0,
          openSpans: [],
          keySpans: {},
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    evaluateRecord(missingTimelineRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: {
        id: "diagnostic",
        diagnostics: {
          timelineRequired: true,
          timelineRequiredForTargetKinds: ["local-build"]
        }
      },
      surface: {
        id: "release-runtime-startup",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(missingTimelineRecord.status, "FAIL", "missing diagnostic timeline status");
    assertEqual(
      missingTimelineRecord.violations.some((violation) => violation.metric === "openclawTimelineAvailable"),
      true,
      "missing diagnostic timeline violation"
    );

    const missingSpanRecord = {
      scenario: "diagnostic-missing-span",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: {
          available: true,
          eventCount: 1,
          parseErrorCount: 0,
          openSpanCount: 0,
          openSpans: [],
          keySpans: {},
          spanTotals: {
            "gateway.startup": { count: 1, totalDurationMs: 100, maxDurationMs: 100 }
          },
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    evaluateRecord(missingSpanRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(missingSpanRecord.status, "PASS", "missing expected span alone does not fail user path");
    assertEqual(missingSpanRecord.measurements.openclawMissingRequiredSpanCount, 1, "missing required span measurement");
    assertEqual(missingSpanRecord.measurements.openclawMissingRequiredSpanSeverity, "diagnostic-gap", "missing expected span severity");
    assertEqual(
      (missingSpanRecord.violations ?? []).some((violation) => violation.metric === "openclawMissingRequiredSpanCount"),
      false,
      "missing expected span does not become violation by default"
    );

    const strictMissingSpanRecord = structuredClone(missingSpanRecord);
    strictMissingSpanRecord.status = "PASS";
    strictMissingSpanRecord.violations = [];
    strictMissingSpanRecord.measurements = undefined;
    evaluateRecord(strictMissingSpanRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: {
          expectedSpans: ["runtimeDeps.stage"],
          missingExpectedSpanSeverity: "fail"
        },
        thresholds: {}
      }
    });
    assertEqual(strictMissingSpanRecord.status, "FAIL", "strict missing span status");
    assertEqual(strictMissingSpanRecord.measurements.openclawMissingRequiredSpanSeverity, "fail", "strict missing span severity");
    assertEqual(
      strictMissingSpanRecord.violations.some((violation) => violation.metric === "openclawMissingRequiredSpanCount"),
      true,
      "strict missing span violation"
    );

    const runtimeDepsStart =
      "{\"type\":\"span.start\",\"timestamp\":\"2026-04-29T15:30:00.000Z\",\"name\":\"runtimeDeps.stage\",\"spanId\":\"1\"}";
    const openRuntimeDepsTimeline = parseTimelineText([
      runtimeDepsStart,
      "{\"type\":\"eventLoop.sample\",\"timestamp\":\"2026-04-29T15:30:06.000Z\",\"name\":\"eventLoop\",\"maxMs\":400}"
    ].join("\n"));
    const closedRuntimeDepsTimeline = parseTimelineText([
      runtimeDepsStart,
      "{\"type\":\"span.end\",\"timestamp\":\"2026-04-29T15:30:06.000Z\",\"name\":\"runtimeDeps.stage\",\"spanId\":\"1\",\"durationMs\":6000}"
    ].join("\n"));
    const longerOpenRuntimeDepsTimeline = parseTimelineText([
      runtimeDepsStart,
      "{\"type\":\"eventLoop.sample\",\"timestamp\":\"2026-04-29T15:30:04.000Z\",\"name\":\"eventLoop\",\"maxMs\":400}",
      "{\"type\":\"eventLoop.sample\",\"timestamp\":\"2026-04-29T15:30:05.000Z\",\"name\":\"eventLoop\",\"maxMs\":500}"
    ].join("\n"));
    const runtimeDepsTimelineOptions = {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    };
    const closedSpanRecord = {
      scenario: "diagnostic-closed-span",
      status: "PASS",
      phases: [{ id: "gateway-start", metrics: { timeline: longerOpenRuntimeDepsTimeline } }],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: closedRuntimeDepsTimeline
      }
    };
    evaluateRecord(closedSpanRecord, { thresholds: {} }, runtimeDepsTimelineOptions);
    assertEqual(closedSpanRecord.status, "PASS", "required span closed by final timeline status");
    assertEqual(closedSpanRecord.measurements.openclawOpenSpanCount, 0, "final timeline open span count");
    assertEqual(closedSpanRecord.measurements.openclawOpenRequiredSpanCount, 0, "final required open span count");
    assertEqual(closedSpanRecord.measurements.openclawOpenSpans.length, 0, "final timeline open span list");
    assertEqual(
      closedSpanRecord.measurements.openclawKeySpans["runtimeDeps.stage"]?.openCount,
      0,
      "final timeline key span open count"
    );
    assertEqual(
      closedSpanRecord.measurements.openclawKeySpans["runtimeDeps.stage"]?.open.length,
      0,
      "final timeline key span open list"
    );
    assertEqual(closedSpanRecord.measurements.openclawTimelineEventCount, 3, "historical event-count maximum");
    assertEqual(closedSpanRecord.measurements.openclawEventLoopMaxMs, 500, "historical event-loop maximum");
    assertEqual(closedSpanRecord.measurements.openclawSlowestSpanMs, 6000, "historical slowest span");

    const cumulativeTimelineRecord = {
      scenario: "diagnostic-cumulative-timeline",
      status: "PASS",
      phases: [{
        id: "gateway-start",
        metrics: {
          timeline: parseTimelineText(runtimeDepsStart)
        }
      }],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: closedRuntimeDepsTimeline
      }
    };
    evaluateRecord(cumulativeTimelineRecord, { thresholds: {} }, runtimeDepsTimelineOptions);
    compactEvaluatedTimelineEvidence(cumulativeTimelineRecord);
    assertEqual(
      cumulativeTimelineRecord.phases[0].metrics.timeline.events,
      undefined,
      "redundant cumulative timeline events compacted"
    );
    assertEqual(
      cumulativeTimelineRecord.finalMetrics.timeline.events.length,
      2,
      "latest cumulative timeline events retained"
    );
    assertEqual(
      cumulativeTimelineRecord.finalMetrics.timeline.openSpansAll,
      undefined,
      "uncapped evaluation-only open spans compacted"
    );

    const openSpanRecord = {
      scenario: "diagnostic-open-span",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: openRuntimeDepsTimeline
      }
    };
    evaluateRecord(openSpanRecord, { thresholds: {} }, runtimeDepsTimelineOptions);
    assertEqual(openSpanRecord.status, "FAIL", "required span still open in final timeline status");
    assertEqual(openSpanRecord.measurements.openclawOpenRequiredSpanCount, 1, "open required span measurement");
    assertEqual(
      openSpanRecord.violations.some((violation) => violation.metric === "openclawOpenRequiredSpanCount"),
      true,
      "open required span violation"
    );
    const reportSummary = renderReportSummary({
      schemaVersion: "kova.report.v1",
      generatedAt: "2026-04-29T15:30:10.000Z",
      runId: "self-check-diagnostics",
      summary: { total: 1, statuses: { FAIL: 1 } },
      records: [openSpanRecord]
    }, { structured: true });
    assertEqual(
      reportSummary.scenarios[0]?.measurements?.diagnostics?.openRequiredSpanCount,
      1,
      "structured report open span evidence"
    );
    assertEqual(
      reportSummary.scenarios[0]?.measurements?.diagnostics?.openSpans?.[0]?.name,
      "runtimeDeps.stage",
      "structured report open span name"
    );
    assertEqual(
      renderPasteSummary({
        runId: "self-check-diagnostics",
        target: "local-build:/tmp/openclaw",
        mode: "self-check",
        records: [openSpanRecord]
      }).includes("openRequiredSpans: 1"),
      true,
      "brief evidence includes open required spans"
    );

    const restartedTimeline = parseTimelineText([
      '{"type":"mark","timestamp":"2026-04-29T15:30:00.000Z","name":"gateway.ready","pid":100}',
      '{"type":"span.start","timestamp":"2026-04-29T15:30:01.000Z","name":"plugins.metadata.scan","spanId":"reused","pid":100}',
      '{"type":"span.start","timestamp":"2026-04-29T15:30:02.000Z","name":"gateway.ready","spanId":"gateway-startup-33","pid":200}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:03.000Z","name":"gateway.ready","spanId":"gateway-startup-33","pid":200,"durationMs":1000}',
      '{"type":"span.start","timestamp":"2026-04-29T15:30:04.000Z","name":"plugins.metadata.scan","spanId":"reused","pid":200}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:05.000Z","name":"plugins.metadata.scan","spanId":"reused","pid":200,"durationMs":1000}'
    ].join("\n"));
    assertEqual(restartedTimeline.openSpanCount, 1, "PID identity preserves prior interrupted span");
    assertEqual(restartedTimeline.openSpans[0]?.pid, 100, "prior gateway PID preserved in compact evidence");
    assertEqual(restartedTimeline.terminalGatewayPid, 200, "terminal gateway PID");

    const restartedSpanRecord = {
      scenario: "diagnostic-restarted-span",
      status: "PASS",
      phases: [
        {
          id: "before-restart",
          metrics: {
            timeline: parseTimelineText(restartedTimeline.events
              .filter((event) => event.pid === 100)
              .map((event) => JSON.stringify(event))
              .join("\n"))
          }
        },
        {
          id: "warm-restart",
          results: [{ command: "ocm service restart 'fixture'", status: 0 }]
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: restartedTimeline
      }
    };
    const pluginTimelineOptions = {
      ...runtimeDepsTimelineOptions,
      surface: {
        id: "gateway-performance",
        diagnostics: { expectedSpans: ["plugins.metadata.scan"] },
        thresholds: {}
      }
    };
    evaluateRecord(restartedSpanRecord, { thresholds: {} }, pluginTimelineOptions);
    assertEqual(restartedSpanRecord.status, "PASS", "intentional restart interrupted span does not fail terminal gateway");
    assertEqual(restartedSpanRecord.measurements.openclawOpenRequiredSpanCount, 0, "prior PID span is not terminal-open");
    assertEqual(restartedSpanRecord.measurements.openclawInterruptedRestartSpanCount, 1, "restart interruption evidence count");
    assertEqual(restartedSpanRecord.measurements.openclawInterruptedRestartSpans[0]?.pid, 100, "restart interruption evidence PID");

    const terminalOpenTimeline = parseTimelineText([
      ...restartedTimeline.events.map((event) => JSON.stringify(event)),
      ...Array.from({ length: 30 }, (_, index) => JSON.stringify({
        type: "span.start",
        timestamp: `2026-04-29T15:31:${String(index).padStart(2, "0")}.000Z`,
        name: "plugins.metadata.scan",
        spanId: `terminal-open-${index}`,
        pid: 200
      }))
    ].join("\n"));
    const terminalOpenRecord = structuredClone(restartedSpanRecord);
    terminalOpenRecord.status = "PASS";
    terminalOpenRecord.measurements = undefined;
    terminalOpenRecord.finalMetrics.timeline = terminalOpenTimeline;
    evaluateRecord(terminalOpenRecord, { thresholds: {} }, pluginTimelineOptions);
    assertEqual(terminalOpenRecord.status, "FAIL", "terminal gateway PID open span stays strict");
    assertEqual(terminalOpenRecord.measurements.openclawOpenRequiredSpanCount, 30, "terminal PID required open span count");
    assertEqual(terminalOpenRecord.measurements.openclawOpenSpanCount, 30, "uncapped terminal open span count");
    assertEqual(terminalOpenRecord.measurements.openclawOpenSpans.length, 25, "terminal open span evidence cap");
    assertEqual(terminalOpenRecord.measurements.openclawKeySpans["plugins.metadata.scan"].openCount, 30, "key span count stays uncapped");
    assertEqual(terminalOpenRecord.measurements.openclawOpenSpans[0]?.pid, 200, "terminal PID evidence preserved");

    const unexpectedRestartTimeline = parseTimelineText([
      ...restartedTimeline.events.map((event) => JSON.stringify(event)),
      '{"type":"span.start","timestamp":"2026-04-29T15:30:06.000Z","name":"plugins.metadata.scan","spanId":"unexpected-interrupted","pid":200}',
      '{"type":"span.end","timestamp":"2026-04-29T15:30:07.000Z","name":"gateway.startup","spanId":"gateway-300","pid":300,"durationMs":100}'
    ].join("\n"));
    const unexpectedRestartRecord = structuredClone(restartedSpanRecord);
    unexpectedRestartRecord.status = "PASS";
    unexpectedRestartRecord.measurements = undefined;
    unexpectedRestartRecord.finalMetrics.timeline = unexpectedRestartTimeline;
    evaluateRecord(unexpectedRestartRecord, { thresholds: {} }, pluginTimelineOptions);
    assertEqual(unexpectedRestartRecord.status, "FAIL", "unexpected later restart remains strict");
    assertEqual(unexpectedRestartRecord.measurements.openclawOpenRequiredSpanCount, 2, "ambiguous restart chain fails closed");
    assertEqual(
      unexpectedRestartRecord.measurements.openclawOpenSpans.some((span) => span.pid === 200),
      true,
      "unexpected prior PID evidence preserved"
    );

    const manyInterruptedLines = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({
        type: "span.start",
        timestamp: `2026-04-29T15:30:${String(index).padStart(2, "0")}.000Z`,
        name: "plugins.metadata.scan",
        spanId: `prior-${index}`,
        pid: 100
      })
    );
    const crowdedRestartTimeline = parseTimelineText([
      '{"type":"mark","timestamp":"2026-04-29T15:29:59.000Z","name":"gateway.ready","pid":100}',
      ...manyInterruptedLines,
      '{"type":"span.end","timestamp":"2026-04-29T15:31:00.000Z","name":"gateway.startup","spanId":"gateway-200","pid":200,"durationMs":100}',
      '{"type":"span.start","timestamp":"2026-04-29T15:31:01.000Z","name":"plugins.metadata.scan","spanId":"terminal-crowded","pid":200}'
    ].join("\n"));
    const crowdedRestartRecord = {
      scenario: "diagnostic-crowded-restart",
      status: "PASS",
      phases: [
        {
          id: "before-restart",
          metrics: { timeline: parseTimelineText([
            '{"type":"mark","timestamp":"2026-04-29T15:29:59.000Z","name":"gateway.ready","pid":100}',
            ...manyInterruptedLines
          ].join("\n")) }
        },
        {
          id: "warm-restart",
          results: [{ command: "ocm service restart 'fixture'", status: 0 }],
          metrics: { timeline: crowdedRestartTimeline }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: crowdedRestartTimeline
      }
    };
    evaluateRecord(crowdedRestartRecord, { thresholds: {} }, pluginTimelineOptions);
    assertEqual(crowdedRestartRecord.status, "FAIL", "terminal open span survives compact evidence cap");
    assertEqual(crowdedRestartRecord.measurements.openclawOpenRequiredSpanCount, 1, "crowded terminal required span count");
    assertEqual(crowdedRestartRecord.measurements.openclawInterruptedRestartSpanCount, 30, "all crowded restart spans classified");

    return {
      id: "diagnostics-timeline-evaluation",
      status: "PASS",
      command: "evaluate synthetic diagnostic timeline records",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-timeline-evaluation",
      status: "FAIL",
      command: "evaluate synthetic diagnostic timeline records",
      durationMs: 0,
      message: error.message
    };
  }
}
