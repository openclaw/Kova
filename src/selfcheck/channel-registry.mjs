import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { evaluateWorkflowCase } from "../../support/channel-conformance/evaluator.mjs";
import { assertValidObservationSet } from "../../support/channel-conformance/observation-schema.mjs";
import { planWorkflowCases } from "../../support/channel-conformance/planner.mjs";
import { channelPlatformsDir } from "../paths.mjs";
import {
  loadChannelCapabilities,
  validateChannelCapabilityCatalogReferences,
  validateChannelCapabilityShape,
  validateChannelCapabilityWorkflowReferences,
  validateChannelProofPolicyReferences
} from "../registries/channel-capabilities.mjs";
import {
  loadChannelCapabilityCatalog,
  validateChannelCapabilityCatalogShape
} from "../registries/channel-capability-catalog.mjs";
import {
  loadChannelWorkflowCaseCatalog,
  validateChannelWorkflowCaseCatalogReferences,
  validateChannelWorkflowCaseCatalogShape,
  validateChannelWorkflowCaseInventoryReferences
} from "../registries/channel-workflow-cases.mjs";
import {
  workflowCaseCatalogFromFamilies,
  workflowInventoryFromFamilies
} from "../registries/channel-workflow-families.mjs";
import {
  loadChannelWorkflowInventory,
  validateChannelWorkflowInventoryReferences
} from "../registries/channel-workflow-inventory.mjs";
import { assertArrayNotEmpty, assertEqual } from "./harness.mjs";

