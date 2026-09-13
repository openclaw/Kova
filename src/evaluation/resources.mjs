import { measuredProductPhase } from "../measurement-contract.mjs";
import { maxNullable } from "./shared.mjs";

export function collectGatewayProcessResources(record, options = {}) {
  // collectEnvMetrics.process samples OCM's supervised service.childPid, so it
  // belongs to the gateway role without contaminating aggregate command trees.
  let summary = null;
  for (const phase of record.phases ?? []) {
    if (options.productOnly === true && !measuredProductPhase(phase)) {
      continue;
    }
    summary = mergeGatewayProcessMetrics(summary, phase.metrics?.process, options);
  }
  return mergeGatewayProcessMetrics(summary, record.finalMetrics?.process, options);
}

function mergeGatewayProcessMetrics(summary, process, options = {}) {
  const rssMb = typeof process?.rssMb === "number" ? process.rssMb : null;
  const cpuPercent = !options.intervalCpu && typeof process?.cpuPercent === "number" ? process.cpuPercent : null;
  if (rssMb === null && cpuPercent === null) {
    return summary;
  }
  const next = summary ?? {
    peakRssMb: null,
    maxCpuPercent: null,
    peakRssAtMs: null,
    peakCpuAtMs: null,
    peakProcessCount: 1,
    peakRssProcess: null,
    peakCpuProcess: null
  };
  const compactProcess = {
    pid: process.pid ?? null,
    roles: ["gateway"],
    role: "gateway",
    rssMb,
    cpuPercent,
    command: process.command ?? null
  };
  if (rssMb !== null && (next.peakRssMb === null || rssMb > next.peakRssMb)) {
    next.peakRssMb = rssMb;
    next.peakRssProcess = compactProcess;
  }
  if (cpuPercent !== null && (next.maxCpuPercent === null || cpuPercent > next.maxCpuPercent)) {
    next.maxCpuPercent = cpuPercent;
    next.peakCpuProcess = compactProcess;
  }
  return next;
}

export function collectResourceSummary(results, options = {}) {
  let sampleCount = 0;
  let peakTotalRssMb = null;
  let maxTotalCpuPercent = null;
  let maxTotalCpuPercentLower = null;
  let peakCommandTreeRssMb = null;
  let peakGatewayRssMb = null;
  let peakRssSample = null;
  let peakCpuSample = null;
  let maxTotalRssGrowthMb = null;
  let maxGatewayRssGrowthMb = null;
  let trend = null;
  const artifacts = [];
  const byPid = new Map();
  const byRole = new Map();

  for (const result of results) {
    const samples = result.resourceSamples;
    if (!samples) {
      continue;
    }
    sampleCount += samples.sampleCount ?? 0;
    peakTotalRssMb = maxNullable(peakTotalRssMb, samples.peakTotalRssMb);
    maxTotalCpuPercent = maxNullable(maxTotalCpuPercent, samples.maxTotalCpuPercent);
    maxTotalCpuPercentLower = maxNullable(maxTotalCpuPercentLower, samples.maxTotalCpuPercentLower);
    peakCommandTreeRssMb = maxNullable(peakCommandTreeRssMb, samples.peakCommandTreeRssMb);
    peakGatewayRssMb = maxNullable(peakGatewayRssMb, samples.peakGatewayRssMb);
    mergeRoleSummaries(byRole, samples.byRole ?? {});
    maxTotalRssGrowthMb = maxNullable(maxTotalRssGrowthMb, samples.trend?.totalRssGrowthMb);
    maxGatewayRssGrowthMb = maxNullable(maxGatewayRssGrowthMb, samples.trend?.gatewayRssGrowthMb);
    trend = maxTrend(trend, samples.trend);
    peakRssSample = maxSample(peakRssSample, samples.peakRssSample, "totalRssMb");
    peakCpuSample = maxSample(peakCpuSample, samples.peakCpuSample, "totalCpuPercent");
    if (samples.artifactPath) {
      artifacts.push(samples.artifactPath);
    }
    for (const process of [...(samples.topByRss ?? []), ...(samples.topByCpu ?? [])]) {
      const processIdentity = `${process.pid}:${process.startTicks ?? "legacy"}`;
      const existing = byPid.get(processIdentity) ?? {
        pid: process.pid,
        ...(process.startTicks === undefined ? {} : { startTicks: process.startTicks }),
        command: process.command,
        role: process.role,
        peakRssMb: 0,
        maxCpuPercent: 0,
        firstSeenMs: process.firstSeenMs,
        lastSeenMs: process.lastSeenMs
      };
      existing.command = process.command;
      existing.role = mergeRoles(existing.role, process.role);
      existing.peakRssMb = Math.max(existing.peakRssMb, process.peakRssMb ?? 0);
      existing.maxCpuPercent = Math.max(existing.maxCpuPercent, process.maxCpuPercent ?? 0);
      existing.firstSeenMs = Math.min(existing.firstSeenMs ?? process.firstSeenMs ?? 0, process.firstSeenMs ?? 0);
      existing.lastSeenMs = Math.max(existing.lastSeenMs ?? process.lastSeenMs ?? 0, process.lastSeenMs ?? 0);
      byPid.set(processIdentity, existing);
    }
  }

  if (options.gatewayProcessResources) {
    mergeRoleSummaries(byRole, { gateway: options.gatewayProcessResources });
    peakGatewayRssMb = maxNullable(peakGatewayRssMb, options.gatewayProcessResources.peakRssMb);
  }

  const processes = [...byPid.values()];
  const roleSummaries = Object.fromEntries([...byRole.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right)));
  const roleList = Object.entries(roleSummaries).map(([role, summary]) => ({ role, ...summary }));
  return {
    sampleCount,
    peakTotalRssMb,
    maxTotalCpuPercent,
    maxTotalCpuPercentLower,
    peakCommandTreeRssMb,
    peakGatewayRssMb,
    maxTotalRssGrowthMb,
    maxGatewayRssGrowthMb,
    trend,
    byRole: roleSummaries,
    topRolesByRss: roleList.toSorted((left, right) => (right.peakRssMb ?? 0) - (left.peakRssMb ?? 0)).slice(0, 8),
    topRolesByCpu: roleList.toSorted((left, right) => (right.maxCpuPercent ?? 0) - (left.maxCpuPercent ?? 0)).slice(0, 8),
    peakRssSample,
    peakCpuSample,
    artifacts,
    topByRss: processes.toSorted((left, right) => right.peakRssMb - left.peakRssMb).slice(0, 5),
    topByCpu: processes.toSorted((left, right) => right.maxCpuPercent - left.maxCpuPercent).slice(0, 5)
  };
}

