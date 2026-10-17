import { setTimeout as sleep } from "node:timers/promises";
import { boundedInteger, conditionMain } from "./condition.mjs";

export function searchMatches(result) {
  const rows = result?.results ?? result?.matches;
  if (!Array.isArray(rows)) throw new Error("search did not return a match list");
  return rows.map((row) => [row.sessionKey, row.sessionId, row.messageId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export async function runSearchCompleteness(ctx) {
  const client = await ctx.connect(), { options } = ctx;
  const batches = boundedInteger(options.batches, 8, 32), width = boundedInteger(options.searches, 8, 32);
  const params = { agentId: "main", sessionKeys: [options["session-key"]], query: options.query, limit: 25 };
  const warm = [];
  let expected;
  // A settled positive result is the control; absent indexing means false.
  for (let i = 0; i < 20; i++) {
    const row = await ctx.observe(client, "sessions.search", params, { timeoutMs: 30000 });
    warm.push({ status: row.status, indexing: row.result?.indexing === true, elapsedMs: row.elapsedMs });
    if (row.status === "completed" && row.result?.indexing !== true) {
      const matches = searchMatches(row.result);
      if (matches.length) { expected = matches; break; }
    }
    await sleep(300, undefined, { signal: ctx.signal });
  }
  if (!expected) throw new Error("search has no settled positive control");
  // Settle the other scoped store too; an index genuinely still being built
  // must not be mistaken for a false completion flag in the following trials.
  let scopeSettled = false;
  for (let i = 0; i < 20; i++) {
    const row = await ctx.observe(client, "sessions.search", { query: options.query, scope: { agentId: options["scope-agent"] }, limit: 25 }, { timeoutMs: 30000 });
    warm.push({ scopeAgent: options["scope-agent"], status: row.status, indexing: row.result?.indexing === true, elapsedMs: row.elapsedMs });
    if (row.status === "completed" && row.result?.indexing !== true) { searchMatches(row.result); scopeSettled = true; break; }
    await sleep(300, undefined, { signal: ctx.signal });
  }
  if (!scopeSettled) throw new Error("secondary search scope did not settle before trials");
  const trials = [];
  const ask = async (kind, request) => {
    const row = await ctx.observe(client, "sessions.search", request, { timeoutMs: 30000 });
    const matches = row.status === "completed" ? searchMatches(row.result) : null;
    trials.push({ kind, status: row.status, indexing: row.result?.indexing === true, matches, sameMatches: matches !== null && JSON.stringify(matches) === JSON.stringify(expected), elapsedMs: row.elapsedMs, ...(row.error ? { error: row.error } : {}) });
  };
  // These selectors are supported by the historical and current Gateway schemas.
  const scope = { configuredAgentsOnly: true, includeGlobal: false, includeUnknown: false, excludeSubagents: true, excludeCron: true, excludeSystem: true };
  for (let i = 0; i < 12; i++) await ask("scoped", { query: options.query, scope, limit: 25 });
  for (let batch = 0; batch < batches; batch++) await Promise.all(Array.from({ length: width }, () => ask("parallel", params)));
  return {
    conditionEstablished: true, expected, warm, trials,
    completed: trials.filter((row) => row.status === "completed").length,
    falseIndexing: trials.filter((row) => row.sameMatches && row.indexing).length,
    changedMatches: trials.filter((row) => row.status === "completed" && !row.sameMatches).length,
    requestFailures: trials.filter((row) => row.status !== "completed").length,
    completeWithoutIndexing: trials.every((row) => row.status === "completed" && row.sameMatches && !row.indexing),
    createdIds: []
  };
}

await conditionMain(import.meta.url, { id: "session-search-completeness", flags: ["session-key", "query", "scope-agent", "batches", "searches"], required: ["session-key", "query", "scope-agent"], cleanupMs: 1000, timeoutMs: 180000 }, runSearchCompleteness);
