import { normalizeTelegramObservations } from "./normalize.mjs";
import {
  telegramBotEchoUpdate,
  telegramInboundForCase
} from "./events.mjs";
import {
  configureTelegramWorkflowCase,
  configureTelegramOpenClaw,
  startTelegramOpenClaw
} from "./openclaw.mjs";
import {
  enqueueTelegramUpdate,
  readTelegramPlatformCalls,
  startTelegramPlatform,
  stopTelegramPlatform
} from "./platform.mjs";

export const startPlatform = startTelegramPlatform;
export const configureOpenClaw = configureTelegramOpenClaw;
export const configureWorkflowCase = configureTelegramWorkflowCase;
export const startOpenClaw = startTelegramOpenClaw;

const SUPPORTED_ROUTES = new Set([
  "direct",
  "reply",
  "thread",
  "reply-thread"
]);

const SUPPORTED_MEDIA_INPUT_KINDS = new Set([
  "image",
  "video",
  "audio",
  "document"
]);

export function canDriveWorkflowCase({ workflowCase }) {
  const route = workflowCase?.matrix?.route;
  if (!SUPPORTED_ROUTES.has(route)) {
    return {
      supported: false,
      reason: `telegram driver cannot enqueue route '${route ?? "unknown"}'`
    };
  }

  const media = workflowCase?.input?.media;
  if (media != null) {
    const kind = typeof media.kind === "string" ? media.kind : "image";
    if (!SUPPORTED_MEDIA_INPUT_KINDS.has(kind)) {
      return {
        supported: false,
        reason: `telegram driver cannot enqueue inbound media kind '${kind}'`
      };
    }
  }

  return { supported: true, reason: null };
}

export async function enqueueUserEvent({ workflowCase, platform }) {
  const inbound = telegramInboundForCase(workflowCase);
  platform.currentInbound = inbound;
  await enqueueTelegramUpdate({ platform, update: inbound.native.update });
  return inbound;
}

export async function enqueueBotEcho({ workflowCase, platform, inbound, observations }) {
  await enqueueTelegramUpdate({
    platform,
    update: telegramBotEchoUpdate({ workflowCase, inbound, observations })
  });
}

export const readPlatformCalls = readTelegramPlatformCalls;

export async function normalizeObservations({ workflowCase, inbound, calls }) {
  return normalizeTelegramObservations({
    workflowCase,
    inbound,
    calls
  });
}

export const stopPlatform = stopTelegramPlatform;
