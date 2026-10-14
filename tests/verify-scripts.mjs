import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CallError } from "../support/verify/background.mjs";
import { scriptMain } from "../support/verify/script.mjs";
import { definition as chat } from "../support/verify/chat-send.mjs";
import { definition as hold } from "../support/verify/session-turn-hold.mjs";
import { definition as tool, toolArguments } from "../support/verify/agent-tool-turn.mjs";
import { definition as history, readDelta } from "../support/verify/chat-history-read.mjs";
import { definition as goal } from "../support/verify/goal-control.mjs";
import { definition as cron } from "../support/verify/cron-isolated-run.mjs";
import { definition as heartbeat } from "../support/verify/heartbeat-wake.mjs";
import { definition as channel, inboundParams } from "../support/verify/channel-inbound-turn.mjs";
import { definition as publicThread } from "../support/verify/public-thread-read.mjs";
import { definition as resume } from "../support/verify/run-resume.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";
const schemas = await loadGatewaySchemaAssertions();
const key = "agent:main:example";
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "kova-verify-scripts-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function run(definition, flags, rpc, context) {
  const requests = [];
  const result = await scriptMain(definition, ["--env", "kova-scripts-example", ...flags], {
    context,
    rpc: async (method, params, ctx) => {
      requests.push({ method, params: structuredClone(params) });
      return await rpc(method, params, ctx);
    }
  });
  for (const { method, params } of requests) schemas.check(method, params);
  return result;
}
function turnRpc({ toolResult = false } = {}) {
  let runId;
  return async (method, params) => {
    if (["chat.send", "sessions.send"].includes(method)) { runId = params.idempotencyKey; return { runId, status: "started" }; }
    if (method === "agent.wait") return { runId, status: "ok" };
    if (method === "chat.history") return { sessionId: "one", hasMore: false, messages: [
      { role: "assistant", content: [{ type: "text", text: "old answer" }], __openclaw: { runId: "old-run" } },
      { role: "assistant", content: toolResult ? [{ type: "toolCall", id: "call-one", name: "sessions_spawn", arguments: {} }] : [{ type: "text", text: "new answer" }], __openclaw: { runId } },
      ...(toolResult ? [{ role: "toolResult", toolCallId: "call-one", details: { status: "accepted", childSessionKey: "agent:main:child", runId: "child-run" }, __openclaw: { runId } }] : [])
    ] };
    throw new Error(`unexpected request ${method}`);
  };
}

