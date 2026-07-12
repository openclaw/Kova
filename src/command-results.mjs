import { RECORD_STATUS } from "./statuses.mjs";

export const COMMAND_RESULT_INTERPRETATION_SCHEMA = "kova.commandResultInterpretation.v1";
const structuredFailureStatuses = new Set([
  RECORD_STATUS.FAIL,
  RECORD_STATUS.INCOMPLETE,
  RECORD_STATUS.BLOCKED
]);
const noLogsStderrPattern = /^ocm: no logs exist for env "[^"\r\n]+" across stdout or stderr\n?$/;

export function isNoLogsOutput(output) {
  return noLogsStderrPattern.test(String(output ?? ""));
}

export function isOptionalNoLogsResult(result) {
  return result?.status === 1 &&
    result?.timedOut !== true &&
    !result?.signal &&
    result?.stdout === "" &&
    isNoLogsOutput(result?.stderr);
}

export function normalizeOptionalCommandResult(result) {
  if (!result || result.status === 0) {
    return result;
  }

  if (/^ocm\s+logs(?:\s|$)/.test(result.command ?? "") && isOptionalNoLogsResult(result)) {
    result.optional = true;
    result.originalStatus = result.status;
    result.status = 0;
    result.note = "optional log collection found no env logs";
  }

  return result;
}

export function attachCommandResultInterpretation(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  result.interpretation = interpretCommandResult(result);
  return result;
}

export function interpretCommandResult(result) {
  const payload = parseStructuredJsonStdout(result?.stdout);
  const recordStatus = normalizeStructuredRecordStatus(payload?.recordStatus);
  return {
    schemaVersion: COMMAND_RESULT_INTERPRETATION_SCHEMA,
    structured: payload !== null,
    ok: typeof payload?.ok === "boolean" ? payload.ok : null,
    failureDomain: normalizeFailureDomain(payload?.failureDomain),
    recordStatus,
    reason: typeof payload?.error === "string" ? payload.error : null
  };
}

export function commandFailureRecordStatus(result) {
  const status = result?.interpretation?.recordStatus ?? interpretCommandResult(result).recordStatus;
  return structuredFailureStatuses.has(status) ? status : null;
}

function parseStructuredJsonStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStructuredRecordStatus(value) {
  const status = typeof value === "string" ? value.trim().toUpperCase() : "";
  return structuredFailureStatuses.has(status) ? status : null;
}

function normalizeFailureDomain(value) {
  const domain = typeof value === "string" ? value.trim() : "";
  if (["openclaw", "kova-harness", "external"].includes(domain)) {
    return domain;
  }
  return null;
}
