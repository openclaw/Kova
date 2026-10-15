# Derivation: sessions

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

Reconciled from historical runs C and D at the same product revision; converted to the current template form without rerunning the derivation.

## Bounds
Paths: src/config/sessions.ts, src/config/sessions/**, src/config/zod-schema.session*.ts, src/config/schema.labels.session.ts, src/config/io.session-store-owner.ts, src/config/runtime-session-changes.ts, src/gateway/server-methods/sessions*.ts, src/gateway/server-methods/session-*.ts, src/gateway/server-methods/chat.ts, src/gateway/server-methods/chat-*.ts, src/gateway/server-methods/agent-session-*.ts, src/gateway/server-methods/agent-expected-session.ts, src/gateway/server-methods/progress-card*.ts, src/gateway/session-*.ts, src/gateway/progress-card-store*.ts, src/gateway/server-chat-progress-snapshot.ts, src/gateway/cli-session-history-*.ts, src/gateway/active-sessions-*.ts, src/gateway/session-companion-rpc.ts, src/agents/sessions/**, src/agents/subagents/**, src/agents/tools/sessions-*.ts, src/agents/tools/session-status-tool.ts, src/agents/tools/subagents-tool.ts, src/agents/tools/progress-card-tool.ts, src/agents/tools/goal-tools.ts, src/auto-reply/reply/session*.ts, src/channels/session*.ts, src/cli/sessions-*.ts, src/cli/session-ref.ts, src/cli/session-target.ts, src/cli/resume-cli*.ts, ui/src/pages/chat/**, ui/src/pages/new-session/**, ui/src/components/app-sidebar*.ts, ui/src/components/session-*.ts, ui/src/components/sidebar-*.ts, ui/src/lib/sessions/**, ui/src/lib/chat/**
Documents: docs/concepts/session.md, docs/concepts/session-state.md, docs/concepts/session-search.md, docs/concepts/session-pruning.md, docs/concepts/session-attachment.md, docs/concepts/session-tool.md, docs/concepts/main-session.md, docs/concepts/subagent-yield-handoff.md, docs/concepts/memory-provenance.md, docs/concepts/compaction.md, docs/cli/sessions.md, docs/cli/resume.md, docs/cli/attach.md, docs/gateway/config-agents/sessions.md, docs/gateway/doctor/state-and-sessions.md, docs/gateway/protocol/rpc-session-control.md, docs/help/faq/sessions-and-chats.md, docs/plugins/session-share.md, docs/reference/session-management-compaction.md, docs/reference/session-management-compaction/compaction.md, docs/reference/session-management-compaction/housekeeping.md, docs/reference/session-management-compaction/maintenance.md, docs/reference/session-management-compaction/resident-history.md, docs/reference/session-management-compaction/schema.md, docs/reference/session-management-compaction/store.md, docs/tools/goal.md, docs/tools/progress-card.md, docs/tools/subagents/thread-bound-sessions.md, docs/web/control-ui/sessions-and-sidebar.md, docs/web/urls.md, docs/tools/subagents.md (ADDED by run D: linked from docs/concepts/session-tool.md "Spawning sub-agents"; describes the sub-agent spawn operation), docs/tools/subagents/slash-command.md (ADDED by run D: linked from docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation" and docs/concepts/subagent-yield-handoff.md "Progress after yield"; describes /subagents list|info|log and the /session thread-binding commands)

## Excluded paths
src/gateway/server-methods/sessions-dispatch.ts (sessions.move, sessions.dispatch, sessions.reclaim): owned by cloud workers
src/gateway/server-methods/session-placement-read-projection.ts, src/gateway/session-worker-placement-context.ts, src/gateway/session-row-placement-projection*.ts, docs/gateway/cloud-workers/*, docs/gateway/cloud-sessions.md: owned by cloud workers
src/gateway/server-methods/session-catalog*.ts except the sessions.catalog.import handler in session-catalog.ts and session-catalog-import.ts (sessions.catalog.list, read, continue, archive, host, startTerminal), docs/nodes/session-catalogs.md, docs/nodes/session-hosting.md: owned by session catalogs (nodes)
src/gateway/server-methods/usage.ts (sessions.usage, sessions.usage.logs, sessions.usage.timeseries): owned by usage
src/gateway/server-methods/session-discussion.ts, src/plugin-sdk/session-discussion.ts (session.discussion.*): owned by the btw side-discussion tool
src/gateway/server-methods/sessions-reactions*.ts (session.reactions.*): owned by chat reactions
src/gateway/session-observer*.ts (sessions.observer.visibility): owned by the session observer
src/gateway/server-node-events.ts (chat.subscribe, chat.unsubscribe): owned by nodes
src/gateway/server-methods/core-handlers.ts (registration table of handler keys; the handler bodies live in area files): owned by gateway core
src/gateway/server-methods/attach.ts (attach grant minting behind openclaw attach): owned by MCP attach; its entry point is placed under Continue a session in the terminal or a coding harness
src/agents/sessions/model-registry*.ts: owned by models
src/plugin-sdk/*session*.ts, docs/plugins/hooks/prompt-and-session.md: owned by the plugin SDK
docs/nodes/talk/*: owned by talk
docs/tools/acp-agents/sessions.md, src/acp/**: owned by ACP
src/infra/heartbeat-*.ts, src/cron/**, src/channels/** other than src/channels/session*.ts: owned by heartbeat, cron and channels (they reach this area; listed as entry points of kind from <area>)
src/commands/doctor-session-*.ts, src/cli/attach-cli.ts, src/cli/tui-cli.ts: command bodies outside the area globs, owned by doctor and the CLI program; their commands are listed as entry points. The sessions command bodies and their shared registration are included below.
Windows-only path handling (src/config/sessions/*windows*, junction creation): owned by platform; a break that needs Windows is outside this template's reach

## Reconciled caller paths

The current area includes `src/commands/sessions*.ts`, `src/cli/program/register.status-health-sessions.ts`, `ui/src/lib/session-progress-cards.ts` and `ui/src/pages/config/session-storage.ts`. The existing phases now select their concrete callers: listing and table rendering select `browse-sessions`; tail selects `inspect-status`; lifecycle commands select `archive-restore` and `delete-session`; compact selects `compact-session`; cleanup and the storage panel select `maintain-session-store`; the progress-card client selects `publish-progress`. The shared CLI registration selects each sessions CLI phase, including import and export. These are corrections to path coverage at the recorded revision, without a new derivation run.

## Operations
| Operation | Entry points | Kinds |
| --- | --- | --- |
| Reach a session from a channel or job | DM route (session.dmScope, recordInboundSession); Group and room route (session.groupScope, bindings[].session.groupScope); Thread route (`:thread:<id>`, Slack Agent View DM thread); Identity links (session.identityLinks); Isolated cron run creating a fresh `cron:<jobId>` session; Webhook session `hook:<uuid>`; Heartbeat wake of the main session; Session-creation notice queued to Home (session.notifyOnCreate) | from channels; from cron; from hooks; from heartbeat; from gateway runtime |
| Start a new session | sessions.create; sessions.title.prepare; New session page "Start session"; New session route `/new` (`?agent=<id>`); Sessions toolbar "+"; Group header "+" and Other "+"; Shortcut Cmd/Ctrl+Shift+O; Project/Place picker; Browse folders; Worktree + From; Local destination; Effort and Fast mode on the New session page; Incognito toggle; Command palette background start (Cmd/Ctrl+K then Cmd/Ctrl+Enter); Palette New session settings; Palette Remember settings; Palette @mentions; Palette pasted images; "New conversation" agent menu (team mode) | Gateway method; UI action |
| Send a message and get a reply | chat.send; sessions.send; chat.inject; Gateway `agent` method input (shown as pending input); Composer Send; Composer Steer; Queued follow-ups and queue reorder; Check delivery; Retry; "Received · waiting for worker setup"; Control UI reconnect resume (one-shot sessionId); OPENCLAW_SHELL=exec rejection of CLI message RPCs | Gateway method; from agent RPC; UI action; from CLI |
| Talk to Home while working | sessions.companion.state; sessions.companion.ask; sessions.companion.reset; "Talk to your Home agent" (Cmd/Ctrl+Shift+H); Dock right / bottom; "Open Home full page"; "Working on" snapshot; "Attach selected text"; "Remove work context"; Home page (`agent:<id>:main`) and agent switcher | Gateway method; UI action |
| Stop a run | chat.abort; sessions.abort; /stop; Stop; Stop during worktree setup; sessions tool action stop | Gateway method; chat command; UI action; agent call |
| Open a session and read its history | chat.history; chat.startup; chat.message.get; chat.metadata; sessions.get; sessions.describe; sessions.preview; sessions.messages.subscribe; sessions.messages.unsubscribe; sessions_history tool; Open a session from the sidebar or Home; "Show earlier messages"; "Show latest messages"; Pending and stopped input bubbles; Open in → new tab; Open in → new window; Open in → Split right; Open in → Split below; HTTP history endpoint (complete history without a limit); Memory ingestion and session backfill transcript reads | Gateway method; agent call; UI action; from gateway HTTP; from memory |
| Open a session by link | sessions.resolve; Route `/chat/<agentId>`; Route `/chat/<agentId>/<slug>-<shortId>`; Route with literal segments; Route `~key`; `~dot` and `~dotdot` escapes; `/dashboard/…` twins; `/focus/dashboard/…`; `?dashboard=expanded`; Legacy `?session=` and `?face=dashboard` rewrite; `/` and `/chat` restoring the last selected session; `?draft=<text>` composer value; Slug-only one-segment fallback; Disambiguation view for short-id ties; "Session not found" recovery page; Reload, new tab and bookmark of a chat link under token or password auth; Incognito literal links (`/chat/<agent>/dashboard/incognito-<uuid>`); Expired-Incognito page (New Incognito session); Cmd/Ctrl-click a sidebar row into a new tab; Expired-link retry after reconnect; Copy → Session link; Copy → Preview link (`/share/<ns>/<agent>/<ref>`); `/share/card.png` social card | Gateway method; UI action |
| Continue a session in the terminal or a coding harness | openclaw resume; openclaw tui <target> / --session; openclaw <session-url> at the CLI root; openclaw attach; "Continue in terminal…" handoff dialog; Session-scoped MCP attach grant (src/gateway/server-methods/attach.ts); First-contact device pairing for a Gateway origin | CLI command; UI action; Gateway method; from devices |
| Browse and find sessions | sessions.list; sessions.subscribe; sessions.setInvolvement (Hide from / Show in Involving me); openclaw sessions / openclaw sessions list; sessions_list tool; Filter & sort: Owners; Filter & sort: Status (Active / Snoozed / Archived / All); Filter & sort: automation and system toggles; Filter & sort: Group by; Filter & sort: Sort by; Filter & sort: Hide empty groups; Filter & sort: Show message preview; Filter & sort: Reset; Team mode "Show all"; Team mode agent group headers; Sidebar sections (Pages, Home, Pinned, custom groups, Other, Groups, Coding zones); "Load more sessions"; Sessions page (`/sessions`, `?status=`, `?session=`); Sessions page checkbox selection; Nested child rows (disclosure and ancestor path); Cmd/Ctrl+B sidebar toggle | Gateway method; CLI command; agent call; UI action |
| Search session history | sessions.search; Command palette search (Cmd/Ctrl+K, Sessions and Messages groups); Sidebar / Sessions page search field; sessions_search tool | Gateway method; UI action; agent call |
| Organize a session | sessions.patch; sessions.patchMany; sessions.assignOwner; sessions.groups.list; sessions.groups.put; sessions.groups.rename; sessions.groups.delete; sessions.groups.defaults; sessions.groups.update; Pin / Unpin; Rename; Mark as unread / read; Snooze presets / Wake session; Icon & color; Move to group; New group (session menu); Remove from group; Assign to; Batch Mark N (Alt/Shift multi-select); Batch Move N; Drag onto Pinned or a custom group; Group header Rename group; Group header New group; Group header Delete group; Group header New session defaults; Reorder grip (Move up / Move down); Group collapse state; sessions tool action patch; sessions tool action assign_owner; sessions tool action group_list; sessions tool action group_set; sessions tool action group_rename; sessions tool action group_delete; sessions.patch { autoLabel } from the Android app | Gateway method; UI action; agent call; from mobile node |
| Archive or restore a session | openclaw sessions archive; Archive / Unarchive / Restore; Undo after archive; Batch Archive N; Shortcut Cmd/Ctrl+Shift+A (archive current pane) | CLI command; UI action |
| Change a session's model or settings | session_status model override (`model=<id>`, `model=default`); Composer Model picker; Composer Effort gauge; Composer Fast mode | agent call; UI action |
| Share a session with teammates or publicly | session.visibility.set; session.members.list; session.members.listEvidence; session.members.add; session.members.remove; session.suggestions.add; session.suggestions.list; session.suggestions.resolve; session.publicShare.set; "Session sharing" control (membership, modes); Enable public access…; Make public; Copy public link; Disable public access; Public badge; Public thread page for signed-out readers (anonymous GET of `/chat/<agentId>/<sessionRef>`); Public thread page Older messages; Public thread page Back to latest; Public thread page Log in; Dashboards gallery link; `openclaw.sessions.list.v1` node command; `openclaw.sessions.read.v1` node command; Receiver catalog "OpenClaw sessions"; session.sharing / session.sharing.evidence / session.suggestion events to clients | Gateway method; UI action; from gateway HTTP; from session-share plugin; Gateway event |
| Fork or rewind a conversation | sessions.fork; sessions.rewind; sessions.branches.list; sessions.branches.switch; "Fork conversation"; "Fork from here"; Edit-and-resend rewind (edit message to composer); Branch navigation; Automatic parent fork for thread and subagent children (100K-token cap, isolated fallback) | Gateway method; UI action; from subagents |
| Reset a session | sessions.reset; /new (and `/new <model>`); /reset; Configured session.resetTriggers; sessions tool action reset; Daily and idle reset policy (session.reset, resetByType, resetByChannel) | Gateway method; chat command; agent call; from config |
| Compact a session | sessions.compact; /compact [focus]; openclaw sessions compact; Auto-compaction with the pre-compaction memory flush; UI Settings compaction knobs (agents.defaults.compaction.*) | Gateway method; chat command; CLI command; from agent runtime; from config |
| Message another session and watch it | sessions_send tool; Stale-state notice to watchers (spawn edge, ambient group watch, explicit watch) | agent call; from gateway runtime |
| Inspect a session's status | session_status tool; /status; sessions.activitySummary.ensure; openclaw sessions tail; Session hovercard; Activity ring; Unread dot; Attention icon previews; "Automation attached"; Online activity card; TUI footer session fields | agent call; chat command; Gateway method; CLI command; UI action; from tui |
| Run background work with sub-agents | sessions_spawn tool; sessions_yield tool; subagents tool action list; subagents tool action wait; subagents tool action cancel; agents_list tool (spawn target discovery); /subagents list; /subagents info; /subagents log; Home → Subagents panel; Subagents panel Running / Finished; View-only subagent transcript; Back to Subagents; Open parent session; Subagents panel Stop; Child-failure notice → Open session; "Subagents working" ring and child attention notices; Completion announce, yield handoff and requester settle wake; Sub-agent auto-archive after archiveAfterMinutes; ACP child session creation (translator session lifecycle); ACP child run (sessions_spawn runtime "acp"); subagents.allowAgents / requireAgentId / maxSpawnDepth policy | agent call; from agents; chat command; UI action; from subagents; from ACP; from agents config |
| Work with a sub-agent in its own channel thread | Thread follow-up routing to the bound session; /session unbind; /session idle; /session max-age; /agents binding state | from channels; chat command; from agents |
| Keep a goal on a session | /goal (start, set, create, edit, pause, resume, complete, block, clear, status); sessions.goal.update; sessions.goal.clear; get_goal tool; create_goal tool; update_goal tool; Goal composer (command picker "Goal", Start goal); Goal pill Pencil; Goal pill Pause; Goal pill Resume; Goal pill Trash; Goal pill Chevron; Goal pill Check outcome; Goal pill Review current goal; TUI footer goal line | chat command; Gateway method; agent call; UI action; from tui |
| Publish progress on a session | progress_card tool; progressCard.get; progressCard.put; progressCard.refresh; Card expand / collapse; Card drag header; "Dismiss progress card"; "Clear saved progress for everyone"; "Refresh task progress"; Settings Show task progress cards; Settings Collapse by default; Session hovercard card placement; Progress-card reminder for paired card renderers; Dashboard widget `session:progress` (widget_put); Channel progress-draft previews of the checklist | agent call; Gateway method; UI action; from gateway runtime; from dashboards; from channels |
| Recover after a Gateway restart | Restart recovery of an interrupted turn (three-attempt budget, replayed tool calls, pending messages); sessions.recover; "Resume in new session" (WebChat) after exhausted recovery; Startup sweep re-materializing pending watcher notices; Startup startup check refusal for an unimported legacy store (prints the Doctor command) | from gateway runtime; Gateway method; UI action; from gateway startup |
| Work with a session's files, changes and processes | sessions.files.list; sessions.files.get; sessions.files.set; sessions.files.assets; sessions.files.reveal; sessions.diff; sessions.processes.list; sessions.processes.stop; sessions.github.options; sessions.github.status; sessions.github.publish; sessions.github.confirm; Files side panel and file previews; HTML preview with relative assets; Workspace changes panel; Publish to GitHub; Pull-request dock and PR indicators; Processes panel | Gateway method; UI action |
| Import a native transcript into a session | sessions.catalog.import; openclaw sessions import (including --all); Catalog menu Import | Gateway method; CLI command; UI action |
| Export a session | openclaw sessions export-trajectory; /export-trajectory; /trajectory; /export; /export-session; Copy → conversation as Markdown; Copy → session ID | CLI command; chat command; UI action |
| Delete a session | sessions.delete; openclaw sessions delete; Session menu Delete; Batch Delete N; Sessions page bulk delete; sessions tool action delete; openclaw memory forget --agent <id> --session <id-or-key>; Browser draft retirement after confirmed deletion | Gateway method; CLI command; UI action; agent call; from memory |
| Maintain the session store | openclaw sessions cleanup; sessions.cleanup; sessions.storage.status; sessions.storage.run; Session storage: Archive older transcripts; Session storage: Archive after (days); Session storage: Run now; Session storage: Refresh; Session storage: Details by agent; Automatic age / cap / disk-budget maintenance armed by entry writes; Dashboard auto-archive after archiveDashboardAfter; Cold-storage worker at startup and once a minute; cron.sessionRetention pruning of isolated cron sessions | CLI command; Gateway method; UI action; from maintenance; from cron |
| Repair or migrate the session store | openclaw doctor --fix (session import and repairs); openclaw doctor --session-sqlite inspect; openclaw doctor --session-sqlite import; openclaw doctor --session-sqlite compact; openclaw doctor --session-sqlite restore | from doctor |
| Comment on selected text in a chat | Selection popup comment draft (chat-selection-popup, chat-selection-annotations); Sent inline comments and read-only comment previews | UI action |

## Excluded entry points
sessions.steer: deprecated alias of chat.send queueMode interrupt (bound decision)
chat.toolTitles: deprecated, returns disabled (bound decision)
chat.showThinking: not a registered request method (event or preference name only)
sessions.move: owned by cloud workers
sessions.dispatch: owned by cloud workers
sessions.reclaim: owned by cloud workers
"Move session…": owned by cloud workers
"Stop cloud worker…" / "Stop device worker…": owned by cloud workers
New session destination picker (Auto, devices, cloud profiles, machine class): owned by cloud workers
Remote checkout: owned by cloud workers
Placement badges and Runs on Cloud chip: owned by cloud workers
sessions.create execNode and worker placement: owned by cloud workers
Systems machine list: owned by cloud workers
sessions.catalog.list: owned by session catalogs (nodes)
sessions.catalog.read: owned by session catalogs (nodes)
sessions.catalog.continue: owned by session catalogs (nodes)
sessions.catalog.archive: owned by session catalogs (nodes)
sessions.catalog.host: owned by session catalogs (nodes)
sessions.catalog.startTerminal: owned by session catalogs (nodes)
Native coding CLI start ("+" beside Codex / Claude Code, Where picker): owned by session catalogs (nodes)
Native catalog links `?catalog=&host=&thread=`: owned by session catalogs (nodes)
`/terminal` catalog query: owned by session catalogs (nodes)
`/focus/terminal`: owned by session catalogs (nodes)
sessions.usage: owned by usage
sessions.usage.logs: owned by usage
sessions.usage.timeseries: owned by usage
Usage page: owned by usage
session.discussion.info: owned by the btw side-discussion tool
session.discussion.open: owned by the btw side-discussion tool
/btw: owned by the btw side-discussion tool
session.reactions.list: owned by chat reactions
session.reactions.set: owned by chat reactions
session.typing: internal presence signal
sessions.viewers.set: internal presence signal
sessions.observer.visibility: owned by the session observer; internal
sessions.pluginPatch: internal plugin-originated metadata patch
sessions.providerReview.continue: owned by provider review; not described as a user action
chat.subscribe: owned by nodes (server-node-events.ts); not a session request method
chat.unsubscribe: owned by nodes (server-node-events.ts); not a session request method
openclaw agent --message: owned by agents
conversations_list: owned by channel delivery (conversations)
conversations_send: owned by channel delivery (conversations)
conversations_turn: owned by channel delivery (conversations)
message tool: owned by channel delivery
suggest_task: owned by tasks
dismiss_task: owned by tasks
Start a suggested task: owned by tasks
/think: owned by models; the row only stores the toggle
/fast: owned by fast mode; the row only stores the toggle
/verbose: owned by tool policy; the row only stores the toggle
/reasoning: owned by models; the row only stores the toggle
/queue: owned by queue policy
/elevated: owned by tool policy
/tools: owned by tool policy
/models: owned by models
/context list: owned by context
openclaw status: owned by status and health
openclaw health: owned by status and health
openclaw channels status --probe: owned by channels
/acp spawn --bind here: owned by ACP
openclaw plugins enable session-share: owned by plugins
openclaw connect <join-url> --commands …: owned by nodes
openclaw nodes list: owned by nodes
openclaw node run --all-commands: owned by nodes
openclaw devices join-code: owned by devices
openclaw devices list: owned by devices
openclaw devices approve: owned by devices
openclaw devices rotate: owned by devices
Settings > Devices pairing: owned by devices
openclaw security audit: owned by security
openclaw reset: owned by onboarding and reset
openclaw onboard --reset: owned by onboarding and reset
openclaw gateway --dev --reset: owned by onboarding and reset
openclaw update cleanup: owned by update
projects.register: owned by projects; New session only consumes it
projects.list: owned by projects; New session only consumes it
fs.listDir: owned by filesystem; New session only consumes it
worktrees.branches: owned by worktrees; New session only consumes it
environments.list: owned by environments; New session only consumes it
`/activity/<name>-<id>` person links: owned by activity
`/beam/<title>-<id>` share links: owned by Beam
Settings → Appearance (other than Show task progress cards): sidebar chrome owned by the Control UI shell
Keyboard-shortcuts help: owned by the Control UI shell
Edit pinned items: owned by the Control UI shell
Page reorder: owned by the Control UI shell
Plugin tabs: owned by the Control UI shell
memory.search.rememberAcrossConversations: owned by memory
Dreaming admission policy (memory-core memoryPolicy): owned by memory
memory_search tool: owned by memory
openclaw memory forget --participant / --hook-source: owned by memory
openclaw memory index: owned by memory
Legacy /dock-* commands: removed (retired channel docking)
openclaw agents delete store delegation: owned by agents
openclaw backup cold-archive capture and restore: owned by backups
Swarm agents_wait: owned by swarm
Swarm agents.run() in Code Mode: owned by swarm
Codex native `thread/archive` supervision: owned by the codex plugin
openclaw gateway restart: owned by the gateway service (used here only as an event trigger)
openclaw gateway stop: owned by the gateway service (used here only as an event trigger)
openclaw gateway start: owned by the gateway service (used here only as an event trigger)
Plugin hook session_start: owned by the plugin SDK
Plugin hook session_end: owned by the plugin SDK
Plugin hook before_compaction: owned by the plugin SDK
Plugin hook after_compaction: owned by the plugin SDK
Plugin hook subagent_ended: owned by the plugin SDK
Plugin SDK session store runtime (getSessionEntry, patchSessionEntry, upsertSessionEntry, deleteSessionEntry): owned by the plugin SDK
openclaw doctor non-session checks (cron, plugin, model-auth, sandbox): owned by doctor

## Conditions
| Condition | Source | Kind | Persona trait |
| --- | --- | --- | --- |
| A turn in flight on the session (turn-in-flight) | C: docs/concepts/session.md "Gateway restart recovery"; docs/gateway/protocol/rpc-session-control.md "Session control" (hasActiveRun, activeRunIds). D: the same two headings (chat.send queueMode, hasActiveRun) | ambient (setup) | mock-provider-held-turn |
| Pending inputs queued behind the active turn and retained (queued, cancelled, interrupted) | C: docs/concepts/session-tool.md "Listing and reading sessions" (pendingInputs); docs/web/control-ui/sessions-and-sidebar.md "New-session preferences and recents". D: docs/concepts/session-tool.md "Sending cross-session messages"; docs/web/control-ui/sessions-and-sidebar.md "New-session preferences and recents" | ambient | mock-provider-held-turn, session-interrupted-inputs |
| Sub-agents working for the session (subagents-working) | C: docs/concepts/session-tool.md "Spawning sub-agents"; docs/concepts/main-session.md "What flows into the main session". D: docs/concepts/main-session.md "What flows into the main session"; docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation" (Subagents working ring) | ambient (setup) | session-orchestrator-idle, mock-provider-tool-calls |
| An incognito session open in memory (incognito-thread-open) | C: docs/concepts/session.md "Incognito sessions"; docs/web/control-ui/sessions-and-sidebar.md "New session page". D: docs/concepts/session.md "Incognito sessions"; docs/web/control-ui/sessions-and-sidebar.md "OpenClaw Chat workspace startup" | ambient (setup, browser) | none |
| Main session rolling across channels (main-session-rolling-across-channels) | C: docs/concepts/main-session.md "Home"; docs/concepts/session.md "DM isolation" | ambient | session-main-rolling |
| Group and room sessions isolated and watched by Home | C: docs/concepts/session.md "Group and room routing"; docs/concepts/session-state.md "Watchers". D: docs/concepts/main-session.md "What flows into the main session"; docs/concepts/session-state.md "Watchers" (ambient groups) | ambient | session-group-watched |
| DM isolation with identity links | D: docs/concepts/session.md "DM isolation"; docs/concepts/main-session.md "When you want isolation instead" | ambient | dm-scope-isolated |
| A long conversation of thousands of messages with compactions (long-session-compacted) | C: docs/concepts/compaction.md "How it works"; docs/concepts/main-session.md "A rolling session with durable history". D: docs/concepts/compaction.md "How it works"; docs/reference/session-management-compaction/resident-history.md "First slice and completion evidence"; docs/gateway/protocol/rpc-session-control.md "Session control" (512 KiB history pages) | ambient | session-long-compacted |
| Pruned tool results recorded as transcript projections (tool-results-pruned) | C and D: docs/concepts/session-pruning.md "Client-side pruning" | ambient | session-pruned-projections |
| Pinned, snoozed, archived and grouped sessions in the store, pinned and other protected rows included | C: docs/concepts/session.md "Session maintenance"; docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation"; docs/reference/session-management-compaction/schema.md "Session store schema". D (two conditions, "Archived sessions in the store" and "Pinned and otherwise protected sessions"): docs/cli/sessions.md "Archive sessions"; docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation"; docs/concepts/session.md "Session maintenance" | ambient | sessions-organized-mixed |
| Nested children and forks in the sidebar | C: docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation"; docs/reference/session-management-compaction/schema.md "Session ids (sessionId)" | ambient | sessions-organized-mixed |
| Transcripts held in cold storage | C: docs/reference/session-management-compaction/maintenance.md "Cold transcript storage"; docs/gateway/config-agents/sessions.md "Cold storage". D: the same two, plus docs/gateway/protocol/rpc-session-control.md "Session control" (sessions.preview status cold) | ambient | transcripts-cold-stored |
| A store of thousands of sessions near the entry cap | C: docs/concepts/session.md "Session maintenance"; docs/reference/session-management-compaction/maintenance.md "Store maintenance and disk controls". D: docs/cli/sessions.md "openclaw sessions"; docs/concepts/session.md "Session maintenance" (maxEntries 5000) | ambient | sessions-thousands-near-cap |
| Store over its disk budget | C: docs/concepts/session.md "Session maintenance"; docs/reference/session-management-compaction/maintenance.md "Store maintenance and disk controls" | ambient | store-over-disk-budget |
| Several people sharing one Gateway (owners, members, drafts, shared sessions) | C: docs/gateway/config-agents/sessions.md "Session field details" (sharing); docs/web/control-ui/sessions-and-sidebar.md "Session menu". D: docs/gateway/config-agents/sessions.md "Session" (sharing); docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation" (Owners filter, Involving me) | ambient | gateway-multi-user-profiles, session-shared-readonly |
| Public session link enabled | C: docs/web/urls.md "Public session transcripts" | ambient | session-public-shared |
| Imported transcript still a draft | C: docs/cli/sessions.md "Import transcripts" | ambient | catalog-claude-transcript, session-imported-draft |
| A session goal active | C: docs/tools/goal.md "Statuses" | ambient | session-goal-active |
| A progress card saved on a session | C: docs/tools/progress-card.md "Where the card appears" | ambient | session-progress-card |
| A sub-agent session bound to a channel thread | C and D: docs/tools/subagents/thread-bound-sessions.md "Thread-bound sessions" | ambient | session-thread-bound |
| Several agents, with a session under the raw global key | C: docs/cli/sessions.md (--all-agents); docs/reference/session-management-compaction/store.md "Two persistence layers"; docs/concepts/session.md "How messages are routed" | ambient | agents-multiple-with-global-key |
| Synthetic automation sessions (cron, hook, heartbeat, model-run rows) | C: docs/reference/session-management-compaction/schema.md "Session keys (sessionKey)"; docs/reference/session-management-compaction/maintenance.md "Cron sessions and run logs" | ambient | sessions-synthetic-automation |
| Sessions bound to a managed worktree or project with workspace changes | C: docs/web/control-ui/sessions-and-sidebar.md "Sidebar navigation" (Coding zone); docs/gateway/protocol/rpc-session-control.md "Session control" (sessions.create worktree). D: the same two headings | ambient | session-with-worktree, session-workspace-changes |
| An automatic reset policy configured (daily or idle) | D: docs/concepts/session.md "Session lifecycle"; docs/reference/session-management-compaction/schema.md "Session ids (sessionId)" | ambient | config-reset-idle-short |
| Stale peer-keyed DM rows after a dmScope change | C: docs/concepts/session.md "Session maintenance" (--fix-dm-scope) | ambient | sessions-stale-peer-dm-rows |
| Stale dashboard sessions past archiveDashboardAfter | C: docs/concepts/session.md "Session maintenance" (archiveDashboardAfter) | ambient | sessions-stale-dashboard |
| A CLI profile paired with the Gateway origin | C: docs/concepts/session-attachment.md "Pair once per Gateway origin" | ambient | cli-profile-paired |
| Heartbeat wakes the main session | C: docs/concepts/main-session.md "What flows into the main session" (Heartbeats); docs/concepts/session-state.md "Notices: one, not many" | event | config-heartbeat-short |
| A cron run creates a fresh session | C: docs/concepts/session.md "How messages are routed"; docs/reference/session-management-compaction/maintenance.md "Cron sessions and run logs" | event | cron-job-isolated |
| Session-creation notice consumed by Home on its next turn | D: docs/concepts/main-session.md "What flows into the main session"; docs/concepts/session-state.md "The signal log" | event | none |
| Another actor changes a watched session (stale-state notice) | C and D: docs/concepts/session-state.md "Notices: one, not many" and "Reconciling" | event | session-pair-watched |
| Sub-agent completion announced to the requester, including after sessions_yield | C: docs/concepts/session-tool.md "Spawning sub-agents"; docs/concepts/subagent-yield-handoff.md "Progress after yield". D: docs/concepts/subagent-yield-handoff.md "Ownership through the handoff"; docs/concepts/session-tool.md "Spawning sub-agents" | event | none (uses subagents-working) |
| Title generation delayed behind the reply on a single-request model endpoint | C: added during the known-break cross-check from PR 160251, no listed document (as provider-serves-one-request-at-a-time). D: docs/web/control-ui/sessions-and-sidebar.md "New session names"; docs/gateway/protocol/rpc-session-control.md "Session control" (sessions.title.prepare, titleSource) | event | mock-provider-single-slot |
| Search index reconciliation after an import or rewind (indexing: true) | D: docs/concepts/session-search.md "Index lifecycle" | event | none |
| Manual compaction (/compact, sessions.compact, --max-lines) | D: docs/concepts/compaction.md "Manual compaction"; docs/cli/sessions.md "Compact a session" | event | session-long-compacted |
| Auto-compaction near the context limit with the pre-compaction memory flush | C and D: docs/concepts/compaction.md "Auto-compaction"; docs/reference/session-management-compaction/housekeeping.md "Pre-compaction memory flush" | event | session-at-compaction-threshold |
| Context-overflow error recovery (compact and retry) | C and D: docs/concepts/compaction.md "Auto-compaction"; docs/reference/session-management-compaction/compaction.md "When auto-compaction happens" | event | mock-provider-overflow |
| Session reset clearing goal, card and queued notices and re-priming memory | D: docs/concepts/session.md "Session lifecycle"; docs/concepts/main-session.md "A rolling session with durable history"; docs/tools/goal.md "Statuses"; docs/tools/progress-card.md "Clear a card" | event | none |
| Daily or idle reset rollover to a new sessionId | C and D: docs/concepts/session.md "Session lifecycle"; docs/reference/session-management-compaction/schema.md "Session ids (sessionId)" | event | config-reset-idle-short, session-idle-expired |
| Right-to-left Control UI locale | C: added during the known-break cross-check from PR 142227 (no listed document) | event | ui-locale-rtl |
| Concurrent reads and writes on one agent database (a search overlapping a card save and a send) | D: docs/concepts/session.md "Session maintenance"; docs/reference/session-management-compaction/store.md "Two persistence layers"; docs/reference/session-management-compaction/resident-history.md "First slice and completion evidence" | event | session-long-compacted |
| Cold-storage extraction run and restore on open | C and D: docs/reference/session-management-compaction/maintenance.md "Cold transcript storage"; docs/gateway/config-agents/sessions.md "Cold storage" | event | transcripts-cold-stored |
| Maintenance pass (age prune, maxEntries cap, dashboard auto-archive, disk budget) | C: docs/concepts/session.md "Session maintenance" (age boundary, 30-minute recheck, dashboard auto-archive). D: docs/concepts/session.md "Session maintenance"; docs/reference/session-management-compaction/maintenance.md "Store maintenance and disk controls"; docs/cli/sessions.md "Cleanup maintenance" | event | sessions-thousands-near-cap, sessions-stale-dashboard, store-stale-sessions-over-cap |
| Session settings reload without a Gateway restart | C: docs/gateway/config-agents/sessions.md "Cold storage"; docs/concepts/compaction.md "Using a different model" | event | none |
| Sub-agent session auto-archived after archiveAfterMinutes | C and D: docs/tools/subagents/thread-bound-sessions.md "Auto-archive" | event | config-subagent-archive-fast |
| Disk-budget cleanup, including deferral on an incomplete WAL checkpoint | C: docs/concepts/session.md "Session maintenance"; docs/reference/session-management-compaction/maintenance.md "Store maintenance and disk controls". D (as "Disk-budget cleanup deferred by an incomplete WAL checkpoint"): docs/concepts/session.md "Session maintenance" (deferredReason checkpoint-incomplete) | event | store-over-disk-budget |
| Gateway switch while deletion cleanup is loading | C: added during the known-break cross-check from PR 125665 (no listed document) | event | gateway-second-instance |
| Gateway restart during work (turn, sub-agents, queued input, incognito) | C: docs/concepts/session.md "Gateway restart recovery" and "Incognito sessions"; docs/concepts/session-state.md "Notices: one, not many"; docs/concepts/session-pruning.md; docs/tools/subagents/thread-bound-sessions.md "Auto-archive". D: docs/concepts/session.md "Gateway restart recovery"; docs/concepts/session-state.md "Notices: one, not many"; docs/concepts/session-pruning.md "Client-side pruning" | event | none (uses the setup phases) |
| Incognito session expiry (after 24 hours, or at a Gateway restart) | C (24 hours): docs/concepts/session.md "Incognito sessions". D (at restart): docs/concepts/session.md "Incognito sessions" | event | none |
| A corrupt or misplaced agent database generation quarantined by Doctor | C (ambient, as quarantined-database-generation): docs/gateway/doctor/state-and-sessions.md "Legacy state migrations (disk layout)", added during the known-break cross-check from PR 110732. D: docs/gateway/doctor/state-and-sessions.md "3. Legacy state migrations" | event (C recorded it as ambient) | store-quarantined-generation, store-corrupt-generation |
| Legacy store import and repair by Doctor | C: docs/gateway/doctor/state-and-sessions.md "Legacy state migrations (disk layout)", "Session lock cleanup", "Session transcript branch repair"; docs/concepts/session.md "Where state lives". D: docs/reference/session-management-compaction/store.md "Two persistence layers"; docs/gateway/doctor/state-and-sessions.md "3. Legacy state migrations", "3c. Session lock cleanup", "3d. Session transcript branch repair" | event | store-legacy-sessions-json, store-rows-legacy-aliases, sessions-stale-lock-files |

## Headings walked

The historical runs did not record a heading-by-heading walk. Their condition citations are retained above, but they do not establish which headings were read without yielding a condition. No heading totals or completed walk are inferred. See comparison.md for the known shortfall.

## Breaks cross-check
| Break | Phase | Note |
| --- | --- | --- |
| 167163 keep session search parallel with accurate indexing | search-history; event-concurrent-search-and-card-save | C: sessions.search runs while the setup turn saves progress cards (session-turn-hold --progress-cards). D: the search, a card save and a send overlap in one phase (condition added during the known-break cross-check) |
| 167029 parallelize foreground transcript reads | search-history; event-search-reindex-after-import; event-concurrent-search-and-card-save | sessions.search with and without agentId across several agents records the indexing flag |
| 162332 restore Windows session creation with namespaced database paths | none | Outside the product's reach on this harness: Windows-only path handling, owned by platform per the bound |
| 149351 keep inline comments compact and readable | comment-on-selected-text | C: operation added during the known-break cross-check; multiline comment draft recorded on screen |
| 142227 replace chat timeline with compact left rail | event-locale-rtl-read-transcript | C: condition added during the known-break cross-check; transcript rail under an RTL locale |
| 125665 retire drafts after authoritative session deletion | event-gateway-switch-during-deletion | C: condition added during the known-break cross-check, delete then switch Gateway, both Gateways' drafts and outbox recorded. D recorded it as outside reach (one {env}); reconciliation keeps C's mapping |
| 110732 read-only database access for pure-read commands | event-corrupt-store-quarantine; browse-sessions | D: quarantine by Doctor then read-only CLI and sessions.list. C: openclaw sessions --all-agents under a quarantined generation |
| 163821 preserve CLI launches, usage reports, and subagent completion | browse-sessions | sessions.list and openclaw sessions --all-agents run while the incognito session exists and several agents add sibling stores; the invalid-locator variant needs persona addition store-locator-invalid (C) |
| 162560 coalesce chat pane updates to one per animation frame | read-history-ui; stop-run | C: browser read of the main chat while the held turn streams. D: send-then-stop flow records the working indicator and composer |
| 148901 updates fail when configured agents have no legacy history | event-legacy-store-doctor | persona store-legacy-sessions-json includes an unused configured agent with an empty sessions.json and no database |
| 143837 compose prepared catalog sources before lookup | none | Its only changed path, src/agents/sessions/model-registry.ts, is excluded by the bound (owned by models) |
| 165600 prepare sharing and custody authority through session workers | setup-incognito-session; send-message | chat.send to the incognito session after its creation (D in setup, C in send-message) |
| 164989 read model context and watermarks through the history reader | none | Outside this template's reach: needs a cloud-worker placement, owned by cloud workers per the bound |
| 163352 a subagent's previous result is lost when its next turn starts quickly | event-subagent-completion | sessions_yield waitFor message, then a quick sessions_send follow-up to the yielding child before the completion is announced |
| 160251 defer session titles until reply progress | event-provider-single-slot-start-session; start-new-session | new sessions titled while the reply holds the single provider slot; final titles recorded |
| 163030 preserve details after background writes | fork-rewind; event-cold-extraction-and-restore | fork, rewind and branch switch on an idle cold session (C); branches.list and fork of the cold session before restore (D) |
| 160126 keep task progress dismissible in every state | publish-progress | Dismiss and Clear on a card with an unfinished step and on a note-only card; an empty progressCard.put |
| 159806 keep streaming chats responsive | read-history-ui; stop-run | a late-growing streaming reply at the bottom of the transcript and the composer geometry recorded on screen |
| 157135 preserve steering across reconnects and show queued input | read-history-ui; send-message | scroll through a session of thousands of messages with timing; queued input display |
| 147519 add a desktop-first Systems workspace | browse-sessions | sidebar navigation and session list scroll regions recorded on screen |
| 145553 preserve public status URLs during credential redaction | none | test-only: only a test file in the area changed; the behavior (logging.redactPatterns) is owned by logging; not counted (C listed it, D did not) |
| 151470 drop subagent run rows from the sidebar | event-subagent-completion | parent unread state after a hidden subagent run finishes; Mark as read recorded on screen |
| 166049 open public threads at their regular links | open-by-link; share-session | reload, new tab and bookmark of a /chat link under token auth; signed-out reads before and after public access |

## Undocumented conditions
Right-to-left Control UI locale: needed by 142227, stated in no document (run C)
Gateway switch while deletion cleanup is loading: needed by 125665, stated in no document (run C)
Title generation delayed behind the reply on a single-request model endpoint: run C listed it here for 160251; run D cites docs/web/control-ui/sessions-and-sidebar.md "New session names", so it is no longer undocumented

## Reconciliation

Inputs: run C (24 operations, 44 conditions, 44 phases) and run D (30 operations, 35 conditions, 50 phases). Result: 31 operations, 51 conditions, 455 entry points (348 placed, 107 excluded), 60 phases. Counting basis for the union: one Gateway method, one CLI command or subcommand (flags are not counted), one named UI control, one route or call site, one tool action where a run listed tool actions separately.

### Taken from run C only

Operation: Comment on selected text in a chat (C added it during the known-break cross-check for 149351).

Entry points placed by C, absent from D:
- "New conversation" agent menu (team mode) (Start a new session)
- OPENCLAW_SHELL=exec rejection of CLI message RPCs (Send a message and get a reply)
- Home page (`agent:<id>:main`) and agent switcher (Talk to Home while working)
- Pending and stopped input bubbles (Open a session and read its history)
- Memory ingestion and session backfill transcript reads (Open a session and read its history)
- Slug-only one-segment fallback (Open a session by link)
- Reload, new tab and bookmark of a chat link under token or password auth (Open a session by link)
- Incognito literal links (`/chat/<agent>/dashboard/incognito-<uuid>`) (Open a session by link)
- Cmd/Ctrl-click a sidebar row into a new tab (Open a session by link)
- Expired-link retry after reconnect (Open a session by link)
- First-contact device pairing for a Gateway origin (Continue a session in the terminal or a coding harness)
- Team mode agent group headers (Browse and find sessions)
- Dashboards gallery link (Share a session with teammates or publicly)
- session.sharing / session.sharing.evidence / session.suggestion events to clients (Share a session with teammates or publicly)
- Automatic parent fork for thread and subagent children (100K-token cap, isolated fallback) (Fork or rewind a conversation)
- Daily and idle reset policy (session.reset, resetByType, resetByChannel) (Reset a session)
- UI Settings compaction knobs (agents.defaults.compaction.*) (Compact a session)
- "Automation attached" (Inspect a session's status)
- TUI footer session fields (Inspect a session's status)
- "Subagents working" ring and child attention notices (Run background work with sub-agents)
- subagents.allowAgents / requireAgentId / maxSpawnDepth policy (Run background work with sub-agents)
- Settings Collapse by default (Publish progress on a session)
- Progress-card reminder for paired card renderers (Publish progress on a session)
- Pull-request dock and PR indicators (Work with a session's files, changes and processes)
- /trajectory (Export a session)
- Browser draft retirement after confirmed deletion (Delete a session)
- cron.sessionRetention pruning of isolated cron sessions (Maintain the session store)
- Selection popup comment draft (chat-selection-popup, chat-selection-annotations) (Comment on selected text in a chat)
- Sent inline comments and read-only comment previews (Comment on selected text in a chat)

Entry points C placed and D excluded (placed, by reconciliation):
- Session-scoped MCP attach grant (src/gateway/server-methods/attach.ts) (Continue a session in the terminal or a coding harness): D excluded as owned by MCP attach; C placed it
- Receiver catalog "OpenClaw sessions" (Share a session with teammates or publicly): D excluded receiver-side catalog rows as owned by session catalogs; C placed it
- agents_list tool (spawn target discovery) (Run background work with sub-agents): D excluded as owned by agents; C placed it
- openclaw memory forget --agent <id> --session <id-or-key> (Delete a session): D excluded memory forget as owned by memory; C placed the --session form

Entry points excluded by C, absent from D:
- sessions.create execNode and worker placement
- Systems machine list
- `/focus/terminal`
- Usage page
- /btw
- openclaw agent --message
- message tool
- /think
- /fast
- /verbose
- /reasoning
- /queue
- /elevated
- /tools
- /models
- openclaw devices join-code
- openclaw devices list
- openclaw reset
- openclaw onboard --reset
- openclaw gateway --dev --reset
- projects.register
- projects.list
- fs.listDir
- worktrees.branches
- environments.list
- Settings → Appearance (other than Show task progress cards)
- Keyboard-shortcuts help
- Edit pinned items
- Page reorder
- Plugin tabs
- memory.search.rememberAcrossConversations
- Dreaming admission policy (memory-core memoryPolicy)
- Legacy /dock-* commands

Conditions found only by C:
- Main session rolling across channels (main-session-rolling-across-channels)
- Nested children and forks in the sidebar
- Store over its disk budget
- Public session link enabled
- Imported transcript still a draft
- A session goal active
- A progress card saved on a session
- Several agents, with a session under the raw global key
- Synthetic automation sessions (cron, hook, heartbeat, model-run rows)
- Stale peer-keyed DM rows after a dmScope change
- Stale dashboard sessions past archiveDashboardAfter
- A CLI profile paired with the Gateway origin
- Heartbeat wakes the main session
- A cron run creates a fresh session
- Right-to-left Control UI locale
- Session settings reload without a Gateway restart
- Gateway switch while deletion cleanup is loading

Phases built only from run C commands: talk-to-home, comment-on-selected-text, subagent-in-channel-thread, reset-session, maintain-session-store, event-heartbeat-wakes-main, event-cron-run-creates-session, event-context-overflow-recovery, event-locale-rtl-read-transcript, event-config-reload-session-maintenance, event-disk-budget-cleanup, event-gateway-switch-during-deletion, event-legacy-store-doctor. subagent-in-channel-thread is built from C's commands (C spawn-and-manage-subagents and send-message) for D's operation "Work with a sub-agent in its own channel thread", which D left uncovered; its intent sentence is new because neither run had a phase for it.

Persona traits only in C: agents-multiple-with-global-key, cli-profile-paired, config-heartbeat-short, cron-job-isolated, gateway-second-instance, mock-provider-overflow (D named provider-mock-context-overflow for its uncovered condition but did not require it), session-goal-active, session-idle-expired, session-imported-draft, session-interrupted-inputs, session-main-rolling, session-orchestrator-idle, session-pair-watched, session-progress-card, session-public-shared, session-shared-readonly, session-thread-bound, sessions-stale-dashboard, sessions-stale-lock-files, sessions-stale-peer-dm-rows, sessions-synthetic-automation, store-over-disk-budget, store-quarantined-generation, store-rows-legacy-aliases, ui-locale-rtl; persona additions not required by a phase: store-locator-invalid, hook-webhook-configured.

support.toWrite only from C: session-turn-hold.mjs, chat-history-read.mjs, channel-inbound-turn.mjs, cron-isolated-run.mjs, heartbeat-wake.mjs, gateway-restart.mjs, goal-control.mjs. support.existing only from C: run-concurrent-agent-turns.mjs (C listed it, no phase of either run calls it).

Breaks mapped only by C: 149351 (comment-on-selected-text), 142227 (event-locale-rtl-read-transcript), 125665 (event-gateway-switch-during-deletion). Listed only by C: 145553 (test-only).

Excluded paths only from C: src/gateway/session-observer*.ts, src/gateway/server-node-events.ts, src/gateway/session-worker-placement-context.ts, src/gateway/session-row-placement-projection*.ts, the CLI command bodies outside the globs (src/commands/doctor-session-*.ts, src/commands/sessions*.ts, src/cli/program/register.status-health-sessions.ts, src/cli/attach-cli.ts, src/cli/tui-cli.ts).

### Taken from run D only

Operations kept from D's finer grouping, each with its own entry-point family: Reach a session from a channel or job (channel routes, cron, hooks, heartbeat; C spread them over Start and Send), Search session history (sessions.search, palette and page search, sessions_search; C folded it into Find and filter), Archive or restore a session (openclaw sessions archive and the archive controls; C folded it into Organize), Message another session and watch it (sessions_send and the watcher notice; C folded it into Send), Work with a sub-agent in its own channel thread (/session commands, thread routing; C folded it into sub-agents), Recover after a Gateway restart (sessions.recover, Resume in new session, startup sweep; C had it only as a condition), Repair or migrate the session store (openclaw doctor; C folded it into maintenance).

Documents added by D: docs/tools/subagents.md, docs/tools/subagents/slash-command.md.

Entry points placed by D, absent from C:
- Sessions toolbar "+" (Start a new session)
- Project/Place picker (Start a new session)
- Browse folders (Start a new session)
- Worktree + From (Start a new session)
- Local destination (Start a new session)
- Effort and Fast mode on the New session page (Start a new session)
- Palette New session settings (Start a new session)
- Palette Remember settings (Start a new session)
- Palette @mentions (Start a new session)
- Palette pasted images (Start a new session)
- Check delivery (Send a message and get a reply)
- Retry (Send a message and get a reply)
- Control UI reconnect resume (one-shot sessionId) (Send a message and get a reply)
- Stop during worktree setup (Stop a run)
- HTTP history endpoint (complete history without a limit) (Open a session and read its history)
- Sidebar sections (Pages, Home, Pinned, custom groups, Other, Groups, Coding zones) (Browse and find sessions)
- Sessions page checkbox selection (Browse and find sessions)
- Cmd/Ctrl+B sidebar toggle (Browse and find sessions)
- Group collapse state (Organize a session)
- Public badge (Share a session with teammates or publicly)
- Public thread page Older messages (Share a session with teammates or publicly)
- Public thread page Back to latest (Share a session with teammates or publicly)
- Branch navigation (Fork or rewind a conversation)
- Auto-compaction with the pre-compaction memory flush (Compact a session)
- Stale-state notice to watchers (spawn edge, ambient group watch, explicit watch) (Message another session and watch it)
- Online activity card (Inspect a session's status)
- Subagents panel Running / Finished (Run background work with sub-agents)
- Back to Subagents (Run background work with sub-agents)
- Open parent session (Run background work with sub-agents)
- Subagents panel Stop (Run background work with sub-agents)
- Restart recovery of an interrupted turn (three-attempt budget, replayed tool calls, pending messages) (Recover after a Gateway restart)
- sessions.recover (Recover after a Gateway restart)
- Startup sweep re-materializing pending watcher notices (Recover after a Gateway restart)
- Workspace changes panel (Work with a session's files, changes and processes)
- Publish to GitHub (Work with a session's files, changes and processes)
- Processes panel (Work with a session's files, changes and processes)

Entry points D placed and C excluded (placed, by reconciliation):
- Gateway `agent` method input (shown as pending input) (Send a message and get a reply): C excluded as owned by agents; D placed it
- `/share/card.png` social card (Open a session by link): C excluded as owned by the share-card renderer; D placed it

Entry points excluded by D, absent from C:
- chat.showThinking
- Start a suggested task
- openclaw node run --all-commands
- openclaw devices rotate
- Settings > Devices pairing
- memory_search tool
- openclaw memory forget --participant / --hook-source
- openclaw memory index
- openclaw agents delete store delegation
- openclaw backup cold-archive capture and restore
- Swarm agents_wait
- Swarm agents.run() in Code Mode
- Codex native `thread/archive` supervision
- openclaw gateway restart
- openclaw gateway stop
- openclaw gateway start
- Plugin hook session_start
- Plugin hook session_end
- Plugin hook before_compaction
- Plugin hook after_compaction
- Plugin hook subagent_ended
- Plugin SDK session store runtime (getSessionEntry, patchSessionEntry, upsertSessionEntry, deleteSessionEntry)
- openclaw doctor non-session checks (cron, plugin, model-auth, sandbox)

Conditions found only by D:
- DM isolation with identity links
- An automatic reset policy configured (daily or idle)
- Session-creation notice consumed by Home on its next turn
- Search index reconciliation after an import or rewind (indexing: true)
- Manual compaction (/compact, sessions.compact, --max-lines)
- Session reset clearing goal, card and queued notices and re-priming memory
- Concurrent reads and writes on one agent database (a search overlapping a card save and a send)

Phases built only from run D commands: setup-incognito-session, reach-session-dm-isolated, reach-session-from-cron, event-creation-notice-home, event-search-reindex-after-import, event-manual-compaction, event-reset-clears-session-state, event-concurrent-search-and-card-save, event-recovery-after-restart, event-corrupt-store-quarantine.

Persona traits only in D: mock-provider-tool-calls (D: provider-mock-tool-calls), dm-scope-isolated, store-stale-sessions-over-cap, store-corrupt-generation.

support.toWrite only from D: gateway-call.mjs, stage-session-store-fixture.mjs. support.existing only from D: run-channel-probe-turn.mjs, run-cron-runtime-smoke.mjs.

Excluded paths only from D: src/gateway/server-methods/session-placement-read-projection.ts, src/gateway/server-methods/core-handlers.ts, src/gateway/server-methods/attach.ts, src/plugin-sdk/session-discussion.ts, docs/nodes/talk/*, docs/tools/acp-agents/sessions.md, src/acp/**, src/infra/heartbeat-*.ts, src/cron/**, src/channels/** other than src/channels/session*.ts, and the cloud-worker and catalog documents.

### Phase provenance (run the intent sentence came from, then commands taken from the other run)

- setup-turn-in-flight: intent from D (setup-turn-in-flight); source phases: C setup-turn-in-flight-main, D setup-turn-in-flight; commands C 2, D 1; taken from the other run: C setup-turn-in-flight-main[0] ensure-gateway-running, C setup-turn-in-flight-main[1] session-turn-hold
- setup-subagents-working: intent from C (setup-subagents-working); source phases: C setup-subagents-working, D setup-subagents-working; commands C 2, D 2; taken from the other run: D setup-subagents-working[0] sessions.create, D setup-subagents-working[1] sessions_spawn
- setup-incognito-session: intent from D (setup-incognito-session); source phases: D setup-incognito-session, C setup-incognito-thread-open; commands C 0, D 2
- reach-session-from-channel: intent from D (reach-session-from-channel); source phases: D reach-session-from-channel; commands C 2, D 2; taken from the other run: C send-message[6] channel-inbound-turn, C send-message[7] channel-inbound-turn
- reach-session-dm-isolated: intent from D (reach-session-dm-isolated); source phases: D reach-session-dm-isolated; commands C 0, D 3
- reach-session-from-cron: intent from D (reach-session-from-cron); source phases: D reach-session-from-cron; commands C 0, D 3
- start-new-session: intent from C (start-new-session); source phases: C start-new-session, D start-session-gateway, D start-session-ui; commands C 6, D 3; taken from the other run: D start-session-gateway[1] sessions.create, D start-session-gateway[2] sessions.create, D start-session-gateway[3] sessions.describe
- send-message: intent from C (send-message); source phases: C send-message, D send-message-queued, D send-message-steer, D inject-and-rpc-send; commands C 6, D 1; taken from the other run: D inject-and-rpc-send[1] run-gateway-session-send-turn
- talk-to-home: intent from C (talk-to-home); source phases: C talk-to-home, D talk-to-home; commands C 5, D 0
- read-history: intent from D (read-history); source phases: D read-history, C open-and-read-session; commands C 6, D 11; taken from the other run: C open-and-read-session[0] chat-history-read, C open-and-read-session[1] chat-history-read, C open-and-read-session[2] chat-history-read, C open-and-read-session[3] sessions.get, C open-and-read-session[4] sessions.describe, C open-and-read-session[5] sessions.preview
- read-history-ui: intent from D (read-history-ui); source phases: D read-history-ui; commands C 2, D 1; taken from the other run: C open-and-read-session[8] read-long-session-scroll, C open-and-read-session[9] read-streaming-main
- read-history-tool: intent from D (read-history-tool); source phases: D read-history-tool; commands C 1, D 2; taken from the other run: C open-and-read-session[7] sessions_history
- comment-on-selected-text: intent from C (comment-on-selected-text); source phases: C comment-on-selected-text; commands C 1, D 0
- open-by-link: intent from C (open-session-by-link); source phases: C open-session-by-link, D open-by-link; commands C 1, D 5; taken from the other run: D open-by-link[0] sessions.resolve, D open-by-link[1] sessions.resolve, D open-by-link[2] sessions.resolve, D open-by-link[3] sessions.resolve, D open-by-link[4] open-by-link
- continue-in-terminal: intent from D (continue-in-terminal); source phases: D continue-in-terminal, C continue-in-terminal-or-attach; commands C 2, D 7; taken from the other run: C continue-in-terminal-or-attach[0] sessions.resolve, C continue-in-terminal-or-attach[4] attach
- browse-sessions: intent from D (browse-sessions); source phases: D browse-sessions, C find-and-filter-sessions; commands C 3, D 13; taken from the other run: C find-and-filter-sessions[1] sessions list, C find-and-filter-sessions[2] sessions --agent, C find-and-filter-sessions[4] sessions.list
- search-history: intent from D (search-history); source phases: D search-history; commands C 1, D 4; taken from the other run: C find-and-filter-sessions[5] sessions.search
- inspect-status: intent from C (inspect-session-status); source phases: C inspect-session-status, D inspect-status; commands C 8, D 2; taken from the other run: D inspect-status[1] session_status, D inspect-status[4] sessions tail
- keep-goal: intent from C (set-session-goal); source phases: C set-session-goal, D keep-goal; commands C 12, D 3; taken from the other run: D keep-goal[0] /goal start, D keep-goal[2] /goal pause, D keep-goal[3] /goal resume
- publish-progress: intent from C (publish-progress-card); source phases: C publish-progress-card, D publish-progress; commands C 7, D 2; taken from the other run: D publish-progress[4] progressCard.put, D publish-progress[6] progressCard.put
- organize-session: intent from D (organize-session); source phases: D organize-session, C organize-sessions; commands C 2, D 12; taken from the other run: C organize-sessions[2] sessions.patch, C organize-sessions[11] sessions
- archive-restore: intent from D (archive-restore); source phases: D archive-restore; commands C 1, D 11; taken from the other run: C organize-sessions[3] sessions.patch
- change-model: intent from C (change-session-model-or-settings); source phases: C change-session-model-or-settings, D change-model; commands C 6, D 1; taken from the other run: D change-model[1] run-session-turn
- session-files-changes: intent from C (inspect-session-files-and-changes); source phases: C inspect-session-files-and-changes, D session-files-changes; commands C 10, D 3; taken from the other run: D session-files-changes[5] sessions.github.options, D session-files-changes[6] sessions.github.status, D session-files-changes[8] files-changes-processes-panels
- share-session: intent from C (share-session); source phases: C share-session, D share-session; commands C 15, D 1; taken from the other run: D share-session[14] session.visibility.set
- fork-rewind: intent from C (fork-rewind-branch); source phases: C fork-rewind-branch, D fork-rewind; commands C 8, D 2; taken from the other run: D fork-rewind[0] sessions.create, D fork-rewind[1] sessions.fork
- message-another-session: intent from D (message-another-session); source phases: D message-another-session; commands C 1, D 3; taken from the other run: C send-message[5] sessions_send
- run-subagents: intent from C (spawn-and-manage-subagents); source phases: C spawn-and-manage-subagents, D run-subagents; commands C 8, D 5; taken from the other run: D run-subagents[0] sessions_spawn, D run-subagents[1] sessions_spawn, D run-subagents[3] subagents, D run-subagents[4] /subagents list, D run-subagents[6] /subagents log
- subagent-in-channel-thread: intent from new intent; source phases: none; commands C 5, D 0
- import-transcript: intent from C (import-native-transcript); source phases: C import-native-transcript, D import-transcript; commands C 6, D 2; taken from the other run: D import-transcript[2] sessions.catalog.import, D import-transcript[3] sessions.describe
- export-session: intent from D (export-session); source phases: D export-session, C export-session; commands C 2, D 3; taken from the other run: C export-session[0] sessions export-trajectory, C export-session[1] sessions export-trajectory
- stop-run: intent from C (stop-running-turn); source phases: C stop-running-turn, D stop-run; commands C 9, D 1; taken from the other run: D stop-run[9] send-then-stop
- compact-session: intent from C (compact-session); source phases: C compact-session; commands C 6, D 1; taken from the other run: D event-manual-compaction[3] sessions.compact
- reset-session: intent from C (reset-session); source phases: C reset-session; commands C 8, D 0
- delete-session: intent from C (delete-session); source phases: C delete-session, D delete-session; commands C 7, D 1; taken from the other run: D delete-session[5] sessions.search
- maintain-session-store: intent from C (maintain-session-storage); source phases: C maintain-session-storage; commands C 11, D 0
- event-heartbeat-wakes-main: intent from C (event-heartbeat-wakes-main); source phases: C event-heartbeat-wakes-main; commands C 3, D 0
- event-creation-notice-home: intent from D (event-creation-notice-home); source phases: D event-creation-notice-home; commands C 0, D 6
- event-cron-run-creates-session: intent from C (event-cron-run-creates-session); source phases: C event-cron-run-creates-session; commands C 4, D 0
- event-watched-session-change: intent from C (event-other-actor-changes-watched-session); source phases: C event-other-actor-changes-watched-session, D event-watched-session-change; commands C 5, D 3; taken from the other run: D event-watched-session-change[0] run-session-turn, D event-watched-session-change[1] session_status, D event-watched-session-change[2] chat.history
- event-subagent-completion: intent from D (event-subagent-completion); source phases: D event-subagent-completion, C event-subagent-completion-announces; commands C 3, D 8; taken from the other run: C event-subagent-completion-announces[0] sessions_spawn, C event-subagent-completion-announces[1] sessions_send, C event-subagent-completion-announces[2] chat-history-read
- event-provider-single-slot-start-session: intent from C (event-provider-single-slot-start-session); source phases: C event-provider-single-slot-start-session; commands C 3, D 1; taken from the other run: D start-session-ui[1] palette-background-start
- event-search-reindex-after-import: intent from D (event-search-reindex-after-import); source phases: D event-search-reindex-after-import; commands C 0, D 3
- event-manual-compaction: intent from D (event-manual-compaction); source phases: D event-manual-compaction; commands C 0, D 6
- event-auto-compaction: intent from C (event-auto-compaction-at-threshold); source phases: C event-auto-compaction-at-threshold, D event-auto-compaction; commands C 3, D 1; taken from the other run: D event-auto-compaction[2] sessions.describe
- event-context-overflow-recovery: intent from C (event-context-overflow-recovery); source phases: C event-context-overflow-recovery; commands C 2, D 0
- event-reset-clears-session-state: intent from D (event-reset); source phases: D event-reset; commands C 0, D 8
- event-idle-reset-rollover: intent from C (event-scheduled-reset-rollover); source phases: C event-scheduled-reset-rollover, D event-idle-rollover; commands C 4, D 4; taken from the other run: D event-idle-rollover[0] run-session-turn, D event-idle-rollover[1] sessions.describe, D event-idle-rollover[2] run-session-turn, D event-idle-rollover[3] sessions.describe
- event-locale-rtl-read-transcript: intent from C (event-locale-rtl-read-transcript); source phases: C event-locale-rtl-read-transcript; commands C 1, D 0
- event-concurrent-search-and-card-save: intent from D (event-concurrent-search-and-card-save); source phases: D event-concurrent-search-and-card-save; commands C 0, D 7
- event-cold-extraction-and-restore: intent from D (event-cold-extraction-and-restore); source phases: D event-cold-extraction-and-restore, C event-cold-storage-extract-and-restore; commands C 1, D 10; taken from the other run: C event-cold-storage-extract-and-restore[7] sessions.storage.status
- event-maintenance-pass: intent from C (event-background-maintenance-pass); source phases: C event-background-maintenance-pass, D event-maintenance-pass; commands C 5, D 8; taken from the other run: D event-maintenance-pass[1] sessions cleanup, D event-maintenance-pass[2] sessions cleanup, D event-maintenance-pass[3] sessions cleanup, D event-maintenance-pass[4] sessions.cleanup, D event-maintenance-pass[5] sessions cleanup, D event-maintenance-pass[6] sessions.list, D event-maintenance-pass[7] sessions.describe, D event-maintenance-pass[8] sessions --json
- event-config-reload-session-maintenance: intent from C (event-config-reload-session-maintenance); source phases: C event-config-reload-session-maintenance; commands C 3, D 0
- event-subagent-auto-archive: intent from C (event-subagent-auto-archive); source phases: C event-subagent-auto-archive, D event-subagent-auto-archive; commands C 4, D 3; taken from the other run: D event-subagent-auto-archive[0] sessions_spawn, D event-subagent-auto-archive[1] subagents, D event-subagent-auto-archive[2] sessions.describe
- event-disk-budget-cleanup: intent from C (event-disk-budget-cleanup); source phases: C event-disk-budget-cleanup; commands C 5, D 0
- event-gateway-switch-during-deletion: intent from C (event-gateway-switch-during-deletion); source phases: C event-gateway-switch-during-deletion; commands C 2, D 0
- event-gateway-restart-during-work: intent from C (event-gateway-restart-during-work); source phases: D event-gateway-restart-during-turn, C event-gateway-restart-during-work; commands C 5, D 10; taken from the other run: D event-gateway-restart-during-turn[0] run-session-turn, D event-gateway-restart-during-turn[1] open-session-keep-open, D event-gateway-restart-during-turn[2] gateway restart, D event-gateway-restart-during-turn[3] ensure-gateway-running, D event-gateway-restart-during-turn[4] run-session-turn, D event-gateway-restart-during-turn[5] chat.history, D event-gateway-restart-during-turn[6] sessions.describe, D event-gateway-restart-during-turn[7] chat.history, D event-gateway-restart-during-turn[8] sessions.list, D event-gateway-restart-during-turn[9] reconnect-and-send
- event-recovery-after-restart: intent from D (event-recovery-after-restart); source phases: D event-recovery-after-restart; commands C 0, D 2
- event-corrupt-store-quarantine: intent from D (event-corrupt-store-quarantine); source phases: D event-corrupt-store-quarantine; commands C 0, D 6
- event-legacy-store-doctor: intent from C (event-doctor-repairs-legacy-session-state); source phases: C event-doctor-repairs-legacy-session-state, D event-legacy-store-doctor; commands C 7, D 0

### Merges and corrections made while reconciling

- Entry points: union by name; four placed-versus-excluded differences resolved to placed in each direction as listed above. The session.sharing / session.sharing.evidence / session.suggestion events stay placed under Share because C placed them and reconciliation never drops, although the entry-point rule says broadcast events are not entry points.
- Conditions merged by meaning, both citations kept: C sessions-pinned-snoozed-archived-grouped with D "Archived sessions in the store" and D "Pinned and otherwise protected sessions"; C pending-inputs-retained with D "Follow-up messages queued behind the active turn"; C store-near-entry-cap with D "A store of thousands of sessions"; C provider-serves-one-request-at-a-time with D "Automatic title generation delayed or failed after submission"; C disk-budget-cleanup with D "Disk-budget cleanup deferred by an incomplete WAL checkpoint"; C incognito-expiry-24h with D "Incognito session expiry at Gateway restart"; C quarantined-database-generation (ambient) with D "A corrupt or misplaced agent database generation quarantined by Doctor" (event); and the one-to-one renames (turn, sub-agents, incognito, group watch, long history, pruning, cold storage, multi-user, thread binding, worktree, restart, auto-compaction, overflow, rollover, cold extraction, maintenance pass, auto-archive, legacy doctor, watched-session change, subagent completion).
- Scripts in support.toWrite merged by the product method they wrap: C chat-send.mjs, D run-session-turn.mjs and D send-chat-command.mjs (all chat.send) became support/verify/chat-send.mjs, with D's --command rewritten to --message; C browser-session-flow.mjs and D control-ui.mjs (Control UI flows) became support/verify/control-ui.mjs with --timeout; C public-thread-read.mjs and D anonymous-thread-get.mjs (anonymous GET of the public thread) became support/verify/public-thread-read.mjs; C resume-handoff.mjs and D run-resume.mjs (openclaw resume) became support/verify/run-resume.mjs; C agent-tool-turn.mjs (sessions.send turn) and D run-agent-tool.mjs (chat.send turn) became support/verify/agent-tool-turn.mjs because both wrap one scripted session-tool call.
- Persona traits merged by the persona content they name, D names and keys rewritten in D commands: provider-mock-slow-turn to mock-provider-held-turn (key marker); provider-mock-single-slot to mock-provider-single-slot; provider-mock-tool-calls to mock-provider-tool-calls; session-long-history to session-long-compacted (sessionKey to key; sessionId, shortId, anchorMessageId, searchWord, searchPrefix kept); session-pruned-tool-results to session-pruned-projections; store-many-sessions to sessions-thousands-near-cap (agentId); session-archived and session-pinned to sessions-organized-mixed (archivedKey, pinnedKey); session-worktree-bound to session-workspace-changes (key, filePath, htmlPath, assetRef) and session-with-worktree (workspaceDir); catalog-native-thread to catalog-claude-transcript (catalogId, hostId, threadId, searchWord); session-near-context-limit to session-at-compaction-threshold; reset-idle-one-minute to config-reset-idle-short (key); transcript-cold-archived and transcript-cold-eligible to transcripts-cold-stored (key, searchWord, eligibleKey); subagent-archive-one-minute to config-subagent-archive-fast; gateway-multi-user-profiles profileId to memberProfileId; session-group-watched sessionKey to key; C mock-provider-overflow sessionKey to key. store-corrupt-generation (D, a fixture file staged before Doctor) and store-quarantined-generation (C, a generation already quarantined in the persona) stay separate because they name different persona states.
- Timeout values: Kova's existing run-gateway-session-send-turn.mjs and run-tui-message-turn.mjs read --timeout in milliseconds (support/openclaw-runtime.mjs readTimeoutMs); run C passed seconds. Every C --timeout under 1000 on a node command is multiplied by 1000, and the merged scripts take milliseconds.
- Run D wrote --params and --args JSON unquoted; they are single-quoted as run C did, so the shell passes them intact.
- Run D passed --expected-text; it is removed from every command because a template carries no expected value. The existing scripts default it internally.
- Checkpoint state:agents/main/workspace/memory (D) is corrected to state:workspace/memory (C): the default agent workspace is <state dir>/workspace (src/agents/workspace-default-path.ts). Trailing slashes on state checkpoints are dropped.
- Commands a run adds were merged when they exercise an entry point, a variant or a condition the base phase lacks, or when they write a handle a later phase reads (D {run}/new-session.json, fork.json, fork-from-entry.json, hidden-child.json, imported-session.json, session-links.json, agent:main:kova-rpc-send). A command that repeats an entry point the base already exercises with the same purpose was not added; its entry point stays covered by the base command.
- Commands of C's send-message moved to the phases of D's finer operations: DM and group inbound to reach-session-from-channel, sessions_send to message-another-session, thread inbound to subagent-in-channel-thread. C's archive commands in organize-sessions moved to archive-restore; C's search commands in find-and-filter-sessions to search-history; C's sessions_history command to read-history-tool and its browser reads to read-history-ui.
- Setup phases: the union by condition. Each pair (turn in flight, sub-agents working, incognito) became one setup phase. The turn and sub-agent setups keep both runs' commands; the incognito setup keeps D's commands only, because C's single command starts the same New session Incognito flow, and C's later commands read D's handle {run}/incognito-session.json.


### Current-form conversion

The area input now records search symbols and literals recovered from the entry points above. This list was not an input to the historical runs, and no new source search or derivation is claimed. The template owner paths match the saved area input, including the four paths present there but absent from the historical template header.

Each phase lists the persona traits named by its placeholders and the additional provider, configuration and ambient state its intent requires. The header is their union. Script flags and status follow catalogue/openclaw.json; historical --timeout-ms spellings use --timeout, sessions list uses sessions, and the all-agent tail form places tail before its flags. Embedded JSON newlines are escaped.

All 60 historical phases and their command variants are represented in 68 current phases. The initial conversion produced 64 phases; subsequent contract corrections separate three persona-read groups from runtime-result consumers and add an explicit RPC target setup before ordering the records by their dependencies. An identical transcript-search command is retained once in search-history instead of repeated after deletion. No new derivation or coverage share is claimed. To satisfy the current timeout-sum rule, the three setup sequences are divided at existing command boundaries into seven setup phases. Their first segments retain the original identifiers; later segments have descriptive suffixes. At that conversion, commands, their order, background lifetimes and shared result files were unchanged, and original checkpoints remain on each sequence's final segment. Operation and event bounds are raised to their explicit command-timeout sums where needed, with slow set when the result exceeds 300000 milliseconds. Conditions assumed to persist across later phases remain historical assumptions rather than demonstrated execution evidence.

## Gateway parameter checks

The request payloads follow the schemas at the recorded OpenClaw revision: search is bounded to 25 results, branch navigation uses `sessionKey` and `leafEntryId`, and bulk edits use `targets[].key` plus a `patch` object. Cron-session queries search session keys for `:cron:` (and the configured job ID for the isolated-job case) with `excludeCron: false`; the list API has no `kinds` filter.

Run `KOVA_OPENCLAW_CHECKOUT=/path/to/openclaw node --test tests/verify-plan.mjs` with that checkout at the recorded revision and its declared `jiti`, `typebox` and `@openclaw/fs-safe` dependencies available. The optional check imports the actual protocol schemas, supplies fixture session identities for `--session-from` and archive/reset expectations for `--merge-from`, and validates every request, including withheld phases. Handle joins validate their originating request. `sessions.get` has no parameter schema at this revision; its requests are checked against the key, agent and limit contract in `sessions-read-by-key.ts`. The check skips when the checkout is absent. This proves parameter shapes, not helper execution or live phase outcomes.

The later schema correction also uses `sessionKey` and `question` for the Home
companion, `key` for message subscriptions and processes, `name` for group
rename, `cwd` plus `worktree` for group updates, `identityId` for sharing
members, `text` and `id` for suggestions, and explicit session expectations for
involvement and public sharing. Durable keys, earlier result files and the
narrowed cleanup/reveal/publication coverage are recorded in coverage.md.
The optional schema check validates the two `--from` mappings with synthetic
read results, including same-phase producer order and matching session/process
identity. It is not proof that the unfinished Gateway helper executes them.

The ordering check simulates helper availability and a complete manifest, then
selects every phase as well as ordinary creation, subagent, search and sidebar
paths. Missing setup traits still withhold their dependents. Run-file checks
distinguish the caller, spawned child and restore target identities. To exercise
the declared spawn output through an available Gateway caller, set
`KOVA_GATEWAY_CALLER` to `support/verify/gateway-call.mjs` in that checkout.
That optional test calls its actual session-file parameter resolver; it skips
when the helper is absent. It does not execute a model or a live phase.

The runtime-identity correction also makes the reindex condition self-contained:
an import or re-import and a rewind of a run-owned fork precede the searches of
their returned session keys. A lifecycle-admission check requires an observed
`expectedSessionId` for archive/snooze patches, including every bulk target.
The explicit RPC-send setup supplies the cross-session target and records its
canonical key instead of relying on another independently selected phase.


The reset and recovery corrections establish their own prerequisites: a goal
and card on a dedicated reset target, and an observed unrecovered tombstone
produced through a declared bounded native-recovery helper. Both use earlier
result files instead of assuming an independently selected phase ran. Creation
contracts identify generated child, run, goal and successor identities without
claiming creation for read results. The helper remains unfinished; the checks
cover records, ordering and 187 Gateway request shapes, not live recovery or
comparison. These corrections do not change the historical coverage totals.


State-generated transcript event IDs, including reset boundaries, are declared
from `transcript_event_identities.event_id`, owned by `session_id` and ordered
by `seq`. The owner session ID is declared first through `session_windows`.
The pinned reset producer and storage schema check that repeated equivalent
boundaries have the same declared address tokens while retained persona IDs
stay literal. This is declaration proof, not an executed comparison verdict.


Background joins use the same helper and Gateway method that created their
handle. The subagent completion phase joins `agent-tool-turn` before a separate
history read. Stored lifecycle archives declare retained session IDs, generation
IDs and generated archive names from `session_transcript_archives`; the retained
session key anchors identity after the live session row is deleted. Declaring
the complete generated archive name covers its timestamp and generation in file
addresses, while directory, reason, encoding and content hashes remain observable.
Cold-tier content-addressed names are hashes, not generated identity declarations.
The pinned archive-name producer and schema check both reset and deleted archive
addresses after live-row deletion. These remain declaration checks, not live
archive execution or an implemented comparison verdict.


The automatic-compaction command now reads the current budget of the session
identified by `session-at-compaction-threshold:key`, sizes input above its
remaining headroom, and requires a new native compaction after that submitted
turn succeeds. Its response carries the assertion evidence into the existing
checkpoint. Goal replay reads its original request through `--from`; the prior
resume writes that request once. Watched status uses an explicit validated
`stateVersion` to `changesSince` projection, preserving its producer dependency.
Group and thread inputs use recorded `group:<id>` and
`group:<parent>/thread:<id>` peers. The corruption fixture is staged beside the
selected database and swapped through the owned foreground Gateway handle,
with the original file set retained for restoration. The catalogue statuses
continue to distinguish these records from unfinished helper implementations.

### Profile admission and streaming prerequisites

Pinned `connect-session.ts` assigns no human profile to an ephemeral backend
client. `sessions-mutations.ts` requires that profile for involvement and
`sessions-suggestions.ts` derives the author from the authenticated client.
The personal calls therefore require the existing persona identity fixture and
its verified saved owner/member admission, through the same foreground owner.
They do not set identity fields in RPC payloads. These new adapter forms remain
unavailable until implemented. Their bounded restarts replace the earlier claim
of uninterrupted sharing overlap. Streaming-history coverage now establishes
and observes its own held turn immediately before the streaming browser read,
after all earlier historical reads, and records its completion afterward.

The same activity rule applies to queued sends and the busy-main reset: neither
can rely on setup surviving prior preparation stops. Each establishes its own
held turn, observes activity immediately before the sensitive call, and joins
its completion. Queued sends have recorded background lifetimes that exceed the
hold. Ambient subagent overlap is not established by these commands.

Explicit stop observations are synchronized to actual active target runs rather
than handle publication. Each abort has an immediately preceding exact-run
activity check, including the sessions tool's peer target; queued input and all
held work retain completion joins.

Public-share activation reuses the existing persona producer that keeps the
bearer in memory. Both member-list methods precede publication on the saved
read-only session, public reads use the existing safe helper, and revocation
follows them. This repairs the caller before stdout, optional helper files and
checkpoint serialization; a checkpoint-only filter would be too late.

Queue observations use the ordinary unanchored history response and validate
its physical/canonical session identity; a supplied sessionId requires an
anchored message read, which cannot provide input receipts. Both admitted
sender types can supply the guarded follow-up, while restart keeps its narrower
chat-send producer. Busy archival uses a fresh session-turn-hold operation and
an exact-run observation immediately before the archive request.
