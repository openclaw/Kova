import { buildAgentTurnBreakdown } from "../collectors/agent-turns.mjs";
import { computeProviderTurnAttribution } from "../collectors/provider.mjs";
import { RESOURCE_HEADLINE_CONTRACT, RESOURCE_MEASUREMENT_SCOPE } from "../performance/stats.mjs";

export function resourceSampleLine(elapsedMs, gatewayRssMb, commandRssMb, cpuPercent) {
  return JSON.stringify({
    timestamp: new Date(1700000000000 + elapsedMs).toISOString(),
    elapsedMs,
    processes: [{
      pid: 101,
      ppid: 1,
      rssMb: gatewayRssMb,
      cpuPercent,
      roles: ["gateway", "gateway-tree"],
      role: "gateway,gateway-tree",
      command: "openclaw gateway"
    }, {
      pid: 202,
      ppid: 1,
      rssMb: commandRssMb,
      cpuPercent: 1,
      roles: ["command-tree"],
      role: "command-tree",
      command: "node support/channel-conformance/run.mjs"
    }]
  });
}

export function syntheticUpgradeLogRecord({ results }) {
  return {
    scenario: "upgrade-existing-user",
    surface: "upgrade-existing-user",
    status: "PASS",
    phases: [{
      id: "post-upgrade",
      commands: results.map((result) => result.command),
      results
    }],
    finalMetrics: {
      service: { gatewayState: "running" }
    }
  };
}

export function upgradeSnapshotRecord({ pre, post }) {
  return {
    status: "PASS",
    phases: [{
      id: "evidence-source-runtime-snapshots",
      results: [{
        evidenceId: "snapshot:pre-upgrade-state",
        evidenceArtifactPath: "/tmp/pre.json",
        snapshot: pre
      }]
    }, {
      id: "evidence-post-upgrade-snapshots",
      results: [{
        evidenceId: "snapshot:post-upgrade-state",
        evidenceArtifactPath: "/tmp/post.json",
        snapshot: post
      }]
    }]
  };
}

export function syntheticResourceSamples({
  peakRssMb,
  maxCpuPercent,
  role,
  processRoles = null
}) {
  const peakProcess = processRoles
    ? {
        pid: 101,
        roles: processRoles,
        role: processRoles.join(","),
        rssMb: peakRssMb,
        cpuPercent: maxCpuPercent,
        command: role
      }
    : null;
  return {
    sampleCount: 1,
    peakTotalRssMb: peakRssMb,
    maxTotalCpuPercent: maxCpuPercent,
    peakCommandTreeRssMb: peakRssMb,
    peakGatewayRssMb: role === "gateway" ? peakRssMb : 0,
    byRole: {
      [role]: {
        peakRssMb,
        maxCpuPercent,
        peakProcessCount: 1,
        peakRssProcess: peakProcess,
        peakCpuProcess: peakProcess
      }
    },
    topRolesByRss: [{ role, peakRssMb, maxCpuPercent }],
    topRolesByCpu: [{ role, peakRssMb, maxCpuPercent }],
    topByRss: [],
    topByCpu: []
  };
}

export function syntheticPerformanceReport({ runId, platform, target, records }) {
  return {
    schemaVersion: "kova.report.v1",
    generatedAt: "2026-04-29T00:00:00.000Z",
    runId,
    mode: "execution",
    target,
    platform,
    records
  };
}

export function syntheticPublicationReport() {
  return {
    schemaVersion: "kova.report.v1",
    generatedAt: "2026-07-12T00:00:00.000Z",
    runId: "kova-260712-000000-aabbcc",
    mode: "execution",
    target: "runtime:stable",
    platform: {
      os: process.platform,
      release: "self-check",
      arch: process.arch,
      node: process.version
    },
    records: [{
      scenario: "fresh-install",
      surface: "fresh-install",
      title: "Fresh Install",
      status: "PASS",
      target: "runtime:stable",
      state: { id: "fresh", title: "Fresh" },
      repeat: { index: 1, total: 1 },
      measurements: {},
      phases: []
    }]
  };
}

export function syntheticPerformanceRecord(index, measurements) {
  return {
    scenario: "fresh-install",
    surface: "fresh-install",
    title: "Fresh Install",
    status: "PASS",
    target: "local-build:/tmp/openclaw",
    state: { id: "fresh", title: "Fresh" },
    repeat: { index, total: 3 },
    envName: `kova-fresh-install-r${index}`,
    measurements: {
      resourceMeasurementScope: RESOURCE_MEASUREMENT_SCOPE,
      resourceHeadlineContract: RESOURCE_HEADLINE_CONTRACT,
      ...measurements
    },
    phases: []
  };
}

export function syntheticHealthMeasurement({ listeningReadyAtMs = null, healthReadyAtMs = null } = {}) {
  return {
    schemaVersion: "kova.health.v1",
    readiness: {
      phaseId: "start",
      listeningReadyAtMs,
      healthReadyAtMs,
      classification: "ready",
      severity: "pass",
      reason: "synthetic readiness",
      thresholdMs: 30000,
      deadlineMs: 90000,
      attempts: 1
    },
    startupSamples: emptySyntheticHealthSummary("startup-sample"),
    postReadySamples: emptySyntheticHealthSummary("post-ready"),
    unknownSamples: emptySyntheticHealthSummary("unknown"),
    final: {
      ...emptySyntheticHealthSummary("final"),
      gatewayState: "running",
      ok: true,
      healthOk: true
    },
    slowestSample: null
  };
}

