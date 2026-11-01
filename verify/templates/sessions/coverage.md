# Coverage: sessions

Operations: 31/31
Conditions: 51/51 (27 ambient, 24 event; historical classification)
Entry points: 348/455 (107 excluded)
Breaks mapped: 19/22

Uncovered:
- Search/card-write overlap and repeated search completeness are now observed by their dedicated connected-client operations. The older background-process-only observations did not establish those conditions; the new command records request interval intersection and false indexing flags for unchanged results.
- UI timing conditions without an activity predicate: comment inspection during streaming; Gateway switching while deletion is pending, return navigation and cross-Gateway drafts/queues; busy Home, session creation, status, goal and model-change interactions. Existing flows retain their ordered interactions. Historical mapping 125665 does not establish the missing deletion-overlap/draft-isolation behavior. Explicit held/streaming variants elsewhere retain their own evidence.
- Deadline-only subagent archival: ordinary delete-cleanup runs may be removed during completion announcement before their retention deadline. The automatic-completion-cleanup phase records that real transition; a later delay does not isolate the timer branch.
- Applied settings hot reload and compaction-model reload (branch of condition "Session settings reload without a Gateway restart"): the existing Settings flow saves and restores the cold-storage archive age; it never changes agents.defaults.compaction.model, and the later storage status observes the restored policy. No current command binds the next compaction to its selected model. Save feedback and restored controls remain observed; applied reload and concurrent-session behavior are unavailable.
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
- session-orchestrator-idle: an idle root session allowed to spawn (key); child run ids and keys are read from spawn outputs during the run
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
- The 60 historical phases are represented by 68 current phases: the three setup sequences are divided into seven bounded setup phases, three persona-read groups are separated from runtime-result consumers, and longer operation and event phases use explicit slow bounds. Background lifetimes are preserved. The schema corrections below supersede the original command forms.
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
- `browse-created-session` describes the new session into `involvement-describe.json`
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
- Subagent cancellation, continuation and waits read their generated identities
  from earlier `sessions_spawn` outputs through `agent-tool-turn --from`.
  Each output has one writer. The caller session and accepted spawn result must
  match before a run id or child session key is used; no child identity comes
  from a persona key. Waits receive a nonempty `runIds` array and use at most
  60 seconds, as the pinned tool requires.
- Ambient held-turn, rolling-session and idle-orchestrator prerequisites are
  declared by setup. Later phases retain their own direct persona inputs but
  do not repeat those ambient traits as unused reads. Setup selection and
  withholding still propagate every missing prerequisite. This avoids false
  read-before-destroy constraints without changing the planner's ordering rules
  or any catalogue side classification.

The current 184 direct Gateway requests include explicit reset and recovery preparation
and two added identity reads, and exclude
the two GitHub status requests and a duplicate transcript search already present
in `search-history`. Deletion still records its response, the deleted transcript
read and the agent database checkpoint. The two existing background joins remain.
These corrections do not recalculate historical coverage figures or establish
live execution; the helpers marked `toWrite` still withhold their phases.

## Ordering and result boundaries

All phases are ordered with the same setup, file-producer and destructive/read
constraints used by planning. `browse-created-session`, `search-history-tool`
and `inspect-terminal-links` separate retained-persona observations from
commands that consume newly created session or link outputs. No command is
added by these splits. The unused pruned-session requirement on the long-session
UI reader is removed; that flow never targeted the pruned session. Redundant
requirements guaranteed by setup or a file producer remain enforced through
those dependencies.

`agent-tool-turn` records the caller as `callerSessionKey`; a successful spawn
also exposes its child as top-level `sessionKey`, matching Gateway
`--session-from`. The child remains in `toolResult.details.childSessionKey`.
The restore tool call reads `expectedSessionId` from the existing
`archive-describe.json` result, requiring its target key to match. These are
declared contracts for the unfinished helper, not live execution claims.

## Creation and mutation prerequisites

`setup-rpc-session` creates or adopts the explicitly named RPC-send target and
writes its canonical key once. Cross-session sends and status queries read that
key through `--from`, so selecting them also selects their producer. Existing
commands using that explicit name run after the same setup.