function maxTrend(current, candidate) {
  if (!candidate?.available) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentGrowth = Math.max(current.totalRssGrowthMb ?? 0, current.gatewayRssGrowthMb ?? 0);
  const candidateGrowth = Math.max(candidate.totalRssGrowthMb ?? 0, candidate.gatewayRssGrowthMb ?? 0);
  return candidateGrowth > currentGrowth ? candidate : current;
}

function mergeRoleSummaries(target, source) {
  for (const [role, summary] of Object.entries(source)) {
    const existing = target.get(role) ?? {
      peakRssMb: null,
      maxCpuPercent: null,
      peakRssAtMs: null,
      peakCpuAtMs: null,
      peakProcessCount: 0,
      peakRssProcess: null,
      peakCpuProcess: null
    };
    if (typeof summary.peakRssMb === "number" && (existing.peakRssMb === null || summary.peakRssMb > existing.peakRssMb)) {
      existing.peakRssMb = summary.peakRssMb;
      existing.peakRssAtMs = summary.peakRssAtMs ?? null;
      existing.peakProcessCount = summary.peakProcessCount ?? 0;
      existing.peakRssProcess = summary.peakRssProcess ?? null;
    }
    if (typeof summary.maxCpuPercent === "number" && (existing.maxCpuPercent === null || summary.maxCpuPercent > existing.maxCpuPercent)) {
      existing.maxCpuPercent = summary.maxCpuPercent;
      existing.peakCpuAtMs = summary.peakCpuAtMs ?? null;
      existing.peakCpuProcess = summary.peakCpuProcess ?? null;
    }
    if (typeof summary.maxCpuPercentLower === "number") existing.maxCpuPercentLower = Math.max(existing.maxCpuPercentLower ?? 0, summary.maxCpuPercentLower);
    target.set(role, existing);
  }
}

function maxSample(current, candidate, key) {
  if (!candidate || typeof candidate[key] !== "number") {
    return current;
  }
  if (!current || candidate[key] > current[key]) {
    return candidate;
  }
  return current;
}

export function compactSampleProcess(process) {
  if (!process) {
    return null;
  }
  return {
    pid: process.pid ?? null,
    role: process.role ?? null,
    rssMb: process.rssMb ?? process.peakRssMb ?? null,
    cpuPercent: process.cpuPercent ?? process.maxCpuPercent ?? null,
    command: process.command ?? null
  };
}

function mergeRoles(left, right) {
  const roles = new Set(`${left ?? ""},${right ?? ""}`.split(",").filter(Boolean));
  return [...roles].join(",");
}

