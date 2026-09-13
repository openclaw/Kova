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
    evaluateRecord(record, {
      id: "soak",
      thresholds: {
        soakMinDurationMs: 60000,
        soakCommandP95Ms: 10000,
        soakHealthP95Ms: 1000,
        soakCommandFailures: 0,
        soakHealthFailures: 0,
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