The reindex phase now performs its own catalog import or re-import and searches
that returned session twice. It then forks a run-owned copy of the long session,
rewinds the copy and searches that returned session twice. Import receipts
record whether content was newly imported; the phase does not assume a re-import
necessarily changes content or that indexing remains in progress. These
operations and their file dependencies precede the observations they support.

Archive and snooze mutations require `expectedSessionId` beyond their parameter
schemas. Bulk archive reads the RPC target's id from its earlier description,
and the stored archived target uses its matching persona id. Every lifecycle
row is checked, including bulk rows, against that pinned admission requirement.


## Reset, recovery and generated identities

The reset phase creates its own session, creates a goal and publishes a progress
card on that same recorded target before `/new`. It therefore does not depend
on unrelated goal or card phases being selected.

Recovery first creates a fresh root session. The declared `restart-for-recovery`
helper must arrange a native interrupted turn, exhaust bounded admission retries,
restore the exact temporary clone configuration and observe an unrecovered
tombstone before publishing the source identity. A plain restart can recover
automatically and is insufficient. The Gateway and WebChat requests read that
observed source. This helper is `toWrite`; the phase remains withheld until it
exists, and these records provide no live recovery evidence. Recovery passes the
owned foreground Gateway handle. Its preparation can use the clone-confined
temporary workspace-file fault, preserving the original workspace and restoring
configuration before healthy startup; model-policy denial is not required.

Creation-capable helper contracts declare observed `createdIds` in stable
operation order for comparison. Spawn outputs include the child key and run ID;
goal creation includes the goal ID. Reads, references and reused identities do
not declare creation. Gateway creation and catalog import distinguish newly
generated identities from explicit or adopted keys and re-imports. Recovery
records the returned successor key, session ID and accepted continuation run ID.
These are output contracts, not an implementation of execution or comparison.


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
The returned status session key must match the requested, recorded target before
its cursor can be used.
Group and thread inputs use recorded `group:<id>` and
`group:<parent>/thread:<id>` peers. The corruption fixture is staged beside the
selected database and swapped through the owned foreground Gateway handle,
with the original file set retained for restoration. The catalogue statuses
continue to distinguish these records from unfinished helper implementations.


Held subagent tasks use the verification mock's explicit four-minute hold marker,
including the cancel target. The verification helper's outer tool marker takes
priority over a nested hold task; no model-name inference is used. Activity must
be observed during dependent work; the bounded hold does not promise indefinite
background execution. The verification and persona mock adapters must both be
preserved when their implementations are combined.

The restart event requires a new `restart-during-turn` helper to prove active
submitted work, a bounded native drain and an actual interruption while retaining
the owned foreground Gateway. Legacy repair requires the existing repair helper
to pause that owner, verify stopped state, inspect/repair offline and restore it.
These helper contracts remain `toWrite`; their phases are withheld until the
implementations satisfy them. Plain service stop/restart calls do not stand in
for these ownership and activity conditions.

Yield continuation now uses a fresh child for each caller. Each child receives
an explicit `sessions_yield` tool request, its caller observes `subagents wait`
with that spawn receipt, and the immediately following send targets the same
child. A completed earlier child is not reused, and the root caller is not
claimed to be paused. Native proof must observe the child's `waiting` result
and `attention` before continuation; a wait timeout alone proves nothing.

Sessions commands use the catalogue's `support/verify/` adapters. Foreground
startup receives the owned Gateway handle and a distinct artifact directory.
The compaction assertion and offline-repair lifecycle contracts must pass
through their adapters before those entries can become available. All remain
`toWrite` here. Command deadlines fit their phase bounds, including background
starts and joins; longer lifecycle phases are explicitly slow.

## Store preparation on run clones

The legacy phase consumes the staged JSON/history and alias paths through
`persona-legacy-store-activate`, while the foreground owner is paused. It then
requires a genuine legacy migration startup refusal before non-interactive
Doctor repair and a healthy restart through that same owner. The durable
persona's active stores remain startable. The historical derivations above did
not record this startup-refusal preparation; coverage figures are not recomputed.