export function resolveResourceGate(resourceSummary, surface, { peakTrackedRssMb, cpuPercentMaxTracked }) {
  const configured = surface?.resourcePrimaryRole ?? null;
  if (typeof configured === "string" && configured.length > 0) {
    const resources = resourceSummary?.byRole?.[configured] ?? null;
    if (resources) {
      return roleResourceGate(configured, resources, "configured primary resource role");
    }
    return {
      kind: "role-missing",
      primaryRole: configured,
      role: configured,
      peakRssMb: null,
      cpuPercentMax: null,
      reason: `configured primary resource role '${configured}' was not observed in product resource samples`,
      attribution: {
        role: configured,
        observed: false,
        topRolesByRss: resourceSummary?.topRolesByRss?.slice(0, 4) ?? [],
        topRolesByCpu: resourceSummary?.topRolesByCpu?.slice(0, 4) ?? [],
        peakRssProcess: compactSampleProcess(resourceSummary?.peakRssSample?.topProcess),
        peakCpuProcess: compactSampleProcess(resourceSummary?.peakCpuSample?.topProcess)
      }
    };
  }
  const gateway = resourceSummary?.byRole?.gateway;
  if (typeof gateway?.peakRssMb === "number" || typeof gateway?.maxCpuPercent === "number") {
    return roleResourceGate("gateway", gateway, "default gateway resource role");
  }
  const topRole = firstObservedRole(resourceSummary?.topRolesByRss) ?? firstObservedRole(resourceSummary?.topRolesByCpu);
  if (topRole) {
    const resources = resourceSummary?.byRole?.[topRole] ?? null;
    if (resources) {
      return roleResourceGate(topRole, resources, "largest observed resource role");
    }
  }
  return {
    kind: "tracked-total",
    primaryRole: null,
    role: null,
    peakRssMb: peakTrackedRssMb,
    cpuPercentMax: cpuPercentMaxTracked,
    reason: "no product resource role was observed; using tracked aggregate",
    attribution: {
      role: null,
      observed: false,
      topRolesByRss: resourceSummary?.topRolesByRss?.slice(0, 4) ?? [],
      topRolesByCpu: resourceSummary?.topRolesByCpu?.slice(0, 4) ?? [],
      peakRssProcess: compactSampleProcess(resourceSummary?.peakRssSample?.topProcess),
      peakCpuProcess: compactSampleProcess(resourceSummary?.peakCpuSample?.topProcess)
    }
  };
}

function roleResourceGate(role, resources, reason) {
  return {
    kind: "role",
    primaryRole: role,
    role,
    peakRssMb: typeof resources?.peakRssMb === "number" ? resources.peakRssMb : null,
    cpuPercentMax: typeof resources?.maxCpuPercent === "number" ? resources.maxCpuPercent : null,
    reason,
    attribution: {
      role,
      observed: true,
      peakRssMb: resources?.peakRssMb ?? null,
      maxCpuPercent: resources?.maxCpuPercent ?? null,
      peakProcessCount: resources?.peakProcessCount ?? null,
      peakRssProcess: resources?.peakRssProcess ?? null,
      peakCpuProcess: resources?.peakCpuProcess ?? null
    }
  };
}

function firstObservedRole(roles) {
  return (roles ?? []).find((entry) => typeof entry?.role === "string" && entry.role.length > 0)?.role ?? null;
}

export function hasActivePrimaryResourceThreshold(thresholds, roleThresholds, primaryResourceRole) {
  if (!primaryResourceRole) {
    return false;
  }
  if (typeof thresholds?.peakRssMb === "number" || typeof thresholds?.cpuPercentMax === "number") {
    return true;
  }
  const role = roleThresholds?.[primaryResourceRole] ?? null;
  return typeof role?.peakRssMb === "number" ||
    typeof role?.peakProcessRssMb === "number" ||
    typeof role?.maxCpuPercent === "number";
}

export function resourceRssLabel(primaryResourceRole, resourceGateKind) {
  if (resourceGateKind === "role-missing") {
    return `${primaryResourceRole} RSS`;
  }
  if (resourceGateKind !== "role") {
    return "tracked total peak RSS";
  }
  if (primaryResourceRole === "gateway") {
    return "gateway peak RSS";
  }
  return `${primaryResourceRole} peak RSS`;
}

export function resourceBreakdownSuffix(resourceSummary, resourceGate) {
  const topRoles = (resourceSummary?.topRolesByRss ?? [])
    .filter((entry) => entry?.role && typeof entry.peakRssMb === "number")
    .slice(0, 3)
    .map((entry) => `${entry.role} ${entry.peakRssMb} MB`);
  if (topRoles.length === 0) {
    return "";
  }
  if (resourceGate.kind === "role") {
    return `; observed role ${resourceGate.role}; top RSS roles: ${topRoles.join(", ")}`;
  }
  if (resourceGate.kind === "tracked-total") {
    return `; aggregate only; top RSS roles: ${topRoles.join(", ")}`;
  }
  return `; configured role not observed; top RSS roles: ${topRoles.join(", ")}`;
}
