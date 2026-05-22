export const TELEGRAM_TOKEN = "999001:kova-telegram-token";

const BOT_ID = 999001;
const BOT_USERNAME = "kova_mock_bot";
const USER_ID = 200;
const DIRECT_CHAT_ID = 200;
const GROUP_CHAT_ID = -1003970070733;
const THREAD_ID = 12;

let updateSequence = 1000;
let messageSequence = 5000;

export function telegramInboundForCase(workflowCase) {
  const threaded = caseUsesThread(workflowCase);
  const reply = caseUsesReply(workflowCase);
  const roomEvent = caseUsesRoomEvent(workflowCase);
  const media = inboundMediaForCase(workflowCase);
  const messageId = nextMessageId();
  const grouped = threaded || roomEvent;
  const chat = grouped
    ? { id: GROUP_CHAT_ID, type: "supergroup", title: "Kova Telegram Shim", is_forum: true }
    : { id: DIRECT_CHAT_ID, type: "private", first_name: "Kova User" };
  const routeKey = threaded
    ? `${GROUP_CHAT_ID}:topic:${THREAD_ID}`
    : String(grouped ? GROUP_CHAT_ID : DIRECT_CHAT_ID);
  const text = grouped && !roomEvent ? `@${BOT_USERNAME} ${workflowCase.prompt}` : workflowCase.prompt;
  const message = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: {
      id: USER_ID,
      is_bot: false,
      first_name: "Kova User",
      username: "kova_user"
    },
    ...(media ? { caption: text, ...media.telegramFields } : { text }),
    ...(threaded ? { message_thread_id: THREAD_ID, is_topic_message: true } : {}),
    ...(reply ? {
      reply_to_message: {
        message_id: 900,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: {
          id: BOT_ID,
          is_bot: true,
          first_name: "Kova",
          username: BOT_USERNAME
        },
        text: "Previous Kova message"
      }
    } : {})
  };
  return {
    channelId: "telegram",
    messageKey: String(messageId),
    route: {
      kind: threaded ? "thread" : "direct",
      key: routeKey,
      parentKey: threaded ? String(GROUP_CHAT_ID) : null
    },
    media: media?.facts ?? [],
    native: {
      update: {
        update_id: nextUpdateId(),
        message
      }
    }
  };
}

function inboundMediaForCase(workflowCase) {
  const media = workflowCase.input?.media;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return null;
  }
  const kind = typeof media.kind === "string" ? media.kind : "image";
  const fileId = typeof media.fileId === "string" ? media.fileId : `kova-${kind}-input`;
  const fileUniqueId = `${fileId}-unique`;
  const contentType = mediaContentType(kind);
  return {
    facts: [{
      kind,
      fileId,
      contentType,
      messageId: null
    }],
    telegramFields: telegramMediaFields({
      kind,
      fileId,
      fileUniqueId,
      fileName: typeof media.fileName === "string" ? media.fileName : undefined,
      contentType
    })
  };
}

function telegramMediaFields({ kind, fileId, fileUniqueId, fileName, contentType }) {
  if (kind === "video") {
    return {
      video: {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        file_name: fileName ?? "kova-input-video.mp4",
        mime_type: contentType,
        width: 640,
        height: 360,
        duration: 2
      }
    };
  }
  if (kind === "audio") {
    return {
      audio: {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        file_name: fileName ?? "kova-input-audio.ogg",
        mime_type: contentType,
        duration: 2
      }
    };
  }
  if (kind === "document") {
    return {
      document: {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        file_name: fileName ?? "kova-input-document.txt",
        mime_type: contentType
      }
    };
  }
  return {
    photo: [{
      file_id: fileId,
      file_unique_id: fileUniqueId,
      width: 320,
      height: 180,
      file_size: 128
    }]
  };
}

function mediaContentType(kind) {
  return {
    video: "video/mp4",
    audio: "audio/ogg",
    document: "text/plain",
    image: "image/png"
  }[kind] ?? "application/octet-stream";
}

export function telegramBotEchoUpdate({ workflowCase, inbound, observations }) {
  const firstDelivery = observations?.deliveries?.find((delivery) => delivery.visible) ?? null;
  const text = firstDelivery?.text ?? firstDelivery?.caption ?? workflowCase.expects?.text ?? "KOVA_SELF_TRIGGER_ECHO";
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextMessageId(),
      date: Math.floor(Date.now() / 1000),
      chat: inbound.native.update.message.chat,
      from: {
        id: BOT_ID,
        is_bot: true,
        first_name: "Kova",
        username: BOT_USERNAME
      },
      text,
      ...(inbound.native.update.message.message_thread_id != null ? {
        message_thread_id: inbound.native.update.message.message_thread_id,
        is_topic_message: true
      } : {})
    }
  };
}

function caseUsesThread(workflowCase) {
  return workflowCase.matrix?.route === "thread" ||
    workflowCase.matrix?.route === "reply-thread" ||
    workflowCase.expects?.threadId != null;
}

function caseUsesReply(workflowCase) {
  return workflowCase.matrix?.route === "reply" ||
    workflowCase.matrix?.route === "reply-thread" ||
    workflowCase.expects?.replyTo === "inbound-message";
}

function caseUsesRoomEvent(workflowCase) {
  return workflowCase.sourceReplyDeliveryMode === "message_tool_only";
}

function nextUpdateId() {
  updateSequence += 1;
  return updateSequence;
}

function nextMessageId() {
  messageSequence += 1;
  return messageSequence;
}
