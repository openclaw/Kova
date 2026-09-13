import { buildAgentCliPreProviderAttribution } from "../collectors/agent-cli-attribution.mjs";
import {
  attributedSpanIntervals,
  buildGatewaySessionPreProviderAttribution
} from "../collectors/gateway-session-turn-attribution.mjs";
import { parseTimelineText } from "../collectors/timeline.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { renderMarkdownReport } from "../reporting/report.mjs";
import { syntheticAgentCliRecord, syntheticGatewaySessionRecord, timelineEvent } from "./fixtures.mjs";
import { assertEqual } from "./harness.mjs";

export function gatewaySessionPreProviderAttributionCheck() {
  try {
    const base = 1777536000000;
    const timelineText = [
      timelineEvent({ type: "span.start", name: "gateway.chat_send.load_session", timestamp: base + 1010, spanId: "cold-load" }),
      timelineEvent({ type: "span.end", name: "gateway.chat_send.load_session", timestamp: base + 1070, spanId: "cold-load", durationMs: 60 }),
      timelineEvent({ type: "span.start", name: "auto_reply.finalize_context", timestamp: base + 1060, spanId: "cold-finalize" }),
      timelineEvent({ type: "span.end", name: "auto_reply.finalize_context", timestamp: base + 1160, spanId: "cold-finalize", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "reply.ensure_workspace", timestamp: base + 1180, spanId: "cold-workspace" }),
      timelineEvent({ type: "span.error", name: "reply.ensure_workspace", timestamp: base + 1230, spanId: "cold-workspace", durationMs: 50, errorName: "SyntheticError" }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 1150, spanId: "cold-scan", durationMs: 33, phase: "startup" }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 1175, spanId: "cold-scan-gap", durationMs: 10, phase: "agent-turn" }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 1200, receivedAtEpochMs: base + 1200, respondedAtEpochMs: base + 1800, durationMs: 600 }),
      timelineEvent({ type: "eventLoop.sample", name: "eventLoop.sample", timestamp: base + 1250, maxMs: 9 }),
      timelineEvent({ type: "span.start", name: "gateway.chat_send.dispatch_inbound", timestamp: base + 11025, spanId: "warm-dispatch" }),
      timelineEvent({ type: "span.end", name: "gateway.chat_send.dispatch_inbound", timestamp: base + 11125, spanId: "warm-dispatch", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "reply.load_runtime_plugins", timestamp: base + 11120, spanId: "warm-plugins" }),
      timelineEvent({ type: "span.end", name: "reply.load_runtime_plugins", timestamp: base + 11220, spanId: "warm-plugins", durationMs: 100 }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 11100, spanId: "warm-scan", durationMs: 11, phase: "agent-turn" }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 11250, receivedAtEpochMs: base + 11250, respondedAtEpochMs: base + 11600, durationMs: 350 }),
      timelineEvent({ type: "eventLoop.sample", name: "eventLoop.sample", timestamp: base + 11200, maxMs: 7 })
    ].join("\n");
    const parsed = parseTimelineText(timelineText);
    assertEqual(parsed.turnAttributionEvents.length, 17, "turn attribution events retained");
    const parsedIntervals = attributedSpanIntervals(parsed.turnAttributionEvents);
    assertEqual(parsedIntervals.length, 8, "span parser includes error terminal and metadata scans");
    assertEqual(parsedIntervals.some((span) => span.type === "span.error" && span.name === "reply.ensure_workspace"), true, "span error included");

    const coldAttribution = buildGatewaySessionPreProviderAttribution({
      label: "cold",
      phaseId: "cold-gateway-session-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 2500,
      attribution: {
        firstProviderRequestAtEpochMs: base + 1200,
        preProviderMs: 200,
        providerFinalMs: 600,
        firstByteLatencyMs: 25,
        firstChunkLatencyMs: 30
      },
      timelineSummary: {
        available: true,
        turnAttributionEvents: parsed.turnAttributionEvents,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    });
    assertEqual(coldAttribution.available, true, "cold attribution available");
    assertEqual(coldAttribution.knownAttributedMs, 180, "overlap-safe cold known attribution includes active-turn metadata scan");
    assertEqual(coldAttribution.unattributedMs, 20, "cold unattributed remainder");
    const coldScanSummary = coldAttribution.spanSummaries.find((span) => span.name === "plugins.metadata.scan");
    assertEqual(coldScanSummary?.count, 2, "gateway session attribution includes active-turn metadata scans");
    assertEqual(coldScanSummary?.phases?.some((phase) => phase.phase === "startup"), true, "startup phase scan inside active window is counted");
    assertEqual(coldScanSummary?.phases?.some((phase) => phase.phase === "agent-turn"), true, "agent-turn phase scan inside active window is counted");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "reply.ensure_workspace")?.errorCount, 1, "error span summary");
    assertEqual(coldAttribution.provider.totalDurationMs, 600, "provider duration stays separate");
    assertEqual(coldAttribution.timelineArtifacts[0], "/tmp/kova/openclaw/timeline.jsonl", "timeline artifact path");

    const missingAttribution = buildGatewaySessionPreProviderAttribution({
      label: "cold",
      phaseId: "cold-gateway-session-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 2500,
      attribution: { firstProviderRequestAtEpochMs: base + 1200, preProviderMs: 200 },
      timelineSummary: { available: false, artifacts: [] }
    });
    assertEqual(missingAttribution.available, false, "missing timeline unavailable");
    assertEqual(missingAttribution.unattributedMs, 200, "missing timeline preserves full remainder");

    const record = syntheticGatewaySessionRecord({ base, timeline: parsed });
    evaluateRecord(record, {
      id: "gateway-session-send-turn",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentTurnMs: 2000, coldAgentTurnMs: 2000, warmAgentTurnMs: 1000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    assertEqual(record.measurements.coldPreProviderAttributedMs, 180, "record cold attributed metric");
    assertEqual(record.measurements.warmPreProviderAttributedMs, 195, "record warm attributed metric");
    assertEqual(record.measurements.warmPreProviderUnattributedMs, 55, "record warm unattributed metric");
    assertEqual(record.measurements.gatewaySessionPreProviderAttribution.timelineArtifacts[0], "/tmp/kova/openclaw/timeline.jsonl", "record timeline artifact");

    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-gateway-session-pre-provider",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("Gateway session pre-provider attribution:"), true, "markdown includes gateway session attribution table");
    assertEqual(rendered.includes("Spans are clipped to the active turn timestamp window"), true, "markdown describes timestamp-window attribution");
    assertEqual(rendered.includes("`agent-turn`"), true, "markdown includes metadata scan phase as descriptive context");
    assertEqual(rendered.includes("`reply.ensure_workspace`"), true, "markdown includes span table");

    return {
      id: "gateway-session-pre-provider-attribution",
      status: "PASS",
      command: "evaluate synthetic Gateway session pre-provider timeline attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gateway-session-pre-provider-attribution",
      status: "FAIL",
      command: "evaluate synthetic Gateway session pre-provider timeline attribution",
      durationMs: 0,
      message: error.message
    };
  }
}

