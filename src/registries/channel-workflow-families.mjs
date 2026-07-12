import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelWorkflowFamiliesDir } from "../paths.mjs";
import {
  assertNoShapeErrors,
  requireArray,
  requireKebabId,
  requireObject,
  requireString,
  validateStringArray
} from "./validate.mjs";

export const channelWorkflowContentKinds = [
  "text",
  "media",
  "payload",
  "attachment",
  "image",
  "video",
  "audio",
  "batch",
  "error",
  "poll",
  "reaction",
  "topic",
  "presentation"
];

export const channelWorkflowRouteKinds = [
  "direct",
  "thread",
  "reply",
  "reply-thread",
  "bound-requester"
];

export const channelWorkflowDeliveryModes = [
  "final",
  "automatic-source-delivery",
  "message-tool-only-source-delivery",
  "background-completion",
  "completion-handoff",
  "live-preview",
  "live-finalizer",
  "ack",
  "native-action"
];

export const channelWorkflowLifecycles = [
  "success",
  "async-completion",
  "provider-failure",
  "ambiguous-send",
  "retry",
  "bot-echo",
  "terminal"
];

const forbiddenGenericUserFlowTerms = [
  "telegram",
  "discord",
  "slack",
  "mattermost",
  "whatsapp",
  "imessage",
  "zalo",
  "message_thread_id",
  "messageThreadId",
  "thread_ts",
  "root_id",
  "reply_parameters",
  "replyToMessageId",
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendPoll",
  "sendDocument",
  "getUpdates",
  "createForumTopic",
  "editForumTopic",
  "Bot API"
];

export async function loadChannelWorkflowFamilies(selectedId) {
  const names = await readdir(channelWorkflowFamiliesDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const families = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(channelWorkflowFamiliesDir, name), "utf8");
    const family = JSON.parse(raw);
    validateChannelWorkflowFamilyShape(family, name);
    if (ids.has(family.id)) {
      throw new Error(`duplicate channel workflow family id '${family.id}' in ${name}`);
    }
    ids.add(family.id);
    families.push(family);
  }

  const filtered = selectedId ? families.filter((family) => family.id === selectedId) : families;
  if (filtered.length === 0) {
    throw new Error(`no channel workflow family found for ${selectedId}`);
  }
  return filtered;
}

export function workflowInventoryFromFamilies(families) {
  const inventories = [{
    schemaVersion: "kova.channelWorkflowInventory.v1",
    id: "openclaw-channel-workflow-inventory",
    title: "OpenClaw Channel Workflow Inventory",
    description: "Source-derived inventory of user-shaped OpenClaw channel workflows that Kova should turn into executable workflow matrix rows.",
    declarationSources: uniqueSorted(families.flatMap((family) => sourcePaths(family.sourceRefs))),
    workflows: families.map((family) => ({
      id: family.id,
      title: family.title,
      userAction: family.userAction,
      openclawSurface: family.openclawSurface,
      ownerArea: family.ownerArea,
      sourceRefs: family.sourceRefs,
      contentKinds: family.contentKinds,
      routeKinds: family.routeKinds,
      deliveryModes: family.deliveryModes,
      lifecycles: family.lifecycles,
      atoms: family.atoms,
      ...(Array.isArray(family.unsupported) ? { unsupported: family.unsupported } : {})
    }))
  }];
  for (const inventory of inventories) {
    validateWorkflowInventoryCatalogShape(inventory, "derived channel workflow inventory");
  }
  return inventories;
}

export function workflowCaseCatalogFromFamilies(families) {
  const catalogs = [{
    schemaVersion: "kova.channelWorkflowCaseCatalog.v1",
    id: "openclaw-channel-workflow-cases",
    title: "OpenClaw Channel Workflow Cases",
    description: "Concrete user-shaped OpenClaw channel workflow cases derived from workflow families.",
    cases: families.flatMap((family) => (family.cases ?? []).map((testCase) => ({
      ...testCase,
      inventoryWorkflow: family.id,
      ownerArea: testCase.ownerArea ?? family.ownerArea
    })))
  }];
  for (const catalog of catalogs) {
    validateWorkflowCaseCatalogShape(catalog, "derived channel workflow case catalog");
  }
  return catalogs;
}