The cleanup phase sets `session.dmScope` to `main` before its first DM-scope
preview and enforced cleanup. Both cold-storage phases pause the owned Gateway,
enable cold storage on the clone, resume that owner and call
`persona-extract-cold` with `transcripts-cold-stored:eligibleKey` before their
existing observations. The entry handles the specific startup-registration
refusal; a successful health probe alone is insufficient. These two entry calls
replace two direct Gateway storage-run requests. The fresh restart parent adds
one request, bringing the current total to 186.

Mid-phase pause/resume reads the original `gateway.json`; standard startup is
still its only command-level writer and final stop retains cleanup custody.
The lifecycle contracts remain `toWrite`: pause proves child exit and listener
absence, normal resume proves health, and expected-refusal resume accepts only
native legacy migration refusal and leaves the owner paused. Doctor's owned
form accepts that paused state, uses `doctor --fix --non-interactive` and restores
that same owner to health. Their implementations are required before these
phases become executable; these declarations do not claim live lifecycle proof.


The corruption checkpoint remains on its original phase. A following restoration
phase reads that swap receipt and restores the original database and sidecars
through the same Gateway owner before legacy activation. Identical selection
paths keep the pair together; the receipt dependency also carries missing-trait
and unavailable-helper withholding without adding a false read-after-destroy
constraint. Selecting only the legacy paths does not request a restore with no
backup. The fixture entry’s new result-file options remain `toWrite` until its
implementation supports them.


Incognito consumers after store preparation create fresh phase-local handles:
ordinary sending, link inspection and the targeted restart each use their own
recorded session. Restart verification creates that session before starting its
held work, then observes its expiry after the specific restart under test.
Earlier maintenance stops cannot masquerade as that expiry. The original setup
and its immediate follow-up remain the initial incognito observation.

Spawn commands record their final creation receipts in their own checkpoints;
the native child keeps working asynchronously after the parent tool returns.
Selecting a history path does not require the later completion event to discover
those generated identities. Cold restoration forks and reads the eligible
session extracted immediately beforehand, including when an earlier phase has
already warmed the other saved cold session.

Restart verification opens one retained browser before its held work, reuses
that browser for reconnection, then closes and joins it. The Control UI entry
remains unavailable until that retained-browser protocol is implemented.
Quarantine recovery declares only newly observed native quarantine basenames,
ordered by database and sidecar role. Comparison can then pair the generated
file addresses while the recovered canonical database is captured separately.
Unreadable quarantine payloads are not captured. The fixture
entry remains unavailable until it emits these creation identities as well as
its restoration receipt.

Raw `attach --print-config` capture is unavailable. The native command mints
an MCP grant and prints its credential in mixed text/JSON output, which is not
safe checkpoint content. Both raw calls have been removed; session resolution,
terminal navigation and resume observations remain. Attachment configuration
coverage requires a future adapter that removes credentials before any output
is recorded and revokes its temporary grant. The template makes no direct
`attach --print-config` invocation.

Every selected background turn has a recorded join. Group-stop flows join each
held turn after its abort before starting the next one. Setup turns overlap the
selected earlier observations and then join before the Home-notice phase needs
an idle session. A dedicated join phase is selected with its producer even when
its own paths do not match, so a history-only plan records completion too.

Busy-parent forks and busy-session compaction establish fresh held work within
the consuming phase. Each sensitive request is preceded by an observation bound
to that exact submitted run and session, with a minimum remaining hold budget
covering the request deadline; each new hold has a recorded join. The hold
entry's observation mode remains `toWrite` for its implementation owner. A
background handle alone, a queued receipt or an expired setup hold cannot meet
that precondition.

Peer templates retain their chosen checkpoint signals. Joins always record
command status, timeout and creation metadata; a phase that requests only UI
and timing evidence is not forced to capture JSON responses. The sessions joins
continue to request responses explicitly.

The restart phase creates its own parent and two held children after the retained
browser is ready. Both foreground spawn receipts reach the checkpoint. The owned
restart contract requires each named child active immediately before interruption
and records the original child run's actual terminal outcome, including work
that continues normally across the restart. Subsequent
waits use those same spawn results. Older setup children cannot satisfy this
condition; the helper's child-observation forms remain `toWrite`.

