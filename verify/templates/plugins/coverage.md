# Coverage: plugins

Operations: 34/34
Conditions: 138/187 (134 ambient, 53 event)
Entry points: 333/374 (41 excluded)
Breaks mapped: 7/18

Uncovered:
- C16 nix-mode-or-read-only-config (condition, partial): CLI environment flags are exercised; starting the Gateway itself with these flags is not provided by a persona trait.
- C187 redaction-patterns-copied-from-defaults (condition): no phase sends encoded form values or Digest authorization through the logging redactor; the public-link prompt does not exercise this boundary.
- C43 clawhub-release-audit-outcome (condition): needs a ClawHub release with a Review or blocking moderation outcome; registry content outside the product
- C45 update-channel-beta-or-extended-stable (condition): phase not written: switching update.channel to beta needs a published beta of an official plugin at run time (real registry content); persona addition plugins-npm-tracked carries the stable record only
- C46 npm-latest-release-incompatible-or-prerelease (condition): needs an npm registry whose latest release is incompatible with the host or a prerelease; registry content outside the product
- C47 npm-artifact-integrity-drift (condition): needs a registry artifact whose bytes change under a recorded integrity hash; registry content outside the product
- C58 plugin-index-unreadable (condition): makes the shared state database unreadable for every area; not run on the shared persona
- C65 hourly-capture-cleanup-sweep (condition): needs more than an hour of Gateway uptime per sweep; phases are bounded at 300000 ms; startup reclamation is recorded by event-gateway-killed
- C67 model-catalog-worker-fails-or-stalls (condition): needs an injected model-catalog worker crash or a filesystem slow enough to stall native admission for 180 s
- C76 hooks-not-emitted-by-native-harness (condition): needs the Codex or Copilot harness; persona agents use the mock provider on the embedded runner
- C84 slack-plugin-approval-reviewer-lists (condition): needs a Slack workspace and bot; the test channel is not Slack
- C85 codex-native-permission-relay (condition): needs the Codex harness with the native permission relay
- C87 control-ui-on-plain-http-lan-origin (condition): phase not written: the browser flows reach the Gateway on loopback; a plain-HTTP LAN origin needs a second network interface address the harness does not provision
- C89 plugin-ui-asset-revision-cache-full (condition): needs 256 plugin UI revisions or 64 MiB of advertised assets before a reload is refused
- C95 pending-artifact-import-expires (condition): pending imports expire after one hour and eviction needs nine pending proposals
- C96 artifact-activation-refused (condition): needs persona addition config-plugins-include or the active inference route served by the artifact's plugin; not run on the shared persona
- C100 keyword-results-change-during-paging (condition): needs ClawHub search results to change between two pages of one request
- C101 client-on-gateway-without-catalog-methods (condition): needs a client newer than the Gateway it connects to; the persona runs one version per side
- C105 codex-plugin-app-needs-sign-in (condition): needs a signed-in Codex app-server and a hosted ChatGPT app
- C106 codex-scheduled-run-with-captured-app-authority (condition): needs a signed-in Codex app-server and an automation created from a Codex turn
- C107 codex-app-inventory-cached-stale-or-failed (condition): needs a signed-in Codex app-server app inventory
- C108 codex-account-apps-admitted-by-allow-all-plugins (condition): needs a signed-in Codex account with connected apps
- C109 codex-destructive-action-policy (condition): needs a signed-in Codex app-server with an admitted app
- C110 codex-plugin-change-applies-to-new-conversations (condition): needs a signed-in Codex app-server; /new and /reset belong to sessions
- C111 bun-runtime (condition): runtime variant outside this template's reach (bound: persona runs Node)
- C112 docker-image-with-bundled-source-overlay (condition): deployment variant outside this template's reach (bound)
- C113 source-checkout-host-built-plugins (condition): deployment variant outside this template's reach (bound: released npm build)
- C114 maintainer-install-overrides-environment (condition): maintainer variant outside this template's reach (bound: no override environment)
- C117 bundled-code-mode-executor-survives-plugin-disable (condition): needs Code Mode with the QuickJS executor selected; no persona trait provides it
- C118 external-channel-catalog-file (condition): phase not written: no phase reads channel setup catalogs; persona addition plugins-external-channel-catalog is named
- C130 update-finalization-fails-and-rolls-back (condition): needs a failure injected between package commit and config rollback during update finalization
- C131 official-plugin-renamed-or-id-replaced (condition): needs an official catalog rename of a published package
- C132 clawhub-and-npm-release-lag (condition): depends on ClawHub and npm publish timing for a real package
- C133 core-update-converges-plugins (condition): owned by update (bound: openclaw update and its plugin convergence)
- C136 inbound-claim-fails-for-bound-conversation (condition): needs a plugin-owned conversation binding on a channel; the fixture plugin binds none
- C137 failed-compaction-emits-no-after-compaction (condition): needs a failing compaction attempt; compaction failure belongs to sessions
- C146 second-session-discussion-provider-registered (condition): no persona plugin registers a session discussion provider
- C148 workspace-discovery-without-system-owner (condition): the documents do not say which installation state leaves workspace discovery without a system owner
- C149 cli-connected-to-remote-gateway-with-local-source (condition): needs a CLI connected to a Gateway on another host
- C152 plugin-tool-constructed-in-sandboxed-session (condition): no persona trait provides a sandboxed session
- C154 file-symlinks-unavailable (condition): platform variant: file symlinks unavailable (bound: owned by platform)
- C163 plugin-from-another-clawhub-registry (condition): needs a plugin installed from a second ClawHub registry
- C170 install-policy-unavailable (condition): the persona's policy command is available; removing it would block every other install phase
- C174 third-party-cookie-blocking (condition): browser privacy settings are not a flow option of the Control UI script
- C176 remote-marketplace-entry-escapes (condition): needs a remote git marketplace on an external host
- C179 bundle-mcp-timeouts (condition): needs a slow MCP server fixture
- C180 artifact-replaces-inference-plugin (condition): would replace the plugin backing the persona's active inference route
- C181 node-worker-hook-admission (condition): needs a paired OpenClaw node worker
- C182 zip-name-collision (condition): no colliding archive fixture in the persona
- 141836 (break) support Flux voice-note transcription: Deepgram transcription is the plugin's own feature (bound: owned by its feature area) and needs the real Deepgram service; lifecycle phases are selected by the extensions path but do not transcribe audio
- 127469 (break) respect provenance in automatic context: memory plugin feature (bound: memory plugins owned by their feature area); needs a legacy memory index and slow embeddings
- 126391 (break) prevent malformed streamed tool calls: provider stream parsing owned by models (bound); needs a real provider's streamed tool-call output
- 146713 (break) rebuild outdated provenance on search: memory plugin feature (bound); needs an index written by a newer version
- 144420 (break) share API-key editing and removal: provider auth owned by models (bound); needs two clients editing one key
- 164989 (break) read model context and watermarks through the history reader: needs a remote OpenClaw worker placement (cloud workers, outside the bound)
- 163850 (break) deslop Feishu, WhatsApp, and Teams: the Teams plugin's Doctor recovery guidance is Doctor repair (bound: owned by update) and needs retired Teams state
- 157135 (break) preserve steering across reconnects and show queued input: the in-area path is a Workboard manifest; the symptom is chat scrolling, owned by sessions
- 145553 (break) preserve public status URLs during credential redaction: masking of encoded form values and Digest authorization is owned by logging; the in-area path is an SDK re-export, and no phase sends those values
- 166049 (break) open public threads at their regular links: chat link routing owned by sessions and the Control UI; the in-area paths are the X plugin's feature code
- 137131 (break) hydrate published models from models.dev: outside the product's reach: needs an upstream models.dev document larger than the publisher's cap (external data)
- The six extension-feature breaks (127469, 146713, 144420, 163850, 157135, 166049) above are accepted coverage gaps for this contribution. Their paths match `extensions/**`, but their feature behaviour is outside this template's plugin-system boundary. Later contributions for memory provenance, provider authentication, Teams recovery, Workboard conversation behaviour and X link routing own that coverage. No template covers those features yet, so changes there select only this template's lifecycle phases; those phases cannot establish whether the feature regression is fixed.
- openclaw plugins (CLI command) (entry point, excluded): command group; prints help only, every subcommand is listed
- openclaw plugins marketplace (CLI command) (entry point, excluded): command group; prints help only, its three subcommands are listed
- plugin.surface.refresh (Gateway method) (entry point, excluded): owned by nodes (src/gateway/server-methods/nodes.read.ts, nodes method family); it is neither plugins.* nor plugin.approval.*; reported for the input file
- apps/android/app/src/main/java/ai/openclaw/app/AndroidScreenshotFixture.kt (from Android app) (entry point, excluded): test-only: screenshot fixture (the bound's *fixture* test exclusion read without case)
- Plugins hub tab "Skills" (UI action) (entry point, excluded): owned by skills
- Plugins hub tab "Skill workshop" (UI action) (entry point, excluded): owned by skills
- openclaw gateway status --deep --require-rpc (CLI command) (entry point, excluded): consumed from gateway (named as a verification step)
- openclaw health (CLI command) (entry point, excluded): consumed from status (reports runtime quarantines)
- openclaw status --all (CLI command) (entry point, excluded): consumed from status (reports configured-unavailable plugins)
- openclaw doctor (--fix) plugin repairs (CLI command) (entry point, excluded): owned by update (bound); its plugin repair files are listed as from update
- openclaw update, openclaw update status, openclaw update repair (CLI command) (entry point, excluded): owned by update (bound)
- openclaw hooks list (CLI command) (entry point, excluded): owned by automation (bound)
- openclaw claws status (CLI command) (entry point, excluded): owned by claws
- openclaw skills search (CLI command) (entry point, excluded): owned by skills (bound)
- openclaw mcp set (CLI command) (entry point, excluded): owned by MCP (bound)
- openclaw config set / openclaw config get (CLI command) (entry point, excluded): owned by config (bound)
- openclaw logs --follow (CLI command) (entry point, excluded): consumed from logs
- openclaw onboard (CLI command) (entry point, excluded): owned by onboarding; its setup-time install caller is listed as from onboarding
- /new, /reset (chat command) (entry point, excluded): owned by sessions (bound); named by the Codex plugin document
- /btw (chat command) (entry point, excluded): owned by the btw side-discussion tool
- clawhub package publish, clawhub login (CLI command) (entry point, excluded): external ClawHub CLI, not this product
- api.enqueueNextTurnInjection (plugin call) (entry point, excluded): not a registration method (bound counts api.register* and hook names); session workflow owned by sessions
- api.emitAgentEvent (plugin call) (entry point, excluded): not a registration method
- api.setRunContext / api.getRunContext / api.clearRunContext (plugin call) (entry point, excluded): not a registration method
- api.sendSessionAttachment (plugin call) (entry point, excluded): not a registration method; bundled-only session workflow
- api.scheduleSessionTurn / api.unscheduleSessionTurnsByTag (plugin call) (entry point, excluded): not a registration method; owned by cron
- api.onConversationBindingResolved (plugin call) (entry point, excluded): not a registration method; conversation bindings owned by channels
- registerSandboxBackend (openclaw/plugin-sdk/sandbox) (plugin call) (entry point, excluded): SDK module function, not an api.register* method; owned by sandbox
- session discussion provider (openclaw/plugin-sdk/session-discussion) (plugin call) (entry point, excluded): SDK module function; owned by the btw side-discussion tool
- api.runtime.* helpers (plugin call) (entry point, excluded): consumed from the area each helper wraps (bound)
- Broadcast events plugins.changed, plugins.install.progress, plugins.controlUi.changed, plugin.approval.requested, plugin.approval.resolved (entry point, excluded): internal; the product emits them, they are not entry points (not counted)
- /plugin (singular) (entry point, excluded): alias of /plugins
- tools.catalog (entry point, excluded): consumed from agents (plugin tool previews)
- mcp.authLogin (entry point, excluded): consumed from MCP (plugin MCP sign-in calls it)
- config.get, config.schema, config.set, config.patch (entry point, excluded): consumed from config (the plugin settings editor and Advanced tab read and write config through them)
- openclaw-plugin-inspector (entry point, excluded): external package, not shipped by the product
- api.on (entry point, excluded): registration mechanism for typed hooks; each hook name is counted under its operation
- UI Logbook plugin page controls (ui/src/pages/plugin/logbook-view.ts) (entry point, excluded): owned by the Logbook plugin's feature area (bound)
- UI settings navigation, sidebar, theme and account controls around the plugin pages (entry point, excluded): shell

Persona additions:
- plugin-fixture-surfaces: an external fixture plugin installed from a local npm-pack package with its receipt, enabled, allowlisted and granted conversation access, that registers a required tool, an optional tool, a slow tool, an approval-gated tool (before_tool_call requireApproval), a tool whose result breaks its output schema, a tool name that collides with a core tool and a malformed tool, Gateway methods (one in a reserved admin namespace, one returning its hook invocation log, one calling the public SDK catalog loader without options), an HTTP route, a service, a root CLI command, a chat command, a session action and session extension, a runtime lifecycle registration, tab, widget and link-reader Control UI descriptors (one tab slug colliding with a reserved name), trusted tool policy and tool-result middleware with their manifest contracts, a slow tool constructor, a handler for every typed hook with operator hook timeouts and an eligibleTriggers-limited heartbeat hook, a bundled skill, a dedicated session, and cron projection hooks (pluginId, sourceDir, themeArtPath, toolName, optionalToolName, slowToolName, holdStatusMethod, approvalToolName, schemaBreakToolName, hookLogMethod, methodName, reservedMethodName, sdkProbeMethod, routePath, cliCommand, commandName, sessionActionId, sessionKey, skillName, packagePath, installDir); its active cleanup callback reads a fixture-owned failure marker on every invocation, including retries; holdStatusMethod reports actual held slow-tool callback entry with session, run and invocation identity; its gateway_stop hook can acknowledge entry and wait on a fixture-owned release marker, and its replacement gateway_start hook can throw after publication without making service startup fail; its config schema accepts kovaMarker (a string the config-change script changes), kovaBreakRegister (register() throws while true) and kovaUnknownKey is not declared
- plugin-fixture-feature-ui: a feature plugin with a native page, navigation with context actions, a composer replacement, a panel, a header accessory, a dashboard widget and a docked conversation, with Settings → Labs → Custom plugin UI turned on (pluginId)
- plugins-policy-mixed: plugins.deny naming one installed plugin, one entry disabled with its config kept, stale unknown ids in plugins.entries and plugins.allow, a legacy plugin id in config, plugins.slots.memory selecting an installed memory plugin, and a disabled channel plugin (deniedPluginId, slotPluginId)
- plugins-local-sources: a plugins.load.paths TypeScript plugin, a --link install with a slow tool, a workspace-origin plugin left disabled, a standalone script in the extensions root, a Claude bundle with an MCP stdio server, LSP config, settings.json and hooks.json, a hook pack, a multi-entry package with one child disabled, a mixed-case plugin id, a plugin requiring a missing companion plugin, a plugin MCP server overridden by mcp.servers, a load-path copy of a bundled plugin id, a second hook plugin without conversation access and with allowPromptInjection false, and a local archive (linkDir, linkedPluginId, linkedSlowToolName, archivePath, multiEntryChildId, bundleMcpToolName, bundleSessionKey, hookLogMethod)
- plugins-broken-installs: a managed npm plugin with incomplete install metadata, a plugin missing a runtime dependency, a plugin with an invalid manifest, a plugin installed disabled for missing required config, an orphan install record, an ambiguous package owner, a plugin directory that is world-writable, a plugin whose register throws, a plugin whose module evaluation throws, a plugin importing a removed SDK subpath, a hook-only plugin on a deprecated contract, a broken capability catalog entry, an invalid board widget content kind, a plugin whose dispose throws, and an install saved after a failed runtime activation (disposeFailPluginId)
- plugins-third-party-consented: a third-party plugin installed from an npm-pack package with recorded capability acceptance, and a staged newer package declaring one more capability (pluginId, packagePath, widenedPackagePath)
- plugins-npm-tracked: an official plugin installed from npm with an exact pinned record and a ClawHub-tracked package, with hoisted dependencies in their managed projects (officialPluginId, officialPluginSpec, clawhubPackage)
- plugins-legacy-state: legacy plugins.installs in config, a flat ~/.openclaw/npm/node_modules root, a dangling plugin-runtime-deps link, a stale node_modules/openclaw host link, a stale generation directory, a config-referenced downloadable plugin with no install record, and an unused configured agent with an empty legacy sessions.json and a pending deferred plugin session migration
- plugins-native-dependency: two installed plugins with native dependencies sharing one dependency file, with published native capture receipts (pluginId)
- config-install-policy: security.installPolicy running a local command that warns for one local package and for the exact local catalogue package identified by warnCatalogId, and blocks another; the warning package is available from clawhub-registry-local and triggers Install anyway (warnPackagePath, blockPackagePath, warnCatalogId)
- config-provider-without-models: a bundled provider configured with credentials and settings but no models array, so startup auto-enables its plugin
- operator-read-only-profile: an operator profile holding operator.read only (profileId)
- marketplace-local: a local Claude marketplace directory with marketplace.json and one plugin, registered in known_marketplaces.json (marketplacePath, marketplaceName, pluginName, mismatchSha256); a checksum that does not match the hosted feed (from run 2)
- claws-package-installed: an installed Claw whose package references an installed plugin (pluginId)
- plugins-bundled-and-external (key additions): the existing trait plus the id of one bundled plugin whose compiled file a phase edits and one bundled plugin disabled by default (bundledPluginId, bundledOffPluginId)
- config-read-only-environment: the Gateway service started with OPENCLAW_CONFIG_READONLY=1 or OPENCLAW_NIX_MODE=1 (named for the uncovered condition; not required by a phase)
- plugins-external-channel-catalog: an external channel catalog file under ~/.openclaw/mpm/plugins.json (named for the uncovered condition; not required by a phase)
- session-plugin-tools: an idle session on an agent whose model is the tool-calling mock, owned by the operator (key)
- plugin-pack-requires-config: an npm-pack tarball of a plugin whose config has a required field (path, pluginId)
- plugin-pack-multi-entry: a local package with two already installed plugin entries; its child starts enabled with no capability acceptance record, representing a legacy unreviewed installation (path, packageName, pluginId, childId)
- plugin-pack-broken-activation: an npm-pack tarball whose register() throws (path, pluginId)
- plugin-workspace-discovered: a workspace-origin plugin under the agent workspace extensions root, not enabled (pluginId)
- plugin-load-path-unrecorded: a plugins.load.paths entry to a local plugin copy without an install record (pluginId)
- plugin-disabled-with-config: an installed plugin disabled with its config kept (pluginId)
- plugin-legacy-enabled-unreviewed: a third-party plugin enabled before capability acceptance existed, with no acceptance record (pluginId)
- plugin-registry-stale: a persisted plugin registry older than the current config and manifests ((none))
- plugin-authoring-workspace: a built tool plugin project and a built feature plugin project, and a plugin id for a new scaffold (toolId, toolProjectDir, featureProjectDir)
- codex-harness-native-plugins: a Codex-mode agent with codexPlugins enabled and one configured native plugin, and its session (agentId, sessionKey, pluginKey)
- config-plugin-approvals-forwarded: approvals.plugin forwarding to the DM test channel (none); from run 2, required by event-plugin-approvals-forwarded-to-chat
- channels-test-accounts (key addition): a sender id that has never paired with the DM channel (unpairedPeer); from run 2
- config-plugins-include: the plugins section authored through a single-file $include (none); required by enable-and-disable-plugin
- clawhub-registry-local: ClawHub, npm and the hosted marketplace feed served from local fixtures the Gateway and CLI are pointed at, holding a known plugin listing with its icon, a bundled skill and release, an official external plugin and an exact npm spec, so the baseline and the change read the same registry content (catalogId, packageName, version, skillName, catalogIconPath, officialPluginId, officialCatalogId, npmSpec)
- session-phase-hold: an idle session on the tool-calling mock model, used by the holds a phase starts and joins itself (key)

- plugin-install-package: a local npm-pack archive with a distinct plugin id used only by install-source variants; it is not the enabled surface fixture (packagePath)

- system-agent-local-operator: the system-agent inference route uses the scripted local mock provider, and the test operator can open its Control UI chat and explicitly approve a staged operation; no model-account credentials are used.
- plugin-managed-removal: a separate managed npm-pack installation, enabled with a slow tool and no initial plugins.load.paths reference; its installation directory is owned and removable by uninstall (pluginId, slowToolName, holdStatusMethod, installDir, sessionKey, releasePath); sessionKey is dedicated to this fixture. holdStatusMethod reports initial held callback admission; subsequent pending-state observation and release use releasePath, a marker relative to the clone state root, independent of plugin RPC admission and private to that clone.
- session-channel-held: a dedicated direct peer and session on the conformance channel with the held mock response, whose final outbound message is collected by the channel harness (peer).

- plugin-mcp-local-account: an installed, enabled bundle declaring an HTTP MCP endpoint served by a loopback fixture, with an operator-owned OAuth configuration for the exact same server name and endpoint. A local authorization fixture accepts a synthetic identity without external accounts or real credentials; initially unauthenticated, it supports Connect and the subsequent authorized Edit state. Both local servers are recreated per clone and remain available through the browser flow (pluginId, serverName).

- plugin-lsp-held-initialize: an enabled local Claude bundle and dedicated mock-model session with an LSP fixture whose initialize response is held after a uniquely identified request; its per-clone control path records the request id, process identity, cancellation and exit, with no shared fixture files between clones (sessionKey, controlPath).

- plugin-credential-synthetic: an enabled local web-search or web-fetch provider plugin with manifest contract metadata advertising one credential field, backed only by a non-secret sentinel and a local synthetic reference. It performs no external requests and uses no real credentials; settings support the field, reveal and reference UI, and changes are restored after the flow (pluginId).

- plugin-concurrency-peer: a separate enabled installed plugin used only as the competing enablement target; it has a distinct identity from every bundled/external inventory and surface fixture (pluginId).
