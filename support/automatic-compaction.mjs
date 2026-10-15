import { readStoredSession, requireSessionContentRuntime } from "./persona/session-store-read.mjs";

const MAX_INPUT_CHARACTERS = 1000000;
const TOKEN_MARGIN = 1024;
export class CompactionInputError extends Error {}

export function compactionInput(session, key, message) {
  const budget = session?.contextBudgetStatus;
  if (session?.key !== key || typeof session.sessionId !== "string" || !session.sessionId ||
      budget?.sessionId !== session.sessionId || !Number.isFinite(budget.estimatedPromptTokens) ||
      budget.estimatedPromptTokens < 0 || !Number.isFinite(budget.promptBudgetBeforeReserve) ||
      budget.promptBudgetBeforeReserve <= 0 || budget.route !== "fits" || budget.shouldCompact !== false) {
    throw new CompactionInputError("automatic compaction requires a current, fitting measured session budget");
  }
  const headroom = budget.promptBudgetBeforeReserve - budget.estimatedPromptTokens;
  const fillerCharacters = 4 * (Math.ceil(headroom) + TOKEN_MARGIN);
  const prefix = "Additional notebook material:\n";
  if (headroom < 0 || typeof message !== "string" || !message.trim() ||
      !Number.isSafeInteger(fillerCharacters) || fillerCharacters + prefix.length + message.length + 1 > MAX_INPUT_CHARACTERS) {
    throw new CompactionInputError("automatic compaction input exceeds the bounded headroom calculation");
  }
  const input = `${prefix}${"note ".repeat(Math.ceil(fillerCharacters / 5)).slice(0, fillerCharacters)}\n${message}`;
  return { message: input, headroom, fillerCharacters, inputCharacters: input.length };
}

const nativeCompactions = (stored) => stored.events.filter(({ event }) => event.type === "compaction" && event.fromHook !== true);

export async function prepareAutomaticCompaction({ request, state, key, message, readSession = readStoredSession }) {
  let session, before, input;
  try {
    requireSessionContentRuntime();
    ({ session } = await request("sessions.describe", { key }));
    input = compactionInput(session, key, message);
    before = await readSession(state, key);
    if (before.key !== key || before.sessionId !== session.sessionId) throw new Error("session identity changed before submission");
    if (nativeCompactions(before).some(({ event }) => typeof event.id !== "string" || !event.id)) throw new Error("native compaction identity is absent");
  } catch (error) {
    if (error instanceof CompactionInputError) throw error;
    throw new CompactionInputError(`automatic compaction preparation failed: ${error.message}`);
  }
  const previous = new Set(nativeCompactions(before).map(({ event }) => event.id));
  const lastSeq = before.events.at(-1)?.seq ?? -1;
  const evidence = {
    sessionKey: key, sessionId: before.sessionId,
    before: { estimatedPromptTokens: session.contextBudgetStatus.estimatedPromptTokens, promptBudgetBeforeReserve: session.contextBudgetStatus.promptBudgetBeforeReserve, headroom: input.headroom, compactions: previous.size, lastSeq },
    inputCharacters: input.inputCharacters, fillerCharacters: input.fillerCharacters,
  };
  return {
    message: input.message,
    evidence,
    async finish(runId) {
      const after = await readSession(state, key);
      if (after.key !== key || after.sessionId !== before.sessionId) throw new Error("session identity changed during automatic compaction");
      const added = nativeCompactions(after).filter(({ seq, event }) => seq > lastSeq && typeof event.id === "string" && event.id && !previous.has(event.id));
      const result = { ...evidence, runId, after: { compactions: nativeCompactions(after).length }, newEntryIds: added.map(({ event }) => event.id), newAutomaticCompactions: added.length };
      if (!added.length) {
        const error = new Error("submitted turn completed without a new native automatic compaction");
        error.compaction = result;
        throw error;
      }
      return result;
    }
  };
}
