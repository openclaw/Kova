const VISIBLE_SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendVideoNote",
  "sendAudio",
  "sendVoice",
  "sendDocument",
  "sendAnimation"
]);

export function normalizeTelegramObservations({ inbound, calls }) {
  return {
    schemaVersion: "kova.channelObservationSet.v1",
    channelId: "telegram",
    inbound,
    deliveries: calls
      .filter((call) => VISIBLE_SEND_METHODS.has(call.method))
      .map(normalizeDelivery),
    nativeCalls: calls
  };
}

function normalizeDelivery(call) {
  const body = objectOrEmpty(call.body);
  const threadId = body.message_thread_id ?? null;
  const chatId = body.chat_id ?? body.chatId ?? call.result?.chat?.id ?? null;
  const media = normalizeMedia(call);
  return {
    schemaVersion: "kova.channelObservation.v1",
    channelId: "telegram",
    native: {
      method: call.method,
      path: call.path,
      raw: call
    },
    actor: "bot",
    visible: true,
    kind: media.length > 0 ? "media" : "text",
    text: typeof body.text === "string" ? body.text : null,
    caption: typeof body.caption === "string" ? body.caption : null,
    media,
    route: {
      kind: threadId == null ? "direct" : "thread",
      key: threadId == null ? String(chatId) : `${chatId}:topic:${threadId}`,
      parentKey: threadId == null ? null : String(chatId)
    },
    replyTo: {
      present: telegramReplyMessageId(body) != null,
      key: telegramReplyMessageId(body) == null ? null : String(telegramReplyMessageId(body))
    },
    delivery: {
      id: call.result?.message_id == null ? null : String(call.result.message_id),
      receiptPresent: call.responseOk === true,
      status: call.responseOk === true ? "sent" : "failed"
    },
    silent: body.disable_notification === true || body.disable_notification === "true",
    timestampMs: Date.parse(call.receivedAt) || 0
  };
}

function normalizeMedia(call) {
  if (call.method === "sendMessage") {
    return [];
  }
  const field = mediaFieldForMethod(call.method);
  const body = objectOrEmpty(call.body);
  return [{
    kind: mediaKindForMethod(call.method),
    present: field ? body[field] != null : true,
    source: typeof body[field] === "string" && body[field].startsWith("http") ? "url" : "upload"
  }];
}

function mediaFieldForMethod(method) {
  return {
    sendPhoto: "photo",
    sendVideo: "video",
    sendVideoNote: "video_note",
    sendAudio: "audio",
    sendVoice: "voice",
    sendDocument: "document",
    sendAnimation: "animation"
  }[method] ?? null;
}

function mediaKindForMethod(method) {
  return {
    sendPhoto: "image",
    sendVideo: "video",
    sendVideoNote: "video",
    sendAudio: "audio",
    sendVoice: "audio",
    sendDocument: "document",
    sendAnimation: "animation"
  }[method] ?? "media";
}

function telegramReplyMessageId(body) {
  if (body.reply_to_message_id != null) {
    return body.reply_to_message_id;
  }
  const parameters = typeof body.reply_parameters === "string"
    ? parseJsonObject(body.reply_parameters)
    : objectOrEmpty(body.reply_parameters);
  return parameters.message_id ?? null;
}

function parseJsonObject(value) {
  try {
    return objectOrEmpty(JSON.parse(value));
  } catch {
    return {};
  }
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