export async function channelCapabilityRegistryCheck() {
  try {
    const catalogs = await loadChannelCapabilityCatalog();
    const workflowInventories = await loadChannelWorkflowInventory();
    const workflowCatalogs = await loadChannelWorkflowCaseCatalog();
    const openClawCatalog = catalogs.find((catalog) => catalog.id === "openclaw-message");
    assertEqual(Boolean(openClawCatalog), true, "OpenClaw message capability catalog present");
    assertOpenClawChannelCapabilityCatalog(openClawCatalog);
    validateChannelCapabilityCatalogReferences(await loadChannelCapabilities(), catalogs);
    validateChannelWorkflowInventoryReferences(workflowInventories, catalogs);
    validateChannelWorkflowCaseCatalogReferences(workflowCatalogs, catalogs);
    validateChannelWorkflowCaseInventoryReferences(workflowCatalogs, workflowInventories);
    const workflowInventory = workflowInventories.find((inventory) => inventory.id === "openclaw-channel-workflow-inventory");
    assertEqual(Boolean(workflowInventory), true, "OpenClaw channel workflow inventory present");
    const completionHandoff = workflowInventory?.workflows?.find((workflow) => workflow.id === "completion-handoff");
    assertEqual(Boolean(completionHandoff), true, "completion handoff workflow inventory present");
    assertEqual(completionHandoff?.deliveryModes?.includes("completion-handoff"), true, "completion handoff declares delivery mode");
    assertEqual(completionHandoff?.atoms?.some((atom) => atom.group === "workflow" && atom.id === "background-artifact-completion"), true, "completion handoff maps to background completion atom");

    const channels = await loadChannelCapabilities();
    await assertRawChannelPlatformFilesArePlatformOnly();
    validateChannelCapabilityWorkflowReferences(channels, workflowCatalogs);
    const workflowCatalog = workflowCatalogs.find((catalog) => catalog.id === "openclaw-channel-workflow-cases");
    assertEqual(Boolean(workflowCatalog), true, "OpenClaw channel workflow case catalog present");
    const sourceMediaCase = workflowCatalog?.cases?.find((testCase) => testCase.id === "source-visible-delivery.media.message-tool-only");
    assertEqual(Boolean(sourceMediaCase), true, "source visible media workflow case present");
    assertEqual(sourceMediaCase?.inventoryWorkflow, "source-visible-delivery", "source media workflow case maps to inventory workflow");
    assertEqual(sourceMediaCase?.matrix?.delivery, "message-tool-only-source-delivery", "source media workflow case declares matrix delivery mode");
    assertEqual(sourceMediaCase?.atoms?.some((atom) => atom.group === "workflow" && atom.id === "source-visible-delivery"), true, "source media workflow declares source delivery atom");
    const nativePollCase = workflowCatalog?.cases?.find((testCase) => testCase.id === "native-action.poll");
    assertEqual(Boolean(nativePollCase), true, "native poll workflow case present");
    let rejectedNativeCalls = false;
    try {
      validateChannelWorkflowCaseCatalogShape({
        schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
        id: "bad-native-calls",
        title: "Bad Native Calls",
        description: "Bad native call shape.",
        cases: [{
          ...nativePollCase,
          expects: {
            ...nativePollCase.expects,
            nativeActions: undefined,
            nativeCalls: { sendPoll: 1 }
          }
        }]
      }, "bad-native-calls.json");
    } catch (error) {
      rejectedNativeCalls = /nativeCalls must not be used/.test(error.message);
    }
    assertEqual(rejectedNativeCalls, true, "workflow cases reject platform method expectations");

    let rejectedPlatformNamedUserFlow = false;
    try {
      validateChannelWorkflowCaseCatalogShape({
        schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
        id: "bad-platform-named-user-flow",
        title: "Bad Platform Named User Flow",
        description: "Bad platform named user flow shape.",
        cases: [{
          ...nativePollCase,
          userAction: "user asks OpenClaw to create a Telegram poll in the current chat"
        }]
      }, "bad-platform-named-user-flow.json");
    } catch (error) {
      rejectedPlatformNamedUserFlow = /must be platform-neutral/.test(error.message);
    }
    assertEqual(rejectedPlatformNamedUserFlow, true, "workflow user-facing text rejects platform-specific names");

    let rejectedUnknownNativeAction = false;
    try {
      validateChannelWorkflowCaseCatalogShape({
        schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
        id: "bad-native-action",
        title: "Bad Native Action",
        description: "Bad native action shape.",
        cases: [{
          ...nativePollCase,
          expects: {
            ...nativePollCase.expects,
            nativeActions: { "action-delete": 1 }
          }
        }]
      }, "bad-native-action.json");
    } catch (error) {
      rejectedUnknownNativeAction = /must match a native-platform atom/.test(error.message);
    }
    assertEqual(rejectedUnknownNativeAction, true, "workflow native action expectations must match declared atoms");
    const telegram = channels.find((channel) => channel.id === "telegram");
    assertEqual(Boolean(telegram), true, "telegram channel capability registry present");
    assertEqual(telegram.adapterId, "telegram", "telegram adapter id");
    assertEqual(telegram.supportStatus, "supported", "telegram support status");
    assertArrayNotEmpty(telegram.declarationSources, "telegram declaration sources");
    assertEqual(telegram.capabilities.some((capability) =>
      capability.group === "durable-final" && capability.id === "media" && capability.requiredLevel === "blocking"
    ), true, "telegram media capability is blocking");
    assertEqual(telegram.capabilities.every((capability) =>
      telegram.declarationSources.includes(capability.declarationSource)
    ), true, "telegram capability declaration sources reference registry sources");
    assertEqual(telegram.capabilities.every((capability) =>
      capability.catalogId === `${capability.group}:${capability.id}`
    ), true, "telegram capabilities reference OpenClaw catalog ids");
    assertEqual(
      telegram.capabilities.every((capability) => capability.title !== capability.catalogId),
      true,
      "channel capability titles resolve from the OpenClaw catalog"
    );
    assertEqual(telegram.workflowCaseIds?.includes("source-visible-delivery.media.message-tool-only"), true, "telegram maps to shared source media workflow case");
    assertEqual(telegram.workflowCoverage?.schemaVersion, "kova.channelWorkflowCoverage.v1", "telegram exposes derived workflow coverage");
    assertEqual(telegram.workflowCoverage?.selectedCount, telegram.workflowCaseIds?.length, "telegram workflow coverage selected count matches selected case ids");
    assertEqual(telegram.workflowCoverage?.selected?.some((row) => row.id === "native-action.poll"), true, "telegram workflow coverage includes selected native poll flow");
    assertEqual(telegram.workflowCoverage?.skipped?.every((row) => typeof row.reason === "string" && row.reason.length > 0), true, "telegram skipped workflow coverage explains every skipped flow");
    const workflowCasesById = new Map((workflowCatalog?.cases ?? []).map((testCase) => [testCase.id, testCase]));
    const telegramCoverageWithDriverSkip = planWorkflowCases({
      channelRegistry: telegram,
      workflowCatalog,
      caseSet: "declared-workflows",
      driver: {
        canDriveWorkflowCase({ workflowCase }) {
          return workflowCase.id === "native-action.poll"
            ? { supported: false, reason: "poll enqueue is not implemented by this driver" }
            : { supported: true, reason: null };
        }
      }
    });
    assertEqual(telegramCoverageWithDriverSkip.skipped.some((row) =>
      row.id === "native-action.poll" && row.reason === "driver support: poll enqueue is not implemented by this driver"
    ), true, "workflow coverage reports driver support skips");
    const telegramWorkflowAtoms = new Set((telegram.workflowCaseIds ?? []).flatMap((caseId) =>
      (workflowCasesById.get(caseId)?.atoms ?? [])
        .filter((atom) => atom.group !== "workflow")
        .map((atom) => `${atom.group}:${atom.id}`)
    ));
    assertEqual(telegram.capabilities
      .filter((capability) => capability.requiredLevel === "blocking")
      .every((capability) => telegramWorkflowAtoms.has(`${capability.group}:${capability.id}`)),
    true, "telegram blocking capabilities have declared workflow proof");
    assertChannelObservationLogicalNativeBoundary();

    let rejectedGroup = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-channel",
        title: "Bad Channel",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "made-up-group",
          catalogId: "made-up-group:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/bad/src/channel.ts"
        }]
      }, "bad-channel.json");
    } catch (error) {
      rejectedGroup = /group must be one of/.test(error.message);
    }
    assertEqual(rejectedGroup, true, "unknown channel capability group rejected");

    let rejectedProofMode = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-proof-mode",
        title: "Bad Proof Mode",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["eventually"],
          declarationSource: "extensions/bad/src/channel.ts"
        }]
      }, "bad-proof-mode.json");
    } catch (error) {
      rejectedProofMode = /proofModes\[0\] must be one of/.test(error.message);
    }
    assertEqual(rejectedProofMode, true, "unknown channel capability proof mode rejected");

    let rejectedSource = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-source",
        title: "Bad Source",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/other/src/channel.ts"
        }]
      }, "bad-source.json");
    } catch (error) {
      rejectedSource = /declarationSource must reference declarationSources/.test(error.message);
    }
    assertEqual(rejectedSource, true, "unknown capability declaration source rejected");

    let rejectedDuplicate = false;
    try {
      validateChannelCapabilityShape({
        schemaVersion: "kova.channelCapability.v1",
        id: "bad-duplicate",
        title: "Bad Duplicate",
        adapterId: "bad",
        supportStatus: "supported",
        declarationSources: ["extensions/bad/src/channel.ts"],
        capabilities: [{
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text",
          requiredLevel: "blocking",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/bad/src/channel.ts"
        }, {
          id: "text",
          group: "durable-final",
          catalogId: "durable-final:text",
          title: "Text Again",
          requiredLevel: "warning",
          proofModes: ["deterministic-shim"],
          declarationSource: "extensions/bad/src/channel.ts"
        }]
      }, "bad-duplicate.json");
    } catch (error) {
      rejectedDuplicate = /duplicate capability/.test(error.message);
    }
    assertEqual(rejectedDuplicate, true, "duplicate channel capability rejected");

    let rejectedCatalogReference = false;
    try {
      validateChannelCapabilityCatalogReferences([{
        ...telegram,
        capabilities: [{
          id: "imaginary",
          group: "durable-final",
          catalogId: "durable-final:imaginary"
        }]
      }], catalogs);
    } catch (error) {
      rejectedCatalogReference = /not defined in the OpenClaw channel capability catalog/.test(error.message);
    }
    assertEqual(rejectedCatalogReference, true, "channel capability must reference OpenClaw catalog");

    let rejectedCatalogCollision = false;
    try {
      validateChannelCapabilityCatalogReferences([], [
        {
          id: "first-catalog",
          capabilities: [{ id: "text", group: "durable-final" }]
        },
        {
          id: "second-catalog",
          capabilities: [{ id: "text", group: "durable-final" }]
        }
      ]);
    } catch (error) {
      rejectedCatalogCollision = /across catalogs 'first-catalog' and 'second-catalog'/.test(error.message);
    }
    assertEqual(rejectedCatalogCollision, true, "cross-catalog capability collisions are rejected");

    for (const field of ["blockingCapabilities", "liveSmokeCapabilities"]) {
      let rejectedProofPolicyReference = false;
      try {
        validateChannelProofPolicyReferences({
          [field]: ["durable-final:imaginary"]
        }, catalogs);
      } catch (error) {
        rejectedProofPolicyReference = new RegExp(`${field} references unknown channel capability`).test(error.message);
      }
      assertEqual(rejectedProofPolicyReference, true, `${field} must reference OpenClaw catalog capabilities`);
    }

    const duplicateFamily = {
      id: "duplicate-family",
      title: "Duplicate Family",
      userAction: "user sends a message",
      openclawSurface: "message delivery",
      ownerArea: "channels",
      sourceRefs: ["src/channels/message/types.ts#L1"],
      contentKinds: ["text"],
      routeKinds: ["direct"],
      deliveryModes: ["final"],
      lifecycles: ["success"],
      atoms: [{ group: "durable-final", id: "text" }],
      cases: [{
        id: "duplicate.case",
        workflow: "duplicate-family",
        userAction: "user sends a message",
        openclawSurface: "message delivery",
        prompt: "reply with a short message",
        providerScript: {},
        expects: {},
        matrix: {
          content: "text",
          route: "direct",
          delivery: "final",
          lifecycle: "success"
        },
        atoms: [{ group: "durable-final", id: "text" }]
      }]
    };
    let rejectedDerivedInventory = false;
    try {
      workflowInventoryFromFamilies([duplicateFamily, duplicateFamily]);
    } catch (error) {
      rejectedDerivedInventory = /duplicate channel workflow inventory workflow/.test(error.message);
    }
    assertEqual(rejectedDerivedInventory, true, "derived workflow inventories validate duplicate family ids");

    let rejectedDerivedCaseCatalog = false;
    try {
      workflowCaseCatalogFromFamilies([duplicateFamily, {
        ...duplicateFamily,
        id: "other-family"
      }]);
    } catch (error) {
      rejectedDerivedCaseCatalog = /duplicate channel workflow case/.test(error.message);
    }
    assertEqual(rejectedDerivedCaseCatalog, true, "derived workflow case catalogs validate duplicate case ids");

    let rejectedWorkflowCaseReference = false;
    try {
      validateChannelCapabilityWorkflowReferences([{
        ...telegram,
        workflowCaseIds: ["imaginary-workflow-case"]
      }], workflowCatalogs);
    } catch (error) {
      rejectedWorkflowCaseReference = /unknown channel workflow case/.test(error.message);
    }
    assertEqual(rejectedWorkflowCaseReference, true, "channel workflow case references must exist");

    let rejectedUnsupportedWorkflowAtom = false;
    try {
      validateChannelCapabilityWorkflowReferences([{
        ...telegram,
        workflowCaseIds: ["text-final"]
      }], workflowCatalogs);
    } catch (error) {
      rejectedUnsupportedWorkflowAtom = /requires unsupported adapter atom/.test(error.message);
    }
    assertEqual(rejectedUnsupportedWorkflowAtom, true, "channel workflow case references must match adapter atoms");

    let rejectedMissingBlockingWorkflowProof = false;
    try {
      validateChannelCapabilityWorkflowReferences([{
        ...telegram,
        capabilities: telegram.capabilities.map((capability) =>
          capability.group === "durable-final" && capability.id === "payload"
            ? { ...capability, requiredLevel: "blocking" }
            : capability
        ),
        workflowCaseIds: telegram.workflowCaseIds.filter((caseId) => caseId !== "source-visible-delivery.payload.message-tool-only")
      }], workflowCatalogs);
    } catch (error) {
      rejectedMissingBlockingWorkflowProof = /blocking but has no declared runtime workflow proof/.test(error.message);
    }
    assertEqual(rejectedMissingBlockingWorkflowProof, true, "blocking channel capabilities require workflow proof");

    return {
      id: "channel-capability-registry",
      status: "PASS",
      command: "validate channel capability registry contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "channel-capability-registry",
      status: "FAIL",
      command: "validate channel capability registry contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

async function assertRawChannelPlatformFilesArePlatformOnly() {
  const forbiddenKeys = [
    "adapterDistribution",
    "adapterId",
    "claims",
    "declarationSources",
    "deterministicShim",
    "proofModes",
    "requiredLevel",
    "supportStatus",
    "workflowCaseIds",
    "workflowOverrides"
  ];
  const names = (await readdir(channelPlatformsDir)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const platform = JSON.parse(await readFile(join(channelPlatformsDir, name), "utf8"));
    assertEqual(Boolean(platform.adapter), true, `${name} declares adapter facts`);
    assertEqual(Boolean(platform.capabilities && typeof platform.capabilities === "object" && !Array.isArray(platform.capabilities)), true, `${name} declares compact implemented capabilities`);
    for (const key of forbiddenKeys) {
      assertEqual(Object.hasOwn(platform, key), false, `${name} does not declare Kova/test policy key ${key}`);
    }
    assertEqual((platform.sources ?? []).includes("src/channels/message/types.ts"), false, `${name} does not declare generic OpenClaw contract as a platform source`);
  }
}

function assertOpenClawChannelCapabilityCatalog(catalog) {
  validateChannelCapabilityCatalogShape(catalog, "openclaw-message.json");
  const byGroup = new Map();
  for (const capability of catalog.capabilities ?? []) {
    const values = byGroup.get(capability.group) ?? [];
    values.push(capability.id);
    byGroup.set(capability.group, values);
  }

  assertEqual(
    JSON.stringify(byGroup.get("durable-final") ?? []),
    JSON.stringify([
      "text",
      "media",
      "poll",
      "payload",
      "silent",
      "reply-to",
      "thread",
      "native-quote",
      "message-sending-hooks",
      "batch",
      "reconcile-unknown-send",
      "after-send-success",
      "after-commit"
    ]),
    "OpenClaw durable-final capability catalog matches src/channels/message/types.ts"
  );
  assertEqual(
    JSON.stringify(byGroup.get("live-preview") ?? []),
    JSON.stringify([
      "draft-preview",
      "preview-finalization",
      "progress-updates",
      "native-streaming",
      "quiet-finalization"
    ]),
    "OpenClaw live-preview capability catalog matches src/channels/message/types.ts"
  );
  assertEqual(
    JSON.stringify(byGroup.get("live-finalizer") ?? []),
    JSON.stringify([
      "final-edit",
      "normal-fallback",
      "discard-pending",
      "preview-receipt",
      "retain-on-ambiguous-failure"
    ]),
    "OpenClaw live-finalizer capability catalog matches src/channels/message/types.ts"
  );
  assertEqual(
    JSON.stringify(byGroup.get("ack") ?? []),
    JSON.stringify([
      "after-receive-record",
      "after-agent-dispatch",
      "after-durable-send",
      "manual"
    ]),
    "OpenClaw ack policy catalog matches src/channels/message/types.ts"
  );
}

function assertChannelObservationLogicalNativeBoundary() {
  const workflowCase = {
    id: "selfcheck.media-logical-delivery",
    expects: {
      visibleDeliveries: 1,
      kind: "media",
      text: "KOVA_AGENT_MEDIA_OK",
      mediaSource: "/tmp/kova-selfcheck-media.png",
      mediaSourcePolicy: "exact"
    }
  };
  const observations = {
    schemaVersion: "kova.channelObservationSet.v1",
    channelId: "selfcheck",
    inbound: {
      route: {
        key: "room-1"
      },
      messageKey: "msg-1"
    },
    deliveries: [{
      schemaVersion: "kova.channelObservation.v1",
      channelId: "selfcheck",
      actor: "bot",
      visible: true,
      kind: "media",
      text: "KOVA_AGENT_MEDIA_OK",
      caption: null,
      route: {
        kind: "direct",
        key: "room-1",
        parentKey: null
      },
      replyTo: {
        present: false,
        key: null
      },
      delivery: {
        id: "native-1",
        receiptPresent: true,
        status: "sent"
      },
      media: [{
        kind: "image",
        present: true,
        source: "upload",
        sourceName: "kova-selfcheck-media.png",
        sourceRef: "[file:kova-selfcheck-media.png]"
      }],
      silent: false,
      timestampMs: 1,
      nativeMessages: [{
        channelId: "selfcheck",
        method: "sendMedia",
        path: "/messages",
        deliveryId: "native-1",
        status: "sent",
        visible: true,
        timestampMs: 1,
        raw: {}
      }]
    }],
    unmatchedNativeMessages: [],
    nativeCallSummary: {
      count: 1,
      nativeVisibleDeliveryCount: 1,
      logicalDeliveryCount: 1,
      byMethod: {
        sendMedia: 1
      },
      byAction: {}
    }
  };
  assertValidObservationSet(observations, { caseId: workflowCase.id });
  const invariants = evaluateWorkflowCase({
    workflowCase,
    observations,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  });
  assertEqual(invariants.every((invariant) => invariant.status === "passed"), true, "logical channel delivery keeps native message proof without overrides");

  const withUnmatchedNativeSend = {
    ...observations,
    unmatchedNativeMessages: [{
      channelId: "selfcheck",
      method: "sendMedia",
      path: "/messages",
      deliveryId: "native-extra",
      status: "sent",
      visible: true,
      timestampMs: 2,
      raw: {}
    }]
  };
  assertValidObservationSet(withUnmatchedNativeSend, { caseId: workflowCase.id });
  const unmatchedInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withUnmatchedNativeSend,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(unmatchedInvariant?.status, "failed", "unmatched native visible sends fail generic channel evaluation");

  const withNativeCompanionText = {
    ...observations,
    unmatchedNativeMessages: [{
      channelId: "selfcheck",
      method: "sendMessage",
      path: "/messages",
      deliveryId: "native-companion",
      status: "sent",
      visible: true,
      timestampMs: 2,
      raw: {
        body: {
          text: "KOVA_AGENT_MEDIA_OK"
        }
      }
    }]
  };
  assertValidObservationSet(withNativeCompanionText, { caseId: workflowCase.id });
  const companionTextInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withNativeCompanionText,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(companionTextInvariant?.status, "passed", "media workflows allow one native companion text send matching the expected response text");

  const messageToolTextWorkflowCase = {
    ...workflowCase,
    expects: {
      ...workflowCase.expects,
      text: undefined
    },
    providerScript: {
      completionToolCalls: [{
        name: "message",
        arguments: {
          action: "send",
          message: "KOVA_AGENT_MEDIA_OK"
        }
      }]
    }
  };
  const derivedCompanionTextInvariant = evaluateWorkflowCase({
    workflowCase: messageToolTextWorkflowCase,
    observations: withNativeCompanionText,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(derivedCompanionTextInvariant?.status, "passed", "media workflows derive companion text proof from scripted message-tool sends");

  const withUnexpectedCompanion = {
    ...observations,
    deliveries: [
      ...observations.deliveries,
      {
        schemaVersion: "kova.channelObservation.v1",
        channelId: "selfcheck",
        actor: "bot",
        visible: true,
        kind: "text",
        text: "unexpected extra text",
        caption: null,
        route: {
          kind: "direct",
          key: "room-1",
          parentKey: null
        },
        replyTo: {
          present: false,
          key: null
        },
        delivery: {
          id: "native-extra-visible",
          receiptPresent: true,
          status: "sent"
        },
        media: [],
        silent: false,
        timestampMs: 3,
        nativeMessages: [{
          channelId: "selfcheck",
          method: "sendMessage",
          path: "/messages",
          deliveryId: "native-extra-visible",
          status: "sent",
          visible: true,
          timestampMs: 3,
          raw: {}
        }]
      }
    ]
  };
  assertValidObservationSet(withUnexpectedCompanion, { caseId: workflowCase.id });
  const unexpectedVisibleInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withUnexpectedCompanion,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":unmatched-native-visible-sends"));
  assertEqual(unexpectedVisibleInvariant?.status, "failed", "unexpected visible companion sends fail generic channel evaluation");

  const withWrongMediaSource = {
    ...observations,
    deliveries: observations.deliveries.map((delivery) => ({
      ...delivery,
      media: delivery.media.map((media) => ({
        ...media,
        sourceName: "wrong-media.png",
        sourceRef: "[file:wrong-media.png]"
      }))
    }))
  };
  const mediaSourceInvariant = evaluateWorkflowCase({
    workflowCase,
    observations: withWrongMediaSource,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":media-source"));
  assertEqual(mediaSourceInvariant?.status, "failed", "wrong exact media source fails generic channel evaluation");

  const fingerprintWorkflowCase = {
    ...workflowCase,
    id: "selfcheck.media-fingerprint-delivery",
    expects: {
      ...workflowCase.expects,
      mediaSource: "/tmp/kova-fingerprint-source.png",
      mediaSourceProofs: [{
        source: "/tmp/kova-fingerprint-source.png",
        fingerprint: "png:1x1:ct6:bd8:filter0:first=abcdef01"
      }]
    }
  };
  const withFingerprintSource = {
    ...observations,
    deliveries: observations.deliveries.map((delivery) => ({
      ...delivery,
      media: delivery.media.map((media) => ({
        ...media,
        sourceName: null,
        sourceRef: "attach://kova-upload",
        sourceFingerprint: "png:1x1:ct6:bd8:filter0:first=abcdef01"
      }))
    }))
  };
  const fingerprintInvariant = evaluateWorkflowCase({
    workflowCase: fingerprintWorkflowCase,
    observations: withFingerprintSource,
    providerRequestsDelta: 1,
    providerRequestsAfterEcho: 0
  }).find((invariant) => invariant.id.endsWith(":media-source"));
  assertEqual(fingerprintInvariant?.status, "passed", "exact media source can be proven by upload media fingerprint");
}