test("chat-send binds only the submitted answer and sends declared options", async () => {
  const rpc = turnRpc();
  let sent;
  const result = await run(chat, ["--session-key", key, "--message", "hello", "--queue-mode", "followup", "--intent", "session-goal-start", "--expected-leaf", "leaf"], async (method, params) => {
    if (method === "chat.send") sent = params;
    return rpc(method, params);
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.reply.length, 1);
  assert.equal(result.output.reply[0].content[0].text, "new answer");
  assert.equal(sent.queueMode, "followup");
  assert.deepEqual(result.output.createdIds, [sent.idempotencyKey]);
});

test("session-turn-hold sends the per-call duration and progress choice", async () => {
  const rpc = turnRpc(); let message;
  const result = await run(hold, ["--session-key", key, "--hold-ms", "240000", "--progress-cards", "--timeout", "290000"], async (method, params) => {
    if (method === "sessions.send") message = params.message;
    return rpc(method, params);
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(message.slice("KOVA_VERIFY_HOLD ".length)), { holdMs: 240000, progressCards: true });
  assert.equal(result.output.sessionKey, key);
});

test("agent-tool-turn records accepted child identities, never the caller as child", async () => {
  const result = await run(tool, ["--session-key", key, "--tool", "sessions_spawn", "--args", '{"task":"example"}'], turnRpc({ toolResult: true }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.callerSessionKey, key);
  assert.equal(result.output.sessionKey, "agent:main:child");
  assert.deepEqual(result.output.createdIds, ["agent:main:child", "child-run"]);
  const read = async () => result.output;
  assert.deepEqual(await toolArguments({ args: '{"action":"wait"}', tool: "subagents", from: "file" }, { read }, key), { action: "wait", runIds: ["child-run"] });
  await assert.rejects(toolArguments({ args: '{}', tool: "sessions_send", from: "file" }, { read }, "agent:main:other"), /this caller/);
});

test("chat-history-read follows the returned cursor and fetches the requested message", async () => {
  const result = await run(history, ["--session-key", key, "--limit", "2", "--message-id", "anchor"], async (method, params) => {
    if (method === "chat.startup") return { sessionId: "one", messages: ["latest"], hasMore: true, olderCursor: "older" };
    if (method === "chat.history") { assert.equal(params.cursor, "older"); return { sessionId: "one", messages: ["older"], hasMore: false }; }
    if (method === "chat.message.get") return { ok: false, unavailableReason: "not_found" };
    throw new Error(method);
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.messages, ["latest", "older"]);
  assert.equal(result.output.pages[2].ok, false);
});

test("goal-control edits and replays the exact acknowledged request", async (t) => {
  const dir = await directory(t), out = join(dir, "goal.json");
  const rpc = async (method, params) => ({ operationId: params.operationId, goal: { id: params.goalId }, replayed: undefined });
  const result = await run(goal, ["--session-key", key, "--goal-id", "goal-one", "--action", "edit", "--objective", "new objective", "--out", out], rpc);
  assert.equal(result.exitCode, 0);
  const saved = JSON.parse(await readFile(out, "utf8"));
  let replayed;
  const replay = await run(goal, ["--session-key", key, "--goal-id", "goal-one", "--action", "edit", "--replay", "--from", out], async (method, params) => {
    replayed = { method, params }; return { ...await rpc(method, params), replayed: true };
  });
  assert.equal(replay.exitCode, 0);
  assert.deepEqual(replayed, saved.request);
  assert.deepEqual(replay.output.createdIds, []);
  const conflict = await run(goal, ["--session-key", key, "--goal-id", "other", "--action", "edit", "--replay", "--from", out], () => assert.fail("must refuse before send"));
  assert.equal(conflict.exitCode, 2);
  const clear = await run(goal, ["--session-key", key, "--goal-id", "goal-one", "--action", "clear"], rpc);
  assert.equal(clear.exitCode, 0);
});

test("cron-isolated-run binds completion to its enqueue receipt", async () => {
  let count = 0;
  const result = await run(cron, ["--job-id", "job-one"], async (method, params) => {
    if (method === "cron.get") return { job: { sessionTarget: "isolated" } };
    if (method === "cron.run") return { ok: true, enqueued: true, runId: "run-one" };
    assert.equal(params.runId, "run-one");
    return { entries: [{ runId: ++count === 1 ? "old-run" : "run-one", action: "finished", sessionKey: key, status: "error" }] };
  });
  assert.equal(result.exitCode, 0);
  assert.equal(count, 2);
  assert.equal(result.output.result.finished.status, "error");
});

test("heartbeat-wake records the scheduling response without inventing delivery", async () => {
  const result = await run(heartbeat, [], async (method, params) => { if (method === "sessions.resolve") return { key }; assert.equal(method, "wake"); assert.equal(params.mode, "now"); assert.equal(params.sessionKey, key); return { ok: true }; });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.woke, { ok: true });
  assert.equal(result.output.notices.disposition, "submitted");
});

test("channel-inbound-turn sends an actual group/thread request", async () => {
  const result = await run(channel, ["--chat-type", "thread", "--peer", "group:room/thread:topic", "--text", "@bot hello"], async (method, params) => {
    assert.equal(params.chatType, "group"); assert.equal(params.targetId, "group:room"); assert.equal(params.threadId, "topic");
    return { observation: { routeSessionKey: key, inboundEvent: { id: "new-input" }, outboundRecords: [{ messageId: "delivered" }] } };
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.createdIds, ["new-input", "delivered"]);
  assert.equal(inboundParams({ "chat-type": "direct", peer: "dm:someone", text: "hello" }).chatType, "direct");
});

test("public-thread-read redacts share tokens and preserves HTTP outcomes", async () => {
  const token = "example/share+token";
  const urls = [];
  const result = await run(publicThread, ["--session-key", key], async () => ({ publicShare: { token } }), {
    runtime: () => ({ gatewayPort: 18789 }), config: {},
    fetchDocument: async (url) => { urls.push(url); return { status: urls.length === 1 ? 404 : 200, body: `link ${token} ${encodeURIComponent(token)}` }; }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, 404);
  assert.equal(JSON.stringify(result.output).includes(token), false);
  assert.equal(JSON.stringify(result.output).includes(encodeURIComponent(token)), false);
  assert.match(urls[1], /\/share\/chat\/main\/~key\/example$/);
});

test("run-resume uses the selected environment and validates handoff identity", async (t) => {
  const dir = await directory(t), source = join(dir, "handoff.json");
  await writeFile(source, JSON.stringify({ handoff: { version: 1, sessionKey: key, gatewayUrl: "ws://127.0.0.1:18789" } }));
  let actual;
  const result = await run(resume, ["--handoff-from", source], () => assert.fail("PTY owns product requests"), {
    runtime: () => ({ gatewayPort: 18789 }),
    pty: async (args) => { actual = args; return { resolved: key, output: "session selected", createdIds: [] }; }
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(actual.slice(0, 4), ["@kova-scripts-example", "--", "resume", "--handoff"]);
  await writeFile(source, JSON.stringify({ handoff: { version: 1, sessionKey: key, gatewayUrl: "ws://127.0.0.1:19876" } }));
  assert.equal((await run(resume, ["--handoff-from", source], () => {}, { runtime: () => ({ gatewayPort: 18789 }), pty: () => assert.fail("foreign Gateway") })).exitCode, 2);
});

test("script entrypoints distinguish malformed input, product error and own timeout", async () => {
  for (const definition of [chat, hold, tool, history, goal, cron, heartbeat, channel, publicThread, resume]) {
    const result = await scriptMain(definition, ["--unlisted", "x"]);
    assert.equal(result.exitCode, 2, definition.id);
    for (const field of Object.keys(definition.empty())) assert.ok(Object.hasOwn(result.output, field), `${definition.id} ${field}`);
  }
  const refused = await run(heartbeat, [], async () => { throw new CallError("product refusal", 1); });
  assert.equal(refused.exitCode, 1);
  const timed = await run(heartbeat, ["--timeout", "5"], async (method, params, ctx) => { await ctx.pause(50); ctx.remaining(); });
  assert.equal(timed.exitCode, 3);
});

test("verification scripts emit requests accepted by the pinned Gateway schemas", (t) => schemas.report(t));

test("history subscription records an idle delta as a result", async () => {
  const requests = [];
  const result = await readDelta(async (method, params) => {
    requests.push({ method, params });
    if (method === "sessions.messages.subscribe") return { subscribed: true };
    return params.cursor ? { kind: "delta", messages: [], deltaCursor: "next" } : { messages: [], deltaCursor: "cursor" };
  }, key, 100);
  for (const request of requests) schemas.check(request.method, request.params);
  assert.equal(result.pages[1].kind, "delta");
  assert.deepEqual(result.messages, []);
});

test("accepted turn evidence survives a later product refusal", async () => {
  let runId;
  const result = await run(chat, ["--session-key", key, "--message", "hello"], async (method, params) => {
    if (method === "chat.send") { runId = params.idempotencyKey; return { runId }; }
    throw new CallError("wait refused", 1);
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.receipt.runId, runId);
  assert.deepEqual(result.output.createdIds, [runId]);
});

test("resume resolves main and short session URLs before handing them to the TUI", async (t) => {
  const dir = await directory(t), source = join(dir, "url.json");
  for (const [url, selector] of [["http://127.0.0.1:18789/chat/main", { key: "main", agentId: "main" }], ["http://127.0.0.1:18789/chat/main/notebook-01234567", { shortId: "01234567", slugHint: "notebook", agentId: "main", allowMissing: true }]]) {
    await writeFile(source, JSON.stringify({ url }));
    const result = await run(resume, ["--url-from", source], async (method, params) => { if (method === "agents.list") return { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [] }; assert.equal(method, "sessions.resolve"); assert.deepEqual(params, selector); return { ok: true, key, agentId: "main" }; }, {
      runtime: () => ({ gatewayPort: 18789 }), pty: async () => ({ resolved: key, output: "attached", createdIds: [] })
    });
    assert.equal(result.exitCode, 0);
  }
});

test("goal replay refuses a request differing from the acknowledged operation", async (t) => {
  const dir = await directory(t), from = join(dir, "changed.json");
  await writeFile(from, JSON.stringify({ error: null, operationId: "acknowledged", request: { method: "sessions.goal.clear", params: { sessionKey: key, goalId: "goal-one", operationId: "other", issuedAtMs: 1 } } }));
  const result = await run(goal, ["--session-key", key, "--goal-id", "goal-one", "--action", "clear", "--replay", "--from", from], () => assert.fail("must not send a different operation"));
  assert.equal(result.exitCode, 2);
});

test("nested tool results retain newly accepted send identifiers", async () => {
  let runId;
  const result = await run(tool, ["--session-key", key, "--tool", "sessions_send", "--args", '{"sessionKey":"agent:main:other","message":"hello"}'], async (method, params) => {
    if (method === "chat.send") { runId = params.idempotencyKey; return { runId }; }
    if (method === "agent.wait") return { runId, status: "ok" };
    return { messages: [{ role: "custom", __openclaw: { runId }, content: [
      { type: "toolCall", id: "nested-call", name: "sessions_send", arguments: {} },
      { role: "toolResult", toolCallId: "nested-call", details: { sessionKey: "agent:main:other" }, content: [{ type: "text", text: JSON.stringify({ status: "ok", sessionKey: "agent:main:other", runId: "new-send" }) }] }
    ] }], hasMore: false };
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.createdIds, ["new-send"]);
  assert.equal(result.output.toolResult.details.sessionKey, "agent:main:other");
  assert.equal(result.output.toolResult.details.runId, "new-send");
});

test("internal background entry mode is not a public CLI flag", async () => {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../support/verify/heartbeat-wake.mjs", import.meta.url)), "--worker"], { timeout: 5000 }).catch((error) => error);
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stdout).error, /worker/);
});

test("resume launches OpenClaw under an actual PTY and waits for connection", async (t) => {
  const available = spawnSync("expect", ["-v"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT" && !process.env.CI) { t.skip("expect is not installed"); return; }
  assert.equal(available.status, 0, available.error?.message ?? available.stderr);
  const dir = await directory(t), binary = join(dir, "ocm");
  await writeFile(binary, `#!${process.execPath}
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(5);
console.log("openclaw tui - ws://127.0.0.1:1234 - agent main - session sample   " + String.fromCharCode(27) + "]8;;" + String.fromCharCode(7));
let connected=false;
setTimeout(()=>{connected=true;console.log("gateway connected");},150);
process.stdin.on("data",(input)=>{if(input.toString().includes("/exit"))process.exit(connected?0:6);});
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const result = await scriptMain(resume, ["--env", "kova-scripts-fixture", "--query", key, "--timeout", "5000"]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.match(result.output.output, /gateway connected/);
  assert.deepEqual(result.output.resolved, ["main", "sample"]);
});

test("resume recognizes an exact URL marker before decoding literal tildes", async (t) => {
  const dir = await directory(t), source = join(dir, "literal-url.json");
  for (const [suffix, expected] of [["~~key", "~key"], ["~key/~~key", "~key"], ["~dot", "."], ["~~dot", "~dot"]]) {
    await writeFile(source, JSON.stringify({ url: `http://127.0.0.1:18789/chat/main/${suffix}` }));
    let handoff;
    const result = await run(resume, ["--url-from", source], (method, params) => {
      assert.notEqual(suffix, "~key/~~key", "exact paths must not resolve");
      if (method === "agents.list") return { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [] };
      assert.equal(method, "sessions.resolve");
      assert.deepEqual(params, { reference: { key: `agent:main:${expected}`, slug: expected }, agentId: "main", includeGlobal: true, includeUnknown: true, allowMissing: true });
      return { ok: true, key: `agent:main:${expected}`, agentId: "main" };
    }, {
      runtime: () => ({ gatewayPort: 18789 }), pty: async (args) => { handoff = JSON.parse(Buffer.from(args.at(-1), "base64url").toString()); return { resolved: handoff.sessionKey, output: "attached", createdIds: [] }; }
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(handoff.sessionKey, `agent:main:${expected}`);
  }
  await writeFile(source, JSON.stringify({ url: "http://127.0.0.1:18789/chat/main/~key" }));
  assert.equal((await run(resume, ["--url-from", source], () => assert.fail("missing exact key"), { runtime: () => ({ gatewayPort: 18789 }) })).exitCode, 2);
});


test("chat delay preserves the full call budget and supports cancellation before sending", async () => {
  let calls = 0;
  const delayed = await run(chat, ["--session-key", key, "--message", "hello", "--after-ms", "60", "--timeout", "30"], async () => { calls++; return { status: "accepted" }; });
  assert.equal(delayed.exitCode, 0, JSON.stringify(delayed.output));
  assert.equal(calls, 1);
  assert.ok(delayed.output.elapsedMs >= 50);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CallError("cancelled before send", 1)), 10);
  try {
    const cancelled = await scriptMain(chat, ["--env", "kova-scripts-probe", "--session-key", key, "--message", "hello", "--after-ms", "100", "--timeout", "30"], { signal: controller.signal, rpc: () => assert.fail("cancelled delay must not send") });
    assert.equal(cancelled.exitCode, 1);
    assert.equal(cancelled.output.error, "cancelled before send");
  } finally { clearTimeout(timer); }
});


test("synchronous environment lookup deadlines remain helper timeouts", async () => {
  for (const delay of [0, 50]) {
    const result = await scriptMain(resume, ["--env", "kova-scripts-probe", "--url-from", "url.json", "--timeout", "20"], {
      context: { read: async () => ({ url: "http://127.0.0.1:18789/chat/main" }) },
      prepare: () => {
        if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        throw Object.assign(new Error("environment lookup failed"), { code: "ETIMEDOUT" });
      },
      rpc: () => assert.fail("failed lookup must not send a request")
    });
    assert.equal(result.exitCode, delay ? 3 : 1);
    assert.equal(result.output.error, delay ? "verification timeout" : "environment lookup failed");
  }
});
