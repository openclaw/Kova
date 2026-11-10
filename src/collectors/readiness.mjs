import { nearestRankPercentile } from "../percentiles.mjs";
import { createConnection } from "node:net";
import { readLinuxCpuCounters } from "./linux-cpu.mjs";

export const READINESS_SCHEMA = "kova.readiness.v1";
export const HEALTH_SAMPLES_SCHEMA = "kova.healthSamples.v1";

export async function collectReadinessMetrics(port, options) {
  const probe = normalizeProbeEndpoint(port, options.probeEndpoint);
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const thresholdMs = Math.max(0, Number(options.thresholdMs ?? options.timeoutMs ?? 0));
  const listeningAttempts = [];
  const healthAttempts = [];
  let listeningReadyAtMs = null;
  let healthReadyAtMs = null;
  let lastListening = null;
  let lastHealth = null;
  const trackIdentity = options.resolveGatewayPid !== undefined || options.gatewayPid !== undefined;
  const resolveIdentity = async () => gatewayIdentity(options.resolveGatewayPid
    ? await options.resolveGatewayPid(Math.max(1, deadline - Date.now()))
    : options.gatewayPid);
  let processIdentity = null;
  let identityMatched = false;
  let readyAt = null;

  do {
    lastListening = await collectListeningMetrics(probe, options.probeTimeoutMs);
    lastListening.elapsedMs = Date.now() - startedAt;
    listeningAttempts.push(lastListening);
    if (lastListening.ok && listeningReadyAtMs === null) {
      listeningReadyAtMs = lastListening.elapsedMs;
    }

    // Bind this attempt, not the first child observed during startup. A
    // successful probe must be bracketed by the same supervised process.
    processIdentity = trackIdentity ? await resolveIdentity() : null;
    lastHealth = await collectGatewayReadinessMetrics(probe, options.probeTimeoutMs);
    lastHealth.elapsedMs = Date.now() - startedAt;
    healthAttempts.push(lastHealth);
    if (lastHealth.ok) {
      healthReadyAtMs = lastHealth.elapsedMs;
      readyAt = new Date().toISOString();
      identityMatched = trackIdentity && sameGatewayIdentity(processIdentity, await resolveIdentity());
      break;
    }

    if (options.timeoutMs === 0 || Date.now() >= deadline) {
      break;
    }

    await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  const effectiveListeningReadyAtMs = listeningReadyAtMs ?? healthReadyAtMs;
  return {
    schemaVersion: READINESS_SCHEMA,
    deadlineMs: options.timeoutMs,
    thresholdMs,
    intervalMs: options.intervalMs,
    attempts: Math.max(listeningAttempts.length, healthAttempts.length),
    ready: healthReadyAtMs !== null,
    ...(trackIdentity ? { processIdentity, identityMatched, readyAt } : {}),
    listeningReady: effectiveListeningReadyAtMs !== null,
    listeningReadyAtMs: effectiveListeningReadyAtMs,
    healthReadyAtMs,
    classification: classifyReadiness({
      thresholdMs,
      listeningReadyAtMs: effectiveListeningReadyAtMs,
      healthReadyAtMs
    }),
    listening: lastListening,
    health: lastHealth,
    listeningAttempts,
    healthAttempts
  };
}

function gatewayIdentity(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return { pid, startTicks: readLinuxCpuCounters(pid).startTicks };
  } catch {
    return null;
  }
}

function sameGatewayIdentity(left, right) {
  return left !== null && right !== null && left.pid === right.pid && left.startTicks === right.startTicks;
}

