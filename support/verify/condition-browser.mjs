import { createRequire } from "node:module";
import { join } from "node:path";

// Authentication, navigation and browser ownership stay with the Control UI
// implementation. This adapter adds only condition-specific recording/hooks.
export async function createConditionBrowser(ctx, { directory, sessionKey, viewport, installClock = false, onSocket = () => {} }, overrides = {}) {
  let createBrowser = overrides.createBrowser;
  if (!createBrowser) {
    try { ({ createControlUiBrowser: createBrowser } = await import("./control-ui.mjs")); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      throw new Error("browser conditions require the Control UI browser support");
    }
  }
  const chromium = overrides.chromium ?? createRequire(join(ctx.runtime.packageRoot, "package.json"))("playwright-core").chromium;
  const videos = [];
  const options = {
    env: ctx.options.env, flow: "open-session-keep-open", "session-key": sessionKey,
    "artifact-dir": directory, timeoutMs: ctx.remaining(),
  };
  const ui = await createBrowser(options, {
    signal: ctx.signal,
    prepare: () => ctx.runtime,
    launch: async (settings) => {
      const browser = await chromium.launch(settings);
      if (ctx.signal.aborted) { await browser.close(); ctx.signal.throwIfAborted(); }
      const close = browser.close.bind(browser), contexts = [];
      let closing;
      browser.close = () => closing ??= (async () => {
        try { for (const context of contexts) await context.close(); }
        finally { await close(); }
      })();
      ctx.cleanup(() => browser.close());
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (settings) => {
        const context = await newContext({ ...settings, viewport, recordVideo: { dir: join(directory, "video"), size: viewport } });
        contexts.push(context);
        context.on("page", (page) => {
          const video = page.video();
          if (video) videos.push(video);
          page.on("websocket", onSocket);
        });
        if (installClock) {
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            await page.clock.install();
            return page;
          };
        }
        return context;
      };
      return browser;
    },
  });
  ctx.cleanup(() => ui.close());
  return { ui, options, videos };
}
