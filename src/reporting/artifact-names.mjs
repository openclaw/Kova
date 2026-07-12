import { createHash } from "node:crypto";

export function artifactRunIdSegment(value) {
  const runId = String(value);
  if (isCanonicalRunId(runId)) {
    return runId;
  }
  return `external-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

export function isCanonicalRunId(value) {
  return /^kova-\d{6}-\d{6}-[0-9a-f]{6}$/.test(value);
}
