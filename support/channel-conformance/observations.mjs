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
  const expectedVisible = expectedVisibleDeliveryCount(workflowCase);
  let latest = null;
  while (Date.now() < deadline) {
    const calls = await readPlatformCalls({ platform });
    latest = await normalizeObservations({
      workflowCase,
      platform,
      inbound: platform.currentInbound,
      calls: calls.slice(callCursor)
    });
    if ((latest.deliveries ?? []).filter((delivery) => delivery.visible).length >= expectedVisible) {
      await sleep(500);
      const finalCalls = await readPlatformCalls({ platform });
      return await normalizeObservations({
        workflowCase,
        platform,
        inbound: platform.currentInbound,
        calls: finalCalls.slice(callCursor)
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

function expectedVisibleDeliveryCount(workflowCase) {
  const value = workflowCase.expects?.visibleDeliveries;
  return Number.isInteger(value) ? value : 1;
}

function caseTimeoutMs(workflowCase, timeoutMs) {
  const value = workflowCase.expects?.asyncCompletionTimeoutMs;
  return Number.isInteger(value) ? Math.min(timeoutMs, value) : Math.min(timeoutMs, 30000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
