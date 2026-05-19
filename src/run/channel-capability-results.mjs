export const CHANNEL_CAPABILITY_RUN_SCHEMA = "kova.channelCapabilityRun.v1";

export function appendChannelCapabilityEvidence(record, result, phaseId, commandIndex) {
  const evidence = channelCapabilityEvidenceFromResult(result, phaseId, commandIndex);
  if (evidence.length === 0) {
    return record;
  }
  record.channelCapabilityEvidence = [
    ...(record.channelCapabilityEvidence ?? []),
    ...evidence
  ];
  return record;
}

export function channelCapabilityEvidenceFromResult(result, phaseId, commandIndex) {
  const payload = parseChannelCapabilityPayload(result?.stdout);
  if (!payload) {
    return [];
  }
  validateChannelCapabilityPayload(payload);
  return payload.capabilities.map((capability) => ({
    channelId: capability.channelId,
    group: capability.group,
    capabilityId: capability.capabilityId,
    required: capability.required !== false,
    status: capability.status,
    proofMode: capability.proofMode ?? payload.proofMode ?? null,
    phaseId: capability.phaseId ?? phaseId,
    commandIndex: capability.commandIndex ?? commandIndex,
    summary: capability.summary,
    reason: capability.reason ?? null,
    artifactPath: capability.artifactPath ?? payload.artifactPath ?? null,
    ownerArea: capability.ownerArea ?? payload.ownerArea ?? null
  }));
}

function parseChannelCapabilityPayload(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return payload?.schemaVersion === CHANNEL_CAPABILITY_RUN_SCHEMA ? payload : null;
}

function validateChannelCapabilityPayload(payload) {
  const errors = [];
  if (!Array.isArray(payload.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    for (const [index, capability] of payload.capabilities.entries()) {
      const prefix = `capabilities[${index}]`;
      requireNonEmptyString(capability.channelId, `${prefix}.channelId`, errors);
      requireNonEmptyString(capability.group, `${prefix}.group`, errors);
      requireNonEmptyString(capability.capabilityId, `${prefix}.capabilityId`, errors);
      requireKnownStatus(capability.status, `${prefix}.status`, errors);
      requireNonEmptyString(capability.summary, `${prefix}.summary`, errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(`invalid channel capability result: ${errors.join("; ")}`);
  }
}

function requireNonEmptyString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function requireKnownStatus(value, label, errors) {
  if (!["passed", "failed", "missing", "skipped"].includes(value)) {
    errors.push(`${label} must be one of passed, failed, missing, skipped`);
  }
}
