export const CHANNEL_DRIVER_CONTRACT = Object.freeze([
  "startPlatform",
  "configureOpenClaw",
  "startOpenClaw",
  "enqueueUserEvent",
  "enqueueBotEcho",
  "readPlatformCalls",
  "normalizeObservations",
  "stopPlatform"
]);

export function validateChannelDriver(driver, channelId) {
  const missing = CHANNEL_DRIVER_CONTRACT.filter((name) => typeof driver?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`channel driver '${channelId}' is missing required export${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  return driver;
}
