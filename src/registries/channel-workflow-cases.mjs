import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { channelCapabilitiesDir } from "../paths.mjs";
import { channelCapabilityCatalogMap } from "./channel-capability-catalog.mjs";
import {
  channelWorkflowContentKinds,
  channelWorkflowDeliveryModes,
  channelWorkflowLifecycles,
  channelWorkflowRouteKinds
} from "./channel-workflow-inventory.mjs";
import {
  assertNoShapeErrors,
  requireArray,
  requireKebabId,
  requireObject,
  requireString,
  validateStringArray
} from "./validate.mjs";

export async function loadChannelWorkflowCaseCatalog(selectedId) {
  const names = await readdir(channelCapabilitiesDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const items = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(channelCapabilitiesDir, name), "utf8");
    const item = JSON.parse(raw);
    if (item.schemaVersion !== "kova.channelWorkflowCaseCatalog.v1") {
      continue;
    }
    validateChannelWorkflowCaseCatalogShape(item, name);
    if (ids.has(item.id)) {
      throw new Error(`duplicate channel workflow case catalog id '${item.id}' in ${name}`);
    }
    ids.add(item.id);
    items.push(item);
  }

  const filtered = selectedId ? items.filter((item) => item.id === selectedId) : items;
  if (filtered.length === 0) {
    throw new Error(`no channel workflow case catalog found for ${selectedId}`);
  }
  return filtered;
}

export function validateChannelWorkflowCaseCatalogShape(catalog, sourceName = "channel workflow case catalog") {
  const errors = [];
  requireString(catalog, "schemaVersion", errors);
  if (catalog?.schemaVersion !== "kova.channelWorkflowCaseCatalog.v1") {
    errors.push("schemaVersion must be kova.channelWorkflowCaseCatalog.v1");
  }
  requireKebabId(catalog, "id", errors);
  requireString(catalog, "title", errors);
  requireString(catalog, "description", errors);
  requireArray(catalog, "cases", errors);
  validateCases(catalog?.cases, errors);
  assertNoShapeErrors(errors, sourceName);
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
      validateInventoryDimension({
        errors,
        catalogId: catalog.id,
        caseId: testCase.id,
        workflow: inventoryWorkflow,
        field: "content",
        inventoryField: "contentKinds",
        value: matrix.content
      });
      validateInventoryDimension({
        errors,
        catalogId: catalog.id,
        caseId: testCase.id,
        workflow: inventoryWorkflow,
        field: "route",
        inventoryField: "routeKinds",
        value: matrix.route
      });
      validateInventoryDimension({
        errors,
        catalogId: catalog.id,
        caseId: testCase.id,
        workflow: inventoryWorkflow,
        field: "delivery",
        inventoryField: "deliveryModes",
        value: matrix.delivery
      });
      validateInventoryDimension({
        errors,
        catalogId: catalog.id,
        caseId: testCase.id,
        workflow: inventoryWorkflow,
        field: "lifecycle",
        inventoryField: "lifecycles",
        value: matrix.lifecycle
      });
    }
  }
  assertNoShapeErrors(errors, "channel workflow case inventory references");
}

function validateCases(cases, errors) {
  if (!Array.isArray(cases)) {
    return;
  }
  if (cases.length === 0) {
    errors.push("cases must not be empty");
    return;
  }

  const ids = new Set();
  for (const [index, testCase] of cases.entries()) {
    const prefix = `cases[${index}]`;
    requireWorkflowCaseId(testCase?.id, `${prefix}.id`, errors);
    requireKebabId(testCase, "workflow", errors, prefix);
    requireKebabId(testCase, "inventoryWorkflow", errors, prefix);
    requireString(testCase, "userAction", errors, prefix);
    requireString(testCase, "openclawSurface", errors, prefix);
    requireString(testCase, "ownerArea", errors, prefix);
    requireString(testCase, "prompt", errors, prefix);
    requireObject(testCase, "providerScript", errors, prefix);
    requireObject(testCase, "expects", errors, prefix);
    requireObject(testCase, "matrix", errors, prefix);
    validateMatrix(testCase?.matrix, `${prefix}.matrix`, errors);
    requireArray(testCase, "atoms", errors, prefix);
    validateAtoms(testCase?.atoms, `${prefix}.atoms`, errors);
    validateExpects(testCase, `${prefix}.expects`, errors);
    validateStringArray(testCase?.adapterSupport, `${prefix}.adapterSupport`, errors, { optional: true });

    if (typeof testCase?.id === "string") {
      if (ids.has(testCase.id)) {
        errors.push(`duplicate channel workflow case '${testCase.id}'`);
      }
      ids.add(testCase.id);
    }
  }
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

function requireWorkflowCaseId(value, label, errors) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(value)) {
    errors.push(`${label} must be a kebab/dot case id`);
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