export function agentCliPreProviderAttributionCheck() {
  try {
    const base = 1777536000000;
    const timelineText = [
      timelineEvent({ type: "span.start", name: "agent.turn", timestamp: base + 1000, spanId: "cold-turn" }),
      timelineEvent({ type: "span.start", name: "cli.main.core-imports", phase: "cli.startup", timestamp: base + 1000, spanId: "cold-cli-main" }),
      timelineEvent({ type: "span.end", name: "cli.main.core-imports", timestamp: base + 1040, spanId: "cold-cli-main", durationMs: 40 }),
      timelineEvent({ type: "span.start", name: "cli.command-startup", phase: "cli.command-startup", timestamp: base + 1040, spanId: "cold-cli-command", attributes: { stage: "agent-action-imports" } }),
      timelineEvent({ type: "span.end", name: "cli.command-startup", phase: "cli.command-startup", timestamp: base + 1080, spanId: "cold-cli-command", durationMs: 40, attributes: { stage: "agent-action-imports" } }),
      timelineEvent({ type: "span.start", name: "agent.startup", phase: "agent.startup", timestamp: base + 1080, spanId: "cold-agent-startup", attributes: { stage: "command-prepare" } }),
      timelineEvent({ type: "span.end", name: "agent.startup", phase: "agent.startup", timestamp: base + 1150, spanId: "cold-agent-startup", durationMs: 70, attributes: { stage: "command-prepare" } }),
      timelineEvent({ type: "span.start", name: "agent.prepare", timestamp: base + 1020, spanId: "cold-prepare" }),
      timelineEvent({ type: "span.end", name: "agent.prepare", timestamp: base + 1120, spanId: "cold-prepare", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "models.catalog.gateway", timestamp: base + 1080, spanId: "cold-models" }),
      timelineEvent({ type: "span.end", name: "models.catalog.gateway", timestamp: base + 1180, spanId: "cold-models", durationMs: 100 }),
      timelineEvent({ type: "span.start", name: "channel.plugin.load", timestamp: base + 1150, spanId: "cold-channel" }),
      timelineEvent({ type: "span.error", name: "channel.plugin.load", timestamp: base + 1170, spanId: "cold-channel", durationMs: 20, errorName: "SyntheticError" }),
      timelineEvent({ type: "span.end", name: "plugins.metadata.scan", timestamp: base + 1190, spanId: "cold-scan", durationMs: 30 }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 1200, receivedAtEpochMs: base + 1200, respondedAtEpochMs: base + 1700, durationMs: 500 }),
      timelineEvent({ type: "span.end", name: "agent.turn", timestamp: base + 1900, spanId: "cold-turn", durationMs: 900 }),
      timelineEvent({ type: "span.start", name: "runtimeDeps.stage", timestamp: base + 11020, spanId: "warm-runtime" }),
      timelineEvent({ type: "span.end", name: "runtimeDeps.stage", timestamp: base + 11070, spanId: "warm-runtime", durationMs: 50 }),
      timelineEvent({ type: "span.start", name: "channel.capabilities", timestamp: base + 11080, spanId: "warm-channel" }),
      timelineEvent({ type: "span.end", name: "channel.capabilities", timestamp: base + 11110, spanId: "warm-channel", durationMs: 30 }),
      timelineEvent({ type: "provider.request", name: "provider.request", timestamp: base + 11200, receivedAtEpochMs: base + 11200, respondedAtEpochMs: base + 11500, durationMs: 300 }),
      timelineEvent({ type: "eventLoop.sample", name: "eventLoop.sample", timestamp: base + 11250, maxMs: 6 })
    ].join("\n");
    const parsed = parseTimelineText(timelineText);
    assertEqual(parsed.turnAttributionEvents.length, 22, "agent CLI turn attribution events retain startup phases");
    assertEqual(
      parsed.turnAttributionEvents.find((event) => event.spanId === "cold-cli-main" && event.type === "span.end")?.phase,
      null,
      "phase-less terminal paired to selected startup span is retained"
    );

    const coldAttribution = buildAgentCliPreProviderAttribution({
      label: "cold",
      phaseId: "cold-agent-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 1900,
      attribution: {
        firstProviderRequestAtEpochMs: base + 1200,
        preProviderMs: 200,
        providerFinalMs: 500
      },
      timelineSummary: {
        available: true,
        turnAttributionEvents: parsed.turnAttributionEvents,
        artifacts: ["/tmp/kova/openclaw/timeline.jsonl"]
      }
    });
    assertEqual(coldAttribution.available, true, "agent CLI cold attribution available");
    assertEqual(coldAttribution.knownAttributedMs, 190, "agent CLI overlap-safe cold known attribution");
    assertEqual(coldAttribution.unattributedMs, 10, "agent CLI cold unattributed remainder");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "cli.main.core-imports")?.phases?.[0]?.phase, "cli.startup", "agent CLI startup span attributed by phase");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "cli.command-startup")?.phases?.[0]?.phase, "cli.command-startup", "command startup span attributed by phase");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "agent.startup")?.phases?.[0]?.phase, "agent.startup", "agent startup span attributed by phase");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "cli.command-startup")?.stages?.[0]?.stage, "agent-action-imports", "command startup stage retained");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "agent.startup")?.stages?.[0]?.stage, "command-prepare", "agent startup stage retained");
    assertEqual(coldAttribution.spanSummaries.some((span) => span.name === "agent.turn"), false, "agent.turn parent span is not counted as pre-provider work");
    assertEqual(coldAttribution.spanSummaries.find((span) => span.name === "channel.plugin.load")?.errorCount, 1, "agent CLI error span summary");

    const missingAttribution = buildAgentCliPreProviderAttribution({
      label: "cold",
      phaseId: "cold-agent-turn",
      activeStartedAtEpochMs: base + 1000,
      activeFinishedAtEpochMs: base + 1900,
      attribution: { firstProviderRequestAtEpochMs: base + 1200, preProviderMs: 200 },
      timelineSummary: { available: false, artifacts: [] }
    });
    assertEqual(missingAttribution.available, false, "agent CLI missing timeline unavailable");
    assertEqual(missingAttribution.unattributedMs, 200, "agent CLI missing timeline preserves full remainder");

    const record = syntheticAgentCliRecord({ base, timeline: parsed });
    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: { agentTurnMs: 2000, coldAgentTurnMs: 2000, warmAgentTurnMs: 1000 }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "runtime" } });
    assertEqual(record.measurements.agentCliPreProviderAttribution.count, 2, "record agent CLI attribution count");
    assertEqual(record.measurements.gatewaySessionPreProviderAttribution.count, 0, "record gateway session attribution stays empty for CLI turns");
    assertEqual(record.measurements.coldPreProviderAttributedMs, 190, "record agent CLI cold attributed metric");
    assertEqual(record.measurements.warmPreProviderAttributedMs, 80, "record agent CLI warm attributed metric");
    assertEqual(record.measurements.warmPreProviderUnattributedMs, 120, "record agent CLI warm unattributed metric");
    assertEqual(record.measurements.agentTurns[0].agentCliPreProviderAttribution.timelineArtifacts[0], "/tmp/kova/openclaw/timeline.jsonl", "record agent CLI timeline artifact");

    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-agent-cli-pre-provider",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("Agent CLI pre-provider attribution:"), true, "markdown includes agent CLI attribution table");
    assertEqual(rendered.includes("`cli.startup`"), true, "markdown includes CLI startup attribution phase");
    assertEqual(rendered.includes("`cli.command-startup`"), true, "markdown includes agent CLI startup span table");

    return {
      id: "agent-cli-pre-provider-attribution",
      status: "PASS",
      command: "evaluate synthetic agent CLI pre-provider timeline attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cli-pre-provider-attribution",
      status: "FAIL",
      command: "evaluate synthetic agent CLI pre-provider timeline attribution",
      durationMs: 0,
      message: error.message
    };
  }
}
