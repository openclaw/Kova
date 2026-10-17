import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeCondition } from "../support/verify/condition.mjs";
import { createConditionBrowser } from "../support/verify/condition-browser.mjs";
import { frameTurnState, sessionFramePause } from "../support/verify/session-frame-pause.mjs";
import { sessionCardDismiss } from "../support/verify/session-card-dismiss.mjs";

async function fixture(t, { signal } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kova-condition-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [], calls = [], cards = new Map();
  let nextClient = 0;
  const dependencies = {
    signal,
    prepare: () => ({ root, packageRoot: root }),
    admit: async (runtime) => runtime,
    connect: async () => {
      const id = ++nextClient;
      let closed = false;
      return { client: {
        close() { closed = true; events.push(`client-close:${id}`); },
        async request(method, params) {
          assert.equal(closed, false, "RPC must use a live observer");
          calls.push({ method, params, client: id });
          if (method === "sessions.create") return { key: params.key, sessionId: `session-${id}` };
          if (method === "progressCard.put") {
            const card = { sessionKey: params.sessionKey, revision: 1, markdown: params.markdown, steps: params.plan ?? [] };
            cards.set(params.sessionKey, card);
            return { card };
          }
          if (method === "progressCard.get") return { card: cards.get(params.sessionKey) };
          if (method === "chat.abort") { events.push("turn-abort"); return { ok: true }; }
          throw new Error(`unexpected method ${method}`);
        },
      } };
    },
  };
  return {
    root, events, calls, cards,
    run: (run) => executeCondition({ id: "browser-test" }, { env: "kova-run-browser", out: join(root, "result.json"), timeoutMs: 10000 }, run, dependencies),
  };
}

test("browser adapter flushes contexts before process close and closes exactly once", async (t) => {
  for (const failClose of [false, true]) {
    const f = await fixture(t);
    const page = new EventEmitter();
    page.video = () => ({ path: async () => join(f.root, "recording.webm") });
    page.clock = { install: async () => f.events.push("clock-install") };
    const context = new EventEmitter();
    context.newPage = async () => { context.emit("page", page); return page; };
    context.close = async () => { f.events.push("context-close"); if (failClose) throw new Error("video flush failed"); };
    const browser = {
      newContext: async () => context,
      close: async () => f.events.push("process-close"),
    };
    const result = await f.run(async (ctx) => {
      const recording = await createConditionBrowser(ctx, {
        directory: f.root, sessionKey: "agent:main:fixture", viewport: { width: 1800, height: 1000 }, installClock: true,
        onSocket: () => f.events.push("socket-observed"),
      }, {
        chromium: { launch: async () => browser },
        createBrowser: async (_options, controls) => {
          const launched = await controls.launch({});
          const opened = await launched.newContext({});
          const target = await opened.newPage();
          target.emit("websocket", {});
          return { close: () => launched.close() };
        },
      });
      assert.equal(recording.videos.length, 1);
      await recording.ui.close();
      return {};
    });
    assert.equal(result.exitCode, failClose ? 1 : 0);
    assert.deepEqual(f.events, ["clock-install", "socket-observed", "context-close", "process-close"]);
  }
});

test("cancellation during browser launch closes the late process before returning", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal });
  let launched, release;
  const started = new Promise((resolve) => { launched = resolve; });
  const pending = f.run((ctx) => createConditionBrowser(ctx, {
    directory: f.root, sessionKey: "agent:main:fixture", viewport: { width: 1800, height: 1000 },
  }, {
    chromium: { launch: () => { launched(); return new Promise((resolve) => { release = resolve; }); } },
    createBrowser: async (_options, controls) => controls.launch({}),
  }));
  await started;
  controller.abort(new Error("cancelled during launch"));
  release({ close: async () => f.events.push("process-close") });
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /cancelled during launch/);
  assert.deepEqual(f.events, ["process-close"]);
});

test("browser initialization failure still closes the process through condition cleanup", async (t) => {
  const f = await fixture(t);
  const result = await f.run((ctx) => createConditionBrowser(ctx, {
    directory: f.root, sessionKey: "agent:main:fixture", viewport: { width: 1800, height: 1000 },
  }, {
    chromium: { launch: async () => ({ newContext: async () => {}, close: async () => f.events.push("process-close") }) },
    createBrowser: async (_options, controls) => {
      await controls.launch({});
      throw new Error("page initialization failed");
    },
  }));
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /page initialization failed/);
  assert.deepEqual(f.events, ["process-close"]);
});

