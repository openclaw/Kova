import { channelCapabilityCatalogMap } from "./channel-capability-catalog.mjs";
import {
  loadChannelWorkflowFamilies,
  validateWorkflowCaseCatalogShape,
  workflowCaseCatalogFromFamilies
} from "./channel-workflow-families.mjs";
import { assertNoShapeErrors } from "./validate.mjs";

export async function loadChannelWorkflowCaseCatalog(selectedId) {
  const items = workflowCaseCatalogFromFamilies(await loadChannelWorkflowFamilies());
  const filtered = selectedId ? items.filter((item) => item.id === selectedId) : items;
  if (filtered.length === 0) {
    throw new Error(`no channel workflow case catalog found for ${selectedId}`);
  }
  return filtered;
}

export function validateChannelWorkflowCaseCatalogShape(catalog, sourceName = "channel workflow case catalog") {
  validateWorkflowCaseCatalogShape(catalog, sourceName);
}

export function validateChannelWorkflowCaseCatalogReferences(workflowCatalogs, capabilityCatalogs) {
  const capabilityMap = channelCapabilityCatalogMap(capabilityCatalogs);
  const errors = [];
  for (const catalog of workflowCatalogs ?? []) {
    for (const testCase of catalog.cases ?? []) {
      for (const atom of testCase.atoms ?? []) {
        const key = `${atom.group}:${atom.id}`;
        if (!capabilityMap.has(key)) {
          errors.push(`${catalog.id}.${testCase.id} references unknown OpenClaw channel atom ${key}`);
        }
      }
    }
  }
  assertNoShapeErrors(errors, "channel workflow case catalog references");
}

export function validateChannelWorkflowCaseInventoryReferences(workflowCatalogs, workflowInventories) {
  const workflowInventoryMap = new Map();
  for (const inventory of workflowInventories ?? []) {
    for (const workflow of inventory.workflows ?? []) {
      workflowInventoryMap.set(workflow.id, workflow);
    }
  }

  const errors = [];
  for (const catalog of workflowCatalogs ?? []) {
    for (const testCase of catalog.cases ?? []) {
      const workflowId = testCase.inventoryWorkflow;
      const inventoryWorkflow = workflowInventoryMap.get(workflowId);
      if (!inventoryWorkflow) {
        errors.push(`${catalog.id}.${testCase.id} references unknown channel workflow inventory id '${workflowId}'`);
        continue;
      }
      const matrix = testCase.matrix ?? {};
      for (const [field, inventoryField] of [
        ["content", "contentKinds"],
        ["route", "routeKinds"],
        ["delivery", "deliveryModes"],
        ["lifecycle", "lifecycles"]
      ]) {
        validateInventoryDimension({
          errors,
          catalogId: catalog.id,
          caseId: testCase.id,
          workflow: inventoryWorkflow,
          field,
          inventoryField,
          value: matrix[field]
        });
      }
    }
  }
  assertNoShapeErrors(errors, "channel workflow case inventory references");
}

function validateInventoryDimension({
  errors,
  catalogId,
  caseId,
  workflow,
  field,
  inventoryField,
  value
}) {
  if (!workflow?.[inventoryField]?.includes(value)) {
    errors.push(`${catalogId}.${caseId} matrix.${field} '${value}' is not supported by inventory workflow '${workflow.id}'`);
  }
}
