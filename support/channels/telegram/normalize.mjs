const VISIBLE_SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendVideoNote",
  "sendAudio",
  "sendVoice",
  "sendDocument",
  "sendAnimation",
  "sendPoll"
]);

export function normalizeTelegramObservations({ workflowCase, inbound, calls }) {
  const visibleCalls = calls.filter((call) => isVisibleDeliveryCall(call, workflowCase));
  const deliveries = visibleCalls
    .map((call) => normalizeDelivery(call, workflowCase));
  return {
    schemaVersion: "kova.channelObservationSet.v1",
    channelId: "telegram",
    inbound,
    deliveries,
    unmatchedNativeMessages: [],
    nativeCallSummary: summarizeNativeCalls(calls, visibleCalls.length, deliveries.length)
  };
}

function summarizeNativeCalls(calls, nativeVisibleDeliveryCount, logicalDeliveryCount) {
  const byMethod = {};
  const byAction = {};
  for (const call of calls) {
    byMethod[call.method] = (byMethod[call.method] ?? 0) + 1;
    for (const action of nativeActionsForMethod(call.method)) {
      byAction[action] = (byAction[action] ?? 0) + 1;
    }
  }
  return {
    count: calls.length,
    nativeVisibleDeliveryCount,
    logicalDeliveryCount,
    byMethod,
    byAction
  };
}

function nativeActionsForMethod(method) {
  return {
    sendMessage: ["action-send"],
    sendPhoto: ["action-send"],
    sendVideo: ["action-send"],
    sendVideoNote: ["action-send"],
    sendAudio: ["action-send"],
    sendVoice: ["action-send"],
    sendDocument: ["action-send"],
    sendAnimation: ["action-send"],
    sendPoll: ["action-poll"],
    setMessageReaction: ["action-react"],
    deleteMessage: ["action-delete"],
    editMessageText: ["action-edit"],
    createForumTopic: ["action-topic-create"],
    editForumTopic: ["action-topic-edit"],
    pinChatMessage: ["delivery-pin"]
  }[method] ?? [];
}

function isVisibleDeliveryCall(call, workflowCase) {
  if (VISIBLE_SEND_METHODS.has(call.method)) {
    return true;
  }
  return workflowCase?.expects?.errorFinal === true &&
    call.method === "editMessageText" &&
    !isTransientStatusText(typeof call.body?.text === "string" ? call.body.text : null);
}

function normalizeDelivery(call, workflowCase) {
  const body = objectOrEmpty(call.body);
  const threadId = body.message_thread_id ?? null;
  const chatId = body.chat_id ?? body.chatId ?? call.result?.chat?.id ?? null;
  const media = normalizeMedia(call);
  const text = call.method === "sendPoll" && typeof body.question === "string"
    ? body.question
    : typeof body.text === "string" ? body.text : null;
  return {
    schemaVersion: "kova.channelObservation.v1",
    channelId: "telegram",
    actor: "bot",
    visible: !isTransientStatusText(text),
    kind: call.method === "sendPoll" ? "poll" : media.length > 0 ? "media" : "text",
    text,
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
    timestampMs: Date.parse(call.receivedAt) || 0,
    nativeMessages: [nativeMessageForCall(call, workflowCase)]
  };
}

function nativeMessageForCall(call, workflowCase) {
  return {
    channelId: "telegram",
    method: call.method,
    path: typeof call.path === "string" ? call.path : null,
    deliveryId: call.result?.message_id == null ? null : String(call.result.message_id),
    status: call.responseOk === true ? "sent" : "failed",
    visible: isVisibleDeliveryCall(call, workflowCase),
    timestampMs: Date.parse(call.receivedAt) || 0,
    raw: call
  };
}

function isTransientStatusText(text) {
  return typeof text === "string" && /<code>[^<]*(?:Image Generation|Message):/u.test(text);
}

function normalizeMedia(call) {
  if (call.method === "sendMessage" || call.method === "sendPoll") {
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
