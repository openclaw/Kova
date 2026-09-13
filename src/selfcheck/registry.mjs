import { validateProfileShape } from "../registries/profiles.mjs";
import { validateScenarioShape } from "../registries/scenarios.mjs";
import { validateStateShape } from "../registries/states.mjs";
import { validateRegistryReferences } from "../registries/validate.mjs";
import { assertEqual, readSelfCheckJson } from "./harness.mjs";

export function stateRegistryValidationCheck() {
  try {
    let rejectedTrait = false;
    try {
      validateStateShape({
        id: "bad-state",
        title: "Bad State",
        objective: "Invalid state fixture",
        tags: [],
        traits: ["not-a-real-trait"],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: ["evidence"],
        cleanupGuarantees: ["cleanup"],
        setup: []
      }, "bad-state.json");
    } catch (error) {
      rejectedTrait = /unknown trait/.test(error.message);
    }
    assertEqual(rejectedTrait, true, "unknown state trait rejected");

    let rejectedEvidence = false;
    try {
      validateStateShape({
        id: "bad-evidence-state",
        title: "Bad Evidence State",
        objective: "Invalid state fixture evidence",
        tags: [],
        traits: ["fresh-user"],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: [],
        cleanupGuarantees: [],
        setup: []
      }, "bad-evidence-state.json");
    } catch (error) {
      rejectedEvidence = /setupEvidence must not be empty/.test(error.message) &&
        /cleanupGuarantees must not be empty/.test(error.message);
    }
    assertEqual(rejectedEvidence, true, "empty state evidence rejected");

    let rejectedStateCollectionIntent = false;
    try {
      validateStateShape({
        id: "bad-collection-state",
        title: "Bad Collection State",
        objective: "Invalid collection intent.",
        tags: [],
        traits: ["fresh-user"],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: ["evidence"],
        cleanupGuarantees: ["cleanup"],
        setup: [{
          id: "bad-intent",
          title: "Bad Intent",
          intent: "Invalid collection intent.",
          afterPhase: "provision",
          commands: ["true"],
          evidence: ["evidence"],
          collectionIntent: "tiny"
        }]
      }, "bad-collection-state.json");
    } catch (error) {
      rejectedStateCollectionIntent = /collectionIntent must be one of/.test(error.message);
    }
    assertEqual(rejectedStateCollectionIntent, true, "invalid state collection intent rejected");

    let rejectedScenarioCollectionIntent = false;
    try {
      validateScenarioShape({
        id: "bad-collection-scenario",
        surface: "fresh-install",
        title: "Bad Collection Scenario",
        objective: "Invalid collection intent.",
        tags: [],
        thresholds: {},
        phases: [{
          id: "provision",
          title: "Provision",
          intent: "Provision.",
          healthScope: "none",
          commands: ["true"],
          evidence: [],
          collectionIntent: "tiny"
        }],
        proves: []
      }, "bad-collection-scenario.json");
    } catch (error) {
      rejectedScenarioCollectionIntent = /collectionIntent must be one of/.test(error.message);
    }
    assertEqual(rejectedScenarioCollectionIntent, true, "invalid scenario collection intent rejected");

    let rejectedSurface = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["baseline"],
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "state",
          traits: ["fresh-user"],
          incompatibleSurfaces: ["missing-surface"]
        }],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          requirements: [{
            id: "baseline",
            states: ["state"],
            targetKinds: ["runtime"],
            metrics: []
          }]
        }],
        processRoles: []
      });
    } catch (error) {
      rejectedSurface = /incompatibleSurfaces references unknown surface/.test(error.message);
    }
    assertEqual(rejectedSurface, true, "unknown incompatible surface rejected");

    let rejectedPurpose = false;
    try {
      validateProfileShape({
        id: "profile",
        title: "Bad Profile",
        objective: "Invalid purpose.",
        entries: [{ scenario: "scenario", state: "state" }],
        purpose: "made-up-purpose"
      }, "bad-profile.json");
    } catch (error) {
      rejectedPurpose = /unknown purpose/.test(error.message);
    }
    assertEqual(rejectedPurpose, true, "unknown profile purpose rejected");

    let rejectedLocalBuildProfile = false;
    try {
      validateProfileShape({
        id: "profile",
        title: "Bad Local Build Profile",
        objective: "Invalid local build profile target.",
        entries: [{ scenario: "scenario", state: "state" }],
        targetKinds: ["runtime"],
        localBuildProfile: "sourcePerformance"
      }, "bad-local-build-profile.json");
    } catch (error) {
      rejectedLocalBuildProfile = /requires targetKinds to include local-build/.test(error.message);
    }
    assertEqual(rejectedLocalBuildProfile, true, "local build profile requires local-build target");

    let rejectedDerivedCoverage = false;
    try {
      validateProfileShape({
        id: "profile",
        title: "Bad Profile Coverage",
        objective: "Invalid derived profile coverage.",
        entries: [{ scenario: "scenario", state: "state" }],
        gate: {
          coverage: {
            surfaces: {
              blocking: ["surface"]
            }
          }
        }
      }, "bad-profile-coverage.json");
    } catch (error) {
      rejectedDerivedCoverage = /coverage\.surfaces is derived/.test(error.message);
    }
    assertEqual(rejectedDerivedCoverage, true, "derived profile coverage rejected");

    let rejectedRequirement = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["missing-requirement"],
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "state",
          traits: ["fresh-user"],
        }],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          thresholds: { knownMetric: 1 },
          requirements: [{
            id: "baseline",
            states: ["missing-state"],
            stateTraits: ["not-a-trait"],
            targetKinds: ["unsupported-target"],
            metrics: ["madeUpMetric"]
          }]
        }],
        processRoles: [],
        metrics: [{ id: "knownMetric" }]
      });
    } catch (error) {
      rejectedRequirement = /proves unknown surface requirement/.test(error.message) &&
        /references unknown state 'missing-state'/.test(error.message) &&
        /references unknown state trait 'not-a-trait'/.test(error.message) &&
        /unsupported-target/.test(error.message) &&
        /unknown metric 'madeUpMetric'/.test(error.message);
    }
    assertEqual(rejectedRequirement, true, "invalid surface requirement and scenario proof rejected");

    let rejectedMetric = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["baseline"],
          thresholds: { madeUpMetric: 1 },
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          thresholds: { knownMetric: 1 },
          requirements: [{
            id: "baseline",
            states: ["state"],
            targetKinds: ["runtime"],
            metrics: ["knownMetric"]
          }]
        }],
        processRoles: [],
        metrics: [{ id: "knownMetric" }]
      });
    } catch (error) {
      rejectedMetric = /unknown metric 'madeUpMetric'/.test(error.message);
    }
    assertEqual(rejectedMetric, true, "unknown scenario metric rejected");

    for (const value of ["100", true, {}, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      let rejectedThresholdValue = false;
      try {
        validateRegistryReferences({
          scenarios: [{
            id: "scenario",
            surface: "known-surface",
            proves: ["baseline"],
            thresholds: { knownMetric: value },
            states: [],
            targetKinds: [],
            processRoles: []
          }],
          states: [],
          profiles: [],
          surfaces: [{
            id: "known-surface",
            processRoles: [],
            thresholds: {},
            requirements: [{
              id: "baseline",
              states: [],
              targetKinds: ["runtime"],
              metrics: ["knownMetric"]
            }]
          }],
          processRoles: [],
          metrics: [{ id: "knownMetric" }]
        });
      } catch (error) {
        rejectedThresholdValue = /must be a finite non-negative number/.test(error.message);
      }
      assertEqual(rejectedThresholdValue, true, `invalid threshold value ${String(value)} rejected`);
    }

    let rejectedScenarioRoleThreshold = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          proves: ["baseline"],
          thresholds: {
            roleThresholds: {
              gateway: { knownMetric: -1 }
            }
          },
          states: [],
          targetKinds: [],
          processRoles: ["gateway"]
        }],
        states: [],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: ["gateway"],
          thresholds: {},
          requirements: [{
            id: "baseline",
            states: [],
            targetKinds: ["runtime"],
            metrics: ["knownMetric"]
          }]
        }],
        processRoles: [{ id: "gateway" }],
        metrics: [{ id: "knownMetric" }]
      });
    } catch (error) {
      rejectedScenarioRoleThreshold = /roleThresholds\.gateway\.knownMetric must be a finite non-negative number/.test(error.message);
    }
    assertEqual(rejectedScenarioRoleThreshold, true, "invalid scenario role threshold rejected");

    let rejectedCalibration = false;
    try {
      validateRegistryReferences({
        scenarios: [],
        states: [],
        profiles: [{
          id: "profile",
          entries: [],
          calibration: {
            roles: {
              missingRole: { peakRssMb: 100 }
            },
            surfaces: {
              missingSurface: {
                thresholds: { peakRssMb: 100 }
              },
              knownSurface: {
                thresholds: { madeUpMetric: 1 },
                roleThresholds: {
                  knownRole: { peakRssMb: 100 }
                }
              }
            }
          }
        }],
        surfaces: [{
          id: "knownSurface",
          processRoles: [],
          requirements: [{
            id: "baseline",
            states: ["state"],
            targetKinds: ["runtime"],
            metrics: []
          }]
        }],
        processRoles: [{ id: "knownRole" }],
        metrics: [{ id: "peakRssMb" }]
      });
    } catch (error) {
      rejectedCalibration = /calibration\.roles references unknown process role/.test(error.message) &&
        /calibration\.surfaces references unknown surface/.test(error.message) &&
        /unknown metric 'madeUpMetric'/.test(error.message);
    }
    assertEqual(rejectedCalibration, true, "invalid profile calibration rejected");

    let rejectedPlatform = false;
    try {
      validateRegistryReferences({
        scenarios: [],
        states: [],
        profiles: [{
          id: "profile",
          entries: [],
          gate: {
            coverage: {
              platforms: {
                blocking: ["macos-arm"]
              }
            }
          }
        }],
        surfaces: [],
        processRoles: [],
        metrics: []
      });
    } catch (error) {
      rejectedPlatform = /unknown platform coverage key 'macos-arm'/.test(error.message);
    }
    assertEqual(rejectedPlatform, true, "unknown platform coverage key rejected");

    return {
      id: "state-registry-validation",
      status: "PASS",
      command: "evaluate synthetic invalid state contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "state-registry-validation",
      status: "FAIL",
      command: "evaluate synthetic invalid state contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

export function scenarioCloneFirstValidationCheck() {
  try {
    let rejectedMissingClone = false;
    try {
      validateScenarioShape({
        id: "bad-existing-user",
        surface: "upgrade-existing-user",
        title: "Bad Existing User",
        objective: "Touches source env without clone-first protection.",
        tags: ["upgrade"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "status",
          title: "Status",
          intent: "Unsafe durable source access.",
          healthScope: "post-ready",
          commands: ["ocm service status {sourceEnv} --json"],
          evidence: ["status"]
        }]
      }, "bad-existing-user.json");
    } catch (error) {
      rejectedMissingClone = /must start by cloning/.test(error.message);
    }
    assertEqual(rejectedMissingClone, true, "source env scenario without clone-first rejected");

    let rejectedSecondSourceUse = false;
    try {
      validateScenarioShape({
        id: "bad-existing-user-second-source",
        surface: "upgrade-existing-user",
        title: "Bad Existing User Second Source",
        objective: "References source env after clone.",
        tags: ["upgrade"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "clone",
          title: "Clone",
          intent: "Clone source.",
          healthScope: "none",
          commands: ["ocm env clone {sourceEnv} {env} --json", "ocm logs {sourceEnv} --tail 20"],
          evidence: ["clone"]
        }]
      }, "bad-existing-user-second-source.json");
    } catch (error) {
      rejectedSecondSourceUse = /may reference it only in the first clone command/.test(error.message);
    }
    assertEqual(rejectedSecondSourceUse, true, "second source env reference rejected");

    validateScenarioShape({
      id: "good-existing-user",
      surface: "upgrade-existing-user",
      title: "Good Existing User",
      objective: "Clone first, then operate only on the disposable env.",
      tags: ["upgrade"],
      proves: ["baseline"],
      thresholds: {},
      phases: [{
        id: "clone",
        title: "Clone",
        intent: "Clone source.",
        healthScope: "none",
        commands: ["ocm env clone {sourceEnv} {env} --json"],
        evidence: ["clone"]
      }, {
        id: "upgrade",
        title: "Upgrade",
        intent: "Upgrade disposable clone.",
        healthScope: "readiness",
        commands: ["ocm upgrade {env} --channel beta --json"],
        evidence: ["upgrade"]
      }]
    }, "good-existing-user.json");

    return {
      id: "scenario-clone-first-validation",
      status: "PASS",
      command: "validate source-env scenario contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-clone-first-validation",
      status: "FAIL",
      command: "validate source-env scenario contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function scenarioCleanupOwnershipCheck() {
  try {
    const freshInstall = await readSelfCheckJson("scenarios", "fresh-install.json");
    assertEqual(
      freshInstall.phases.some((phase) => phase.id === "cleanup"),
      false,
      "scenario registry does not duplicate lifecycle cleanup"
    );

    let rejected = false;
    try {
      validateScenarioShape({
        id: "scenario-owned-cleanup",
        surface: "runtime-startup",
        title: "Scenario Owned Cleanup",
        objective: "Attempts to duplicate Kova lifecycle cleanup.",
        tags: ["startup"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "cleanup",
          title: "Cleanup",
          intent: "Destroy the env from scenario data.",
          healthScope: "none",
          commands: ["ocm env destroy {env} --yes"],
          evidence: ["destroy"]
        }]
      }, "scenario-owned-cleanup.json");
    } catch (error) {
      rejected = /reserved for Kova lifecycle cleanup/.test(error.message);
    }
    assertEqual(rejected, true, "scenario-owned cleanup phase rejected");

    return {
      id: "scenario-cleanup-ownership",
      status: "PASS",
      command: "validate central lifecycle cleanup ownership",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-cleanup-ownership",
      status: "FAIL",
      command: "validate central lifecycle cleanup ownership",
      durationMs: 0,
      message: error.message
    };
  }
}

