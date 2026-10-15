import assert from "node:assert/strict";

export function assertChatHistorySelectors(method, params) {
  if (method !== "chat.history") return;
  // Pinned 7e80556f chat-history-handler.ts checks this after schema validation.
  assert.ok(params.sessionId === undefined || params.messageId !== undefined, "chat.history handler: sessionId requires messageId");
}