function emptySyntheticHealthSummary(scope) {
  return {
    scope,
    count: 0,
    okCount: 0,
    failureCount: 0,
    minMs: null,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    slowestPhaseId: null
  };
}

export function syntheticCpuProfile(uniqueFunctionName) {
  return {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "shared",
          url: "file:///shared.js",
          lineNumber: 1,
          columnNumber: 1
        }
      },
      {
        id: 2,
        callFrame: {
          functionName: uniqueFunctionName,
          url: `file:///${uniqueFunctionName}.js`,
          lineNumber: 1,
          columnNumber: 1
        }
      }
    ],
    samples: [1, 2],
    timeDeltas: [4000, 6000]
  };
}

export function syntheticHeapProfile(uniqueFunctionName) {
  return {
    head: {
      callFrame: {
        functionName: "(root)",
        url: "",
        lineNumber: 0,
        columnNumber: 0
      },
      selfSize: 0,
      children: [
        {
          callFrame: {
            functionName: "shared",
            url: "file:///shared.js",
            lineNumber: 1,
            columnNumber: 1
          },
          selfSize: 60,
          children: []
        },
        {
          callFrame: {
            functionName: uniqueFunctionName,
            url: `file:///${uniqueFunctionName}.js`,
            lineNumber: 1,
            columnNumber: 1
          },
          selfSize: 100,
          children: []
        }
      ]
    }
  };
}