export function scenarioHealthScopeValidationCheck() {
  try {
    let rejectedMissing = false;
    try {
      validateScenarioShape({
        id: "missing-health-scope",
        surface: "fresh-install",
        title: "Missing Health Scope",
        objective: "Scenario phase without an explicit health scope.",
        tags: ["fresh-user"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "start",
          title: "Start",
          intent: "Start gateway.",
          commands: ["ocm start {env} {startSelector} --json"],
          evidence: ["start"]
        }]
      }, "missing-health-scope.json");
    } catch (error) {
      rejectedMissing = /phases\[0\]\.healthScope must be a non-empty string/.test(error.message);
    }
    assertEqual(rejectedMissing, true, "missing healthScope rejected");

    let rejectedInvalid = false;
    try {
      validateScenarioShape({
        id: "invalid-health-scope",
        surface: "fresh-install",
        title: "Invalid Health Scope",
        objective: "Scenario phase with an invalid health scope.",
        tags: ["fresh-user"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "start",
          title: "Start",
          intent: "Start gateway.",
          healthScope: "startup",
          commands: ["ocm start {env} {startSelector} --json"],
          evidence: ["start"]
        }]
      }, "invalid-health-scope.json");
    } catch (error) {
      rejectedInvalid = /healthScope must be one of/.test(error.message);
    }
    assertEqual(rejectedInvalid, true, "invalid healthScope rejected");

    let rejectedMeasurementScope = false;
    try {
      validateScenarioShape({
        id: "invalid-measurement-scope",
        surface: "fresh-install",
        title: "Invalid Measurement Scope",
        objective: "Scenario phase with an invalid measurement scope.",
        tags: ["fresh-user"],
        proves: ["baseline"],
        thresholds: {},
        phases: [{
          id: "start",
          title: "Start",
          intent: "Start gateway.",
          healthScope: "readiness",
          measurementScope: "setup",
          commands: ["ocm start {env} {startSelector} --json"],
          evidence: ["start"]
        }]
      }, "invalid-measurement-scope.json");
    } catch (error) {
      rejectedMeasurementScope = /measurementScope must be one of/.test(error.message);
    }
    assertEqual(rejectedMeasurementScope, true, "invalid measurementScope rejected");

    return {
      id: "scenario-health-scope-validation",
      status: "PASS",
      command: "validate scenario health scope contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-health-scope-validation",
      status: "FAIL",
      command: "validate scenario health scope contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

export function scenarioStateCompatibilityCheck() {
  try {
    let rejected = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "upgrade-existing-user",
          surface: "upgrade-existing-user",
          proves: ["baseline"],
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "fresh",
          traits: ["fresh-user"],
          incompatibleSurfaces: ["upgrade-existing-user"]
        }],
        profiles: [{
          id: "bad-profile",
          entries: [{ scenario: "upgrade-existing-user", state: "fresh" }]
        }],
        surfaces: [{
          id: "upgrade-existing-user",
          processRoles: [],
          requirements: [{
            id: "baseline",
            states: ["old-release-user"],
            targetKinds: ["runtime"],
            metrics: []
          }]
        }],
        processRoles: []
      });
    } catch (error) {
      rejected = /pairs scenario 'upgrade-existing-user' with state 'fresh'/.test(error.message) ||
        /explicitly incompatible surface/.test(error.message);
    }
    assertEqual(rejected, true, "invalid scenario/state profile pairing rejected");
    return {
      id: "scenario-state-compatibility",
      status: "PASS",
      command: "evaluate synthetic invalid scenario/state pairing",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-state-compatibility",
      status: "FAIL",
      command: "evaluate synthetic invalid scenario/state pairing",
      durationMs: 0,
      message: error.message
    };
  }
}
