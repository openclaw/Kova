export function declaredCapabilityProofRows({ channelId, channelRegistry, workflowCoverage, rows, artifactPath }) {
  const rowsById = new Map((rows ?? []).map((row) => [row.id, row]));
  const selectedRows = workflowCoverage?.selectedRows ?? workflowCoverage?.selected ?? [];
  return (channelRegistry.capabilities ?? []).map((capability) => capabilityProofRow({
    channelId,
    capability,
    proofCaseRows: selectedRows
      .filter((workflowCase) => caseAtoms(workflowCase).includes(`${capability.group}:${capability.id}`))
      .map((workflowCase) => rowsById.get(workflowCase.id) ?? { id: workflowCase.id, status: "missing" }),
    artifactPath
  }));
}

function capabilityProofRow({ channelId, capability, proofCaseRows, artifactPath }) {
  const proofCaseIds = proofCaseRows.map((row) => row.id);
  const failedCases = proofCaseRows.filter((row) => row.status !== "passed" && row.status !== "missing");
  const capabilityKey = `${capability.group}:${capability.id}`;
  if (failedCases.length > 0) {
    return {
      channelId,
      group: capability.group,
      capabilityId: capability.id,
      required: true,
      status: "failed",
      proofMode: "channel-platform-conformance",
      summary: `${channelId} ${capabilityKey} capability proof failed`,
      reason: `${failedCases.length} selected user flow proof${failedCases.length === 1 ? "" : "s"} failed: ${failedCases.map((row) => row.id).join(", ")}`,
      failureOwner: failedCases[0]?.failureOwner ?? null,
      ownerArea: failedCases[0]?.ownerArea ?? `${channelId} adapter/runtime`,
      artifactPath,
      proofCaseIds
    };
  }
  if (proofCaseRows.length > 0 && proofCaseRows.every((row) => row.status === "passed")) {
    return {
      channelId,
      group: capability.group,
      capabilityId: capability.id,
      required: true,
      status: "passed",
      proofMode: "channel-platform-conformance",
      summary: `${channelId} ${capabilityKey} capability proven by ${proofCaseIds.join(", ")}`,
      reason: null,
      ownerArea: `${channelId} adapter/runtime`,
      artifactPath,
      proofCaseIds
    };
  }
  return {
    channelId,
    group: capability.group,
    capabilityId: capability.id,
    required: true,
    status: "missing",
    proofMode: "channel-platform-conformance",
    summary: `${channelId} ${capabilityKey} capability proof incomplete`,
    reason: proofCaseRows.length > 0
      ? `missing selected user flow results: ${proofCaseRows.filter((row) => row.status === "missing").map((row) => row.id).join(", ")}`
      : `no selected ${channelId} user flow proves ${capabilityKey}`,
    failureOwner: "kova-coverage",
    ownerArea: "Kova channel conformance coverage",
    artifactPath,
    proofCaseIds
  };
}

function caseAtoms(workflowCase) {
  return (workflowCase.atoms ?? [])
    .filter((atom) => atom.group !== "workflow")
    .map((atom) => `${atom.group}:${atom.id}`);
}