export function validateWorkflowInventoryCatalogShape(inventory, sourceName = "channel workflow inventory") {
  const errors = [];
  requireString(inventory, "schemaVersion", errors);
  if (inventory?.schemaVersion !== "kova.channelWorkflowInventory.v1") {
    errors.push("schemaVersion must be kova.channelWorkflowInventory.v1");
  }
  requireKebabId(inventory, "id", errors);
  requireString(inventory, "title", errors);
  requireString(inventory, "description", errors);
  validateStringArray(inventory?.declarationSources, "declarationSources", errors, { nonEmpty: true });
  requireArray(inventory, "workflows", errors);
  validateInventoryWorkflows(inventory, errors);
  assertNoShapeErrors(errors, sourceName);
}

export function validateWorkflowCaseCatalogShape(catalog, sourceName = "channel workflow case catalog") {
  const errors = [];
  requireString(catalog, "schemaVersion", errors);
  if (catalog?.schemaVersion !== "kova.channelWorkflowCaseCatalog.v1") {
    errors.push("schemaVersion must be kova.channelWorkflowCaseCatalog.v1");
  }
  requireKebabId(catalog, "id", errors);
  requireString(catalog, "title", errors);
  requireString(catalog, "description", errors);
  requireArray(catalog, "cases", errors);
  validateCatalogCases(catalog?.cases, errors);
  assertNoShapeErrors(errors, sourceName);
}

export function validateChannelWorkflowFamilyShape(family, sourceName = "channel workflow family") {
  const errors = [];
  requireString(family, "schemaVersion", errors);
  if (family?.schemaVersion !== "kova.channelWorkflowFamily.v1") {
    errors.push("schemaVersion must be kova.channelWorkflowFamily.v1");
  }
  requireKebabId(family, "id", errors);
  requireString(family, "title", errors);
  requireString(family, "userAction", errors);
  requireString(family, "openclawSurface", errors);
  requireString(family, "ownerArea", errors);
  validateGenericUserFlowText(family, "title", "title", errors);
  validateGenericUserFlowText(family, "userAction", "userAction", errors);
  validateGenericUserFlowText(family, "openclawSurface", "openclawSurface", errors);
  validateStringArray(family?.sourceRefs, "sourceRefs", errors, { nonEmpty: true });
  validateStringArray(family?.contentKinds, "contentKinds", errors, { nonEmpty: true });
  validateKnownValues(family?.contentKinds, channelWorkflowContentKinds, "contentKinds", errors);
  validateStringArray(family?.routeKinds, "routeKinds", errors, { nonEmpty: true });
  validateKnownValues(family?.routeKinds, channelWorkflowRouteKinds, "routeKinds", errors);
  validateStringArray(family?.deliveryModes, "deliveryModes", errors, { nonEmpty: true });
  validateKnownValues(family?.deliveryModes, channelWorkflowDeliveryModes, "deliveryModes", errors);
  validateStringArray(family?.lifecycles, "lifecycles", errors, { nonEmpty: true });
  validateKnownValues(family?.lifecycles, channelWorkflowLifecycles, "lifecycles", errors);
  requireArray(family, "atoms", errors);
  validateAtoms(family?.atoms, "atoms", errors);
  requireArray(family, "cases", errors);
  validateCases(family, errors);
  assertNoShapeErrors(errors, sourceName);
}

function validateInventoryWorkflows(inventory, errors) {
  if (!Array.isArray(inventory?.workflows)) {
    return;
  }
  if (inventory.workflows.length === 0) {
    errors.push("workflows must not be empty");
    return;
  }

  const declarationSources = new Set(inventory.declarationSources ?? []);
  const ids = new Set();
  for (const [index, workflow] of inventory.workflows.entries()) {
    const prefix = `workflows[${index}]`;
    validateWorkflowShape(workflow, prefix, errors);

    if (typeof workflow?.id === "string") {
      if (ids.has(workflow.id)) {
        errors.push(`duplicate channel workflow inventory workflow '${workflow.id}'`);
      }
      ids.add(workflow.id);
    }

    for (const sourceRef of workflow?.sourceRefs ?? []) {
      const sourcePath = String(sourceRef).split("#", 1)[0];
      if (!declarationSources.has(sourcePath)) {
        errors.push(`${prefix}.sourceRefs '${sourceRef}' must reference declarationSources`);
      }
    }
  }
}

