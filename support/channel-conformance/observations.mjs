import { expectedFinalDeliveries } from "./final-deliveries.mjs";

export async function waitForCaseObservations({
  workflowCase,
  platform,
  callCursor,
  readPlatformCalls,
  normalizeObservations,
  timeoutMs
}) {
  const startedAt = Date.now();
  const deadline = startedAt + caseTimeoutMs(workflowCase, timeoutMs);
  let latest = null;
  while (Date.now() < deadline) {
    const calls = await readPlatformCalls({ platform });
    latest = await normalizeObservations({
      workflowCase,
      platform,
      inbound: platform.currentInbound,
      calls: calls.slice(callCursor)
    });
    if (hasExpectedFinalDeliveries(workflowCase, latest) && hasExpectedNativeActions(workflowCase, latest)) {
      const finalCalls = await waitForQuietPlatformCalls({
        platform,
        readPlatformCalls,
        callCursor,
        deadline
      });
      return await normalizeObservations({
        workflowCase,
        platform,
        inbound: platform.currentInbound,
        calls: finalCalls
      });
    }
    await sleep(150);
  }
  return latest ?? await normalizeObservations({
    workflowCase,
    platform,
    inbound: platform.currentInbound,
    calls: []
  });
}

async function waitForQuietPlatformCalls({ platform, readPlatformCalls, callCursor, deadline }) {
  let latest = (await readPlatformCalls({ platform })).slice(callCursor);
  let latestCount = latest.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(150);
    latest = (await readPlatformCalls({ platform })).slice(callCursor);
    if (latest.length !== latestCount) {
      latestCount = latest.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= 1000) {
      return latest;
    }
  }
  return latest;
}

function expectedVisibleDeliveryCount(workflowCase) {
  const value = workflowCase.expects?.visibleDeliveries;
  return Number.isInteger(value) ? value : 1;
}

function hasExpectedFinalDeliveries(workflowCase, observations) {
  return expectedFinalDeliveries(workflowCase, observations).length >= expectedVisibleDeliveryCount(workflowCase);
}

function hasExpectedNativeActions(workflowCase, observations) {
  const expected = workflowCase.expects?.nativeActions;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return true;
  }
  const byAction = observations?.nativeCallSummary?.byAction && typeof observations.nativeCallSummary.byAction === "object"
    ? observations.nativeCallSummary.byAction
    : {};
  return Object.entries(expected)
    .every(([action, count]) => Number(byAction[action] ?? 0) >= Number(count));
}

function caseTimeoutMs(workflowCase, timeoutMs) {
  const value = workflowCase.expects?.asyncCompletionTimeoutMs;
  return Number.isInteger(value) ? Math.min(timeoutMs, value) : Math.min(timeoutMs, 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
