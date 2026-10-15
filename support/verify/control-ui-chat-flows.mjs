import { CallError } from "./background.mjs";
import { revealSidebarSession } from "./control-ui-session-flows.mjs";

const heldMessage = "VERIFY_HOLD";
const replyMessage = "Reply with exact ASCII text KOVA_AGENT_OK only.";
const storagePath = "/settings/ai-agents?section=session";

const activePane = (page) => page.locator("openclaw-chat-pane.chat-pane-cache__pane--active:visible").first();
const composer = (scope) => scope.locator(".agent-chat__composer-combobox textarea");
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const cssString = (value) => `"${String(value).replace(/[\x00-\x1f\x7f"\\]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;

async function openChat(context) {
  context.requireSession();
  await context.step("open-session", () => context.openSession());
  return activePane(context.page);
}

// Both the empty selector and an existing tab strip are native panel entry points.
async function openPanel(pane, label) {
  if (["Processes", "Subagents"].includes(label)) {
    await pane.locator(".chat-header-session-menu__trigger").click();
    const menu = pane.locator("openclaw-chat-header-session-menu");
    const panels = menu.locator(".session-menu__text").filter({ hasText: /^Panels$/ });
    if (await menu.locator("wa-dropdown.chat-header-session-menu--compact").count()) await panels.click();
    else await panels.hover();
    await menu.locator(`wa-dropdown-item[value="quick:panels:session-${label.toLowerCase()}"]`).click();
    return;
  }
  const panel = pane.locator(".sidebar-region__right-runtime .side-panel");
  if (!(await panel.locator('[data-region-header="side"]').isVisible()) &&
      !(await panel.locator(".side-panel-empty--selector").isVisible())) {
    await pane.locator(".chat-side-panel-toggle").click();
  }
  await panel.locator(".side-panel-empty__types, .side-panel__header-tabs").first().waitFor({ state: "visible" });
  const existing = panel.locator(".side-panel__header .tabstrip-tab").filter({ hasText: label });
  if (await existing.count()) {
    await existing.click();
    return;
  }
  const empty = panel.locator(".side-panel-empty__type").filter({ hasText: label });
  if (await empty.count()) {
    await empty.click();
    return;
  }
  await button(panel, "Add side panel tab").click();
  await panel.locator("wa-dropdown-item").filter({ hasText: label }).click();
}

async function selectAssistantText(pane) {
  const passage = pane.locator(".chat-group.assistant .chat-bubble .chat-text p:visible").last();
  await passage.scrollIntoViewIfNeeded();
  const bounds = await passage.boundingBox();
  if (!bounds) throw new CallError("assistant text is unavailable", 1);
  const mouse = pane.page().mouse;
  await mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await mouse.down();
  await mouse.move(bounds.x + Math.min(bounds.width - 2, 100), bounds.y + bounds.height / 2, { steps: 8 });
  await mouse.up();
}

async function showStorage(context) {
  await context.step("open-session-storage", () => context.navigate(storagePath));
}

async function storageDetails(context) {
  await showStorage(context);
  await context.step("storage-by-agent", () => context.page.getByText("Details by agent", { exact: true }).click());
  await context.step("refresh-storage", () => button(context.page, "Refresh").click());
}

async function chooseModel(pane, model) {
  await pane.locator("[data-chat-model-select]").click();
  await pane.locator("[data-chat-model-search]").fill(model);
  const option = pane.locator(`[data-chat-model-option=${cssString(model)}]`);
  await option.waitFor({ state: "attached" });
  if (!(await option.isVisible())) {
    const toggle = option.locator("xpath=ancestor::section[@data-chat-model-provider-group][1]")
      .locator("[data-chat-model-provider-toggle]");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
  await option.click();
}

export const chatFlows = {
  "progress-card-dismiss-clear-refresh": async (context) => {
    let pane = await openChat(context);
    let card = pane.locator(".session-progress-card--composer");
    await context.step("refresh-progress", async () => {
      await card.locator(".session-progress-card__refresh").click();
      const refresh = card.locator('.session-progress-card__refresh[aria-busy="false"]');
      await refresh.waitFor({ state: "visible" });
      context.captureValue("progressRefreshState", await refresh.getAttribute("data-state"));
    });
    await context.step("dismiss-progress", () => button(card, "Dismiss progress card").click());
    // A document navigation releases the pane-local dismissal; it does not
    // manufacture a replacement Gateway card.
    await context.step("reopen-progress", () => context.openSession());
    pane = activePane(context.page);
    card = pane.locator(".session-progress-card--composer");
    await context.step("clear-saved-progress", () => button(card, "Clear saved progress for everyone").click());
  },

  "files-changes-processes-panels": async (context) => {
    const pane = await openChat(context);
    await context.step("open-files", () => openPanel(pane, "Files"));
    await context.step("open-changes", () => openPanel(pane, "Review"));
    await context.step("open-processes", () => openPanel(pane, "Processes"));
  },

  "home-subagents-panel": async (context) => {
    await context.step("open-home", () => context.navigate("/chat?session=main"));
    await context.step("open-subagents", () => openPanel(activePane(context.page), "Subagents"));
    return { concerns: ["The Subagents panel is scoped to main Home; its children must be prepared there."] };
  },

  "parent-mark-read-after-child": async (context) => {
    context.requireSession();
    // Opening the parent itself acknowledges it. Perform the explicit menu
    // action from another page before navigating to the parent.
    await context.step("open-session-list", () => context.navigate("/sessions"));
    const row = context.page.locator(`.sidebar-recent-session[data-session-key=${cssString(context.sessionKey)}]`);
    await context.step("parent-menu", async () => {
      await revealSidebarSession(context.page, context.sessionKey);
      await row.click({ button: "right" });
    });
    await context.step("mark-parent-read", () => context.page.getByRole("menuitem", { name: "Mark as read", exact: true }).click());
    await context.step("open-parent", () => row.locator(".sidebar-recent-session__link").click());
  },

  "comment-on-selection": async (context) => {
    const pane = await openChat(context);
    await context.step("select-assistant-text", () => selectAssistantText(pane));
    await context.step("open-comment", () => button(context.page.getByRole("toolbar", { name: "Selection actions", exact: true }), "Add to chat").click());
    await context.step("draft-comment", async () => {
      const editor = context.page.getByRole("dialog", { name: "Comment", exact: true }).getByRole("textbox");
      await editor.fill("Please review this passage.\nInclude any relevant caveats.");
      await editor.press("Enter");
    });
    await context.step("preview-comment", () => pane.locator(".chat-attachments-preview .chat-selection-annotations__chip").hover());
    await context.step("send-comment", async () => {
      await composer(pane).fill(replyMessage);
      await pane.locator(".agent-chat__composer-actions .chat-send-btn--send").click();
    });
    await context.step("review-sent-comment", () => pane.locator(".chat-thread .chat-selection-annotations__chip").last().hover());
  },

  "talk-to-home-dock": async (context) => {
    const pane = await openChat(context);
    await context.step("open-home-dock", () => context.page.locator(".sidebar-footer-bar__home").click());
    const dock = context.page.locator("openclaw-assistant-panel");
    await context.step("select-work-context", () => selectAssistantText(pane));
    await context.step("attach-selected-text", () => button(dock, "Attach selected text").click());
    await context.step("inspect-work-context", () => dock.locator(".assistant-panel-context details > summary").click());
    await context.step("ask-home", async () => {
      await composer(dock).fill(replyMessage);
      await dock.locator(".agent-chat__composer-actions .chat-send-btn--send").click();
    });
    await context.step("open-home-full-page", () => button(dock, "Open Home full page").click());
    return { concerns: ["This opens and messages Home; it does not reset the separate Side chat conversation."] };
  },

  "sidebar-hovercard-and-attention": async (context) => {
    await openChat(context);
    const row = context.page.locator(`.sidebar-recent-session[data-session-key=${cssString(context.sessionKey)}]`);
    await context.step("session-hovercard", async () => {
      await context.page.keyboard.press("Escape");
      await context.page.mouse.move(700, 20);
      await revealSidebarSession(context.page, context.sessionKey);
      await row.hover();
      await row.locator(".sidebar-recent-session__link").focus();
      await context.page.locator(".session-progress-hovercard").waitFor({ state: "visible" });
    });
    await context.step("open-inbox", () => context.page.locator(".sidebar-issues-button").click());
  },

  "goal-composer-and-pill": async (context) => {
    const pane = await openChat(context);
    await context.step("enter-goal", async () => {
      await composer(pane).fill("/goal");
      await pane.locator(".agent-chat__composer-actions .chat-send-btn--send").click();
    });
    await context.step("start-goal", async () => {
      await composer(pane).fill("Reply with exact ASCII text KOVA_GOAL_OK only.");
      await button(pane, "Start goal").click();
    });
    await context.step("show-goal-details", () => button(pane, "Show goal details").click());
  },

  "composer-model-effort-fast": async (context) => {
    const pane = await openChat(context);
    await context.step("choose-tool-model", () => chooseModel(pane, "openai/mock-tools"));
    await context.step("choose-reasoning-model", () => chooseModel(pane, "openai/gpt-5.5"));
    await context.step("change-effort", async () => {
      await pane.locator("[data-chat-thinking-select]").click();
      const slider = pane.locator("[data-chat-thinking-slider]");
      const values = (await slider.getAttribute("data-chat-thinking-values"))?.split(",") ?? [];
      const current = Number(await slider.inputValue());
      if (values.length < 2 || !Number.isInteger(current) || current < 0 || current >= values.length) {
        throw new CallError("The selected model does not expose an adjustable effort slider");
      }
      const next = current === 0 ? 1 : current - 1;
      await slider.press(current === 0 ? "ArrowRight" : "ArrowLeft");
      context.captureValue("effortChoice", values[next]);
    });
    await context.step("enable-fast-mode", async () => {
      const fast = pane.locator('[data-chat-speed-option="on"]');
      if (!(await fast.isVisible())) await pane.locator("[data-chat-thinking-select]").click();
      await fast.click();
    });
    return { concerns: ["Requires the existing openai/mock-tools and openai/gpt-5.5 models; finishes on openai/gpt-5.5 with the adjacent effort level and fast mode enabled."] };
  },

  "send-then-stop": async (context) => {
    const pane = await openChat(context);
    await context.step("send-held-message", async () => {
      await composer(pane).fill(heldMessage);
      await button(pane, "Send message").click();
    });
    await context.step("stop-generating", () => button(pane, "Stop generating").click());
    return { concerns: ["Requires the scripted provider to hold VERIFY_HOLD until the Stop action."] };
  },

  "settings-session-storage-panel": storageDetails,

  "composer-send-and-steer": async (context) => {
    const pane = await openChat(context);
    await context.step("send-held-message", async () => {
      await composer(pane).fill(heldMessage);
      await pane.locator(".agent-chat__composer-actions .chat-send-btn--send").click();
      await button(pane, "Stop generating").waitFor({ state: "visible" });
    });
    // The native slash command is independent of this browser's Queue/Steer
    // keyboard preference and still goes through the visible composer.
    await context.step("steer-active-run", async () => {
      await composer(pane).fill(`/steer ${replyMessage}`);
      await pane.locator(".agent-chat__composer-actions .chat-send-btn--send").click();
    });
    return { concerns: ["Requires an active scripted VERIFY_HOLD turn; steering uses the native /steer composer command."] };
  },

  "open-session-and-page-history": async (context) => {
    const pane = await openChat(context);
    await context.step("page-earlier-history", async () => {
      const thread = pane.locator(".chat-thread");
      await thread.hover();
      await context.page.mouse.wheel(0, -100000);
    });
    await context.step("open-split-view", () => button(pane, "Open split view").click());
  },

  "read-long-session-scroll": async (context) => {
    const pane = await openChat(context);
    await context.step("scroll-earlier", async () => {
      await pane.locator(".chat-thread").hover();
      await context.page.mouse.wheel(0, -1600);
    });
    await context.step("preview-position", () => pane.locator(".chat-position-rail__marker:visible").first().hover());
    await context.step("select-position", () => pane.locator(".chat-position-rail__marker:visible").first().click());
    await context.step("scroll-to-latest", () => pane.locator('.chat-scroll-to-bottom[data-visible="true"]').click());
  },

  "read-streaming-main": async (context) => {
    const pane = await openChat(context);
    await context.step("read-streaming-reply", () => pane.locator(".chat-bubble.streaming").scrollIntoViewIfNeeded());
    await context.step("scroll-during-stream", async () => {
      await pane.locator(".chat-thread").hover();
      await context.page.mouse.wheel(0, -600);
    });
  },

  "settings-session-storage-change": async (context) => {
    await showStorage(context);
    const age = context.page.getByRole("spinbutton", { name: "Archive after (days)", exact: true });
    const original = await context.step("read-storage-age", () => age.inputValue());
    const numeric = Number(original);
    if (!Number.isSafeInteger(numeric) || numeric < 1) throw new CallError("Session storage age is not a positive whole number");
    const changed = String(numeric === 1 ? 2 : numeric - 1);
    const saved = context.page.locator("openclaw-settings-save-indicator .settings-save-indicator--saved");
    let changeError;
    let edited = false;
    try {
      await context.step("change-storage-age", async () => {
        // The previous success notice lasts two seconds. Retire it before
        // observing the success notice for this particular edit.
        await saved.waitFor({ state: "hidden" });
        await age.fill(changed);
        edited = true;
        await age.blur();
        await saved.waitFor({ state: "visible" });
      });
    } catch (error) {
      changeError = error;
    }
    if (!edited) throw changeError;
    try {
      await context.step("restore-storage-age", async () => {
        await saved.waitFor({ state: "hidden" });
        await age.fill(original);
        await age.blur();
        await saved.waitFor({ state: "visible" });
      });
    } catch (error) {
      throw changeError ? new AggregateError([changeError, error], "Storage age change and restoration failed") : error;
    }
    if (changeError) throw changeError;
    context.captureValue("storageAgeSequence", [original, changed, original]);
    return { concerns: [`Session storage age changed from ${original} to ${changed} days, then restored to ${original}; no other policy or model setting changed.`] };
  },

  "session-storage-panel": async (context) => {
    await storageDetails(context);
    await context.step("run-storage-maintenance", () => button(context.page, "Run now").click());
    return { concerns: ["Runs one background batch using the already enabled, saved and applied archival policy."] };
  },

  "reconnect-and-send": async (context) => {
    context.requireSession();
    // The caller retains the browser and observes the actual connect reply.
    // Navigating here would replace the page whose reconnect is being observed.
    await context.step("reconnect-existing-page", () => context.waitConnected());
    await context.step("send-after-reconnect", async () => {
      const pane = activePane(context.page);
      if (await pane.evaluate((element) => element.sessionKey) !== context.requireSession()) throw new CallError("retained page session does not match the requested session");
      context.captureValue("sessionKey", context.requireSession());
      await composer(pane).fill(replyMessage);
      await pane.locator(".agent-chat__composer-actions .chat-send-btn--send").click();
    });
  },
};