function validateWorkflowShape(workflow, prefix, errors) {
  requireKebabId(workflow, "id", errors, prefix);
  requireString(workflow, "title", errors, prefix);
  requireString(workflow, "userAction", errors, prefix);
  requireString(workflow, "openclawSurface", errors, prefix);
  requireString(workflow, "ownerArea", errors, prefix);
  validateGenericUserFlowText(workflow, "title", `${prefix}.title`, errors);
  validateGenericUserFlowText(workflow, "userAction", `${prefix}.userAction`, errors);
  validateGenericUserFlowText(workflow, "openclawSurface", `${prefix}.openclawSurface`, errors);
  validateStringArray(workflow?.sourceRefs, `${prefix}.sourceRefs`, errors, { nonEmpty: true });
  validateStringArray(workflow?.contentKinds, `${prefix}.contentKinds`, errors, { nonEmpty: true });
  validateKnownValues(workflow?.contentKinds, channelWorkflowContentKinds, `${prefix}.contentKinds`, errors);
  validateStringArray(workflow?.routeKinds, `${prefix}.routeKinds`, errors, { nonEmpty: true });
  validateKnownValues(workflow?.routeKinds, channelWorkflowRouteKinds, `${prefix}.routeKinds`, errors);
  validateStringArray(workflow?.deliveryModes, `${prefix}.deliveryModes`, errors, { nonEmpty: true });
  validateKnownValues(workflow?.deliveryModes, channelWorkflowDeliveryModes, `${prefix}.deliveryModes`, errors);
  validateStringArray(workflow?.lifecycles, `${prefix}.lifecycles`, errors, { nonEmpty: true });
  validateKnownValues(workflow?.lifecycles, channelWorkflowLifecycles, `${prefix}.lifecycles`, errors);
  requireArray(workflow, "atoms", errors, prefix);
  validateAtoms(workflow?.atoms, `${prefix}.atoms`, errors);
  validateStringArray(workflow?.unsupported, `${prefix}.unsupported`, errors, { optional: true });
}

function validateCatalogCases(cases, errors) {
  if (!Array.isArray(cases)) {
    return;
  }
  if (cases.length === 0) {
    errors.push("cases must not be empty");
    return;
  }

  const ids = new Set();
  for (const [index, testCase] of cases.entries()) {
    validateCaseShape(testCase, `cases[${index}]`, errors, { requireInventoryWorkflow: true, requireOwnerArea: true });
    if (typeof testCase?.id === "string") {
      if (ids.has(testCase.id)) {
        errors.push(`duplicate channel workflow case '${testCase.id}'`);
      }
      ids.add(testCase.id);
    }
  }
}

function validateCases(family, errors) {
  if (!Array.isArray(family?.cases)) {
    return;
  }
  const ids = new Set();
  for (const [index, testCase] of family.cases.entries()) {
    validateCaseShape(testCase, `cases[${index}]`, errors, { requireInventoryWorkflow: false, requireOwnerArea: false });

    if (typeof testCase?.id === "string") {
      if (ids.has(testCase.id)) {
        errors.push(`duplicate channel workflow case '${testCase.id}'`);
      }
      ids.add(testCase.id);
    }
  }
}

function validateCaseShape(testCase, prefix, errors, { requireInventoryWorkflow, requireOwnerArea }) {
  requireWorkflowCaseId(testCase?.id, `${prefix}.id`, errors);
  requireKebabId(testCase, "workflow", errors, prefix);
  if (requireInventoryWorkflow) {
    requireKebabId(testCase, "inventoryWorkflow", errors, prefix);
  }
  requireString(testCase, "userAction", errors, prefix);
  requireString(testCase, "openclawSurface", errors, prefix);
  if (requireOwnerArea) {
    requireString(testCase, "ownerArea", errors, prefix);
  }
  requireString(testCase, "prompt", errors, prefix);
  validateGenericUserFlowText(testCase, "userAction", `${prefix}.userAction`, errors);
  validateGenericUserFlowText(testCase, "openclawSurface", `${prefix}.openclawSurface`, errors);
  validateGenericUserFlowText(testCase, "prompt", `${prefix}.prompt`, errors);
  requireObject(testCase, "providerScript", errors, prefix);
  requireObject(testCase, "expects", errors, prefix);
  requireObject(testCase, "matrix", errors, prefix);
  validateMatrix(testCase?.matrix, `${prefix}.matrix`, errors);
  requireArray(testCase, "atoms", errors, prefix);
  validateAtoms(testCase?.atoms, `${prefix}.atoms`, errors);
  validateExpects(testCase, `${prefix}.expects`, errors);
  validateStringArray(testCase?.adapterSupport, `${prefix}.adapterSupport`, errors, { optional: true });
}

