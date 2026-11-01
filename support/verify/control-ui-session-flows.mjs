import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { CallError, readJson, validateGatewayOutput } from "./background.mjs";
import { controlUiException } from "./control-ui-errors.mjs";

const initialMessage = "Reply with exact ASCII text KOVA_AGENT_OK only.";
const activePane = "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])";

function cssString(value) {
  return `"${String(value).replace(/["\\\n\r\f]/g, (character) => `\\${character.codePointAt(0).toString(16)} `)}"`;
}

function rowFor(page, key) {
  return page.locator(`openclaw-app-sidebar .sidebar-recent-session[data-session-key=${cssString(key)}]`).first();
}

export async function revealSidebarSession(page, key) {
  const row = rowFor(page, key);
  const sidebar = page.locator("openclaw-app-sidebar");
  while (!(await row.isVisible())) {
    // Sections, roster pages and child trees each have their own native
    // disclosure. Scrolling alone does not load or reveal those rows.
    const controls = [
      sidebar.locator('.sidebar-session-group-toggle[aria-expanded="false"]:visible'),
      sidebar.getByRole("button", { name: "Show more", exact: true }),
      sidebar.locator('.sidebar-session-pagination--roster button'),
      sidebar.locator('[data-child-session-toggle][aria-expanded="false"]:visible'),
      sidebar.locator('[data-show-more-children]:visible'),
    ];
    let next;
    for (const control of controls) if (await control.count()) { next = control.first(); break; }
    if (!next) { await row.waitFor({ state: "visible" }); break; }
    await next.click();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
  }
  return row;
}

function captureUrl(context) {
  const url = new URL(context.page.url());
  // Pairing parameters never belong in the result.
  context.captureValue("url", `${url.origin}${url.pathname}`);
}

async function openSelected(context) {
  context.requireSession();
  await context.step("open-session", () => context.openSession());
}

async function openRowMenu(context) {
  const row = await revealSidebarSession(context.page, context.requireSession());
  await row.click({ button: "right" });
  const menu = context.page.locator("openclaw-session-menu");
  await menu.locator("wa-dropdown-item").first().waitFor({ state: "visible" });
  return menu;
}

async function openHeaderMenu(page) {
  await page.locator(activePane).locator(".chat-header-session-menu__trigger").click();
  const menu = page.locator(activePane).locator("openclaw-chat-header-session-menu");
  await menu.waitFor({ state: "visible" });
  return menu;
}

async function submenu(menu, label) {
  const item = menu.getByRole("menuitem", { name: label, exact: true });
  await item.focus();
  await item.press("ArrowRight");
  return item;
}

async function rowAction(context, label, value) {
  await context.step(label, async () => {
    const menu = await openRowMenu(context);
    await menu.locator(`wa-dropdown-item[value=${cssString(value)}]`).click();
  });
}

