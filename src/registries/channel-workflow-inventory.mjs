import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelCapabilitiesDir } from "../paths.mjs";
import { channelCapabilityCatalogMap } from "./channel-capability-catalog.mjs";
import {
  assertNoShapeErrors,
  requireArray,
  requireKebabId,
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

export async function loadChannelWorkflowInventory(selectedId) {
  const names = await readdir(channelCapabilitiesDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const items = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(channelCapabilitiesDir, name), "utf8");
    const item = JSON.parse(raw);
    if (item.schemaVersion !== "kova.channelWorkflowInventory.v1") {
      continue;
    }
    validateChannelWorkflowInventoryShape(item, name);
    if (ids.has(item.id)) {
      throw new Error(`duplicate channel workflow inventory id '${item.id}' in ${name}`);
    }
    ids.add(item.id);
    items.push(item);
  }

  const filtered = selectedId ? items.filter((item) => item.id === selectedId) : items;
  if (filtered.length === 0) {
    throw new Error(`no channel workflow inventory found for ${selectedId}`);
  }
  return filtered;
}

export function validateChannelWorkflowInventoryShape(inventory, sourceName = "channel workflow inventory") {
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
  validateWorkflows(inventory, errors);
  assertNoShapeErrors(errors, sourceName);
}

export function validateChannelWorkflowInventoryReferences(inventories, capabilityCatalogs) {
  const capabilityMap = channelCapabilityCatalogMap(capabilityCatalogs);
  const errors = [];
  for (const inventory of inventories ?? []) {
    for (const workflow of inventory.workflows ?? []) {
      for (const atom of workflow.atoms ?? []) {
        const key = `${atom.group}:${atom.id}`;
        if (!capabilityMap.has(key)) {
          errors.push(`${inventory.id}.${workflow.id} references unknown OpenClaw channel atom ${key}`);
        }
      }
    }
  }
  assertNoShapeErrors(errors, "channel workflow inventory references");
}

function validateWorkflows(inventory, errors) {
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
    requireKebabId(workflow, "id", errors, prefix);
    requireString(workflow, "title", errors, prefix);
    requireString(workflow, "userAction", errors, prefix);
    requireString(workflow, "openclawSurface", errors, prefix);
    requireString(workflow, "ownerArea", errors, prefix);
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
