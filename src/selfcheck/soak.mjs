import { evaluateRecord } from "../evaluator.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function soakTrendEvaluationCheck() {
  try {
    const loop = {
      schemaVersion: "kova.soakLoop.v1",
      durationMs: 65000,
      iterations: 3,
      commandSummary: {
        count: 9,
        okCount: 9,
        failureCount: 0,
        p95Ms: 900,
        maxMs: 1200
      },
      healthSummary: {
        count: 3,
        okCount: 3,
        failureCount: 0,
        p95Ms: 45,
        maxMs: 60
      }
    };
    const record = {
      scenario: "soak",
      status: "PASS",
      phases: [{
        id: "loop",
        results: [{
          command: "node support/run-soak-loop.mjs --env kova-self-check --duration-ms 60000",
          status: 0,
          timedOut: false,
          durationMs: 65000,
          stdout: JSON.stringify(loop),
          stderr: "",
          resourceSamples: {
            sampleCount: 3,
            peakTotalRssMb: 1000,
            maxTotalCpuPercent: 80,
            peakGatewayRssMb: 900,
            peakCommandTreeRssMb: 100,
            byRole: {},
            topRolesByRss: [],
            topRolesByCpu: [],
            topByRss: [],
            topByCpu: [],
            trend: {
              schemaVersion: "kova.resourceTrend.v1",
              available: true,
              totalRssGrowthMb: 420,
              gatewayRssGrowthMb: 390
            }
          }
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    const soakThresholds = {
      soakMinDurationMs: 60000,
      soakCommandP95Ms: 10000,
      soakHealthP95Ms: 1000,
      soakCommandFailures: 0,
      soakHealthFailures: 0
    };
    const evaluateLoops = (outputs, thresholds = soakThresholds) => {
      const candidate = structuredClone(record);
      candidate.phases[0].results = outputs.map((output) => ({
        ...structuredClone(record.phases[0].results[0]),
        stdout: typeof output === "string" ? output : JSON.stringify(output)
      }));
      return evaluateRecord(candidate, { id: "soak", thresholds }, {
        surface: { thresholds: {} }, targetPlan: { kind: "npm" }
      });
    };
    const metrics = [
      ["soakDurationMs", null, "durationMs", 59999],
      ["soakCommandP95Ms", "commandSummary", "p95Ms", 10001],
      ["soakCommandFailures", "commandSummary", "failureCount", 1],
      ["soakHealthP95Ms", "healthSummary", "p95Ms", 1001],
      ["soakHealthFailures", "healthSummary", "failureCount", 1]
    ];
    const assertMissing = (evaluated, missing, label) => {
      assertEqual(evaluated.status, "FAIL", `${label} cannot pass configured soak gates`);
      for (const metric of missing) {
        assertEqual(evaluated.measurements[metric], null, `${label} keeps ${metric} unknown`);
        const violation = evaluated.violations?.find((entry) => entry.metric === metric);
        assertEqual(violation?.actual, null, `${label} reports missing ${metric}`);
        assertEqual(violation?.message.includes("evidence was not captured"), true, `${label} explains missing ${metric}`);
      }
    };

    assertEqual(evaluateLoops([loop]).status, "PASS", "complete soak evidence passes without the RSS regression gate");
    assertEqual(evaluateLoops([], {}).status, "PASS", "unconfigured soak gates stay optional");
    for (const outputs of [
      [], [""], ["{"], [{ ...loop, schemaVersion: "wrong" }],
      [{ schemaVersion: loop.schemaVersion }], [loop, "{"], [loop, { schemaVersion: loop.schemaVersion }]
    ]) {
      assertMissing(evaluateLoops(outputs), metrics.map(([metric]) => metric), "absent or incomplete soak receipt");
    }
    for (const [metric, group, field, breach] of metrics) {
      const changed = (value) => {
        const copy = structuredClone(loop);
        (group ? copy[group] : copy)[field] = value;
        return copy;
      };
      const invalid = [undefined, null, "0", -1, {}, true];
      if (field === "failureCount") invalid.push(0.5, Number.MAX_SAFE_INTEGER + 1);
      for (const value of invalid) {
        const bad = changed(value);
        const label = `${metric}=${JSON.stringify(value)}`;
        assertMissing(evaluateLoops([bad]), [metric], label);
        assertMissing(evaluateLoops([loop, bad]), [metric], `partial ${label}`);
      }
      const failed = evaluateLoops([changed(breach)]);
      assertEqual(failed.status, "FAIL", `${metric} threshold breach fails`);
      assertEqual(failed.measurements[metric], breach, `${metric} measured breach remains available`);
      assertEqual(failed.violations?.find((entry) => entry.metric === metric)?.actual, breach, `${metric} violation keeps measured value`);
    }
    assertMissing(evaluateLoops([JSON.stringify(loop).replace('"durationMs":65000', '"durationMs":1e309')]), ["soakDurationMs"], "nonfinite soak duration");
    const aggregateLoop = structuredClone(loop);
    aggregateLoop.durationMs = 70000;
    aggregateLoop.commandSummary.p95Ms = 950;
    aggregateLoop.healthSummary.p95Ms = 50;
    const aggregate = evaluateLoops([loop, aggregateLoop]);
    assertEqual(aggregate.status, "PASS", "complete repeated soak receipts pass");
    assertEqual(aggregate.measurements.soakDurationMs, 70000, "soak duration keeps maximum");
    assertEqual(aggregate.measurements.soakCommandP95Ms, 950, "soak command latency keeps maximum");
    assertEqual(aggregate.measurements.soakHealthP95Ms, 50, "soak health latency keeps maximum");
    aggregateLoop.commandSummary.failureCount = 1;
    aggregateLoop.healthSummary.failureCount = 1;
    const failures = evaluateLoops([aggregateLoop, aggregateLoop]);
    assertEqual(failures.measurements.soakCommandFailures, 2, "soak command failure counts add across receipts");
    assertEqual(failures.measurements.soakHealthFailures, 2, "soak health failure counts add across receipts");

    evaluateRecord(record, {
      id: "soak",
      thresholds: {
        ...soakThresholds,
        rssGrowthMb: 300,
        gatewayRssGrowthMb: 300
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "FAIL", "soak trend record status");
    assertEqual(record.measurements.soakIterations, 3, "soak iterations");
    assertEqual(record.measurements.soakCommandP95Ms, 900, "soak command p95");
    assertEqual(record.measurements.rssGrowthMb, 420, "soak total RSS growth");
    assertEqual(record.measurements.gatewayRssGrowthMb, 390, "soak gateway RSS growth");
    assertEqual(
      record.violations.some((violation) => violation.metric === "rssGrowthMb"),
      true,
      "soak RSS growth violation"
    );

    return {
      id: "soak-trend-evaluation",
      status: "PASS",
      command: "evaluate synthetic soak trend regression",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "soak-trend-evaluation",
      status: "FAIL",
      command: "evaluate synthetic soak trend regression",
      durationMs: 0,
      message: error.message
    };
  }
}
