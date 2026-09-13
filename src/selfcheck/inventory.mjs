import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRepeatedWorkAudit } from "../audits/repeated-work.mjs";
import { quoteShell } from "../commands.mjs";
import { classifyManifest, selectManifestCandidates } from "../inventory/openclaw.mjs";
import { assertEqual, jsonCommandCheck } from "./harness.mjs";

export function inventoryManifestContractsCheck() {
  const canonicalManifest = {
    id: "discord",
    channels: ["discord"],
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  };
  assertEqual(
    classifyManifest("/repo/extensions/discord/openclaw.plugin.json", canonicalManifest),
    "plugin-manifest",
    "POSIX canonical OpenClaw plugin classification"
  );
  assertEqual(
    classifyManifest("C:\\repo\\extensions\\discord\\openclaw.plugin.json", canonicalManifest),
    "plugin-manifest",
    "Windows canonical OpenClaw plugin classification"
  );
  assertEqual(
    classifyManifest("C:\\repo\\extensions\\dashboard\\manifest.json", { openclawExtension: true }),
    "extension-manifest",
    "Windows extension path classification"
  );

  const candidates = Array.from({ length: 302 }, (_, index) =>
    `/repo/extensions/plugin-${String(index).padStart(3, "0")}/openclaw.plugin.json`
  );
  const forward = selectManifestCandidates(candidates);
  const reversed = selectManifestCandidates([...candidates].reverse());
  assertEqual(forward.length, 300, "manifest candidate cap");
  assertEqual(
    forward.join("\n"),
    reversed.join("\n"),
    "manifest candidate selection is discovery-order independent"
  );
  assertEqual(forward.at(0), candidates[0], "manifest candidate sort first item");
  assertEqual(forward.at(-1), candidates[299], "manifest candidate sort capped last item");

  return {
    id: "inventory-manifest-contracts",
    status: "PASS",
    command: "inline self-check",
    durationMs: 0
  };
}

