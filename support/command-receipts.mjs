import { runProcess } from "./process.mjs";

export async function runRecordedCommand(command, args, options = {}) {
  const result = await runProcess(command, args, options.timeoutMs ?? 30000);
  return {
    ...result,
    command: [command, ...args].join(" "),
    stdout: truncateCommandOutput(result.stdout),
    stderr: truncateCommandOutput(result.stderr)
  };
}

export function compactCommand(result) {
  return {
    command: result.command,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncateCommandOutput(result.stdout, 1200),
    stderr: truncateCommandOutput(result.stderr, 1200)
  };
}

function truncateCommandOutput(value, limit = 4000) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}

export function commandOutputSnippet(value) {
  return truncateCommandOutput(String(value ?? "").replace(/\s+/g, " ").trim(), 500);
}
