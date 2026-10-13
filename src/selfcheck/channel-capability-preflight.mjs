import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../paths.mjs";
import { assertEqual, inlineCheck } from "./harness.mjs";

// Stand-in for the one plugin-sdk subpath the preflight imports, with the
// contract verifiers as OpenClaw exports them from channel-outbound (they left
// channel-message in 2026.8.1, and the subpath itself is gone since
// openclaw/openclaw#162333). Any other subpath is absent, so the old import fails
// with "does not export". This keeps the preflight on that import list and on
// the verifier result shape; it does not follow later changes to OpenClaw's
// capability lists, which the channel-capability-preflight scenario run covers.
const channelOutbound = `
const durableFinalDeliveryCapabilities = ["text", "media", "poll", "payload", "silent", "replyTo", "thread",
  "nativeQuote", "messageSendingHooks", "batch", "reconcileUnknownSend", "afterSendSuccess", "afterCommit"];
const channelMessageLiveCapabilities = ["draftPreview", "previewFinalization", "progressUpdates", "nativeStreaming",
  "quietFinalization"];
const livePreviewFinalizerCapabilities = ["finalEdit", "normalFallback", "discardPending", "previewReceipt",
  "retainOnAmbiguousFailure"];
const channelMessageReceiveAckPolicies = ["after_receive_record", "after_agent_dispatch", "after_durable_send", "manual"];

async function verifyContractProofs({ keys, isDeclared, proofs, missingProofError, result }) {
  const results = [];
  for (const key of keys) {
    if (!isDeclared(key)) {
      results.push(result(key, "not_declared"));
      continue;
    }
    if (!proofs[key]) throw new Error(missingProofError(key));
    await proofs[key]();
    results.push(result(key, "verified"));
  }
  return results;
}

const capabilityProofs = (keys, name, capabilities, proofs) => verifyContractProofs({
  keys,
  isDeclared: (key) => capabilities?.[key] === true,
  proofs,
  missingProofError: (key) => name + " declares " + key + " without a contract proof",
  result: (capability, status) => ({ capability, status })
});

export const verifyDurableFinalCapabilityProofs = ({ adapterName, capabilities, proofs }) =>
  capabilityProofs(durableFinalDeliveryCapabilities, adapterName, capabilities, proofs);
export const verifyChannelMessageLiveCapabilityAdapterProofs = ({ adapterName, adapter, proofs }) =>
  capabilityProofs(channelMessageLiveCapabilities, adapterName, adapter.live?.capabilities, proofs);
export const verifyChannelMessageLiveFinalizerProofs = ({ adapterName, adapter, proofs }) =>
  capabilityProofs(livePreviewFinalizerCapabilities, adapterName, adapter.live?.finalizer?.capabilities, proofs);
export async function verifyChannelMessageReceiveAckPolicyAdapterProofs({ adapterName, adapter, proofs }) {
  const receive = adapter.receive;
  const declared = new Set(receive?.supportedAckPolicies?.length
    ? receive.supportedAckPolicies
    : receive?.defaultAckPolicy ? [receive.defaultAckPolicy] : []);
  return verifyContractProofs({
    keys: channelMessageReceiveAckPolicies,
    isDeclared: (policy) => declared.has(policy),
    proofs,
    missingProofError: (policy) => adapterName + " declares receive ack policy " + policy + " without a contract proof",
    result: (policy, status) => ({ policy, status })
  });
}
`;

export async function channelCapabilityPreflightLoadCheck(tmp) {
  return inlineCheck("channel-capability-preflight-load", async () => {
    const root = join(tmp, "channel-capability-preflight-load");
    const packageRoot = join(root, "node_modules", "openclaw");
    const artifactDir = join(root, "artifacts");
    await mkdir(join(packageRoot, "plugin-sdk"), { recursive: true });
    await writeFile(join(packageRoot, "plugin-sdk", "channel-outbound.js"), channelOutbound);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/channel-outbound": "./plugin-sdk/channel-outbound.js" }
    }));

    const env = { ...process.env };
    delete env.KOVA_OCM_TRANSPORT_JSON;
    const result = spawnSync(process.execPath, [
      join(repoRoot, "support", "run-channel-capability-preflight.mjs"),
      "--package-root", packageRoot,
      "--artifact-dir", artifactDir
    ], { cwd: repoRoot, env, encoding: "utf8", timeout: 30000 });
    const output = JSON.parse(result.stdout || "{}");
    const rows = output.capabilities ?? [];
    const notPassed = rows.filter((row) => row.status !== "passed");
    assertEqual(
      notPassed.map((row) => `${row.group}/${row.capabilityId}: ${row.status} ${row.reason}`).join("; "),
      "",
      "every preflight row passes"
    );
    assertEqual(result.status, 0, `preflight exit status (stderr: ${result.stderr.trim()})`);

    const catalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "openclaw-message.json"), "utf8"));
    const preflightIds = catalog.capabilities
      .filter((capability) => (capability.proofModes ?? []).includes("preflight"))
      .map((capability) => `${capability.group}/${capability.id}`);
    assertEqual(rows.map((row) => `${row.group}/${row.capabilityId}`).join(","), preflightIds.join(","), "one row per catalog preflight entry");

    const artifact = JSON.parse(await readFile(join(artifactDir, "channel-capability-preflight.json"), "utf8"));
    assertEqual(artifact.probe?.exportPath, join(packageRoot, "plugin-sdk", "channel-outbound.js"), "preflight imports channel-outbound");
  });
}