export async function inventoryPlanCheck(tmp) {
  const binDir = join(tmp, "inventory-bin");
  const repoDir = join(tmp, "inventory-openclaw");
  const openclawBin = join(binDir, "openclaw");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(repoDir, "extensions", "discord"), { recursive: true });
  await mkdir(join(repoDir, "extensions", "dashboard"), { recursive: true });
  await mkdir(join(repoDir, "src", "channels", "message"), { recursive: true });
  await writeFile(openclawBin, `#!/bin/sh
case "$1" in
  --help)
    cat <<'HELP'
Usage: openclaw <command>

Commands:
  Hint: commands suffixed with * have subcommands.
  dashboard  Start dashboard
  plugins *  Manage plugins
  unknownx   Experimental command
HELP
    ;;
  dashboard)
    echo "OpenClaw dashboard help"
    ;;
  plugins)
    echo "OpenClaw plugins help"
    ;;
  unknownx)
    echo "OpenClaw unknownx help"
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 2
    ;;
esac
`, "utf8");
  await chmod(openclawBin, 0o755);
  await writeFile(join(repoDir, "package.json"), `${JSON.stringify({
    name: "openclaw",
    scripts: {
      "audit:internal": "node scripts/internal-audit.mjs",
      build: "pnpm build",
      "release:check": "node scripts/release-check.mjs"
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(repoDir, "extensions", "discord", "openclaw.plugin.json"), `{
  // OpenClaw accepts authored JSON5 plugin manifests.
  id: "discord",
  name: "Discord",
  description: "OpenClaw-style channel plugin manifest",
  channels: ["discord"],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
}
`, "utf8");
  await writeFile(join(repoDir, "extensions", "dashboard", "manifest.json"), `${JSON.stringify({
    name: "dashboard",
    description: "Dashboard extension",
    openclawExtension: true
  }, null, 2)}\n`, "utf8");
  await writeFile(join(repoDir, "src", "channels", "message", "types.ts"), `export const durableFinalDeliveryCapabilities = [
  "text",
  "media",
  "poll",
  "payload",
  "silent",
  "replyTo",
  "thread",
  "nativeQuote",
  "messageSendingHooks",
  "batch",
  "reconcileUnknownSend",
  "afterSendSuccess",
  "afterCommit"
] as const;

export const channelMessageLiveCapabilities = [
  "draftPreview",
  "previewFinalization",
  "progressUpdates",
  "nativeStreaming",
  "quietFinalization"
] as const;

export const livePreviewFinalizerCapabilities = [
  "finalEdit",
  "normalFallback",
  "discardPending",
  "previewReceipt",
  "retainOnAmbiguousFailure"
] as const;

export const channelMessageReceiveAckPolicies = [
  "after_receive_record",
  "after_agent_dispatch",
  "after_durable_send",
  "manual"
] as const;
`, "utf8");

  return jsonCommandCheck(
    "inventory-plan-json",
    `node bin/kova.mjs inventory plan --openclaw-bin ${quoteShell(openclawBin)} --openclaw-repo ${quoteShell(repoDir)} --require-modeled cli:unknownx --json`,
    (data) => {
      assertEqual(data.schemaVersion, "kova.inventory.plan.v1", "inventory schema");
      assertEqual(data.sources?.find((source) => source.id === "openclaw-help")?.status, "scanned", "inventory help source");
      assertEqual(data.sources?.find((source) => source.id === "package-scripts")?.status, "scanned", "inventory package source");
      assertEqual(data.sources?.find((source) => source.id === "manifests")?.status, "scanned", "inventory manifests source");
      assertEqual(data.sources?.find((source) => source.id === "channel-capability-catalog")?.status, "matched", "inventory channel capability source catalog");
      assertEqual(data.channelCapabilityCatalog?.ok, true, "inventory channel capability catalog source comparison");
      assertEqual(data.sources?.find((source) => source.id === "package-scripts")?.includedScriptCount, 1, "inventory product script filter");
      assertEqual(data.capabilities?.some((capability) => capability.id === "cli:dashboard" && capability.matchedSurfaceIds?.includes("dashboard")), true, "dashboard command mapped");
      assertEqual(data.capabilities?.some((capability) => capability.id === "cli:Hint"), false, "help parser ignores help prose");
      assertEqual(data.capabilities?.some((capability) => capability.id === "cli:unknownx" && capability.matchStatus === "unmodeled"), true, "unknown command warning");
      assertEqual(data.capabilities?.some((capability) => capability.id === "script:release:check"), true, "product package scripts discovered");
      assertEqual(data.capabilities?.some((capability) => capability.id === "script:build"), false, "internal package scripts filtered");
      assertEqual(
        data.capabilities?.some((capability) =>
          capability.kind === "plugin-manifest" &&
          capability.path === "extensions/discord/openclaw.plugin.json"
        ),
        true,
        "canonical OpenClaw plugin manifest discovered"
      );
      assertEqual(data.capabilities?.some((capability) => capability.kind === "extension-manifest"), true, "extension manifest discovered");
      assertEqual((data.coverage?.warnings ?? []).some((warning) => warning.capability === "cli:unknownx"), true, "unmodeled warning emitted");
      assertEqual(data.coverage?.ok, false, "required unmodeled capability blocks inventory coverage");
      assertEqual((data.coverage?.blockers ?? []).some((blocker) => blocker.capability === "cli:unknownx"), true, "required unmodeled blocker emitted");
    }
  );
}

export async function repeatedWorkAuditCheck() {
  const audit = await buildRepeatedWorkAudit();
  const freshAudit = await buildRepeatedWorkAudit();
  assertEqual(audit.schemaVersion, "kova.repeatedWorkAudit.v1", "repeated work audit schema");
  assertEqual(audit.scenarioCount > 0, true, "repeated work audit scenarios");
  assertEqual(audit.phaseCount > 0, true, "repeated work audit phases");
  assertEqual(
    Object.values(audit.profiles).some((profile) => profile.minimumCollectEnvMetrics > profile.entries),
    true,
    "repeated work audit profile collector floor"
  );
  assertEqual(
    audit.duplicateCommands.some((entry) => entry.command === "ocm @{env} -- status" && entry.count > 1),
    true,
    "repeated work audit duplicate status command"
  );
  const allowedExplicitEvidenceScenarios = new Set([
    "adversarial-input-openai-compatible",
    "agent-provider-protocol-failure",
    "agent-provider-random-disconnect",
    "cron-runtime",
    "dirty-plugin-state",
    "exec-tool-safety",
    "mcp-tool-call",
    "plugin-legacy-unsafe-memory",
    "release-update-recovery",
    "tool-failure-containment"
  ]);
  assertEqual(
    audit.explicitEvidenceCommands.every((entry) => allowedExplicitEvidenceScenarios.has(entry.scenario)),
    true,
    "repeated work audit explicit evidence commands are limited to failure-state scenarios"
  );
  assertEqual(
    audit.commandReceiptLocks.some((lock) => lock.scenario === "release-runtime-startup"),
    false,
    "repeated work audit release receipt lock removed"
  );
  assertEqual(
    audit.commandReceiptLocks.some((lock) => lock.scenario === "official-plugin-install"),
    false,
    "repeated work audit official plugin receipt lock removed"
  );
  assertEqual(
    audit.commandReceiptLocks.length,
    0,
    "repeated work audit command receipt locks empty"
  );
  audit.commandReceiptLocks.push({ scenario: "mutation-probe" });
  assertEqual(audit.commandReceiptLocks === freshAudit.commandReceiptLocks, false, "repeated work audit receipt locks are fresh");
  assertEqual(freshAudit.commandReceiptLocks.length, 0, "repeated work audit receipt locks do not leak mutations");
  return {
    id: "repeated-work-audit",
    status: "PASS"
  };
}
