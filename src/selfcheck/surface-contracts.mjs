import { readdir } from "node:fs/promises";
import { resolveThresholdPolicy } from "../evaluation/thresholds.mjs";
import { readinessThresholdForPhase } from "../measurement-contract.mjs";
import { assertEqual, readSelfCheckJson, selfCheckPath } from "./harness.mjs";

export async function bundledPluginStartupSurfaceContractCheck() {
  try {
    const scenario = await readSelfCheckJson("scenarios", "bundled-plugin-startup.json");
    const surface = await readSelfCheckJson("surfaces", "bundled-plugin-startup.json");
    const releaseProfile = await readSelfCheckJson("profiles", "release.json");
    const startPhase = scenario.phases.find((phase) =>
      (phase.commands ?? []).some((command) => /^ocm service start /.test(command))
    );
    const policy = resolveThresholdPolicy({
      profile: releaseProfile,
      surface,
      scenario,
      nodeVersion: "v24.19.0"
    });
    const node22Policy = resolveThresholdPolicy({ profile: releaseProfile, surface, scenario, nodeVersion: "22.22.3" });
    const uncalibratedPolicy = resolveThresholdPolicy({ profile: releaseProfile, surface, scenario, nodeVersion: "v26.0.0" });

    assertEqual(startPhase?.id, "gateway-start", "bundled plugin startup uses readiness phase contract");
    assertEqual(
      readinessThresholdForPhase(scenario, startPhase),
      30000,
      "bundled plugin startup waits for gateway readiness"
    );
    assertEqual(surface.roleThresholds?.gateway?.peakRssMb?.absoluteCeilingMb, 1200, "bundled plugin surface owns absolute gateway RSS ceiling");
    assertEqual(surface.roleThresholds?.gateway?.maxCpuPercent, 250, "bundled plugin surface owns gateway CPU cap");
    assertEqual(surface.roleThresholds?.["plugin-cli"]?.peakRssMb, 900, "bundled plugin surface owns plugin CLI RSS cap");
    assertEqual(surface.roleThresholds?.["plugin-cli"]?.maxCpuPercent, 250, "bundled plugin surface owns plugin CLI CPU cap");
    assertEqual(policy.roleThresholds?.gateway?.peakRssMb, 1193, "bundled plugin resolves Node 24 baseline with bounded regression allowance");
    assertEqual(policy.report.runtimeCalibration?.[0]?.baselineMb, 1085, "bundled plugin reports selected Node 24 baseline");
    assertEqual(node22Policy.roleThresholds?.gateway?.peakRssMb, 803, "bundled plugin selects the parsed Node 22 major baseline");
    assertEqual(uncalibratedPolicy.roleThresholds?.gateway?.peakRssMb, 1200, "uncalibrated Node major remains bounded by the absolute ceiling");
    assertEqual(uncalibratedPolicy.report.runtimeCalibration?.[0]?.baselineMb, null, "uncalibrated Node major reports missing baseline evidence");
    assertEqual(policy.roleThresholds?.gateway?.maxCpuPercent, 250, "bundled plugin resolved gateway CPU cap");
    assertEqual(policy.roleThresholds?.["plugin-cli"]?.peakRssMb, 900, "bundled plugin resolved plugin CLI RSS cap");
    assertEqual(policy.roleThresholds?.["plugin-cli"]?.maxCpuPercent, 250, "bundled plugin resolved plugin CLI CPU cap");
    assertEqual(surface.diagnostics?.expectedSpans?.includes("plugins.load"), true, "bundled plugin startup requires plugin load span");
    assertEqual(surface.diagnostics?.expectedSpans?.includes("runtimeDeps.stage"), false, "bundled plugin startup excludes retired runtime deps span");
    assertEqual(surface.thresholds?.runtimeDepsStagingMs, undefined, "bundled plugin startup excludes retired staging threshold");
    assertEqual(scenario.thresholds?.runtimeDepsStagingMs, undefined, "bundled plugin scenario excludes retired staging threshold");

    return {
      id: "bundled-plugin-startup-surface-contract",
      status: "PASS",
      command: "validate bundled plugin startup readiness and resource caps",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "bundled-plugin-startup-surface-contract",
      status: "FAIL",
      command: "validate bundled plugin startup readiness and resource caps",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function startupSurfaceDiagnosticsContractCheck() {
  try {
    const startupSpans = ["gateway.ready", "config.normalize", "plugins.metadata.scan"];
    const surfaceSpans = {
      "fresh-install": startupSpans,
      "gateway-performance": startupSpans,
      "bundled-plugin-startup": [...startupSpans, "plugins.load"]
    };
    for (const [surfaceId, expectedSpans] of Object.entries(surfaceSpans)) {
      const surface = await readSelfCheckJson("surfaces", `${surfaceId}.json`);
      const actualSpans = surface.diagnostics?.expectedSpans ?? [];
      assertEqual(actualSpans.length, expectedSpans.length, `${surfaceId} diagnostic span count`);
      for (const span of expectedSpans) {
        assertEqual(actualSpans.includes(span), true, `${surfaceId} requires observed ${span} span`);
      }
    }
    return {
      id: "startup-surface-diagnostics-contract",
      status: "PASS",
      command: "validate startup surfaces against current OpenClaw timeline spans",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "startup-surface-diagnostics-contract",
      status: "FAIL",
      command: "validate startup surfaces against current OpenClaw timeline spans",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function legacyRuntimeDepsIsolationCheck() {
  try {
    const [legacyScenario, legacySurface, missingDepsSurface] = await Promise.all([
      readSelfCheckJson("scenarios", "bundled-runtime-deps.json"),
      readSelfCheckJson("surfaces", "bundled-runtime-deps.json"),
      readSelfCheckJson("surfaces", "plugin-missing-runtime-deps.json")
    ]);
    const profileNames = (await readdir(selfCheckPath("profiles")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const scheduledProfiles = [];
    for (const profileName of profileNames) {
      const profile = await readSelfCheckJson("profiles", profileName);
      const referencesLegacyScenario =
        (profile.entries ?? []).some((entry) => entry.scenario === "bundled-runtime-deps") ||
        ["blocking", "warning"].some((level) =>
          (profile.gate?.[level] ?? []).some((entry) => entry.scenario === "bundled-runtime-deps")
        ) ||
        ["blocking", "warning"].some((level) =>
          (profile.gate?.coverage?.requirements?.[level] ?? [])
            .some((requirement) => requirement.startsWith("bundled-runtime-deps:"))
        ) ||
        profile.calibration?.surfaces?.["bundled-runtime-deps"] !== undefined;
      if (referencesLegacyScenario) {
        scheduledProfiles.push(profile.id);
      }
    }

    assertEqual(scheduledProfiles.length, 0, "legacy runtime deps scenario is absent from current profiles");
    assertEqual(legacyScenario.tags?.includes("legacy"), true, "legacy runtime deps scenario is labeled legacy");
    assertEqual(legacySurface.description?.startsWith("Legacy-only"), true, "legacy runtime deps surface is documented as legacy-only");
    assertEqual(legacySurface.diagnostics?.expectedSpans?.includes("runtimeDeps.stage"), true, "legacy runtime deps surface retains historical span parsing");
    assertEqual(missingDepsSurface.diagnostics?.expectedSpans?.length, 1, "missing dependency surface has one current diagnostic span");
    assertEqual(missingDepsSurface.diagnostics?.expectedSpans?.[0], "plugins.load", "missing dependency surface requires plugin load span");
    assertEqual(missingDepsSurface.processRoles?.includes("runtime-staging"), false, "missing dependency surface excludes retired staging role");

    return {
      id: "legacy-runtime-deps-isolation",
      status: "PASS",
      command: "validate legacy runtime dependency scenario isolation",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "legacy-runtime-deps-isolation",
      status: "FAIL",
      command: "validate legacy runtime dependency scenario isolation",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function currentProfileDiagnosticsContractCheck() {
  try {
    const retiredSpans = new Set(["runtimeDeps.stage", "plugins.runtimeDeps"]);
    const activeScenarioIds = new Set();
    const profileNames = (await readdir(selfCheckPath("profiles")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const profileName of profileNames) {
      const profile = await readSelfCheckJson("profiles", profileName);
      for (const entry of profile.entries ?? []) {
        activeScenarioIds.add(entry.scenario);
      }
      for (const level of ["blocking", "warning"]) {
        for (const entry of profile.gate?.[level] ?? []) {
          activeScenarioIds.add(entry.scenario);
        }
      }
    }

    const scenarioNames = (await readdir(selfCheckPath("scenarios")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const scenarioSurfaces = new Map();
    for (const scenarioName of scenarioNames) {
      const scenario = await readSelfCheckJson("scenarios", scenarioName);
      scenarioSurfaces.set(scenario.id, scenario.surface);
    }

    const activeSurfaceIds = new Set(
      [...activeScenarioIds]
        .map((scenarioId) => scenarioSurfaces.get(scenarioId))
        .filter(Boolean)
    );
    const staleRequirements = [];
    for (const surfaceId of [...activeSurfaceIds].sort()) {
      const surface = await readSelfCheckJson("surfaces", `${surfaceId}.json`);
      for (const span of surface.diagnostics?.expectedSpans ?? []) {
        if (retiredSpans.has(span)) {
          staleRequirements.push(`${surfaceId}:${span}`);
        }
      }
    }

    assertEqual(staleRequirements.join(","), "", "current profile surfaces exclude retired production spans");
    for (const surfaceId of [
      "browser-automation",
      "release-update-recovery",
      "upgrade-existing-user"
    ]) {
      const surface = await readSelfCheckJson("surfaces", `${surfaceId}.json`);
      assertEqual(
        surface.diagnostics?.expectedSpans?.includes("plugins.load"),
        true,
        `${surfaceId} requires current plugin load span`
      );
    }

    return {
      id: "current-profile-diagnostics-contract",
      status: "PASS",
      command: "validate current profile surfaces against production diagnostics spans",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "current-profile-diagnostics-contract",
      status: "FAIL",
      command: "validate current profile surfaces against production diagnostics spans",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function releaseResourceCalibrationCheck() {
  try {
    const [
      freshScenario,
      gatewayScenario,
      freshSurface,
      gatewaySurface,
      bundledPluginSurface,
      releaseProfile,
      smokeProfile
    ] = await Promise.all([
      readSelfCheckJson("scenarios", "fresh-install.json"),
      readSelfCheckJson("scenarios", "gateway-performance.json"),
      readSelfCheckJson("surfaces", "fresh-install.json"),
      readSelfCheckJson("surfaces", "gateway-performance.json"),
      readSelfCheckJson("surfaces", "bundled-plugin-startup.json"),
      readSelfCheckJson("profiles", "release.json"),
      readSelfCheckJson("profiles", "smoke.json")
    ]);

    for (const profile of [null, smokeProfile]) {
      const policy = resolveThresholdPolicy({
        profile,
        surface: freshSurface,
        scenario: freshScenario,
        nodeVersion: "v24.19.0"
      });
      assertEqual(policy.roleThresholds?.gateway?.maxCpuPercent, 250, "non-release fresh install gateway CPU cap");
    }

    const contracts = [
      {
        id: "fresh-install",
        scenario: freshScenario,
        surface: freshSurface,
        primaryRssMb: 1177,
        gatewayCpuPercent: 300,
        roles: { gateway: 1177, "status-cli": 900, "plugin-cli": 900 }
      },
      {
        id: "gateway-performance",
        scenario: gatewayScenario,
        surface: gatewaySurface,
        primaryRssMb: 1177,
        roles: { gateway: 1177, "gateway-tree": 1200, "status-cli": 900, "plugin-cli": 950 }
      },
      {
        id: "bundled-plugin-startup",
        scenario: null,
        surface: bundledPluginSurface,
        primaryRssMb: null,
        roles: { gateway: 1193, "plugin-cli": 900 }
      }
    ];

    for (const contract of contracts) {
      const policy = resolveThresholdPolicy({
        profile: releaseProfile,
        surface: contract.surface,
        scenario: contract.scenario,
        nodeVersion: "v24.19.0"
      });
      if (contract.primaryRssMb !== null) {
        assertEqual(policy.thresholds?.peakRssMb, contract.primaryRssMb, `${contract.id} resolved primary RSS cap`);
        assertEqual(contract.surface?.thresholds?.peakRssMb?.absoluteCeilingMb, 1200, `${contract.id} absolute primary RSS ceiling`);
      }
      if (contract.gatewayCpuPercent !== undefined) {
        assertEqual(policy.roleThresholds?.gateway?.maxCpuPercent, contract.gatewayCpuPercent, `${contract.id} release-profile gateway CPU cap`);
      }
      for (const [role, peakRssMb] of Object.entries(contract.roles)) {
        assertEqual(contract.surface?.processRoles?.includes(role), true, `${contract.id} declares ${role}`);
        assertEqual(policy.roleThresholds?.[role]?.peakRssMb, peakRssMb, `${contract.id} ${role} RSS cap`);
      }
    }

    return {
      id: "release-resource-calibration",
      status: "PASS",
      command: "validate release resource calibration scope",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "release-resource-calibration",
      status: "FAIL",
      command: "validate release resource calibration scope",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function gatewaySessionSurfaceContractCheck() {
  try {
    const surface = await readSelfCheckJson("surfaces", "gateway-session-send-turn.json");
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = ["agent.turn", "agent.prepare", "models.catalog", "provider.request", "agent.cleanup", "gateway.chat_send", "auto_reply", "reply"];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `gateway session surface must not require stale ${span} span`);
    }
    assertEqual(expectedSpans.includes("gateway.ready"), true, "gateway session surface requires readiness spans observed by release runtimes");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "gateway session surface requires metadata scan spans used for active-turn attribution");
    return {
      id: "gateway-session-surface-contract",
      status: "PASS",
      command: "validate gateway session surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-surface-contract",
      status: "FAIL",
      command: "validate gateway session surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function releaseRuntimeStartupSurfaceContractCheck() {
  try {
    const scenario = await readSelfCheckJson("scenarios", "release-runtime-startup.json");
    const surface = await readSelfCheckJson("surfaces", "release-runtime-startup.json");
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = ["gateway.startup", "plugins.runtimeDeps", "health.ready"];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `release startup surface must not require stale ${span} span`);
    }
    assertEqual(scenario.auth?.mode, "skip", "release startup scenario skips provider auth setup");
    assertEqual(surface.resourcePrimaryRole, "gateway", "release startup resource gate is gateway-scoped");
    assertEqual(expectedSpans.includes("gateway.ready"), true, "release startup surface requires gateway.ready timeline span");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "release startup surface requires plugin metadata scan timeline span");
    assertEqual(expectedSpans.includes("plugins.load"), true, "release startup surface requires plugin load timeline span");
    return {
      id: "release-runtime-startup-surface-contract",
      status: "PASS",
      command: "validate release runtime startup surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "release-runtime-startup-surface-contract",
      status: "FAIL",
      command: "validate release runtime startup surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function officialPluginInstallSurfaceContractCheck() {
  try {
    const surface = await readSelfCheckJson("surfaces", "official-plugin-install.json");
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = ["plugins.install", "plugins.registry.refresh", "plugins.security.scan"];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `official plugin surface must not require stale ${span} span`);
    }
    assertEqual(surface.roleThresholds?.["plugin-cli"]?.peakRssMb >= 900, true, "official plugin cli RSS budget covers real release install path");
    assertEqual(expectedSpans.includes("gateway.ready"), true, "official plugin surface requires gateway.ready timeline span");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "official plugin surface requires plugin metadata scan timeline span");
    return {
      id: "official-plugin-install-surface-contract",
      status: "PASS",
      command: "validate official plugin install surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "official-plugin-install-surface-contract",
      status: "FAIL",
      command: "validate official plugin install surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function agentCliLocalTurnSurfaceContractCheck() {
  try {
    const surface = await readSelfCheckJson("surfaces", "agent-cli-local-turn.json");
    const networkOfflineSurface = await readSelfCheckJson("surfaces", "network-offline.json");
    const releaseProfile = await readSelfCheckJson("profiles", "release.json");
    const scenario = await readSelfCheckJson("scenarios", "agent-cold-warm-message.json");
    const policy = resolveThresholdPolicy({
      profile: releaseProfile,
      surface,
      scenario
    });
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = [
      "agent.turn",
      "agent.prepare",
      "agent.runtimeCapabilities",
      "channel.capabilities",
      "channel.plugin.load",
      "models.catalog",
      "provider.request",
      "agent.cleanup"
    ];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `agent CLI surface must not require stale ${span} span`);
    }
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "agent CLI surface requires plugin metadata scan timeline span");
    assertEqual(surface.resourcePrimaryRole, "agent-process", "local agent surface headlines the agent process");
    assertEqual(networkOfflineSurface.resourcePrimaryRole, "agent-process", "offline agent surface headlines the agent process");
    assertEqual(surface.thresholds?.peakRssMb, 1000, "agent CLI surface owns primary RSS cap");
    assertEqual(surface.roleThresholds?.["agent-cli"]?.peakRssMb, 1000, "agent CLI surface owns agent CLI RSS cap");
    assertEqual(surface.roleThresholds?.["agent-process"]?.peakRssMb, 1000, "agent CLI surface owns agent process RSS cap");
    assertEqual(scenario.thresholds?.peakRssMb, 1000, "agent cold/warm scenario owns primary RSS cap");
    assertEqual(policy.thresholds?.peakRssMb, 1000, "agent cold/warm resolved primary RSS cap");
    assertEqual(policy.roleThresholds?.["agent-cli"]?.peakRssMb, 1000, "agent CLI resolved agent CLI RSS cap");
    assertEqual(policy.roleThresholds?.["agent-process"]?.peakRssMb, 1000, "agent CLI resolved agent process RSS cap");
    const configPreflight = scenario.phases?.find((phase) => phase.id === "config-preflight");
    assertEqual(configPreflight?.commands?.[0], "ocm @{env} -- config validate --json", "agent CLI config preflight command");
    assertEqual(configPreflight?.measurementScope, "harness", "agent CLI config preflight stays outside product measurements");
    assertEqual(configPreflight?.collectionIntent, "skip-env", "agent CLI config preflight avoids extra environment collection");
    return {
      id: "agent-cli-local-turn-surface-contract",
      status: "PASS",
      command: "validate agent CLI local turn surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cli-local-turn-surface-contract",
      status: "FAIL",
      command: "validate agent CLI local turn surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function agentGatewayRpcTurnSurfaceContractCheck() {
  try {
    const surface = await readSelfCheckJson("surfaces", "agent-gateway-rpc-turn.json");
    const expectedSpans = surface.diagnostics?.expectedSpans ?? [];
    const staleSpans = [
      "agent.turn",
      "agent.prepare",
      "models.catalog",
      "provider.request",
      "agent.cleanup"
    ];
    for (const span of staleSpans) {
      assertEqual(expectedSpans.includes(span), false, `agent Gateway RPC surface must not require stale ${span} span`);
    }
    assertEqual(surface.resourcePrimaryRole, "agent-cli", "Gateway RPC surface headlines the client process");
    assertEqual(expectedSpans.includes("gateway.ready"), true, "agent Gateway RPC surface requires gateway.ready timeline span");
    assertEqual(expectedSpans.includes("plugins.metadata.scan"), true, "agent Gateway RPC surface requires plugin metadata scan timeline span");
    return {
      id: "agent-gateway-rpc-turn-surface-contract",
      status: "PASS",
      command: "validate agent Gateway RPC surface diagnostics contract",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-gateway-rpc-turn-surface-contract",
      status: "FAIL",
      command: "validate agent Gateway RPC surface diagnostics contract",
      durationMs: 0,
      message: error.message
    };
  }
}