Phase bounds include scheduled `--after-ms` delays as well as command timeouts.
The idle rollover and subagent auto-archive phases include their 75-second and
90-second delays, respectively, before the following timeout clocks begin.

## Profile admission and fresh streaming

The two personal operations use `gateway-call --persona-profile` with the existing
`gateway.json` owner: `browse-created-session` hides involvement as the saved
owner; `share-session` submits its new suggestion as the saved member. Both
require `gateway-multi-user-profiles`. A token-authenticated backend connection
has no human profile at the pinned OpenClaw revision and cannot exercise these
operations. The declared adapter must reuse `enterProfileGatewayMode` and
`withProfileClient` from the persona implementation: stop the owned foreground
Gateway, enter the existing loopback identity fixture, verify native admission
and `users.self` against the saved identity, perform the request, then stop,
restore the original authentication settings and resume the same owner. Its
normal result records the verified profile without credentials or headers; the
new suggestion ID is declared for comparison. Cleanup also runs on errors and
cancellation. No uninterrupted background-turn overlap is claimed across these
restarts. The adapter forms remain `toWrite` for their existing owner; this
contract does not claim their implementation or a live run of the two calls.

`read-history-ui` finishes its historical paging reads before starting a fresh
held turn on the main session. It observes that exact run active with enough
remaining hold time for `read-streaming-main`, then joins it after the browser
observation. Earlier maintenance or profile-fixture restarts cannot make a stale
setup turn satisfy this prerequisite. The phase includes the new commands in
its time budget. Active-run observation remains the declared helper contract.

Queued follow-up/steer and the busy-main reset also establish fresh held work
at their own operation. Queued sends run in recorded background jobs with
completion budgets longer than the hold, then join after it; a foreground send
cannot wait behind a deliberate five-minute hold with a thirty-second deadline.
The reset observes its newly submitted run active immediately before the reset
and records its settlement afterward. These checks do not establish ambient
subagent concurrency; earlier setup children may already have completed.

Every explicit stop request establishes a fresh held turn on its target and
observes that exact run active with sufficient remaining hold time before
`/stop`, `chat.abort`, `sessions.abort` or the sessions tool's stop action.
A background handle alone is not admission evidence. The queued group input
also runs in a recorded background job with a completion budget longer than
the hold; its completion and each held turn are joined after stopping.

Public activation uses the existing `persona-enable-public-share` entry. Its
producer validates the bearer only in memory and returns the session key; raw
`session.publicShare.set enabled:true` output is never recorded. The generic
member/evidence reads stay before activation on the persona's unpublished
read-only session, because either method can return a bearer for a public
session. Public thread reads use their existing helper, which removes the
bearer and its URL-encoded form from returned documents and errors. Revocation
returns no bearer. The persisted grant ID names the revocable grant and cannot
by itself authenticate a token-based read; it is not the returned bearer.

Queued follow-ups used by stop, send and restart observations additionally pass
`chat-send --busy-from`. This opt-in form must bind the exact held run and wait
for the submitted input's native `chat.history.inputReceipts` row to be pending
with `queued:true` before publishing a background handle. A `started` receipt
is insufficient. Admission has a separate thirty-second startup bound within
the completion deadline; failed admission cannot leave a ready handle or an
unjoined worker. This remains an unavailable helper contract. A consumed input
receipt does not prove steering, and no such interpretation is made here.

The queued-admission query is unanchored: it supplies `sessionKey`,
`inputRunIds` and `limit`, without `sessionId`, `messageId`, cursor or offset.
The returned physical session ID and canonical `sessionInfo` identity must
match the captured held run; exact active-run evidence is required throughout.
`--busy-from` accepts the two explicit sender producers, `chat-send` and
`session-turn-hold`, after validating their matching live submission records.
Restart retains its required `chat-send` producer. Archive likewise establishes
its own held target, observes it active immediately before mutation with enough
remaining budget, and joins that same operation afterward.

## Setup settlement, queue clearing and automatic maintenance

The recorded setup joins precede the fresh main-session send, streaming-history
and reset prerequisites. A narrowly selected pending-input change therefore
settles earlier setup work before submitting its own hold. Join errors and
timeouts remain visible; they are not evidence that native work settled.

