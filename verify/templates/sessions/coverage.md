# Coverage: sessions

Operations: 31/31
Conditions: 51/51 (27 ambient, 24 event; historical classification)
Entry points: 348/455 (107 excluded)
Breaks mapped: 19/22

Uncovered:
- sessions.github.publish / sessions.github.confirm / sessions.github.status (entry points): publication needs a real GitHub repository and token, a real external service. Status requires the requestId returned by that publication, so both status requests are outside reach under credential-free execution. Options remain recorded; the historical C and D status requests were removed after schema validation.
- `openclaw.sessions.list.v1`, `openclaw.sessions.read.v1` and the receiver catalog "OpenClaw sessions" (entry points): need a second Gateway with a paired node host running the session-share plugin (C and D)
- openclaw tui <target> with a Control UI URL, gateway shorthand or short reference (branch of entry point openclaw tui): run-tui-message-turn.mjs opens the TUI by session name; only --session is driven (C and D)
- openclaw resume picker (branch of entry point openclaw resume): the picker needs an interactive TTY selection; query, handoff and session-URL forms are driven (C; D drives the query form)
- openclaw sessions tail --follow (branch of entry point openclaw sessions tail): follow mode never exits on its own; the non-follow tail is recorded (C)
- openclaw sessions --store <path> and openclaw sessions cleanup --store <path> (branches): the offline legacy selector needs exclusive ownership of the state directory while the Gateway is stopped (C)
- /trajectory (entry point): needs the owner to approve the exec request in a client; /export-trajectory is sent and its reply recorded, the CLI export-trajectory path is recorded (C)
- Memory ingestion and session backfill transcript reads (entry point, from memory): scheduled by the memory plugin's dreaming pass, owned by memory (C)
- sessions.patch { autoLabel } from the Android app (entry point): needs a paired Android node (C and D)
- openclaw doctor --session-sqlite import, compact and restore (entry points): restore moves the persona's archived legacy artifacts back and is destructive to the shared persona (C); no phase of either run drives import or compact; inspect and --fix are recorded
- Dashboard widget `session:progress` (entry point, from dashboards): owned by dashboards; no dashboard persona or widget placement (C and D)
- Channel progress-draft previews of the checklist (entry point, from channels): need a channel that renders editable drafts (Telegram or Discord); the conformance channel and channel probe do not (C and D)
- Webhook session `hook:<uuid>` (entry point, from hooks): no webhook persona and no catalogue script sends a webhook; persona addition hook-webhook-configured (C and D)
- Identity links (session.identityLinks) (entry point, from channels): the channel probe and inbound script exercise single-identity routes only (D)
- /agents binding state (entry point, from agents): owned by agents; not driven (C and D)
- ACP child session creation and ACP child run (entry points, from ACP): need an external ACP harness on the Gateway host (C and D)
- Configured session.resetTriggers and /new <model> (entry point and branch): no custom resetTriggers persona and the model-switch variant is not sent; /new and /reset are recorded (C and D)
- First-contact device pairing for a Gateway origin (entry point, from devices): the persona CLI profile is already paired; pairing approval is owned by devices (C)
- "Received · waiting for worker setup" (entry point): needs a worker placement, excluded by the bound (cloud workers) (C)
- OPENCLAW_SHELL=exec rejection of CLI message RPCs (entry point): needs the agent shell marker in the calling environment; not driven (C)
- Pull-request dock and PR indicators (entry point): need a published pull request (GitHub) (C)
- Gateway `agent` method input (entry point): not called; chat.send and sessions.send cover the same pending-input display (D)
- HTTP history endpoint (entry point): only the WebSocket chat.history is called (D)
- Startup startup check refusal for an unimported legacy store (entry point, from gateway startup): both legacy-store phases run Doctor before starting the Gateway, so the refusal path is not recorded (D; C's phase has the same order)
- Incognito session expiry after 24 hours (branch of condition "Incognito session expiry"): needs a clock the harness does not move; the restart branch is recorded by event-gateway-restart-during-work (C)
- Disk-budget cleanup deferred by an incomplete WAL checkpoint (branch of condition "Disk-budget cleanup"): event-disk-budget-cleanup records a deferral when it happens, but no catalogue command holds a SQLite read mark to force one (D)
- 162332 (break): Windows-only path handling, outside this harness's platform (C and D)
- 143837 (break): its only changed path src/agents/sessions/model-registry.ts is excluded by the bound (models) (C and D)
- 164989 (break): needs a remote OpenClaw worker, excluded by the bound (cloud workers) (C and D)
- 145553 (break, not counted): test-only: only a test file in the area changed; the behavior is owned by logging (C)

Persona additions:
These descriptions are retained from the historical derivation. A plan checks the current persona manifest; this list does not claim that the traits have been built or verified.
- agents-multiple-with-global-key: a second configured agent and a session stored under the raw global key beside its agent-qualified spelling (agentId)
- catalog-claude-transcript: a Claude Code JSONL thread readable from the Gateway host's catalog (catalogId, hostId, threadId, searchWord); D named it catalog-native-thread
- cli-profile-paired: a CLI profile whose device is approved for the Gateway origin
- config-heartbeat-short: agents.defaults.heartbeat.every short enough to fire inside a phase, with heartbeat scratch
- config-reset-idle-short: session.reset mode idle with an idleMinutes of about one minute, and a session under it (key); D named it reset-idle-one-minute
- config-subagent-archive-fast: agents.defaults.subagents.archiveAfterMinutes of one minute, and a parent allowed to spawn (parentKey); D named it subagent-archive-one-minute
- cron-job-isolated: an enabled isolated cron job with chat delivery (jobId)
- dm-scope-isolated: session.dmScope per-peer with session.identityLinks configured and a linked peer (peerId); D's condition table called it config-dm-isolated
- gateway-multi-user-profiles: two human profiles with verified identities and operator scopes (memberProfileId)
- gateway-second-instance: a second Kova env the Control UI can switch to (env)
- mock-provider-held-turn: a scripted mock provider reply that stays open for the requested time, emits markdown while open and calls progress_card while held, triggered by a marker message (marker); D named it provider-mock-slow-turn. support/write-mock-ai-provider-script.mjs was recorded as supporting delayMs and stallMs, but not progress-card tool calls
- mock-provider-overflow: a mock provider that answers one request with a context-overflow error body, then succeeds, and a session on it (key); the historical record provided errorStatus but no overflow body
- mock-provider-single-slot: a mock provider that serves one request at a time, with its own agent (agentId)
- mock-provider-tool-calls: a mock provider model whose scripted replies call one named session tool (modelId); D named it provider-mock-tool-calls
- session-at-compaction-threshold: a session whose projected usage sits just under the compaction threshold of the active model window (key); D named it session-near-context-limit
- session-goal-active: a session with an active goal (key, goalId)
- session-group-watched: a group session with human turns that the main session watches (key, peer)
- session-idle-expired: a session whose lastInteractionAt is older than the configured idle window and whose history contains KOVA_IDLE_HISTORY (key)
- session-imported-draft: an imported catalog copy still visible only to its creator (key)
- session-interrupted-inputs: a session with queued, cancelled and interrupted pending inputs retained (key)
- session-long-compacted: a session of thousands of messages with compaction entries and a reset boundary (key, sessionId, shortId, anchorMessageId, searchWord, searchPrefix); D named it session-long-history
- session-main-rolling: the main session with history from several channels and a DM peer id (key, peer)
- session-orchestrator-idle: an idle root session allowed to spawn (key; cancelRunId and yieldingChildKey are recorded by the spawn phases)
- session-pair-watched: two idle sessions on the same agent (keyA, keyB, peerB, sessionIdB)
- session-progress-card: a session holding a saved progress card (key)
- session-pruned-projections: a session with cache-ttl pruning projections recorded in its transcript (key, sessionId); D named it session-pruned-tool-results
- session-public-shared: a saved session with public access enabled (key)
- session-shared-readonly: a session shared read-only with a member profile and one pending suggestion (key, suggestionId)
- session-thread-bound: a sub-agent session bound to a channel thread (key, peer)
- session-with-worktree: a session bound to a managed worktree (key, workspaceDir)
- session-workspace-changes: a session with workspace files, an HTML file with a relative asset and uncommitted changes (key, filePath, fileHash, htmlPath, assetRef); its process is started during the run, not retained in the persona. D folded this and session-with-worktree into session-worktree-bound
- sessions-organized-mixed: pinned, snoozed, archived (manual, age-retention, cap reasons), grouped, colored, unread, nested-child and fork rows (pinnedKey, snoozedKey, snoozedSessionId, archivedKey, archivedSessionId, childKey, forkKey, shortId); D named the archived and pinned parts session-archived and session-pinned
- sessions-stale-dashboard: dashboard sessions inactive longer than archiveDashboardAfter (key)
- sessions-stale-lock-files: legacy write-lock files with dead and live owners under the agent session directory
- sessions-stale-peer-dm-rows: peer-keyed direct-DM rows left by an earlier per-channel-peer scope with dmScope back at main
- sessions-synthetic-automation: cron, hook, heartbeat and agent:*:explicit:model-run-<uuid> rows
- sessions-thousands-near-cap: more unarchived rows than maxEntries minus the high-water buffer, on one agent (agentId); D named it store-many-sessions
- store-corrupt-generation: a fixture of a corrupt agent database generation to stage beside the current one (path)
- store-legacy-sessions-json: a legacy sessions.json and hot JSONL history awaiting Doctor import, including an unused configured agent with an empty sessions.json and no database, whose history contains KOVA_LEGACY_HISTORY (D also names a fixture path and searchWord); support/prepare-large-memory-session-state.mjs was recorded as writing this layout
- store-over-disk-budget: physical usage above session.maintenance.maxDiskBytes with reset and delete archives, unreferenced history and cap archives present (victimKey, victimSessionId)
- store-quarantined-generation: an agent database generation proved corrupt and preserved beside the live store as .corrupt-<timestamp>
- store-rows-legacy-aliases: session rows still carrying provider and lastProvider aliases
- store-stale-sessions-over-cap: a store over its entry cap with stale, pinned and archived sessions (agentId)
- transcripts-cold-stored: an idle session whose transcript (containing KOVA_COLD_HISTORY) was extracted to cold storage (key, userEntryId, leafEntryId, searchWord) plus another inactive transcript eligible for extraction (eligibleKey); D named them transcript-cold-archived and transcript-cold-eligible
- ui-locale-rtl: a Control UI locale setting for Arabic or Persian (locale)
- store-locator-invalid: an invalid configured session.store locator beside the real stores (named for 163821; not required by a phase)
- hook-webhook-configured: a configured webhook hook (named for the uncovered webhook entry point; not required by a phase)


Historical limits:
- The totals above describe the reconciled historical coverage, not executed proof. The current heading-based comparison has missing figures, recorded in comparison.md.
- The 60 historical phases are represented by 64 current phases: the three setup sequences are divided into seven bounded setup phases, and longer operation and event phases use explicit slow bounds. Background lifetimes are preserved. The schema corrections below supersede the original command forms.
- The recorded broadcast-event and manual-operation classifications predate the current derivation rules and remain identified in derivation.md.

## Current schema requirements and limits

- `session-workspace-changes` must expose `sessionId` as well as its existing
  `key`. `session-shared-readonly` must expose `sessionId`,
  `memberIdentityId` and its existing `suggestionId`. The declarations are in
  [Persona](../../../docs/verify/persona.md#sessions-identity-keys). Missing keys
  withhold the affected phases; this document does not claim they are built.
- `session-files-changes` uses the scripted tool-call provider to start a bounded
  background process with `exec` in the run, then writes
  `workspace-processes.json` once with `sessions.processes.list`. The stop reads
  both `processId` and `instanceId` through `--from` and requires the observed
  session id to match the persona's `sessionId`. It retains the separate
  main-session process listing. A truncated list, no stoppable running process
  or more than one such process cannot supply an identity. No process or
  queued-input identifier is read from the persona; queued messages are sent
  during the run.
- `browse-sessions` describes the new session into `involvement-describe.json`
  before reading its current session id through `--from` for
  `sessions.setInvolvement`. `hidden: true` removes it from the signed-in
  person's involvement list without changing access.
- `sessions.cleanup` has no RPC dry-run option at the pinned revision. The two
  RPC calls use `enforce: false` and the schema's `agent` selector where needed;
  they run the configured cleanup mode and may mutate disposable run state.
  Preview coverage is limited to the existing CLI `--dry-run` calls. RPC-only
  preview is outside reach because the API does not offer it.
- `sessions.files.reveal` reveals the session workspace, not an arbitrary file;
  the unsupported path was removed. File-level reveal is outside reach of this
  RPC. Listing, reading and editing the selected file remain covered.
- `share-session` adds a suggestion and resolves the persona's stored pending
  suggestion. The new suggestion's resolution is not claimed. Public sharing
  uses the durable session id as its concurrency expectation.

The current 179 Gateway requests include two added identity reads and exclude
the two GitHub status requests. The two existing background joins remain.
These corrections do not recalculate historical coverage figures or establish
live execution; the helpers marked `toWrite` still withhold their phases.
