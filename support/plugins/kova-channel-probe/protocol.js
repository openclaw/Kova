const string = { type: "string", minLength: 1, maxLength: 4096 };
const object = { type: "object" };
const boolean = { type: "boolean" };
const empty = { type: "object", properties: {}, additionalProperties: false };

export function isKovaTarget(value) {
  return typeof value === "string" && (value === "dm:kova-probe-user" || value.startsWith("dm:kova-probe-user-") || /^group:kova-probe-group(?:-[a-z0-9-]+)?$/.test(value));
}

export const probeRequestSchemas = {
  "kova.channelProbe.status": empty,
  "kova.channelProbe.bindings": {
    type: "object", properties: { targetSessionKey: string }, additionalProperties: false
  },
  "kova.channelProbe.inject": {
    type: "object", required: ["message"], additionalProperties: false,
    properties: {
      message: { type: "string", minLength: 1, maxLength: 1000000 },
      inboundEventId: string, targetId: string, senderId: string, senderName: string,
      from: string, chatType: { type: "string", enum: ["direct", "group"] },
      replyToId: { anyOf: [string, { type: "null" }] }, threadId: string,
      silent: boolean, manualAck: boolean, wasMentioned: boolean, sourceReplyDeliveryMode: string,
      ackPolicy: { type: "string", enum: ["after_receive_record", "after_agent_dispatch", "after_durable_send", "manual"] },
      requiredCapabilities: object, botLoopProtection: object
    }
  }
};

export function validateProbeRequest(method, params) {
  const schema = probeRequestSchemas[method];
  if (!schema || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("invalid channel probe request");
  for (const key of schema.required ?? []) if (!(key in params)) throw new Error(`channel probe ${key} is required`);
  for (const [key, value] of Object.entries(params)) {
    const rule = schema.properties[key];
    if (!rule) throw new Error(`unknown channel probe option: ${key}`);
    const matches = (constraint) => {
      if (constraint.type === "null") return value === null;
      if (constraint.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
      if (typeof value !== constraint.type) return false;
      if (constraint.type === "string" && (!value.trim() || value.length < constraint.minLength || value.length > constraint.maxLength)) return false;
      return !constraint.enum || constraint.enum.includes(value);
    };
    if (!(rule.anyOf ? rule.anyOf.some(matches) : matches(rule))) throw new Error(`invalid channel probe ${key}`);
  }
  return params;
}
