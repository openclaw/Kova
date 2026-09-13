import { checkBooleanThreshold } from "./violations.mjs";

export function checkRequiredBooleanGate(violations, kind, metric, actual, threshold, message) {
  if (typeof threshold !== "number") {
    return;
  }
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected: threshold >= 1,
      actual: null,
      message: `${message}; metric evidence was not captured`
    });
    return;
  }
  checkBooleanThreshold(violations, kind, metric, actual, threshold, message);
}

export function checkRequiredMaxGate(violations, kind, metric, actual, threshold, label) {
  if (typeof threshold !== "number") {
    return;
  }
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected: `<= ${threshold}`,
      actual: null,
      message: `${label} evidence was not captured`
    });
    return;
  }
  if (actual > threshold) {
    violations.push({
      kind,
      metric,
      expected: `<= ${threshold}`,
      actual,
      message: `${label} ${actual} exceeded threshold ${threshold}`
    });
  }
}

export function checkRequiredMinGate(violations, kind, metric, actual, threshold, label) {
  if (typeof threshold !== "number") {
    return;
  }
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected: `>= ${threshold}`,
      actual: null,
      message: `${label} evidence was not captured`
    });
    return;
  }
  if (actual < threshold) {
    violations.push({
      kind,
      metric,
      expected: `>= ${threshold}`,
      actual,
      message: `${label} ${actual} below threshold ${threshold}`
    });
  }
}