async function inputDialog(page, value) {
  const input = page.locator("openclaw-modal-dialog input");
  await input.fill(value);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

async function sidebarStatus(context, status) {
  await context.step(`filter-${status.toLowerCase()}`, async () => {
    await context.page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    const menu = context.page.locator(".sidebar-session-sort-menu");
    await menu.locator("#sidebar-sessions-status").getByRole("radio", { name: status, exact: true }).click();
    await context.page.keyboard.press("Escape");
  });
}

async function startSession(context, incognito = false) {
  await context.step("new-session", () => context.navigate("/new?agent=main"));
  if (incognito) {
    await context.step("incognito", () => context.page.getByRole("switch", { name: "Incognito", exact: true }).click());
  }
  await context.step("compose", () => context.page.locator(".new-session-page__message").fill(initialMessage));
  await context.step("send", async () => {
    await context.page.locator(".new-session-page__start-submit").click();
    await context.page.waitForURL((url) => /\/chat\//.test(url.pathname));
    captureUrl(context);
  });
}

async function backgroundSession(context) {
  await context.step("open-home", () => context.navigate("/chat?session=main"));
  await context.step("open-palette", () => context.page.keyboard.press("ControlOrMeta+K"));
  const palette = context.page.locator("openclaw-command-palette");
  await context.step("compose", () => palette.locator(".cmd-palette__input").fill(initialMessage));
  await context.step("send", () => palette.getByRole("button", { name: "Start new session in background", exact: true }).click());
}

async function sharingMenu(page) {
  await page.locator(activePane).locator(".chat-pane__sharing-trigger").click();
  return page.locator(activePane).locator(".chat-pane__sharing-menu");
}


async function deleteSelected(context) {
  await context.step("delete-menu", async () => {
    const menu = await openRowMenu(context);
    await menu.locator('wa-dropdown-item[value="delete"]').click();
  });
  await context.step("delete", () => context.page.locator("openclaw-modal-dialog").getByRole("button", { name: "Delete", exact: true }).click());
}

function pathSegment(segment) {
  if (segment === ".") return "~dot";
  if (segment === "..") return "~dotdot";
  const encoded = encodeURIComponent(segment).replaceAll(".", "%2E");
  return encoded.startsWith("~") ? `~${encoded}` : encoded;
}

function literalPaths(key) {
  const match = /^agent:([^:]+):(.+)$/.exec(key);
  if (!match || match[2].split(":").some((part) => !part)) {
    throw new CallError("link forms require a qualified agent session key");
  }
  const agent = pathSegment(match[1]);
  const rest = match[2].split(":").map(pathSegment).join("/");
  return { literal: `/chat/${agent}/${rest}`, exact: `/chat/${agent}/~key/${rest}` };
}

async function incognitoKey(options) {
  if (!options["incognito-handle"]) throw new CallError("--incognito-handle is required for this flow");
  let value;
  try { value = await readJson(options["incognito-handle"]); }
  catch (error) { throw Object.assign(new CallError("cannot read --incognito-handle JSON"), { cause: controlUiException(error) }); }
  const keys = [...new Set([value?.sessionKey, value?.result?.sessionKey].filter((key) => typeof key === "string" && key.trim()))];
  if (value?.error || keys.length !== 1 || !/^agent:[^:]+:(?:dashboard|subagent|internal-session-effects):incognito-[^:]+$/.test(keys[0])) {
    throw new CallError("--incognito-handle requires one incognito sessionKey");
  }
  return keys[0];
}

export const sessionFlows = {
  "new-session-page": (context) => startSession(context),
  "new-session-incognito": (context) => startSession(context, true),

  "sidebar-browse-and-filter": async (context) => {
    await context.step("open-home", () => context.navigate("/chat?session=main"));
    await sidebarStatus(context, "All");
    await sidebarStatus(context, "Archived");
    await sidebarStatus(context, "Active");
    await context.step("browse-session", () => context.page.locator("openclaw-app-sidebar .sidebar-recent-session__link").first().click());
    captureUrl(context);
  },

  "palette-and-page-search": async (context) => {
    await context.step("open-home", () => context.navigate("/chat?session=main"));
    await context.step("open-palette", () => context.page.keyboard.press("ControlOrMeta+K"));
    await context.step("palette-search", () => context.page.locator("openclaw-command-palette .cmd-palette__input").fill("KOVA"));
    await context.step("close-palette", () => context.page.keyboard.press("Escape"));
    await context.step("sessions-page", () => context.navigate("/sessions"));
    await context.step("transcript-search", async () => {
      const search = context.page.getByRole("search", { name: "Search transcripts", exact: true });
      await search.getByRole("searchbox", { name: "Search session transcripts", exact: true }).fill("KOVA");
      await search.getByRole("button", { name: "Search", exact: true }).click();
    });
    await context.step("clear-search", () => context.page.getByRole("search", { name: "Search transcripts", exact: true }).getByRole("button", { name: "Clear", exact: true }).click());
  },

  "palette-background-session": backgroundSession,
  "palette-background-start": backgroundSession,

  "sidebar-session-menu": async (context) => {
    await openSelected(context);
    await rowAction(context, "rename-menu", "rename");
    await context.step("rename", () => inputDialog(context.page, "Kova organized session"));
    await rowAction(context, "toggle-pin", "toggle-pin");
    await rowAction(context, "mark-unread", "toggle-unread");
    await context.step("snooze", async () => {
      const menu = await openRowMenu(context);
      await submenu(menu, "Snooze");
      await menu.locator('wa-dropdown-item[value^="snooze:"]').first().click();
    });
    await sidebarStatus(context, "Snoozed");
    await context.step("wake", async () => {
      const menu = await openRowMenu(context);
      await menu.locator('wa-dropdown-item[value="wake"]').click();
    });
    await sidebarStatus(context, "Active");
    await context.step("color", async () => {
      const menu = await openRowMenu(context);
      await submenu(menu, "Icon & color");
      await menu.getByRole("button", { name: "Blue", exact: true }).click();
    });
    await context.step("new-group-menu", async () => {
      const menu = await openRowMenu(context);
      await submenu(menu, "Move to group");
      await menu.locator('wa-dropdown-item[value="new-group"]').click();
    });
    await context.step("create-group", () => inputDialog(context.page, "Kova UI group"));
    await context.step("assign-owner", async () => {
      const menu = await openRowMenu(context);
      await submenu(menu, "Assign to…");
      await menu.locator('wa-dropdown-item[value^="assign-owner:"][aria-checked="false"]').first().click();
    });
  },

  "archive-undo-restore": async (context) => {
    await openSelected(context);
    await rowAction(context, "archive", "toggle-archived");
    await context.step("undo-archive", () => context.page.locator(".app-toast").getByRole("button", { name: "Undo", exact: true }).click());
    await rowAction(context, "archive-again", "toggle-archived");
    await sidebarStatus(context, "Archived");
    await rowAction(context, "restore", "toggle-archived");
    await sidebarStatus(context, "Active");
  },

  "session-sharing-dialog": async (context) => {
    await openSelected(context);
    for (const visibility of ["read-only", "suggest", "shared"]) {
      await context.step(`sharing-${visibility}`, async () => {
        const menu = await sharingMenu(context.page);
        await menu.locator(`wa-dropdown-item[value="visibility:${visibility}"]`).click();
      });
    }
    await context.step("view-sharing", () => sharingMenu(context.page));
  },

  "catalog-import-row": async (context) => {
    await context.step("open-home", () => context.navigate("/chat?session=main"));
    await context.step("open-catalog", async () => {
      const toggle = context.page.getByRole("button", { name: "Claude Code", exact: true });
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      const row = context.page.locator('[data-session-section="catalog:claude"] .sidebar-recent-session').filter({ has: context.page.locator("[data-catalog-session-menu]") }).first();
      await row.hover();
      await row.locator("[data-catalog-session-menu]").click();
    });
    await context.step("import", () => context.page.locator('openclaw-catalog-session-menu wa-dropdown-item[value="import"]').click());
    await context.step("open-imported-session", () => context.page.locator(".app-toast").getByRole("button", { name: "Open imported session", exact: true }).click());
    captureUrl(context);
  },

  "export-markdown-and-copy": async (context) => {
    const destination = await validateGatewayOutput({ ...context.options, out: join(context.options["artifact-dir"], "conversation.md") });
    await openSelected(context);
    await context.step("compose-export", () => context.page.locator(activePane).locator(".agent-chat__composer-combobox textarea").fill("/export"));
    await context.step("download-markdown", async () => {
      const [download] = await Promise.all([
        context.page.waitForEvent("download"),
        context.page.locator(activePane).getByRole("button", { name: "Send message", exact: true }).click(),
      ]);
      const content = await download.createReadStream();
      if (!content) throw new CallError("Markdown download did not provide content", 1);
      await pipeline(content, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    });
    await context.step("copy-markdown", async () => {
      await context.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: context.origin });
      const menu = await openRowMenu(context);
      await submenu(menu, "Copy");
      await menu.locator('wa-dropdown-item[value="copy-markdown"]').click();
    });
  },

  "fork-from-message": async (context) => {
    await openSelected(context);
    await context.step("message-menu", () => context.page.locator(activePane).locator(".chat-group.user .chat-bubble[data-entry-id]").last().click({ button: "right" }));
    await context.step("fork", async () => {
      const previous = context.page.url();
      await context.page.locator(".chat-reply-context-menu").getByRole("menuitem", { name: "Fork from here", exact: true }).click();
      await context.page.waitForURL((url) => url.href !== previous);
      captureUrl(context);
    });
  },

  "continue-in-terminal": async (context) => {
    await openSelected(context);
    await context.step("continue-in-terminal", async () => {
      const menu = await openHeaderMenu(context.page);
      await submenu(menu, "Open in");
      await menu.locator('wa-dropdown-item[value="continue-in-terminal"]').click();
    });
    await context.step("copy-terminal-command", async () => {
      const dialog = context.page.locator(".continue-in-terminal-dialog");
      const command = await dialog.locator(".login-gate__command code").innerText();
      await dialog.locator(".chat-copy-btn").click();
      const encoded = /(?:^|\s)--handoff\s+['"]?([A-Za-z0-9_-]+)['"]?(?:\s|$)/.exec(command)?.[1];
      if (!encoded) throw new CallError("terminal dialog did not provide a resume handoff", 1);
      let handoff;
      try { handoff = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
      catch { throw new CallError("terminal dialog provided a malformed handoff", 1); }
      if (handoff.version !== 1 || typeof handoff.sessionKey !== "string" || typeof handoff.gatewayUrl !== "string" || Object.keys(handoff).some((key) => !["version", "sessionKey", "gatewayUrl"].includes(key))) throw new CallError("terminal handoff contains unsupported fields", 1);
      const gateway = new URL(handoff.gatewayUrl);
      if (!["ws:", "wss:"].includes(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash) throw new CallError("terminal handoff contains an unsupported Gateway URL", 1);
      context.captureValue("handoff", encoded);
      context.captureValue("sessionKey", context.requireSession());
    });
    await context.step("close-terminal-dialog", () => context.page.locator(".continue-in-terminal-dialog").getByRole("button", { name: "Close", exact: true }).click());
  },

  "sidebar-delete-nested-child": async (context) => {
    await openSelected(context);
    await context.step("reveal-child", () => revealSidebarSession(context.page, context.requireSession()));
    await deleteSelected(context);
  },

  "delete-then-switch-gateway": async (context) => {
    context.requireSession();
    if (!context.options["gateway-env"]) throw new CallError("--gateway-env is required for this flow");
    await openSelected(context);
    await sidebarStatus(context, "All");
    await deleteSelected(context);
    await context.step("switch-gateway", () => context.pairGateway());
  },

  "resume-in-new-session": async (context) => {
    await openSelected(context);
    await context.step("resume-in-new-session", async () => {
      const previous = context.page.url();
      await context.page.locator(activePane).getByRole("button", { name: "Resume in new session", exact: true }).click();
      await context.page.waitForURL((url) => url.href !== previous);
      captureUrl(context);
    });
  },

  "open-by-link": async (context) => {
    const url = context.sessionUrl(context.requireSession());
    await context.step("open-link", () => context.navigate(url));
    await context.step("reload-link", () => context.reload());
    captureUrl(context);
  },

  "open-links-matrix": async (context) => {
    const key = context.requireSession();
    const incognito = await incognitoKey(context.options);
    const paths = literalPaths(key);
    const links = [
      ["literal", paths.literal],
      ["exact-key", paths.exact],
      ["draft", `${paths.exact}?draft=${encodeURIComponent("Kova link draft")}`],
      ["legacy", `/chat?session=${encodeURIComponent(key)}`],
      ["incognito", literalPaths(incognito).exact],
      ["missing", `/chat/main/~key/${pathSegment(`kova-missing-${Date.now()}`)}`],
    ];
    for (const [form, path] of links) {
      await context.step(`link-${form}`, () => context.navigate(path, { waitForGateway: false }));
    }
    await context.step("revisit-link", () => context.navigate(context.sessionUrl(key)));
    await context.step("reload-link", () => context.reload());
    const tab = await context.newPage(context.sessionUrl(key));
    try {
      await context.step("new-tab-link", () => tab.locator(".sidebar-footer-bar").waitFor({ state: "visible" }), { screen: tab });
    } finally { await context.closePage(tab); }
    captureUrl(context);
  },

  "open-session-keep-open": async (context) => {
    await openSelected(context);
    context.captureValue("sessionKey", context.requireSession());
    captureUrl(context);
  },
};
