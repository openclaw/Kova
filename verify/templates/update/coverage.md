# Coverage: update

Operations with retained phases: 11/21 (some retained operations have fewer entry points)
Conditions described by retained phases: 64/520 (354 ambient, 166 event)
Entry points inventoried: 203 placed/310 (107 excluded); executable coverage has not been measured
Breaks mapped to retained phases: 0/6; all six are outside reach under OCM supervision

A condition is counted here only when a retained phase describes its concrete setup and observation; runtime execution remains unproven. Reconciliation credits applicable phases from either run and excludes claims whose required inputs or actions were lost. There are 64 described conditions and 456 explicit gaps below. Phases: 37 (1 setup, 11 operation, 25 event). These are declarative descriptions, not executed results.

Uncovered:
- Condition 10, Provider-level contextTokens/contextWindow and Copilot discovery.enabled migration: config-hand-edited supplies unspecified older keys; no retained fixture guarantees these particular fields.
- Condition 219, Recovery destination changes during cleanup with readers: reader presence alone does not guarantee a change between verification passes. The retained reader scenario records either outcome; a deterministic between-check mutation fixture is missing.
- Condition 242, Retired subagents/runs.json, plugins/installs.json, sandbox JSON registries and room-to-groupChannel records: restart-sentinel.json blocks the combined fixture before the plugin-index check; no independent fixture reaches the other cases.
- Condition 225, Reachable Gateway with recorded channel warnings (channelIssues, blocked channel startup): No retained fixture establishes recorded channel warnings on a reachable Gateway.
- Condition 245, Legacy cron JSON stores (jobs.json, jobs-state.json, runs/*.jsonl) refused; candidate admission reports it: The combined retired-state fixture fails the earlier runtime-file preflight before Doctor reaches the retired cron JSON check.
- Condition 246, Pre-July JSON delivery queue files refused: restart-sentinel.json in the combined fixture is rejected before Doctor reaches delivery-queue detection; startup continuation does not prove this refusal.
- Condition 248, Retired OAuth credential sidecars referenced by auth-profiles.json: The combined fixture is rejected by the earlier runtime-file preflight before OAuth-sidecar inspection.
- Condition 159, Package already replaced and Doctor failed on the live Gateway lock: repair from the updated installation: The manual replacement does not establish a preceding Doctor failure against the live Gateway; the retained phase describes offline repair without claiming that failure.
- Condition 188, Triage starts the first launchable coding agent on PATH, or none is found and handoff commands are printed: The retained JSON triage commands return before external coding-agent launch; the other helper runs embedded repair.
- Condition 244, Retired channel config and JSON stores (Discord voice.tts, Device Pair notify, Voice Call logs) refused with bridge guidance: No retained fixture provides the retired Discord voice configuration, Device Pair notification state or Voice Call logs.
- Condition 23, GitHub CLI missing or unauthenticated when reporting: sanitized report kept locally, back to the menu: The direct report preview remains, but neither native failure-menu return nor the OCM-backed reporting UI is exercised.
- Condition 239, Retired pre-June plugin JSON state (iMessage, Active Memory, Nostr, Teams) preserved; bridge through 2026.9.5: No retained fixture provides the retired plugin-specific stores named here.
- Condition 240, Pre-July Telegram sidecars ignored; Telegram ingress spool still imported: No retained fixture provides the Telegram sidecars and ingress spool named here.
- Condition 243, Per-agent SQLite layouts below schema 8 refused: No retained fixture provides an agent database below schema 8.
- Condition 63, No update active: status labels the saved outcome Last recorded update: The OCM-backed status surface replaces native ledger history; the retained native history queries do not establish this status label.
- Condition 16, Orphan task_delivery_state rows: admission runs preservation-first recovery, refused under a live Gateway owner: Native update admission is excluded, and no retained admission runs over orphan delivery rows.
- Condition 210, Stale inactive ledger row with a healthy Gateway: lightweight repair records failed/abandoned: Fresh stale rows are staged offline; this does not exercise lightweight repair against a healthy serving Gateway.
- Condition 372, Doctor interrupted during an agent schema or media migration: rerun reclaims a dead owner and resumes: No retained scenario synchronizes interruption with an observed pending migration.
- Condition 385, SIGINT or SIGTERM to Doctor during archive repair batches: Gateway restored: No retained scenario stages pending archive batches and synchronizes interruption with their repair.
- Condition 453, Standalone restart while startup migration progresses: still-starting exit 2 within five minutes: External-supervision restart uses listener health polling and does not return the native still-starting outcome.
- Condition 467, Interrupted pre-startup migration backup: retries reuse the completed group; damaged member stops migration: No retained scenario synchronizes interruption with observed backup capture.
- Condition 416, Config inputs change while Doctor plans migrations: rerun required: An elapsed config-edit delay does not establish a concurrent write during Doctor planning; that ineffective scenario is removed.
- Condition 47, Retained runtime projections awaiting cleanup by the next update or doctor --fix: No retained fixture supplies updater-retained runtime projections for Doctor cleanup.
- Condition 154, Restart cannot run after an update: restart skipped or failed guidance: No retained scenario creates the post-update restart-skipped or restart-failed history needed for this guidance.
- Condition 217, Repair phase exceeds its deadline: exit 1 with stuckPhase and Doctor output excerpts: The retained bounded repair command does not guarantee work exceeding its deadline; timeout failure is not claimed.
- Condition 229, Configuration writes suspended while an update row is active: No retained phase attempts a config write while an active update row still suspends it.
- Condition 390, Retained legacy state blocks agent turns; unready live config candidate rejected: No retained command starts an agent turn or commits a live config candidate against this blocked state.
- Condition 494, Recorded identity evidence is missing versus mismatched (Not verified / Failed badges) (`identity-unavailable`): No retained fixture establishes both missing and mismatched recorded identity evidence.
- Condition 464, Completed run shown on the sidebar card for 24 hours until acknowledged: The recorded history does not guarantee a completed run less than 24 hours old or its acknowledgement transition.
- Condition 351, Gateway unreachable during triage: archive written with snapshot failures: The retained triage phase restores a running Gateway; it does not establish an outage.
- Condition 393, Session compactionCheckpoints still read at runtime: No retained phase requires or reads the compacted-session fixture.
- Condition 424, Manual installation opens incompatible newer-schema state: Retained replacement journeys install compatible side or side-next code; they do not open incompatible state.
- Condition 437, Older systemd service with KillMode=control-group interrupts children immediately: Native systemd or launchd service-definition semantics are outside reach from OCM-supervised clones. An OCM restart does not establish them.
- Condition 438, Short systemd stop timeout: drain and reserve clamped; unreadable service uses 90 seconds: Native systemd or launchd service-definition semantics are outside reach from OCM-supervised clones. An OCM restart does not establish them.
- Condition 439, launchd ExitTimeOut budgets: Native systemd or launchd service-definition semantics are outside reach from OCM-supervised clones. An OCM restart does not establish them.
- Condition 9, Legacy config fields while switching channel: Doctor prepares a read-only projection bound to the original bytes: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 14, Configured plugins.load.paths directory missing: admission warning, configured-plugin-path-unavailable, update continues: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 30, Managed child refuses before service parking: serving Gateway untouched, refusal kept in history: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 31, Managed child produces no usable result: managed-service-handoff-failed: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 32, Retained activation with update-recovery-pending: exact recovery command followed: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 50, Legacy plugin configuration (Discord dm.policy) admitted with a warning when the candidate planner repairs it: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 75, dev channel ensures a Git checkout at the default or OPENCLAW_GIT_DIR location: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 84, Outdated OpenClaw-managed systemd policy refreshed without stopping the Gateway; operator drop-ins preserved: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 85, Writable managed service definition stale: finalization backs it up and repairs recognized policy: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 86, Maintenance stop drains active turns until idle or the step deadline; remaining turns interrupted with a warning; write custody refuses the stop: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 128, New version running while verification fails: guidance uses the latest observed service state: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 129, Failed update while the Gateway still serves: guidance names the serving version, failure stays: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 163, Git checkout on stable or beta selects the release tag; extended-stable unsupported for checkouts: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 233, Updater exits during restart verification: Gateway or Doctor finish the run succeeded after fresh checks: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 293, Disabling checks cancels unfinished discovery and its campaign: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 294, Gateway shutdown cancels unfinished discovery and waits for Git processes: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 325, Control UI failed attempt opens Ask OpenClaw once per attempt identity; browser storage unavailable disables the automatic request: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 326, Lost connection or verification timeout shown as an unknown outcome until the version arrives: Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 423, Agent schema bump that older code cannot read (cold storage 20, canonical validation 21, compact payloads 23): Its saved scenario depended on excluded native activation, campaign discovery or update transitions; the retained status, Doctor, repair and restart observations do not establish this condition.
- Condition 3, Installation without a detected owning package tool (container image, extracted tarball, Yarn global): update recorded as skipped, Gateway left running: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 4, Unrecognized installation root: target preflight skipped, commands to locate the owner printed: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 5, Installed updater older than the candidate: fixes in the candidate do not apply to the first hop: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 6, Invalid configuration at update admission (invalid-config before schema inspection, invalid fields listed, dry run keeps guidance in notes): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 8, Selected target equals the installed version and build: no-op after validation, plugin convergence still runs, skipped already-current: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 17, A failed update or repair attempt enters recovery triage after service recovery and cleanup: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 20, Verified automatic rollback leaves the previous generation running; no automatic triage, nonzero exit: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 21, Late Git verification failure restores configuration, source and runtime and restarts the verified service: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 22, Interactive failure menu after a failed update (Diagnose, Report, Report in browser, Check report status, Exit by default): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 26, CLI invoked from a working directory inside the installation being replaced: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 27, Dashboard update fails while the Gateway handles the request: Gateway warning log with the public reason: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 33, npm install fails with EACCES or EPERM on the global prefix (global-install-permission-denied, sanitized npm lines): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 34, npm install fails with ENOSPC on the prefix or cache volume: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 35, Registry lacks the requested version or tag (E404, ETARGET, EINTEGRITY; stale-cache retry): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 36, Confirmed ENOSPC during dev staging: preflight-insufficient-space: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 43, Candidate refuses or fails before mutation: stage removed, installed package and Gateway kept: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 52, Update run with non-terminal stdin: confirmations fail promptly, menus and consent do not wait: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 53, Piped or captured output: progress without animation, elapsed time every 30 seconds: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 54, An active chat session does not block an explicit update: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 59, Historical package backups present: a later verified activation retires them; failures preserve them: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 60, Aggregate activation deadline expires: update-activation-timeout, ownership retained until writers settle: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 64, Switching from a dev checkout to a package: failed activation leaves recovery unverified, no automatic restart: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 67, State newer than the updater can read: install-compatible-build or restore-backup refusal: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 70, Package metadata cannot be resolved (registry lookup, dist-tag, version mismatch, schema declaration): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 71, Saved update.channel keeps governing later updates after a one-off --tag: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 72, Source checkout with uncommitted changes: clean check fails before installation, checkout preserved (dirty): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 78, Channel health collection times out during post-update verification: warning kept, explicit negative probe fails: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 80, --no-restart cannot replace runtime files used by a running Gateway; process and retry action reported: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 81, Another Gateway shares this installation: its separate state needs doctor --fix under its own account: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 82, Live sibling Gateway uses overlapping output paths: runtime completion refused: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 89, Replaced Gateway rejects connections because its runtime files are gone: stopped through its service owner: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 90, Paired operator identity only (no shared token): maintenance drain uses it without new pairing: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 91, Explicit package artifact with the same version: build identity compared before the no-op: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 103, Fresh local update interrupted before activation: failed interrupted entry, owner held: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 104, SIGINT, SIGTERM or SIGHUP during activation or verification: forward work stops, recovery owner restores and reports; SIGKILL needs explicit recovery: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 105, Target Doctor migrated shared state: candidate runtime owns finalization, code-only rollback prohibited: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 106, Database writes during Doctor maintenance: automatic restoration refused, state-migrated-no-rollback, manual recovery: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 108, Old Gateway keeps serving through staging and validation while a canary boots on copied state: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 112, Previous-Gateway ready check verification after the canary; expiry leaves it unverified and blocks automatic restart: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 114, Doctor warnings during update: kept in the report, do not block ready check; unconfirmed child termination still blocks: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 115, Old Gateway serving with a database schema older than the candidate during capability check: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 116, Large or busy databases: snapshot budgets scale with size, deadline extends while files change: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 117, Live snapshots while writers continue (bounded WAL prefix, crash journals recovered privately): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 118, Candidate startup slow but progressing: milestones renew the allowance up to four times; stalled or exited candidate fails validation: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 120, Insufficient temporary space for snapshots: TMPDIR, capture directory, system temp; snapshot-capacity-insufficient or snapshot-location-unavailable: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 121, Low disk space on the target volume: warning only, kept in history: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 124, Plugin resolution error attributed to a named plugin recorded without rejecting the update: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 125, Plugin activation or load failures after the core checks pass are named warnings: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 127, Blocking validation failure: staged update discarded, serving Gateway untouched: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 130, Startup lease ends while the same Gateway still progresses: still-starting warning, no restart or rollback: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 131, Ready check allowance expires for the same running process: skipped `gateway-readiness-unverified`, backups retained: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 132, Process or boot generation changes during verification: failure and recovery: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 133, Plugin downloads count toward downtime; service stopped through convergence: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 134, Doctor cannot enter maintenance at finalization: service restored, warning, Doctor and plugin work pending: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 135, Pre-migration database snapshots retained beside the package backup; capacity shortage refuses before migration: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 139, Snapshots taken while a Gateway may write (--no-restart) only for manual recovery: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 141, Config edited after the activation Doctor pass or $include changed: automatic rollback refused: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 142, Update fails before activation: recovery observes the existing Gateway once without restarting: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 143, Update launched from a shell inside the managed Gateway service: detached helper, exit 75, the exec shell may be terminated: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 150, Stopping a Gateway during helper startup, staging or activation waits for update work; draining if cleanup is uncertain: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 151, Stored extended-stable channel: read-only startup and 24-hour hints, never applied automatically: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 161, Managed-service handoff failure kinds (spawn, permission, ownership, payload, timeout, early exit, preparation): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 162, Restart sentinel pending with restart-health-pending until the CLI rewrites it; status shows an Update restart row: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 165, Configured tracking remote fetch fails (fetch-failed); unrelated remote unavailable only warns: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 172, Changed plugin snapshot or deferred model retirement runs fresh Doctor repairs before restart: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 174, Managed release pin resumes the catalog default; pins outside eligibility kept with a pin advisory: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 175, Beta channel plugins pick newest of beta and latest; ClawHub @beta unavailable falls back with a warning: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 176, Plugin npm target unavailable or registry unreachable: plugin-target-unavailable advisory, core update continues: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 177, Plugin compatibility range excludes the target core: named notice, plugin unavailable until compatible: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 178, Pinned npm plugin artifact integrity differs from its record: that plugin update aborted: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 179, Invalid plugin manifest or missing payload: per-plugin warning; invalid config snapshot fails the update: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 181, Extended-stable core: official plugins target the exact installed core version: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 183, pnpm- or Bun-owned installation: --channel dev rejected before activation; repair runs children on that Bun: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 185, Gateway and updater running on the Bun runtime of a Bun-owned global installation: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 187, Local packaged dist edits: recovery bundle under update-recovery/, replay only with matching baseline: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 190, Non-interactive failure without verified rollback: diagnostics and handoff commands, owned automatic repair on configured inference: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 191, Another process saves configuration during database admission: config reread, checks repeated, implicit channel change re-resolved: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 193, Already-current installation needs plugin maintenance and a maintenance step is refused: restart after Doctor writers settle: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 195, Initial-check rejections (arguments, external supervisor, store ownership, handoff identity, immutable config) collect no diagnostics: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 202, Package activation stranded at prepared or publishing by an older updater: repair settles or aborts it: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 203, Manual install over a stranded update: closed as superseded-by-manual-install: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 214, Another live or uninspectable update driver blocks repair and Doctor service stops: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 222, Update in progress: status shows its phase instead of another update: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 224, Detached updater's late terminal notification awaited for up to 30 minutes by the watcher: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 227, History admission waits for a busy database writer: update-ledger-busy deferral: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 252, Update invoked from inside the Gateway process tree: inside-gateway-service, deferred maintenance for already-current: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 257, ClawHub lacks a version-matched official plugin: trusted npm source tried, version-skew warning: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 260, Canary uses a temporary loopback port and suppresses listeners, preserving rate-limit settings: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 265, Update requested from a chat session with a delivery route: acknowledgement, restarting, back-on and final-report notices follow there: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 266, Managed service installation: a chat-started update's restart can stop the Gateway before an intermediate notice: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 269, Run with an internal origin session (Control UI, webchat): notices in that transcript: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 272, Scheduled automation calls gateway update.run under the scheduled run's authority: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 284, Gateway automatic updates enabled on a managed service (update.auto.enabled): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 286, Channel cadence: stable delay with jitter, beta interval, dev hourly pinned commit: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 287, Campaign due with active work: waits for idle, one-minute countdown, 15-minute hard deadline: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 289, Failed campaign apply ends the campaign; handoff failures surface after the Gateway returns: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 291, External supervisor mode: automatic applies and self-update refused, hints still run: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 292, External supervisor mode: restart targets the running Gateway, native service ops and self-update refused: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 295, update.run with a routable chat session: acknowledgement awaited up to 10 seconds (ackDelivered): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 296, Control UI reconnects during an update: dialog shows Gateway restarting and resumes from the run record: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 298, Fresh shared database without fleet_cells: older revisions reject it: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 300, Config written by a newer version (meta.lastTouchedVersion): older binary refuses service mutations: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 307, Triage launch consent: only Yes starts the agent; Enter, n, cancel or 30 seconds skips: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 309, Failed candidate during an install-type switch leaves the previous command runnable: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 310, Installation-change watcher restarts a Gateway updated with --no-restart: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 332, Candidate migration rehearsal step exceeds its budget (candidate-migration-rehearsal): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 333, Large agent fleet: minutes of model-catalog preparation after the listener binds, HTTP unanswered: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 341, Updater killed after the Gateway stops: Gateway stays stopped unless recovery was verified: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 342, Refused or failed core update keeps the previous channel: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 344, Refused channel switch or verified rollback recovers the previous service; unverified leaves it stopped: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 345, Last recorded update fetch failed: status shows update check stale: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 352, Bounded unattended repair before triage for validation failures or unsafe rollback: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 386, Large fleets: shared inspection across update guard and admission: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 419, Database schema newer than the running build: startup exits 78, update refuses older targets: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 420, Two databases at the same version differ in shape and canonical validation applies (`same-version-shape`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 427, Linked source checkout reports its build commit, not HEAD: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 430, Control UI tab open while an update replaces the bundled UI: one reload per reported build: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 444, Cancellation before package mutation restores the original service: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 446, Previously active sessions at update time reach a resumed or terminal state after the update: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 458, Restart handoff consume with a mismatched, missing or expired handoff: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 484, Doctor's config write refused during an update: the update fails with the refusal and rollback keeps it as the reason: The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 488, An agent updates the Gateway that hosts its own session and must use the gateway tool's update.run action (`agent-own-gateway`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 491, Plugins change during an otherwise current update, so a running managed Gateway restarts unless --no-restart (`plugins-changed-restart`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 493, A chat-initiated update carries the requester's authority through Doctor, handoffs and repair workers (`chat-requester-authority`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 498, An enabled configured plugin has no version for the target in the registry, warning before the Gateway stops (`plugin-availability-preflight`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 499, Gateway automatic updates are off by default; checks can be on or off independently (`auto-off-default`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 500, A Control UI update asks for confirmation first; cancel, Escape or dismiss leave the Gateway untouched (`ui-confirmation`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 502, The package install, staging, verification or launcher swap fails (global-install-failed) and rollback is attempted (`global-install-failed`): The saved scenario requires an excluded native update, campaign or custom-supervisor path; outside reach from an OCM-supervised clone.
- Condition 422, Compatibility rollback between different implementations at the same schema: side-next only bumps the version of side, so no retained phase establishes a distinct older reader or newer companion-table behavior.
- Condition 7, Unreadable configuration file (config-read-failed with filesystem code): No fixture makes configuration reads fail; invalid fields and read-only writes exercise different conditions.
- Condition 15, Older updater refuses before staging with plugins.load.paths: plugin path not found: The missing-plugin-path fixture is applied to the primary environment, not to the older updater installation.
- Condition 19, Another Doctor holds a native command claim: recorded as foreign custody, installation replacement blocked: No concurrent Doctor holds the native-command claim; database locks are a different condition.
- Condition 24, Uncertain report upload pending: Check report status, no browser handoff: Reporting is intentionally unavailable; no pending or uncertain upload receipt is staged.
- Condition 61, No usable model authentication: update, verification and rollback proceed; auth findings stay warnings: No fixture removes or invalidates the scripted model authentication.
- Condition 62, Unavailable inference for embedded repair: external handoff, no login prompt: No fixture makes configured inference unavailable.
- Condition 74, Target older than the installed version: downgrade confirmation required: Downgrades use --yes; no phase exercises interactive downgrade confirmation.
- Condition 76, beta dist-tag missing or older than stable: beta falls back to latest: The feed does not remove the beta tag or make it older than the current installation.
- Condition 107, Git Doctor fails after a database snapshot: snapshots restore pre-migration state; later writes keep the migrated installation: The Git rollback scenario fails a channel probe, not Doctor after the snapshot.
- Condition 149, Pinned Git update leaves the checkout detached; receipt preserves the upstream: Git updates choose channels, not a pinned commit.
- Condition 160, update.run without a supervising service boundary: managed-service-handoff-unavailable with a shell command: All declared Gateway environments have a supervisor.
- Condition 164, Interactive Doctor in a Git checkout offers to update first: No phase invokes the interactive Doctor update offer in a Git installation.
- Condition 184, Managed Bun Gateway at a different package root: service-root update, repair from another installation refuses: No Bun fixture gives the service and CLI different package roots.
- Condition 197, Standalone doctor --fix captures retained for 30 days and retired by the next run: No fixture supplies standalone Doctor captures aged thirty days; retained update originals are different inputs.
- Condition 212, New explicit update supersedes a sole stale identityless row (superseded): The stale-history environment receives only a dry-run update, not a mutating update that supersedes its row.
- Condition 226, Extended-stable installation ahead of the selector, or selector failures (registry.reason): No extended-stable installation is ahead of its selector, and no selector failure is injected.
- Condition 258, Operator-managed local plugin copy in plugins.load.paths: plugin-operator-managed warning: No trait supplies an existing operator-managed plugins.load.paths directory to the older installation.
- Condition 273, No functioning model: /update still works: No fixture removes inference while /update is invoked.
- Condition 277, Headless node host busy: automatic activation postponed until idle, activations at least 12 hours apart: No phase establishes busy work on the node host.
- Condition 280, Node shares its state directory with an older Gateway: mismatched local node rejected: No node fixture shares state with an older running Gateway.
- Condition 281, Node update needing a migration or startup repair is deferred: No node target is constructed to require migration or repair before activation.
- Condition 282, Node automatic updates disabled (nodeHost.autoUpdate.enabled false, checkOnStart false, OPENCLAW_NO_AUTO_UPDATE): No phase disables node automatic updates.
- Condition 285, Dev Git install: Updates page refreshes the upstream (current, ahead, diverged, unavailable, behind): Control UI commands use the primary installation, not the Git installation.
- Condition 304, Incomplete $include graph: automatic config rollback unavailable: The include fixture is valid; no phase removes or breaks an included file.
- Condition 384, Missing file copies of canonical transcript archives: warnings only: No phase removes the canonical archive file copies from the cold-storage fixture.
- Condition 401, Legacy agents.list roster without a default marker: unbound accounts bound to the first agent; unavailable roster blocks the account: Both declared legacy roster fixtures contain a default marker.
- Condition 434, Read-only RPC waits get UNAVAILABLE gateway-restarting during drain: No phase starts a read-only RPC wait across the restart drain.
- Condition 452, Restart during an upgrade records intent without migrating; no state database skips it: The active-update scenario requests stop, not restart; the migration restart happens after package replacement.
- Condition 465, Campaign target fixed while the installed revision changes: no outdated count or link: No held automatic campaign changes its installed Git revision.
- Condition 485, Other foreign-key violations or structural damage refuse update admission (`db-structural-damage`): The corrupt-state fixture is exercised by Doctor or startup, not by update admission.
- Condition 492, Schema state cannot be compared or a new database is unreadable by the previous package, refusing rollback with rollback-state-unverified (`rollback-state-unverified`): No rollback scenario makes schema state unreadable or incomparable.
- Condition 136, Hard-linked database files: no retained fixture creates hard links.
- Condition 182, Concurrent mutation of a pnpm or Bun global project: no retained fault mutates the project during activation.
- Condition 278, Node plugin without an idle-work callback: the current node fixture has default plugins, not this plugin behavior.
- Condition 421, Missing or drifted canonical indexes: no retained fixture removes or changes those indexes.
- Condition 369, Container entrypoint runs activation checks: no retained phase invokes the container entrypoint.
- Condition 473, A running 2026.9.6 Gateway loads removed files after package replacement: the persona restores 2026.9.9; the general replacement scenario does not reproduce this historical runtime-specific condition.
- Condition 357, Gateway startup failure triage: the pinned startup gate excludes invalid configuration; no retained phase injects an eligible startup error after recording a boot. The ineffective event-startup-failure-triage phase was removed.
- Update an immutable release installation (operation; entry points openclaw update adopt-immutable and openclaw update recover): needs an explicitly adopted Linux installation with a root-owned system systemd service, sealed release generations and cgroup v2; outside this template's reach
- Condition 1, Gateway installed as a Windows Scheduled Task (principal, elevation, schtasks and rename limits, task autostart suspension): Windows Scheduled Task paths are owned by platform per the bound; outside this template's reach
- Condition 11, Managed service runs under another profile than the caller: caller and service projections stay separate: needs a second named profile owning the service; the persona has one profile
- Condition 13, Older updater reports database-schema-preflight with mode unknown (2026.9.4): needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 18, Cleanup cannot confirm admitted work stopped: ownership and recovery artifacts retained, pending execution: needs an updater child whose termination cannot be confirmed; no harness control reaches it
- Condition 25, Retained worker close exceeds the ten-second exit grace: warning, retained runtime kept: needs a worker that refuses to close; no harness control reaches it
- Condition 28, Interrupted pre-create report preparation becomes retryable after its reservation expires: needs an interrupted GitHub issue preparation; a real external service
- Condition 29, Unexpected exception in an admitted update retains error identity, step and facts in history: needs an unexpected exception inside the updater; no harness control raises one
- Condition 37, Adopted immutable release installation (preparation-only or activation enabled): needs a root-owned system systemd service with sealed releases and cgroup v2; outside this template's reach
- Condition 38, Immutable drain under committed Gateway suspension; expired or resumed suspension refuses the handoff: immutable installations are outside this template's reach
- Condition 39, Immutable activation failure restores the sealed predecessor; inconclusive check stays pending: immutable installations are outside this template's reach
- Condition 40, Immutable updater interrupted after shutdown commits; recovery observes the supervisor first: immutable installations are outside this template's reach
- Condition 41, Immutable target with incompatible migration requirements refused before drain: immutable installations are outside this template's reach
- Condition 42, Hot SQLite rollback journal left in the installation control after an updater crash: immutable installations are outside this template's reach
- Condition 44, Linux OverlayFS installation: retained worker files use private copies: needs a container that denies FICLONE
- Condition 45, Container or filesystem refuses file cloning (Proxmox LXC FICLONE): guarded byte-copy fallback: needs a container that denies FICLONE
- Condition 46, Docker OverlayFS rejects moving an image-layer package (EXDEV): verified copy fallback: needs a container that denies FICLONE
- Condition 48, Retained .openclaw.package-backup-* link to a source checkout makes an older updater refuse with a plugin-link error: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 49, Candidate without the admission marker or with a failing admission process: installed checks used with a warning: needs a target package without the admission marker or with a crashing admission process
- Condition 55, Updater-owned native service command still alive: new update excluded; owner exit or lost lease stops its mutation: needs a stalled native service child; no harness control reaches it
- Condition 56, Target runtime without ownership handoff support refused before stopping the Gateway: needs a sealed system service definition
- Condition 57, Definition write authority sealed or unverified, or target lacks --preserve-definition: activation rejected, service may stay stopped: needs a sealed system service definition
- Condition 58, Obsolete package and launcher backups cleanup exceeds its five-minute budget: remaining backups retained with a warning: needs storage slow enough to exceed five minutes; no harness control reaches it
- Condition 65, Profile without a runtime database: older npm target initializes state, fresh-profile dry run records nothing: the persona always has a runtime database; a fresh profile needs its own environment
- Condition 66, Registered custom agent store incompatible with the target: named before any change: needs a custom agent store at a schema the target cannot read; no persona trait provides it
- Condition 68, No compatible Node for the target: dry run reports Would refuse update or Would replace; node-runtime-preflight: the harness Node version is fixed
- Condition 69, Service Node cannot run the target while the CLI Node can: service metadata rewritten; --no-restart stops before mutation: the harness Node version is fixed
- Condition 73, Nix mode (OPENCLAW_NIX_MODE=1): mutating updates disabled, status read-only: needs a Nix-managed installation
- Condition 77, Git directory replaced during fresh clone validation: update stops without changing the replacement: needs a concurrent replacement of the clone destination; no harness control reaches it
- Condition 79, Git checkout advanced without rebuilding, or runtime artifacts missing: update still needed: needs a checkout advanced without rebuilding
- Condition 83, Source command through pnpm openclaw refuses an automatic rebuild while the Gateway runs: needs the pnpm openclaw source wrapper; no catalogue script runs it
- Condition 92, Validation-copy cleanup, derived-cache cleanup or Git upstream tracking fails: update continues with warnings: needs a cleanup failure; no harness control reaches it
- Condition 93, Linux user-service supervisor inspection times out: one retry, second timeout leaves the Gateway running: needs a stalled systemd service supervisor; no harness control reaches it
- Condition 94, Service inspection unavailable or service record stale: managed-service warning, record cannot select package, Node or state: OCM environments run under a service supervisor
- Condition 95, Linux without a service supervisor: update proceeds when no lock or listener; nothing to restart: OCM environments run under a service supervisor
- Condition 96, Baseline package fingerprint scan hits its budget or size limit: warning, rollback verifies identity only: needs a package tree beyond the scan limits
- Condition 97, Package tree over the scan limits (500,000 entries or 8 GiB; older supervisors 50,000 or 1 GiB): needs a package tree beyond the scan limits
- Condition 98, Sibling .openclaw.update-stage-* directories from another or interrupted updater: no persona trait leaves a stale stage directory
- Condition 99, Equivalent launcher recreated keeps recovery; changed symlink target refuses the swap: needs a launcher rewrite during the update; no harness control reaches it
- Condition 100, npm prefix parents owned by another UID: ownership refusal names object, UID and expected UID: needs a Node version switcher
- Condition 101, Node version switcher switched the shell prefix: global-install-foreign-destination unless the original prefix is kept: needs a Node version switcher
- Condition 102, Other package tools or tools modify the installation during an update: needs a concurrent package tool; no catalogue script reaches it
- Condition 109, Plugin files change after snapshot inventory: snapshot refused; link-only changes accepted: needs a plugin write during the snapshot; no harness control reaches it
- Condition 110, Abandoned plugin Git transaction directories (<destination>.openclaw-update-<UUID>.tmp) are skipped: no persona trait leaves a transaction directory
- Condition 111, Progress receipt refused at validation start: validation stops before copying: needs a database write refusal at a precise moment
- Condition 113, Disposable copy cleanup exceeds five minutes: warning, removal may finish in the background: needs storage slow enough to exceed five minutes
- Condition 119, Candidate Doctor process or pipes stay open past the allowance: exit-phase warning or candidate-checks-timeout: needs a stuck candidate Doctor child
- Condition 122, Install record, plugin owner or database registration changes before copy: preparation refused: needs a concurrent plugin install during preparation
- Condition 123, Initial config inspection meets lock contention or a changing source: one retry with a warning: needs a lock at a precise moment
- Condition 126, Target predates migration continuation: runtime validation unavailable, no schema-neutral rollback: the target is the side under test, not an older release
- Condition 138, Failed candidate never allowed to start: databases restored before the package, migrated files kept as <database>.migrated-<runId>: needs a candidate that fails after Doctor migrated a stopped installation and before it starts
- Condition 140, Pending records that require checkpoint replay block mutable updates: needs a legacy checkpoint record; no persona trait provides it
- Condition 144, Service handoff records from 2026.9.2 or 2026.9.3; a different supervisor UID blocks service mutation: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 145, Foreground Gateway without a managed service: update hints only, activation left to the operator: OCM environments run a managed service; a foreground Gateway needs its own environment
- Condition 146, Foreground replacement still starting or rejected by ready check: unverified or shutdown pending: OCM environments run a managed service; a foreground Gateway needs its own environment
- Condition 147, Chat requester's access grant revoked during staging: pending update stops, Gateway keeps serving: no catalogue script revokes a person-access grant while an update stages
- Condition 148, OPENCLAW_NO_RESPAWN set on a foreground Gateway: update.run refused: needs a foreground Gateway environment
- Condition 152, Shell installer service refresh denied: code installed, service untouched: installer scripts are owned by install
- Condition 153, LaunchAgent installed but not supervised: re-bootstrapped after the update: macOS launchd behaviour; the harness host runs Linux user services, outside this template's reach
- Condition 157, Updater-owned Doctor waits for a foreground Gateway to release state: needs a foreground Gateway environment
- Condition 158, Active Gateway suspension: installation watcher does not restart during preparing, draining or prepared: gateway.suspend.* is consumed from gateway; no catalogue script holds a suspension
- Condition 166, Shallow or partial checkout: missing objects hydrated privately, ahead/behind unavailable without a merge base: no persona trait provides a shallow checkout
- Condition 167, Git pack above 256 MiB: size warning, capacity refusal when the object volume is short: needs an oversized pack
- Condition 168, Newest dev commit does not build: up to ten commits walked back: needs an unbuildable upstream commit
- Condition 169, pnpm bootstrap through corepack fails: tool-specific early error: needs a broken corepack
- Condition 170, Another worktree holds the original branch or the reflog is unusable during Git rollback: needs a second worktree on the checkout
- Condition 171, Restoring the previous Git runtime fails: Gateway stays stopped, originals in <runtime>.openclaw-update-<id>.tmp/previous: needs a filesystem failure during restoration
- Condition 180, Throwing plugin config-repair hook keeps its input and names the plugin: needs a plugin whose repair hook throws
- Condition 186, npm link to a built Git checkout: rollback verifies that checkout; rebuilding it during the update prevents rollback: needs an npm link into a checkout
- Condition 189, Original working directory no longer accessible: agent starts in the OS home: needs the operator's directory removed mid-run
- Condition 192, Stopping the service unloads it and then fails before activation: original runtime restored: needs a stop failure at a precise moment
- Condition 194, Reporting fails after a successful activation: installation kept, exit nonzero: needs a report write failure after activation
- Condition 198, Filesystem rejects no-replace rename or hard links: hard-link publication, or audit files preserved with a warning: needs a FUSE or limited filesystem
- Condition 199, Legacy audit raw archive changed other than by append: quarantined copy, warning repeats until resolved: needs a FUSE or limited filesystem
- Condition 200, Debug capture enabled during an update: proxy persistence disabled, limitation reported: no persona trait enables debug capture
- Condition 201, Chat-triggered update to 2026.9.6 fails with an authority-check stack overflow: needs the 2026.9.6 candidate as the target; the target is the side under test
- Condition 204, Managed handoff lease database replaced or missing after a reboot clears temporary storage: needs the lease database removed between runs; no catalogue script reaches it
- Condition 206, Interrupted automatic triage leaves an uncertain installation handoff reclaimable after 45 minutes: needs a 45-minute wait
- Condition 207, Unfinished package or configuration rollback keeps the handoff; repair refuses until restoration completes: needs an unfinished rollback record
- Condition 213, OPENCLAW_SERVICE_REPAIR_POLICY=external preserved by Doctor children: no persona trait sets the external repair policy
- Condition 221, Interrupted cleanup reconciled on retry; removal failures exit nonzero: needs a removal failure
- Condition 223, Git discovery times out twice at startup: git-unavailable until an explicit refresh: needs a stalled git binary
- Condition 228, Update history unreadable: runStatusError, availability still shown: needs a corrupt ledger; no persona trait provides it
- Condition 230, Diagnostics enabled: slow update.status requests log phase durations: no persona trait enables diagnostics
- Condition 231, Candidate check exits by signal: termination class, signal and stderr tail kept: needs a signalled candidate check
- Condition 234, Shared-state schema bump under a 2026.9.2 updater: content applied, version publication deferred: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 235, App-owned package marker (openclaw-install-owner.json): update returns the owner's hint; invalid marker warns: app-owned installations belong to the apps
- Condition 236, Container image replaced over the same mounted state: entrypoint runs doctor --fix before the Gateway: container image replacement needs a container runtime; outside this template's reach
- Condition 237, Tenant containers from the retired fleet command left untouched by a host update: needs retired fleet tenants
- Condition 249, Retired same-file memory index refused before canonical tables: needs a retired memory index
- Condition 250, Masked or start-restricted systemd service: preflight refuses before replacing files: masking the service would stop every other phase
- Condition 251, Operator masks the service during the update: service-definition warning, no rollback: masking the service would stop every other phase
- Condition 253, Compatibility config read after package replacement fails: candidate-config-read-failed: needs an unreadable config after replacement
- Condition 254, Managed Node service points at another global installation: refreshed with gateway install --force: needs two global installations
- Condition 255, Shell resolves a different openclaw or Node than the service: installation drift reported: needs two global installations
- Condition 256, Pending package-publication recovery blocks writable preparation: needs a pending publication journal
- Condition 259, Retained .artifacts/dist-artifacts.lock refuses a source update: needs a stale build lock
- Condition 261, Unparseable plugin entry during snapshot inventory: warning, files copied unchanged: needs an unparseable plugin source
- Condition 262, Package publication completed but cleanup failed: evidence archived or retained with a warning: needs a cleanup failure
- Condition 263, External-helper operation stuck at publication-complete: repair settles it: needs a stranded publication
- Condition 264, Older in-directory activation journals reported with their helper status command: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 267, No owner destination resolves for a notice: skipped and logged, outcome kept: the persona's channels resolve to the owner
- Condition 268, Destination account disables actions.sendMessage: notices skipped: no persona trait disables sendMessage
- Condition 274, FreeBSD rc.d service discovery: FreeBSD only
- Condition 276, Background exec completion follow-ups after an update run even with heartbeat every 0m: owned by exec; no catalogue script runs background exec
- Condition 283, Stale node-runtime/activation.lock: needs an interrupted node activation
- Condition 288, Open terminal sessions do not defer the campaign and end at the restart: no catalogue script opens a Gateway terminal session
- Condition 297, Signed macOS app owns the local Gateway update (Update Mac app + Gateway): owned by the apps
- Condition 299, Package rollback verification mismatch: up to five differing paths recorded: needs a package tree changed during rollback
- Condition 301, Enabled auto-updater would reapply the newer release during recovery: needs automatic updates enabled during a downgrade recovery
- Condition 302, Auth profile import .bak files are not the live credential store: no persona trait holds auth import backups
- Condition 303, Restored service fails its health check after rollback: recovery.service failed: needs a rollback whose restored service fails
- Condition 305, Doctor times out after migration: process groups stopped, candidate started on migrated state, or Gateway kept stopped while writers remain: needs a Doctor timeout after migration
- Condition 311, Live service shares a source checkout's dist output: build entry points refuse: needs a live service sharing a source checkout's dist output during a build
- Condition 312, Source-server script without Corepack or with a pnpm pin mismatch stops before checkout update: the reference script needs a Corepack-less host
- Condition 313, Source-server publication fails after stopping the service: previous revision restored and restarted: the reference script needs a Corepack-less host
- Condition 314, Output root such as dist is a symbolic link: build refused: needs a symlinked output root
- Condition 315, Failed npm package replacement where triage cannot start: installer rerun recovers: installer scripts are owned by install
- Condition 316, Homebrew formula install: update leaves the formula, records skipped; service on a Cellar path: needs Homebrew
- Condition 318, npm install fails and retries with --omit=optional; fs-safe native binding restored: needs a failing optional dependency build
- Condition 319, npm min-release-age quarantine configured: cleared for OpenClaw-managed npm children: no persona trait sets npm quarantine
- Condition 320, pnpm global install group shared with another package: updater stops before changing it: needs a shared pnpm group
- Condition 321, Root-owned system-global install: update fails with EACCES, recovery through system npm: needs a root-owned prefix
- Condition 323, OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL set: postinstall cleanup skipped, lifecycle completed: no persona trait sets it
- Condition 324, Hardened systemd service without write access to config and state roots: needs a hardened system service
- Condition 327, Report from a non-owner administrator: prefilled browser issue only, never the host GitHub CLI: control-ui has no profile switch to act as a non-owner administrator
- Condition 328, Gateway disconnected, method unsupported or no admin scope: Control UI recovery controls disabled, CLI fallback: control-ui has no profile or connection switch to drop the admin scope or the Gateway connection
- Condition 329, Container package changes are not durable: redeploy the image: needs a container installation
- Condition 330, System-scope systemd Gateway: package updated, operator restart command recorded: needs a system-scope service
- Condition 331, Installation not writable by the updater: managed-service-handoff-failed with owner commands: needs a foreign-owned installation
- Condition 334, Missing runtime source capture (openclaw-plugin-build- ENOENT): warning, replacement loads: needs a deleted capture
- Condition 335, Plugin dependency using import.meta in an older updater's parser: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 336, Legacy openclaw-model-catalog-* temporary trees removed by doctor --fix when no other process runs: no persona trait leaves catalog trees
- Condition 337, Two identical candidate Doctor failures for one version: automatic updates pause: needs two identical candidate Doctor failures for one version
- Condition 338, Dependency or build fails during a source update (deps-install-failed, build-failed, ui-build-failed): needs an unbuildable target
- Condition 340, Installed CLI damaged or diagnostics unwritable: automatic triage reports the failure: needs a damaged CLI
- Condition 343, Git checkout with several remotes and no branch.main.remote: needs a multi-remote checkout
- Condition 346, Plugin dependency tree corrupted after an update: channel not loaded: needs a corrupted dependency tree
- Condition 347, Stale per-agent OAuth shadows after re-auth: provider 401s until doctor --fix: needs OAuth profiles; the persona uses the mock provider
- Condition 348, Prepared model runtime publication times out at startup (ambient credentials stage): needs an external login check that stalls
- Condition 349, Protocol mismatch: a newer client keeps reconnecting to an older Gateway after rollback: needs a long-running newer client process connected across the downgrade
- Condition 350, Claude Code without safe-mode support: notice, normal customization: no coding agent CLI in the harness
- Condition 354, Update failure artifact without a run identity: unrepaired: needs a hand-written artifact
- Condition 355, Post-turn cleanup fails: another repair refused in that process: needs a cleanup failure
- Condition 356, Explicit exec deny or sandbox, node or remote route: embedded repair refused (exec-denied-by-policy): no persona trait sets an exec deny policy
- Condition 358, Unsupervised foreground or container run stays alive after a failed startup retry: needs a foreground run
- Condition 359, Stop received during triage cancels recovery: needs triage in progress
- Condition 360, Codex app-server on a socket transport: automatic repair refused: no Codex app-server in the harness
- Condition 361, Competing failure while triage is owned: already owned, original output kept: needs two failures at once
- Condition 362, Fixing process disappears abruptly: automatic admission blocked for that boot: needs a killed fixing process
- Condition 363, Linux user-systemd automatic recovery in a native scope; explicit stop cancels it: needs automatic recovery in progress
- Condition 364, Missing Node or CLI files: manual triage required: needs a damaged installation
- Condition 365, Matrix dedupe scan only when Matrix is configured: no Matrix account in the persona
- Condition 368, Default-layout install with only ~/.clawdbot: renamed; both directories present need manual reconciliation: renaming the state directory would replace the persona
- Condition 371, Unused legacy stores (loose agent/settings.json) deferred with advisories: no persona trait leaves loose settings
- Condition 374, Legacy workspace setup files imported; canonical record wins: no persona trait holds legacy workspace setup files
- Condition 375, Skill Workshop proposals exported; unowned or half-applied proposals held back: no persona trait holds Workshop proposals
- Condition 376, Plugin migrations with files outside the copied state deferred: no persona trait holds such a plugin
- Condition 377, Completed agent deletion kept its files or deletion history missing: stores held back with warnings: no persona trait holds a deleted agent's store
- Condition 378, Incognito reserved database filename collision: no persona trait holds the collision
- Condition 379, Historical 2026.7.35 shared schema without a deletion journal: needs a 2026.7.35 database
- Condition 380, Interrupted auth-profile archive recovery reported: no persona trait holds it
- Condition 383, Another connection commits before the media repair: source changed before migration transaction: needs a commit at a precise moment
- Condition 387, Device Pair legacy JSON beyond namespace capacity: no persona trait holds it
- Condition 388, Shared auth still in the legacy agents/main database: relocated; conflicts reported: no persona trait holds legacy auth
- Condition 389, Retired MCP OAuth files and stale .lock sidecars: no persona trait holds them
- Condition 392, Owner allowlist with direct-user target kinds; ambiguous owners restored from .bak history: no persona trait holds an ambiguous owner list
- Condition 394, Retired settings.json or keybindings.json keys refused, last accepted bindings kept: no persona trait holds them
- Condition 395, Telegram update-offset versions 1 and 2 normalized before account startup: no Telegram account in the persona
- Condition 399, Older database without Claw provenance columns: claws are owned by claws
- Condition 400, Policy-only WhatsApp accounts.default beside named accounts: warning, unchanged: no WhatsApp account in the persona
- Condition 404, Tlon flat allowPrivateNetwork migrated; Matrix and Mattermost forms retired: no such channel in the persona
- Condition 405, Enabled webhook channel account without legacyWebhook: historical listener pinned once: the persona's test channels do not use webhook listeners
- Condition 406, Voice Call realtime settings copied into talk.realtime: no Voice Call config in the persona
- Condition 407, Historical ACP metadata keys: startup refuses unmigrated state with a current binding: no ACP sessions in the persona
- Condition 409, Retired TaskFlow Webhooks plugin entry ignored; allowlist kept explicit: no persona trait holds the entry
- Condition 410, Legacy Tasks rows for native Codex work imported or preserved: no Codex rows in the persona
- Condition 412, Local embeddings without managed llama-server setup: degraded semantic recall named: no local embeddings in the persona
- Condition 413, Legacy credential fields (mode, apiKey) in auth stores converted; runtime rejects them: no persona trait holds legacy credential fields
- Condition 415, Older Git updater keeps an in-memory config snapshot: Doctor preserves config: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 417, Model migration changes a consumer's billing route: warning after saving: the persona uses the mock provider
- Condition 418, Multi-account channel without a default account: routing warning: the persona's channels have one account each
- Condition 425, Profile-owned skill library tables present when changing builds: no persona trait holds a skill library
- Condition 426, Target package without schema metadata checked against the schema-1 contract: needs a pre-metadata target
- Condition 428, Config health-state write failing: reported once per database per process: needs a failing database write
- Condition 431, Downgrade to 2026.9.2 with newer accepted-input receipts: same-ID retries rejected: needs a 2026.9.2 target
- Condition 436, Restart preparation cannot verify service command or owner: GATEWAY_RESTART_PREPARATION_REFUSED: the harness service is always verifiable
- Condition 440, Pending approvals, questions and node replies answerable during drain: no catalogue script raises a pending approval
- Condition 442, Exit 79 keeps the Gateway parked unless the updater supplies a verified recovery: needs a failed restoration that cannot be verified
- Condition 443, Helper result missing, malformed or interrupted: activation left to the operator: needs a failed restoration that cannot be verified
- Condition 449, Work ignores cancellation at the native deadline: stability bundle, exit 0, fresh Gateway: needs work that ignores cancellation; the mock provider's held turn honours it
- Condition 451, Shared-state database unreadable: gateway status --deep exits 1 naming it: needs a damaged shared database
- Condition 454, State selectors pointing outside the account home: isolated, no service management: OCM environments own their selectors
- Condition 455, Several custom services match: OPENCLAW_SYSTEMD_UNIT required; duplicate user and system services: needs several services
- Condition 456, Sealed or unsafe service definition: gateway install --force refused: needs a sealed definition
- Condition 457, Database ownership claimed by an external supervisor: unmarked writable opens fail: database ownership claim is consumed from database
- Condition 459, Interactive setup prompt open at stop or restart: closed before drain: no catalogue script opens setup
- Condition 463, Automated environment (CI set): no update check or statistics: the harness sets the endpoint, which overrides the suppression
- Condition 466, Older Linux host without openat2: older images report a false Gateway owner: needs a container on an old kernel
- Condition 468, Restart policy loop on an unsafe migration: run Doctor once in the container: needs a container runtime
- Condition 469, Update wizard selects dev without a Git checkout: offers to create one: the wizard phase cancels before the channel choice; no catalogue script answers the checkout offer
- Condition 470, Installed 2026.9.3 or 2026.9.4 updater caps rehearsal and snapshot at five minutes even with a larger --timeout: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 471, Installed 2026.9.4 updater refuses with managed-service-preflight before the target runs: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 472, pnpm-owned installation whose older updater triggers an interactive build-approval prompt (IO error: not a terminal): needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 474, Published 2026.9.5 Gateways have no installation-replacement watcher: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 475, Published 2026.8.2 CLI refuses updates on service-less Linux installs: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 476, Installed 2026.9.7 or 2026.9.8 supervisor refuses candidate trees over 50,000 entries: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 477, Older updater without the paired-identity drain reports device identity required and waits for its deadline: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 478, Published 2026.9.5 resident keeps its startup stop budget after daemon-reload and omits write custody: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 479, Installed 2026.9.2 admits a new update while an older row remains running: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 480, Older updater returns already-current with runtime-verification-failed: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 481, Older updater fails at updater-runtime-retention: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 482, Installed 2026.9.4 updater cannot use orphan-row recovery before updating itself: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 483, Bun-hosted update driven by 2026.9.7 waits for idle candidate workers: needs an installed updater of that specific older release; the persona pins 2026.9.9
- Condition 486, Writing the local Markdown report fails; a warning is printed and the outcome preserved (`report-write-fails`): needs fault injection or timing at a precise moment of the update that no catalogue script provides
- Condition 487, A candidate state snapshot fails (active database, exec approvals or plugin phase named) (`snapshot-error`): needs fault injection or timing at a precise moment of the update that no catalogue script provides
- Condition 495, Recovery files have unexpected mode, link count or owner, producing permission refusals (`recovery-permissions`): needs recovery files with unexpected mode, link count or owner
- Condition 496, The Control UI cannot read fresh progress and shows the read error beside the last run (`progress-read-error`): needs fault injection or timing at a precise moment of the update that no catalogue script provides
- Condition 497, Doctor imports channel state only for enabled channels (`disabled-channel-import`): needs pre-July channel state for a disabled channel
- Condition 503, The restart is unhealthy or its revision mismatches or is unavailable (`restart-unhealthy`): needs fault injection or timing at a precise moment of the update that no catalogue script provides
- Condition 504, Switching channels syncs plugin sources (bundled for dev, registry for stable/beta) (`plugins-follow-channel`): needs a Git checkout installation with full source builds inside one phase bound (persona addition install-git-checkout); no phase drives it at this revision
- Condition 505, Release tags in recognised forms (beta, legacy numeric, extended-stable patches) select Git targets (`git-tag-forms`): needs a Git checkout installation with full source builds inside one phase bound (persona addition install-git-checkout); no phase drives it at this revision
- Condition 506, A named profile or custom state/config paths are pinned for triage and repair (`named-profile`): needs a named profile or custom state and config paths
- Condition 507, A support artifact cannot be saved, reporting the storage error (`triage-artifact-save-fails`): needs fault injection or timing at a precise moment of the update that no catalogue script provides
- Condition 508, Startup finds the webhook completion marker as the sole change or endpoints needing repair (`webhook-startup`): needs a webhook channel whose endpoints need repair at startup
- Condition 510, Pending delivery settlements or completion recovery exist and older builds may discard their metadata (`pending-settlements`): needs pending delivery settlements or completion recovery before a downgrade
- Condition 511, Database closure refuses a follow-up drain, parking queued input (`drain-parks-input`): needs fault injection or timing at a precise moment of the update that no catalogue script provides
- Condition 512, Older persisted running or queued session statuses are normalised to interrupted at startup (`legacy-session-status`): needs persisted running or queued session statuses from an older release
- Condition 513, Old scripts send SIGUSR1, which no longer restarts the Gateway (`sigusr1-legacy`): needs a script that still sends SIGUSR1, which starts the Node inspector instead of restarting
- Condition 514, A forced restart from an older caller without a drain budget gets at most 45 seconds (`force-old-caller`): needs a specific older published release as the driver or caller (2026.9.2, 2026.9.4, 2026.9.5 or an older restart caller), other than the persona's pinned release
- Condition 515, gateway restart runs inside the macOS LaunchAgent process tree and hands off to a detached helper (`restart-inside-launchagent`): outside reach on a Linux host: needs a macOS LaunchAgent service
- Condition 516, Service-managed profile names collide by case or with reserved labels, or custom service identity variables are set (`profile-service-names`): needs a root-owned system installation or system-scope service (sealed releases, system services, root prefixes, masked or hardened services) that the OCM environment does not provide
- Condition 517, OPENCLAW_GATEWAY_RESTART_TRACE adds restart timing lines (`restart-timing-log`): needs OPENCLAW_GATEWAY_RESTART_TRACE set on the Gateway
- Condition 518, A custom container entrypoint bypasses Doctor activation (`custom-entrypoint`): needs a container runtime and image recreation, which an OCM environment does not provide
- Condition 519, A Bun-only install's launcher is missing, relinked or names a moved Bun (`bun-launcher`): needs a Bun-only installation with a broken launcher
- Condition 520, A Windows Bun-only node host cannot stage updates and logs the failure hourly (`bun-windows-node`): outside this template's reach: Windows Scheduled Task hosts (bound: owned by platform)

Phases that depend on each script still to be written (support.toWrite):
- support/verify/release-feed.mjs: 37 phases
- support/ensure-gateway-running.mjs: 20 phases
- support/verify/restore-update-fixture.mjs: 17 phases
- support/verify/read-installation-state.mjs: 13 phases
- support/verify/env-fault.mjs: 8 phases
- support/verify/gateway-call.mjs: 8 phases
- support/verify/stop-gateway.mjs: 7 phases
- support/verify/manual-package-replace.mjs: 4 phases
- support/verify/session-turn-hold.mjs: 4 phases
- support/verify/chat-send.mjs: 3 phases
- support/verify/stage-state-fixture.mjs: 3 phases
- support/verify/control-ui.mjs: 2 phases
- support/verify/node-host-auto-update.mjs: 2 phases
- support/verify/stage-update-history.mjs: 2 phases
- support/verify/update-config.mjs: 2 phases
- support/run-doctor-repair.mjs: 1 phases
- support/verify/channel-inbound-turn.mjs: 1 phases
- support/verify/chat-history-read.mjs: 1 phases
- support/verify/cron-isolated-run.mjs: 1 phases
- support/verify/stage-session-store-fixture.mjs: 1 phases
- support/verify/triage-run.mjs: 1 phases

Persona additions:
- channel-authorized-non-owner: A conformance-channel group sender allowed to chat in this comparison clone, but absent from owner grants and command-owner allowlists; peer identifies that sender and is checked before the /update attempt (peer)
- agents-fleet-large: Several hundred configured agents, each with its own agent database (none) (inventory only; not required by a retained phase)
- approvals-legacy-json: A legacy exec-approvals.json stub beside an SQLite approvals row holding a default-agent policy with string allowlist entries (none)
- checkout-dirty: A second Git checkout environment like install-git-checkout with one uncommitted edit in a tracked file (env) (inventory only; not required by a retained phase)
- coding-agent-stub: a stub coding agent CLI on PATH (codex) that records the prompt it receives and exits (agent)
- config-include-files: Config split across $include files, with the agent roster in an included file (none) (inventory only; not required by a retained phase)
- config-legacy-roster: A second environment whose config keeps an agents.list roster with a default marker, unprefixed toolsBySender keys and an ownerless cron job (env, fixture)
- config-retired-keys: A second environment whose config carries retired keys (agents.defaults.llm, routing.allowFrom, top-level heartbeat) (env, fixture)
- cron-job-update: An isolated cron job created by the operator whose scheduled prompt asks the agent to update OpenClaw through the gateway tool (jobId) (inventory only; not required by a retained phase)
- history-stale-run: the update ledger holds an identityless running row inactive for more than 30 minutes and an untouched 2026.9.2-era admission older than 24 hours (fixture)
- install-bun-global: A second environment with OpenClaw installed globally by Bun at the persona's pinned release, its Gateway running on Bun (env) (inventory only; not required by a retained phase)
- install-dist-edited: A local edit in one packaged dist file of the install-npm-global environment (none) (inventory only; not required by a retained phase)
- install-git-checkout: A second environment running from a Git checkout on the dev channel whose tracking remote is a local mirror of the side's source (env) (inventory only; not required by a retained phase)
- install-npm-global: A second environment with OpenClaw installed globally by npm at the persona's pinned release under a user prefix configured in ~/.npmrc, its Gateway a managed user service, holding a copy of the persona's state (env, fixture)
- install-pnpm-global: A second environment with OpenClaw installed globally by pnpm at the persona's pinned release (env, fixture)
- install-tarball-extracted: A second environment running from an extracted package tarball with no package-tool owner (env) (inventory only; not required by a retained phase)
- node-host-headless: A headless node host paired to the Gateway, running the persona's pinned release with its default plugins (nodeId, fixture)
- plugin-capability-widened: An external plugin whose version in the release feed declares an added capability (none)
- plugin-compat-excluded: An installed external plugin whose declared compatibility range excludes the side's version (none)
- plugin-migration-pending: An installed plugin with a recorded pending state migration and retained inputs (none)
- plugin-payload-missing: A configured plugin whose installed payload directory was removed (none)
- plugin-pin-outdated: An official plugin pinned to an older exact release that drifts from the installed core (none)
- plugin-record-missing: A configured official plugin present in config with no install record (none)
- recovery-originals-retained: An immutable complete installation/user-state export with eligible owner-recorded recovery originals, protected pre-startup captures and an older npm snapshot directory; every cleanup attempt restores its own copy (fixture)
- service-definition-outdated: A native service definition written by an older installer (TimeoutStopSec=30, KillMode=control-group) with one operator drop-in (inventory only; outside reach and not required by a retained phase)
- state-legacy-migratable: a fixture of legacy state Doctor can migrate: a legacy agents.list roster with a default marker and ownerless cron jobs with null, deliver and mixed-case delivery modes, legacy auth field shapes in JSON and SQLite, a policy-free exec-approvals.json stub and a legacy default-agent SQLite policy, a legacy workspace setup file, session rows with flat pending-delivery fields and provider aliases, orphan task_delivery_state rows, Codex-native task rows, historical ACP metadata keys, unprefixed toolsBySender keys, flat channel allowPrivateNetwork keys, inherited Voice Call realtime settings, a multi-account channel without a default and a policy-only WhatsApp accounts.default, retired TaskFlow Webhooks settings, messages.tts settings, an ownerAllowFrom entry that lost its user: kind, a database without claw provenance columns, shared auth in the main agent database, retired MCP OAuth files, a deleted agent's retained store, pending Skill Workshop proposals, a damaged legacy sessions.json entry, a missing plugins.load.paths entry and a configured plugin that is not installed, Matrix state needing the dedupe scan, an enabled webhook channel account without legacyWebhook, an ACP agent with a separate harness model, legacy Discord dm.policy, stale per-agent OAuth shadows and a legacy audit archive changed other than by append; plus a config file with legacy keys for startup (path, configPath)
- state-legacy-retired: a fixture of retired pre-July state: plugins/installs.json, cron jobs.json with jobs-state.json and run logs, a JSON delivery queue, restart-sentinel.json, retired config keys, OAuth credential sidecars, retired settings.json keys and a ~/.clawdbot directory (path; filesPath is a separate export containing only retired state files and a valid supported configuration, without the retired config keys; startup uses filesPath)
- state-retired-json: A second environment holding retired pre-July JSON state: restart-sentinel.json, plugins/installs.json and a legacy cron jobs.json store (env, fixture)
- store-orphan-delivery-rows: Shared-database task_delivery_state rows whose parent tasks are missing (none) (inventory only; not required by a retained phase)
- update-history-failed: Update history holding a failed run with a config failure followed by a later success, and a failed run within the last 24 hours (runId)
- update-history-long: An update run whose history reached the 128-step and 16 KiB compaction limit (runId)
- update-history-stale: A second environment whose update history holds an identityless legacy admission older than 24 hours and an active row inactive for over 30 minutes whose driver is dead (env, fixture)
- channel-owner-route: commands.ownerAllowFrom names the test channel's direct-user target of a DM peer (peer) (named for an uncovered condition; not required by a phase)
- config-includes-split: the config split across $include files (path) (named for an uncovered condition; not required by a phase)
- config-invalid-field: a staged config fixture with an invalid field (path) (named for an uncovered condition; not required by a phase)
- package-dist-edited: local edits to the installed package's dist (no keys) (named for an uncovered condition; not required by a phase)
- runtime-bun-available: a Bun 1.4+ executable with WAL-safe node:sqlite available to the env (bunPath) (named for an uncovered condition; not required by a phase)


## Execution dependencies

The figures above describe derived coverage, not executed results. Product commands using `@{persona:<trait>:env}` depend on the [run contract](../../../docs/verify/plan-and-verdict.md): every persona-provided environment is cloned separately for each comparison clone, and the placeholder resolves to that copy. The durable persona installation must never be mutated. Catalogue recognition of this product environment form depends on the correction in [PR #174](https://github.com/openclaw/Kova/pull/174).

The existing Gateway health helper currently accepts `--timeout-ms`; these commands use the catalogue's `--timeout` contract. It is therefore listed under `support.toWrite`, with the required compatible adaptation spelled out. The existing Doctor repair helper likewise remains withheld until its catalogue contract is implemented. File existence alone does not make either entry available.

Invalid configuration and missing plugin paths must be staged through `config-fixture.mjs`, without the validated config writer, preserving and restoring the exact original bytes even on interruption. Each scenario claiming a turn in progress starts its own held turn immediately before the action; the admission-rejection send additionally waits for an observed draining state; the initial shared turn was removed. Successful recovery-data removal runs after the reader-refusal scenarios so it cannot consume their input first. These scripts and persona traits remain prerequisites; a command that exits 2 on any clone makes its phase incomplete and the verdict unresolved.


Independent mutating scenarios restore their complete starting installation and user state with `restore-update-fixture.mjs` before injecting faults or applying updates. This prevents an earlier phase's update from turning a later first-hop migration into an already-current check. The helper preserves the comparison clone's identity and service ports, never edits the immutable fixture or its source installation, and restores local release-feed routing. `repair-after-update` restores its own primary and stale-history fixtures and no longer consumes a result from a native update.

Additional persona requirements for that helper: `update-baseline-fixture` provides `path`, an immutable full installation/user-state export for the primary environment; every installation trait used by a restored phase also provides `fixture`, an immutable export of its own original installation and user state, alongside `env`. These keys are missing until the persona supplies them, so the affected phases remain withheld. Valid config changes use the declared `update-config.mjs` presets; no phase depends on nonexistent JSON patch files.

Coverage reconciliation controls: condition 279 is described by `event-node-candidate-fails`. Conditions 127 and 178 require excluded native updater paths and remain uncovered. Other run 1 claims are not automatically counted when its supporting phase or persona setup was not retained. This inventory is a description of reachable scenarios once dependencies exist, not a claim of executed coverage.


Node update scenarios require `node-host-headless:fixture`, an immutable export of the node's persona runtime and state, including its runtime selector and activation timestamps. The support command creates and removes a fresh disposable node for each invocation, connected only to the comparison Gateway; it never updates the durable source host. This prevents an earlier activation's twelve-hour cooldown from suppressing the fallback scenario.

Every reporting action requires a live `github-unavailable` fixture that isolates HOME/XDG and PATH, removes GitHub token variables only from its own child processes, and cannot submit to GitHub. Reporting wrappers consume that fixture's handle and fail closed before invoking the product if it is unavailable, even if phase execution continues after a setup error. No phase is authorized to publish a real issue. Independent UI/reporting phases restore the seeded failure history so its attempt identity is still current. Secondary installation phases record their own database rows as compared JSON responses through `read-installation-state.mjs`; the primary `state:` checkpoint alone would not observe them.


Catalogue registration is a separate prerequisite owned by [PR #174](https://github.com/openclaw/Kova/pull/174). This template's `support.toWrite` list is the input to those additions, not itself a catalogue registry. Until those entries are added, unlisted commands reject planning; only registered entries with `status: toWrite` withhold phases. This contribution does not claim that a current catalogue can plan it.

The release feed retains a publication recipe after setup, then each selected phase starts and joins its own server handle. A server must also stop when its owning phase worker exits or is interrupted. This keeps cleanup local to selected phases instead of requiring an otherwise unselected final phase. `history-stale-run` additionally supplies `fixture`; its rows are staged with the Gateway stopped immediately before restart and separately before repair, without a status query consuming them first. Secondary Doctor migrations use the comparison side's runtime over legacy content; the persona runtime remains for first-hop updater scenarios.


## OCM-only scope

Every comparison clone remains an OCM environment under external supervision. OCM's `build_openclaw_env` sets the external repair policy and marks a running service `OPENCLAW_SUPERVISOR_MODE=external` ([shell.rs, lines 66–118](https://github.com/openclaw/ocm/blob/6c563651c7f0047db553e0e9438a7df3cfaaad76/src/infra/shell.rs#L66)); the Gateway receives that supervision mode as well ([supervisor/mod.rs](https://github.com/openclaw/ocm/blob/6c563651c7f0047db553e0e9438a7df3cfaaad76/src/supervisor/mod.rs#L2911)). At OpenClaw 7e80556f, this disables automatic campaigns ([update-startup.ts, lines 288–305](https://github.com/openclaw/openclaw/blob/7e80556f503d26ddde64e274bfb50cbbec7830f5/src/infra/update-startup.ts#L288)) and refuses mutating native CLI updates before their preparation ([update-command-run.ts, line 627](https://github.com/openclaw/openclaw/blob/7e80556f503d26ddde64e274bfb50cbbec7830f5/src/cli/update-cli/update-command-run.ts#L627)). `update.run` can delegate to OCM before native execution ([update-admission.ts, lines 79–114](https://github.com/openclaw/openclaw/blob/7e80556f503d26ddde64e274bfb50cbbec7830f5/src/gateway/server-methods/update-admission.ts#L79)). An OCM update cannot stand in for a native updater scenario.

Native campaigns, native activation and rollback, updater-driven failure menus and native handoffs are outside reach. Their commands are excluded from executable selection, not marked as future native-service dependencies. Package and state fixtures do not remove the supervision boundary. No native service, custom supervisor or bypass of the external-supervision hint is created. Read-only previews, Doctor, update repair, recovery cleanup and package-replacement observations retain their separate paths.

All six historical breaks are outside reach here: 155433 needs the native managed handoff and macOS stop guard; 150816 needs native Bun activation; 161813 needs native replacement from the updater's working directory; 162604 needs the native activation Doctor and rollback; 159504 needs an affected older native updater (also absent from the pinned persona); 156633 needs the native interactive failure menu. The [breaks cross-check](derivation.md#breaks-cross-check) records each disposition.

Excluded phase IDs from the saved reconciliation:

- `update-from-terminal`
- `finish-plugin-updates`
- `switch-release-channel`
- `update-from-control-ui`
- `update-from-chat`
- `receive-restart-notices`
- `schedule-automatic-updates`
- `restart-under-external-supervisor`
- `event-verification-failure-triage`
- `event-verification-failure-rollback`
- `event-verification-failure-service-state`
- `event-git-verification-failure-restore`
- `event-migrated-verification-failure-repair`
- `event-verification-failure-unattended-repair`
- `event-interactive-failure-menu`
- `event-triage-consent-timeout`
- `event-control-ui-update-failure-log`
- `event-control-ui-update-failure-ask`
- `event-managed-handoff-refusal`
- `event-managed-handoff-no-result`
- `event-managed-handoff-spawn-failure`
- `event-npm-prefix-not-writable`
- `event-npm-prefix-volume-full`
- `event-snapshot-space-insufficient`
- `event-dev-staging-no-space`
- `event-registry-target-404`
- `event-registry-offline`
- `event-candidate-refuses-older-target`
- `event-pre-activation-failure-observation`
- `event-refused-update-keeps-channel`
- `event-activation-deadline`
- `event-dev-to-package-activation-failure`
- `event-no-restart-update`
- `event-no-restart-watcher-restart`
- `event-update-drain-deadline`
- `event-previous-gateway-ready-check-expiry`
- `event-replaced-gateway-update`
- `event-manual-install-over-stranded-update`
- `event-update-interrupted-before-activation`
- `event-cancel-before-mutation`
- `event-updater-signal-during-activation`
- `event-updater-killed-after-stop`
- `event-updater-exits-during-verification`
- `event-slow-candidate-startup`
- `event-still-starting-after-update`
- `event-ready-check-unverified-after-update`
- `event-rehearsal-budget-exceeded`
- `event-gateway-killed-during-verification`
- `event-doctor-maintenance-refused`
- `event-already-current-maintenance-refused`
- `event-foreign-writer-during-maintenance`
- `event-config-edited-during-update`
- `event-config-saved-during-admission`
- `event-update-from-agent-shell`
- `event-stop-during-update`
- `event-git-remote-unreachable`
- `event-plugin-target-unavailable`
- `event-clawhub-plugin-missing`
- `event-repair-during-live-update`
- `event-ledger-busy`
- `event-campaign-with-active-work`
- `event-campaign-apply-failure`
- `event-checks-disabled-during-discovery`
- `event-shutdown-during-discovery`
- `event-control-ui-reconnect-during-update`
- `event-control-ui-reload-after-update`
- `event-install-switch-candidate-failure`
- `event-channel-switch-refused`
- `event-restart-handoff-mismatch`
- `event-old-gateway-shutdown-after-replacement`
- `event-doctor-config-write-refused`
- `event-update-already-current`
- `event-candidate-validation-fails`
- `event-candidate-validation-fails-older-updater`
- `event-package-install-fails`
- `event-plugin-registry-offline`
- `event-capability-consent`
- `event-plugin-integrity-drift`
- `event-same-schema-rollback-and-reupgrade`
- `event-downgrade-newer-schema-refusal`

The original entry-point placement and all 520 condition rows remain in derivation.md as inventory, independent of executable selection. No new derivation runs were made. A native-service capability would require a separate lifecycle and persona design before these exclusions could change.

Node scenarios retain separate persona-driven and side-driven journeys, each with a fresh eligible host fixture. The cron restart scenario requires a held job that has reached active execution and a terminal result read. Same-code native rollback and custom-supervisor handoff scenarios have been excluded.

OCM lifecycle and observation corrections: stopped-service prerequisites use the bounded OCM stop helper and record service status. Fixture helpers must use OCM and wait for process exit. The stop RPC helper supplies the current clone’s PID, owner ID and port and fails closed if that identity is unavailable. The restart-disabled scenario uses the policy-gated chat commands; it makes no unrestricted `update.run` request that OCM could accept. Manual replacement retains the older-runtime journey and adds a fresh side-driven journey to exercise each side’s running replacement detector. Secondary status reads use the side runtime; repair stages fresh stale rows immediately before reading them.

Retained-scenario prerequisites: the OCM stop wrapper polls until the named Gateway has exited, including when OCM initially reports it still shutting down. Doctor repairs establish this offline ownership and restore the service afterward. The rich legacy-state fixture is now staged for Doctor, with resulting config and state recorded before fixture restoration. Non-owner update attempts require a verified authorized-but-non-owner conformance sender. Freeze recovery pauses for 120 seconds, beyond the pinned 75-second threshold, and waits for the thaw observation; recovery phases include their boot-lifecycle and thaw source owners in selection paths.

The following ineffective event descriptions were removed because their required work or outcome was not established: `event-doctor-interrupted-during-migration`, `event-doctor-terminated-during-archive-repair`, `event-migration-backup-interrupted`, `event-restart-during-startup-migration`, and `event-config-changed-during-doctor`. Their conditions remain inventoried and explicitly uncovered above.

OCM history boundary: at the pinned revision, `src/gateway/server-methods/update-status.ts:65–113` uses OCM history instead of the native ledger when OCM supports updates. Seeded native failures cannot establish the Settings reporting, retry or diagnosis actions. `check-and-retry-update` and those UI commands are excluded. Direct native-ledger report preview and CLI triage remain; the basic Updates page records the OCM-backed view without claiming it shows native failures.

Product outcomes remain comparable: after successful fault setup, absent thaw recovery, missing replacement detection and incomplete restart sequences are recorded with normal result/error/timeout semantics, not exit 2. Replacement journeys wait for a product record or process-generation change before consuming their observations. The update-check failure scenario stops the clone, resets its telemetry cache, serves a malformed endpoint response and records request attempts on completion. Its source selector includes telemetry.ts; node scenarios include node-host-launcher.mjs and pending package lifecycle includes src/index.ts. The retired-files startup fixture uses filesPath with valid config, separately from the legacy-config refusal fixture.

Persona-consumption order follows the catalogue metadata: session-holding phases precede chat operations that consume the same session, and installation observations precede operations that consume the same installation trait. Setup and file-writer dependencies remain first; recovery retirement remains last. The supported command metadata was checked through the catalogue resolver from [PR #174](https://github.com/openclaw/Kova/pull/174); full planning still requires its deferred registrations. Cleanup phases include the inventory, retirement and destination-verification implementations in their selectors. The valid-config retired-files export establishes startup continuation; later Doctor refusals blocked by its runtime-file preflight are not credited.

The forced-restart case holds its turn for 360,000 ms, exceeding the pinned 300,000 ms allowance, with a 700,000 ms phase bound. The CLI rejects combining --force with --wait, so the case preserves its actual forced path. Busy-restart selectors include work admission, active-work accounting, drain waiting and shutdown-budget computation. The redundant Doctor invocation over the combined retired-state export is removed: its first refusal cannot establish the later cron, delivery-queue or OAuth checks.

Asynchronous restarts are observed against a bounded snapshot of gateway_boot_lifecycle before each held-work variant. Health checks in this mode require a new active boot/owner generation, observe rather than repair the service, and record a missing transition as a normal timeout. Missing drain after valid setup likewise remains a product observation. Cron cancellation and shutdown-budget owners select their corresponding scenarios, and restart-policy owners select the disabled-policy case. Installation triage is a normal diagnostic control; it does not claim failed-update discovery without the required failed restart sentinel.

Recovery observations and isolation: crash-loop checks include the suppression, recovery and persistence owners. They capture the initial boot rows, observe the breaker interval and wait up to 420,000 ms for a new recovery row, then record channel state. Existing old recovery rows cannot satisfy that observation. Outbox checks select the reconnect reconciliation and replay owners. Each cleanup attempt independently restores its recovery-originals export, so an earlier successful cleanup cannot erase a later attempt’s input. Reader polling is not treated as guaranteed destination mutation.

The crash-loop phase independently restores update-baseline-fixture before observing its initial boot rows. That export must have settled boot history, with no recent unclean boots or unrecovered breaker marker, so another selected scenario cannot supply the trip being measured. The fixture remains unavailable until the persona supplies that starting state.

Observation lifetimes: the malformed-response endpoint remains available until its current-window request and HTTP exchange are observed within a bound; product status/log collection follows, then teardown. The restart port fault is armed before the request and retained through its result, with a 600,000 ms cap exceeding the pinned 300,000 ms drain plus 60,000 ms health allowance. Thaw scheduling, ACP model checks, CLI response formatting and update-check scheduling select their observations. Across helper contracts, valid operational errors and timeouts use normal 1/3 outcomes; 2 is reserved for malformed call inputs and does not relabel a product or storage failure.
