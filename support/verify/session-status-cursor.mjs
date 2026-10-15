import { CallError } from "./background.mjs";
import { entrypoint, nonempty } from "./script.mjs";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createdSession(record, flag) {
  if (!object(record) || record.error !== null || record.method !== "sessions.create" ||
      !object(record.result) || !nonempty(record.result.key)) {
    throw new CallError(`${flag} must contain a successful sessions.create result with a key`);
  }
  return record.result.key;
}

export function projectSessionStatusCursor(source, caller, target) {
  const callerKey = createdSession(caller, "--session-from");
  const targetKey = createdSession(target, "--target-from");
  if (!object(source) || source.error !== null) {
    throw new CallError("--from must contain a successful agent-tool-turn result");
  }
  if (source.callerSessionKey !== callerKey || source.toolCall?.name !== "session_status" ||
      source.toolCall?.args?.sessionKey !== targetKey) {
    throw new CallError("session_status result does not match the caller and watched session");
  }
  const result = source.toolResult;
  if (!object(result) || (result.isError !== undefined && result.isError !== false) || !object(result.details)) {
    throw new CallError("session_status must have successful tool result details");
  }
  if (result.details.sessionKey !== targetKey) {
    throw new CallError("session_status returned a different or missing watched session");
  }
  const version = result.details.stateVersion;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new CallError("session_status stateVersion must be a nonnegative safe integer");
  }
  return { sessionKey: targetKey, changesSince: version };
}

export const definition = {
  id: "session-status-cursor", url: import.meta.url,
  envOptional: true, cancellationExitCode: 3,
  flags: ["from", "session-from", "target-from", "out"],
  empty: () => ({ sessionKey: null, changesSince: null }),
  validate(o) {
    for (const flag of this.flags) if (!nonempty(o[flag])) throw new CallError(`--${flag} requires a value`);
  },
  // The file is merged directly into session_status arguments. Diagnostics
  // belong only to stdout; failed projections never publish a usable cursor.
  fileOutput(result) {
    return result.exitCode === 0 ? { sessionKey: result.output.sessionKey, changesSince: result.output.changesSince } : undefined;
  },
  async run(o, ctx) {
    const records = await Promise.all(["from", "session-from", "target-from"].map((flag) => ctx.read(o[flag])));
    return projectSessionStatusCursor(...records);
  }
};
await entrypoint(definition);
