import { evaluateRecord } from "../evaluator.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function browserAutomationEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.browserAutomationSmoke.v1",
      durationMs: 4200,
      browserDoctorMs: 120,
      browserStartMs: 1800,
      browserTabsMs: 90,
      browserOpenMs: 300,
      browserSnapshotMs: 250,
      browserStopMs: 180,
      browserTabCount: 2,
      browserSnapshotOk: true,
      browserStopped: true,
      errors: []
    };
    const record = {
      scenario: "browser-automation-smoke",
      status: "PASS",
      phases: [{
        id: "browser-smoke",
        results: [{
          command: "node support/browser-automation-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 4200,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "browser-automation-smoke",
      thresholds: {
        browserDoctorMs: 15000,
        browserStartMs: 30000,
        browserTabsMs: 10000,
        browserOpenMs: 15000,
        browserSnapshotMs: 15000,
        browserStopMs: 10000,
        browserTabCountMin: 1,
        browserProcessLeaks: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "browser automation record status");
    assertEqual(record.measurements.browserStartMs, 1800, "browser start ms");
    assertEqual(record.measurements.browserOpenMs, 300, "browser open ms");
    assertEqual(record.measurements.browserSnapshotMs, 250, "browser snapshot ms");
    assertEqual(record.measurements.browserTabCount, 2, "browser tab count");
    assertEqual(record.measurements.browserProcessLeaks, 0, "browser process leak count");

    const failed = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "browser-smoke",
        results: [{
          command: "node support/browser-automation-smoke.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 4200,
          stdout: JSON.stringify({ ...smoke, browserStopped: false, errors: ["browser stop failed"] }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failed, {
      id: "browser-automation-smoke",
      thresholds: { browserProcessLeaks: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failed.status, "FAIL", "browser failed stop status");
    assertEqual(
      failed.violations.some((violation) => violation.metric === "browserProcessLeaks"),
      true,
      "browser process leak violation"
    );

    return {
      id: "browser-automation-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic browser automation evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "browser-automation-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic browser automation evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

export function mediaUnderstandingEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.mediaUnderstandingTimeout.v1",
      ok: true,
      durationMs: 1600,
      mediaDescribeMs: 1250,
      mediaTimeoutObserved: true,
      mediaCommandTimedOut: false,
      mediaCommandStatus: 1,
      mediaStatusAfterTimeoutMs: 180,
      gatewayStatusWorks: true,
      errors: []
    };
    const record = {
      scenario: "media-understanding-timeout",
      status: "PASS",
      providerEvidence: { requestCount: 1 },
      phases: [{
        id: "media-timeout",
        results: [{
          command: "node support/media-understanding-timeout.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1600,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "media-understanding-timeout",
      thresholds: {
        mediaDescribeMs: 10000,
        mediaTimeoutObserved: 1,
        mediaStatusAfterTimeoutMs: 10000,
        providerRequestCountMin: 1
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "media understanding record status");
    assertEqual(record.measurements.mediaDescribeMs, 1250, "media describe ms");
    assertEqual(record.measurements.mediaTimeoutObserved, true, "media timeout observed");
    assertEqual(record.measurements.mediaCommandTimedOut, false, "media command did not hit outer timeout");
    assertEqual(record.measurements.mediaStatusAfterTimeoutMs, 180, "post-media status ms");
    assertEqual(record.measurements.mediaGatewayStatusWorks, true, "gateway status after media timeout");

    const failed = {
      ...record,
      status: "PASS",
      providerEvidence: { requestCount: 0 },
      violations: [],
      measurements: undefined,
      phases: [{
        id: "media-timeout",
        results: [{
          command: "node support/media-understanding-timeout.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1600,
          stdout: JSON.stringify({
            ...smoke,
            ok: false,
            mediaTimeoutObserved: false,
            gatewayStatusWorks: false,
            errors: ["media timeout not observed"]
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failed, {
      id: "media-understanding-timeout",
      thresholds: {
        mediaTimeoutObserved: 1,
        providerRequestCountMin: 1
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failed.status, "FAIL", "media failure status");
    assertEqual(
      failed.violations.some((violation) => violation.metric === "mediaTimeoutObserved"),
      true,
      "media timeout observed violation"
    );
    assertEqual(
      failed.violations.some((violation) => violation.metric === "providerRequestCountMin"),
      true,
      "media provider request count violation"
    );

    return {
      id: "media-understanding-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic media understanding timeout evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "media-understanding-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic media understanding timeout evidence",
      durationMs: 0,
      message: error.message
    };
  }
}

export function networkOfflineEvidenceEvaluationCheck() {
  try {
    const smoke = {
      schemaVersion: "kova.agentNetworkOffline.v1",
      ok: true,
      durationMs: 1800,
      networkTurnMs: 1400,
      networkFailureObserved: true,
      networkCommandTimedOut: false,
      networkCommandStatus: 1,
      networkStatusAfterFailureMs: 190,
      gatewayStatusWorks: true,
      errors: []
    };
    const record = {
      scenario: "agent-network-offline",
      status: "PASS",
      phases: [{
        id: "network-offline-turn",
        results: [{
          command: "node support/agent-network-offline.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1800,
          stdout: JSON.stringify(smoke),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(record, {
      id: "agent-network-offline",
      thresholds: {
        networkFailureObserved: 1,
        networkStatusAfterFailureMs: 10000
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "network offline record status");
    assertEqual(record.measurements.networkTurnMs, 1400, "network turn ms");
    assertEqual(record.measurements.networkFailureObserved, true, "network failure observed");
    assertEqual(record.measurements.networkCommandTimedOut, false, "network command did not hit outer timeout");
    assertEqual(record.measurements.networkStatusAfterFailureMs, 190, "post-network status ms");
    assertEqual(record.measurements.networkGatewayStatusWorks, true, "gateway status after network failure");

    const failed = {
      ...record,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: [{
        id: "network-offline-turn",
        results: [{
          command: "node support/agent-network-offline.mjs --env kova-self-check --artifact-dir /tmp/kova",
          status: 0,
          timedOut: false,
          durationMs: 1800,
          stdout: JSON.stringify({
            ...smoke,
            ok: false,
            networkFailureObserved: false,
            gatewayStatusWorks: false,
            errors: ["network failure not observed"]
          }),
          stderr: ""
        }],
        metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
      }]
    };
    evaluateRecord(failed, {
      id: "agent-network-offline",
      thresholds: {
        networkFailureObserved: 1
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(failed.status, "FAIL", "network failure status");
    assertEqual(
      failed.violations.some((violation) => violation.metric === "networkFailureObserved"),
      true,
      "network failure observed violation"
    );
    assertEqual(
      failed.violations.some((violation) => violation.metric === "networkGatewayStatusWorks"),
      true,
      "network gateway status violation"
    );

    return {
      id: "network-offline-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic network offline evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "network-offline-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic network offline evidence",
      durationMs: 0,
      message: error.message
    };
  }
}
