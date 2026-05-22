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
  const messageId = nextMessageId();
  const chat = threaded
    ? { id: GROUP_CHAT_ID, type: "supergroup", title: "Kova Telegram Shim", is_forum: true }
    : { id: DIRECT_CHAT_ID, type: "private", first_name: "Kova User" };
  const routeKey = threaded ? `${GROUP_CHAT_ID}:topic:${THREAD_ID}` : String(DIRECT_CHAT_ID);
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
    text: workflowCase.prompt,
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
    native: {
      update: {
        update_id: nextUpdateId(),
        message
      }
    }
  };
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

function nextUpdateId() {
  updateSequence += 1;
  return updateSequence;
}

function nextMessageId() {
  messageSequence += 1;
  return messageSequence;
}
