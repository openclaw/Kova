export function thresholdFromExpected(expected) {
  if (Number.isFinite(expected)) {
    return expected;
  }
  const match = String(expected ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function maxDurationWhere(results, predicate) {
  const durations = results
    .filter((result) => predicate(result.command))
    .map((result) => result.durationMs)
    .filter((duration) => typeof duration === "number");
  return durations.length === 0 ? null : Math.max(...durations);
}

export function sumNumbers(values) {
  return values.reduce((total, value) => total + (typeof value === "number" ? value : 0), 0);
}

export function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function firstNonEmptyLine(...values) {
  for (const value of values) {
    const line = String(value ?? "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (line) {
      return line;
    }
  }
  return null;
}

export function hasAnyThreshold(thresholds, metrics) {
  return metrics.some((metric) => typeof thresholds[metric] === "number");
}

export function maxNullable(...values) {
  const numbers = values.filter((value) => typeof value === "number");
  return numbers.length === 0 ? null : Math.max(...numbers);
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isoOrNull(epochMs) {
  return typeof epochMs === "number" && Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

export function delta(left, right) {
  return typeof left === "number" && typeof right === "number" ? Math.max(0, left - right) : null;
}

export function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

export function findFirstString(value, keys) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const nested = findFirstString(child, keys);
    if (typeof nested === "string") {
      return nested;
    }
  }
  return null;
}

export function findPayloadText(text) {
  const payloadIndex = text.indexOf('"payloads"');
  if (payloadIndex < 0) {
    return null;
  }
  const payloadText = text.slice(payloadIndex).match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  if (typeof payloadText !== "string") {
    return null;
  }
  try {
    return JSON.parse(`"${payloadText}"`);
  } catch {
    return payloadText;
  }
}
