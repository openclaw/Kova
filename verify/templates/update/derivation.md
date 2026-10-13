# Derivation: update

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

Reconciled at step 8 from two independent runs of steps 1 to 7 on verify/areas/update.json at this revision: run 1 and run 2. Every item below is the union of the two runs; `## Reconciliation` lists what only one run found.

## Bounds
Paths: src/cli/update-cli.ts, src/cli/update-cli/**, src/cli/update-option-specs.ts, src/cli/run-main-update-admission.ts, src/cli/daemon-cli/update-*.ts, src/cli/daemon-cli/restart-*.ts, src/cli/daemon-cli/lifecycle-*restart*.ts, src/cli/gateway-cli/update-successor.ts, src/cli/gateway-cli/register-restart-handoff.ts, src/gateway/server-methods/update*.ts, src/gateway/server-methods/restart*.ts, src/gateway/update-run-*.ts, src/gateway/server-restart-update-run.ts, src/gateway/server-startup-update-check.ts, src/gateway/server-update-sentinel.ts, src/gateway/server-restart-sentinel*.ts, src/gateway/server-startup-restart-sentinel.ts, src/gateway/server-startup-session-migration.ts, src/gateway/restart-trace.ts, src/infra/update-*.ts, src/infra/package-update-*.ts, src/infra/ocm-update-client.ts, src/infra/restart*.ts, src/infra/windows-task-restart.ts, src/infra/state-migrations*.ts, src/infra/startup-migration-checkpoint.ts, src/infra/sqlite-rollback-recovery.ts, src/infra/migration-warning-summary.ts, src/infra/deferred-plugin-migration*.ts, src/infra/device-pairing-migration.ts, src/infra/device-pairing-node-desktop-migration.ts, src/infra/node-pairing-migration.ts, src/infra/exec-approvals-*migration*.ts, src/infra/legacy-acp-migration-source.ts, src/infra/session-sqlite-migration-*.ts, src/infra/session-cost-usage-cache-migration.ts, src/infra/outbound/delivery-queue-migration.ts, src/state/*migration*.ts, src/state/openclaw-schema-versions.ts, src/state/openclaw-state-db-schema-version.ts, src/state/openclaw-state-db-content-version.ts, src/state/openclaw-state-db-doctor-schema.ts, src/state/openclaw-update-schema-refusal.ts, src/config/*-migration.ts, src/commands/doctor-update*.ts, src/commands/doctor-post-upgrade*.ts, src/commands/doctor-startup-migration-refusal.ts, src/commands/doctor-migration-*.ts, src/commands/doctor-*-migration*.ts, src/commands/doctor-config-preflight-*.ts, src/commands/doctor/legacy-config-repair.ts, src/commands/doctor/shared/legacy-config-*.ts, src/commands/doctor/cron/*migration*.ts, src/commands/doctor/cron/legacy-*.ts, src/flows/doctor-update-budget.ts, src/commands/status.update.ts, src/commands/status-update-restart.ts, src/commands/triage*.ts, src/infra/triage-continuation.ts, src/cli/gateway-cli/startup-triage.ts, src/auto-reply/reply/commands-update.ts, src/daemon/launchd-update-jobs.ts, src/daemon/launchd-restart-handoff.ts, src/daemon/service-update-authority.ts, src/daemon/schtasks-update-recovery.ts, src/daemon/restart-*.ts, src/node-host/auto-update*.ts, src/node-host/runtime-update-pause.ts, src/shared/update-outcome.ts, ui/src/pages/config/updates*.ts, ui/src/app/update-*.ts, ui/src/app/overlays-updates.ts, ui/src/components/sidebar-update-card.ts, ui/src/components/sidebar-attention-update.ts, ui/src/components/update-*.ts, src/gateway/stale-install.ts, src/infra/package-lifecycle.ts
Documents: docs/cli/update.md, docs/cli/update/how-updates-run.md, docs/cli/update/repair-and-recovery.md, docs/cli/update/status-and-history.md, docs/install/updating.md, docs/install/updating/automatic-updates.md, docs/install/updating/rollback-and-recovery.md, docs/install/updating/update-methods.md, docs/install/update-troubleshooting.md, docs/install/development-channels.md, docs/gateway/troubleshooting/updates-and-rollbacks.md, docs/cli/triage.md, docs/cli/doctor/state-migrations.md, docs/gateway/doctor/config-migrations.md, docs/reference/database-schemas/versioning.md, docs/reference/database-schemas/integrity-and-recovery.md, docs/gateway/restart-recovery.md, docs/cli/gateway/restart-and-supervision.md, docs/web/control-ui/settings.md, docs/gateway/telemetry.md, docs/tools/slash-commands.md, docs/install/docker.md, docs/install/bun-compatibility.md (added: linked from docs/install/updating.md "Recommended: `openclaw update`"; run 1)
Partial documents read under the bound: docs/web/control-ui/settings.md (Updates only); docs/gateway/telemetry.md (Daily update check, Automated environments, Disable every automatic update request); docs/tools/slash-commands.md (/update, /restart, commands.restart, commands.ownerAllowFrom); docs/install/docker.md (Upgrading container images); docs/reference/database-schemas/integrity-and-recovery.md (Doctor reports orphan task delivery rows, Why you cannot go back after updating to 2026.7.2, The Gateway refuses to start with a newer schema version error, Downgrade recovery); docs/gateway/restart-recovery.md is read in full, with Automatic resume, Subagents and Agent-requested restarts left to sessions.
Caller search: the `search.symbols` and `search.literals` of the area input file, grepped as whole words with fixed strings (`grep -rowF`) over src, ui/src, extensions and packages, file types .ts/.tsx/.js/.mjs/.mts/.cts, skipping node_modules and dist build output.

## Excluded paths
src/agents/main-session-recovery/**, src/gateway/server-methods/chat-restart-recovery.ts: owned by sessions (automatic resume of interrupted turns after a restart; bound decision)
src/plugins/update*.ts, src/cli/plugins-update-*.ts: owned by plugins (plugin code reached during plugin sync is listed as kind from plugins)
src/gateway/server-reload-*.ts, src/config/io*.ts, src/config/mutate*.ts, src/config/write-lock.ts: owned by config (config writes; the update hooks they call are listed as entry points of kind from config)
src/commands/migrate/**: owned by migrate
src/claws/**: owned by claws; src/hooks/update.ts: owned by hooks
src/gateway/device-scope-upgrade.ts, ui/src/app/device-scope-upgrade*.ts: owned by devices
src/daemon/schtasks-update-recovery.ts, src/infra/windows-task-restart.ts: inside the area globs but owned by platform per the bound (Windows Scheduled Task paths); a break that needs Windows is outside this template's reach
src/gateway/methods/core-descriptors.ts, src/gateway/server-methods.ts, src/gateway/server-request-lifecycle.ts, src/gateway/server-broadcast-scopes.ts, src/gateway/events.ts: owned by Gateway core (method registration, scopes, dispatch and broadcast event names; listed as entry points where the caller search finds them)
src/cli/program/register.subclis.ts, src/cli/program/register.maintenance.ts, src/cli/daemon-cli/register-service-commands.ts, src/cli/argv.ts, src/cli/gateway-cli/output-mode.ts: owned by the CLI program (command registration for openclaw update, openclaw triage, openclaw gateway restart and the --update shorthand; the commands are this area's entry points)
src/auto-reply/reply/commands-session.ts, src/auto-reply/reply/command-gates.ts: owned by chat commands (/restart handler and the owner gate for /update and /restart; the chat commands are this area's entry points)
src/agents/tools/gateway-tool.ts: owned by agent tools (its update.run action is this area's entry point)
src/commands/doctor*.ts, src/flows/doctor-*.ts and src/commands/doctor/** outside the area globs: owned by doctor (their update and migration hooks are listed as entry points of kind from doctor)
src/state/openclaw-agent-db-schema.ts, src/state/openclaw-state-db-*.ts outside the area globs, src/state/openclaw-state-worker-runtime.ts: owned by database schemas (their migration and update-ledger writers are listed as entry points of kind from state)
src/cli/gateway-cli/run*.ts, src/cli/gateway-cli/lifecycle.runtime.ts, src/cli/daemon-cli/lifecycle*.ts outside the area globs, src/daemon/launchd-*.ts outside the area globs, src/infra/process-respawn.ts: owned by gateway lifecycle and service management (they reach restart and update handoff; listed as entry points of kind from gateway lifecycle)
src/node-host/runner.ts, src/node-host/runtime.ts: owned by nodes (they start the headless node automatic update)
ui/src/app/app-shell-view.ts, ui/src/components/sidebar-issue-item.ts, ui/src/pages/config/config-page.ts, ui/src/pages/custodian/**: owned by the Control UI shell, settings shell and custodian (they host the update card, Updates section and update alert)
packages/gateway-protocol/**: owned by the Gateway protocol (method parameter and response schemas)
docs/reference/team-immutable-update-design.md: a design proposal, not current behaviour (bound decision)
macOS app update card, Sparkle and the native device update rows on the Updates page (renderDeviceUpdates): owned by the apps
Legacy session store import and session store schema (openclaw doctor --session-sqlite, docs/gateway/doctor/state-and-sessions.md): owned by sessions; its Doctor files are still listed below as entry points of kind from sessions
docs/cli/backup.md, docs/install/backups.md (openclaw backup): owned by backup; creating a verified backup before an update is listed as an entry point of kind from backup
install.sh, install-cli.sh, install.ps1, docs/install/installer.md, onboarding: owned by install
Doctor checks that are neither update repairs nor migrations (docs/cli/doctor/recovery.md, the health contract, lint, SQLite maintenance, integrity checks other than the newer-schema refusal and downgrade recovery): owned by doctor
docs/gateway/protocol/versioning.md (protocol versioning between clients): owned by Gateway protocol; a protocol mismatch after rollback stays a condition here
src/gateway/server-methods/suspend.ts (gateway.suspend.*): owned by Gateway suspension; its methods are consumed by this area
docs/ci/release-validation*, docs/reference/full-release-validation*: owned by the maintainers' release process

## Operations
| Operation | Entry points | Kinds |
| --- | --- | --- |
| Check for updates and see what is installed | `update.status`; `openclaw update status`; openclaw status update line (src/commands/status.update.ts); startup update check; periodic update check; Settings Updates: Check for updates button; Compare on GitHub link (dev Git revisions); Sidebar attention update entry; packages/gateway-protocol/src/schema/config.ts (update.status); ui/src/pages/config/config-page.ts (update.status) | CLI command; Gateway method; UI action; from Gateway protocol; from settings; scheduled job; startup hook |
| Back up before an update | `openclaw backup create --verify`; src/infra/backup-create.ts (createLegacyAuditBackupCapture) | from backup |
| Update OpenClaw from the terminal | `openclaw update`; `openclaw --update`; src/cli/argv.ts ("--update"); src/cli/daemon-cli.ts (adoptUpdateRun, createManagedUpdateRequesterAuthority, finishUpdateRun, recordUpdateRunDiagnostic, recordUpdateRunStep, recordUpdateRunVerification, runDaemonRestart); src/cli/daemon-cli/lifecycle-context.ts (createManagedUpdateRequesterAuthority); src/cli/program/register.subclis.ts (registerUpdateCli); src/daemon/launchd-stop.ts (createManagedHandoffLeaseStore, prepareGatewayRestartIntentLegacyProcess, scheduleDetachedLaunchdMaintenancePark, update.run, writeGatewayServiceRestartIntentSync); src/daemon/service-operation-lock.ts (createManagedHandoffLeaseStore); src/daemon/service-reconciliation.ts (recordUpdateRunStep) | CLI command; from CLI program; from gateway lifecycle; from service management |
| Finish plugin updates and plugin migrations | post-core plugin sync during openclaw update (docs/cli/update/how-updates-run.md "Plugin sync details"); pending plugin migrations Doctor runs (docs/cli/doctor/state-migrations.md "Pending plugin migrations") | CLI command; from plugins |
| Switch release channel or install type | `openclaw update wizard`; Settings Updates: update channel selector | CLI command; UI action |
| Update from the Control UI | `update.run`; Settings Updates: Update now; Sidebar update card: Update Gateway; Sidebar update card: Review update; Sidebar update card: open the active or completed run; Update confirmation: Update and restart; Update confirmation: Cancel (Escape, dismiss); Update dialog: Review update; Update dialog: Close; Update run view: per-step detail disclosure; Update run view: Installation steps disclosure; Update run view: Step details panel; src/gateway/methods/core-descriptors.ts (gateway.restart.preflight, gateway.restart.request, gateway.stop.request, update.hold, update.report, update.run, update.runs.get, update.runs.list, update.status); ui/src/app/app-shell-view.ts (update.run); ui/src/components/sidebar-issue-item.ts (update.hold, update.run); ui/src/pages/custodian/custodian-alert-card.ts (update.run) | Gateway method; UI action; from Control UI shell; from Gateway core; from custodian |
| Update from chat or through the agent | /update; `gateway` tool action `update.run`; src/agents/system-prompt.ts (update.run); src/agents/tools/gateway-tool.ts (update.run); src/auto-reply/reply/command-gates.ts ("/restart", "/update"); operator-scheduled automation calling gateway update.run | chat command; from agent tools; from agents; from chat commands; tool action |
| See restart and update notices after the Gateway returns | openclaw status Update restart row (src/commands/status-update-restart.ts); update run watcher; restart sentinel processing at startup; restart-update-run finalization after the replacement Gateway starts; Sidebar update card: Refresh for full capabilities / Retry now (Server updated); src/gateway/server-startup-post-attach.ts (createDeferredGatewayUpdateCheck, createGatewayUpdateCheck, prepareLatestUpdateRestartSentinel, scheduleRestartSentinelWakeAfterReady) | CLI command; UI action; from Gateway core; scheduled job; startup hook |
| Schedule, hold or turn off automatic updates | `update.hold`; automatic update campaign; Settings Updates: Check for updates toggle; Settings Updates: Automatic updates toggle; Settings Updates: Hold 1 h; Sidebar update card: Hold 1 h | Gateway method; UI action; scheduled job |
| Inspect past update runs | `update.runs.get`; `update.runs.list`; packages/gateway-protocol/src/core-request-params.ts (update.runs.get, update.runs.list); packages/gateway-protocol/src/schema/update-runs.ts (update.run); src/gateway/server-request-lifecycle.ts (update.runs.get); src/state/openclaw-state-worker-runtime.ts (persistInterruptedUpdateObservation, reconcileUpdateRunCandidatesInWorker, recordUpdateRunMutationInWorker) | Gateway method; from Gateway core; from Gateway protocol; from database schemas |
| Check on and retry an update in the Control UI | Settings Updates: Check status (recorded attempt); Settings Updates: Retry update (recorded attempt); Update dialog: Check status; Update dialog: Retry update | UI action |
| Diagnose a failed update with triage | `openclaw triage`; startup failure triage; automatic triage after a failed managed update; Settings Updates: Diagnose update; Settings Updates: Show terminal commands; Settings Updates: Troubleshoot updates link; src/cli/gateway-cli/run.ts (triageGatewayStartupFailure); src/cli/program/register.maintenance.ts (command("triage")); Ask OpenClaw update-failure alert and its "Review update" action | CLI command; UI action; from CLI program; from gateway lifecycle; startup hook |
| Report an update failure | `update.report`; Settings Updates: Report update failure; Settings Updates: Open GitHub issue link; Settings Updates: Open prefilled issue link; Failure report preview: Submit; Failure report preview: Cancel | Gateway method; UI action |
| Repair an installation after an update | `openclaw update repair`; openclaw doctor (update repair inspection and post-upgrade probes); package-publication recovery helper `status --anchor --operation`; package-publication recovery helper `repair --anchor --operation`; legacy update admission expiry; src/commands/doctor-lint-runner.ts (admitDoctorUpdateInspection); src/commands/doctor-maintenance-admission.ts (recordUpdateRunRepairContinuation); src/commands/doctor-maintenance-state.ts (createUpdateDoctorDatabaseWriteCapture); src/commands/doctor-maintenance.ts (recordUpdateDoctorRefusal); src/commands/doctor-original-capture.ts (captureUpdateRecoveryBaseline, retireExpiredStandaloneDoctorCaptures); src/commands/doctor.ts (runPostUpgradeProbes); src/commands/doctor/shared/release-configured-plugin-installs.ts (createDeferredConfiguredPluginRepairDoctorResult); src/flows/doctor-health.ts (captureUpdateDoctorConfigWrites, maybeOfferUpdateBeforeDoctor, recordUpdateDoctorRefusal, recordUpdateRunStep, writeUpdatePostInstallDoctorResult) | CLI command; from doctor; startup hook |
| Migrate legacy state and config to the new version | openclaw doctor --fix (update repairs and migrations); startup state migration with its checkpoint; src/acp/runtime/session-meta-migration-embedded.ts (prepareLegacyAcpMigrationSource, recordLegacyAcpMigrationCompletion); src/acp/runtime/session-meta-write.native.ts (recordLegacyAcpMigrationCompletion); src/acp/runtime/session-meta-write.worker.ts (recordLegacyAcpMigrationCompletion); src/agents/workspace-alias-rebind.ts (applyWorkspaceMigrationReceiptMove, prepareWorkspaceMigrationReceiptMove); src/channels/message/ingress-queue.migration.ts (markLegacyMigrationSourceRemovedInDatabase, recordLegacyMigrationReceipt); src/channels/plugins/types.adapters.ts (detectLegacyStateMigrations); src/commands/config-preflight-snapshot.ts (recordStartupMigrationWarnings); src/commands/doctor-auth-flat-profiles.ts (createAuthProfileMigrationSourceReceipt, finalizeAuthProfileMigrationSource, resumePendingAuthProfileMigrationArchives); src/commands/doctor-config-flow.ts (repairCronCodexRuntimePolicies, repairUnownedChannelAccountBindings); src/commands/doctor-config-preflight.cron.ts (migrateLegacyConfigMachineState, repairLegacyCronStoreWithoutPrompt); src/commands/doctor-config-preflight.ts (autoMigrateLegacyState, autoMigrateLegacyStateDir, createDoctorConfigRepairPlanner, createDoctorPluginMigrationPreparation, createDoctorRehearsalSnapshotPreparation, migrateLegacyConfig, migrateLegacyDoctorConfig, noteStaleUpdateRuns, prepareDoctorConfigRecovery, prepareDoctorMigrationPlugins, repairLegacyCronStoreWithoutPrompt); src/commands/doctor-heartbeat-main-session-repair.ts (updateLegacySessionStore); src/commands/doctor-outbound-delivery.ts (migrateLegacyPendingOutboundDeliveries); src/commands/doctor-session-delivery-state.ts (createLegacyStateMigrationStepReceipt); src/commands/doctor-session-sqlite-archive.ts (recordCompletedMigrationMoves, recordPlannedMigrationMoves, updateMigrationManifestTarget); src/commands/doctor-session-sqlite-discovery.ts (migrateLegacySessionCreator); src/commands/doctor-session-sqlite-failure.ts (writeSessionSqliteMigrationManifest); src/commands/doctor-session-sqlite-import.ts (prepareLegacyAcpMigrationSource, updateMigrationManifestTarget); src/commands/doctor-session-sqlite-restore.ts (writeSessionSqliteMigrationManifest); src/commands/doctor-session-sqlite-retained.ts (createSessionSqliteMigrationRun, markLegacyMigrationSourceRemovedInDatabase, recordCompletedMigrationMoves, recordPlannedMigrationMoves, updateMigrationManifestTarget, writeSessionSqliteMigrationManifest); src/commands/doctor-session-sqlite-retirement.ts (writeSessionSqliteMigrationManifest); src/commands/doctor-session-sqlite-verification.ts (migrateLegacySessionCreator); src/commands/doctor-session-sqlite.ts (createSessionSqliteMigrationRun, recordCompletedMigrationMoves, recordPlannedMigrationMoves, updateMigrationManifestTarget, writeSessionSqliteMigrationManifest); src/commands/doctor-session-state-providers.ts (updateLegacySessionStore); src/commands/doctor-session-transcripts.ts (createLegacyStateMigrationStepReceipt, runPostSessionPluginDoctorStateRepairs); src/commands/doctor-state-integrity.ts (updateLegacySessionStore); src/commands/doctor/auth-alias-receipt.ts (recordLegacyMigrationReceipt); src/commands/doctor/cron/index.ts (applyLegacyCronStoreRepair); src/commands/doctor/repair-sequencing.ts (migrateLegacyTailscaleProfileIdentities, recordUpdateModelRetirement, repairMergedGatewayOwnerProfile); src/commands/doctor/shared/automatic-config-repair.ts (applyLegacyDoctorMigrations, repairLegacyCronOwnersBeforeConfigWrite); src/commands/doctor/shared/codex-route-session-repair.ts (updateLegacySessionStore); src/commands/doctor/shared/config-flow-steps.ts (applyLegacyDoctorMigrations, migrateLegacyConfig); src/commands/doctor/shared/config-migration-result.ts (createLegacyStateMigrationStepReceipt, migrateLegacyConfig); src/commands/doctor/shared/config-recovery.ts (applyLegacyDoctorMigrations); src/commands/doctor/shared/preview-warnings.ts (repairMergedGatewayOwnerProfile); src/commands/startup-config-preflight.ts (recordStartupMigrationWarnings); src/config/io.runtime-write-finalization.ts (recordUpdateDoctorConfigWrite); src/config/io.write-topology.ts (retireLegacyAgentDefaultMarkers); src/config/io.write.ts (recordUpdateDoctorConfigWrite); src/config/mutate.include-io.ts (recordUpdateDoctorConfigFileWrite); src/config/write-lock.ts (createManagedHandoffLeaseStore, recordUpdateDoctorConfigWriteRefusal); src/flows/doctor-core-checks.ts (detectLegacyStateMigrations); src/flows/doctor-health-contribution-runners.config.ts (recordUpdateDoctorConfigMigration, recordUpdateDoctorConfigWriteRefusal, recordUpdateModelRetirement, repairLegacyCronOwnersBeforeConfigWrite, runUpdateDoctorIncludeWrite); src/flows/doctor-health-contributions.ts (admitDoctorUpdateInspection, detectLegacyStateMigrations, repairObsoleteGeneratedExecApprovals, runLegacyStateMigrations); src/gateway/server-agent-database-startup.ts (prepareGatewayStartupSessions); src/gateway/server-startup-bootstrap.ts (prepareGatewayStartupSessions, setGatewayRestartPolicy, setPreRestartDeferralCheck); src/infra/deferred-plugin-session-sources.ts (recordLegacyMigrationReceipt, recordStartupMigrationWarnings); src/plugins/doctor-contract-legacy-setup.ts (detectLegacyStateMigrations); src/plugins/state.worker.ts (recordDeferredPluginMigrationsInTransaction); src/state/agent-deletion-journal-recovery.ts (recordLegacyMigrationReceipt); src/state/openclaw-agent-db-schema.ts (migrateConversationDeliveryTargetColumn, migrateSessionCostUsageRollupStorage, migrateSessionCreatorNamespaces, migrateSessionEntrySnapshotsInTransaction, migrateSessionNodesAndWindows, migrateSessionParticipantsSchema, migrateSessionTranscriptActiveProjection, migrateSessionTranscriptGenerations, migrateTranscriptPayloadStorageInTransaction); src/state/openclaw-state-db-maintenance.ts (migrateCronDeliveryAttemptState); src/state/openclaw-state-db-repair.ts (migrateLegacyCronRunLogsToTaskRuns, migrateSessionWatchCursorProvenance, repairAuditEventsSchema); src/state/openclaw-state-db-schema-runtime.ts (migrateLegacyCronRunLogsToTaskRuns, migrateSessionWatchCursorProvenance) | CLI command; from ACP; from Gateway core; from agents; from channels; from config; from database schemas; from doctor; from plugins; from sessions; startup hook |
| Update by another method | installation replacement check on the maintenance tick; pending package lifecycle completion before a CLI command; re-running the installer over an existing installation; npm install -g openclaw@<target>; pnpm add -g openclaw@<target>; bun add -g openclaw@<target>; brew upgrade openclaw-cli; replacing a container image over the same mounted state; scripts/update-gateway.sh; src/cli/gateway-cli/run-loop-request.ts (registerGatewayInstallationReplacementHandler, update.run); src/gateway/server-maintenance.ts (checkGatewayInstallationReplacement) | another method; from Gateway core; from gateway lifecycle; scheduled job; startup hook |
| Keep headless node hosts updated | headless node host automatic update; src/node-host/runner.ts (startNodeHostAutoUpdate); src/node-host/runtime.ts (createNodeHostUpdatePause) | from nodes; scheduled job |
| Restart the Gateway | `gateway.restart.request`; `gateway.restart.preflight`; `gateway.stop.request`; `openclaw gateway restart`; SIGUSR2 manual restart signal; /restart; extensions/admin-http-rpc/src/methods.ts (gateway.restart.request, update.status); src/auto-reply/reply/commands-session.ts ("/restart", clearRestartSentinelIfRevision, scheduleGatewayRestart, triggerOpenClawRestart, writeRestartSentinel); src/cli/channel-auth.ts (gateway.restart.request); src/cli/daemon-cli/lifecycle-core.ts (createServiceRestartIntent); src/cli/daemon-cli/lifecycle-unmanaged.ts (clearGatewayRestartIntentSync, gateway.restart.request, writeGatewayRestartIntentSync); src/cli/daemon-cli/lifecycle.runtime.ts (runDaemonRestart); src/cli/daemon-cli/lifecycle.ts (runDaemonRestart, runSafeGatewayRestart); src/cli/daemon-cli/register-service-commands.ts (runDaemonRestart); src/cli/gateway-cli/host-lifecycle.ts (scheduleSafeGatewayRestart); src/cli/gateway-cli/lifecycle.runtime.ts (consumeGatewayRestartAuthorization, consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, consumeGatewayRestartIntentSync, markGatewayRestartHandled, markUpdateRestartSentinelFailure, requestGatewayRestartWithSignalAdmission, resetGatewayRestartStateForInProcessRestart, rollbackGatewayRestartSignalAdmission, scheduleGatewayRestart, writeGatewayRestartHandoffSync, writeRestartSentinelIfUnchanged); src/cli/gateway-cli/run-loop-drain.ts (markGatewayRestartTrace); src/cli/gateway-cli/run-loop-startup.ts (markGatewayRestartTrace, resetGatewayRestartStateForInProcessRestart); src/cli/gateway-cli/run-loop.ts (consumeGatewayRestartAuthorization, consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, markGatewayRestartHandled, markGatewayRestartTrace, requestGatewayRestartWithSignalAdmission, rollbackGatewayRestartSignalAdmission, scheduleGatewayRestart, update.run, writeGatewayRestartHandoffSync); src/daemon/launchd-lifecycle.ts (scheduleDetachedLaunchdRestartHandoff); src/daemon/schtasks-process.ts (gateway.stop.request); src/gateway/server-close.ts (recordGatewayRestartTrace); src/gateway/server-methods.ts (gateway.restart.request); src/gateway/server-methods/config-write-flow.ts (scheduleGatewayRestart, writeRestartSentinel); src/gateway/server-reload-hot.ts (setGatewayRestartPolicy); src/gateway/server-reload-restart.ts (deferGatewayRestartUntilIdle, setGatewayRestartPolicy); src/gateway/server-startup-trace.ts (recordGatewayRestartTraceDetail, recordGatewayRestartTraceSpan); src/infra/process-respawn.ts (scheduleDetachedLaunchdRestartHandoff, triggerOpenClawRestart); src/system-agent/operations-execution-helpers.ts (runDaemonRestart) | CLI command; Gateway method; chat command; from CLI program; from Gateway core; from admin HTTP RPC; from channels; from chat commands; from config; from gateway lifecycle; from service management; from system agent; signal |
| Hand restarts to an external supervisor | `openclaw gateway restart-handoff capabilities`; `openclaw gateway restart-handoff consume`; src/cli/gateway-cli/output-mode.ts ("restart-handoff") | CLI command; from CLI program |
| Retire update recovery data | `openclaw update cleanup`; package-publication recovery helper `retire --anchor --operation` | CLI command |
| Update an immutable release installation | `openclaw update adopt-immutable`; `openclaw update recover` | CLI command |

Entry points of kind `from <area>` are the non-test files outside the area's paths found by the caller search; each names the matched symbols or literals in parentheses. Startup hooks, scheduled jobs and other update methods are the ones the area input file names, one entry point each.

## Excluded entry points
`openclaw update admit`: internal: hidden candidate admission protocol the installed updater spawns
`openclaw update finalize`: internal: hidden supervisor-facing finalization; its user-facing form is update repair
`openclaw update migration-plan`: internal: hidden snapshot migration planner used by the updater
`openclaw daemon restart`: deprecated (bound decision)
This device: Automatic updates toggle (native app): owned by the apps (native device self-update)
This device: Check (native app): owned by the apps (native device self-update)
Sidebar update card: Update Mac app + Gateway: owned by the apps (signed macOS app coordinated update)
Settings → Updates route (/settings/updates): shell (bound decision: navigation)
Shell controls shared by every page (navigation, theme, account, settings panel): shell
scripts/freebsd-service-inspect.mjs: owned by platform: FreeBSD-only diagnostic script outside the area's paths
scripts/doctor-config-upgrade-replay.mjs: test-only: repository replay script for a fixture config
pnpm test:startup:gateway: test-only: repository benchmark
pnpm test:restart:gateway: test-only: repository benchmark
`update.available` event: internal: broadcast event
`update.run.changed` event: internal: broadcast event
`openclaw gateway start`: consumed from gateway service
`openclaw gateway stop`: consumed from gateway service
`openclaw gateway status`: consumed from gateway service
`openclaw gateway install`: consumed from gateway service
`openclaw gateway call`: consumed from gateway
`openclaw health`: consumed from gateway
`openclaw logs`: consumed from logging
`openclaw nodes status`: consumed from nodes
`openclaw node restart`: consumed from nodes
`openclaw config get`: consumed from config
`openclaw config set`: consumed from config
`openclaw config validate`: consumed from config
`openclaw database preflight`: consumed from database
`openclaw database ownership claim`: consumed from database
`openclaw completion`: consumed from CLI program
`openclaw plugins update`: consumed from plugins
`gateway.suspend.prepare`: consumed from gateway
`gateway.suspend.status`: consumed from gateway
`gateway.suspend.resume`: consumed from gateway
`gateway.suspend.handoff`: consumed from gateway
`config.get`: consumed from config
`config.patch`: consumed from config
`channels.start`: consumed from channels
`chat.send`: consumed from sessions
`openclaw node run`: consumed from nodes
`openclaw plugins install`: consumed from plugins
`openclaw plugins disable`: consumed from plugins
`openclaw plugins enable`: consumed from plugins
`openclaw plugins reload`: consumed from plugins
`openclaw browser doctor`: consumed from browser
`openclaw agents add`: consumed from agents
`openclaw agents delete`: consumed from agents
`openclaw channels remove`: consumed from channels
`openclaw channels status`: consumed from channels
`openclaw onboard`: consumed from install
`openclaw models auth login`: consumed from models
`openclaw memory status`: consumed from memory
`openclaw config unset`: consumed from config
`openclaw doctor --session-sqlite`: consumed from sessions
`openclaw sessions`: consumed from sessions
`openclaw doctor --lint`: consumed from doctor
`openclaw doctor --deep`: consumed from doctor
extensions/matrix/src/matrix/monitor/reaction-events.ts (update.status): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/acp/client.ts (update.status): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/claws/mcp.ts (update.status): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/commands/doctor.e2e-harness.ts (autoMigrateLegacyState, autoMigrateLegacyStateDir, detectLegacyStateMigrations, migrateLegacyConfig, migrateLegacyConfigMachineState, runLegacyStateMigrations): test-only: test harness or QA runtime
src/commands/doctor.fast-path-mocks.ts (repairLegacyCronStoreWithoutPrompt): test-only: test harness or QA runtime
src/config/sessions/session-accessor.sqlite-import-stage.ts (update.run): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/gateway/events.ts (update.run): internal: broadcast event name declaration
src/gateway/server-methods/sessions-files.ts (update.status): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/gateway/server-methods/workspace-files.ts (update.status): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/logging/diagnostic-stability.ts (update.status): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/plugin-sdk/qa-runtime.ts (writeGatewayRestartIntentSync): test-only: test harness or QA runtime
src/state/openclaw-state-db-legacy-backfills.ts (update.run): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
src/state/openclaw-state-db-schema-v13-widerow.ts (update.run): not an entry point: the match is an unrelated local identifier (a variable named update or a prepared statement), not this area's symbol
extensions/qa-lab/src/suite-runtime-gateway.ts (gateway.restart.request, writeGatewayRestartIntentSync): test-only: test harness, test support or QA lab
src/agents/media-generation-activity.observer.test-support.ts (update.status): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-external-handoff.test-support.ts (writeGatewayRestartHandoffSync): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-force.test-support.ts (consumeGatewayRestartIntent, deferGatewayRestartUntilIdle, resetGatewayRestartStateForInProcessRestart): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-hosted-stop.test-support.ts (consumeGatewayRestartIntentPayloadSync): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-mocks.test-support.ts (consumeGatewayRestartAuthorization, consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, consumeGatewayRestartIntentSync, markGatewayRestartHandled, markUpdateRestartSentinelFailure, requestGatewayRestartWithSignalAdmission, resetGatewayRestartStateForInProcessRestart, rollbackGatewayRestartSignalAdmission, scheduleGatewayRestart, writeGatewayRestartHandoffSync, writeRestartSentinelIfUnchanged): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-package-helper.test-support.ts (adoptUpdateRun, finishUpdateRun, recordUpdateRunStep, recordUpdateRunVerification): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-package-lifecycle.test-support.ts (consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, createManagedHandoffLeaseStore, createUpdateRun, update.run): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-request.test-support.ts (consumeGatewayRestartIntent, update.run): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-shutdown-budget.test-support.ts (consumeGatewayRestartIntent): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-shutdown-completion.test-support.ts (consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, requestGatewayRestartWithSignalAdmission, update.run): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-stop.test-support.ts (consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, markUpdateRestartSentinelFailure, rollbackGatewayRestartSignalAdmission, update.run, writeGatewayRestartHandoffSync): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop-update-respawn.test-support.ts (consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, markUpdateRestartSentinelFailure, update.run, writeGatewayRestartHandoffSync): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop.forced-cron.test-support.ts (writeGatewayRestartIntentSync): test-only: test harness, test support or QA lab
src/cli/gateway-cli/run-loop.test-support.ts (consumeGatewayRestartIntent, consumeGatewayRestartIntentPayloadSync, markUpdateRestartSentinelFailure, update.run, writeGatewayRestartHandoffSync, writeRestartSentinelIfUnchanged): test-only: test harness, test support or QA lab
src/cli/update-cli-invocation.test-support.ts (registerUpdateCli): test-only: test harness, test support or QA lab
src/cli/update-cli-lifecycle.test-support.ts (runDaemonRestart): test-only: test harness, test support or QA lab
src/cli/update-cli-mocks.test-support.ts (runDaemonRestart): test-only: test harness, test support or QA lab
src/cli/update-cli-modules.test-support.ts (clearRestartSentinelIfRevision, createUpdateRun, registerUpdateCli, runDaemonRestart): test-only: test harness, test support or QA lab
src/cli/update-finalization-output.test-support.ts (registerUpdateCli): test-only: test harness, test support or QA lab
src/commands/doctor-config-preflight.legacy-driver.test-support.ts (createManagedHandoffLeaseStore, createUpdateRun, finishUpdateRun, recordUpdateRunStep): test-only: test harness, test support or QA lab
src/commands/doctor-maintenance.admission.test-support.ts (createUpdateRun, finishUpdateRun): test-only: test harness, test support or QA lab
src/commands/doctor-maintenance.settlement.test-support.ts (adoptUpdateRun, createUpdateRun, finishUpdateRun, recordUpdateDoctorRefusal, recordUpdateRunDiagnostic, recordUpdateRunPhase, recordUpdateRunRepairContinuation, recordUpdateRunStep): test-only: test harness, test support or QA lab
src/commands/doctor-session-sqlite.deferred-plugin.test-support.ts (recordDeferredPluginMigrations): test-only: test harness, test support or QA lab
src/commands/doctor.e2e-harness.test-helpers.ts (detectLegacyStateMigrations, runLegacyStateMigrations): test-only: test harness, test support or QA lab
src/commands/doctor/repair-sequencing-mocks.test-support.ts (migrateLegacyTailscaleProfileIdentities, repairMergedGatewayOwnerProfile): test-only: test harness, test support or QA lab
src/daemon/launchd-ancestry.test-support.ts (scheduleDetachedLaunchdMaintenancePark, scheduleDetachedLaunchdRestartHandoff): test-only: test harness, test support or QA lab
src/flows/doctor-health.fixture.test-support.ts (writeUpdatePostInstallDoctorResult): test-only: test harness, test support or QA lab
src/flows/doctor-health.test-support.ts (maybeOfferUpdateBeforeDoctor, writeUpdatePostInstallDoctorResult): test-only: test harness, test support or QA lab
src/gateway/server-methods-list.test-fixtures.ts (gateway.restart.preflight, gateway.restart.request, update.hold, update.run, update.status): test-only: test harness, test support or QA lab
src/gateway/server-plugin-reload.transcripts.test-support.ts (createGatewayUpdateCheck): test-only: test harness, test support or QA lab
src/gateway/server-startup-background.test-support.ts (prepareLatestUpdateRestartSentinel, startUpdateRunWatcher): test-only: test harness, test support or QA lab
src/gateway/server-startup-session-migration.test-support.ts (prepareGatewayStartupSessions): test-only: test harness, test support or QA lab
src/gateway/server.update-history.test-support.ts (createUpdateRun, update.runs.get, update.runs.list): test-only: test harness, test support or QA lab
src/gateway/test-helpers.server-lifecycle.ts (resetGatewayRestartStateForInProcessRestart, setGatewayRestartPolicy, setPreRestartDeferralCheck): test-only: test harness, test support or QA lab
ui/src/test-helpers/control-ui-e2e-defaults.ts (update.hold, update.run, update.runs.get, update.runs.list, update.status): test-only: test harness, test support or QA lab
openclaw gateway restart-handoff: command group only; its capabilities and consume subcommands are listed

## Search list gaps
Writer functions of this area that the input file's `search.symbols` lacks, reported by either run for the next revision of the input file; they were not searched for.
- completePendingPackageLifecycle: called from src/index.ts (the pending package lifecycle completion startup hook's own call site)
- requestManagedServiceUpdateHandoffPark: called from src/cli/gateway-cli/lifecycle.runtime.ts, src/cli/gateway-cli/run-loop.ts
- captureForegroundUpdateHandoffStop, completeForegroundUpdateHandoffAfterClose: called from src/cli/gateway-cli/lifecycle.runtime.ts
- finishDaemonUpdateRun, prepareManagedUpdateRequesterIdentity: called from src/cli/daemon-cli.ts
- runGatewayServiceUpdateCommand: called from src/cli/daemon-cli/register-service-commands.ts
- startGatewayRestartTrace, captureGatewayRestartTraceHandoff, createGatewayRestartTraceHandoffEnv: called from src/cli/gateway-cli/run-loop.ts
- resumeGatewayRestartTraceFromEnv, resumeGatewayRestartTraceFromHandoff, migrateLegacyDesktopStreamOptOuts: called from src/gateway/server-startup-bootstrap.ts
- finishGatewayRestartTrace: called from src/gateway/server-startup-finish.ts
- createGatewayRestartDeadline: called from src/cli/daemon-cli/diagnostic-readiness.ts, src/cli/daemon-cli/start-health.ts
- createUpdateFailureFact: called from src/commands/doctor-agent-lease-refusal.ts, src/commands/doctor-maintenance-stale-service.ts, src/commands/doctor-maintenance.ts
- createUpdateRunAdmissionReader: called from src/commands/doctor-maintenance-admission.ts
- completeDoctorMigrationBackups: called from src/commands/doctor-maintenance-inspection.ts
- migrateLegacyExecApprovals, migrateLegacyMediaPersistence, noteDoctorMigrationResult, prepareLegacyStateDatabaseSchema: called from src/commands/doctor-config-preflight.ts, src/commands/doctor-agent-deletion-journal.ts
- prepareLegacyStateDirMigration: called from src/commands/doctor-maintenance-state.ts
- prepareCanonicalTranscriptArchiveMigrations: called from src/flows/doctor-health.ts
- preparePostSessionPluginMigration: called from src/commands/doctor/shared/config-migration-result.ts
- repairCronCodexModelRefsAfterConfigWrite: called from src/flows/doctor-health-contribution-runners.config.ts
- repairOperatorApprovalSchema: called from src/state/openclaw-state-db-repair.ts
- migrateOrphanedSessionKeys: called from src/cli/deps.ts
- runGatewaySessionStartupMaintenance: called from src/gateway/server-agent-database-startup.ts, src/gateway/server-startup-plugins.ts
- runLegacyMigrationPlans, createLegacyPrivateNetworkDoctorContract, migrateLegacyFlatAllowPrivateNetworkAlias: called from src/plugin-sdk/doctor-migration-plan-adapter.ts, src/plugin-sdk/runtime-doctor-migrations.ts, src/plugin-sdk/ssrf-policy.ts, src/plugin-sdk/ssrf-runtime.ts, extensions/tlon/src/doctor-contract.ts
- createLegacyAuditDatabaseWitness: called from src/infra/backup-sqlite-snapshot.ts
- createManagedHandoffBootIdentityReader: called from src/infra/gateway-lock-payload.ts
- createApplicationUpdateOverlays, createUpdateStatusRefresher, createUpdateProgressWatcher: called from ui/src/app/overlays.ts, ui/src/app/overlays-types.ts, ui/src/app/app-shell-view-callbacks.ts
- `finishGatewayRestartTrace` (src/gateway/restart-trace.ts), used by src/gateway/server-startup-finish.ts
- `resumeGatewayRestartTraceFromEnv` (src/gateway/restart-trace.ts), used by src/gateway/server-startup-bootstrap.ts
- `resumeGatewayRestartTraceFromHandoff` (src/gateway/restart-trace.ts), used by src/gateway/server-startup-bootstrap.ts
- `createUpdateFailureFact` (src/infra/update-failure-facts.ts), used by src/commands/doctor-agent-lease-refusal.ts and three other Doctor files
- `noteDoctorMigrationResult` (src/commands/doctor-migration-notes.ts), used by src/commands/doctor-config-preflight.ts
- `createLegacyAuditDatabaseWitness` (src/infra/state-migrations.audit-backup.ts), used by src/infra/backup-sqlite-snapshot.ts
- `createApplicationUpdateOverlays` (ui/src/app/overlays-updates.ts), used by ui/src/app/overlays.ts
- `createUpdateProgressWatcher` (ui/src/app/update-confirmation.ts), used by ui/src/app/app-shell-view-callbacks.ts

## Conditions
| # | Condition | Source | Kind | Persona trait |
| --- | --- | --- | --- | --- |
| 1 | Gateway installed as a Windows Scheduled Task (principal, elevation, schtasks and rename limits, task autostart suspension) | docs/cli/update.md "`openclaw update`"; docs/cli/update.md "Usage"; docs/cli/update.md "Native service commands during updates"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Package-manager installs"; docs/cli/update/repair-and-recovery.md "Retained updater runtime"; docs/install/update-troubleshooting.md "Doctor cannot enter maintenance during finalization"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/triage.md "Installation target and embedded handoff", "Automatic failure handoff"; docs/cli/update.md "`openclaw update`", "Usage", "Native service commands during updates"; docs/cli/update/how-updates-run.md "Validation and activation", "Restart handoff"; docs/cli/update/repair-and-recovery.md "Retained updater runtime", "`update repair`"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup"; docs/install/updating/update-methods.md "Package lifecycle and operator state" | ambient | none |
| 2 | Global npm installation under a custom prefix (prefix from ~/.npmrc, launcher-identified owner) | docs/cli/update.md "`openclaw update`"; docs/install/update-troubleshooting.md "Node and global install permissions"; docs/cli/update/how-updates-run.md "Package-manager installs"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun" | ambient | install-npm-global |
| 3 | Installation without a detected owning package tool (container image, extracted tarball, Yarn global): update recorded as skipped, Gateway left running | docs/cli/update.md "`openclaw update`"; docs/cli/update/repair-and-recovery.md "`update repair`" | ambient | install-tarball-extracted |
| 4 | Unrecognized installation root: target preflight skipped, commands to locate the owner printed | docs/cli/update.md "`openclaw update`" | ambient | install-tarball-extracted |
| 5 | Installed updater older than the candidate: fixes in the candidate do not apply to the first hop | docs/cli/update.md "`openclaw update`"; docs/cli/update.md "Candidate-owned admission"; docs/cli/update.md "Native service commands during updates"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Recovery limits"; docs/cli/update/repair-and-recovery.md "Retained updater runtime"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/update-methods.md "Package lifecycle and operator state"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/update.md "`openclaw update`", "Usage", "Candidate-owned admission", "Options"; docs/cli/update/how-updates-run.md "Validation and activation", "Recovery limits", "Restart handoff"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/install/updating/rollback-and-recovery.md "Before you upgrade" | ambient | install-npm-global |
| 6 | Invalid configuration at update admission (invalid-config before schema inspection, invalid fields listed, dry run keeps guidance in notes) | docs/cli/update.md "Usage"; docs/cli/update.md "Options"; docs/cli/update.md "Usage", "Options" | ambient | config-invalid-field |
| 7 | Unreadable configuration file (config-read-failed with filesystem code) | docs/cli/update.md "Usage"; docs/cli/update.md "Usage", "Options" | ambient | config-invalid-field |
| 8 | Selected target equals the installed version and build: no-op after validation, plugin convergence still runs, skipped already-current | docs/cli/update.md "Usage"; docs/cli/update.md "Candidate-owned admission"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Update steps"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update.md "Usage", "Candidate-owned admission"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps" | ambient | none |
| 9 | Legacy config fields while switching channel: Doctor prepares a read-only projection bound to the original bytes | docs/cli/update.md "Usage"; docs/cli/update.md "Usage", "Candidate-owned admission"; docs/gateway/doctor/config-migrations.md "Runtime config migration", "Checks 0-2" | ambient | config-hand-edited |
| 10 | Retired provider-level contextTokens and contextWindow, Copilot discovery.enabled migrated | docs/gateway/doctor/config-migrations.md "Runtime config migration"; docs/gateway/doctor/config-migrations.md "Checks 0-2"; docs/cli/update.md "Usage", "Candidate-owned admission"; docs/gateway/doctor/config-migrations.md "Runtime config migration", "Checks 0-2" | ambient | config-hand-edited |
| 11 | Managed service runs under another profile than the caller: caller and service projections stay separate | docs/cli/update.md "Usage" | ambient | none |
| 12 | A saved config failure from an earlier failed update, followed by a later success | docs/cli/update.md "Usage" | ambient | update-history-failed |
| 13 | Older updater reports database-schema-preflight with mode unknown (2026.9.4) | docs/cli/update.md "Usage" | ambient | none |
| 14 | Configured plugins.load.paths directory missing: admission warning, configured-plugin-path-unavailable, update continues | docs/cli/update.md "Usage"; docs/cli/update.md "Candidate-owned admission"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/update-troubleshooting.md "Plugin repair warnings"; docs/cli/update.md "Usage", "Candidate-owned admission" | ambient | state-legacy-migratable |
| 15 | Older updater refuses before staging with plugins.load.paths: plugin path not found | docs/cli/update.md "Usage"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update.md "Usage", "Candidate-owned admission"; docs/install/update-troubleshooting.md "Plugin repair warnings" | ambient | state-legacy-migratable |
| 16 | Orphan task_delivery_state rows: admission runs preservation-first recovery, refused under a live Gateway owner | docs/cli/update.md "Usage"; docs/reference/database-schemas/integrity-and-recovery.md "Doctor reports orphan task delivery rows" | ambient | store-orphan-delivery-rows |
| 17 | A failed update or repair attempt enters recovery triage after service recovery and cleanup | docs/cli/update.md "Usage"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/install/update-troubleshooting.md "(intro)"; docs/install/update-troubleshooting.md "(introduction)" | event | none |
| 18 | Cleanup cannot confirm admitted work stopped: ownership and recovery artifacts retained, pending execution | docs/cli/update.md "Usage"; docs/cli/update/repair-and-recovery.md "`update repair`" | ambient | none |
| 19 | Another Doctor holds a native command claim: recorded as foreign custody, installation replacement blocked | docs/cli/update.md "Usage" | ambient | none |
| 20 | Verified automatic rollback leaves the previous generation running; no automatic triage, nonzero exit | docs/cli/update.md "Usage"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/cli/update/how-updates-run.md "Compatibility-checked package rollback"; docs/gateway/restart-recovery.md "Recovery after a failed update" | event | none |
| 21 | Late Git verification failure restores configuration, source and runtime and restarts the verified service | docs/cli/update/how-updates-run.md "Update steps"; docs/cli/update.md "Usage"; docs/cli/update/how-updates-run.md "Compatibility-checked package rollback"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/install/updating/update-methods.md "Switch between npm and git installs" | event | install-git-checkout |
| 22 | Interactive failure menu after a failed update (Diagnose, Report, Report in browser, Check report status, Exit by default) | docs/cli/update.md "Usage"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback" | event | none |
| 23 | GitHub CLI missing or unauthenticated when reporting: sanitized report kept locally, back to the menu | docs/cli/update.md "Usage"; docs/install/update-troubleshooting.md "(intro)"; docs/install/update-troubleshooting.md "(introduction)" | ambient | none |
| 24 | Uncertain report upload pending: Check report status, no browser handoff | docs/cli/update.md "Usage"; docs/install/update-troubleshooting.md "(intro)"; docs/install/update-troubleshooting.md "(introduction)" | ambient | none |
| 25 | Retained worker close exceeds the ten-second exit grace: warning, retained runtime kept | docs/cli/update.md "Usage"; docs/cli/update/repair-and-recovery.md "`update repair`" | event | none |
| 26 | CLI invoked from a working directory inside the installation being replaced | docs/cli/update.md "Usage" | ambient | install-npm-global |
| 27 | Dashboard update fails while the Gateway handles the request: Gateway warning log with the public reason | docs/cli/update.md "Usage" | event | none |
| 28 | Interrupted pre-create report preparation becomes retryable after its reservation expires | docs/cli/update.md "Usage"; docs/install/update-troubleshooting.md "(intro)" | event | none |
| 29 | Unexpected exception in an admitted update retains error identity, step and facts in history | docs/cli/update.md "Usage"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 30 | Managed child refuses before service parking: serving Gateway untouched, refusal kept in history | docs/cli/update.md "Usage"; docs/cli/update/status-and-history.md "Run history and reports"; docs/install/update-troubleshooting.md "(introduction)" | event | none |
| 31 | Managed child produces no usable result: managed-service-handoff-failed | docs/cli/update.md "Usage"; docs/cli/update/how-updates-run.md "Control-plane response shape"; docs/install/update-troubleshooting.md "(intro)"; docs/cli/update/status-and-history.md "Run history and reports"; docs/install/update-troubleshooting.md "(introduction)" | event | none |
| 32 | Retained activation with update-recovery-pending: exact recovery command followed | docs/cli/update.md "Usage"; docs/cli/update/status-and-history.md "Run history and reports"; docs/install/update-troubleshooting.md "(introduction)" | ambient | update-history-stale |
| 33 | npm install fails with EACCES or EPERM on the global prefix (global-install-permission-denied, sanitized npm lines) | docs/cli/update.md "Usage"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/update-troubleshooting.md "Node and global install permissions"; docs/install/update-troubleshooting.md "Reason codes"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/cli/update/status-and-history.md "Run history and reports" | event | install-npm-global |
| 34 | npm install fails with ENOSPC on the prefix or cache volume | docs/cli/update.md "Usage"; docs/cli/update/status-and-history.md "Run history and reports"; docs/install/update-troubleshooting.md "Reason codes" | event | install-npm-global |
| 35 | Registry lacks the requested version or tag (E404, ETARGET, EINTEGRITY; stale-cache retry) | docs/cli/update.md "Usage"; docs/install/update-troubleshooting.md "Reason codes"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 36 | Confirmed ENOSPC during dev staging: preflight-insufficient-space | docs/cli/update/how-updates-run.md "Update steps"; docs/install/update-troubleshooting.md "Reason codes"; docs/cli/update.md "Usage"; docs/cli/update/status-and-history.md "Run history and reports" | event | install-git-checkout |
| 37 | Adopted immutable release installation (preparation-only or activation enabled) | docs/cli/update.md "Immutable release installations"; docs/cli/update/status-and-history.md "`update status`" | ambient | none |
| 38 | Immutable drain under committed Gateway suspension; expired or resumed suspension refuses the handoff | docs/cli/update.md "Immutable release installations" | event | none |
| 39 | Immutable activation failure restores the sealed predecessor; inconclusive check stays pending | docs/cli/update.md "Immutable release installations" | event | none |
| 40 | Immutable updater interrupted after shutdown commits; recovery observes the supervisor first | docs/cli/update.md "Immutable release installations" | event | none |
| 41 | Immutable target with incompatible migration requirements refused before drain | docs/cli/update.md "Immutable release installations" | ambient | none |
| 42 | Hot SQLite rollback journal left in the installation control after an updater crash | docs/cli/update.md "Immutable release installations" | ambient | none |
| 43 | Candidate refuses or fails before mutation: stage removed, installed package and Gateway kept | docs/cli/update.md "Candidate-owned admission" | event | none |
| 44 | Linux OverlayFS installation: retained worker files use private copies | docs/cli/update.md "Candidate-owned admission"; docs/cli/update/repair-and-recovery.md "Retained updater runtime", "Docker image-layer package updates" | ambient | none |
| 45 | Container or filesystem refuses file cloning (Proxmox LXC FICLONE): guarded byte-copy fallback | docs/cli/update/repair-and-recovery.md "Retained updater runtime"; docs/cli/update.md "Candidate-owned admission"; docs/cli/update/repair-and-recovery.md "Retained updater runtime", "Docker image-layer package updates" | ambient | none |
| 46 | Docker OverlayFS rejects moving an image-layer package (EXDEV): verified copy fallback | docs/cli/update/repair-and-recovery.md "Docker image-layer package updates"; docs/cli/update.md "Candidate-owned admission"; docs/cli/update/repair-and-recovery.md "Retained updater runtime", "Docker image-layer package updates" | ambient | none |
| 47 | Retained runtime projections awaiting cleanup by the next update or doctor --fix | docs/cli/update.md "Candidate-owned admission"; docs/cli/update/repair-and-recovery.md "Retained updater runtime" | ambient | none |
| 48 | Retained .openclaw.package-backup-* link to a source checkout makes an older updater refuse with a plugin-link error | docs/cli/update.md "Candidate-owned admission" | ambient | none |
| 49 | Candidate without the admission marker or with a failing admission process: installed checks used with a warning | docs/cli/update.md "Candidate-owned admission"; docs/install/updating.md "Recommended: `openclaw update`" | event | none |
| 50 | Legacy plugin configuration (Discord dm.policy) admitted with a warning when the candidate planner repairs it | docs/cli/update.md "Candidate-owned admission" | ambient | config-hand-edited |
| 51 | Update history at its 128-step or 16 KiB compaction limit | docs/cli/update.md "Candidate-owned admission" | ambient | update-history-long |
| 52 | Update run with non-terminal stdin: confirmations fail promptly, menus and consent do not wait | docs/cli/update.md "Automation and SSH"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/cli/update.md "Automation and SSH", "Options" | ambient | none |
| 53 | Piped or captured output: progress without animation, elapsed time every 30 seconds | docs/cli/update.md "Options"; docs/cli/update.md "Automation and SSH", "Options"; docs/cli/update/repair-and-recovery.md "Recover a failed update" | ambient | none |
| 54 | An active chat session does not block an explicit update | docs/cli/update.md "Automation and SSH" | ambient | mock-provider-held-turn |
| 55 | Updater-owned native service command still alive: new update excluded; owner exit or lost lease stops its mutation | docs/cli/update.md "Native service commands during updates" | ambient | none |
| 56 | Target runtime without ownership handoff support refused before stopping the Gateway | docs/cli/update.md "Native service commands during updates"; docs/cli/update/how-updates-run.md "Update validation and service definitions"; docs/install/updating/update-methods.md "Switch between npm and git installs" | ambient | none |
| 57 | Definition write authority sealed or unverified, or target lacks --preserve-definition: activation rejected, service may stay stopped | docs/cli/update/how-updates-run.md "Update validation and service definitions"; docs/cli/update.md "Native service commands during updates"; docs/install/updating/update-methods.md "Switch between npm and git installs" | ambient | none |
| 58 | Obsolete package and launcher backups cleanup exceeds its five-minute budget: remaining backups retained with a warning | docs/cli/update.md "Options"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 59 | Historical package backups present: a later verified activation retires them; failures preserve them | docs/cli/update.md "Options"; docs/cli/update/status-and-history.md "Run history and reports" | ambient | install-npm-global |
| 60 | Aggregate activation deadline expires: update-activation-timeout, ownership retained until writers settle | docs/cli/update.md "Options"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 61 | No usable model authentication: update, verification and rollback proceed; auth findings stay warnings | docs/cli/update.md "Options"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating/rollback-and-recovery.md "Unattended repair on your own inference"; docs/cli/triage.md "Installation target and embedded handoff"; docs/install/update-troubleshooting.md "(introduction)" | ambient | none |
| 62 | Unavailable inference for embedded repair: external handoff, no login prompt | docs/install/updating/rollback-and-recovery.md "Unattended repair on your own inference"; docs/cli/triage.md "Installation target and embedded handoff"; docs/cli/update.md "Options"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "(introduction)" | ambient | none |
| 63 | No update active: status labels the saved outcome Last recorded update | docs/cli/update.md "Options" | ambient | update-history-failed |
| 64 | Switching from a dev checkout to a package: failed activation leaves recovery unverified, no automatic restart | docs/cli/update.md "Options" | event | install-git-checkout |
| 65 | Profile without a runtime database: older npm target initializes state, fresh-profile dry run records nothing | docs/cli/update.md "Options"; docs/cli/update/status-and-history.md "Run history and reports"; docs/cli/update.md "`openclaw update`", "Options" | ambient | none |
| 66 | Registered custom agent store incompatible with the target: named before any change | docs/cli/update.md "Options"; docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | agents-three-configured |
| 67 | State newer than the updater can read: install-compatible-build or restore-backup refusal | docs/cli/update.md "Options"; docs/reference/database-schemas/versioning.md "Versioning contract" | ambient | none |
| 68 | No compatible Node for the target: dry run reports Would refuse update or Would replace; node-runtime-preflight | docs/cli/update.md "Options"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/update-troubleshooting.md "Node and global install permissions"; docs/cli/update/how-updates-run.md "Node runtime for package-manager updates"; docs/install/updating/rollback-and-recovery.md "Before you upgrade" | ambient | none |
| 69 | Service Node cannot run the target while the CLI Node can: service metadata rewritten; --no-restart stops before mutation | docs/cli/update/how-updates-run.md "Node runtime for package-manager updates"; docs/install/update-troubleshooting.md "Node and global install permissions"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/rollback-and-recovery.md "Before you upgrade" | ambient | none |
| 70 | Package metadata cannot be resolved (registry lookup, dist-tag, version mismatch, schema declaration) | docs/cli/update.md "Options" | event | none |
| 71 | Saved update.channel keeps governing later updates after a one-off --tag | docs/cli/update.md "Options"; docs/install/updating.md "Package-publication recovery"; docs/install/development-channels.md "One-off version or tag targeting" | ambient | none |
| 72 | Source checkout with uncommitted changes: clean check fails before installation, checkout preserved (dirty) | docs/cli/update.md "Options"; docs/cli/update/how-updates-run.md "Update steps"; docs/install/update-troubleshooting.md "Reason codes" | ambient | checkout-dirty |
| 73 | Nix mode (OPENCLAW_NIX_MODE=1): mutating updates disabled, status read-only | docs/cli/update.md "Options" | ambient | none |
| 74 | Target older than the installed version: downgrade confirmation required | docs/cli/update.md "Options"; docs/cli/update.md "Automation and SSH"; docs/install/development-channels.md "One-off version or tag targeting"; docs/install/updating/rollback-and-recovery.md "Downgrade"; docs/install/development-channels.md "One-off version or tag targeting", "Dry run"; docs/reference/database-schemas/integrity-and-recovery.md "Why you cannot go back after updating to 2026.7.2", "Downgrade recovery" | ambient | none |
| 75 | dev channel ensures a Git checkout at the default or OPENCLAW_GIT_DIR location | docs/cli/update/how-updates-run.md "What it does"; docs/install/development-channels.md "Switching channels"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/install/development-channels.md "(introduction)", "Switching channels"; docs/install/updating.md "Package-publication recovery"; docs/install/updating/automatic-updates.md "Auto-updater" | ambient | install-git-checkout |
| 76 | beta dist-tag missing or older than stable: beta falls back to latest | docs/cli/update/how-updates-run.md "What it does"; docs/install/development-channels.md "(intro)"; docs/install/updating.md "Package-publication recovery"; docs/install/development-channels.md "(introduction)", "Switching channels"; docs/install/updating/automatic-updates.md "Auto-updater" | ambient | none |
| 77 | Git directory replaced during fresh clone validation: update stops without changing the replacement | docs/cli/update/how-updates-run.md "What it does" | event | none |
| 78 | Channel health collection times out during post-update verification: warning kept, explicit negative probe fails | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | channels-test-accounts |
| 79 | Git checkout advanced without rebuilding, or runtime artifacts missing: update still needed | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating/update-methods.md "Source-checkout servers (reference script)" | ambient | install-git-checkout |
| 80 | --no-restart cannot replace runtime files used by a running Gateway; process and retry action reported | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Validation and activation", "When restart is skipped or fails" | event | none |
| 81 | Another Gateway shares this installation: its separate state needs doctor --fix under its own account | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Update steps"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/install/updating/update-methods.md "Source-checkout servers (reference script)"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps"; docs/install/updating/update-methods.md "Switch between npm and git installs", "Source-checkout servers (reference script)" | ambient | gateway-second-instance |
| 82 | Live sibling Gateway uses overlapping output paths: runtime completion refused | docs/cli/update/how-updates-run.md "Update steps"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps"; docs/install/updating/update-methods.md "Switch between npm and git installs", "Source-checkout servers (reference script)" | ambient | gateway-second-instance |
| 83 | Source command through pnpm openclaw refuses an automatic rebuild while the Gateway runs | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | install-git-checkout |
| 84 | Outdated OpenClaw-managed systemd policy refreshed without stopping the Gateway; operator drop-ins preserved | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Update validation and service definitions"; docs/gateway/restart-recovery.md "Graceful restarts drain first"; docs/gateway/restart-recovery.md "Systemd stop deadlines"; docs/cli/update/how-updates-run.md "Validation and activation", "Update validation and service definitions"; docs/gateway/restart-recovery.md "Graceful restarts drain first", "Systemd stop deadlines", "Launchd stop deadlines" | ambient | service-definition-outdated |
| 85 | Writable managed service definition stale: finalization backs it up and repairs recognized policy | docs/cli/update/how-updates-run.md "Update validation and service definitions"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update/how-updates-run.md "Validation and activation", "Update validation and service definitions"; docs/gateway/restart-recovery.md "Graceful restarts drain first", "Systemd stop deadlines", "Launchd stop deadlines" | ambient | service-definition-outdated |
| 86 | Maintenance stop drains active turns until idle or the step deadline; remaining turns interrupted with a warning; write custody refuses the stop | docs/cli/update/how-updates-run.md "Validation and activation"; docs/gateway/restart-recovery.md "Graceful restarts drain first"; docs/gateway/restart-recovery.md "Maintenance custody observations"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/update.md "Automation and SSH"; docs/gateway/restart-recovery.md "Graceful restarts drain first", "Verify recovery after an update"; docs/gateway/restart-recovery.md "Systemd stop deadlines"; docs/install/updating/automatic-updates.md "Update campaigns" | event | mock-provider-held-turn |
| 87 | Active work present when a restart is requested: the Gateway drains it up to the drain budget | docs/gateway/restart-recovery.md "Graceful restarts drain first"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/update.md "Automation and SSH"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/gateway/restart-recovery.md "Graceful restarts drain first", "Verify recovery after an update"; docs/gateway/restart-recovery.md "Maintenance custody observations"; docs/gateway/restart-recovery.md "Systemd stop deadlines"; docs/install/updating/automatic-updates.md "Update campaigns" | ambient | mock-provider-held-turn |
| 88 | Work beyond the drain budget aborted and marked for recovery | docs/gateway/restart-recovery.md "Systemd stop deadlines"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/update.md "Automation and SSH"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/gateway/restart-recovery.md "Graceful restarts drain first", "Verify recovery after an update"; docs/gateway/restart-recovery.md "Maintenance custody observations"; docs/install/updating/automatic-updates.md "Update campaigns" | event | mock-provider-held-turn |
| 89 | Replaced Gateway rejects connections because its runtime files are gone: stopped through its service owner | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 90 | Paired operator identity only (no shared token): maintenance drain uses it without new pairing | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | cli-profile-paired |
| 91 | Explicit package artifact with the same version: build identity compared before the no-op | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Recommended: `openclaw update`" | ambient | none |
| 92 | Validation-copy cleanup, derived-cache cleanup or Git upstream tracking fails: update continues with warnings | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 93 | Linux user-service supervisor inspection times out: one retry, second timeout leaves the Gateway running | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 94 | Service inspection unavailable or service record stale: managed-service warning, record cannot select package, Node or state | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Linux without a service manager"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update/how-updates-run.md "Validation and activation", "Linux without a service manager"; docs/install/updating/rollback-and-recovery.md "Before you upgrade" | ambient | none |
| 95 | Linux without a service supervisor: update proceeds when no lock or listener; nothing to restart | docs/cli/update/how-updates-run.md "Linux without a service manager"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update/how-updates-run.md "Validation and activation", "Linux without a service manager"; docs/install/updating/rollback-and-recovery.md "Before you upgrade" | ambient | none |
| 96 | Baseline package fingerprint scan hits its budget or size limit: warning, rollback verifies identity only | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "Reason codes" | ambient | none |
| 97 | Package tree over the scan limits (500,000 entries or 8 GiB; older supervisors 50,000 or 1 GiB) | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "Reason codes" | ambient | none |
| 98 | Sibling .openclaw.update-stage-* directories from another or interrupted updater | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Package-manager installs"; docs/cli/update/how-updates-run.md "Package-manager installs", "Validation and activation" | ambient | none |
| 99 | Equivalent launcher recreated keeps recovery; changed symlink target refuses the swap | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating/rollback-and-recovery.md "Downgrade" | event | none |
| 100 | npm prefix parents owned by another UID: ownership refusal names object, UID and expected UID | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "Node and global install permissions" | ambient | none |
| 101 | Node version switcher switched the shell prefix: global-install-foreign-destination unless the original prefix is kept | docs/install/update-troubleshooting.md "Node and global install permissions"; docs/cli/update/how-updates-run.md "Validation and activation" | ambient | none |
| 102 | Other package tools or tools modify the installation during an update | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Package-publication recovery" | event | none |
| 103 | Fresh local update interrupted before activation: failed interrupted entry, owner held | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/status-and-history.md "Run history and reports" | event | install-npm-global |
| 104 | SIGINT, SIGTERM or SIGHUP during activation or verification: forward work stops, recovery owner restores and reports; SIGKILL needs explicit recovery | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "CLI fallback" | event | install-npm-global |
| 105 | Target Doctor migrated shared state: candidate runtime owns finalization, code-only rollback prohibited | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/status-and-history.md "Run history and reports"; docs/cli/update/how-updates-run.md "Recovery limits"; docs/cli/update/how-updates-run.md "Validation and activation", "Recovery limits"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup", "Automatic schema-neutral rollback" | ambient | session-main-rolling |
| 106 | Database writes during Doctor maintenance: automatic restoration refused, state-migrated-no-rollback, manual recovery | docs/cli/update/how-updates-run.md "Recovery limits"; docs/cli/update/how-updates-run.md "Compatibility-checked package rollback"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/cli/update/how-updates-run.md "Validation and activation", "Recovery limits"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup", "Automatic schema-neutral rollback" | event | session-main-rolling |
| 107 | Git Doctor fails after a database snapshot: snapshots restore pre-migration state; later writes keep the migrated installation | docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/cli/update/how-updates-run.md "Recovery limits"; docs/cli/update/how-updates-run.md "Validation and activation", "Recovery limits"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup", "Automatic schema-neutral rollback" | event | session-main-rolling |
| 108 | Old Gateway keeps serving through staging and validation while a canary boots on copied state | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Recommended: `openclaw update`"; docs/gateway/restart-recovery.md "Recovery after a failed update" | ambient | mock-provider-held-turn |
| 109 | Plugin files change after snapshot inventory: snapshot refused; link-only changes accepted | docs/cli/update/how-updates-run.md "Validation and activation" | event | plugins-bundled-and-external |
| 110 | Abandoned plugin Git transaction directories (<destination>.openclaw-update-<UUID>.tmp) are skipped | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps" | ambient | none |
| 111 | Progress receipt refused at validation start: validation stops before copying | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 112 | Previous-Gateway ready check verification after the canary; expiry leaves it unverified and blocks automatic restart | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 113 | Disposable copy cleanup exceeds five minutes: warning, removal may finish in the background | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 114 | Doctor warnings during update: kept in the report, do not block ready check; unconfirmed child termination still blocks | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "Plugin repair warnings"; docs/cli/update/how-updates-run.md "Validation and activation", "Plugin sync details" | ambient | config-hand-edited |
| 115 | Old Gateway serving with a database schema older than the candidate during capability check | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | none |
| 116 | Large or busy databases: snapshot budgets scale with size, deadline extends while files change | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/update-troubleshooting.md "Database snapshots under continuous writes"; docs/install/updating/update-methods.md "Advanced npm install topics"; docs/cli/update.md "Options"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/update-troubleshooting.md "Candidate migration rehearsal timeouts" | ambient | sessions-thousands-near-cap |
| 117 | Live snapshots while writers continue (bounded WAL prefix, crash journals recovered privately) | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update.md "Options"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/update-troubleshooting.md "Candidate migration rehearsal timeouts"; docs/install/update-troubleshooting.md "Database snapshots under continuous writes" | ambient | mock-provider-held-turn |
| 118 | Candidate startup slow but progressing: milestones renew the allowance up to four times; stalled or exited candidate fails validation | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/gateway/restart-recovery.md "Recovery after a failed update" | event | sessions-thousands-near-cap |
| 119 | Candidate Doctor process or pipes stay open past the allowance: exit-phase warning or candidate-checks-timeout | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "(intro)"; docs/install/update-troubleshooting.md "(introduction)", "Candidate migration rehearsal timeouts" | event | none |
| 120 | Insufficient temporary space for snapshots: TMPDIR, capture directory, system temp; snapshot-capacity-insufficient or snapshot-location-unavailable | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Recovery limits"; docs/cli/update/how-updates-run.md "Update steps"; docs/install/updating/update-methods.md "Advanced npm install topics"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps" | event | none |
| 121 | Low disk space on the target volume: warning only, kept in history | docs/install/updating/update-methods.md "Advanced npm install topics"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps" | ambient | none |
| 122 | Install record, plugin owner or database registration changes before copy: preparation refused | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 123 | Initial config inspection meets lock contention or a changing source: one retry with a warning | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 124 | Plugin resolution error attributed to a named plugin recorded without rejecting the update | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Plugin sync details"; docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update/how-updates-run.md "Validation and activation", "Plugin sync details" | ambient | plugins-bundled-and-external |
| 125 | Plugin activation or load failures after the core checks pass are named warnings | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Plugin sync details"; docs/cli/update/how-updates-run.md "Validation and activation", "Plugin sync details"; docs/install/updating.md "Recommended: `openclaw update`" | ambient | plugins-bundled-and-external |
| 126 | Target predates migration continuation: runtime validation unavailable, no schema-neutral rollback | docs/cli/update/how-updates-run.md "Validation and activation"; docs/gateway/restart-recovery.md "Recovery after a failed update" | ambient | none |
| 127 | Blocking validation failure: staged update discarded, serving Gateway untouched | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating/rollback-and-recovery.md "Unattended repair on your own inference"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/cli/update/how-updates-run.md "Validation and activation", "Update steps" | event | none |
| 128 | New version running while verification fails: guidance uses the latest observed service state | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 129 | Failed update while the Gateway still serves: guidance names the serving version, failure stays | docs/cli/update/status-and-history.md "Run history and reports"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback" | ambient | update-history-failed |
| 130 | Startup lease ends while the same Gateway still progresses: still-starting warning, no restart or rollback | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/update/how-updates-run.md "Validation and activation", "Restart handoff"; docs/cli/update/status-and-history.md "Run history and reports" | event | sessions-thousands-near-cap |
| 131 | Ready check allowance expires for the same running process: skipped `gateway-readiness-unverified`, backups retained | docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/status-and-history.md "Run history and reports"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/cli/update/how-updates-run.md "Validation and activation", "Restart handoff" | event | sessions-thousands-near-cap |
| 132 | Process or boot generation changes during verification: failure and recovery | docs/cli/update/how-updates-run.md "Validation and activation" | event | none |
| 133 | Plugin downloads count toward downtime; service stopped through convergence | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Recommended: `openclaw update`" | ambient | plugins-bundled-and-external |
| 134 | Doctor cannot enter maintenance at finalization: service restored, warning, Doctor and plugin work pending | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "Doctor cannot enter maintenance during finalization"; docs/cli/update/repair-and-recovery.md "`update repair`" | event | none |
| 135 | Pre-migration database snapshots retained beside the package backup; capacity shortage refuses before migration | docs/cli/update/how-updates-run.md "Recovery limits"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup" | ambient | install-npm-global |
| 136 | Hard-linked database or journal files refuse before migration | docs/cli/update/how-updates-run.md "Recovery limits" | ambient | none |
| 137 | Older npm snapshot directories reported by Doctor with size and removal command | docs/cli/update/how-updates-run.md "Recovery limits"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup" | ambient | recovery-originals-retained |
| 138 | Failed candidate never allowed to start: databases restored before the package, migrated files kept as <database>.migrated-<runId> | docs/cli/update/how-updates-run.md "Recovery limits"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup" | event | none |
| 139 | Snapshots taken while a Gateway may write (--no-restart) only for manual recovery | docs/cli/update/how-updates-run.md "Recovery limits"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup" | ambient | none |
| 140 | Pending records that require checkpoint replay block mutable updates | docs/cli/update/how-updates-run.md "Recovery limits"; docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup"; docs/cli/update/how-updates-run.md "Validation and activation", "Recovery limits" | ambient | none |
| 141 | Config edited after the activation Doctor pass or $include changed: automatic rollback refused | docs/cli/update/how-updates-run.md "Compatibility-checked package rollback"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback" | event | config-include-files |
| 142 | Update fails before activation: recovery observes the existing Gateway once without restarting | docs/cli/update/how-updates-run.md "Compatibility-checked package rollback" | event | none |
| 143 | Update launched from a shell inside the managed Gateway service: detached helper, exit 75, the exec shell may be terminated | docs/cli/update/how-updates-run.md "Restart handoff"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating.md "From chat" | event | mock-provider-tool-calls |
| 144 | Service handoff records from 2026.9.2 or 2026.9.3; a different supervisor UID blocks service mutation | docs/cli/update/how-updates-run.md "Restart handoff" | ambient | none |
| 145 | Foreground Gateway without a managed service: update hints only, activation left to the operator | docs/cli/update/how-updates-run.md "Restart handoff"; docs/install/updating/automatic-updates.md "Auto-updater"; docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 146 | Foreground replacement still starting or rejected by ready check: unverified or shutdown pending | docs/cli/update/how-updates-run.md "Restart handoff"; docs/cli/triage.md "Automatic failure handoff"; docs/install/updating/automatic-updates.md "Auto-updater" | event | none |
| 147 | Chat requester's access grant revoked during staging: pending update stops, Gateway keeps serving | docs/cli/update/how-updates-run.md "Restart handoff"; docs/install/updating.md "From chat" | event | gateway-multi-user-profiles |
| 148 | OPENCLAW_NO_RESPAWN set on a foreground Gateway: update.run refused | docs/cli/update/how-updates-run.md "Restart handoff"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/gateway/restart-recovery.md "Systemd stop deadlines" | ambient | none |
| 149 | Pinned Git update leaves the checkout detached; receipt preserves the upstream | docs/cli/update/how-updates-run.md "Restart handoff" | ambient | install-git-checkout |
| 150 | Stopping a Gateway during helper startup, staging or activation waits for update work; draining if cleanup is uncertain | docs/cli/update/how-updates-run.md "Restart handoff" | event | none |
| 151 | Stored extended-stable channel: read-only startup and 24-hour hints, never applied automatically | docs/cli/update/how-updates-run.md "Restart handoff"; docs/install/updating/automatic-updates.md "Auto-updater"; docs/install/updating/automatic-updates.md "Headless node updates"; docs/install/development-channels.md "(intro)"; docs/install/development-channels.md "(introduction)"; docs/install/updating/automatic-updates.md "Auto-updater", "Update campaigns", "Headless node updates" | ambient | none |
| 152 | Shell installer service refresh denied: code installed, service untouched | docs/cli/update/how-updates-run.md "Shell installers" | event | none |
| 153 | LaunchAgent installed but not supervised: re-bootstrapped after the update | docs/cli/update/how-updates-run.md "macOS LaunchAgent verification"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/gateway/restart-recovery.md "Recovery after a failed update" | ambient | none |
| 154 | Restart cannot run after an update: restart skipped or failed guidance | docs/cli/update/how-updates-run.md "When restart is skipped or fails"; docs/install/update-troubleshooting.md "Reason codes" | event | none |
| 155 | Running Gateway detects its installation was replaced and exits or drains for its owner | docs/cli/update/how-updates-run.md "When restart is skipped or fails"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/install/update-troubleshooting.md "System-scope systemd services"; docs/cli/update/status-and-history.md "`update status`" | event | install-npm-global |
| 156 | Last shutdown recorded an installation replacement (lastGatewayInstallationReplacement) | docs/cli/update/status-and-history.md "`update status`"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/cli/update/how-updates-run.md "When restart is skipped or fails" | ambient | install-npm-global |
| 157 | Updater-owned Doctor waits for a foreground Gateway to release state | docs/cli/update/how-updates-run.md "When restart is skipped or fails" | event | none |
| 158 | Active Gateway suspension: installation watcher does not restart during preparing, draining or prepared | docs/cli/update/how-updates-run.md "When restart is skipped or fails"; docs/gateway/restart-recovery.md "Host sleep and process freezes" | ambient | none |
| 159 | Package already replaced and Doctor failed on the live Gateway lock: repair from the updated installation | docs/cli/update/how-updates-run.md "When restart is skipped or fails" | event | install-npm-global |
| 160 | update.run without a supervising service boundary: managed-service-handoff-unavailable with a shell command | docs/cli/update/how-updates-run.md "Control-plane response shape"; docs/install/update-troubleshooting.md "(introduction)"; docs/install/updating/automatic-updates.md "Update campaigns" | ambient | none |
| 161 | Managed-service handoff failure kinds (spawn, permission, ownership, payload, timeout, early exit, preparation) | docs/install/update-troubleshooting.md "(intro)"; docs/cli/update/how-updates-run.md "Control-plane response shape"; docs/install/update-troubleshooting.md "(introduction)"; docs/install/updating/automatic-updates.md "Update campaigns" | event | none |
| 162 | Restart sentinel pending with restart-health-pending until the CLI rewrites it; status shows an Update restart row | docs/cli/update/how-updates-run.md "Control-plane response shape"; docs/gateway/troubleshooting/updates-and-rollbacks.md "After an update"; docs/gateway/restart-recovery.md "What survives a restart" | ambient | none |
| 163 | Git checkout on stable or beta selects the release tag; extended-stable unsupported for checkouts | docs/cli/update/how-updates-run.md "Channel selection"; docs/install/development-channels.md "Switching channels"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/cli/update.md "Related"; docs/cli/update/how-updates-run.md "Git checkout flow", "Channel selection"; docs/cli/update/how-updates-run.md "What it does", "Channel selection"; docs/gateway/doctor/config-migrations.md "Checks 0-2" | ambient | install-git-checkout |
| 164 | Interactive Doctor in a Git checkout offers to update first | docs/gateway/doctor/config-migrations.md "Checks 0-2"; docs/cli/update.md "Related"; docs/cli/update/how-updates-run.md "Git checkout flow", "Channel selection"; docs/cli/update/how-updates-run.md "What it does", "Channel selection"; docs/install/development-channels.md "Switching channels" | ambient | install-git-checkout |
| 165 | Configured tracking remote fetch fails (fetch-failed); unrelated remote unavailable only warns | docs/cli/update/how-updates-run.md "Update steps"; docs/cli/update/status-and-history.md "Run history and reports"; docs/install/development-channels.md "Checking current status" | event | install-git-checkout |
| 166 | Shallow or partial checkout: missing objects hydrated privately, ahead/behind unavailable without a merge base | docs/cli/update/how-updates-run.md "Update steps"; docs/cli/update/status-and-history.md "`update status`" | ambient | install-git-checkout |
| 167 | Git pack above 256 MiB: size warning, capacity refusal when the object volume is short | docs/cli/update/how-updates-run.md "Update steps" | ambient | none |
| 168 | Newest dev commit does not build: up to ten commits walked back | docs/cli/update/how-updates-run.md "Update steps" | event | install-git-checkout |
| 169 | pnpm bootstrap through corepack fails: tool-specific early error | docs/cli/update/how-updates-run.md "Update steps"; docs/install/updating/rollback-and-recovery.md "If you are stuck" | ambient | none |
| 170 | Another worktree holds the original branch or the reflog is unusable during Git rollback | docs/cli/update/how-updates-run.md "Update steps" | ambient | install-git-checkout |
| 171 | Restoring the previous Git runtime fails: Gateway stays stopped, originals in <runtime>.openclaw-update-<id>.tmp/previous | docs/cli/update/how-updates-run.md "Update steps"; docs/cli/update/how-updates-run.md "Compatibility-checked package rollback", "Update steps" | event | none |
| 172 | Changed plugin snapshot or deferred model retirement runs fresh Doctor repairs before restart | docs/cli/update/how-updates-run.md "Update steps"; docs/install/updating.md "Recommended: `openclaw update`"; docs/gateway/doctor/config-migrations.md "Checks 0-2" | ambient | plugins-bundled-and-external |
| 173 | Configured official plugin without an install record repaired from the release cohort | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/cli/update/repair-and-recovery.md "`update repair`" | ambient | plugin-record-missing |
| 174 | Managed release pin resumes the catalog default; pins outside eligibility kept with a pin advisory | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/install/updating.md "Package-publication recovery"; docs/install/development-channels.md "Plugins and channels" | ambient | plugin-pin-outdated |
| 175 | Beta channel plugins pick newest of beta and latest; ClawHub @beta unavailable falls back with a warning | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/install/development-channels.md "Plugins and channels"; docs/install/updating.md "Package-publication recovery" | ambient | plugins-bundled-and-external |
| 176 | Plugin npm target unavailable or registry unreachable: plugin-target-unavailable advisory, core update continues | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/update-troubleshooting.md "Reason codes" | event | plugins-bundled-and-external |
| 177 | Plugin compatibility range excludes the target core: named notice, plugin unavailable until compatible | docs/cli/update/how-updates-run.md "Plugin sync details" | ambient | plugin-compat-excluded |
| 178 | Pinned npm plugin artifact integrity differs from its record: that plugin update aborted | docs/cli/update/how-updates-run.md "Plugin sync details" | event | plugins-bundled-and-external |
| 179 | Invalid plugin manifest or missing payload: per-plugin warning; invalid config snapshot fails the update | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/install/update-troubleshooting.md "Plugin repair warnings"; docs/cli/update/repair-and-recovery.md "`update repair`" | ambient | plugin-payload-missing |
| 180 | Throwing plugin config-repair hook keeps its input and names the plugin | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/gateway/doctor/config-migrations.md "(intro)"; docs/install/update-troubleshooting.md "Plugin repair warnings"; docs/gateway/doctor/config-migrations.md "(introduction)" | event | plugins-bundled-and-external |
| 181 | Extended-stable core: official plugins target the exact installed core version | docs/cli/update/how-updates-run.md "Plugin sync details"; docs/install/updating.md "Package-publication recovery"; docs/install/development-channels.md "Plugins and channels" | ambient | plugins-bundled-and-external |
| 182 | pnpm or Bun owned global project changes concurrently: activation stops; rollback-project-changed | docs/cli/update/how-updates-run.md "Package-manager installs"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/bun-compatibility.md "Bun-only installs"; docs/install/bun-compatibility.md "Bun-only installs", "SQLite library selection on macOS", "Known limitations", "SQLite worker lifecycle"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/install/updating/update-methods.md "Switch between npm and git installs" | event | runtime-bun-available |
| 183 | pnpm- or Bun-owned installation: --channel dev rejected before activation; repair runs children on that Bun | docs/cli/update/how-updates-run.md "Package-manager installs"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/bun-compatibility.md "Bun-only installs"; docs/install/bun-compatibility.md "Bun-only installs", "SQLite library selection on macOS", "Known limitations", "SQLite worker lifecycle"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun" | ambient | install-pnpm-global |
| 184 | Managed Bun Gateway at a different package root: service-root update, repair from another installation refuses | docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/update-methods.md "Switch between npm and git installs"; docs/cli/update/how-updates-run.md "Package-manager installs"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/bun-compatibility.md "Bun-only installs"; docs/install/bun-compatibility.md "Bun-only installs", "SQLite library selection on macOS", "Known limitations", "SQLite worker lifecycle"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun" | ambient | runtime-bun-available |
| 185 | Gateway and updater running on the Bun runtime of a Bun-owned global installation | docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/update/how-updates-run.md "Package-manager installs"; docs/install/bun-compatibility.md "Bun-only installs"; docs/install/bun-compatibility.md "Bun-only installs", "SQLite library selection on macOS", "Known limitations", "SQLite worker lifecycle"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/install/updating/update-methods.md "Switch between npm and git installs" | ambient | install-bun-global |
| 186 | npm link to a built Git checkout: rollback verifies that checkout; rebuilding it during the update prevents rollback | docs/cli/update/how-updates-run.md "Package-manager installs" | ambient | none |
| 187 | Local packaged dist edits: recovery bundle under update-recovery/, replay only with matching baseline | docs/cli/update/how-updates-run.md "Local packaged overrides"; docs/cli/update/status-and-history.md "Run history and reports" | ambient | install-dist-edited |
| 188 | Triage starts the first launchable coding agent on PATH, or none is found and handoff commands are printed | docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating/rollback-and-recovery.md "If you are stuck"; docs/cli/triage.md "`openclaw triage`"; docs/cli/triage.md "Manual handoff"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/cli/triage.md "`openclaw triage`", "Manual handoff" | ambient | coding-agent-stub |
| 189 | Original working directory no longer accessible: agent starts in the OS home | docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/cli/triage.md "Failed update recovery" | ambient | none |
| 190 | Non-interactive failure without verified rollback: diagnostics and handoff commands, owned automatic repair on configured inference | docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating/rollback-and-recovery.md "If you are stuck"; docs/cli/triage.md "Failed update recovery"; docs/install/update-troubleshooting.md "(intro)"; docs/gateway/restart-recovery.md "Recovery after a failed update"; docs/install/updating/rollback-and-recovery.md "Unattended repair on your own inference" | event | mock-provider-tool-calls |
| 191 | Another process saves configuration during database admission: config reread, checks repeated, implicit channel change re-resolved | docs/cli/update/repair-and-recovery.md "Recover a failed update" | event | none |
| 192 | Stopping the service unloads it and then fails before activation: original runtime restored | docs/cli/update/repair-and-recovery.md "Recover a failed update" | event | none |
| 193 | Already-current installation needs plugin maintenance and a maintenance step is refused: restart after Doctor writers settle | docs/cli/update/repair-and-recovery.md "Recover a failed update" | event | none |
| 194 | Reporting fails after a successful activation: installation kept, exit nonzero | docs/cli/update/repair-and-recovery.md "Recover a failed update" | event | none |
| 195 | Initial-check rejections (arguments, external supervisor, store ownership, handoff identity, immutable config) collect no diagnostics | docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 196 | Original state captures under <state-directory>.update-captures/<run-id>; incomplete captures warned; status shows restored, manual or incomplete | docs/cli/update/repair-and-recovery.md "Original state captures"; docs/cli/update/repair-and-recovery.md "Original state captures", "Skipped legacy audit recovery" | ambient | none |
| 197 | Standalone doctor --fix captures retained for 30 days and retired by the next run | docs/cli/update/repair-and-recovery.md "Original state captures" | ambient | recovery-originals-retained |
| 198 | Filesystem rejects no-replace rename or hard links: hard-link publication, or audit files preserved with a warning | docs/cli/update/repair-and-recovery.md "Original state captures"; docs/cli/update/repair-and-recovery.md "Skipped legacy audit recovery"; docs/install/docker.md "Upgrading container images" | ambient | state-legacy-migratable |
| 199 | Legacy audit raw archive changed other than by append: quarantined copy, warning repeats until resolved | docs/cli/update/repair-and-recovery.md "Skipped legacy audit recovery"; docs/cli/update/repair-and-recovery.md "Original state captures"; docs/install/docker.md "Upgrading container images" | ambient | state-legacy-migratable |
| 200 | Debug capture enabled during an update: proxy persistence disabled, limitation reported | docs/cli/update/repair-and-recovery.md "Original state captures" | ambient | none |
| 201 | Chat-triggered update to 2026.9.6 fails with an authority-check stack overflow | docs/cli/update/repair-and-recovery.md "Candidate Doctor stack overflow" | event | none |
| 202 | Package activation stranded at prepared or publishing by an older updater: repair settles or aborts it | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating.md "Package-publication recovery" | ambient | none |
| 203 | Manual install over a stranded update: closed as superseded-by-manual-install | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating.md "Package-publication recovery" | event | install-npm-global |
| 204 | Managed handoff lease database replaced or missing after a reboot clears temporary storage | docs/cli/update/repair-and-recovery.md "`update repair`" | event | none |
| 205 | Core package changed but post-core plugin sync or Doctor did not converge: update repair finishes it | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/update/status-and-history.md "Run history and reports" | ambient | plugin-migration-pending |
| 206 | Interrupted automatic triage leaves an uncertain installation handoff reclaimable after 45 minutes | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 207 | Unfinished package or configuration rollback keeps the handoff; repair refuses until restoration completes | docs/cli/update/repair-and-recovery.md "`update repair`" | ambient | none |
| 208 | Managed Gateway already stopped before repair: stays offline with a gateway start warning | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/update-troubleshooting.md "Doctor cannot enter maintenance during finalization" | ambient | none |
| 209 | Identityless 2026.9.2-era admission older than 24 hours: legacy-driver-expired, config writes no longer suspended | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/update/status-and-history.md "Run history and reports"; docs/install/updating.md "Stale update history" | ambient | update-history-stale |
| 210 | Stale inactive ledger row with a healthy Gateway: lightweight repair records failed/abandoned | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating.md "Stale update history"; docs/cli/update/status-and-history.md "Run history and reports" | ambient | update-history-stale |
| 211 | Active row inactive over 30 minutes with a dead driver: abandonedRun, later reconciled by the Gateway | docs/cli/update/status-and-history.md "Run history and reports"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating.md "Stale update history" | ambient | update-history-stale |
| 212 | New explicit update supersedes a sole stale identityless row (superseded) | docs/cli/update/status-and-history.md "Run history and reports"; docs/install/updating.md "Stale update history"; docs/cli/update/repair-and-recovery.md "`update repair`" | event | update-history-stale |
| 213 | OPENCLAW_SERVICE_REPAIR_POLICY=external preserved by Doctor children | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/gateway/restart-and-supervision.md "External supervisors" | ambient | none |
| 214 | Another live or uninspectable update driver blocks repair and Doctor service stops | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating.md "Stale update history" | event | none |
| 215 | Deferred plugin migrations: finalization runs another fresh Doctor; retained inputs protected from config edits | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/doctor/state-migrations.md "Pending plugin migrations"; docs/gateway/doctor/config-migrations.md "Missing plugins during migration"; docs/cli/update/status-and-history.md "`update status`"; docs/install/update-troubleshooting.md "Retained legacy session history"; docs/install/updating.md "Recommended: `openclaw update`" | ambient | plugin-migration-pending |
| 216 | Unfinished plugin data or settings upgrades listed as migrationWarnings; unreadable migration state reported separately | docs/cli/update/status-and-history.md "`update status`"; docs/cli/doctor/state-migrations.md "Pending plugin migrations"; docs/gateway/doctor/config-migrations.md "Missing plugins during migration"; docs/install/update-troubleshooting.md "Retained legacy session history"; docs/install/updating.md "Recommended: `openclaw update`" | ambient | plugin-migration-pending |
| 217 | Repair phase exceeds its deadline: exit 1 with stuckPhase and Doctor output excerpts | docs/cli/update/repair-and-recovery.md "`update repair`" | event | none |
| 218 | Plugin capability changes need consent: PLUGIN_CAPABILITY_CONSENT_REQUIRED warning until reviewed or --accept-capabilities | docs/cli/update/repair-and-recovery.md "`update repair`"; docs/cli/update.md "Options" | ambient | plugin-capability-widened |
| 219 | Cleanup apply while database readers run: Recovery destination database changed | docs/cli/update/repair-and-recovery.md "`update cleanup`"; docs/install/updating.md "Retire update recovery data" | event | recovery-originals-retained |
| 220 | Recovery originals retained after an update: only owner-recorded, fully imported artifacts eligible | docs/cli/update/repair-and-recovery.md "`update cleanup`"; docs/install/docker.md "Upgrading container images"; docs/install/updating.md "Retire update recovery data" | ambient | recovery-originals-retained |
| 221 | Interrupted cleanup reconciled on retry; removal failures exit nonzero | docs/cli/update/repair-and-recovery.md "`update cleanup`" | event | none |
| 222 | Update in progress: status shows its phase instead of another update | docs/cli/update/status-and-history.md "`update status`"; docs/cli/update/status-and-history.md "`update status`", "Run history and reports" | ambient | none |
| 223 | Git discovery times out twice at startup: git-unavailable until an explicit refresh | docs/cli/update/status-and-history.md "`update status`" | event | install-git-checkout |
| 224 | Detached updater's late terminal notification awaited for up to 30 minutes by the watcher | docs/cli/update/status-and-history.md "`update status`" | ambient | none |
| 225 | Reachable Gateway with recorded channel warnings (channelIssues, blocked channel startup) | docs/cli/update/status-and-history.md "`update status`" | ambient | channels-test-accounts |
| 226 | Extended-stable installation ahead of the selector, or selector failures (registry.reason) | docs/cli/update/status-and-history.md "`update status`" | ambient | none |
| 227 | History admission waits for a busy database writer: update-ledger-busy deferral | docs/cli/update/status-and-history.md "Run history and reports"; docs/install/update-troubleshooting.md "Reason codes" | event | none |
| 228 | Update history unreadable: runStatusError, availability still shown | docs/cli/update/status-and-history.md "Run history and reports" | ambient | none |
| 229 | Configuration writes suspended while an update row is active | docs/cli/update/status-and-history.md "Run history and reports"; docs/install/updating.md "Stale update history" | ambient | update-history-stale |
| 230 | Diagnostics enabled: slow update.status requests log phase durations | docs/cli/update/status-and-history.md "Run history and reports" | ambient | none |
| 231 | Candidate check exits by signal: termination class, signal and stderr tail kept | docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 232 | Updater process dies: Gateway reconciles the run as abandoned after 30 minutes without activity | docs/cli/update/status-and-history.md "Run history and reports" | event | history-stale-run |
| 233 | Updater exits during restart verification: Gateway or Doctor finish the run succeeded after fresh checks | docs/cli/update/status-and-history.md "Run history and reports" | event | history-stale-run |
| 234 | Shared-state schema bump under a 2026.9.2 updater: content applied, version publication deferred | docs/cli/update/status-and-history.md "Run history and reports"; docs/install/updating.md "Updating from 2026.9.2 across a schema bump"; docs/gateway/doctor/config-migrations.md "Schema publication during a 2026.9.2 update"; docs/reference/database-schemas/versioning.md "Schema bumps and older updaters" | ambient | none |
| 235 | App-owned package marker (openclaw-install-owner.json): update returns the owner's hint; invalid marker warns | docs/install/updating.md "(intro)"; docs/install/updating.md "(introduction)" | ambient | none |
| 236 | Container image replaced over the same mounted state: entrypoint runs doctor --fix before the Gateway | docs/install/updating.md "(intro)"; docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/install/docker.md "Upgrading container images"; docs/install/updating.md "(introduction)" | event | none |
| 237 | Tenant containers from the retired fleet command left untouched by a host update | docs/install/updating.md "Retired tenant-container management" | ambient | none |
| 238 | Installation older than July 2026: bridge through 2026.9.5, Doctor stops before rewriting retired keys | docs/install/updating.md "Upgrading very old versions"; docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/gateway/doctor/config-migrations.md "Retired state and config formats" | ambient | state-legacy-retired |
| 239 | Retired pre-June plugin JSON state (iMessage, Active Memory, Nostr, Teams) preserved; bridge through 2026.9.5 | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/install/updating.md "Upgrading very old versions" | ambient | state-legacy-retired |
| 240 | Pre-July Telegram sidecars ignored; Telegram ingress spool still imported | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-legacy-retired |
| 241 | Retired Voice Wake, plugin-binding, ACP replay and restart-sentinel JSON: Doctor and admission refuse with the 2026.9.7 bridge | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-retired-json |
| 242 | Retired subagents/runs.json, plugins/installs.json, sandbox JSON registries and room->groupChannel records refused or ignored | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/install/updating.md "Upgrading very old versions" | ambient | state-retired-json |
| 243 | Per-agent SQLite layouts below schema 8 refused | docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-legacy-retired |
| 244 | Retired channel config and JSON stores (Discord voice.tts, Device Pair notify, Voice Call logs) refused with bridge guidance | docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-legacy-retired |
| 245 | Legacy cron JSON stores (jobs.json, jobs-state.json, runs/*.jsonl) refused; candidate admission reports it | docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-retired-json |
| 246 | Pre-July JSON delivery queue files refused | docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-legacy-retired |
| 247 | Retired config keys (agents.defaults.llm, routing.*, talk selectors and others) refused with guidance | docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | config-retired-keys |
| 248 | Retired OAuth credential sidecars referenced by auth-profiles.json | docs/gateway/doctor/config-migrations.md "Retired state and config formats"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Retention policy", "Retired state and config formats", "Workspace setup"; docs/install/updating.md "Upgrading very old versions" | ambient | state-legacy-retired |
| 249 | Retired same-file memory index refused before canonical tables | docs/install/updating.md "Upgrading very old versions" | ambient | none |
| 250 | Masked or start-restricted systemd service: preflight refuses before replacing files | docs/install/updating.md "Recommended: `openclaw update`" | ambient | none |
| 251 | Operator masks the service during the update: service-definition warning, no rollback | docs/install/updating.md "Recommended: `openclaw update`" | event | none |
| 252 | Update invoked from inside the Gateway process tree: inside-gateway-service, deferred maintenance for already-current | docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | ambient | mock-provider-tool-calls |
| 253 | Compatibility config read after package replacement fails: candidate-config-read-failed | docs/install/updating.md "Recommended: `openclaw update`" | event | none |
| 254 | Managed Node service points at another global installation: refreshed with gateway install --force | docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/rollback-and-recovery.md "Before you upgrade"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating/update-methods.md "Homebrew formula installs" | ambient | none |
| 255 | Shell resolves a different openclaw or Node than the service: installation drift reported | docs/install/updating/rollback-and-recovery.md "Before you upgrade"; docs/cli/update/repair-and-recovery.md "`update repair`"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating/update-methods.md "Homebrew formula installs" | ambient | none |
| 256 | Pending package-publication recovery blocks writable preparation | docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating.md "Package-publication recovery" | ambient | none |
| 257 | ClawHub lacks a version-matched official plugin: trusted npm source tried, version-skew warning | docs/install/updating.md "Recommended: `openclaw update`" | event | plugins-bundled-and-external |
| 258 | Operator-managed local plugin copy in plugins.load.paths: plugin-operator-managed warning | docs/install/updating.md "Recommended: `openclaw update`" | ambient | none |
| 259 | Retained .artifacts/dist-artifacts.lock refuses a source update | docs/install/updating.md "Recommended: `openclaw update`" | ambient | install-git-checkout |
| 260 | Canary uses a temporary loopback port and suppresses listeners, preserving rate-limit settings | docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update/how-updates-run.md "Validation and activation" | ambient | none |
| 261 | Unparseable plugin entry during snapshot inventory: warning, files copied unchanged | docs/install/updating.md "Recommended: `openclaw update`"; docs/install/update-troubleshooting.md "Snapshot parse errors from 2026.9.5 and 2026.9.6" | ambient | none |
| 262 | Package publication completed but cleanup failed: evidence archived or retained with a warning | docs/install/updating.md "Package-publication recovery" | event | none |
| 263 | External-helper operation stuck at publication-complete: repair settles it | docs/install/updating.md "Package-publication recovery" | ambient | none |
| 264 | Older in-directory activation journals reported with their helper status command | docs/install/updating.md "Package-publication recovery" | ambient | none |
| 265 | Update requested from a chat session with a delivery route: acknowledgement, restarting, back-on and final-report notices follow there | docs/install/updating.md "From chat"; docs/install/updating/automatic-updates.md "Update campaigns"; docs/tools/slash-commands.md "Core commands" | ambient | session-main-rolling |
| 266 | Managed service installation: a chat-started update's restart can stop the Gateway before an intermediate notice | docs/install/updating.md "From chat"; docs/install/updating/automatic-updates.md "Update campaigns"; docs/tools/slash-commands.md "Core commands" | ambient | channels-test-accounts |
| 267 | No owner destination resolves for a notice: skipped and logged, outcome kept | docs/install/updating.md "From chat"; docs/tools/slash-commands.md "Configuration" | ambient | channel-owner-route |
| 268 | Destination account disables actions.sendMessage: notices skipped | docs/install/updating.md "From chat" | ambient | none |
| 269 | Run with an internal origin session (Control UI, webchat): notices in that transcript | docs/install/updating.md "From chat"; docs/install/updating/automatic-updates.md "Update campaigns" | ambient | none |
| 270 | Non-owner chat sender asks to update or restart: refusal with the configuration command | docs/install/updating.md "From chat"; docs/tools/slash-commands.md "Configuration"; docs/tools/slash-commands.md "Configuration", "Core commands" | ambient | gateway-multi-user-profiles |
| 271 | commands.restart disabled: /update, /restart and SIGUSR2 refused | docs/install/updating.md "From chat"; docs/tools/slash-commands.md "Configuration"; docs/install/update-troubleshooting.md "Reason codes"; docs/tools/slash-commands.md "Configuration", "Core commands" | ambient | none |
| 272 | Scheduled automation calls gateway update.run under the scheduled run's authority | docs/install/updating.md "From chat" | ambient | cron-job-isolated |
| 273 | No functioning model: /update still works | docs/install/updating.md "From chat" | ambient | none |
| 274 | FreeBSD rc.d service discovery | docs/install/updating.md "Inspect FreeBSD service discovery"; docs/install/updating.md "Recommended: `openclaw update`"; docs/install/updating.md "Inspect FreeBSD service discovery", "Recommended: `openclaw update`" | ambient | none |
| 275 | Plugin restart-ready-state warning: active official plugins differ from the package the service will load | docs/install/updating.md "Run doctor"; docs/install/updating.md "Run doctor", "After updating" | ambient | plugin-pin-outdated |
| 276 | Background exec completion follow-ups after an update run even with heartbeat every 0m | docs/install/updating.md "Background exec notifications after an update" | ambient | none |
| 277 | Headless node host busy: automatic activation postponed until idle, activations at least 12 hours apart | docs/install/updating/automatic-updates.md "Headless node updates"; docs/install/update-troubleshooting.md "Headless nodes waiting on 2026.9.6" | ambient | node-host-headless |
| 278 | Plugin without the idle-work callback postpones node activation | docs/install/updating/automatic-updates.md "Headless node updates"; docs/install/update-troubleshooting.md "Headless nodes waiting on 2026.9.6" | ambient | node-host-headless |
| 279 | Node candidate fails to reconnect: launcher falls back to the previous runtime | docs/install/updating/automatic-updates.md "Headless node updates" | event | node-host-headless |
| 280 | Node shares its state directory with an older Gateway: mismatched local node rejected | docs/install/updating/automatic-updates.md "Headless node updates" | ambient | node-host-headless |
| 281 | Node update needing a migration or startup repair is deferred | docs/install/updating/automatic-updates.md "Headless node updates" | ambient | node-host-headless |
| 282 | Node automatic updates disabled (nodeHost.autoUpdate.enabled false, checkOnStart false, OPENCLAW_NO_AUTO_UPDATE) | docs/install/updating/automatic-updates.md "Headless node updates" | ambient | node-host-headless |
| 283 | Stale node-runtime/activation.lock | docs/install/updating/automatic-updates.md "Headless node updates" | ambient | node-host-headless |
| 284 | Gateway automatic updates enabled on a managed service (update.auto.enabled) | docs/install/updating/automatic-updates.md "Auto-updater" | ambient | none |
| 285 | Dev Git install: Updates page refreshes the upstream (current, ahead, diverged, unavailable, behind) | docs/install/updating/automatic-updates.md "Auto-updater"; docs/web/control-ui/settings.md "Updates"; docs/install/development-channels.md "Checking current status" | ambient | install-git-checkout |
| 286 | Channel cadence: stable delay with jitter, beta interval, dev hourly pinned commit | docs/install/updating/automatic-updates.md "Auto-updater" | ambient | none |
| 287 | Campaign due with active work: waits for idle, one-minute countdown, 15-minute hard deadline | docs/install/updating/automatic-updates.md "Update campaigns"; docs/install/development-channels.md "Switching channels"; docs/install/updating/automatic-updates.md "Update campaigns", "Auto-updater"; docs/web/control-ui/settings.md "Updates" | event | mock-provider-held-turn |
| 288 | Open terminal sessions do not defer the campaign and end at the restart | docs/install/updating/automatic-updates.md "Update campaigns"; docs/gateway/restart-recovery.md "What survives a restart"; docs/gateway/restart-recovery.md "What survives a restart", "What is not resumed" | ambient | none |
| 289 | Failed campaign apply ends the campaign; handoff failures surface after the Gateway returns | docs/install/updating/automatic-updates.md "Update campaigns"; docs/cli/update/status-and-history.md "Run history and reports" | event | none |
| 290 | Update checks disabled (checkOnStart false or OPENCLAW_NO_AUTO_UPDATE): no checks, statistics or notices | docs/install/updating/automatic-updates.md "Update campaigns"; docs/gateway/telemetry.md "Disable every automatic update request"; docs/install/updating/automatic-updates.md "Update campaigns", "Headless node updates"; docs/install/updating/rollback-and-recovery.md "Downgrade" | ambient | none |
| 291 | External supervisor mode: automatic applies and self-update refused, hints still run | docs/install/updating/automatic-updates.md "Update campaigns"; docs/cli/gateway/restart-and-supervision.md "External supervisors"; docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 292 | External supervisor mode: restart targets the running Gateway, native service ops and self-update refused | docs/cli/gateway/restart-and-supervision.md "External supervisors"; docs/cli/triage.md "Automatic failure handoff"; docs/install/updating/automatic-updates.md "Update campaigns" | ambient | none |
| 293 | Disabling checks cancels unfinished discovery and its campaign | docs/install/updating/automatic-updates.md "Update campaigns" | event | none |
| 294 | Gateway shutdown cancels unfinished discovery and waits for Git processes | docs/install/updating/automatic-updates.md "Update campaigns" | event | none |
| 295 | update.run with a routable chat session: acknowledgement awaited up to 10 seconds (ackDelivered) | docs/install/updating/automatic-updates.md "Update campaigns"; docs/install/updating.md "From chat" | ambient | session-main-rolling |
| 296 | Control UI reconnects during an update: dialog shows Gateway restarting and resumes from the run record | docs/install/updating/automatic-updates.md "Update campaigns"; docs/web/control-ui/settings.md "Updates" | event | none |
| 297 | Signed macOS app owns the local Gateway update (Update Mac app + Gateway) | docs/install/updating/automatic-updates.md "Update campaigns"; docs/web/control-ui/settings.md "Updates" | ambient | none |
| 298 | Fresh shared database without fleet_cells: older revisions reject it | docs/install/updating/rollback-and-recovery.md "Downgrade" | ambient | none |
| 299 | Package rollback verification mismatch: up to five differing paths recorded | docs/install/updating/rollback-and-recovery.md "Downgrade" | event | none |
| 300 | Config written by a newer version (meta.lastTouchedVersion): older binary refuses service mutations | docs/install/updating/rollback-and-recovery.md "Downgrade"; docs/gateway/troubleshooting/updates-and-rollbacks.md "Split brain installs and newer config guard" | ambient | none |
| 301 | Enabled auto-updater would reapply the newer release during recovery | docs/install/updating/rollback-and-recovery.md "Downgrade" | ambient | none |
| 302 | Auth profile import .bak files are not the live credential store | docs/install/updating/rollback-and-recovery.md "Downgrade" | ambient | none |
| 303 | Restored service fails its health check after rollback: recovery.service failed | docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback" | event | none |
| 304 | Incomplete $include graph: automatic config rollback unavailable | docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/cli/update/how-updates-run.md "Compatibility-checked package rollback"; docs/gateway/doctor/config-migrations.md "Agent roster migration" | ambient | config-include-files |
| 305 | Doctor times out after migration: process groups stopped, candidate started on migrated state, or Gateway kept stopped while writers remain | docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback" | event | none |
| 306 | Large legacy histories need space for originals, spool and destination | docs/install/updating/rollback-and-recovery.md "Before updating: create a verified backup" | ambient | store-legacy-sessions-json |
| 307 | Triage launch consent: only Yes starts the agent; Enter, n, cancel or 30 seconds skips | docs/install/updating/rollback-and-recovery.md "If you are stuck"; docs/install/update-troubleshooting.md "(intro)"; docs/cli/triage.md "Failed update recovery"; docs/install/update-troubleshooting.md "(introduction)" | event | coding-agent-stub |
| 308 | Restart accepted by the service owner but ready check fails | docs/install/updating/rollback-and-recovery.md "If you are stuck" | event | none |
| 309 | Failed candidate during an install-type switch leaves the previous command runnable | docs/install/updating/update-methods.md "Switch between npm and git installs" | event | install-git-checkout |
| 310 | Installation-change watcher restarts a Gateway updated with --no-restart | docs/install/updating/update-methods.md "Switch between npm and git installs" | event | none |
| 311 | Live service shares a source checkout's dist output: build entry points refuse | docs/install/updating/update-methods.md "Source-checkout servers (reference script)" | ambient | install-git-checkout |
| 312 | Source-server script without Corepack or with a pnpm pin mismatch stops before checkout update | docs/install/updating/update-methods.md "Source-checkout servers (reference script)" | ambient | install-git-checkout |
| 313 | Source-server publication fails after stopping the service: previous revision restored and restarted | docs/install/updating/update-methods.md "Source-checkout servers (reference script)" | event | install-git-checkout |
| 314 | Output root such as dist is a symbolic link: build refused | docs/install/updating/update-methods.md "Source-checkout servers (reference script)" | ambient | install-git-checkout |
| 315 | Failed npm package replacement where triage cannot start: installer rerun recovers | docs/install/updating/update-methods.md "Alternative: re-run the installer" | event | none |
| 316 | Homebrew formula install: update leaves the formula, records skipped; service on a Cellar path | docs/install/updating/update-methods.md "Homebrew formula installs" | ambient | none |
| 317 | Package scripts skipped: CLI completes the pending lifecycle before any command (.openclaw-lifecycle-pending) | docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/cli/update/how-updates-run.md "Package-manager installs" | event | install-npm-global |
| 318 | npm install fails and retries with --omit=optional; fs-safe native binding restored | docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun" | event | none |
| 319 | npm min-release-age quarantine configured: cleared for OpenClaw-managed npm children | docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/cli/update/how-updates-run.md "Package-manager installs"; docs/install/updating.md "Upgrading very old versions" | ambient | install-npm-global |
| 320 | pnpm global install group shared with another package: updater stops before changing it | docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun" | ambient | none |
| 321 | Root-owned system-global install: update fails with EACCES, recovery through system npm | docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun"; docs/install/updating/update-methods.md "Advanced npm install topics"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun", "Advanced npm install topics" | ambient | none |
| 322 | Drifted official npm plugins brought to the installed release by doctor --fix | docs/install/updating/update-methods.md "Package lifecycle and operator state"; docs/install/updating/update-methods.md "Package lifecycle and operator state", "Stuck on 2026.9.3" | ambient | plugin-pin-outdated |
| 323 | OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL set: postinstall cleanup skipped, lifecycle completed | docs/install/updating/update-methods.md "Package lifecycle and operator state" | ambient | none |
| 324 | Hardened systemd service without write access to config and state roots | docs/install/updating/update-methods.md "Advanced npm install topics" | ambient | none |
| 325 | Control UI failed attempt opens Ask OpenClaw once per attempt identity; browser storage unavailable disables the automatic request | docs/install/update-troubleshooting.md "(intro)"; docs/install/update-troubleshooting.md "(introduction)" | event | none |
| 326 | Lost connection or verification timeout shown as an unknown outcome until the version arrives | docs/install/update-troubleshooting.md "(intro)"; docs/web/control-ui/settings.md "Updates"; docs/install/update-troubleshooting.md "(introduction)" | ambient | none |
| 327 | Report from a non-owner administrator: prefilled browser issue only, never the host GitHub CLI | docs/install/update-troubleshooting.md "(intro)" | ambient | gateway-multi-user-profiles |
| 328 | Gateway disconnected, method unsupported or no admin scope: Control UI recovery controls disabled, CLI fallback | docs/install/update-troubleshooting.md "Recover in the Control UI"; docs/web/control-ui/settings.md "Updates"; docs/install/update-troubleshooting.md "(introduction)", "Recover in the Control UI" | ambient | gateway-multi-user-profiles |
| 329 | Container package changes are not durable: redeploy the image | docs/install/update-troubleshooting.md "Node and global install permissions" | ambient | none |
| 330 | System-scope systemd Gateway: package updated, operator restart command recorded | docs/install/update-troubleshooting.md "System-scope systemd services" | ambient | none |
| 331 | Installation not writable by the updater: managed-service-handoff-failed with owner commands | docs/install/update-troubleshooting.md "System-scope systemd services" | ambient | none |
| 332 | Candidate migration rehearsal step exceeds its budget (candidate-migration-rehearsal) | docs/install/update-troubleshooting.md "Candidate migration rehearsal timeouts" | event | sessions-thousands-near-cap |
| 333 | Large agent fleet: minutes of model-catalog preparation after the listener binds, HTTP unanswered | docs/install/update-troubleshooting.md "Published 2026.9.4 on large agent fleets"; docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | agents-fleet-large |
| 334 | Missing runtime source capture (openclaw-plugin-build- ENOENT): warning, replacement loads | docs/install/update-troubleshooting.md "Missing temporary plugin captures" | ambient | none |
| 335 | Plugin dependency using import.meta in an older updater's parser | docs/install/update-troubleshooting.md "Snapshot parse errors from 2026.9.5 and 2026.9.6"; docs/install/updating.md "Recommended: `openclaw update`" | ambient | plugins-bundled-and-external |
| 336 | Legacy openclaw-model-catalog-* temporary trees removed by doctor --fix when no other process runs | docs/install/update-troubleshooting.md "Large model-catalog temporary directories" | ambient | none |
| 337 | Two identical candidate Doctor failures for one version: automatic updates pause | docs/install/update-troubleshooting.md "Reason codes" | event | registry-local-mirror |
| 338 | Dependency or build fails during a source update (deps-install-failed, build-failed, ui-build-failed) | docs/install/update-troubleshooting.md "Reason codes"; docs/install/update-troubleshooting.md "Reason codes", "CLI fallback" | event | install-git-checkout |
| 339 | Legacy sessions.json with invalid entries or malformed transcripts: imported prefix, warnings; changed transcripts block ready check | docs/install/update-troubleshooting.md "Retained legacy session history" | ambient | store-legacy-sessions-json |
| 340 | Installed CLI damaged or diagnostics unwritable: automatic triage reports the failure | docs/install/update-troubleshooting.md "CLI fallback"; docs/cli/triage.md "Automatic failure handoff"; docs/cli/triage.md "Output and exit codes" | ambient | none |
| 341 | Updater killed after the Gateway stops: Gateway stays stopped unless recovery was verified | docs/install/update-troubleshooting.md "CLI fallback" | event | install-npm-global |
| 342 | Refused or failed core update keeps the previous channel | docs/install/development-channels.md "Switching channels" | event | none |
| 343 | Git checkout with several remotes and no branch.main.remote | docs/install/development-channels.md "Switching channels" | ambient | install-git-checkout |
| 344 | Refused channel switch or verified rollback recovers the previous service; unverified leaves it stopped | docs/install/development-channels.md "Switching channels" | event | install-git-checkout |
| 345 | Last recorded update fetch failed: status shows update check stale | docs/install/development-channels.md "Checking current status" | ambient | install-git-checkout |
| 346 | Plugin dependency tree corrupted after an update: channel not loaded | docs/gateway/troubleshooting/updates-and-rollbacks.md "After an update" | ambient | plugins-bundled-and-external |
| 347 | Stale per-agent OAuth shadows after re-auth: provider 401s until doctor --fix | docs/gateway/troubleshooting/updates-and-rollbacks.md "After an update" | ambient | state-legacy-migratable |
| 348 | Prepared model runtime publication times out at startup (ambient credentials stage) | docs/gateway/troubleshooting/updates-and-rollbacks.md "Prepared model runtime publication timeout" | event | none |
| 349 | Protocol mismatch: a newer client keeps reconnecting to an older Gateway after rollback | docs/gateway/troubleshooting/updates-and-rollbacks.md "Protocol mismatch after rollback" | ambient | none |
| 350 | Claude Code without safe-mode support: notice, normal customization | docs/cli/triage.md "`openclaw triage`" | ambient | none |
| 351 | Gateway unreachable during triage: archive written with snapshot failures | docs/cli/triage.md "`openclaw triage`" | ambient | none |
| 352 | Bounded unattended repair before triage for validation failures or unsafe rollback | docs/cli/triage.md "Failed update recovery" | event | none |
| 353 | Installation already healthy: triage --run reports already resolved | docs/cli/triage.md "Installation target and embedded handoff" | ambient | none |
| 354 | Update failure artifact without a run identity: unrepaired | docs/cli/triage.md "Installation target and embedded handoff" | ambient | none |
| 355 | Post-turn cleanup fails: another repair refused in that process | docs/cli/triage.md "Installation target and embedded handoff" | event | none |
| 356 | Explicit exec deny or sandbox, node or remote route: embedded repair refused (exec-denied-by-policy) | docs/cli/triage.md "Installation target and embedded handoff" | ambient | none |
| 357 | Gateway server startup failure: triage when the crash-loop breaker first trips; startup retried once after cleanup | docs/cli/triage.md "Automatic failure handoff"; docs/gateway/restart-recovery.md "Safety valves and observability" | event | coding-agent-stub |
| 358 | Unsupervised foreground or container run stays alive after a failed startup retry | docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 359 | Stop received during triage cancels recovery | docs/cli/triage.md "Automatic failure handoff" | event | none |
| 360 | Codex app-server on a socket transport: automatic repair refused | docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 361 | Competing failure while triage is owned: already owned, original output kept | docs/cli/triage.md "Automatic failure handoff" | event | none |
| 362 | Fixing process disappears abruptly: automatic admission blocked for that boot | docs/cli/triage.md "Automatic failure handoff" | event | none |
| 363 | Linux user-systemd automatic recovery in a native scope; explicit stop cancels it | docs/cli/triage.md "Automatic failure handoff" | event | none |
| 364 | Missing Node or CLI files: manual triage required | docs/cli/triage.md "Automatic failure handoff" | ambient | none |
| 365 | Matrix dedupe scan only when Matrix is configured | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/cli/doctor/state-migrations.md "(introduction)" | ambient | state-legacy-migratable |
| 366 | Session rows with provider and lastProvider aliases repaired | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration" | ambient | store-rows-legacy-aliases |
| 367 | Older session-row pending-delivery, model-fallback and memory-flush fields converted; ordinary reads require the repair | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/cli/doctor/state-migrations.md "(introduction)", "Legacy state migration" | ambient | store-rows-legacy-aliases |
| 368 | Default-layout install with only ~/.clawdbot: renamed; both directories present need manual reconciliation | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-legacy-retired |
| 369 | Container entrypoint migration: unsafe required store exits 78 | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/install/docker.md "Upgrading container images" | event | store-corrupt-generation |
| 370 | Default or system agent database refused: ready check false with the reason; optional agent isolated | docs/install/docker.md "Upgrading container images"; docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | store-corrupt-generation |
| 371 | Unused legacy stores (loose agent/settings.json) deferred with advisories | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | none |
| 372 | Doctor interrupted during an agent schema or media migration: rerun reclaims a dead owner and resumes | docs/cli/doctor/state-migrations.md "Legacy state migration" | event | none |
| 373 | Earlier refusal blocks later steps (blocked-by-prior-refusal) | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-retired-json |
| 374 | Legacy workspace setup files imported; canonical record wins | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Workspace setup" | ambient | state-legacy-migratable |
| 375 | Skill Workshop proposals exported; unowned or half-applied proposals held back | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-legacy-migratable |
| 376 | Plugin migrations with files outside the copied state deferred | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | none |
| 377 | Completed agent deletion kept its files or deletion history missing: stores held back with warnings | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-legacy-migratable |
| 378 | Incognito reserved database filename collision | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | none |
| 379 | Historical 2026.7.35 shared schema without a deletion journal | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | none |
| 380 | Interrupted auth-profile archive recovery reported | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | none |
| 381 | Legacy exec-approvals.json stub or malformed file: stubs retired, malformed blocks approvals | docs/cli/doctor/state-migrations.md "Legacy state migration"; docs/gateway/doctor/config-migrations.md "Exec approval policy" | ambient | approvals-legacy-json |
| 382 | Legacy exec approval policy rows in SQLite normalized with a snapshot | docs/gateway/doctor/config-migrations.md "Exec approval policy"; docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | approvals-legacy-json |
| 383 | Another connection commits before the media repair: source changed before migration transaction | docs/cli/doctor/state-migrations.md "Legacy state migration" | event | session-main-rolling |
| 384 | Missing file copies of canonical transcript archives: warnings only | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | transcripts-cold-stored |
| 385 | SIGINT or SIGTERM to Doctor during archive repair batches: Gateway restored | docs/cli/doctor/state-migrations.md "Legacy state migration" | event | none |
| 386 | Large fleets: shared inspection across update guard and admission | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | agents-fleet-large |
| 387 | Device Pair legacy JSON beyond namespace capacity | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | none |
| 388 | Shared auth still in the legacy agents/main database: relocated; conflicts reported | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-legacy-migratable |
| 389 | Retired MCP OAuth files and stale .lock sidecars | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-legacy-migratable |
| 390 | Retained legacy state blocks agent turns; unready live config candidate rejected | docs/cli/doctor/state-migrations.md "Legacy state migration" | ambient | state-retired-json |
| 391 | Pending plugin migration finished when the installed plugin has nothing to migrate | docs/cli/doctor/state-migrations.md "Pending plugin migrations"; docs/gateway/doctor/config-migrations.md "Missing plugins during migration" | ambient | plugin-migration-pending |
| 392 | Owner allowlist with direct-user target kinds; ambiguous owners restored from .bak history | docs/gateway/doctor/config-migrations.md "Command-owner target kinds"; docs/tools/slash-commands.md "Configuration" | ambient | state-legacy-migratable |
| 393 | Session compactionCheckpoints still read at runtime | docs/gateway/doctor/config-migrations.md "Deferred compaction checkpoints" | ambient | session-long-compacted |
| 394 | Retired settings.json or keybindings.json keys refused, last accepted bindings kept | docs/gateway/doctor/config-migrations.md "Session settings" | ambient | state-legacy-migratable |
| 395 | Telegram update-offset versions 1 and 2 normalized before account startup | docs/gateway/doctor/config-migrations.md "Retired state and config formats" | ambient | none |
| 396 | Startup with retired files: Gateway run and local message send continue with a warning | docs/gateway/doctor/config-migrations.md "Retired state and config formats" | ambient | state-retired-json |
| 397 | Ownerless cron jobs pinned to the historical default agent before roster migration | docs/gateway/doctor/config-migrations.md "Cron ownership before roster migration"; docs/gateway/doctor/config-migrations.md "Cron ownership before roster migration", "Legacy cron delivery settings" | ambient | config-legacy-roster |
| 398 | Legacy cron delivery mode (missing, null, deliver) repaired; unknown mode withholds execution | docs/gateway/doctor/config-migrations.md "Legacy cron delivery settings"; docs/gateway/doctor/config-migrations.md "Cron ownership before roster migration", "Legacy cron delivery settings" | ambient | cron-job-isolated |
| 399 | Older database without Claw provenance columns | docs/gateway/doctor/config-migrations.md "Claw provenance schema" | ambient | state-legacy-migratable |
| 400 | Policy-only WhatsApp accounts.default beside named accounts: warning, unchanged | docs/gateway/doctor/config-migrations.md "Channel account routing during an update" | ambient | state-legacy-migratable |
| 401 | Legacy agents.list roster without a default marker: unbound accounts bound to the first agent; unavailable roster blocks the account | docs/gateway/doctor/config-migrations.md "Channel ownership during an update"; docs/gateway/doctor/config-migrations.md "Channel ownership during an update", "Agent roster migration", "Checks 0-2" | ambient | config-legacy-roster |
| 402 | Populated agents.list or default markers; root-level $include roster needs consolidation | docs/gateway/doctor/config-migrations.md "Agent roster migration"; docs/gateway/doctor/config-migrations.md "Checks 0-2"; docs/gateway/doctor/config-migrations.md "Channel ownership during an update", "Agent roster migration", "Checks 0-2" | ambient | config-legacy-roster |
| 403 | Unprefixed toolsBySender keys migrated | docs/gateway/doctor/config-migrations.md "Sender tool policies" | ambient | config-hand-edited |
| 404 | Tlon flat allowPrivateNetwork migrated; Matrix and Mattermost forms retired | docs/gateway/doctor/config-migrations.md "Channel private-network opt-ins" | ambient | state-legacy-migratable |
| 405 | Enabled webhook channel account without legacyWebhook: historical listener pinned once | docs/gateway/doctor/config-migrations.md "Channel webhook listeners" | ambient | state-legacy-migratable |
| 406 | Voice Call realtime settings copied into talk.realtime | docs/gateway/doctor/config-migrations.md "Talk realtime inheritance" | ambient | state-legacy-migratable |
| 407 | Historical ACP metadata keys: startup refuses unmigrated state with a current binding | docs/gateway/doctor/config-migrations.md "ACP session metadata" | ambient | state-legacy-migratable |
| 408 | Configured plugin missing during migration: warning, Gateway serves the rest | docs/gateway/doctor/config-migrations.md "Missing plugins during migration" | ambient | plugin-payload-missing |
| 409 | Retired TaskFlow Webhooks plugin entry ignored; allowlist kept explicit | docs/gateway/doctor/config-migrations.md "Retired TaskFlow Webhooks plugin" | ambient | state-legacy-migratable |
| 410 | Legacy Tasks rows for native Codex work imported or preserved | docs/gateway/doctor/config-migrations.md "Native Codex recovery after Tasks removal" | ambient | state-legacy-migratable |
| 411 | July 2026 legacy config shape (two-agent roster, legacy allowlists, retired keys) | docs/gateway/doctor/config-migrations.md "Replay a July 2026 config upgrade" | ambient | config-legacy-roster |
| 412 | Local embeddings without managed llama-server setup: degraded semantic recall named | docs/gateway/doctor/config-migrations.md "Replay a July 2026 config upgrade" | ambient | state-legacy-migratable |
| 413 | Legacy credential fields (mode, apiKey) in auth stores converted; runtime rejects them | docs/gateway/doctor/config-migrations.md "Auth credential fields" | ambient | state-legacy-migratable |
| 414 | Legacy single-file config normalized by ordinary Doctor; startup prints the hint and headless services stop | docs/gateway/doctor/config-migrations.md "Checks 0-2" | ambient | config-hand-edited |
| 415 | Older Git updater keeps an in-memory config snapshot: Doctor preserves config | docs/gateway/doctor/config-migrations.md "Checks 0-2" | ambient | none |
| 416 | Config inputs change while Doctor plans migrations: rerun required | docs/gateway/doctor/config-migrations.md "Checks 0-2" | event | none |
| 417 | Model migration changes a consumer's billing route: warning after saving | docs/gateway/doctor/config-migrations.md "Checks 0-2" | ambient | none |
| 418 | Multi-account channel without a default account: routing warning | docs/gateway/doctor/config-migrations.md "Checks 0-2" | ambient | state-legacy-migratable |
| 419 | Database schema newer than the running build: startup exits 78, update refuses older targets | docs/reference/database-schemas/versioning.md "Versioning contract"; docs/reference/database-schemas/integrity-and-recovery.md "Why you cannot go back after updating to 2026.7.2"; docs/reference/database-schemas/integrity-and-recovery.md "The Gateway refuses to start with a newer schema version error"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | event | none |
| 420 | Two databases at the same version differ in shape and canonical validation applies (`same-version-shape`) | docs/reference/database-schemas/versioning.md "Versioning contract"; docs/install/docker.md "Upgrading container images" | ambient | none |
| 421 | Canonical indexes are missing or drifted and are rebuilt by the writable owner at startup (`index-drift`) | docs/reference/database-schemas/versioning.md "Versioning contract"; docs/install/docker.md "Upgrading container images" | event | sessions-thousands-near-cap |
| 422 | Binary rollback to an older same-schema build and re-upgrade: companion tables ignored, features disabled, stale projections | docs/reference/database-schemas/versioning.md "Versioning contract"; docs/gateway/restart-recovery.md "What survives a restart"; docs/reference/database-schemas/versioning.md "Versioning contract", "Profile-owned skill library" | event | none |
| 423 | Agent schema bump that older code cannot read (cold storage 20, canonical validation 21, compact payloads 23) | docs/reference/database-schemas/versioning.md "Versioning contract" | ambient | transcripts-cold-stored |
| 424 | Manual npm install bypasses the updater guard; database open still refuses an incompatible build | docs/reference/database-schemas/versioning.md "Versioning contract" | ambient | install-npm-global |
| 425 | Profile-owned skill library tables present when changing builds | docs/reference/database-schemas/versioning.md "Profile-owned skill library" | ambient | none |
| 426 | Target package without schema metadata checked against the schema-1 contract | docs/reference/database-schemas/integrity-and-recovery.md "Why you cannot go back after updating to 2026.7.2" | ambient | none |
| 427 | Linked source checkout reports its build commit, not HEAD | docs/reference/database-schemas/integrity-and-recovery.md "The Gateway refuses to start with a newer schema version error" | ambient | install-git-checkout |
| 428 | Config health-state write failing: reported once per database per process | docs/reference/database-schemas/integrity-and-recovery.md "The Gateway refuses to start with a newer schema version error" | ambient | none |
| 429 | Accepted Control UI follow-ups in the browser outbox re-admitted after reconnect | docs/gateway/restart-recovery.md "What survives a restart" | event | none |
| 430 | Control UI tab open while an update replaces the bundled UI: one reload per reported build | docs/gateway/restart-recovery.md "What survives a restart"; docs/web/control-ui/settings.md "Updates" | event | none |
| 431 | Downgrade to 2026.9.2 with newer accepted-input receipts: same-ID retries rejected | docs/gateway/restart-recovery.md "What survives a restart" | ambient | none |
| 432 | Queued outbound deliveries and cron schedules survive a restart | docs/gateway/restart-recovery.md "What survives a restart" | ambient | cron-job-isolated |
| 433 | Startup migration warnings: Gateway starts degraded, warning report in status and Doctor | docs/gateway/restart-recovery.md "Graceful restarts drain first" | ambient | none |
| 434 | Read-only RPC waits get UNAVAILABLE gateway-restarting during drain | docs/gateway/restart-recovery.md "Graceful restarts drain first" | ambient | mock-provider-held-turn |
| 435 | Cron run in flight during shutdown: cleanup window for result writes | docs/gateway/restart-recovery.md "Graceful restarts drain first" | ambient | cron-job-isolated |
| 436 | Restart preparation cannot verify service command or owner: GATEWAY_RESTART_PREPARATION_REFUSED | docs/gateway/restart-recovery.md "Graceful restarts drain first" | ambient | none |
| 437 | Older systemd service with KillMode=control-group interrupts children immediately | docs/gateway/restart-recovery.md "Graceful restarts drain first" | ambient | service-definition-outdated |
| 438 | Short systemd stop timeout: drain and reserve clamped; unreadable service uses 90 seconds | docs/gateway/restart-recovery.md "Systemd stop deadlines"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/gateway/restart-recovery.md "Systemd stop deadlines", "Launchd stop deadlines" | ambient | service-definition-outdated |
| 439 | launchd ExitTimeOut budgets | docs/gateway/restart-recovery.md "Launchd stop deadlines"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway"; docs/gateway/restart-recovery.md "Systemd stop deadlines", "Launchd stop deadlines" | ambient | service-definition-legacy |
| 440 | Pending approvals, questions and node replies answerable during drain | docs/gateway/restart-recovery.md "Systemd stop deadlines" | ambient | none |
| 441 | Host sleep or process freeze detected: channels restarted once idle | docs/gateway/restart-recovery.md "Host sleep and process freezes" | event | channels-test-accounts |
| 442 | Exit 79 keeps the Gateway parked unless the updater supplies a verified recovery | docs/gateway/restart-recovery.md "Recovery after a failed update" | event | none |
| 443 | Helper result missing, malformed or interrupted: activation left to the operator | docs/gateway/restart-recovery.md "Recovery after a failed update" | event | none |
| 444 | Cancellation before package mutation restores the original service | docs/gateway/restart-recovery.md "Recovery after a failed update" | event | install-npm-global |
| 445 | Crash-loop breaker: three unclean boots in five minutes suppress channel autostart and pause recovery | docs/gateway/restart-recovery.md "Safety valves and observability" | event | channels-test-accounts |
| 446 | Previously active sessions at update time reach a resumed or terminal state after the update | docs/gateway/restart-recovery.md "Verify recovery after an update" | ambient | mock-provider-held-turn |
| 447 | Messages arriving during the drain window rejected with a restart error | docs/gateway/restart-recovery.md "What is not resumed" | ambient | session-main-rolling |
| 448 | Restart with active work: --safe defers until idle then forces; --skip-deferral bypasses the gate | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | ambient | mock-provider-held-turn |
| 449 | Work ignores cancellation at the native deadline: stability bundle, exit 0, fresh Gateway | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | event | mock-provider-held-turn |
| 450 | Same signal three times in five minutes: hint about another supervisor | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | event | none |
| 451 | Shared-state database unreadable: gateway status --deep exits 1 naming it | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | ambient | none |
| 452 | Restart during an upgrade records intent without migrating; no state database skips it | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | ambient | none |
| 453 | Standalone restart while startup migration progresses: still-starting exit 2 within five minutes | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | event | sessions-thousands-near-cap |
| 454 | State selectors pointing outside the account home: isolated, no service management | docs/cli/gateway/restart-and-supervision.md "Install identity" | ambient | none |
| 455 | Several custom services match: OPENCLAW_SYSTEMD_UNIT required; duplicate user and system services | docs/cli/gateway/restart-and-supervision.md "Install identity"; docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | ambient | none |
| 456 | Sealed or unsafe service definition: gateway install --force refused | docs/cli/gateway/restart-and-supervision.md "Install identity"; docs/cli/update/how-updates-run.md "Update validation and service definitions" | ambient | none |
| 457 | Database ownership claimed by an external supervisor: unmarked writable opens fail | docs/cli/gateway/restart-and-supervision.md "External supervisors" | ambient | none |
| 458 | Restart handoff consume with a mismatched, missing or expired handoff | docs/cli/gateway/restart-and-supervision.md "External supervisors" | event | none |
| 459 | Interactive setup prompt open at stop or restart: closed before drain | docs/cli/gateway/restart-and-supervision.md "Gateway profiling" | ambient | none |
| 460 | The update-check service is unreachable or returns an invalid response without interrupting startup (`telemetry-unreachable`) | docs/gateway/telemetry.md "Daily update check" | event | registry-local-mirror |
| 461 | A successful update check is cached for 24 hours and rechecked during maintenance with random delay (`telemetry-cached`) | docs/gateway/telemetry.md "Daily update check" | ambient | registry-local-mirror |
| 462 | Replacement endpoint set (OPENCLAW_TELEMETRY_ENDPOINT) | docs/gateway/telemetry.md "Daily update check"; docs/gateway/telemetry.md "Automated environments" | ambient | none |
| 463 | Automated environment (CI set): no update check or statistics | docs/gateway/telemetry.md "Automated environments" | ambient | none |
| 464 | Completed run shown on the sidebar card for 24 hours until acknowledged | docs/web/control-ui/settings.md "Updates" | ambient | update-history-failed |
| 465 | Campaign target fixed while the installed revision changes: no outdated count or link | docs/web/control-ui/settings.md "Updates" | ambient | install-git-checkout |
| 466 | Older Linux host without openat2: older images report a false Gateway owner | docs/install/docker.md "Upgrading container images" | ambient | none |
| 467 | Interrupted pre-startup migration backup: retries reuse the completed group; damaged member stops migration | docs/install/docker.md "Upgrading container images" | event | none |
| 468 | Restart policy loop on an unsafe migration: run Doctor once in the container | docs/install/docker.md "Upgrading container images" | event | none |
| 469 | Update wizard selects dev without a Git checkout: offers to create one | docs/cli/update.md "`update wizard`" | ambient | none |
| 470 | Installed 2026.9.3 or 2026.9.4 updater caps rehearsal and snapshot at five minutes even with a larger --timeout | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/update-troubleshooting.md "Candidate migration rehearsal timeouts"; docs/install/update-troubleshooting.md "Published 2026.9.4 on large agent fleets"; docs/install/updating/update-methods.md "Stuck on 2026.9.3"; docs/install/update-troubleshooting.md "Reason codes" | ambient | none |
| 471 | Installed 2026.9.4 updater refuses with managed-service-preflight before the target runs | docs/install/updating.md "Recommended: `openclaw update`" | ambient | none |
| 472 | pnpm-owned installation whose older updater triggers an interactive build-approval prompt (IO error: not a terminal) | docs/install/updating.md "Recommended: `openclaw update`" | ambient | none |
| 473 | Running 2026.9.6 Gateway fails its first shutdown with ERR_MODULE_NOT_FOUND after an in-place package replacement | docs/install/updating.md "Recommended: `openclaw update`"; docs/cli/update.md "Usage" | event | install-npm-global |
| 474 | Published 2026.9.5 Gateways have no installation-replacement watcher | docs/cli/update/how-updates-run.md "When restart is skipped or fails" | ambient | none |
| 475 | Published 2026.8.2 CLI refuses updates on service-less Linux installs | docs/cli/update/how-updates-run.md "Linux without a service manager" | ambient | none |
| 476 | Installed 2026.9.7 or 2026.9.8 supervisor refuses candidate trees over 50,000 entries | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | none |
| 477 | Older updater without the paired-identity drain reports device identity required and waits for its deadline | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | none |
| 478 | Published 2026.9.5 resident keeps its startup stop budget after daemon-reload and omits write custody | docs/cli/update/how-updates-run.md "Validation and activation"; docs/gateway/restart-recovery.md "Maintenance custody observations"; docs/gateway/restart-recovery.md "Systemd stop deadlines" | ambient | none |
| 479 | Installed 2026.9.2 admits a new update while an older row remains running | docs/cli/update/status-and-history.md "Run history and reports"; docs/install/updating.md "Stale update history" | ambient | none |
| 480 | Older updater returns already-current with runtime-verification-failed | docs/cli/update/how-updates-run.md "Validation and activation" | ambient | none |
| 481 | Older updater fails at updater-runtime-retention | docs/cli/update.md "Candidate-owned admission" | ambient | none |
| 482 | Installed 2026.9.4 updater cannot use orphan-row recovery before updating itself | docs/cli/update.md "Usage" | ambient | none |
| 483 | Bun-hosted update driven by 2026.9.7 waits for idle candidate workers | docs/install/updating.md "Recommended: `openclaw update`" | ambient | none |
| 484 | Doctor's config write refused during an update: the update fails with the refusal and rollback keeps it as the reason | docs/cli/update/status-and-history.md "Run history and reports"; docs/cli/update/how-updates-run.md "Validation and activation"; docs/cli/update/how-updates-run.md "Plugin sync details"; docs/cli/update/repair-and-recovery.md "update repair" | event | none |
| 485 | Other foreign-key violations or structural damage refuse update admission (`db-structural-damage`) | docs/cli/update.md "Usage" | ambient | store-corrupt-generation |
| 486 | Writing the local Markdown report fails; a warning is printed and the outcome preserved (`report-write-fails`) | docs/cli/update.md "Usage" | event | none |
| 487 | A candidate state snapshot fails (active database, exec approvals or plugin phase named) (`snapshot-error`) | docs/cli/update.md "Usage" | event | none |
| 488 | An agent updates the Gateway that hosts its own session and must use the gateway tool's update.run action (`agent-own-gateway`) | docs/cli/update.md "Automation and SSH"; docs/install/updating.md "From chat" | ambient | mock-provider-tool-calls |
| 489 | No --timeout is given, so Doctor and finalization run without an aggregate deadline; an explicit limit bounds each phase (`timeout-omitted`) | docs/cli/update.md "Options"; docs/cli/update/repair-and-recovery.md "`update repair`" | ambient | none |
| 490 | A newer release than the installed one is available on the configured channel and is announced by the startup and daily checks (`update-available`) | docs/install/updating/automatic-updates.md "Auto-updater"; docs/gateway/telemetry.md "Daily update check"; docs/cli/update/status-and-history.md "`update status`"; docs/web/control-ui/settings.md "Updates" | ambient (setup) | registry-local-mirror |
| 491 | Plugins change during an otherwise current update, so a running managed Gateway restarts unless --no-restart (`plugins-changed-restart`) | docs/cli/update/how-updates-run.md "Validation and activation"; docs/install/updating.md "Recommended: `openclaw update`" | event | plugins-bundled-and-external |
| 492 | Schema state cannot be compared or a new database is unreadable by the previous package, refusing rollback with rollback-state-unverified (`rollback-state-unverified`) | docs/cli/update/how-updates-run.md "Compatibility-checked package rollback"; docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback"; docs/gateway/restart-recovery.md "Recovery after a failed update" | event | none |
| 493 | A chat-initiated update carries the requester's authority through Doctor, handoffs and repair workers (`chat-requester-authority`) | docs/cli/update/repair-and-recovery.md "Recover a failed update"; docs/install/updating.md "From chat" | ambient | gateway-multi-user-profiles |
| 494 | Recorded identity evidence is missing versus mismatched (Not verified / Failed badges) (`identity-unavailable`) | docs/cli/update/status-and-history.md "Run history and reports" | ambient | none |
| 495 | Recovery files have unexpected mode, link count or owner, producing permission refusals (`recovery-permissions`) | docs/cli/update/status-and-history.md "Run history and reports" | ambient | none |
| 496 | The Control UI cannot read fresh progress and shows the read error beside the last run (`progress-read-error`) | docs/cli/update/status-and-history.md "Run history and reports"; docs/install/update-troubleshooting.md "Recover in the Control UI" | event | none |
| 497 | Doctor imports channel state only for enabled channels (`disabled-channel-import`) | docs/install/updating.md "Upgrading very old versions" | ambient | channels-test-accounts |
| 498 | An enabled configured plugin has no version for the target in the registry, warning before the Gateway stops (`plugin-availability-preflight`) | docs/install/updating.md "Recommended: `openclaw update`" | event | registry-local-mirror |
| 499 | Gateway automatic updates are off by default; checks can be on or off independently (`auto-off-default`) | docs/install/updating/automatic-updates.md "Auto-updater"; docs/gateway/telemetry.md "Disable every automatic update request" | ambient | none |
| 500 | A Control UI update asks for confirmation first; cancel, Escape or dismiss leave the Gateway untouched (`ui-confirmation`) | docs/install/updating/automatic-updates.md "Update campaigns"; docs/web/control-ui/settings.md "Updates" | event | none |
| 501 | A raw npm i -g replacement keeps no previous package and runs no recovery workflow (`raw-npm-replacement`) | docs/install/updating/rollback-and-recovery.md "Downgrade"; docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun" | event | install-npm-global |
| 502 | The package install, staging, verification or launcher swap fails (global-install-failed) and rollback is attempted (`global-install-failed`) | docs/install/update-troubleshooting.md "Reason codes" | event | install-npm-global |
| 503 | The restart is unhealthy or its revision mismatches or is unavailable (`restart-unhealthy`) | docs/install/update-troubleshooting.md "Reason codes" | event | none |
| 504 | Switching channels syncs plugin sources (bundled for dev, registry for stable/beta) (`plugins-follow-channel`) | docs/install/development-channels.md "Plugins and channels" | event | plugins-bundled-and-external |
| 505 | Release tags in recognised forms (beta, legacy numeric, extended-stable patches) select Git targets (`git-tag-forms`) | docs/install/development-channels.md "Tagging best practices" | ambient | install-git-checkout |
| 506 | A named profile or custom state/config paths are pinned for triage and repair (`named-profile`) | docs/cli/triage.md "Installation target and embedded handoff"; docs/cli/gateway/restart-and-supervision.md "Install identity" | ambient | none |
| 507 | A support artifact cannot be saved, reporting the storage error (`triage-artifact-save-fails`) | docs/cli/triage.md "Output and exit codes" | event | none |
| 508 | Startup finds the webhook completion marker as the sole change or endpoints needing repair (`webhook-startup`) | docs/gateway/doctor/config-migrations.md "Channel webhook listeners" | event | none |
| 509 | An ACP agent's harness model differs from the native default (information notice) (`acp-model-precedence`) | docs/gateway/doctor/config-migrations.md "ACP agents' model precedence" | ambient | state-legacy-migratable |
| 510 | Pending delivery settlements or completion recovery exist and older builds may discard their metadata (`pending-settlements`) | docs/gateway/restart-recovery.md "What survives a restart" | ambient | session-main-rolling |
| 511 | Database closure refuses a follow-up drain, parking queued input (`drain-parks-input`) | docs/gateway/restart-recovery.md "Graceful restarts drain first" | event | none |
| 512 | Older persisted running or queued session statuses are normalised to interrupted at startup (`legacy-session-status`) | docs/gateway/restart-recovery.md "How interrupted work is detected" | ambient | none |
| 513 | Old scripts send SIGUSR1, which no longer restarts the Gateway (`sigusr1-legacy`) | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | ambient | none |
| 514 | A forced restart from an older caller without a drain budget gets at most 45 seconds (`force-old-caller`) | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | event | none |
| 515 | gateway restart runs inside the macOS LaunchAgent process tree and hands off to a detached helper (`restart-inside-launchagent`) | docs/cli/gateway/restart-and-supervision.md "Restart the Gateway" | event | none (macOS) |
| 516 | Service-managed profile names collide by case or with reserved labels, or custom service identity variables are set (`profile-service-names`) | docs/cli/gateway/restart-and-supervision.md "Install identity" | ambient | none |
| 517 | OPENCLAW_GATEWAY_RESTART_TRACE adds restart timing lines (`restart-timing-log`) | docs/cli/gateway/restart-and-supervision.md "Gateway profiling" | ambient | none |
| 518 | A custom container entrypoint bypasses Doctor activation (`custom-entrypoint`) | docs/install/docker.md "Upgrading container images" | ambient | none (container) |
| 519 | A Bun-only install's launcher is missing, relinked or names a moved Bun (`bun-launcher`) | docs/install/bun-compatibility.md "Bun-only installs" | ambient | none |
| 520 | A Windows Bun-only node host cannot stage updates and logs the failure hourly (`bun-windows-node`) | docs/install/bun-compatibility.md "Known limitations" | ambient | none (Windows) |

## Headings walked
docs/cli/update.md "openclaw update": 1, 2, 3, 4, 5, 65
docs/cli/update.md "Usage": 1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 473, 482, 485, 486, 487
docs/cli/update.md "Immutable release installations": 37, 38, 39, 40, 41, 42
docs/cli/update.md "Candidate-owned admission": 5, 8, 9, 10, 14, 15, 43, 44, 45, 46, 47, 48, 49, 50, 51, 481
docs/cli/update.md "Automation and SSH": 52, 53, 54, 74, 86, 87, 88, 488
docs/cli/update.md "Native service commands during updates": 1, 5, 55, 56, 57
docs/cli/update.md "Options": 5, 6, 7, 52, 53, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 116, 117, 218, 489
docs/cli/update.md "update wizard": 469
docs/cli/update.md "Detailed topics": none
docs/cli/update.md "Related": 163, 164
docs/cli/update/how-updates-run.md "(introduction)": none
docs/cli/update/how-updates-run.md "What it does": 75, 76, 77, 163, 164
docs/cli/update/how-updates-run.md "Validation and activation": 1, 5, 8, 61, 62, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 140, 260, 470, 476, 477, 478, 480, 484, 491
docs/cli/update/how-updates-run.md "Recovery limits": 5, 105, 106, 107, 120, 121, 135, 136, 137, 138, 139, 140
docs/cli/update/how-updates-run.md "Compatibility-checked package rollback": 20, 21, 105, 106, 107, 141, 142, 171, 304, 492
docs/cli/update/how-updates-run.md "Restart handoff": 1, 5, 130, 131, 143, 144, 145, 146, 147, 148, 149, 150, 151
docs/cli/update/how-updates-run.md "Update validation and service definitions": 56, 57, 84, 85, 456
docs/cli/update/how-updates-run.md "Shell installers": 152
docs/cli/update/how-updates-run.md "Linux without a service manager": 94, 95, 475
docs/cli/update/how-updates-run.md "Node runtime for package-manager updates": 68, 69
docs/cli/update/how-updates-run.md "macOS LaunchAgent verification": 153
docs/cli/update/how-updates-run.md "When restart is skipped or fails": 80, 154, 155, 156, 157, 158, 159, 474
docs/cli/update/how-updates-run.md "Control-plane response shape": 30, 31, 32, 160, 161, 162
docs/cli/update/how-updates-run.md "Git checkout flow": 163, 164
docs/cli/update/how-updates-run.md "Channel selection": 163, 164
docs/cli/update/how-updates-run.md "Update steps": 8, 20, 21, 33, 34, 35, 36, 72, 81, 82, 110, 120, 121, 127, 165, 166, 167, 168, 169, 170, 171, 172
docs/cli/update/how-updates-run.md "Plugin sync details": 114, 124, 125, 173, 174, 175, 176, 177, 178, 179, 180, 181, 484
docs/cli/update/how-updates-run.md "Package-manager installs": 1, 2, 98, 182, 183, 184, 185, 186, 317, 319
docs/cli/update/how-updates-run.md "Local packaged overrides": 187
docs/cli/update/how-updates-run.md "(intro)": none
docs/cli/update/repair-and-recovery.md "(introduction)": none
docs/cli/update/repair-and-recovery.md "Recover a failed update": 17, 20, 21, 22, 29, 52, 53, 105, 106, 107, 127, 188, 189, 190, 191, 192, 193, 194, 195, 493
docs/cli/update/repair-and-recovery.md "Original state captures": 196, 197, 198, 199, 200
docs/cli/update/repair-and-recovery.md "Retained updater runtime": 1, 5, 44, 45, 46, 47
docs/cli/update/repair-and-recovery.md "Candidate Doctor stack overflow": 201
docs/cli/update/repair-and-recovery.md "Docker image-layer package updates": 44, 45, 46
docs/cli/update/repair-and-recovery.md "update repair": 1, 3, 18, 25, 116, 117, 134, 173, 179, 182, 183, 184, 185, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 254, 255, 489
docs/cli/update/repair-and-recovery.md "Skipped legacy audit recovery": 196, 198, 199
docs/cli/update/repair-and-recovery.md "update cleanup": 219, 220, 221
docs/cli/update/repair-and-recovery.md "(intro)": none
docs/cli/update/status-and-history.md "(introduction)": none
docs/cli/update/status-and-history.md "update status": 37, 155, 156, 166, 215, 216, 222, 223, 224, 225, 226, 490
docs/cli/update/status-and-history.md "Run history and reports": 29, 30, 31, 32, 33, 34, 35, 36, 58, 59, 60, 65, 92, 103, 105, 106, 107, 128, 129, 130, 131, 165, 187, 205, 209, 210, 211, 212, 222, 227, 228, 229, 230, 231, 232, 233, 234, 289, 479, 484, 494, 495, 496
docs/cli/update/status-and-history.md "(intro)": none
docs/install/updating.md "(introduction)": 235, 236
docs/install/updating.md "Retired tenant-container management": 237
docs/install/updating.md "Upgrading very old versions": 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 319, 497
docs/install/updating.md "Recommended: openclaw update": 1, 5, 8, 14, 15, 33, 34, 35, 36, 49, 68, 69, 84, 85, 91, 94, 95, 108, 116, 117, 124, 125, 133, 143, 172, 176, 182, 183, 184, 185, 215, 216, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 274, 335, 471, 472, 473, 483, 491, 498
docs/install/updating.md "Package-publication recovery": 71, 75, 76, 102, 174, 175, 181, 202, 203, 256, 262, 263, 264
docs/install/updating.md "Updating from 2026.9.2 across a schema bump": 234
docs/install/updating.md "From chat": 143, 147, 265, 266, 267, 268, 269, 270, 271, 272, 273, 295, 488, 493
docs/install/updating.md "Inspect FreeBSD service discovery": 274
docs/install/updating.md "Stale update history": 209, 210, 211, 212, 214, 229, 479
docs/install/updating.md "Retire update recovery data": 219, 220
docs/install/updating.md "After updating": 275
docs/install/updating.md "Run doctor": 275
docs/install/updating.md "Restart the gateway": none
docs/install/updating.md "Verify": none
docs/install/updating.md "Background exec notifications after an update": 276
docs/install/updating.md "Detailed topics": none
docs/install/updating.md "Related": none
docs/install/updating.md "(intro)": 235, 236
docs/install/updating/automatic-updates.md "(introduction)": none
docs/install/updating/automatic-updates.md "Headless node updates": 151, 277, 278, 279, 280, 281, 282, 283, 290
docs/install/updating/automatic-updates.md "Auto-updater": 75, 76, 145, 146, 151, 284, 285, 286, 287, 490, 499
docs/install/updating/automatic-updates.md "Update campaigns": 86, 87, 88, 151, 160, 161, 265, 266, 269, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 500
docs/install/updating/automatic-updates.md "(intro)": none
docs/install/updating/rollback-and-recovery.md "(introduction)": none
docs/install/updating/rollback-and-recovery.md "Before you upgrade": 5, 68, 69, 94, 95, 254, 255
docs/install/updating/rollback-and-recovery.md "Downgrade": 74, 99, 290, 298, 299, 300, 301, 302, 501
docs/install/updating/rollback-and-recovery.md "Full-state recovery requires a backup": 1, 105, 106, 107, 135, 136, 137, 138, 139, 140
docs/install/updating/rollback-and-recovery.md "Automatic schema-neutral rollback": 20, 21, 22, 105, 106, 107, 128, 129, 141, 182, 183, 184, 185, 303, 304, 305, 492
docs/install/updating/rollback-and-recovery.md "Before updating: create a verified backup": 306
docs/install/updating/rollback-and-recovery.md "If you are stuck": 169, 188, 190, 307, 308
docs/install/updating/rollback-and-recovery.md "Unattended repair on your own inference": 61, 62, 127, 190
docs/install/updating/rollback-and-recovery.md "(intro)": none
docs/install/updating/update-methods.md "(introduction)": none
docs/install/updating/update-methods.md "Switch between npm and git installs": 20, 21, 56, 57, 75, 76, 81, 82, 153, 163, 164, 182, 183, 184, 185, 309, 310
docs/install/updating/update-methods.md "Source-checkout servers (reference script)": 79, 81, 82, 311, 312, 313, 314
docs/install/updating/update-methods.md "Alternative: re-run the installer": 315
docs/install/updating/update-methods.md "Homebrew formula installs": 254, 255, 316
docs/install/updating/update-methods.md "Alternative: manual npm, pnpm, or bun": 2, 33, 34, 35, 36, 155, 156, 182, 183, 184, 185, 317, 318, 319, 320, 321, 501
docs/install/updating/update-methods.md "Package lifecycle and operator state": 1, 5, 322, 323
docs/install/updating/update-methods.md "Stuck on 2026.9.3": 322, 470
docs/install/updating/update-methods.md "Advanced npm install topics": 116, 117, 120, 121, 321, 324
docs/install/updating/update-methods.md "(intro)": none
docs/install/update-troubleshooting.md "(introduction)": 17, 23, 24, 30, 31, 32, 61, 62, 119, 160, 161, 307, 325, 326, 328
docs/install/update-troubleshooting.md "Recover in the Control UI": 328, 496
docs/install/update-troubleshooting.md "Doctor cannot enter maintenance during finalization": 1, 134, 208
docs/install/update-troubleshooting.md "Node and global install permissions": 2, 33, 34, 35, 36, 68, 69, 100, 101, 329
docs/install/update-troubleshooting.md "System-scope systemd services": 155, 156, 330, 331
docs/install/update-troubleshooting.md "Candidate migration rehearsal timeouts": 116, 117, 119, 332, 470
docs/install/update-troubleshooting.md "Published 2026.9.4 on large agent fleets": 333, 470
docs/install/update-troubleshooting.md "Headless nodes waiting on 2026.9.6": 277, 278
docs/install/update-troubleshooting.md "Plugin repair warnings": 14, 15, 114, 179, 180
docs/install/update-troubleshooting.md "Missing temporary plugin captures": 334
docs/install/update-troubleshooting.md "Database snapshots under continuous writes": 116, 117
docs/install/update-troubleshooting.md "Snapshot parse errors from 2026.9.5 and 2026.9.6": 261, 335
docs/install/update-troubleshooting.md "Large model-catalog temporary directories": 336
docs/install/update-troubleshooting.md "Reason codes": 33, 34, 35, 36, 72, 96, 97, 154, 176, 227, 271, 337, 338, 470, 502, 503
docs/install/update-troubleshooting.md "Retained legacy session history": 215, 216, 339
docs/install/update-troubleshooting.md "CLI fallback": 104, 338, 340, 341
docs/install/update-troubleshooting.md "Rollback boundary": none
docs/install/update-troubleshooting.md "Support diagnostics": none
docs/install/update-troubleshooting.md "(intro)": 17, 23, 24, 28, 30, 31, 32, 119, 160, 161, 190, 307, 325, 326, 327
docs/install/development-channels.md "(introduction)": 75, 76, 151
docs/install/development-channels.md "Switching channels": 75, 76, 163, 164, 287, 342, 343, 344
docs/install/development-channels.md "One-off version or tag targeting": 71, 74
docs/install/development-channels.md "Dry run": 74
docs/install/development-channels.md "Plugins and channels": 174, 175, 181, 504
docs/install/development-channels.md "Checking current status": 165, 285, 345
docs/install/development-channels.md "Tagging best practices": 505
docs/install/development-channels.md "macOS app availability": none
docs/install/development-channels.md "Related": none
docs/install/development-channels.md "(intro)": 75, 76, 151
docs/gateway/troubleshooting/updates-and-rollbacks.md "After an update": 162, 346, 347
docs/gateway/troubleshooting/updates-and-rollbacks.md "Prepared model runtime publication timeout": 348
docs/gateway/troubleshooting/updates-and-rollbacks.md "Split brain installs and newer config guard": 300
docs/gateway/troubleshooting/updates-and-rollbacks.md "Protocol mismatch after rollback": 349
docs/cli/triage.md "openclaw triage": 188, 350, 351
docs/cli/triage.md "Failed update recovery": 189, 190, 307, 352
docs/cli/triage.md "Installation target and embedded handoff": 1, 61, 62, 353, 354, 355, 356, 506
docs/cli/triage.md "Manual handoff": 188
docs/cli/triage.md "Automatic failure handoff": 1, 145, 146, 195, 206, 291, 292, 340, 357, 358, 359, 360, 361, 362, 363, 364
docs/cli/triage.md "Output and exit codes": 340, 507
docs/cli/triage.md "Options": none
docs/cli/doctor/state-migrations.md "(introduction)": 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 365, 366, 367
docs/cli/doctor/state-migrations.md "Legacy state migration": 66, 236, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 333, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, 390
docs/cli/doctor/state-migrations.md "Pending plugin migrations": 215, 216, 391
docs/cli/doctor/state-migrations.md "(intro)": none
docs/gateway/doctor/config-migrations.md "(introduction)": 180
docs/gateway/doctor/config-migrations.md "Runtime config migration": 9, 10
docs/gateway/doctor/config-migrations.md "Command-owner target kinds": 392
docs/gateway/doctor/config-migrations.md "Retention policy": 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248
docs/gateway/doctor/config-migrations.md "Deferred compaction checkpoints": 393
docs/gateway/doctor/config-migrations.md "Workspace setup": 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 374
docs/gateway/doctor/config-migrations.md "Session settings": 394
docs/gateway/doctor/config-migrations.md "Retired state and config formats": 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 395, 396
docs/gateway/doctor/config-migrations.md "Cron ownership before roster migration": 397, 398
docs/gateway/doctor/config-migrations.md "Legacy cron delivery settings": 397, 398
docs/gateway/doctor/config-migrations.md "Exec approval policy": 381, 382
docs/gateway/doctor/config-migrations.md "Claw provenance schema": 399
docs/gateway/doctor/config-migrations.md "Channel account routing during an update": 400
docs/gateway/doctor/config-migrations.md "Channel ownership during an update": 401, 402
docs/gateway/doctor/config-migrations.md "Sender tool policies": 403
docs/gateway/doctor/config-migrations.md "Agent roster migration": 304, 401, 402
docs/gateway/doctor/config-migrations.md "Channel private-network opt-ins": 404
docs/gateway/doctor/config-migrations.md "Channel webhook listeners": 405, 508
docs/gateway/doctor/config-migrations.md "Talk realtime inheritance": 406
docs/gateway/doctor/config-migrations.md "ACP session metadata": 407
docs/gateway/doctor/config-migrations.md "ACP agents' model precedence": 509
docs/gateway/doctor/config-migrations.md "Missing plugins during migration": 215, 216, 391, 408
docs/gateway/doctor/config-migrations.md "Retired TaskFlow Webhooks plugin": 409
docs/gateway/doctor/config-migrations.md "Schema publication during a 2026.9.2 update": 234
docs/gateway/doctor/config-migrations.md "Native Codex recovery after Tasks removal": 410
docs/gateway/doctor/config-migrations.md "Replay a July 2026 config upgrade": 411, 412
docs/gateway/doctor/config-migrations.md "Auth credential fields": 413
docs/gateway/doctor/config-migrations.md "Checks 0-2": 9, 10, 163, 164, 172, 401, 402, 414, 415, 416, 417, 418
docs/gateway/doctor/config-migrations.md "(intro)": 180
docs/reference/database-schemas/versioning.md "Versioning contract": 67, 419, 420, 421, 422, 423, 424
docs/reference/database-schemas/versioning.md "Schema bumps and older updaters": 234
docs/reference/database-schemas/versioning.md "Profile-owned skill library": 422, 425
docs/reference/database-schemas/integrity-and-recovery.md "Integrity checks": none
docs/reference/database-schemas/integrity-and-recovery.md "Startup on multi-agent hosts": none
docs/reference/database-schemas/integrity-and-recovery.md "btrfs and NOCOW": none
docs/reference/database-schemas/integrity-and-recovery.md "Planner statistics maintenance": none
docs/reference/database-schemas/integrity-and-recovery.md "Troubleshooting": none
docs/reference/database-schemas/integrity-and-recovery.md "The state database is busy": none
docs/reference/database-schemas/integrity-and-recovery.md "Database paths cannot be compared": none
docs/reference/database-schemas/integrity-and-recovery.md "A mount check times out while opening a local database": none
docs/reference/database-schemas/integrity-and-recovery.md "A legacy Workshop index prevents shared-state reads": none
docs/reference/database-schemas/integrity-and-recovery.md "The shared-state WAL keeps growing": none
docs/reference/database-schemas/integrity-and-recovery.md "Doctor reports orphan task delivery rows": 16
docs/reference/database-schemas/integrity-and-recovery.md "Why you cannot go back after updating to 2026.7.2": 74, 419, 426
docs/reference/database-schemas/integrity-and-recovery.md "The Gateway refuses to start with a newer schema version error": 419, 427, 428
docs/reference/database-schemas/integrity-and-recovery.md "A database is quarantined after integrity verification failed": none
docs/reference/database-schemas/integrity-and-recovery.md "Downgrade recovery": 74
docs/gateway/restart-recovery.md "(introduction)": none
docs/gateway/restart-recovery.md "What survives a restart": 162, 288, 422, 429, 430, 431, 432, 510
docs/gateway/restart-recovery.md "Graceful restarts drain first": 84, 85, 86, 87, 88, 433, 434, 435, 436, 437, 511
docs/gateway/restart-recovery.md "Maintenance custody observations": 86, 87, 88, 478
docs/gateway/restart-recovery.md "Systemd stop deadlines": 84, 85, 86, 87, 88, 148, 438, 439, 440, 478
docs/gateway/restart-recovery.md "Launchd stop deadlines": 84, 85, 438, 439
docs/gateway/restart-recovery.md "Host sleep and process freezes": 158, 441
docs/gateway/restart-recovery.md "Recovery after a failed update": 1, 5, 17, 20, 21, 105, 106, 107, 108, 118, 126, 127, 153, 188, 190, 442, 443, 444, 492
docs/gateway/restart-recovery.md "How interrupted work is detected": 512
docs/gateway/restart-recovery.md "Automatic resume": none
docs/gateway/restart-recovery.md "Subagents": none
docs/gateway/restart-recovery.md "Agent-requested restarts": none
docs/gateway/restart-recovery.md "Safety valves and observability": 357, 445
docs/gateway/restart-recovery.md "Verify recovery after an update": 86, 87, 88, 446
docs/gateway/restart-recovery.md "What is not resumed": 288, 447
docs/gateway/restart-recovery.md "(intro)": none
docs/cli/gateway/restart-and-supervision.md "(introduction)": none
docs/cli/gateway/restart-and-supervision.md "Restart the Gateway": 1, 5, 86, 87, 88, 118, 130, 131, 148, 252, 419, 438, 439, 448, 449, 450, 451, 452, 453, 455, 513, 514, 515
docs/cli/gateway/restart-and-supervision.md "Install identity": 454, 455, 456, 506, 516
docs/cli/gateway/restart-and-supervision.md "External supervisors": 213, 291, 292, 457, 458
docs/cli/gateway/restart-and-supervision.md "Gateway profiling": 459, 517
docs/cli/gateway/restart-and-supervision.md "(intro)": none
docs/web/control-ui/settings.md "(introduction)": none
docs/web/control-ui/settings.md "Environment identity": none
docs/web/control-ui/settings.md "Browser tab icon": none
docs/web/control-ui/settings.md "Community invitation": none
docs/web/control-ui/settings.md "Personal identity": none
docs/web/control-ui/settings.md "Gateway host status": none
docs/web/control-ui/settings.md "Language support": none
docs/web/control-ui/settings.md "Appearance themes": none
docs/web/control-ui/settings.md "Opening links": none
docs/web/control-ui/settings.md "Session sources": none
docs/web/control-ui/settings.md "Manage plugins": none
docs/web/control-ui/settings.md "Updates": 285, 287, 296, 297, 325, 326, 328, 430, 464, 465, 490, 500
docs/web/control-ui/settings.md "Apps and extensions": none
docs/web/control-ui/settings.md "Settings": none
docs/web/control-ui/settings.md "Side panel keyboard shortcuts": none
docs/web/control-ui/settings.md "This device (macOS and iOS apps)": none
docs/web/control-ui/settings.md "Custom plugin UI": none
docs/web/control-ui/settings.md "Import assistant memory": none
docs/web/control-ui/settings.md "MCP page": none
docs/web/control-ui/settings.md "Activity tab": none
docs/web/control-ui/settings.md "Meetings page": none
docs/web/control-ui/settings.md "(intro)": none
docs/gateway/telemetry.md "(introduction)": none
docs/gateway/telemetry.md "Inspect what is sent": none
docs/gateway/telemetry.md "Daily update check": 460, 461, 462, 490
docs/gateway/telemetry.md "Approximate location": none
docs/gateway/telemetry.md "Optional anonymous feature statistics": none
docs/gateway/telemetry.md "What is not sent or stored": none
docs/gateway/telemetry.md "Turn anonymous feature statistics on or off": none
docs/gateway/telemetry.md "Automated environments": 462, 463
docs/gateway/telemetry.md "Disable every automatic update request": 290, 499
docs/gateway/telemetry.md "(intro)": none
docs/tools/slash-commands.md "(introduction)": none
docs/tools/slash-commands.md "Three command types": none
docs/tools/slash-commands.md "Configuration": 267, 270, 271, 392
docs/tools/slash-commands.md "Command list": none
docs/tools/slash-commands.md "Core commands": 265, 266, 270, 271
docs/tools/slash-commands.md "Bundled plugin commands": none
docs/tools/slash-commands.md "Skill commands": none
docs/tools/slash-commands.md "/tools: what the agent can use now": none
docs/tools/slash-commands.md "/loop: recurring conversation work": none
docs/tools/slash-commands.md "/model: model selection": none
docs/tools/slash-commands.md "/config: on-disk config writes": none
docs/tools/slash-commands.md "/mcp: MCP server config": none
docs/tools/slash-commands.md "/debug: runtime-only overrides": none
docs/tools/slash-commands.md "/plugins: plugin management": none
docs/tools/slash-commands.md "/trace: plugin trace output": none
docs/tools/slash-commands.md "/btw: side questions": none
docs/tools/slash-commands.md "Surface notes": none
docs/tools/slash-commands.md "Provider usage and status": none
docs/tools/slash-commands.md "Related": none
docs/tools/slash-commands.md "(intro)": none
docs/install/docker.md "(introduction)": none
docs/install/docker.md "Prerequisites": none
docs/install/docker.md "Containerized Gateway": none
docs/install/docker.md "Using the Control UI browser": none
docs/install/docker.md "Headless bootstrap": none
docs/install/docker.md "Manual flow": none
docs/install/docker.md "Upgrading container images": 198, 199, 220, 236, 369, 370, 420, 421, 466, 467, 468, 518
docs/install/docker.md "Source-built images with selected plugins": none
docs/install/docker.md "Observability": none
docs/install/docker.md "Health checks": none
docs/install/docker.md "Detailed topics": none
docs/install/docker.md "Related": none
docs/install/docker.md "(intro)": none
docs/install/bun-compatibility.md "(introduction)": none
docs/install/bun-compatibility.md "Requirements": none
docs/install/bun-compatibility.md "macOS app private runtime": none
docs/install/bun-compatibility.md "SQLite library selection on macOS": 182, 183, 184, 185
docs/install/bun-compatibility.md "Memory search without an extension-capable library": none
docs/install/bun-compatibility.md "Browser subprocesses": none
docs/install/bun-compatibility.md "Bun-only installs": 182, 183, 184, 185, 519
docs/install/bun-compatibility.md "SQLite worker lifecycle": 182, 183, 184, 185
docs/install/bun-compatibility.md "Known limitations": 182, 183, 184, 185, 520
docs/install/bun-compatibility.md "History across releases": none
docs/install/bun-compatibility.md "Related": none

## Breaks cross-check

All six historical update breaks are outside reach from OCM-supervised clones. The original mappings remain part of the saved derivations; they do not establish coverage in the retained template.

| Break | Phase | Why outside reach |
| --- | --- | --- |
| 155433 | none | Native managed update.run handoff and the macOS LaunchAgent stop guard require native service ownership. OCM can handle update.run before the native updater is entered. |
| 150816 | none | The affected Bun activation and startup cleanup are reached by a mutating native update, which external supervision refuses. |
| 161813 | none | Reading the receipt and continuing Doctor from inside the replaced installation requires native updater mutation; external supervision refuses it first. |
| 162604 | none | The activation Doctor write refusal, progress writer and native rollback decision require native updater activation. |
| 159504 | none | The native older-updater journey is unavailable under OCM supervision. Independently, the pinned 2026.9.9 updater already ignores the canary progress marker; reproducing the historical diagnostic needs an affected older driver. |
| 156633 | none | The interactive failure menu follows a failed mutating native update, which external supervision refuses before activation. |
| 153984 | none | Test-only: its only change inside the globs is src/cli/daemon-cli/restart-health-client.test.ts; not counted. |

The source boundary is documented in [coverage.md](coverage.md#ocm-only-scope).

## Undocumented conditions
none: every condition added at step 6 cites a listed document

## Reconciliation

The following records the historical reconciliation. The OCM-only disposition below supersedes executable phase and coverage claims for removed native paths, while preserving the full inventory.
Operator-scheduled automation calling gateway update.run: from run 1 only; entry point kept (reconciliation adds)
Ask OpenClaw update-failure alert and its "Review update" action: from run 1 only; entry point kept (reconciliation adds)
Post-core plugin sync during openclaw update (docs/cli/update/how-updates-run.md "Plugin sync details"): from run 1 only; entry point kept (reconciliation adds)
Pending plugin migrations Doctor runs (docs/cli/doctor/state-migrations.md "Pending plugin migrations"): from run 1 only; entry point kept (reconciliation adds)
openclaw gateway restart-handoff: command group only; its capabilities and consume subcommands are listed: from run 1 only; entry point kept (reconciliation adds)
package-publication recovery helper `status --anchor --operation`: from run 2 only; entry point kept
package-publication recovery helper `repair --anchor --operation`: from run 2 only; entry point kept
package-publication recovery helper `retire --anchor --operation`: from run 2 only; entry point kept
pnpm test:startup:gateway: test-only: repository benchmark: from run 2 only; entry point kept
pnpm test:restart:gateway: test-only: repository benchmark: from run 2 only; entry point kept
`openclaw node run`: consumed from nodes: from run 2 only; entry point kept
`openclaw plugins install`: consumed from plugins: from run 2 only; entry point kept
`openclaw plugins disable`: consumed from plugins: from run 2 only; entry point kept
`openclaw plugins enable`: consumed from plugins: from run 2 only; entry point kept
`openclaw plugins reload`: consumed from plugins: from run 2 only; entry point kept
`openclaw browser doctor`: consumed from browser: from run 2 only; entry point kept
`openclaw agents add`: consumed from agents: from run 2 only; entry point kept
`openclaw agents delete`: consumed from agents: from run 2 only; entry point kept
`openclaw channels remove`: consumed from channels: from run 2 only; entry point kept
`openclaw channels status`: consumed from channels: from run 2 only; entry point kept
`openclaw onboard`: consumed from install: from run 2 only; entry point kept
`openclaw models auth login`: consumed from models: from run 2 only; entry point kept
`openclaw memory status`: consumed from memory: from run 2 only; entry point kept
`openclaw config unset`: consumed from config: from run 2 only; entry point kept
`openclaw doctor --session-sqlite`: consumed from sessions: from run 2 only; entry point kept
`openclaw sessions`: consumed from sessions: from run 2 only; entry point kept
`openclaw doctor --lint`: consumed from doctor: from run 2 only; entry point kept
`openclaw doctor --deep`: consumed from doctor: from run 2 only; entry point kept
Condition 4 (Unrecognized installation root: target preflight skipped, commands to locate the owner printed): from run 2 only; kept
Condition 13 (Older updater reports database-schema-preflight with mode unknown (2026.9.4)): from run 2 only; kept
Condition 28 (Interrupted pre-create report preparation becomes retryable after its reservation expires): from run 2 only; kept
Condition 41 (Immutable target with incompatible migration requirements refused before drain): from run 2 only; kept
Condition 42 (Hot SQLite rollback journal left in the installation control after an updater crash): from run 2 only; kept
Condition 43 (Candidate refuses or fails before mutation: stage removed, installed package and Gateway kept): from run 2 only; kept
Condition 54 (An active chat session does not block an explicit update): from run 2 only; kept
Condition 59 (Historical package backups present: a later verified activation retires them; failures preserve them): from run 2 only; kept
Condition 63 (No update active: status labels the saved outcome Last recorded update): from run 2 only; kept
Condition 79 (Git checkout advanced without rebuilding, or runtime artifacts missing: update still needed): from run 2 only; kept
Condition 83 (Source command through pnpm openclaw refuses an automatic rebuild while the Gateway runs): from run 2 only; kept
Condition 93 (Linux user-service supervisor inspection times out: one retry, second timeout leaves the Gateway running): from run 2 only; kept
Condition 102 (Other package tools or tools modify the installation during an update): from run 2 only; kept
Condition 113 (Disposable copy cleanup exceeds five minutes: warning, removal may finish in the background): from run 2 only; kept
Condition 115 (Old Gateway serving with a database schema older than the candidate during capability check): from run 2 only; kept
Condition 126 (Target predates migration continuation: runtime validation unavailable, no schema-neutral rollback): from run 2 only; kept
Condition 132 (Process or boot generation changes during verification: failure and recovery): from run 2 only; kept
Condition 133 (Plugin downloads count toward downtime; service stopped through convergence): from run 2 only; kept
Condition 138 (Failed candidate never allowed to start: databases restored before the package, migrated files kept as <database>.migrated-<runId>): from run 2 only; kept
Condition 139 (Snapshots taken while a Gateway may write (--no-restart) only for manual recovery): from run 2 only; kept
Condition 142 (Update fails before activation: recovery observes the existing Gateway once without restarting): from run 2 only; kept
Condition 144 (Service handoff records from 2026.9.2 or 2026.9.3; a different supervisor UID blocks service mutation): from run 2 only; kept
Condition 149 (Pinned Git update leaves the checkout detached; receipt preserves the upstream): from run 2 only; kept
Condition 157 (Updater-owned Doctor waits for a foreground Gateway to release state): from run 2 only; kept
Condition 159 (Package already replaced and Doctor failed on the live Gateway lock: repair from the updated installation): from run 2 only; kept
Condition 167 (Git pack above 256 MiB: size warning, capacity refusal when the object volume is short): from run 2 only; kept
Condition 169 (pnpm bootstrap through corepack fails: tool-specific early error): from run 2 only; kept
Condition 181 (Extended-stable core: official plugins target the exact installed core version): from run 2 only; kept
Condition 186 (npm link to a built Git checkout: rollback verifies that checkout; rebuilding it during the update prevents rollback): from run 2 only; kept
Condition 193 (Already-current installation needs plugin maintenance and a maintenance step is refused: restart after Doctor writers settle): from run 2 only; kept
Condition 194 (Reporting fails after a successful activation: installation kept, exit nonzero): from run 2 only; kept
Condition 195 (Initial-check rejections (arguments, external supervisor, store ownership, handoff identity, immutable config) collect no diagnostics): from run 2 only; kept
Condition 207 (Unfinished package or configuration rollback keeps the handoff; repair refuses until restoration completes): from run 2 only; kept
Condition 213 (OPENCLAW_SERVICE_REPAIR_POLICY=external preserved by Doctor children): from run 2 only; kept
Condition 221 (Interrupted cleanup reconciled on retry; removal failures exit nonzero): from run 2 only; kept
Condition 226 (Extended-stable installation ahead of the selector, or selector failures (registry.reason)): from run 2 only; kept
Condition 229 (Configuration writes suspended while an update row is active): from run 2 only; kept
Condition 249 (Retired same-file memory index refused before canonical tables): from run 2 only; kept
Condition 257 (ClawHub lacks a version-matched official plugin: trusted npm source tried, version-skew warning): from run 2 only; kept
Condition 258 (Operator-managed local plugin copy in plugins.load.paths: plugin-operator-managed warning): from run 2 only; kept
Condition 261 (Unparseable plugin entry during snapshot inventory: warning, files copied unchanged): from run 2 only; kept
Condition 262 (Package publication completed but cleanup failed: evidence archived or retained with a warning): from run 2 only; kept
Condition 263 (External-helper operation stuck at publication-complete: repair settles it): from run 2 only; kept
Condition 264 (Older in-directory activation journals reported with their helper status command): from run 2 only; kept
Condition 269 (Run with an internal origin session (Control UI, webchat): notices in that transcript): from run 2 only; kept
Condition 273 (No functioning model: /update still works): from run 2 only; kept
Condition 284 (Gateway automatic updates enabled on a managed service (update.auto.enabled)): from run 2 only; kept
Condition 286 (Channel cadence: stable delay with jitter, beta interval, dev hourly pinned commit): from run 2 only; kept
Condition 297 (Signed macOS app owns the local Gateway update (Update Mac app + Gateway)): from run 2 only; kept
Condition 299 (Package rollback verification mismatch: up to five differing paths recorded): from run 2 only; kept
Condition 301 (Enabled auto-updater would reapply the newer release during recovery): from run 2 only; kept
Condition 302 (Auth profile import .bak files are not the live credential store): from run 2 only; kept
Condition 303 (Restored service fails its health check after rollback: recovery.service failed): from run 2 only; kept
Condition 308 (Restart accepted by the service owner but ready check fails): from run 2 only; kept
Condition 310 (Installation-change watcher restarts a Gateway updated with --no-restart): from run 2 only; kept
Condition 311 (Live service shares a source checkout's dist output: build entry points refuse): from run 2 only; kept
Condition 320 (pnpm global install group shared with another package: updater stops before changing it): from run 2 only; kept
Condition 323 (OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL set: postinstall cleanup skipped, lifecycle completed): from run 2 only; kept
Condition 327 (Report from a non-owner administrator: prefilled browser issue only, never the host GitHub CLI): from run 2 only; kept
Condition 329 (Container package changes are not durable: redeploy the image): from run 2 only; kept
Condition 331 (Installation not writable by the updater: managed-service-handoff-failed with owner commands): from run 2 only; kept
Condition 342 (Refused or failed core update keeps the previous channel): from run 2 only; kept
Condition 350 (Claude Code without safe-mode support: notice, normal customization): from run 2 only; kept
Condition 352 (Bounded unattended repair before triage for validation failures or unsafe rollback): from run 2 only; kept
Condition 353 (Installation already healthy: triage --run reports already resolved): from run 2 only; kept
Condition 358 (Unsupervised foreground or container run stays alive after a failed startup retry): from run 2 only; kept
Condition 359 (Stop received during triage cancels recovery): from run 2 only; kept
Condition 363 (Linux user-systemd automatic recovery in a native scope; explicit stop cancels it): from run 2 only; kept
Condition 364 (Missing Node or CLI files: manual triage required): from run 2 only; kept
Condition 371 (Unused legacy stores (loose agent/settings.json) deferred with advisories): from run 2 only; kept
Condition 373 (Earlier refusal blocks later steps (blocked-by-prior-refusal)): from run 2 only; kept
Condition 376 (Plugin migrations with files outside the copied state deferred): from run 2 only; kept
Condition 378 (Incognito reserved database filename collision): from run 2 only; kept
Condition 379 (Historical 2026.7.35 shared schema without a deletion journal): from run 2 only; kept
Condition 380 (Interrupted auth-profile archive recovery reported): from run 2 only; kept
Condition 384 (Missing file copies of canonical transcript archives: warnings only): from run 2 only; kept
Condition 385 (SIGINT or SIGTERM to Doctor during archive repair batches: Gateway restored): from run 2 only; kept
Condition 386 (Large fleets: shared inspection across update guard and admission): from run 2 only; kept
Condition 387 (Device Pair legacy JSON beyond namespace capacity): from run 2 only; kept
Condition 395 (Telegram update-offset versions 1 and 2 normalized before account startup): from run 2 only; kept
Condition 411 (July 2026 legacy config shape (two-agent roster, legacy allowlists, retired keys)): from run 2 only; kept
Condition 415 (Older Git updater keeps an in-memory config snapshot: Doctor preserves config): from run 2 only; kept
Condition 416 (Config inputs change while Doctor plans migrations: rerun required): from run 2 only; kept
Condition 417 (Model migration changes a consumer's billing route: warning after saving): from run 2 only; kept
Condition 425 (Profile-owned skill library tables present when changing builds): from run 2 only; kept
Condition 427 (Linked source checkout reports its build commit, not HEAD): from run 2 only; kept
Condition 429 (Accepted Control UI follow-ups in the browser outbox re-admitted after reconnect): from run 2 only; kept
Condition 431 (Downgrade to 2026.9.2 with newer accepted-input receipts: same-ID retries rejected): from run 2 only; kept
Condition 432 (Queued outbound deliveries and cron schedules survive a restart): from run 2 only; kept
Condition 444 (Cancellation before package mutation restores the original service): from run 2 only; kept
Condition 446 (Previously active sessions at update time reach a resumed or terminal state after the update): from run 2 only; kept
Condition 448 (Restart with active work: --safe defers until idle then forces; --skip-deferral bypasses the gate): from run 2 only; kept
Condition 453 (Standalone restart while startup migration progresses: still-starting exit 2 within five minutes): from run 2 only; kept
Condition 455 (Several custom services match: OPENCLAW_SYSTEMD_UNIT required; duplicate user and system services): from run 2 only; kept
Condition 462 (Replacement endpoint set (OPENCLAW_TELEMETRY_ENDPOINT)): from run 2 only; kept
Condition 465 (Campaign target fixed while the installed revision changes: no outdated count or link): from run 2 only; kept
Condition 468 (Restart policy loop on an unsafe migration: run Doctor once in the container): from run 2 only; kept
Condition 470 (Installed 2026.9.3 or 2026.9.4 updater caps rehearsal and snapshot at five minutes even with a larger --timeout): from run 2 only; kept
Condition 471 (Installed 2026.9.4 updater refuses with managed-service-preflight before the target runs): from run 2 only; kept
Condition 472 (pnpm-owned installation whose older updater triggers an interactive build-approval prompt (IO error: not a terminal)): from run 2 only; kept
Condition 474 (Published 2026.9.5 Gateways have no installation-replacement watcher): from run 2 only; kept
Condition 475 (Published 2026.8.2 CLI refuses updates on service-less Linux installs): from run 2 only; kept
Condition 476 (Installed 2026.9.7 or 2026.9.8 supervisor refuses candidate trees over 50,000 entries): from run 2 only; kept
Condition 477 (Older updater without the paired-identity drain reports device identity required and waits for its deadline): from run 2 only; kept
Condition 478 (Published 2026.9.5 resident keeps its startup stop budget after daemon-reload and omits write custody): from run 2 only; kept
Condition 479 (Installed 2026.9.2 admits a new update while an older row remains running): from run 2 only; kept
Condition 480 (Older updater returns already-current with runtime-verification-failed): from run 2 only; kept
Condition 481 (Older updater fails at updater-runtime-retention): from run 2 only; kept
Condition 482 (Installed 2026.9.4 updater cannot use orphan-row recovery before updating itself): from run 2 only; kept
Condition 483 (Bun-hosted update driven by 2026.9.7 waits for idle candidate workers): from run 2 only; kept
Condition 485 (Other foreign-key violations or structural damage refuse update admission (`db-structural-damage`)): from run 1 only; kept
Condition 486 (Writing the local Markdown report fails; a warning is printed and the outcome preserved (`report-write-fails`)): from run 1 only; kept
Condition 487 (A candidate state snapshot fails (active database, exec approvals or plugin phase named) (`snapshot-error`)): from run 1 only; kept
Condition 488 (An agent updates the Gateway that hosts its own session and must use the gateway tool's update.run action (`agent-own-gateway`)): from run 1 only; kept
Condition 489 (No --timeout is given, so Doctor and finalization run without an aggregate deadline; an explicit limit bounds each phase (`timeout-omitted`)): from run 1 only; kept
Condition 490 (A newer release than the installed one is available on the configured channel and is announced by the startup and daily checks (`update-avai): from run 1 only; kept
Condition 491 (Plugins change during an otherwise current update, so a running managed Gateway restarts unless --no-restart (`plugins-changed-restart`)): from run 1 only; kept
Condition 492 (Schema state cannot be compared or a new database is unreadable by the previous package, refusing rollback with rollback-state-unverified (`): from run 1 only; kept
Condition 493 (A chat-initiated update carries the requester's authority through Doctor, handoffs and repair workers (`chat-requester-authority`)): from run 1 only; kept
Condition 494 (Recorded identity evidence is missing versus mismatched (Not verified / Failed badges) (`identity-unavailable`)): from run 1 only; kept
Condition 495 (Recovery files have unexpected mode, link count or owner, producing permission refusals (`recovery-permissions`)): from run 1 only; kept
Condition 496 (The Control UI cannot read fresh progress and shows the read error beside the last run (`progress-read-error`)): from run 1 only; kept
Condition 497 (Doctor imports channel state only for enabled channels (`disabled-channel-import`)): from run 1 only; kept
Condition 498 (An enabled configured plugin has no version for the target in the registry, warning before the Gateway stops (`plugin-availability-preflight): from run 1 only; kept
Condition 499 (Gateway automatic updates are off by default; checks can be on or off independently (`auto-off-default`)): from run 1 only; kept
Condition 500 (A Control UI update asks for confirmation first; cancel, Escape or dismiss leave the Gateway untouched (`ui-confirmation`)): from run 1 only; kept
Condition 501 (A raw npm i -g replacement keeps no previous package and runs no recovery workflow (`raw-npm-replacement`)): from run 1 only; kept
Condition 502 (The package install, staging, verification or launcher swap fails (global-install-failed) and rollback is attempted (`global-install-failed`): from run 1 only; kept
Condition 503 (The restart is unhealthy or its revision mismatches or is unavailable (`restart-unhealthy`)): from run 1 only; kept
Condition 504 (Switching channels syncs plugin sources (bundled for dev, registry for stable/beta) (`plugins-follow-channel`)): from run 1 only; kept
Condition 505 (Release tags in recognised forms (beta, legacy numeric, extended-stable patches) select Git targets (`git-tag-forms`)): from run 1 only; kept
Condition 506 (A named profile or custom state/config paths are pinned for triage and repair (`named-profile`)): from run 1 only; kept
Condition 507 (A support artifact cannot be saved, reporting the storage error (`triage-artifact-save-fails`)): from run 1 only; kept
Condition 508 (Startup finds the webhook completion marker as the sole change or endpoints needing repair (`webhook-startup`)): from run 1 only; kept
Condition 509 (An ACP agent's harness model differs from the native default (information notice) (`acp-model-precedence`)): from run 1 only; kept
Condition 510 (Pending delivery settlements or completion recovery exist and older builds may discard their metadata (`pending-settlements`)): from run 1 only; kept
Condition 511 (Database closure refuses a follow-up drain, parking queued input (`drain-parks-input`)): from run 1 only; kept
Condition 512 (Older persisted running or queued session statuses are normalised to interrupted at startup (`legacy-session-status`)): from run 1 only; kept
Condition 513 (Old scripts send SIGUSR1, which no longer restarts the Gateway (`sigusr1-legacy`)): from run 1 only; kept
Condition 514 (A forced restart from an older caller without a drain budget gets at most 45 seconds (`force-old-caller`)): from run 1 only; kept
Condition 515 (gateway restart runs inside the macOS LaunchAgent process tree and hands off to a detached helper (`restart-inside-launchagent`)): from run 1 only; kept
Condition 516 (Service-managed profile names collide by case or with reserved labels, or custom service identity variables are set (`profile-service-names`): from run 1 only; kept
Condition 517 (OPENCLAW_GATEWAY_RESTART_TRACE adds restart timing lines (`restart-timing-log`)): from run 1 only; kept
Condition 518 (A custom container entrypoint bypasses Doctor activation (`custom-entrypoint`)): from run 1 only; kept
Condition 519 (A Bun-only install's launcher is missing, relinked or names a moved Bun (`bun-launcher`)): from run 1 only; kept
Condition 520 (A Windows Bun-only node host cannot stage updates and logs the failure hourly (`bun-windows-node`)): from run 1 only; kept
Phases: run 2 is the base (it exercised more entry points per operation). Taken from run 1 because run 2 has no phase for that operation or event: finish-plugin-updates, event-update-already-current, event-candidate-validation-fails, event-candidate-validation-fails-older-updater, event-package-install-fails, event-plugin-registry-offline, event-capability-consent, event-plugin-integrity-drift, event-telemetry-unreachable, event-update-checks-disabled, event-stale-update-history, event-non-owner-update, event-node-candidate-fails, event-restart-forced-under-turn, event-restart-during-cron, event-restart-rejects-new-input, event-cleanup-readers-active, event-startup-legacy-config, event-startup-retired-files, event-required-store-refused.
Commands added from run 1 to run 2 phases (a variant or entry point the base lacked): update.status with refreshCheckout in setup-release-published; update.run through the Gateway method in event-control-ui-update-failure-log; update repair after a killed updater in event-updater-killed-after-stop; the declined triage consent in event-triage-consent-timeout; /restart and the SIGUSR2 request with restarts disabled in event-update-with-restarts-disabled; the embedded triage repair turn in recover-failed-update.
Script convention: run 1's registry-publish.mjs and registry-mirror-control.mjs are merged into run 2's release-feed.mjs (one local release feed; publish variants and plugin releases added as flags); update-run.mjs, update-interrupt.mjs, update-pty.mjs and update-wizard.mjs into update-cli.mjs (target variant:<name> added); node-update-check.mjs into node-host-auto-update.mjs; manual-package-update.mjs into manual-package-replace.mjs; restart-handoff-consume.mjs into restart-handoff.mjs; state-db-lock-hold.mjs and gateway-signal.mjs into env-fault.mjs faults. Run 1's updater-journey.mjs, stage-state-fixture.mjs and triage-run.mjs are kept for the phases taken from run 1.
Persona traits merged by content: mock-provider-gateway-tool into mock-provider-tool-calls; service-definition-legacy into service-definition-outdated; registry-local-mirror replaced by the setup phase that starts the release feed. run 1's install-npm-global (the environment itself installed by npm) is not carried: every phase runs on the persona's environment as run 2's do, and run 2's install-npm-global names a second environment.
Headings walked: a heading outside the sections the bound names (in integrity-and-recovery.md, settings.md, telemetry.md, slash-commands.md and docker.md, and the session sections of restart-recovery.md) carries no condition numbers here; run 1 had cited some of its conditions under such headings as well, and every one of those conditions also cites a heading inside the bound, so none is dropped.
Template form corrections: every phase carries its own requires (placeholders, the mock behaviours its scripts need, and the persona state it exercises) and the template's requires is their union; valid config edits use named support presets; invalid config uses a restoring fixture helper; support/ensure-gateway-running.mjs takes its bound on the catalogue's --timeout flag (milliseconds) as the catalogue lists it; phase timeouts cover the sum of their command timeouts and a phase over 300000 ms is slow; setup phases are not slow.


Reconciliation corrections after command-contract review: invalid config and missing-plugin fixtures use a direct-write helper with exact-byte restoration; busy transitions start and collect their own held turns instead of sharing an expiring setup handle; successful recovery cleanup follows all reader-refusal phases. Caller files in the operations inventory are included in their corresponding phase paths. The template now has 123 phases (one setup, 20 operation, 102 event). The existing Gateway health helper needs the declared compatible catalogue adaptation before its --timeout calls can run; it and the Doctor helper remain in support.toWrite. Secondary environment commands retain their derived form and depend on per-comparison-clone environment resolution, as coverage.md records.

Further reconciliation corrections: each independent mutating update scenario restores its starting installation and user state before fault setup; dependent repair preserves its named prior update. The unsupported invalid-config startup-triage scenario is removed and condition 357 recorded as uncovered, because the pinned startup gate excludes invalid configuration. The drain-admission scenario establishes held work and waits for observed draining before sending. Gateway background joins retain their method identity. Valid config changes use declared support presets instead of missing patch files. Coverage accounts for the retained candidate-validation, plugin-integrity and node-fallback phases from run 1 even where run 2 did not cover those conditions.

Reconciliation of remaining scenario preconditions: update.hold sends its empty parameter object; each older-updater validation scenario publishes its own required release variant; secondary and independent UI/history scenarios restore their seeded state; node-host updates use a fresh disposable exported host, including activation timestamps. Report actions require an isolated unavailable-GitHub handle and fail closed before product invocation without it. Secondary installation databases are included in compared responses. Conditions 369 (container entrypoint) and 473 (the specifically affected 2026.9.6 running Gateway) remain uncovered with this persona and these commands.

Final lifecycle reconciliation: secondary Doctor migrations execute the side runtime; stale update-history rows are restaged immediately before each recovery action; every selected phase owns and joins its release-feed server, with interruption cleanup required of that helper. Unsupported hard-link, concurrent package-project mutation, missing node idle-callback and drifted-index setups are listed as gaps. Break159504 is outside reach with the fixed2026.9.9 updater, rather than claimed as covered by a generic candidate failure. Catalogue registration remains the separate prerequisite recorded in coverage.md.

Additional command reconciliation: independent chat callers each restore their starting installation; cron restart waits for active held work and collects the terminal result; handoff mismatch now first creates a retained handoff; node discovery is specified under each side as well as the persona runtime. Stale-history preview is described as a preview, not as superseding a row. Same-code package cycling is no longer claimed to exercise condition422 compatibility. Native campaigns and native-updater mutations are outside reach under the OCM-only scope recorded in coverage.md.

## OCM-only disposition

The retained template has 43 phases: one setup, 12 operation and 30 event phases. Eighty previously reconciled phases are excluded from executable selection because their native mutation, campaign, handoff or custom supervisor prerequisites cannot be established by an OCM-supervised clone. The inventories of 310 entry points and 520 conditions remain intact; comparison.md measures discovery overlap, not executable coverage. coverage.md lists the excluded conditions and all six historical breaks.

The manual replacement operation retains npm and pnpm replacement, without the native source-server script. Repair restores its own primary and stale-history fixtures and no longer reads a result produced by an excluded native update. Unused support commands and persona requirements were removed. No native service or fixture is introduced.
