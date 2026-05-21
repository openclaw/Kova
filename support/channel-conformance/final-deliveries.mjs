export function expectedFinalDeliveries(workflowCase, observations) {
  const expects = workflowCase?.expects && typeof workflowCase.expects === "object" && !Array.isArray(workflowCase.expects)
    ? workflowCase.expects
    : {};
  const deliveries = Array.isArray(observations?.deliveries) ? observations.deliveries : [];
  const visible = deliveries.filter((delivery) => delivery.visible === true);
  const expectedText = typeof expects.text === "string" ? expects.text : null;
  const expectedKind = typeof expects.kind === "string" ? expects.kind : null;
  return visible.filter((delivery) => {
    if (expectedKind === "text" && delivery.kind !== "text") {
      return false;
    }
    if (expectedKind === "media" && !delivery.media?.some((media) => media.present)) {
      return false;
    }
    if (expectedText && expectedKind !== "media" && !deliveryText(delivery).includes(expectedText)) {
      return false;
    }
    return true;
  });
}

function deliveryText(delivery) {
  return [delivery.text, delivery.caption]
    .filter((value) => typeof value === "string")
    .join("\n");
}