`sessions.abort clearQueued:true` now has a separate follow-up confirmed queued
behind its own third group hold. Its recorded join uses `--expect-cancelled`:
the exact native input receipt must be pending with `cancelled:true`, no longer
queued, and bound to the original canonical/physical session; the owned worker
must also settle. Absence or ordinary input consumption cannot prove cancellation.
This is an unfinished extension of the existing `chat-send` entry.

`event-maintenance-pass` uses a dedicated `session-maintenance-pass` adapter,
owned with the other Gateway scripts and marked `toWrite`. It reuses persona
collection preparation, creates fresh age/dashboard/cap candidates and a pinned
control in one selected agent database, and triggers an ordinary write there.
Its bounded temporary policy uses warning mode for preparation, then enforcement
with 5,000 entries, 30-day age retention, one-day dashboard retention and recent
preservation disabled. Fresh eligible ordinary rows exceed the automatic cap
high-water threshold even after age/dashboard removals. The same foreground
owner fences preparation and restoration; actual prior maintenance values and
property presence are restored on every exit. Native policy application and
new archive identities/reasons/counts are required evidence; explicit cleanup,
cold-storage status and optional success logs cannot supply it. The receipt
projects the selected store's relevant native state without exporting a full
configuration or credentials. No runtime implementation is claimed here.

Manual cleanup variants remain in `maintain-session-store`, including scoped
cleanup, text preview, active-key protection and the pinned-row observation.
They do not run inside the automatic observation transaction.

## Deletion maintenance and Settings observation boundaries

The disk-budget event now uses the unfinished `session-maintenance-pass
--disk-budget` form before manual cleanup. It prepares fresh native identities,
archives and physical pressure after earlier cleanup, applies enforcement, and
requires a deletion-triggered change to a captured non-victim candidate plus a
measured usage reduction. It restores the exact prior policy through the same
foreground owner. Old persona victim IDs or archives cannot stand in for fresh
preparation, and the following explicit cleanup cannot establish the automatic
result. Actual reclamation categories are recorded; no single pass guarantees
every category. An incomplete-checkpoint branch still has no forced fixture.

The Settings phase retains its existing save/restore UI flow and later storage
status. The unrelated compaction request is removed: the flow never changes the
compaction model and restores the cold-storage value before it returns. Ordinary
compaction remains in the compaction phases; applied model reload, hot reload
and overlap with running sessions are explicitly unavailable here. These are
coverage corrections, not new runtime implementations or a new derivation.

## Personal list filtering and child completion cleanup

The personal list request uses the same saved-owner admission transaction as
setInvolvement. Explicit owner-profile calls mark the long session involved and
the shared session hidden. The list adapter requires both exact identities in
an unfiltered baseline, then requires opposite membership with involvingMe.
An unprofiled backend query or a row missing from both lists cannot satisfy it.
These profile/assertion forms remain unfinished under the Gateway helper owner.

Both automatic-cleanup children use explicit hidden one-shot delete cleanup.
Their existing spawn receipts and same-caller waits remain, and final describe
queries use both captured child keys through the unchanged unrestricted caller.
A successful native session:null response records absence; errors or a changed
admission do not. The wait may report unavailable after registry retirement,
which is retained without being labelled completed. Completion announcement can
delete immediately, so deadline-only archival remains unavailable as a separate
condition. The later delay provides an observation point, not causal proof.

## Gateway boot identities and timing boundaries

The standard state-ID declarations include gateway_boot_lifecycle.boot_id in
state/openclaw.sqlite. Boots are grouped by their recorded startup_reason and
ordered by started_at_ms, with the comparison contract's rowid tie-break. The
table remains recorded: outcome, completion and reason changes are preserved.
The fixture covers startup and subsequent restart checkpoints with unchanged,
NULL startup reasons, even when no command returns the generated ID. Native boot
completion can update startup_reason; identity stability across that transition
is not established by this fixture.

