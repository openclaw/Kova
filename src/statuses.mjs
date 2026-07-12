export const RECORD_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  INCOMPLETE: "INCOMPLETE",
  BLOCKED: "BLOCKED",
  SKIPPED: "SKIPPED",
  DRY_RUN: "DRY-RUN"
});

export const NON_PASSING_EXECUTION_STATUSES = new Set([
  RECORD_STATUS.FAIL,
  RECORD_STATUS.INCOMPLETE,
  RECORD_STATUS.BLOCKED
]);

export function isNonPassingExecutionStatus(status) {
  return NON_PASSING_EXECUTION_STATUSES.has(status);
}

export function findingSeverityForStatus(status) {
  if (status === RECORD_STATUS.BLOCKED) {
    return "blocked";
  }
  if (status === RECORD_STATUS.INCOMPLETE) {
    return "incomplete";
  }
  return "fail";
}

export function recordStatusRank(status) {
  const ranks = {
    [RECORD_STATUS.PASS]: 0,
    [RECORD_STATUS.DRY_RUN]: 1,
    [RECORD_STATUS.SKIPPED]: 2,
    [RECORD_STATUS.INCOMPLETE]: 3,
    [RECORD_STATUS.BLOCKED]: 4,
    [RECORD_STATUS.FAIL]: 5
  };
  return ranks[status] ?? 3;
}

export function worseRecordStatus(left, right) {
  if (left == null) {
    return right ?? null;
  }
  if (right == null) {
    return left;
  }
  return recordStatusRank(right) > recordStatusRank(left) ? right : left;
}