export function classifyReadiness({ thresholdMs, listeningReadyAtMs, healthReadyAtMs }) {
  if (healthReadyAtMs === null) {
    if (listeningReadyAtMs === null) {
      return {
        state: "hard-failure",
        severity: "fail",
        reason: "gateway TCP socket never accepted connections before the hard deadline"
      };
    }
    return {
      state: "unhealthy",
      severity: "fail",
      reason: "gateway TCP socket opened but health never became ready before the hard deadline"
    };
  }
  if (thresholdMs > 0 && healthReadyAtMs > thresholdMs) {
    return {
      state: "slow-startup",
      severity: "fail",
      reason: `gateway became healthy after ${healthReadyAtMs}ms, beyond the ${thresholdMs}ms threshold`
    };
  }
  return {
    state: "ready",
    severity: "pass",
    reason: "gateway became healthy within the readiness threshold"
  };
}

export function collectListeningMetrics(probeTarget, timeoutMs) {
  const probe = normalizeProbeEndpoint(probeTarget, null);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host: probe.host, port: probe.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        source: probe.source,
        host: probe.host,
        port: probe.port,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: "tcp connect timed out"
      });
    }, Math.min(timeoutMs, 5000));

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({
        source: probe.source,
        host: probe.host,
        port: probe.port,
        ok: true,
        durationMs: Date.now() - startedAt
      });
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        source: probe.source,
        host: probe.host,
        port: probe.port,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
    });
  });
}

export async function collectHealthMetrics(probeTarget, timeoutMs) {
  return collectHttpProbeMetrics(probeTarget, timeoutMs, "/health");
}

export async function collectGatewayReadinessMetrics(probeTarget, timeoutMs) {
  return collectHttpProbeMetrics(probeTarget, timeoutMs, "/readyz");
}

async function collectHttpProbeMetrics(probeTarget, timeoutMs, path) {
  const probe = normalizeProbeEndpoint(probeTarget, null);
  const url = `${probe.url}${path}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    const text = await response.text();
    let ok = response.ok;
    if (path === "/readyz" && ok) {
      // Unknown routes can return the Control UI with HTTP 200.
      try {
        ok = JSON.parse(text)?.ready === true;
      } catch {
        ok = false;
      }
    }
    return {
      source: probe.source,
      host: probe.host,
      port: probe.port,
      url,
      ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bodySnippet: text.slice(0, 500)
    };
  } catch (error) {
    return {
      source: probe.source,
      host: probe.host,
      port: probe.port,
      url,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? `${path === "/readyz" ? "readiness" : "health"} request timed out` : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectHealthSamples(port, options) {
  const probe = normalizeProbeEndpoint(port, options.probeEndpoint);
  const samples = [];
  for (let index = 0; index < options.count; index += 1) {
    samples.push(await collectHealthMetrics(probe, options.timeoutMs));
    if (index < options.count - 1 && options.intervalMs > 0) {
      await sleep(options.intervalMs);
    }
  }
  return samples;
}

function normalizeProbeEndpoint(portOrEndpoint, explicitEndpoint) {
  const endpoint = explicitEndpoint ?? (typeof portOrEndpoint === "object" ? portOrEndpoint : null);
  if (endpoint) {
    const host = endpoint.host;
    const port = Number(endpoint.port);
    if (typeof host === "string" && host.length > 0 && Number.isInteger(port) && port > 0) {
      const url = typeof endpoint.url === "string" && endpoint.url.length > 0
        ? endpoint.url.replace(/\/+$/, "")
        : `http://${host}:${port}`;
      return {
        source: endpoint.source ?? "probe-endpoint",
        host,
        port,
        url
      };
    }
  }
  const port = Number(portOrEndpoint);
  return {
    source: "gateway-port",
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`
  };
}

export function summarizeHealthSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }

  const durations = samples.map((sample) => sample.durationMs).filter((duration) => typeof duration === "number").sort((a, b) => a - b);
  return {
    schemaVersion: HEALTH_SAMPLES_SCHEMA,
    count: samples.length,
    okCount: samples.filter((sample) => sample.ok).length,
    failureCount: samples.filter((sample) => !sample.ok).length,
    minMs: durations.at(0) ?? null,
    p50Ms: nearestRankPercentile(durations, 0.5),
    p95Ms: nearestRankPercentile(durations, 0.95),
    maxMs: durations.at(-1) ?? null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
