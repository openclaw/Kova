import { channelCapabilityCatalogMap } from "./channel-capability-catalog.mjs";
import {
  channelWorkflowContentKinds,
  channelWorkflowDeliveryModes,
  channelWorkflowLifecycles,
  channelWorkflowRouteKinds,
  loadChannelWorkflowFamilies,
  workflowInventoryFromFamilies
} from "./channel-workflow-families.mjs";
import { assertNoShapeErrors } from "./validate.mjs";

export {
  channelWorkflowContentKinds,
  channelWorkflowDeliveryModes,
  channelWorkflowLifecycles,
  channelWorkflowRouteKinds
};

export async function loadChannelWorkflowInventory(selectedId) {
  const items = workflowInventoryFromFamilies(await loadChannelWorkflowFamilies());
  const filtered = selectedId ? items.filter((item) => item.id === selectedId) : items;
  if (filtered.length === 0) {
    throw new Error(`no channel workflow inventory found for ${selectedId}`);
  }
  return filtered;
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