test("frame activity requires the accepted run, physical session and unfinished input", () => {
  const sessionKey = "agent:main:frame", sessionId = "physical-session";
  const send = { status: "completed", result: { runId: "new-run" } };
  const payload = {
    sessionKey, sessionId, inFlightRun: { runId: "new-run" },
    sessionInfo: { status: "running", hasActiveRun: true },
    messages: [{ role: "user", content: 'KOVA_VERIFY_HOLD {"holdMs":30000,"progressCards":false}' }],
  };
  const state = (change = {}) => frameTurnState({ sessionKey, sessionId, send, history: { status: "completed", result: { ...payload, ...change } } });
  assert.deepEqual(state(), { acceptedInput: true, acceptedActiveTurn: true });
  assert.equal(state({ inFlightRun: { runId: "older-run" } }).acceptedActiveTurn, false);
  assert.equal(state({ sessionId: "replaced-session" }).acceptedActiveTurn, false);
  assert.equal(state({ sessionKey: "agent:main:other" }).acceptedInput, false);
  assert.equal(state({ sessionInfo: { status: "completed", hasActiveRun: true } }).acceptedActiveTurn, false);
  assert.equal(state({ messages: [...payload.messages, { role: "assistant", content: "Already finished" }] }).acceptedInput, false);
  assert.equal(frameTurnState({ sessionKey, sessionId, send, history: { status: "timeout" } }).acceptedActiveTurn, false);
});

test("interrupted frame send closes the browser, aborts the turn and retains its evidence", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal });
  const result = await f.run((ctx) => sessionFramePause(ctx, {
    openBrowser: async (_ctx, options) => {
      const socket = new EventEmitter();
      options.onSocket(socket);
      let input, paused = false, closed = false;
      const pane = {
        evaluate: async () => ({ workingIndicators: 0 }),
        locator: (selector) => selector.includes("textarea") ? { fill: async (value) => { input = value; } } : {
          click: async () => {
            assert.equal(paused, true, "frames must stop before a new send");
            socket.emit("framesent", { payload: JSON.stringify({ type: "req", id: "send", method: "chat.send", params: { sessionKey: options.sessionKey, message: input } }) });
            socket.emit("framereceived", { payload: JSON.stringify({ type: "res", id: "send", ok: true, payload: { runId: "new-run" } }) });
            controller.abort(new Error("stop after accepted send"));
          },
        },
      };
      return {
        options: {}, videos: [],
        ui: {
          run: async () => ({ exitCode: 0, output: {} }),
          close: async () => { if (!closed) f.events.push("browser-close"); closed = true; },
          page: {
            setDefaultTimeout() {}, locator: () => ({ first: () => pane }), evaluate: async () => Date.now(),
            screenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            clock: { pauseAt: async () => { paused = true; } },
          },
        },
      };
    },
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.send.result.runId, "new-run");
  assert.ok(result.output.createdIds.includes("new-run"));
  assert.ok(f.events.indexOf("browser-close") < f.events.indexOf("turn-abort"));
  assert.equal(f.calls.filter((call) => call.method === "chat.abort").length, 1);
  assert.equal(result.output.screens.length, 1);
  await access(result.output.screens[0]);
});

test("card observation preserves absent actions and accepted unchanged cards with fresh readers", async (t) => {
  for (const offered of [false, true]) {
    const f = await fixture(t);
    const result = await f.run((ctx) => sessionCardDismiss(ctx, {
      openBrowser: async (_ctx, options) => {
        const socket = new EventEmitter();
        options.onSocket(socket);
        // These frames must never become result-file content.
        socket.emit("framesent", { payload: JSON.stringify({ type: "req", id: "connect", method: "connect", params: { token: "private-token-sentinel" } }) });
        const button = {
          count: async () => offered ? 1 : 0,
          click: async () => {
            assert.equal(offered, true);
            socket.emit("framesent", { payload: JSON.stringify({ type: "req", id: "dismiss", method: "progressCard.put", params: { sessionKey: options.sessionKey, expectedRevision: 1 } }) });
            socket.emit("framereceived", { payload: JSON.stringify({ type: "res", id: "dismiss", ok: true, payload: { card: f.cards.get(options.sessionKey) } }) });
          },
        };
        const card = { waitFor: async () => {}, locator: () => button, isVisible: async () => true };
        return {
          options: {}, videos: [],
          ui: {
            run: async () => ({ exitCode: 0, output: {} }), close: async () => {},
            page: {
              setDefaultTimeout() {}, locator: () => ({ first: () => ({ locator: () => card }) }),
              screenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            },
          },
        };
      },
    }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.cases.length, 2);
    assert.equal(JSON.stringify(result.output).includes("private-token-sentinel"), false);
    for (const row of result.output.cases) {
      assert.equal(row.conditionEstablished, true);
      assert.equal(row.actionOffered, offered);
      assert.equal(row.accepted, offered);
      assert.equal(row.disappeared, false);
      assert.equal(row.observationComplete, true);
      assert.equal(row.wire.length, offered ? 1 : 0);
      if (offered) assert.deepEqual(row.wire[0].request.params, { sessionKey: row.sessionKey, expectedRevision: 1 });
      const reads = f.calls.filter((call) => call.method === "progressCard.get" && call.params.sessionKey === row.sessionKey);
      assert.equal(reads.length, 2);
      assert.notEqual(reads[0].client, reads[1].client);
      const put = f.calls.find((call) => call.method === "progressCard.put" && call.params.sessionKey === row.sessionKey);
      assert.deepEqual(put.params.plan, row.type === "unfinished" ? [{ step: "Unfinished work", status: "in_progress" }] : undefined);
    }
    for (const path of result.output.screens) await access(path);
  }
});
