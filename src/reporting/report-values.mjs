import { measurementMetricValue } from "../health.mjs";
import { markdownFence } from "./markdown.mjs";

export function statusCountsText(statuses = {}) {
  return Object.entries(statuses).map(([status, count]) => `${status}:${count}`).join(", ") || "unknown";
}

export function hasValue(value) {
  return value !== null && value !== undefined;
}

export function valueMs(value, defaultValue = "unknown") {
  return value === null || value === undefined ? defaultValue : `${value}ms`;
}

export function valueMb(value) {
  return value === null || value === undefined ? "unknown" : `${value} MB`;
}

export function valuePercent(value) {
  return value === null || value === undefined ? "unknown" : `${value}%`;
}

export function formatChannelWorkflowResourceRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "no attributed workflow samples";
  }
  return rows.slice(0, 3).map((row) => {
    const label = row.caseId ?? row.workflow ?? "unknown";
    return `${label} gateway ${valueMb(row.peakGatewayRssMb)} tracked ${valueMb(row.peakTrackedRssMb)}`;
  }).join("; ");
}

export function resourceHeadlineValue(measurements) {
  return measurementMetricValue(measurements, "peakRssMb");
}

export function resourceHeadlineEvidenceLabel(measurements) {
  const role = measurements.resourcePrimaryRole ?? null;
  if (measurements.resourceGateKind === "role-missing") {
    return role ? `${role}RssMbNotObserved` : "resourceRoleNotObserved";
  }
  if (measurements.resourceGateKind === "tracked-total") {
    return "trackedTotalRssMb";
  }
  if (role === "gateway" || !role) {
    return "gatewayRssMb";
  }
  return `${role}RssMb`;
}

export function resourceHeadlineText(measurements) {
  const role = measurements.resourcePrimaryRole ?? null;
  if (measurements.resourceGateKind === "role-missing") {
    return role ? `${role} RSS not observed` : "primary RSS not observed";
  }
  if (measurements.resourceGateKind === "tracked-total") {
    return "tracked total RSS";
  }
  if (role === "gateway" || !role) {
    return "gateway RSS";
  }
  return `${role} RSS`;
}

export function healthSlowestText(measurements) {
  const slowest = measurements.health?.slowestSample;
  if (!slowest) {
    return "";
  }
  return `; slowest ${slowest.scope}/${slowest.phaseId ?? "unknown"} ${valueMs(slowest.durationMs)}`;
}

export function fencedSnippet(value) {
  return markdownFence(value);
}

export function shortCommand(command) {
  const value = String(command ?? "").replace(/\s+/g, " ").trim();
  return value.length <= 90 ? value : `${value.slice(0, 87)}...`;
}
