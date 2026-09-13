import { evaluateRecord } from "../evaluator.mjs";
import { zeroLogMetrics } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function pluginRecoveryEvidenceEvaluationCheck() {
  try {
    const dirtySummary = {
      schemaVersion: "kova.dirtyPluginState.v1",
      state: "dirty-plugin-local-edits",
      pluginRecords: [{ id: "kova-dirty-local-edits", dirty: true }],
      ok: true,
      failures: []
    };
    const dirtyRecord = {
      scenario: "dirty-plugin-state",
      status: "PASS",
      phases: [
        {
          id: "plugin-inspect",
          results: [
            { command: "ocm @kova-self-check -- plugins list", status: 0, durationMs: 300, stdout: "kova-dirty-local-edits dirty\n", stderr: "" },
            { command: "ocm @kova-self-check -- plugins update --all --dry-run", status: 0, durationMs: 400, stdout: "dirty plugin preserved\n", stderr: "" }
          ],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        },
        {
          id: "state-restart",
          results: [{
            command: "ocm env exec kova-self-check -- node support/dirty-plugin-state.mjs verify dirty-plugin-local-edits",
            status: 0,
            durationMs: 100,
            stdout: JSON.stringify(dirtySummary),
            stderr: ""
          }],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        }
      ],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(dirtyRecord, {
      id: "dirty-plugin-state",
      thresholds: {
        dirtyPluginDetected: 1,
        dirtyPluginReported: 1,
        dirtyPluginChecksumPreserved: 1,
        doctorDestructiveChangeCount: 0,
        pluginsUsableWithDirtyState: 1,
        gatewaySurvivedDirtyPlugin: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(dirtyRecord.status, "PASS", "dirty plugin evidence status");
    assertEqual(dirtyRecord.measurements.dirtyPluginDetected, true, "dirty plugin detected");
    assertEqual(dirtyRecord.measurements.dirtyPluginReported, true, "dirty plugin reported");
    assertEqual(dirtyRecord.measurements.dirtyPluginChecksumPreserved, true, "dirty plugin checksum preserved");
    assertEqual(dirtyRecord.measurements.doctorDestructiveChangeCount, 0, "dirty plugin destructive changes");

    const missingDirtyReport = {
      ...dirtyRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: dirtyRecord.phases.map((phase) => phase.id === "plugin-inspect"
        ? {
            ...phase,
            results: phase.results.map((result) => ({ ...result, stdout: "plugins ok\n" }))
          }
        : phase)
    };
    evaluateRecord(missingDirtyReport, {
      id: "dirty-plugin-state",
      thresholds: { dirtyPluginReported: 1, pluginLoadFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingDirtyReport.status, "FAIL", "missing dirty report status");
    assertEqual(
      missingDirtyReport.violations.some((violation) => violation.metric === "dirtyPluginReported"),
      true,
      "dirty plugin reported violation surfaced"
    );

    const destructiveDoctor = {
      ...dirtyRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: dirtyRecord.phases.map((phase) => phase.id === "state-restart"
        ? {
            ...phase,
            results: [{
              ...phase.results[0],
              status: 1,
              stdout: JSON.stringify({ ...dirtySummary, ok: false, failures: ["local edit checksum changed"] })
            }]
          }
        : phase)
    };
    evaluateRecord(destructiveDoctor, {
      id: "dirty-plugin-state",
      thresholds: {
        dirtyPluginChecksumPreserved: 1,
        doctorDestructiveChangeCount: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(destructiveDoctor.status, "FAIL", "destructive doctor status");
    assertEqual(
      destructiveDoctor.violations.some((violation) => violation.metric === "dirtyPluginChecksumPreserved" || violation.metric === "doctorDestructiveChangeCount"),
      true,
      "dirty plugin destructive change violation surfaced"
    );

    const releaseRecord = {
      scenario: "release-update-recovery",
      status: "PASS",
      phases: [
        {
          id: "upgrade",
          results: [
            { command: "ocm upgrade kova-self-check --runtime stable --json", status: 0, durationMs: 1000, stdout: "{\"ok\":true}", stderr: "" },
            { command: "ocm @kova-self-check -- --version", status: 0, durationMs: 100, stdout: "2026.5.20\n", stderr: "" }
          ],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        },
        {
          id: "plugin-health",
          results: [
            { command: "ocm @kova-self-check -- plugins list", status: 0, durationMs: 200, stdout: "plugins ok\n", stderr: "" },
            { command: "ocm @kova-self-check -- plugins update --all --dry-run", status: 0, durationMs: 250, stdout: "dry run ok\n", stderr: "" }
          ],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        },
        {
          id: "doctor-repair",
          results: [
            {
              command: "node support/run-doctor-repair.mjs --env kova-self-check",
              status: 0,
              durationMs: 300,
              stdout: JSON.stringify({
                schemaVersion: "kova.doctorRepair.v1",
                durationMs: 300,
                status: 0,
                doctorFixSucceeded: true,
                doctorUnrepairedFindingCount: 0,
                errors: []
              }),
              stderr: ""
            },
            { command: "ocm @kova-self-check -- status", status: 0, durationMs: 100, stdout: "running\n", stderr: "" }
          ],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        },
        {
          id: "update-retry",
          results: [
            { command: "ocm upgrade kova-self-check --runtime stable --json", status: 0, durationMs: 900, stdout: "{\"ok\":true}", stderr: "" },
            { command: "ocm @kova-self-check -- --version", status: 0, durationMs: 100, stdout: "2026.5.20\n", stderr: "" }
          ],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        },
        {
          id: "rollback",
          results: [
            {
              command: "node support/restore-first-ocm-upgrade-snapshot.mjs --env kova-self-check",
              status: 0,
              durationMs: 500,
              stdout: JSON.stringify({ schemaVersion: "kova.ocmUpgradeSnapshotRestore.v1", snapshotId: "snap-1", restored: { ok: true } }),
              stderr: ""
            },
            { command: "ocm @kova-self-check -- plugins list", status: 0, durationMs: 200, stdout: "plugins ok\n", stderr: "" }
          ],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        },
        {
          id: "state-rollback",
          results: [{
            command: "ocm env exec kova-self-check -- node support/dirty-plugin-state.mjs verify update-recovery-plugin-user",
            status: 0,
            durationMs: 100,
            stdout: JSON.stringify({ ...dirtySummary, state: "update-recovery-plugin-user" }),
            stderr: ""
          }],
          metrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
        }
      ],
      finalMetrics: { service: { gatewayState: "running" }, logs: zeroLogMetrics() }
    };
    evaluateRecord(releaseRecord, {
      id: "release-update-recovery",
      thresholds: {
        updateRetryVersionDrift: 0,
        doctorFixSucceeded: 1,
        doctorUnrepairedFindingCount: 0,
        rollbackAvailable: 1,
        rollbackSucceeded: 1,
        pluginsUsableAfterUpgrade: 1,
        pluginsUsableAfterRollback: 1,
        rollbackPreservedPluginData: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(releaseRecord.status, "PASS", "release recovery evidence status");
    assertEqual(releaseRecord.measurements.doctorFixSucceeded, true, "doctor fix succeeded");
    assertEqual(releaseRecord.measurements.doctorUnrepairedFindingCount, 0, "doctor unrepaired finding count");
    assertEqual(releaseRecord.measurements.updateRetryVersionDrift, 0, "update retry version drift");
    assertEqual(releaseRecord.measurements.rollbackAvailable, true, "rollback available");
    assertEqual(releaseRecord.measurements.pluginsUsableAfterRollback, true, "plugins usable after rollback");

    const missingDoctorEvidence = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.map((phase) => phase.id === "doctor-repair"
        ? {
            ...phase,
            results: [{
              command: "ocm @kova-self-check -- doctor --fix",
              status: 0,
              durationMs: 300,
              stdout: "doctor ok\n",
              stderr: ""
            }]
          }
        : phase)
    };
    evaluateRecord(missingDoctorEvidence, {
      id: "release-update-recovery",
      thresholds: {
        doctorFixSucceeded: 1,
        doctorUnrepairedFindingCount: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingDoctorEvidence.status, "FAIL", "missing doctor evidence status");
    assertEqual(
      missingDoctorEvidence.violations.some((violation) => violation.metric === "doctorFixSucceeded" || violation.metric === "doctorUnrepairedFindingCount"),
      true,
      "missing structured doctor evidence failed closed"
    );

    const unrepairedDoctor = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.map((phase) => phase.id === "doctor-repair"
        ? {
            ...phase,
            results: phase.results.map((result) => result.command.includes("run-doctor-repair.mjs")
              ? {
                  ...result,
                  status: 1,
                  stdout: JSON.stringify({
                    schemaVersion: "kova.doctorRepair.v1",
                    durationMs: 300,
                    status: 0,
                    doctorFixSucceeded: false,
                    doctorUnrepairedFindingCount: 2,
                    errors: ["doctor left 2 unrepaired findings"]
                  })
                }
              : result)
          }
        : phase)
    };
    evaluateRecord(unrepairedDoctor, {
      id: "release-update-recovery",
      thresholds: {
        doctorFixSucceeded: 1,
        doctorUnrepairedFindingCount: 0,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(unrepairedDoctor.status, "FAIL", "unrepaired doctor status");
    assertEqual(
      unrepairedDoctor.violations.some((violation) => violation.metric === "doctorFixSucceeded" || violation.metric === "doctorUnrepairedFindingCount"),
      true,
      "unrepaired doctor violation surfaced"
    );

    const missingRollback = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.map((phase) => phase.id === "rollback"
        ? {
            ...phase,
            results: phase.results.map((result) => result.command.includes("restore-first")
              ? { ...result, status: 1, stdout: "", stderr: "no OCM pre-upgrade snapshots found" }
              : result)
          }
        : phase)
    };
    evaluateRecord(missingRollback, {
      id: "release-update-recovery",
      thresholds: {
        rollbackAvailable: 1,
        rollbackSucceeded: 1,
        pluginsUsableAfterRollback: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingRollback.status, "FAIL", "missing rollback status");
    assertEqual(
      missingRollback.violations.some((violation) => violation.metric === "rollbackAvailable" || violation.metric === "rollbackSucceeded"),
      true,
      "rollback violation surfaced"
    );

    const driftedRetry = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.map((phase) => phase.id === "update-retry"
        ? {
            ...phase,
            results: phase.results.map((result) => / -- --version\b/.test(result.command)
              ? { ...result, stdout: "2026.5.21\n" }
              : result)
          }
        : phase)
    };
    evaluateRecord(driftedRetry, {
      id: "release-update-recovery",
      thresholds: { updateRetryVersionDrift: 0, pluginLoadFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(driftedRetry.status, "FAIL", "drifted retry status");
    assertEqual(
      driftedRetry.violations.some((violation) => violation.metric === "updateRetryVersionDrift"),
      true,
      "retry drift violation surfaced"
    );

    const lostRollbackFixture = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.map((phase) => phase.id === "state-rollback"
        ? {
            ...phase,
            results: phase.results.map((result) => ({
              ...result,
              status: 1,
              stdout: JSON.stringify({
                ...dirtySummary,
                state: "update-recovery-plugin-user",
                ok: false,
                failures: ["rollback fixture marker missing"]
              })
            }))
          }
        : phase)
    };
    evaluateRecord(lostRollbackFixture, {
      id: "release-update-recovery",
      thresholds: {
        rollbackPreservedPluginData: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(lostRollbackFixture.status, "FAIL", "lost rollback fixture status");
    assertEqual(
      lostRollbackFixture.violations.some((violation) => violation.metric === "rollbackPreservedPluginData"),
      true,
      "rollback fixture preservation violation surfaced"
    );

    const missingRollbackFixtureVerifier = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.filter((phase) => phase.id !== "state-rollback")
    };
    evaluateRecord(missingRollbackFixtureVerifier, {
      id: "release-update-recovery",
      thresholds: {
        rollbackPreservedPluginData: 1,
        pluginLoadFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(missingRollbackFixtureVerifier.status, "FAIL", "missing rollback fixture verifier status");
    assertEqual(
      missingRollbackFixtureVerifier.violations.some((violation) => violation.metric === "rollbackPreservedPluginData"),
      true,
      "missing rollback fixture verifier failed closed"
    );

    const unusableRollbackPlugins = {
      ...releaseRecord,
      status: "PASS",
      violations: [],
      measurements: undefined,
      phases: releaseRecord.phases.map((phase) => phase.id === "rollback"
        ? {
            ...phase,
            results: phase.results.map((result) => / -- plugins list\b/.test(result.command)
              ? { ...result, status: 1, stdout: "", stderr: "plugin list failed" }
              : result)
          }
        : phase)
    };
    evaluateRecord(unusableRollbackPlugins, {
      id: "release-update-recovery",
      thresholds: { pluginsUsableAfterRollback: 1, pluginLoadFailures: 0 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });
    assertEqual(unusableRollbackPlugins.status, "FAIL", "unusable rollback plugins status");
    assertEqual(
      unusableRollbackPlugins.violations.some((violation) => violation.metric === "pluginsUsableAfterRollback"),
      true,
      "post-rollback plugin usability violation surfaced"
    );

    return {
      id: "plugin-recovery-evidence-evaluation",
      status: "PASS",
      command: "evaluate synthetic dirty plugin and release recovery evidence",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "plugin-recovery-evidence-evaluation",
      status: "FAIL",
      command: "evaluate synthetic dirty plugin and release recovery evidence",
      durationMs: 0,
      message: error.message
    };
  }
}