export function fakeOcmScript() {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  service:install) echo '{"installed":true}'; exit 0 ;;
  service:start) echo '{"started":true}'; exit 0 ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:exec)
    env_name="$3"
    shift 4
    OPENCLAW_HOME="$KOVA_FAKE_OPENCLAW_HOME" "$@"
    exit $?
    ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*)
    env_name="$1"
    shift
    if [ "$1" = "--" ]; then shift; fi
    if [ "$1" = "onboard" ]; then
      mkdir -p "$KOVA_FAKE_OPENCLAW_HOME/.openclaw"
      case " $* " in
        *" --auth-choice openai-api-key "*)
          cat > "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" <<'JSON'
{"models":{"mode":"merge","providers":{"openai":{"apiKey":{"source":"env","provider":"default","id":"OPENAI_API_KEY"},"models":[{"id":"gpt-5.5","name":"gpt-5.5","api":"openai-responses"}]}}},"agents":{"defaults":{"model":{"primary":"openai/gpt-5.5"}}}}
JSON
          ;;
        *" --auth-choice apiKey "*)
          cat > "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" <<'JSON'
{"models":{"mode":"merge","providers":{"anthropic":{"apiKey":{"source":"env","provider":"default","id":"ANTHROPIC_API_KEY"},"models":[{"id":"claude-sonnet-4-5","name":"claude-sonnet-4-5"}]}}},"agents":{"defaults":{"model":{"primary":"anthropic/claude-sonnet-4-5"}}}}
JSON
          ;;
        *" --auth-choice anthropic-cli "*)
          cat > "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" <<'JSON'
{"agents":{"defaults":{"model":{"primary":"claude-cli/claude-sonnet-4-5"},"agentRuntime":{"id":"claude-cli","fallback":"none"}}}}
JSON
          ;;
      esac
      echo '{"ok":true}'
      exit 0
    fi
    if [ "$1" = "models" ] && [ "$2" = "set" ]; then
      node - "$KOVA_FAKE_OPENCLAW_HOME/.openclaw/openclaw.json" "$3" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const model = process.argv[3];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = {
  ...(config.agents.defaults.model || {}),
  primary: model
};
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
NODE
      echo "Default model: $3"
      exit 0
    fi
    echo "live command key=$OPENAI_API_KEY"
    exit 0
    ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`;
}

export function syntheticAgentCliLocalTurnRecord({
  coldCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json",
  warmCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json"
} = {}) {
  return {
    scenario: "agent-cold-warm-message",
    surface: "agent-cli-local-turn",
    status: "PASS",
    auth: { mode: "mock", source: "mock", providerId: "openai" },
    phases: [
      {
        id: "provision",
        commands: ["ocm start kova --runtime stable --no-service --json"],
        results: [{
          command: "ocm start kova --runtime stable --no-service --json",
          status: 0,
          durationMs: 100,
          stdout: "{\"gatewayPort\":43111,\"serviceRequested\":false}"
        }],
        metrics: { service: { gatewayState: "disabled", gatewayPort: 43111 } }
      },
      {
        id: "cold-agent-turn",
        commands: [coldCommand],
        results: [{
          command: coldCommand,
          status: 0,
          timedOut: false,
          startedAt: "2026-05-15T10:00:01.000Z",
          startedAtEpochMs: 1778839201000,
          finishedAt: "2026-05-15T10:00:03.000Z",
          finishedAtEpochMs: 1778839203000,
          durationMs: 2000,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: "",
          resourceSamples: syntheticAgentCliResourceSamples("/tmp/kova/resources/cold-agent-turn-1.jsonl")
        }],
        metrics: {
          logs: zeroLogMetrics(),
          timeline: syntheticTimelineMetrics()
        }
      },
      {
        id: "warm-agent-turn",
        commands: [warmCommand],
        results: [{
          command: warmCommand,
          status: 0,
          timedOut: false,
          startedAt: "2026-05-15T10:00:10.000Z",
          startedAtEpochMs: 1778839210000,
          finishedAt: "2026-05-15T10:00:11.500Z",
          finishedAtEpochMs: 1778839211500,
          durationMs: 1500,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: "",
          resourceSamples: syntheticAgentCliResourceSamples("/tmp/kova/resources/warm-agent-turn-1.jsonl")
        }],
        metrics: {
          logs: zeroLogMetrics(),
          timeline: syntheticTimelineMetrics()
        }
      },
      {
        id: "post-agent-health",
        commands: ["ocm @kova -- status"],
        results: [{
          command: "ocm @kova -- status",
          status: 0,
          durationMs: 100,
          stdout: "OpenClaw env ok\n",
          resourceSamples: syntheticAgentCliResourceSamples("/tmp/kova/resources/post-agent-health-1.jsonl")
        }],
        metrics: {
          logs: {
            ...zeroLogMetrics(),
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          },
          timeline: syntheticTimelineMetrics()
        }
      }
    ],
    providerEvidence: {
      available: true,
      requestCount: 2,
      summaryPath: "/tmp/kova/provider/provider-evidence.json",
      artifacts: ["/tmp/kova/mock-openai/requests.jsonl", "/tmp/kova/provider/provider-evidence.json"],
      requests: [
        {
          requestId: "cold-provider",
          receivedAt: "2026-05-15T10:00:02.000Z",
          receivedAtEpochMs: 1778839202000,
          respondedAt: "2026-05-15T10:00:02.050Z",
          respondedAtEpochMs: 1778839202050,
          firstByteLatencyMs: 5,
          firstChunkLatencyMs: 5,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          statusClass: "2xx"
        },
        {
          requestId: "warm-provider",
          receivedAt: "2026-05-15T10:00:10.700Z",
          receivedAtEpochMs: 1778839210700,
          respondedAt: "2026-05-15T10:00:10.750Z",
          respondedAtEpochMs: 1778839210750,
          firstByteLatencyMs: 4,
          firstChunkLatencyMs: 4,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200,
          statusClass: "2xx"
        }
      ]
    },
    finalMetrics: {
      service: { gatewayState: "disabled", gatewayPort: 43111 },
      health: null,
      healthSummary: null,
      logs: zeroLogMetrics(),
      timeline: syntheticTimelineMetrics()
    }
  };
}

function syntheticAgentCliResourceSamples(artifactPath) {
  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: 1,
    artifactPath,
    peakTotalRssMb: 650,
    maxTotalCpuPercent: 80,
    peakCommandTreeRssMb: 650,
    peakGatewayRssMb: 0,
    byRole: {
      "agent-cli": {
        peakRssMb: 650,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "agent-process": {
        peakRssMb: 650,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "command-tree": {
        peakRssMb: 650,
        maxCpuPercent: 80,
        peakProcessCount: 1
      }
    },
    topRolesByRss: [{ role: "agent-cli", peakRssMb: 650, maxCpuPercent: 80 }],
    topRolesByCpu: [{ role: "agent-cli", peakRssMb: 650, maxCpuPercent: 80 }],
    topByRss: [],
    topByCpu: []
  };
}

export function syntheticAgentGatewayRpcTurnRecord({
  turnCommand = "ocm @kova -- agent --agent main --session-id kova-agent-gateway-rpc --message hi --json"
} = {}) {
  return {
    scenario: "agent-gateway-rpc-turn",
    surface: "agent-gateway-rpc-turn",
    status: "PASS",
    auth: { mode: "mock", source: "mock", providerId: "openai" },
    phases: [
      {
        id: "provision",
        commands: ["ocm start kova --runtime stable --no-service --json"],
        results: [{
          command: "ocm start kova --runtime stable --no-service --json",
          status: 0,
          durationMs: 100,
          stdout: "{\"gatewayPort\":43111,\"serviceRequested\":false}"
        }],
        metrics: {
          service: { gatewayState: "disabled", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" }
        }
      },
      {
        id: "gateway-start",
        commands: [
          "ocm service install kova --json",
          "ocm service start kova --json"
        ],
        results: [
          {
            command: "ocm service install kova --json",
            status: 0,
            durationMs: 100,
            stdout: "{\"ok\":true}",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/gateway-start-1.jsonl")
          },
          {
            command: "ocm service start kova --json",
            status: 0,
            durationMs: 100,
            stdout: "{\"ok\":true}",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/gateway-start-2.jsonl")
          }
        ],
        metrics: {
          readiness: syntheticReadyReadiness(),
          healthSummary: syntheticHealthSummary(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
          logs: zeroLogMetrics(),
          timeline: {
            ...syntheticTimelineMetrics(),
            keySpans: {
              "gateway.ready": { count: 1, totalDurationMs: 120, maxDurationMs: 120 },
              "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
            },
            spanTotals: {
              "gateway.ready": { count: 1, totalDurationMs: 120, maxDurationMs: 120 },
              "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
            }
          }
        }
      },
      {
        id: "gateway-agent-turn",
        commands: [turnCommand],
        results: [{
          command: turnCommand,
          status: 0,
          timedOut: false,
          startedAt: "2026-05-15T10:00:10.000Z",
          startedAtEpochMs: 1778839210000,
          finishedAt: "2026-05-15T10:00:13.000Z",
          finishedAtEpochMs: 1778839213000,
          durationMs: 3000,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: "",
          resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/gateway-agent-turn-1.jsonl")
        }],
        metrics: {
          health: { ok: true, durationMs: 2 },
          healthSummary: syntheticHealthSummary(),
          logs: zeroLogMetrics(),
          timeline: syntheticTimelineMetrics()
        }
      },
      {
        id: "post-agent-health",
        commands: [
          "ocm @kova -- status",
          "ocm logs kova --tail 300 --raw"
        ],
        results: [
          {
            command: "ocm @kova -- status",
            status: 0,
            durationMs: 100,
            stdout: "OpenClaw env ok\n",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/post-agent-health-1.jsonl")
          },
          {
            command: "ocm logs kova --tail 300 --raw",
            status: 0,
            durationMs: 50,
            stdout: "gateway ready\nKOVA_AGENT_OK\n",
            resourceSamples: syntheticAgentGatewayResourceSamples("/tmp/kova/resources/post-agent-health-2.jsonl")
          }
        ],
        metrics: {
          readiness: syntheticReadyReadiness(),
          healthSummary: syntheticHealthSummary(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
          logs: {
            ...zeroLogMetrics(),
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          },
          timeline: syntheticTimelineMetrics()
        }
      }
    ],
    providerEvidence: {
      available: true,
      requestCount: 1,
      summaryPath: "/tmp/kova/provider/provider-evidence.json",
      artifacts: ["/tmp/kova/mock-openai/requests.jsonl", "/tmp/kova/provider/provider-evidence.json"],
      requests: [{
        requestId: "gateway-provider",
        receivedAt: "2026-05-15T10:00:12.000Z",
        receivedAtEpochMs: 1778839212000,
        respondedAt: "2026-05-15T10:00:12.050Z",
        respondedAtEpochMs: 1778839212050,
        firstByteLatencyMs: 5,
        firstChunkLatencyMs: 5,
        route: "/v1/responses",
        model: "gpt-5.5",
        status: 200,
        statusClass: "2xx"
      }]
    },
    finalMetrics: {
      service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
      health: { ok: true, durationMs: 1 },
      healthSummary: syntheticHealthSummary(),
      logs: zeroLogMetrics(),
      timeline: syntheticTimelineMetrics()
    }
  };
}

function syntheticAgentGatewayResourceSamples(artifactPath) {
  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: 1,
    artifactPath,
    peakTotalRssMb: 1000,
    maxTotalCpuPercent: 120,
    peakCommandTreeRssMb: 500,
    peakGatewayRssMb: 600,
    byRole: {
      gateway: {
        peakRssMb: 600,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "gateway-tree": {
        peakRssMb: 600,
        maxCpuPercent: 80,
        peakProcessCount: 1
      },
      "agent-cli": {
        peakRssMb: 500,
        maxCpuPercent: 120,
        peakProcessCount: 1
      },
      "agent-process": {
        peakRssMb: 500,
        maxCpuPercent: 120,
        peakProcessCount: 1
      },
      "command-tree": {
        peakRssMb: 500,
        maxCpuPercent: 120,
        peakProcessCount: 1
      }
    },
    topRolesByRss: [{ role: "gateway", peakRssMb: 600, maxCpuPercent: 80 }],
    topRolesByCpu: [{ role: "agent-cli", peakRssMb: 500, maxCpuPercent: 120 }],
    topByRss: [],
    topByCpu: []
  };
}

export function syntheticOfficialPluginInstallRecord({ helperPayload = {}, includeInstallHelper = true } = {}) {
  const officialPayload = {
    schemaVersion: "kova.officialPluginInstall.v1",
    ok: true,
    pluginCount: 1,
    requiredPluginCount: 1,
    failedRequiredCount: 0,
    durationMs: 1200,
    installed: true,
    listed: true,
    registryRefreshed: true,
    securityBlocked: false,
    securityBlockCount: 0,
    securityEvidence: null,
    failureEvidence: [],
    artifactPath: "/tmp/kova/official-plugins.json",
    pluginResults: [{
      id: "discord",
      package: "@openclaw/discord",
      ok: true,
      required: true,
      installed: true,
      listed: true,
      registryRefreshed: true,
      securityBlocked: false
    }],
    commands: [
      { id: "install:discord", status: 0, durationMs: 500 },
      { id: "list:discord", status: 0, durationMs: 100 },
      { id: "registry-refresh:discord", status: 0, durationMs: 100 }
    ],
    ...helperPayload
  };
  officialPayload.ok = officialPayload.securityBlocked === true ? false : officialPayload.ok;
  officialPayload.securityBlockCount = officialPayload.securityBlocked === true
    ? Math.max(1, officialPayload.securityBlockCount ?? 1)
    : officialPayload.securityBlockCount;
  officialPayload.failedRequiredCount = officialPayload.securityBlocked === true
    ? Math.max(1, officialPayload.failedRequiredCount ?? 1)
    : officialPayload.failedRequiredCount;

  const installResults = includeInstallHelper
    ? [{
        command: "node support/run-official-plugin-install.mjs --env kova --state states/official-plugins.json --artifact-dir /tmp/kova --timeout-ms 120000",
        status: officialPayload.ok ? 0 : 1,
        durationMs: 1200,
        stdout: JSON.stringify(officialPayload),
        resourceSamples: syntheticReleaseStartupResourceSamples("/tmp/kova/resources/install-1.jsonl")
      }]
    : [];

  return {
    scenario: "official-plugin-install",
    surface: "official-plugin-install",
    status: "PASS",
    phases: [
      {
        id: "provision",
        results: [
          { command: "ocm start kova --runtime stable --json", status: 0, durationMs: 100, stdout: "{\"gatewayPort\":43111}" },
          { command: "ocm @kova -- plugins list", status: 0, durationMs: 100, stdout: "Plugins\n" }
        ],
        metrics: {
          readiness: syntheticReadyReadiness(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" }
        }
      },
      {
        id: "install",
        results: installResults,
        metrics: {
          healthSummary: syntheticHealthSummary(),
          logs: zeroLogMetrics()
        }
      },
      {
        id: "restart",
        results: [{
          command: "node support/ensure-gateway-running.mjs --env kova --artifact-dir /tmp/kova --timeout-ms 120000",
          status: 0,
          durationMs: 300,
          stdout: "{\"ok\":true,\"gatewayState\":\"running\"}"
        }],
        metrics: {
          readiness: syntheticReadyReadiness(),
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" }
        }
      },
      {
        id: "post-restart-verify",
        results: [
          { command: "ocm service status kova --json", status: 0, durationMs: 50, stdout: "{\"gatewayState\":\"running\"}" },
          { command: "ocm @kova -- plugins list", status: 0, durationMs: 100, stdout: "@openclaw/discord\n" },
          { command: "ocm logs kova --tail 400 --raw", status: 0, durationMs: 40, stdout: "plugins loaded\n" }
        ],
        metrics: {
          collectors: [
            syntheticCollectorReceipt("service"),
            syntheticCollectorReceipt("logs", { artifacts: ["/tmp/kova/logs/gateway-tail.log"] }),
            syntheticCollectorReceipt("timeline", { artifacts: ["/tmp/kova/openclaw/timeline.jsonl"] })
          ],
          service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
          healthSummary: syntheticHealthSummary(),
          logs: {
            ...zeroLogMetrics(),
            artifacts: ["/tmp/kova/logs/gateway-tail.log"]
          },
          timeline: syntheticTimelineMetrics()
        }
      }
    ],
    finalMetrics: {
      service: { gatewayState: "running", gatewayPort: 43111, runtimeReleaseVersion: "2026.5.7", runtimeReleaseChannel: "stable" },
      health: { ok: true, durationMs: 1 },
      healthSummary: syntheticHealthSummary(),
      logs: zeroLogMetrics(),
      timeline: syntheticTimelineMetrics()
    }
  };
}

export function syntheticCollectorReceipt(id, overrides = {}) {
  return {
    schemaVersion: "kova.collectorReceipt.v1",
    id,
    status: "PASS",
    durationMs: 1,
    commandStatus: 0,
    timedOut: false,
    artifactCount: overrides.artifacts?.length ?? 0,
    artifacts: overrides.artifacts ?? [],
    error: null,
    ...overrides
  };
}

function syntheticReadyReadiness() {
  return {
    classification: {
      state: "ready",
      severity: "pass",
      reason: "gateway became healthy within the readiness threshold"
    },
    listeningReadyAtMs: 100,
    healthReadyAtMs: 200,
    thresholdMs: 30000,
    deadlineMs: 120000,
    attempts: 2,
    healthAttempts: [
      { ok: false, durationMs: 5 },
      { ok: true, durationMs: 4 }
    ]
  };
}

function syntheticHealthSummary() {
  return {
    count: 1,
    okCount: 1,
    failureCount: 0,
    minMs: 1,
    p50Ms: 1,
    p95Ms: 1,
    maxMs: 1
  };
}

function syntheticTimelineMetrics() {
  return {
    available: true,
    eventCount: 4,
    parseErrorCount: 0,
    artifacts: ["/tmp/kova/openclaw/timeline.jsonl"],
    keySpans: {
      "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
    },
    spanTotals: {
      "plugins.metadata.scan": { count: 1, totalDurationMs: 30, maxDurationMs: 30 }
    },
    openSpanCount: 0,
    openSpans: [],
    runtimeDeps: {},
    eventLoop: {},
    providers: {},
    childProcesses: {}
  };
}

export function syntheticReleaseStartupResourceSamples(artifactPath) {
  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: 1,
    artifactPath,
    peakTotalRssMb: 500,
    maxTotalCpuPercent: 60,
    peakCommandTreeRssMb: 20,
    peakGatewayRssMb: 480,
    byRole: {
      gateway: {
        peakRssMb: 480,
        maxCpuPercent: 60,
        peakProcessCount: 1
      },
      "command-tree": {
        peakRssMb: 20,
        maxCpuPercent: 5,
        peakProcessCount: 1
      }
    },
    trend: {
      available: true,
      sampleCount: 1,
      totalRssGrowthMb: 0,
      gatewayRssGrowthMb: 0
    },
    peakRssSample: {
      elapsedMs: 1000,
      totalRssMb: 500,
      topProcess: { pid: 123, role: "gateway", roles: ["gateway"], rssMb: 480, cpuPercent: 60, command: "openclaw gateway" }
    },
    peakCpuSample: {
      elapsedMs: 1000,
      totalCpuPercent: 60,
      topProcess: { pid: 123, role: "gateway", roles: ["gateway"], rssMb: 480, cpuPercent: 60, command: "openclaw gateway" }
    },
    topByRss: [],
    topByCpu: []
  };
}

export function timelineEvent(event) {
  const timestamp = typeof event.timestamp === "number" ? new Date(event.timestamp).toISOString() : event.timestamp;
  return JSON.stringify({
    schemaVersion: "openclaw.diagnostics.v1",
    ...event,
    timestamp
  });
}

export function syntheticGatewaySessionRecord({ base, timeline }) {
  const coldPayload = {
    ok: true,
    surface: "gateway-session-send-turn",
    method: "sessions.send",
    createSession: true,
    minAssistantCount: 1,
    sessionKey: "kova-gateway-session-send",
    runId: "cold-run",
    gatewayTransport: { kind: "direct-gateway-rpc" },
    activeStartedAtEpochMs: base + 1000,
    activeFinishedAtEpochMs: base + 2500,
    activeTurnMs: 1500,
    sendStartedAtEpochMs: base + 1000,
    sendFinishedAtEpochMs: base + 1040,
    sendDurationMs: 40,
    assistantFirstSeenAtEpochMs: base + 2200,
    assistantMatchedAtEpochMs: base + 2500,
    timeToFirstAssistantMs: 1200,
    timeToMatchedAssistantMs: 1500,
    historyPollCount: 3,
    historyErrorCount: 0,
    assistantMessageCount: 1,
    finalAssistantVisibleText: "KOVA_AGENT_OK",
    expectedTextPresent: true
  };
  const warmPayload = {
    ...coldPayload,
    createSession: false,
    minAssistantCount: 2,
    runId: "warm-run",
    activeStartedAtEpochMs: base + 11000,
    activeFinishedAtEpochMs: base + 11800,
    activeTurnMs: 800,
    sendStartedAtEpochMs: base + 11000,
    sendFinishedAtEpochMs: base + 11050,
    sendDurationMs: 50,
    assistantFirstSeenAtEpochMs: base + 11600,
    assistantMatchedAtEpochMs: base + 11800,
    timeToFirstAssistantMs: 600,
    timeToMatchedAssistantMs: 800,
    historyPollCount: 2,
    assistantMessageCount: 2
  };
  return {
    scenario: "gateway-session-send-turn",
    surface: "gateway-session-send-turn",
    title: "Gateway session cold/warm",
    status: "PASS",
    cleanup: "done",
    auth: { mode: "mock" },
    phases: [
      syntheticGatewayTurnPhase({
        id: "cold-gateway-session-turn",
        command: "node support/run-gateway-session-send-turn.mjs --create-session true",
        startedAtEpochMs: base,
        finishedAtEpochMs: base + 5000,
        payload: coldPayload
      }),
      syntheticGatewayTurnPhase({
        id: "warm-gateway-session-turn",
        command: "node support/run-gateway-session-send-turn.mjs --create-session false",
        startedAtEpochMs: base + 10000,
        finishedAtEpochMs: base + 14000,
        payload: warmPayload
      })
    ],
    providerEvidence: {
      available: true,
      requestCount: 2,
      requests: [
        {
          requestId: "cold-provider",
          receivedAt: new Date(base + 1200).toISOString(),
          receivedAtEpochMs: base + 1200,
          respondedAt: new Date(base + 1800).toISOString(),
          respondedAtEpochMs: base + 1800,
          firstByteLatencyMs: 25,
          firstChunkLatencyMs: 30,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200
        },
        {
          requestId: "warm-provider",
          receivedAt: new Date(base + 11250).toISOString(),
          receivedAtEpochMs: base + 11250,
          respondedAt: new Date(base + 11600).toISOString(),
          respondedAtEpochMs: base + 11600,
          firstByteLatencyMs: 20,
          firstChunkLatencyMs: 22,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200
        }
      ]
    },
    finalMetrics: {
      service: { gatewayState: "running" },
      logs: zeroLogMetrics(),
      timeline: {
        ...timeline,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    }
  };
}

export function syntheticAgentCliRecord({ base, timeline }) {
  return {
    scenario: "agent-cold-warm-message",
    surface: "agent-cold-warm-message",
    title: "Agent CLI cold/warm",
    status: "PASS",
    cleanup: "done",
    auth: { mode: "mock" },
    phases: [
      syntheticAgentCliTurnPhase({
        id: "cold-agent-turn",
        startedAtEpochMs: base + 1000,
        finishedAtEpochMs: base + 1900
      }),
      syntheticAgentCliTurnPhase({
        id: "warm-agent-turn",
        startedAtEpochMs: base + 11000,
        finishedAtEpochMs: base + 11600
      })
    ],
    providerEvidence: {
      available: true,
      requestCount: 2,
      requests: [
        {
          requestId: "cold-provider",
          receivedAt: new Date(base + 1200).toISOString(),
          receivedAtEpochMs: base + 1200,
          respondedAt: new Date(base + 1700).toISOString(),
          respondedAtEpochMs: base + 1700,
          firstByteLatencyMs: 20,
          firstChunkLatencyMs: 25,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200
        },
        {
          requestId: "warm-provider",
          receivedAt: new Date(base + 11200).toISOString(),
          receivedAtEpochMs: base + 11200,
          respondedAt: new Date(base + 11500).toISOString(),
          respondedAtEpochMs: base + 11500,
          firstByteLatencyMs: 18,
          firstChunkLatencyMs: 20,
          route: "/v1/responses",
          model: "gpt-5.5",
          status: 200
        }
      ]
    },
    finalMetrics: {
      service: { gatewayState: "running" },
      logs: zeroLogMetrics(),
      timeline: {
        ...timeline,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    }
  };
}

function syntheticAgentCliTurnPhase({ id, startedAtEpochMs, finishedAtEpochMs }) {
  const command = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
  return {
    id,
    title: id,
    intent: "Synthetic agent CLI turn",
    commands: [command],
    evidence: [],
    results: [{
      command,
      status: 0,
      timedOut: false,
      startedAt: new Date(startedAtEpochMs).toISOString(),
      startedAtEpochMs,
      finishedAt: new Date(finishedAtEpochMs).toISOString(),
      finishedAtEpochMs,
      durationMs: finishedAtEpochMs - startedAtEpochMs,
      stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
      stderr: ""
    }],
    metrics: { logs: zeroLogMetrics(), health: { ok: true } }
  };
}

function syntheticGatewayTurnPhase({ id, command, startedAtEpochMs, finishedAtEpochMs, payload }) {
  return {
    id,
    title: id,
    intent: "Synthetic Gateway session turn",
    commands: [command],
    evidence: [],
    results: [{
      command,
      status: 0,
      timedOut: false,
      startedAt: new Date(startedAtEpochMs).toISOString(),
      startedAtEpochMs,
      finishedAt: new Date(finishedAtEpochMs).toISOString(),
      finishedAtEpochMs,
      durationMs: finishedAtEpochMs - startedAtEpochMs,
      stdout: JSON.stringify(payload),
      stderr: ""
    }],
    metrics: { logs: zeroLogMetrics(), health: { ok: true } }
  };
}

export function syntheticTurn({
  startedAtEpochMs,
  firstProviderRequestAtEpochMs,
  firstByteLatencyMs = null,
  firstChunkLatencyMs = null,
  lastProviderResponseAtEpochMs,
  finishedAtEpochMs,
  timelineSummary
}) {
  const result = {
    command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
    startedAt: new Date(startedAtEpochMs).toISOString(),
    startedAtEpochMs,
    finishedAt: new Date(finishedAtEpochMs).toISOString(),
    finishedAtEpochMs,
    durationMs: finishedAtEpochMs - startedAtEpochMs,
    processSnapshots: {
      before: { capturedAt: new Date(startedAtEpochMs - 10).toISOString(), processCount: 2 },
      after: { capturedAt: new Date(finishedAtEpochMs + 10).toISOString(), processCount: 2 },
      leaks: { leakCount: 0, leaksByRole: {}, leakedProcesses: [] }
    }
  };
  const request = {
    requestId: "self-check-provider",
    receivedAt: new Date(firstProviderRequestAtEpochMs).toISOString(),
    receivedAtEpochMs: firstProviderRequestAtEpochMs,
    firstByteLatencyMs,
    firstChunkLatencyMs,
    respondedAt: new Date(lastProviderResponseAtEpochMs).toISOString(),
    respondedAtEpochMs: lastProviderResponseAtEpochMs,
    route: "/v1/responses",
    model: "gpt-5.5",
    stream: true,
    status: 200,
    statusClass: "2xx"
  };
  const attribution = computeProviderTurnAttribution(result, {
    available: true,
    requests: [request]
  });
  return {
    result,
    request,
    attribution,
    breakdown: buildAgentTurnBreakdown({ result, attribution, timelineSummary })
  };
}

export function providerRequest({ startedAt, finishedAt, status }) {
  return {
    requestId: `provider-${startedAt}`,
    mode: "normal",
    outcome: "completed",
    errorClass: null,
    receivedAt: new Date(startedAt).toISOString(),
    receivedAtEpochMs: startedAt,
    respondedAt: new Date(finishedAt).toISOString(),
    respondedAtEpochMs: finishedAt,
    firstByteLatencyMs: Math.max(0, finishedAt - startedAt),
    firstChunkLatencyMs: Math.max(0, finishedAt - startedAt),
    route: "/v1/chat/completions",
    model: "openclaw",
    stream: false,
    status,
    statusClass: `${Math.floor(status / 100)}xx`
  };
}

export function zeroProcessLeakSummary() {
  return {
    schemaVersion: "kova.processLeakSummary.v1",
    leakCount: 0,
    leakedProcesses: [],
    leaksByRole: {}
  };
}

export function syntheticProviderSpecificRecord({ scenarioId, phaseId, expectedFailure, commandStatus, stdout, stderr, providerRequests }) {
  const startedAtEpochMs = 1777543201000;
  const finishedAtEpochMs = 1777543203000;
  const normalizedRequests = providerRequests.map((request) => ({
    receivedAt: new Date(request.receivedAtEpochMs).toISOString(),
    respondedAt: new Date(request.respondedAtEpochMs).toISOString(),
    firstByteLatencyMs: 10,
    firstChunkLatencyMs: 10,
    route: "/v1/responses",
    model: "gpt-5.5",
    stream: true,
    ...request
  }));
  return {
    scenario: scenarioId,
    status: "PASS",
    auth: { mode: "mock", source: "mock", providerId: "openai" },
    phases: [
      {
        id: phaseId,
        expectedAgentFailure: expectedFailure,
        results: [{
          command: "ocm @kova-self-check -- agent --local --agent main --session-id kova-provider-specific --message hi --json",
          status: commandStatus,
          timedOut: false,
          startedAt: new Date(startedAtEpochMs).toISOString(),
          startedAtEpochMs,
          finishedAt: new Date(finishedAtEpochMs).toISOString(),
          finishedAtEpochMs,
          durationMs: finishedAtEpochMs - startedAtEpochMs,
          stdout,
          stderr,
          processSnapshots: {
            leaks: {
              schemaVersion: "kova.processLeakSummary.v1",
              leakCount: 0,
              leakedProcesses: [],
              leaksByRole: {}
            }
          }
        }],
        metrics: { logs: zeroLogMetrics(), health: { ok: true } }
      }
    ],
    providerEvidence: {
      available: true,
      requestCount: normalizedRequests.length,
      requests: normalizedRequests
    },
    finalMetrics: {
      service: { gatewayState: "running" },
      logs: zeroLogMetrics()
    }
  };
}

export function syntheticCompareReport({ runId, target, timelineAvailable, preProviderMs, slowestSpanMs }) {
  return {
    runId,
    mode: "execution",
    target,
    generatedAt: "2026-05-01T00:00:00.000Z",
    platform: { os: "darwin", arch: "arm64", release: "test", node: "test" },
    summary: { statuses: { PASS: 1 } },
    records: [{
      scenario: "agent-cold-warm-message",
      surface: "agent-cli-local-turn",
      state: { id: "mock-openai-provider" },
      status: "PASS",
      measurements: {
        resourceMeasurementScope: RESOURCE_MEASUREMENT_SCOPE,
        resourceHeadlineContract: RESOURCE_HEADLINE_CONTRACT,
        openclawTimelineAvailable: timelineAvailable,
        openclawTimelineEventCount: timelineAvailable ? 20 : 0,
        openclawSlowestSpanName: timelineAvailable ? "agent.prepare" : null,
        openclawSlowestSpanMs: slowestSpanMs,
        coldAgentTurnMs: preProviderMs + 800,
        coldPreProviderMs: preProviderMs,
        coldProviderFinalMs: 800,
        agentTurnMs: preProviderMs + 800,
        agentPreProviderMs: preProviderMs,
        agentProviderFinalMs: 800,
        runtimeDepsStagingMs: 0,
        peakRssMb: 100
      }
    }]
  };
}

export function runtimeDepsRecord({ coldLog, warmLog }) {
  return {
    scenario: "bundled-runtime-deps",
    status: "PASS",
    phases: [
      {
        id: "cold-start",
        results: [{ command: "ocm logs kova-runtime-deps --tail 300 --raw", status: 0, stdout: coldLog, stderr: "", durationMs: 100 }],
        metrics: {
          service: { gatewayState: "running" },
          logs: zeroLogMetrics()
        }
      },
      {
        id: "warm-restart",
        results: [{ command: "ocm logs kova-runtime-deps --tail 300 --raw", status: 0, stdout: warmLog, stderr: "", durationMs: 100 }],
        metrics: {
          service: { gatewayState: "running" },
          logs: zeroLogMetrics()
        }
      }
    ],
    finalMetrics: {
      service: { gatewayState: "running" },
      logs: zeroLogMetrics()
    }
  };
}

export function zeroLogMetrics() {
  return {
    missingDependencyErrors: 0,
    pluginLoadFailures: 0,
    metadataScanMentions: 0,
    configNormalizationMentions: 0,
    gatewayRestartMentions: 0,
    providerLoadMentions: 0,
    modelCatalogMentions: 0,
    providerTimeoutMentions: 0,
    eventLoopDelayMentions: 0,
    v8DiagnosticMentions: 0
  };
}
