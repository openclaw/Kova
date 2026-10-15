import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { conditionMain } from "./condition.mjs";
import { createConditionBrowser } from "./condition-browser.mjs";

const viewport = { width: 1800, height: 1000 };
const message = 'KOVA_VERIFY_HOLD {"holdMs":30000,"progressCards":false}';

async function paneState(pane) {
  return await pane.evaluate((element) => {
    const rect = (target) => {
      if (!target) return null;
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x, y, width, height };
    };
    const indicators = [...element.querySelectorAll(".chat-working-indicator")];
    return {
      workingIndicators: indicators.length,
      visibleWorkingIndicators: indicators.filter((target) => target.getClientRects().length > 0 && getComputedStyle(target).visibility !== "hidden").length,
      indicatorBounds: indicators.map(rect),
      pane: rect(element),
      thread: rect(element.querySelector(".chat-thread")),
      renderedRows: element.querySelectorAll("[data-virtual-row-key]").length,
    };
  });
}

export function frameTurnState({ sessionKey, sessionId, send, history }) {
  const page = history?.status === "completed" ? history.result : null;
  const exactSession = page?.sessionKey === sessionKey && typeof sessionId === "string" && page?.sessionId === sessionId;
  const text = (row) => typeof row.content === "string" ? row.content
    : Array.isArray(row.content) ? row.content.filter((block) => block?.type === "text").map((block) => block.text).join("") : "";
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  return {
    acceptedInput: exactSession && messages.some((row) => row.role === "user" && text(row) === message)
      && !messages.some((row) => row.role === "assistant"),
    acceptedActiveTurn: exactSession && send?.status === "completed"
      && typeof send.result?.runId === "string" && send.result.runId.length > 0
      && page?.inFlightRun?.runId === send.result.runId
      && page?.sessionInfo?.status === "running"
      && page?.sessionInfo?.hasActiveRun === true,
  };
}

export async function sessionFramePause(ctx, { openBrowser = createConditionBrowser } = {}) {
  const directory = await mkdtemp(join(dirname(ctx.options.out), "session-frame-pause-"));
  const key = `agent:main:kova-frame-${randomUUID()}`;
  const output = {
    sessionKey: key, viewport, createdIds: [],
    created: null, send: null, screens: [], recordings: [], samples: [],
  };
  try {
    let client = await ctx.connect();
    const created = await ctx.observe(client, "sessions.create", { key });
    output.created = created;
    if (created.status !== "completed") throw new Error("could not create the frame-pause session");
    output.createdIds.push(key, ...[created.result?.sessionId].filter(Boolean));
    let submitted = false;
    client.close();
    const { ui, options, videos } = await openBrowser(ctx, {
      directory, sessionKey: key, viewport, installClock: true,
      onSocket(socket) {
        let requestId;
        socket.on("framesent", ({ payload }) => {
          let frame;
          try { frame = JSON.parse(String(payload)); } catch { return; }
          if (frame.type !== "req" || frame.method !== "chat.send" || frame.params?.sessionKey !== key || frame.params?.message !== message) return;
          requestId = frame.id;
          submitted = true;
          output.send = { method: frame.method, status: "pending", sessionKey: key };
        });
        socket.on("framereceived", ({ payload }) => {
          let frame;
          try { frame = JSON.parse(String(payload)); } catch { return; }
          if (!requestId || frame.type !== "res" || frame.id !== requestId) return;
          output.send.status = frame.ok ? "completed" : "error";
          output.send.result = frame.ok ? frame.payload : null;
          output.send.errorCode = frame.ok ? null : frame.error?.code ?? null;
          if (typeof frame.payload?.runId === "string") output.createdIds.push(frame.payload.runId);
        });
      },
    });
    try {
      const opened = await ui.run(options, { signal: ctx.signal });
      output.open = opened.output;
      if (opened.exitCode !== 0) throw new Error("could not open the frame-pause session");
      // Reconnect after UI boot. Custom cleanup runs before the shared runner
      // closes clients, so the held turn can still be cancelled on interruption.
      client = await ctx.connect();
      ctx.cleanup(async () => {
        try { await ui.close(); }
        finally {
          if (submitted) {
            await client.request("chat.abort", { sessionKey: key }, { timeoutMs: 5000 });
            submitted = false;
          }
        }
      });
      const page = ui.page;
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active:visible").first();
      page.setDefaultTimeout(Math.min(10000, ctx.remaining()));
      const screenshot = async (name) => {
        const path = join(directory, `${name}.png`);
        await writeFile(path, await page.screenshot({ type: "png", timeout: ctx.remaining() }), { flag: "wx", mode: 0o600 });
        output.screens.push(path);
        return path;
      };
      await pane.locator(".agent-chat__composer-combobox textarea").fill(message);
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5000);
      output.before = await paneState(pane);
      await screenshot("before-send-frozen");
      const began = Date.now();
      await pane.locator(".agent-chat__composer-actions .chat-send-btn--send").click({ force: true });
      // Real time continues while the page clock is paused. Sampling must not
      // request animation frames from the page being measured.
      do {
        output.samples.push({ elapsedMs: Date.now() - began, ...await paneState(pane) });
        await sleep(Math.min(100, ctx.remaining()), undefined, { signal: ctx.signal });
      } while (Date.now() - began < 1500);
      output.history = await ctx.observe(client, "chat.history", { sessionKey: key, limit: 10 });
      output.frozen = await paneState(pane);
      Object.assign(output, frameTurnState({ sessionKey: key, sessionId: created.result?.sessionId, send: output.send, history: output.history }));
      output.conditionEstablished = output.acceptedActiveTurn && output.acceptedInput;
      output.screen = await screenshot("frozen-after-send");
      await page.clock.resume();
      await sleep(Math.min(1000, ctx.remaining()), undefined, { signal: ctx.signal });
      output.thawed = await paneState(pane);
      await screenshot("thawed");
      output.abort = await ctx.observe(client, "chat.abort", { sessionKey: key });
      if (output.abort.status === "completed") submitted = false;
    } finally {
      await ui.close();
      output.recordings = await Promise.all(videos.map((video) => video.path()));
    }
    output.createdIds = [...new Set(output.createdIds)];
    return output;
  } catch (error) {
    error.output = output;
    throw error;
  }
}

await conditionMain(import.meta.url, { id: "session-frame-pause", flags: [], required: [], cleanupMs: 20000, timeoutMs: 90000 }, sessionFramePause);
