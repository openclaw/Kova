import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { conditionMain } from "./condition.mjs";
import { createConditionBrowser } from "./condition-browser.mjs";

const viewport = { width: 1440, height: 1000 };

export async function sessionCardDismiss(ctx, { openBrowser = createConditionBrowser } = {}) {
  const directory = await mkdtemp(join(dirname(ctx.options.out), "session-card-dismiss-"));
  const output = { viewport, cases: [], createdIds: [], screens: [], recordings: [] };
  try {
    for (const type of ["unfinished", "note-only"]) {
      const key = `agent:main:kova-dismiss-${randomUUID()}`;
      const client = await ctx.connect();
      const created = await ctx.observe(client, "sessions.create", { key });
      if (created.status !== "completed") throw new Error("could not create the card-dismiss session");
      output.createdIds.push(key, ...[created.result?.sessionId].filter(Boolean));
      const putParams = {
        sessionKey: key, markdown: "Kova dismissal observation",
        ...(type === "unfinished" ? { plan: [{ step: "Unfinished work", status: "in_progress" }] } : {}),
      };
      const put = await ctx.observe(client, "progressCard.put", putParams);
      client.close();
      if (put.status !== "completed") throw new Error("could not create the progress card");
      const row = { type, sessionKey: key, created, put: { params: putParams, ...put }, wire: [], screens: [] };
      output.cases.push(row);
      const caseDirectory = await mkdtemp(join(directory, `${type}-`));
      const { ui, options, videos } = await openBrowser(ctx, {
        directory: caseDirectory, sessionKey: key, viewport,
        onSocket(socket) {
          const pending = new Map();
          socket.on("framesent", ({ payload }) => {
            let frame;
            try { frame = JSON.parse(String(payload)); } catch { return; }
            if (frame.type !== "req" || frame.method !== "progressCard.put" || frame.params?.sessionKey !== key) return;
            // Only this freshly created synthetic card is recorded. Never
            // retain authentication frames or unrelated browser traffic.
            const record = { request: { method: frame.method, params: frame.params }, status: "pending" };
            row.wire.push(record);
            pending.set(frame.id, { record, began: Date.now() });
          });
          socket.on("framereceived", ({ payload }) => {
            let frame;
            try { frame = JSON.parse(String(payload)); } catch { return; }
            if (frame.type !== "res" || !pending.has(frame.id)) return;
            const { record, began } = pending.get(frame.id);
            pending.delete(frame.id);
            record.status = frame.ok ? "completed" : "error";
            record.response = { ok: frame.ok, ...(frame.ok ? { payload: frame.payload } : { errorCode: frame.error?.code ?? null }) };
            record.elapsedMs = Date.now() - began;
          });
          socket.on("close", () => {
            for (const { record, began } of pending.values()) {
              record.status = "closed";
              record.elapsedMs = Date.now() - began;
            }
            pending.clear();
          });
        },
      });
      try {
        const opened = await ui.run(options, { signal: ctx.signal });
        row.open = opened.output;
        if (opened.exitCode !== 0) throw new Error("could not open the card-dismiss session");
        const page = ui.page;
        page.setDefaultTimeout(Math.min(10000, ctx.remaining()));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active:visible").first();
        const card = pane.locator(".session-progress-card--composer");
        await card.waitFor({ state: "visible" });
        const button = card.locator(".session-progress-card__dismiss");
        row.buttonCount = await button.count();
        const readCard = async () => {
          const observer = await ctx.connect();
          try { return await ctx.observe(observer, "progressCard.get", { sessionKey: key }); }
          finally { observer.close(); }
        };
        const screenshot = async (name) => {
          const path = join(caseDirectory, `${name}.png`);
          await writeFile(path, await page.screenshot({ type: "png", timeout: ctx.remaining() }), { flag: "wx", mode: 0o600 });
          row.screens.push(path);
          output.screens.push(path);
          return path;
        };
        row.before = await readCard();
        const stored = row.before.result?.card;
        const steps = stored?.steps ?? [];
        row.conditionEstablished = row.before.status === "completed" && stored?.sessionKey === key
          && stored.markdown === putParams.markdown && Array.isArray(steps)
          && (type === "note-only" ? steps.length === 0 : steps.some((step) => step.status === "in_progress"));
        row.beforeVisible = await card.isVisible();
        await screenshot("before");
        if (row.buttonCount > 0) {
          await button.click();
          const deadline = Date.now() + Math.min(5000, ctx.remaining());
          while ((!row.wire.length || row.wire.some((record) => record.status === "pending")) && Date.now() < deadline) {
            await sleep(Math.min(25, ctx.remaining()), undefined, { signal: ctx.signal });
          }
          for (const record of row.wire) if (record.status === "pending") record.status = "timeout";
          // The request has settled (or its bounded observation expired). Give
          // the UI the same short settling window on every tested revision.
          await sleep(Math.min(750, ctx.remaining()), undefined, { signal: ctx.signal });
        }
        row.after = await readCard();
        row.cardVisible = await card.isVisible();
        row.actionOffered = row.buttonCount > 0;
        row.accepted = row.wire.some((record) => record.response?.ok === true);
        row.disappeared = row.beforeVisible && !row.cardVisible;
        row.observationComplete = row.before.status === "completed" && row.after.status === "completed"
          && (!row.actionOffered || row.wire.length > 0 && row.wire.every((record) => ["completed", "error"].includes(record.status)));
        output.screen = await screenshot("after");
      } finally {
        await ui.close();
        output.recordings.push(...await Promise.all(videos.map((video) => video.path())));
      }
    }
    output.createdIds = [...new Set(output.createdIds)];
    return output;
  } catch (error) {
    error.output = output;
    throw error;
  }
}

await conditionMain(import.meta.url, { id: "session-card-dismiss", flags: [], required: [], cleanupMs: 15000, timeoutMs: 120000 }, sessionCardDismiss);