function validateExpects(testCase, prefix, errors) {
  const expects = testCase?.expects;
  if (!expects || typeof expects !== "object" || Array.isArray(expects)) {
    return;
  }
  if (expects.nativeCalls !== undefined) {
    errors.push(`${prefix}.nativeCalls must not be used; use generic nativeActions instead`);
  }
  if (expects.nativeActions === undefined) {
    return;
  }
  if (!expects.nativeActions || typeof expects.nativeActions !== "object" || Array.isArray(expects.nativeActions)) {
    errors.push(`${prefix}.nativeActions must be an object when set`);
    return;
  }
  const nativeAtoms = new Set((testCase.atoms ?? [])
    .filter((atom) => atom.group === "native-platform")
    .map((atom) => atom.id));
  for (const [action, count] of Object.entries(expects.nativeActions)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(action)) {
      errors.push(`${prefix}.nativeActions key '${action}' must be a kebab id`);
    }
    if (!Number.isInteger(count) || count < 1) {
      errors.push(`${prefix}.nativeActions.${action} must be a positive integer`);
    }
    if (!nativeAtoms.has(action)) {
      errors.push(`${prefix}.nativeActions.${action} must match a native-platform atom on the same workflow case`);
    }
  }
}

function validateGenericUserFlowText(source, key, label, errors) {
  const value = source?.[key];
  if (typeof value !== "string") {
    return;
  }
  const lower = value.toLowerCase();
  for (const term of forbiddenGenericUserFlowTerms) {
    if (lower.includes(term.toLowerCase())) {
      errors.push(`${label} must be platform-neutral and must not mention '${term}'`);
    }
  }
}

function validateMatrix(matrix, prefix, errors) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return;
  }
  validateKnownMatrixValue(matrix.content, channelWorkflowContentKinds, `${prefix}.content`, errors);
  validateKnownMatrixValue(matrix.route, channelWorkflowRouteKinds, `${prefix}.route`, errors);
  validateKnownMatrixValue(matrix.delivery, channelWorkflowDeliveryModes, `${prefix}.delivery`, errors);
  validateKnownMatrixValue(matrix.lifecycle, channelWorkflowLifecycles, `${prefix}.lifecycle`, errors);
}

function validateAtoms(atoms, prefix, errors) {
  if (!Array.isArray(atoms)) {
    return;
  }
  if (atoms.length === 0) {
    errors.push(`${prefix} must not be empty`);
    return;
  }
  const seen = new Set();
  for (const [index, atom] of atoms.entries()) {
    const atomPrefix = `${prefix}[${index}]`;
    requireKebabId(atom, "group", errors, atomPrefix);
    requireKebabId(atom, "id", errors, atomPrefix);
    const key = `${atom?.group}:${atom?.id}`;
    if (typeof atom?.group === "string" && typeof atom?.id === "string") {
      if (seen.has(key)) {
        errors.push(`${prefix} duplicates atom '${key}'`);
      }
      seen.add(key);
    }
  }
}

function validateKnownValues(values, allowed, label, errors) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const [index, value] of values.entries()) {
    if (!allowed.includes(value)) {
      errors.push(`${label}[${index}] must be one of ${allowed.join(", ")}`);
    }
  }
}

function validateKnownMatrixValue(value, allowed, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
  }
}

function requireWorkflowCaseId(value, label, errors) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(value)) {
    errors.push(`${label} must be a kebab/dot case id`);
  }
}

function sourcePaths(sourceRefs) {
  return (sourceRefs ?? []).map((sourceRef) => String(sourceRef).split("#", 1)[0]);
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}
