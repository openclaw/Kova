export function selectWorkflowCases({ channelRegistry, workflowCatalog, caseSet: requestedCaseSet }) {
  const cases = Array.isArray(workflowCatalog?.cases) ? workflowCatalog.cases : [];
  const casesById = new Map(cases.map((workflowCase) => [workflowCase.id, workflowCase]));
  const ids = requestedCaseSet === "declared-workflows"
    ? channelRegistry.workflowCaseIds ?? []
    : requestedCaseSet.split(",").map((id) => id.trim()).filter(Boolean);
  const selected = ids.map((id) => casesById.get(id)).filter(Boolean);
  if (selected.length !== ids.length) {
    const unknown = ids.filter((id) => !casesById.has(id));
    throw new Error(`unknown workflow case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return selected.map((workflowCase) => applyWorkflowOverride(workflowCase, channelRegistry.workflowOverrides?.[workflowCase.id]));
}

function applyWorkflowOverride(workflowCase, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return workflowCase;
  }
  return {
    ...workflowCase,
    expects: {
      ...workflowCase.expects,
      ...override
    }
  };
}