The background search/card/send phase records actual results and joins without
claiming simultaneous database activity. The existing UI flows are similarly
bounded to what they observe: comment preview precedes sending; deletion is
requested before pairing another Gateway; Home UI actions and companion RPCs
are separate variants. Unsupported streaming/busy/pending-delete claims are
removed. This does not change historical derivation totals or discard the
explicit fresh-held-turn and streaming predicates in other phases.


## Incognito follow-up and scoped transcript searches

The incognito follow-up observes chat.send admission and its reply. It is an
API-only phase with responses, logs and timing checkpoints, and does not request
a browser or screenshot. The preceding New session UI phase retains its screen
checkpoint; a screenshot from that phase cannot satisfy a later phase’s screen
request. Its Gateway permission failures remain a separate UI observation.

Legacy sessions.search requests that name an agent also name their sessionKeys,
as required by the configured-store handler. Retained-history, background-search
and reset searches use the existing long-session key. Cold-history search names
both the saved cold session and the just-extracted eligible session. Reindex
searches retain their --from mapping from the earlier create/import result; the
projected scope variant and requests without an explicit agent are unchanged.
These corrections do not establish simultaneous database access or full phase
execution.

## Conditions established by the operation itself

The session-conditions template contains the following operations, which create their preconditions on the disposable clone and expose the relevant result in the response checkpoint. A recorded response is evidence of the operation, not a claim that every historical failure reproduces on every attempt.

| Condition | Phase | Observable |
| --- | --- | --- |
| Preconnected search/card-write/chat overlap | event-concurrent-search-and-card-save | intersecting request intervals, card result, persisted chat completion or timeout; owned recovery follows timeout |
| Settled repeated concurrent search | search-completeness | identical result identities, indexing flags, request failures |
| First Incognito send on its owning connection | incognito-send-admission | admission, completion and visible reply; independent of browser discovery |
| Independent Incognito placement evidence beside an invalid ordinary locator | event-placement-reconcile | absent-row retirement, live-row availability and fallback warning |
| Accepted active send while animation frames are paused | event-frame-paused-send | frozen and resumed working indicator and geometry, screenshots and recording |
| First cold fork under non-admin authority | event-cold-fork-admission | cold preview, granted read/write scopes, first attempt and warm retry |
| Unfinished and note-only card dismissal | event-dismiss-unfinished-card | offered action, accepted native request and before/after card presence |
| Ordinary search over newer retained memory-index provenance | event-memory-rollback-search | provenance before/after, local embedding counts and cost warning; exact clone restoration |

The independent variants require only the persona keys they actually consume, so missing unrelated historical traits do not suppress them. Browser observation reuses the Control UI implementation; recovery and offline memory preparation reuse the foreground Gateway owner. These operations require those implementations in the composed installation. No OS service is changed and no real embedding provider is contacted. Memory storage remains owned by OpenClaw; the memory phase observes its session-facing effects.

Paired-worker cancellation (164989), `event-worker-cancel-followup`, remains declared with a `toWrite` catalogue entry and is withheld from plans. Its implementation and cleanup proof are pending, so it is not part of the eight implemented conditions.


### Repaired fixture selection and unsupported managed worktrees

The successful full-parent fork uses the bounded rolling-main fixture instead
of the thousands-message compacted fixture, which exceeds the native fork
budget. The separate entry fork still uses the long history and its recorded
anchor; the native fork limit and the long-history trait are unchanged.

Quarantine recovery captures the recovered canonical agent database, Doctor
observations and newly generated quarantine identities. It does not recursively
capture the agent directory: unreadable quarantine bytes cannot be safely
filtered. Restore still belongs to the fixture helper, which must remove only
its proven unchanged generated artifacts before later broad snapshots.

Managed-worktree session and child creation are separate withheld phases using
`session-create-worktree` and `session-spawn-worktree`. Both entries are
`toWrite` until their helpers prove ownership of the disposable repository and
Git storage. Ordinary creation and its dependent observations stay selected;
no creation-admission or isolation check is bypassed.

The reindex-after-rewind sequence forks the two-turn cold-history fixture. Its
parent key, rewind entry and search word all come from that same trait; only the
new copy is rewound. Full-parent creation never uses the oversized long-history
fixture. The two separately withheld managed-worktree phases bring the current
sessions template to 70 phases; earlier 68-phase figures describe the prior form.
