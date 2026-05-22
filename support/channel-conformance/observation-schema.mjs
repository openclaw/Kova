const OBSERVATION_SET_SCHEMA = "kova.channelObservationSet.v1";
const OBSERVATION_SCHEMA = "kova.channelObservation.v1";
const DELIVERY_STATUSES = new Set(["sent", "failed", "unknown"]);
const DELIVERY_KINDS = new Set(["text", "media", "poll", "payload"]);

export function assertValidObservationSet(observations, { caseId } = {}) {
  const errors = observationSetErrors(observations);
  if (errors.length > 0) {
    const prefix = caseId ? `${caseId} produced invalid channel observations` : "invalid channel observations";
    throw new Error(`${prefix}: ${errors.join("; ")}`);
  }
}

function observationSetErrors(observations) {
  const errors = [];
  if (!isObject(observations)) {
    return ["observation set must be an object"];
  }
  if (observations.schemaVersion !== OBSERVATION_SET_SCHEMA) {
    errors.push(`schemaVersion must be ${OBSERVATION_SET_SCHEMA}`);
  }
  if (!isNonEmptyString(observations.channelId)) {
    errors.push("channelId must be a non-empty string");
  }
  if (!isObject(observations.inbound)) {
    errors.push("inbound must be an object");
  }
  if (!Array.isArray(observations.deliveries)) {
    errors.push("deliveries must be an array");
  } else {
    observations.deliveries.forEach((delivery, index) => {
      errors.push(...deliveryErrors(delivery, observations.channelId, index));
    });
  }
  errors.push(...nativeCallSummaryErrors(observations.nativeCallSummary));
  return errors;
}

function deliveryErrors(delivery, expectedChannelId, index) {
  const prefix = `deliveries[${index}]`;
  const errors = [];
  if (!isObject(delivery)) {
    return [`${prefix} must be an object`];
  }
  if (delivery.schemaVersion !== OBSERVATION_SCHEMA) {
    errors.push(`${prefix}.schemaVersion must be ${OBSERVATION_SCHEMA}`);
  }
  if (delivery.channelId !== expectedChannelId) {
    errors.push(`${prefix}.channelId must match observation set channelId`);
  }
  if (!isObject(delivery.native)) {
    errors.push(`${prefix}.native must be an object`);
  }
  if (!isNonEmptyString(delivery.actor)) {
    errors.push(`${prefix}.actor must be a non-empty string`);
  }
  if (typeof delivery.visible !== "boolean") {
    errors.push(`${prefix}.visible must be boolean`);
  }
  if (!DELIVERY_KINDS.has(delivery.kind)) {
    errors.push(`${prefix}.kind must be one of ${Array.from(DELIVERY_KINDS).join(", ")}`);
  }
  if (!isNullableString(delivery.text)) {
    errors.push(`${prefix}.text must be string or null`);
  }
  if (!isNullableString(delivery.caption)) {
    errors.push(`${prefix}.caption must be string or null`);
  }
  errors.push(...routeErrors(delivery.route, `${prefix}.route`));
  errors.push(...replyToErrors(delivery.replyTo, `${prefix}.replyTo`));
  errors.push(...deliveryReceiptErrors(delivery.delivery, `${prefix}.delivery`));
  errors.push(...mediaErrors(delivery.media, `${prefix}.media`));
  if (typeof delivery.silent !== "boolean") {
    errors.push(`${prefix}.silent must be boolean`);
  }
  if (!Number.isFinite(delivery.timestampMs)) {
    errors.push(`${prefix}.timestampMs must be a finite number`);
  }
  return errors;
}

function routeErrors(route, prefix) {
  const errors = [];
  if (!isObject(route)) {
    return [`${prefix} must be an object`];
  }
  if (!isNonEmptyString(route.kind)) {
    errors.push(`${prefix}.kind must be a non-empty string`);
  }
  if (!isNonEmptyString(route.key)) {
    errors.push(`${prefix}.key must be a non-empty string`);
  }
  if (!isNullableString(route.parentKey)) {
    errors.push(`${prefix}.parentKey must be string or null`);
  }
  return errors;
}

function replyToErrors(replyTo, prefix) {
  const errors = [];
  if (!isObject(replyTo)) {
    return [`${prefix} must be an object`];
  }
  if (typeof replyTo.present !== "boolean") {
    errors.push(`${prefix}.present must be boolean`);
  }
  if (!isNullableString(replyTo.key)) {
    errors.push(`${prefix}.key must be string or null`);
  }
  return errors;
}

function deliveryReceiptErrors(delivery, prefix) {
  const errors = [];
  if (!isObject(delivery)) {
    return [`${prefix} must be an object`];
  }
  if (!isNullableString(delivery.id)) {
    errors.push(`${prefix}.id must be string or null`);
  }
  if (typeof delivery.receiptPresent !== "boolean") {
    errors.push(`${prefix}.receiptPresent must be boolean`);
  }
  if (!DELIVERY_STATUSES.has(delivery.status)) {
    errors.push(`${prefix}.status must be one of ${Array.from(DELIVERY_STATUSES).join(", ")}`);
  }
  return errors;
}

function mediaErrors(media, prefix) {
  const errors = [];
  if (!Array.isArray(media)) {
    return [`${prefix} must be an array`];
  }
  media.forEach((item, index) => {
    const itemPrefix = `${prefix}[${index}]`;
    if (!isObject(item)) {
      errors.push(`${itemPrefix} must be an object`);
      return;
    }
    if (!isNonEmptyString(item.kind)) {
      errors.push(`${itemPrefix}.kind must be a non-empty string`);
    }
    if (typeof item.present !== "boolean") {
      errors.push(`${itemPrefix}.present must be boolean`);
    }
    if (!isNonEmptyString(item.source)) {
      errors.push(`${itemPrefix}.source must be a non-empty string`);
    }
  });
  return errors;
}

function nativeCallSummaryErrors(summary) {
  const errors = [];
  if (!isObject(summary)) {
    return ["nativeCallSummary must be an object"];
  }
  if (!Number.isInteger(summary.count) || summary.count < 0) {
    errors.push("nativeCallSummary.count must be a non-negative integer");
  }
  if (!Number.isInteger(summary.deliveryCount) || summary.deliveryCount < 0) {
    errors.push("nativeCallSummary.deliveryCount must be a non-negative integer");
  }
  if (!isObject(summary.byMethod)) {
    errors.push("nativeCallSummary.byMethod must be an object");
  } else {
    for (const [method, count] of Object.entries(summary.byMethod)) {
      if (!isNonEmptyString(method) || !Number.isInteger(count) || count < 0) {
        errors.push("nativeCallSummary.byMethod values must be non-negative integers keyed by method");
        break;
      }
    }
  }
  if (!isObject(summary.byAction)) {
    errors.push("nativeCallSummary.byAction must be an object");
  } else {
    for (const [action, count] of Object.entries(summary.byAction)) {
      if (!isNonEmptyString(action) || !Number.isInteger(count) || count < 0) {
        errors.push("nativeCallSummary.byAction values must be non-negative integers keyed by action");
        break;
      }
    }
  }
  return errors;
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}
