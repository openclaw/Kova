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
  checkRequiredBoundGate(violations, kind, metric, actual, threshold, label, false);
}

export function checkRequiredMinGate(violations, kind, metric, actual, threshold, label) {
  checkRequiredBoundGate(violations, kind, metric, actual, threshold, label, true);
}

function checkRequiredBoundGate(violations, kind, metric, actual, threshold, label, minimum) {
  if (typeof threshold !== "number") {
    return;
  }
  const expected = `${minimum ? ">=" : "<="} ${threshold}`;
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected,
      actual: null,
      message: `${label} evidence was not captured`
    });
    return;
  }
  if (minimum ? actual < threshold : actual > threshold) {
    violations.push({
      kind,
      metric,
      expected,
      actual,
      message: `${label} ${actual} ${minimum ? "below" : "exceeded"} threshold ${threshold}`
    });
  }
}
