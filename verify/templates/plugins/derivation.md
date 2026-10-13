# Derivation: plugins

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

## Bounds
Paths: src/plugins/**, src/plugin-sdk/**, src/plugin-state/**, src/cli/plugins-*.ts, src/cli/plugin-*.ts, src/cli/run-main-plugin-cache.ts, src/gateway/server-methods/plugins*.ts, src/gateway/server-methods/plugin-*.ts, src/gateway/server-plugin*.ts, src/gateway/server-startup-plugins.ts, src/gateway/server-retained-plugin-cleanup.ts, src/gateway/plugin-*.ts, src/gateway/control-ui-plugin-*.ts, src/gateway/config-reload-plugin-drain.ts, src/gateway/hosted-plugin-surface-url.ts, src/gateway/http-auth-plugin-cookie.ts, src/gateway/server-http-plugin-auth.ts, src/gateway/node-invoke-plugin-*.ts, src/gateway/node-plugin-tool-snapshot.ts, src/config/plugin-*.ts, src/config/plugins-allowlist.ts, src/config/types.plugins.ts, src/config/validation-plugin-*.ts, src/config/io.plugin-metadata.ts, src/infra/clawhub-plugin-*.ts, ui/src/lib/plugin-activation.ts, src/commands/onboarding-plugin-install.ts, src/commands/runtime-plugin-install.ts, src/commands/codex-runtime-plugin-install.ts, src/commands/startup-plugin-source-captures.ts, ui/src/pages/plugins/**, ui/src/pages/plugin/**, ui/src/lib/plugins/**, ui/src/components/app-sidebar-plugin-*.ts, ui/src/components/plugin-*.ts, extensions/**
Documents: docs/tools/plugin.md, docs/plugins/manage-plugins.md, docs/cli/plugins.md, docs/cli/plugins/install.md, docs/cli/plugins/list.md, docs/cli/plugins/inspect-and-diagnose.md, docs/cli/plugins/uninstall-and-update.md, docs/cli/plugins/marketplace.md, docs/cli/plugins/authoring.md, docs/plugins/install-overrides.md, docs/plugins/dependency-resolution.md, docs/plugins/bundles.md, docs/plugins/community.md, docs/plugins/compatibility.md, docs/plugins/plugin-inventory.md, docs/plugins/plugin-permission-requests.md, docs/plugins/architecture.md, docs/plugins/architecture-internals/load-pipeline.md, docs/plugins/architecture-internals/packaging.md, docs/plugins/manifest.md, docs/plugins/hooks.md, docs/plugins/hooks/lifecycle.md, docs/plugins/hooks/reference.md, docs/plugins/sdk-overview.md, docs/plugins/sdk-overview/host-hooks.md, docs/plugins/sdk-entrypoints.md, docs/plugins/building-plugins.md, docs/plugins/tool-plugins.md, docs/plugins/feature-plugins.md, docs/plugins/codex-native-plugins.md, docs/gateway/protocol/rpc-system-and-channels.md (no additions)

Linked pages not added: docs/plugins/manifest/*, docs/plugins/hooks/prompt-and-session.md and docs/plugins/sdk-runtime* are owned elsewhere by the bound; docs/plugins/hooks/tool-policy.md and messages.md describe hook semantics whose hook names the listed reference already counts; the docs/plugins/sdk-overview/* child pages were not added because the registration method names were taken from src/plugins/plugin-api.types.ts (docs/plugins/sdk-overview.md delegates its method list to them).

## Excluded paths
src/auto-reply/reply/commands-plugins.ts, src/auto-reply/reply/plugins-commands.ts: /plugins chat command bodies outside the globs; their commands are listed as entry points because the area's documents describe them
src/agents/tools/system-agent-tool.ts: the system agent tool body is owned by the system agent; its plugin actions are listed as entry points
src/commands/doctor-plugin-*.ts, src/commands/doctor-config-preflight-plugin-*.ts, src/commands/doctor/shared/*plugin*, src/infra/deferred-plugin-*.ts: owned by update (bound); Doctor's plugin repair is listed as an entry point of kind from update
src/gateway/server-methods/nodes.read.ts (plugin.surface.refresh): owned by nodes
ui/src/plugins/** other than control-ui-runtime.ts, ui/src/app/** other than the files listed as from Control UI shell: owned by the Control UI shell
ui/src/pages/plugin/logbook-*.ts: owned by the logbook plugin's feature area (bound)
extensions/<id>/** feature code: owned by each plugin's feature area (bound); install, enablement, startup load and reload of every shipped plugin stay here
docs/plugins/reference/*, docs/plugins/sdk-channel-*, docs/plugins/sdk-provider-plugins*, docs/plugins/codex-harness*, docs/plugins/sdk-agent-harness*: owned by plugin features, channels, models and agent runtime (bound)
Windows-only path handling: owned by platform (bound)
src/agents/tools/plugins-tool.ts, src/auto-reply/reply/commands-plugins*.ts, src/agents/tools/system-agent-tool.ts, ui/src/plugins/**, src/commands/startup-config-preflight.ts: outside the globs; their entry points are listed because the area's documents describe them, their code is owned by agents, auto-reply, the system agent, the Control UI runtime and startup
channels.*, config.*, sessions.*, skills.* methods and their CLI and pages, model provider behaviour, the agent harnesses, api.runtime.* helpers, internal hooks, the MCP settings page and dashboard widgets: owned by the areas the bound names

## Operations
| Operation | Entry points | Kinds |
| --- | --- | --- |
| Browse and search the plugin catalog | plugins.search; plugins.catalog.browse; plugins.catalog.get; plugins.catalog.categories; catalog.browse; catalog.searchKeywords; openclaw plugins search; Plugins hub (/plugins) tab "Plugins"; Plugins hub "Search plugins" field; Plugins hub "Featured" intent button; Plugins hub "Trending" intent button; Plugins hub ClawHub category buttons; Plugins hub catalog card (opens catalog detail); Plugins hub "Load more"; Plugins hub "Try again" (discovery retry); Catalog detail back link "Plugins"; Catalog detail "Repository" link; Catalog detail "Documentation" link; plugins tool action search; /__openclaw__/catalog-icon; /__openclaw__/link-favicon; packages/gateway-protocol/src/core-request-params.ts; src/gateway/server-methods/catalog.ts; ui/src/components/command-palette-catalog-search.ts; UI Plugins hub "All" chip; UI Plugins hub section "View all"; UI catalog detail publisher profile link (clawhub.ai); UI catalog detail README code-block copy | Gateway method; CLI command; UI action; agent tool action; route; from gateway protocol; from gateway; from command palette |
| List installed plugins | plugins.list; openclaw plugins list; Plugins hub "View all" (documented as "Show all") for Installed plugins; Installed plugin card (opens /settings/plugins/<plugin-id>); Plugins hub "Plugin settings" button; Settings → Plugins (/settings/plugins) "Search installed plugins" field; Settings → Plugins tab "Installed"; plugins tool action list; /plugins list; /__openclaw__/plugin-icon; /__openclaw__/plugin-activity-icon; ui/src/pages/channels/plugin-presentation-controller.ts; ui/src/pages/chat/chat-tool-icon-controller.ts; ui/src/pages/config/config-page.ts; src/gateway/methods/core-descriptors.ts (from gateway) | Gateway method; CLI command; UI action; agent tool action; chat command; route; from channels; from chat; from config; from gateway |
| Inspect a plugin | plugins.inspect; plugins.credentials.inspect; openclaw plugins inspect (alias openclaw plugins info); Plugin overview "Ask OpenClaw"; Plugin overview Tools row (opens tool preview); Tool preview "Close"; Plugin overview MCP server details button; Plugin overview "Security audit" (View security audit); Plugin overview "Settings" link (configuration view); Plugin settings "Try again" (inspection retry); plugins tool action inspect; /plugins inspect (also show, get); UI plugin settings page back link | Gateway method; CLI command; UI action; agent tool action; chat command |
| Preview a plugin's bundled skill | plugins.skills.read; Plugin overview Skills row (opens skill preview); Skill preview file selection; Skill preview retry of a failed file read | Gateway method; UI action |
| Install a plugin | plugins.install; openclaw plugins install; "Install" button on catalog card and detail (also "Retry install", "View install status"); Install progress "Failure details"; "Install anyway" (install-policy warning); plugins tool action install; /plugins install (also add); openclaw tool action plugin_install; src/auto-reply/reply/commands-plugins-install.ts; src/claws/packages.ts; src/commands/channel-setup/plugin-install.ts; src/flows/search-setup.ts; src/wizard/setup.app-recommendations.ts; src/wizard/setup.official-plugins.ts; src/commands/onboard-non-interactive/local/auth-choice.plugin-providers.ts; src/commands/doctor/shared/missing-configured-plugin-install.install.ts; src/system-agent/setup-inference-codex.ts; src/system-agent/setup-inference-core.ts; src/commands/models/auth.ts; src/commands/models/set.ts | Gateway method; CLI command; UI action; agent tool action; chat command; from chat commands; from claws; from channel setup; from search setup; from setup wizard; from onboarding; from update; from system agent; from models |
| Review and accept a plugin's capabilities | Capability consent dialog accept ("Enable {name}"); Capability consent dialog "Cancel"; Capability consent dialog "Try again" | UI action |
| Enable or disable a plugin | plugins.setEnabled; openclaw plugins enable; openclaw plugins disable; Plugin settings "Enable" / "Disable" button; plugins tool action enable; plugins tool action disable; /plugins enable; /plugins disable; src/flows/channel-setup.ts; src/system-agent/setup-inference-detect.ts; src/system-agent/setup-provider-method.ts; src/commands/promos/claim.ts | Gateway method; CLI command; UI action; agent tool action; chat command; from channel setup; from system agent; from promos |
| Configure a plugin's settings and credentials | Plugin settings editor "Search settings" field; Plugin settings editor section navigation; Plugin settings editor field inputs (schema form); Plugin settings field "Actions" menu "Reset value"; Plugin settings field "Actions" menu "Ask OpenClaw"; Plugin settings "Retry" (config read or write); Plugin overview Credentials "Configure" / "Edit"; Credential API key field; Credential reveal toggle; Credential "Get an API key" link; Credential "Use a secret reference"; Secret reference "Source" select; Secret reference value field; Secret reference "Save"; Secret reference "Cancel"; src/gateway/config-reload.ts; UI plugin Permissions "Conversation access"; UI plugin Permissions "Prompt context access" | UI action; from config |
| Connect a plugin's account | Plugin overview Accounts "Connect" (MCP sign-in); Plugin overview Accounts "Edit" (opens MCP settings) | UI action |
| Set plugin loading policy | Settings → Plugins tab "Advanced"; Settings → Plugins Advanced "Reload"; Advanced global plugin loading policy; Advanced allow list; Advanced deny list; Advanced load paths; Advanced capability slots | UI action |
| Reload a plugin | plugins.reload; openclaw plugins reload; Plugin settings Lifecycle "Reload" (documented); plugins tool action reload; src/gateway/server/ws-connection/authenticated-request-dispatch.ts | Gateway method; CLI command; UI action; agent tool action; from gateway |
| Refresh the plugin inventory and registry | plugins.refresh; openclaw plugins registry | Gateway method; CLI command |
| Uninstall a plugin | plugins.uninstall; openclaw plugins uninstall; Plugin settings "Uninstall"; Uninstall confirmation; plugins tool action uninstall; openclaw tool action plugin_uninstall; src/claws/package-remove.ts | Gateway method; CLI command; UI action; agent tool action; from claws |
| Update a plugin | openclaw plugins update; src/commands/doctor/shared/missing-configured-plugin-install.repair.ts; src/commands/doctor/shared/post-core-plugin-convergence.ts | CLI command; from update |
| Diagnose plugin health | openclaw plugins doctor | CLI command |
| Author and package a plugin | openclaw plugins init; openclaw plugins build; openclaw plugins validate; openclaw plugins pack | CLI command |
| Browse marketplaces and feeds | openclaw plugins marketplace entries; openclaw plugins marketplace list; openclaw plugins marketplace refresh | CLI command |
| Use plugin pages, tabs and widgets in the Control UI | plugins.uiDescriptors; plugins.controlUi.list; Plugin sidebar tab (/plugin?plugin=<id>&id=<tab> or its slug); Plugin page (ui/src/pages/plugin); Plugin navigation item context actions (right-click, Shift+F10); Plugin-contributed composer, header or session menu action; Plugin session panel; Plugin session header accessory; Native plugin dashboard widget (with "Retry"); Docked link reader; Plugin frame session navigation (openclaw-plugin-session-open); native plugin UI asset route (src/gateway/control-ui-plugin-assets.ts); plugin tab auth cookie grant (src/gateway/control-ui-plugin-auth-cookie.ts, src/gateway/server-http-plugin-auth.ts); /__openclaw__/plugin-theme-art; ui/src/app/plugin-capabilities.runtime.ts; ui/src/plugins/control-ui-runtime.ts; host.ui.registerNavigation | Gateway method; UI action; route; from Control UI shell; plugin call |
| Customize and reload plugin UI | plugins.controlUi.reload; plugins.controlUi.report; plugins.controlUi.status; Plugins → Advanced → Customize UI replacement choice; Customize UI "Built-in"; Customize UI "Reload plugin UI"; Settings → Labs → "Custom plugin UI"; host.ui.registerReplacement | Gateway method; UI action; plugin call |
| Run a plugin session action | plugins.sessionAction; src/gateway/method-scopes.ts; src/gateway/session-method-policy.ts | Gateway method; from gateway; from sessions |
| Approve or deny a plugin permission request | plugin.approval.request; plugin.approval.waitDecision; plugin.approval.resolve; plugin.approval.list; Plugin approval prompt decision buttons (Allow once, Allow always, Deny); /approve <id> <decision> (plugin approval); apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt; apps/ios/Sources/Model/NodeAppModel.swift; apps/macos/Sources/OpenClaw/ExecApprovalQueueStore.swift; src/agents/agent-tools.before-tool-call.approval.ts; src/agents/cli-runner/cli-native-tool-approval.ts; src/agents/harness/host-capability.ts; src/agents/harness/native-hook-relay-permissions.ts; src/agents/tools/gateway.ts; src/cli/exec-approvals-cli.ts; src/gateway/server-aux-handlers.ts; src/gateway/server-request-lifecycle.ts; src/gateway/session-sharing-target-input.ts; src/infra/approval-gateway-resolver.ts; src/infra/approval-gateway-runtime-methods.ts; src/infra/exec-approval-channel-runtime.ts; src/mcp/channel-bridge.ts; src/tui/gateway-chat.ts; ui/src/app/exec-approval.ts | Gateway method; UI action; chat command; from Android app; from iOS app; from macOS app; from agents; from agent runtime; from approvals; from gateway; from sessions; from MCP; from TUI; from Control UI shell |
| Activate an agent-built plugin artifact | openclaw tool action plugin_activate_artifact; src/system-agent/plugin-artifact.ts | agent tool action; from system agent |
| Start the Gateway with plugins loaded | src/gateway/server-startup-bootstrap.ts; src/gateway/server-startup-finish.ts; src/gateway/server-runtime-services.ts; src/commands/startup-config-preflight.ts | from gateway |
| Run a plugin-provided CLI command | registerCli; registerNodeCliFeature; src/cli/run-main.ts | plugin call; from CLI |
| Use plugin tools and node commands in agent turns | registerTool; registerToolMetadata; registerNodeHostCommand; registerNodeInvokePolicy; registerTrustedToolPolicy; registerAgentToolResultMiddleware; src/agents/tools/plugins-tool.ts; src/gateway/server-methods/nodes.invoke.ts; src/gateway/server-methods/terminal.ts; src/gateway/worker-environments/computer-transport.ts; src/gateway/node-registry.ts | plugin call; from agents; from nodes; from terminal; from cloud workers |
| Manage native Codex plugins | /codex plugins (alias of list); /codex plugins list; /codex plugins available; /codex plugins install; /codex plugins status; /codex plugins refresh; /codex plugins enable; /codex plugins disable; codex_plugins tool; Codex plugin "Refresh hosted apps"; Codex plugin "Check status"; "Open <app> in ChatGPT" link; Codex sign-in question "Open link"; Codex sign-in question "I've completed this step"; openclaw migrate codex; openclaw migrate apply codex | chat command; agent tool action; UI action; CLI command |
| Plugins shape agent turns through hooks | before_model_resolve; agent_turn_prepare; before_prompt_build; before_agent_run; before_agent_reply; before_agent_finalize; agent_end; heartbeat_prompt_contribution; model_call_started; model_call_ended; llm_input; llm_output | plugin call |
| Plugins gate and observe tool calls | before_tool_call; after_tool_call; resolve_exec_env; tool_result_persist; before_message_write | plugin call |
| Plugins intercept messages and delivery | inbound_claim; channel_pairing_requested; message_received; message_sending; reply_payload_sending; message_sent; before_dispatch; reply_dispatch | plugin call |
| Plugins follow sessions, compaction and subagents | session_start; session_end; before_compaction; after_compaction; before_reset; subagent_spawned; subagent_ended; subagent_progress; subagent_delivery_target | plugin call |
| Plugins follow Gateway, cron, install and skill lifecycle | gateway_start; gateway_stop; cron_reconciled; cron_changed; before_install; skill_changed | plugin call |
| Plugins register providers and capabilities | registerProvider; registerCliBackend; registerEmbeddingProvider; registerSpeechProvider; registerRealtimeTranscriptionProvider; registerRealtimeVoiceProvider; registerMediaUnderstandingProvider; registerTranscriptSourceProvider; registerImageGenerationProvider; registerMusicGenerationProvider; registerVideoGenerationProvider; registerWebFetchProvider; registerWebSearchProvider; registerChannel; registerGatewayDiscoveryService; registerMigrationProvider; registerWorkerProvider; registerStorageProvider; registerModelCatalogProvider; registerContextEngine; registerDecisionProvider; registerCompactionProvider; registerAgentHarness; registerAgentExecutorController; registerCodexAppServerExtensionFactory; registerMemoryCapability; registerMemoryPromptSupplement; registerMemoryPromptPreparation; registerMemoryCorpusSupplement; registerSessionCatalog; registerHostedMediaResolver; registerTextTransforms | plugin call |
| Plugins register Gateway methods, routes, services and maintenance | registerGatewayMethod; registerGatewayAccessPolicy; registerHttpRoute; registerService; registerHook; registerReload; registerConfigMigration; registerAutoEnableProbe; registerSecurityAuditCollector; registerInteractiveHandler; registerRuntimeLifecycle | plugin call |
| Plugins register commands, session state and Control UI contributions | registerCommand; registerControlUiDescriptor; registerSessionAction; registerSessionExtension; registerSessionSchedulerJob; registerAgentEventSubscription; registerBoardWidgetContentKind; registerWidgetPresenter | plugin call |

## Excluded entry points
openclaw plugins (CLI command): command group; prints help only, every subcommand is listed
openclaw plugins marketplace (CLI command): command group; prints help only, its three subcommands are listed
plugin.surface.refresh (Gateway method): owned by nodes (src/gateway/server-methods/nodes.read.ts, nodes method family); it is neither plugins.* nor plugin.approval.*; reported for the input file
apps/android/app/src/main/java/ai/openclaw/app/AndroidScreenshotFixture.kt (from Android app): test-only: screenshot fixture (the bound's *fixture* test exclusion read without case)
Plugins hub tab "Skills" (UI action): owned by skills
Plugins hub tab "Skill workshop" (UI action): owned by skills
openclaw gateway status --deep --require-rpc (CLI command): consumed from gateway (named as a verification step)
openclaw health (CLI command): consumed from status (reports runtime quarantines)
openclaw status --all (CLI command): consumed from status (reports configured-unavailable plugins)
openclaw doctor (--fix) plugin repairs (CLI command): owned by update (bound); its plugin repair files are listed as from update
openclaw update, openclaw update status, openclaw update repair (CLI command): owned by update (bound)
openclaw hooks list (CLI command): owned by automation (bound)
openclaw claws status (CLI command): owned by claws
openclaw skills search (CLI command): owned by skills (bound)
openclaw mcp set (CLI command): owned by MCP (bound)
openclaw config set / openclaw config get (CLI command): owned by config (bound)
openclaw logs --follow (CLI command): consumed from logs
openclaw onboard (CLI command): owned by onboarding; its setup-time install caller is listed as from onboarding
/new, /reset (chat command): owned by sessions (bound); named by the Codex plugin document
/btw (chat command): owned by the btw side-discussion tool
clawhub package publish, clawhub login (CLI command): external ClawHub CLI, not this product
api.enqueueNextTurnInjection (plugin call): not a registration method (bound counts api.register* and hook names); session workflow owned by sessions
api.emitAgentEvent (plugin call): not a registration method
api.setRunContext / api.getRunContext / api.clearRunContext (plugin call): not a registration method
api.sendSessionAttachment (plugin call): not a registration method; bundled-only session workflow
api.scheduleSessionTurn / api.unscheduleSessionTurnsByTag (plugin call): not a registration method; owned by cron
api.onConversationBindingResolved (plugin call): not a registration method; conversation bindings owned by channels
registerSandboxBackend (openclaw/plugin-sdk/sandbox) (plugin call): SDK module function, not an api.register* method; owned by sandbox
session discussion provider (openclaw/plugin-sdk/session-discussion) (plugin call): SDK module function; owned by the btw side-discussion tool
api.runtime.* helpers (plugin call): consumed from the area each helper wraps (bound)
Broadcast events plugins.changed, plugins.install.progress, plugins.controlUi.changed, plugin.approval.requested, plugin.approval.resolved: internal; the product emits them, they are not entry points (not counted)
/plugin (singular): alias of /plugins
tools.catalog: consumed from agents (plugin tool previews)
mcp.authLogin: consumed from MCP (plugin MCP sign-in calls it)
config.get, config.schema, config.set, config.patch: consumed from config (the plugin settings editor and Advanced tab read and write config through them)
openclaw-plugin-inspector: external package, not shipped by the product
api.on: registration mechanism for typed hooks; each hook name is counted under its operation
UI Logbook plugin page controls (ui/src/pages/plugin/logbook-view.ts): owned by the Logbook plugin's feature area (bound)
UI settings navigation, sidebar, theme and account controls around the plugin pages: shell

## Conditions
| Condition | Source | Kind | Persona trait |
| --- | --- | --- | --- |
| C1 plugin-config-edit-hot-replaces-instance | docs/plugins/hooks.md "Quick start"; docs/tools/plugin.md "Quick start"; docs/tools/plugin.md "Plugin hooks"; docs/plugins/manage-plugins.md "Apply changes and inspect"; docs/plugins/hooks.md "Permissions and scope"; docs/cli/plugins/list.md "List"; docs/plugins/hooks/reference.md "Hook catalog" | event | plugin-fixture-surfaces |
| C2 gateway-stopped-change-saved-for-next-start | docs/plugins/tool-plugins.md "Install and inspect locally"; docs/plugins/manage-plugins.md "Apply changes and inspect"; docs/cli/plugins/install.md "Install"; docs/cli/plugins/install.md "Enable installed plugins"; docs/cli/plugins/uninstall-and-update.md "(intro)"; docs/plugins/bundles.md "Install a bundle"; docs/plugins/plugin-inventory.md "Install a plugin"; docs/cli/plugins/inspect-and-diagnose.md "Inspect"; docs/plugins/feature-plugins.md "Approve an agent-built artifact"; docs/tools/plugin.md "Quick start"; docs/cli/plugins/install.md "Install", "Enable installed plugins"; docs/cli/plugins.md "`openclaw plugins`" | event | plugin-fixture-surfaces |
| C3 replacement-drains-in-flight-plugin-work | docs/plugins/manage-plugins.md "Use the Control UI"; docs/cli/plugins/install.md "Install"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | ambient | plugin-fixture-surfaces, mock-provider-tool-calls |
| C4 drain-budget-exceeded-previous-generation-keeps-serving | docs/plugins/manage-plugins.md "Use the Control UI"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | event | plugin-fixture-surfaces, mock-provider-tool-calls |
| C5 reload-wait-cancelled-before-publication | docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | event | plugin-fixture-surfaces |
| C6 reload-requested-from-turn-holding-the-plugin | docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | event | plugin-fixture-surfaces, mock-provider-tool-calls |
| C7 replacement-fails-before-publication-recovers-previous-code | docs/plugins/manage-plugins.md "Use the Control UI"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation" | event | plugin-fixture-surfaces |
| C8 replacement-fails-after-publication | docs/plugins/manage-plugins.md "Use the Control UI"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation" | event | plugin-fixture-surfaces |
| C9 recovery-cannot-complete-ready-state-reports-plugin-reload | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/cli/plugins/uninstall-and-update.md "Reload" | event | plugin-fixture-surfaces |
| C10 install-saved-but-runtime-activation-failed | docs/plugins/tool-plugins.md "Tool does not appear after install"; docs/plugins/manage-plugins.md "Use the Control UI"; docs/plugins/manage-plugins.md "Manage plugins from an agent conversation"; docs/cli/plugins/install.md "Install"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation"; docs/plugins/manage-plugins.md "Use the Control UI", "Manage plugins from an agent conversation" | ambient | plugins-broken-installs |
| C11 bundled-code-edited-while-loaded-restart-required | docs/plugins/manage-plugins.md "Apply changes and inspect"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/tools/plugin.md "Verify the active Gateway", "Plugin hooks"; docs/cli/plugins/list.md "List"; docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)" | event | plugins-bundled-and-external |
| C12 passive-config-reload-disabled | docs/plugins/manage-plugins.md "Apply changes and inspect"; docs/cli/plugins/list.md "List"; docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary" | event | plugin-fixture-surfaces |
| C13 disable-cleanup-leaves-process-state | docs/plugins/manage-plugins.md "Apply changes and inspect"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | ambient | plugin-fixture-surfaces |
| C14 another-lifecycle-operation-already-applying | docs/cli/plugins/uninstall-and-update.md "(intro)"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation" | event | plugin-fixture-surfaces |
| C15 plugin-changed-during-agent-run | docs/plugins/manage-plugins.md "Manage plugins from an agent conversation"; docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)"; docs/plugins/tool-plugins.md "Owner-authorized continuations"; docs/plugins/hooks/reference.md "Hook catalog"; docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/plugins/architecture-internals/packaging.md "Plugin SDK import paths"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/cli/plugins/uninstall-and-update.md "Reload" | event | plugin-fixture-surfaces, mock-provider-tool-calls |
| C16 nix-mode-or-read-only-config | docs/tools/plugin.md "Troubleshooting"; docs/plugins/manage-plugins.md "Use the Control UI"; docs/plugins/manage-plugins.md "Uninstall plugins"; docs/cli/plugins.md "Commands"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/gateway/protocol/rpc-system-and-channels.md "Plugin management"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation"; docs/plugins/manage-plugins.md "Use the Control UI", "Uninstall plugins"; docs/gateway/protocol/rpc-system-and-channels.md "Plugin management", "Catalog detail and client confirmation" | ambient | config-read-only-environment |
| C17 plugins-globally-disabled | docs/tools/plugin.md "Configure plugin policy"; docs/cli/plugins/install.md "Enable installed plugins" | event | plugins-bundled-and-external |
| C18 plugin-in-deny-list | docs/tools/plugin.md "Configure plugin policy"; docs/plugins/manage-plugins.md "Use the Control UI"; docs/cli/plugins/install.md "Enable installed plugins" | ambient | plugins-policy-mixed |
| C19 restrictive-allowlist | docs/tools/plugin.md "Quick start"; docs/tools/plugin.md "Configure plugin policy"; docs/plugins/manage-plugins.md "Use the Control UI"; docs/cli/plugins/install.md "Install"; docs/cli/plugins/install.md "Enable installed plugins"; docs/tools/plugin.md "Quick start", "Configure plugin policy" | event | plugins-policy-mixed |
| C20 plugin-entry-disabled-config-kept | docs/tools/plugin.md "Configure plugin policy"; docs/plugins/manifest.md "Configuration validation"; docs/plugins/manage-plugins.md "Capability consent"; docs/cli/plugins/uninstall-and-update.md "Uninstall" | ambient | plugins-policy-mixed |
| C21 allowlist-unset-with-discovered-non-bundled-plugins | docs/tools/plugin.md "Configure plugin policy"; docs/cli/plugins/list.md "List" | ambient | plugins-local-sources |
| C22 plugin-loaded-without-install-provenance | docs/tools/plugin.md "Configure plugin policy"; docs/cli/plugins/list.md "List"; docs/plugins/architecture.md "Execution model"; docs/tools/plugin.md "Configure plugin policy", "Plugin runtime trust refused"; docs/cli/plugins/install.md "Install" | ambient | plugins-local-sources |
| C23 stale-plugin-ids-in-config | docs/tools/plugin.md "Configure plugin policy"; docs/tools/plugin.md "Troubleshooting"; docs/plugins/manifest.md "Configuration validation"; docs/cli/plugins/inspect-and-diagnose.md "Doctor"; docs/tools/plugin.md "Configure plugin policy", "Troubleshooting" | ambient | plugins-policy-mixed |
| C24 exclusive-slot-selected | docs/tools/plugin.md "Configure plugin policy"; docs/cli/plugins/uninstall-and-update.md "Uninstall"; docs/plugins/manifest.md "Configuration validation"; docs/plugins/manifest.md "Notes"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/plugins/manifest.md "Configuration validation", "Notes" | ambient | plugins-policy-mixed |
| C25 bundled-default-enablement | docs/tools/plugin.md "Configure plugin policy"; docs/plugins/manage-plugins.md "Enable and disable plugins"; docs/cli/plugins.md "Commands"; docs/plugins/manifest.md "Top-level field reference"; docs/plugins/plugin-inventory.md "Definitions", "Install a plugin" | ambient | plugins-bundled-and-external |
| C26 bundled-plugin-auto-activated-by-config | docs/tools/plugin.md "Configure plugin policy"; docs/plugins/manifest.md "Top-level field reference"; docs/plugins/architecture-internals/load-pipeline.md "Manifest-first behavior"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | ambient | plugins-bundled-and-external, config-provider-without-models |
| C27 workspace-origin-plugin-disabled-by-default | docs/tools/plugin.md "Configure plugin policy"; docs/cli/plugins/install.md "Local paths and bundle formats"; docs/plugins/architecture.md "Execution model"; docs/cli/plugins/inspect-and-diagnose.md "Inspect" | ambient | plugins-local-sources |
| C28 load-path-or-linked-local-plugin | docs/tools/plugin.md "Configure plugin policy"; docs/plugins/manage-plugins.md "Capability consent"; docs/cli/plugins/install.md "Install"; docs/cli/plugins/install.md "Local paths and bundle formats"; docs/plugins/dependency-resolution.md "Local plugins"; docs/plugins/architecture.md "Execution model"; docs/plugins/architecture.md "Runtime instance and source lifetime" | ambient | plugins-local-sources |
| C29 standalone-script-in-extensions-root | docs/cli/plugins/install.md "Local paths and bundle formats"; docs/plugins/manage-plugins.md "Choose a source" | ambient | plugins-local-sources |
| C30 compatible-bundle-installed | docs/plugins/bundles.md "Skill content"; docs/plugins/bundles.md "Agent Plugins bundles"; docs/plugins/bundles.md "Claude bundles"; docs/plugins/bundles.md "Cursor bundles"; docs/tools/plugin.md "Understand plugin formats"; docs/cli/plugins/install.md "Local paths and bundle formats"; docs/plugins/bundles.md "Supported now"; docs/plugins/bundles.md "Hook packs"; docs/plugins/bundles.md "Embedded OpenClaw settings"; docs/plugins/bundles.md "Detected but not executed"; docs/plugins/bundles.md "Bundle formats"; docs/plugins/bundles.md "Detection precedence"; docs/plugins/bundles.md "Security"; docs/plugins/bundles.md "Install a bundle", "Supported now", "Skill content", "Hook packs", "Embedded OpenClaw settings", "Embedded OpenClaw LSP", "Detected but not executed", "MCP for embedded OpenClaw", "Tool naming", "Bundle formats", "Detection precedence", "Security" | ambient | plugins-local-sources |
| C31 bundle-mcp-tools-in-agent-turn | docs/plugins/bundles.md "MCP for embedded OpenClaw"; docs/plugins/bundles.md "Transports"; docs/plugins/bundles.md "Tool naming"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | ambient | plugins-local-sources, mock-provider-tool-calls |
| C32 turn-cancel-during-bundle-lsp-startup | docs/plugins/bundles.md "Embedded OpenClaw LSP" | event | plugin-lsp-held-initialize, mock-provider-scripted |
| C33 hook-pack-installed | docs/cli/plugins/install.md "Hook packs and npm specs" | ambient | plugins-local-sources |
| C34 multi-entry-package-installed | docs/plugins/manage-plugins.md "Install plugins"; docs/plugins/manage-plugins.md "Update plugins"; docs/plugins/manage-plugins.md "Uninstall plugins"; docs/cli/plugins/inspect-and-diagnose.md "Inspect"; docs/cli/plugins/uninstall-and-update.md "Uninstall"; docs/plugins/manifest.md "Top-level field reference"; docs/plugins/manage-plugins.md "Install plugins", "Update plugins"; docs/cli/plugins/uninstall-and-update.md "Uninstall", "Resolving plugin id vs npm spec"; docs/plugins/architecture-internals/packaging.md "Package packs" | ambient | plugins-local-sources |
| C35 package-ownership-ambiguous | docs/plugins/manage-plugins.md "Update plugins"; docs/cli/plugins/uninstall-and-update.md "Uninstall"; docs/cli/plugins/inspect-and-diagnose.md "Inspect"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation" | ambient | plugins-broken-installs |
| C36 orphan-install-record | docs/cli/plugins/uninstall-and-update.md "Uninstall"; docs/cli/plugins/uninstall-and-update.md "Update" | ambient | plugins-broken-installs |
| C37 third-party-capability-consent-required | docs/plugins/manage-plugins.md "Capability consent"; docs/cli/plugins/install.md "Install"; docs/gateway/protocol/rpc-system-and-channels.md "Plugin management"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation"; docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary" | ambient | plugins-third-party-consented |
| C38 update-declares-new-capabilities | docs/plugins/manage-plugins.md "Capability consent"; docs/cli/plugins/uninstall-and-update.md "Reload" | event | plugins-third-party-consented |
| C39 first-party-plugin-consent-exempt | docs/plugins/manage-plugins.md "Capability consent"; docs/cli/plugins/install.md "Install" | ambient | plugins-bundled-and-external |
| C40 non-interactive-caller-cannot-approve-capabilities | docs/plugins/manage-plugins.md "Capability consent"; docs/tools/plugin.md "Quick start"; docs/plugins/manage-plugins.md "Capability consent", "Install plugins"; docs/cli/plugins/install.md "Install", "--force confirmation and reinstall vs update"; docs/cli/plugins/uninstall-and-update.md "Uninstall", "Reload" | ambient | plugins-third-party-consented |
| C41 trust-gated-capability-refused-for-local-copy | docs/tools/plugin.md "Plugin runtime trust refused"; docs/cli/plugins/install.md "Install"; docs/plugins/manage-plugins.md "Capability consent" | ambient | plugins-local-sources |
| C42 unsafe-plugin-path-blocked | docs/tools/plugin.md "Blocked plugin path ownership"; docs/cli/plugins/inspect-and-diagnose.md "Doctor"; docs/plugins/architecture-internals/load-pipeline.md "Load pipeline"; docs/plugins/architecture-internals/packaging.md "Package packs" | ambient | plugins-broken-installs |
| C43 clawhub-release-audit-outcome | docs/cli/plugins/install.md "ClawHub security audit"; docs/cli/plugins/uninstall-and-update.md "ClawHub Security Audit on update"; docs/plugins/community.md "Publish plugins" | ambient | none |
| C44 clawhub-registry-unreachable | docs/gateway/protocol/rpc-system-and-channels.md "Plugin management"; docs/gateway/protocol/rpc-system-and-channels.md "Browse and search"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation", "Browse and search", "Bulk keyword discovery" | event | none |
| C45 update-channel-beta-or-extended-stable | docs/cli/plugins/install.md "Install"; docs/cli/plugins/uninstall-and-update.md "Beta channel updates" | event | plugins-npm-tracked |
| C46 npm-latest-release-incompatible-or-prerelease | docs/tools/plugin.md "Choose an install source"; docs/cli/plugins/install.md "Hook packs and npm specs"; docs/cli/plugins/install.md "Hook packs and npm specs", "Sources and locators" | ambient | none |
| C47 npm-artifact-integrity-drift | docs/cli/plugins/uninstall-and-update.md "Version checks and integrity drift"; docs/cli/plugins/install.md "Sources and locators" | event | none |
| C48 installed-plugin-already-at-target-version | docs/cli/plugins/uninstall-and-update.md "Version checks and integrity drift" | ambient | plugins-npm-tracked |
| C49 exact-pinned-install-records | docs/plugins/manage-plugins.md "Update plugins"; docs/cli/plugins/install.md "--pin scope"; docs/cli/plugins/uninstall-and-update.md "Resolving plugin id vs npm spec"; docs/cli/plugins/uninstall-and-update.md "Resolving plugin id vs npm spec", "Existing plugin source choices", "Version checks and integrity drift" | ambient | plugins-npm-tracked |
| C50 managed-npm-install-incomplete | docs/cli/plugins/install.md "--force confirmation and reinstall vs update"; docs/tools/plugin.md "Troubleshooting" | ambient | plugins-broken-installs |
| C51 plugin-missing-runtime-dependency | docs/plugins/manage-plugins.md "List and search plugins"; docs/plugins/dependency-resolution.md "(intro)"; docs/plugins/tool-plugins.md "`Cannot find package 'typebox'`"; docs/plugins/dependency-resolution.md "Missing runtime imports"; docs/plugins/dependency-resolution.md "Startup and reload"; docs/cli/plugins/list.md "List"; docs/cli/plugins/inspect-and-diagnose.md "Inspect"; docs/tools/plugin.md "Troubleshooting"; docs/plugins/dependency-resolution.md "Responsibility split", "Missing runtime imports", "Startup and reload", "Local plugins" | ambient | plugins-broken-installs |
| C52 host-config-or-plugin-config-invalid | docs/cli/plugins/install.md "Config includes and invalid-config repair"; docs/tools/plugin.md "Troubleshooting"; docs/plugins/manifest.md "JSON Schema requirements"; docs/plugins/manage-plugins.md "Install plugins" | event | plugin-fixture-surfaces |
| C53 plugins-config-in-include-file | docs/cli/plugins/install.md "Config includes and invalid-config repair"; docs/plugins/feature-plugins.md "Approve an agent-built artifact"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation" | ambient | config-plugins-include |
| C54 installed-plugin-missing-required-config | docs/plugins/manage-plugins.md "Install plugins"; docs/cli/plugins/install.md "Config includes and invalid-config repair" | ambient | plugins-broken-installs |
| C55 plugin-already-installed | docs/cli/plugins/install.md "--force confirmation and reinstall vs update"; docs/cli/plugins/install.md "Git repositories"; docs/cli/plugins/install.md "--force confirmation and reinstall vs update", "Git repositories"; docs/plugins/manage-plugins.md "Install plugins" | ambient | plugins-bundled-and-external |
| C56 superseded-plugin-generation-retired | docs/plugins/dependency-resolution.md "Install roots"; docs/cli/plugins/install.md "--force confirmation and reinstall vs update"; docs/cli/plugins/inspect-and-diagnose.md "Registry" | event | plugin-fixture-surfaces |
| C57 legacy-plugin-install-state | docs/cli/plugins/list.md "Plugin index"; docs/plugins/dependency-resolution.md "Legacy cleanup"; docs/plugins/dependency-resolution.md "Host peer dependency"; docs/cli/plugins/inspect-and-diagnose.md "Registry"; docs/cli/plugins/install.md "Archives"; docs/plugins/dependency-resolution.md "Startup and reload"; docs/plugins/dependency-resolution.md "Legacy cleanup", "Install roots"; docs/cli/plugins/uninstall-and-update.md "Update" | event | plugins-legacy-state |
| C58 plugin-index-unreadable | docs/cli/plugins/list.md "Plugin index" | event | none |
| C59 persisted-registry-differs-from-derived | docs/cli/plugins/inspect-and-diagnose.md "Registry" | ambient | plugin-fixture-surfaces |
| C60 managed-plugin-payload-verification-fails-at-startup | docs/tools/plugin.md "Troubleshooting"; docs/cli/plugins/inspect-and-diagnose.md "Doctor" | event | plugin-fixture-surfaces |
| C61 provider-or-harness-plugin-fails-to-load | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/cli/plugins/inspect-and-diagnose.md "Inspect"; docs/plugins/compatibility.md "Session-store bridge retirement"; docs/plugins/architecture-internals/packaging.md "Plugin SDK import paths" | ambient | plugins-broken-installs |
| C62 plugin-on-deprecated-contract | docs/plugins/compatibility.md "Synchronous plugin state"; docs/plugins/compatibility.md "Deprecation policy"; docs/plugins/compatibility.md "Current compatibility areas"; docs/plugins/architecture.md "Compatibility signals"; docs/plugins/hooks.md "Upcoming deprecations"; docs/plugins/manifest.md "Notes"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins"; docs/plugins/compatibility.md "(intro)", "Deprecation policy", "Current compatibility areas"; docs/plugins/hooks.md "(intro)", "Upcoming deprecations" | ambient | plugins-broken-installs |
| C63 duplicate-or-malformed-registration | docs/plugins/hooks.md "(intro)"; docs/tools/plugin.md "Troubleshooting"; docs/plugins/architecture.md "Contracts and enforcement"; docs/plugins/building-plugins.md "Registering tools"; docs/plugins/architecture-internals/load-pipeline.md "Manifest-first behavior"; docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary"; docs/plugins/architecture.md "Execution model"; docs/plugins/architecture-internals/load-pipeline.md "Manifest-first behavior", "Plugin cache boundary" | ambient | plugin-fixture-surfaces |
| C64 gateway-killed-leases-and-captures-reclaimed | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table", "Runtime instance and source lifetime" | event | plugin-fixture-surfaces |
| C65 hourly-capture-cleanup-sweep | docs/plugins/architecture.md "Runtime instance and source lifetime" | event | none |
| C66 captures-fall-back-to-system-temp | docs/plugins/architecture.md "Runtime instance and source lifetime" | event | plugin-fixture-surfaces |
| C67 model-catalog-worker-fails-or-stalls | docs/plugins/architecture.md "Runtime instance and source lifetime" | event | none |
| C68 run-outside-canonical-workspace-reuses-generation | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary" | ambient | cron-job-isolated, plugin-fixture-surfaces |
| C69 failed-plugin-module-evaluation-retained | docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary"; docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/plugins/architecture.md "Architecture overview" | ambient | plugins-broken-installs |
| C70 durable-final-reply-across-unrelated-reload | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table" | event | channels-test-accounts, mock-provider-held-turn |
| C71 cron-reconciled-and-cron-changed | docs/plugins/hooks/lifecycle.md "Gateway lifecycle"; docs/plugins/hooks/lifecycle.md "Safe external cron projection" | event | cron-job-isolated, plugin-fixture-surfaces |
| C72 slow-plugin-tool-construction | docs/tools/plugin.md "Slow plugin tool setup" | ambient | plugin-fixture-surfaces |
| C73 plugin-hook-handler-times-out | docs/plugins/hooks.md "Troubleshooting"; docs/plugins/hooks/reference.md "Registration and execution"; docs/plugins/hooks/lifecycle.md "Install hooks" | event | plugin-fixture-surfaces |
| C74 conversation-hooks-without-access-grant | docs/plugins/hooks.md "Permissions and scope"; docs/cli/plugins/list.md "List"; docs/plugins/hooks/reference.md "Hook catalog"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugins-local-sources |
| C75 incognito-session-hooks-redacted | docs/plugins/hooks.md "Permissions and scope"; docs/plugins/hooks/reference.md "Hook catalog" | ambient | none |
| C76 hooks-not-emitted-by-native-harness | docs/plugins/hooks.md "Choose a hook" | ambient | none |
| C77 several-plugins-handle-one-hook | docs/plugins/hooks.md "Troubleshooting"; docs/plugins/hooks/reference.md "Registration and execution" | ambient | plugin-fixture-surfaces, plugins-local-sources |
| C78 hook-limited-to-eligible-triggers | docs/plugins/hooks/reference.md "Registration and execution" | ambient | plugin-fixture-surfaces, config-heartbeat-short |
| C79 plugin-approval-pending | docs/plugins/plugin-permission-requests.md "Request approval before a tool call"; docs/plugins/plugin-permission-requests.md "Declare approval scope"; docs/plugins/plugin-permission-requests.md "Decision behavior" | ambient | plugin-fixture-surfaces, mock-provider-tool-calls |
| C80 plugin-approval-times-out | docs/plugins/plugin-permission-requests.md "Decision behavior"; docs/plugins/plugin-permission-requests.md "Request approval before a tool call", "Decision behavior" | event | plugin-fixture-surfaces, mock-provider-tool-calls |
| C81 run-aborted-with-pending-approval | docs/plugins/plugin-permission-requests.md "Decision behavior" | event | plugin-fixture-surfaces, mock-provider-tool-calls |
| C82 no-approval-route | docs/plugins/plugin-permission-requests.md "Decision behavior"; docs/plugins/plugin-permission-requests.md "Troubleshooting"; docs/plugins/plugin-permission-requests.md "Decision behavior", "Troubleshooting" | ambient | plugin-fixture-surfaces |
| C83 plugin-approvals-forwarded-to-chat-target | docs/plugins/plugin-permission-requests.md "Route approval prompts" | event | channels-test-accounts, plugin-fixture-surfaces |
| C84 slack-plugin-approval-reviewer-lists | docs/plugins/plugin-permission-requests.md "Route approval prompts" | ambient | none |
| C85 codex-native-permission-relay | docs/plugins/plugin-permission-requests.md "Codex native permissions" | ambient | none |
| C86 custom-plugin-ui-lab-off | docs/plugins/feature-plugins.md "Enable custom plugin UI"; docs/cli/plugins/authoring.md "Feature scaffold and artifacts"; docs/plugins/sdk-overview.md "API stability" | event | plugin-fixture-feature-ui |
| C87 control-ui-on-plain-http-lan-origin | docs/plugins/feature-plugins.md "(intro)"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugin-fixture-feature-ui |
| C88 workspace-replacement-hides-navigation | docs/plugins/feature-plugins.md "Create a feature plugin" | ambient | plugin-fixture-feature-ui |
| C89 plugin-ui-asset-revision-cache-full | docs/plugins/feature-plugins.md "Build and reload" | event | none |
| C90 plugin-ui-activation-fails | docs/plugins/feature-plugins.md "Build and reload" | event | plugin-fixture-feature-ui |
| C91 control-ui-reconnects | docs/plugins/feature-plugins.md "Build and reload"; docs/plugins/feature-plugins.md "Define operations once"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins"; docs/plugins/sdk-overview/host-hooks.md "Docked link readers"; docs/plugins/feature-plugins.md "Define operations once", "Build and reload"; docs/plugins/architecture.md "Skill previews" | event | plugin-fixture-feature-ui |
| C92 plugin-view-session-identity-changes | docs/plugins/feature-plugins.md "Contribute and replace views"; docs/plugins/feature-plugins.md "Dock a conversation" | event | plugin-fixture-feature-ui, session-main-rolling |
| C93 plugin-contributions-follow-enablement | docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins"; docs/plugins/sdk-overview/host-hooks.md "Docked link readers"; docs/plugins/feature-plugins.md "Contribute and replace views"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins", "Docked link readers" | ambient | plugin-fixture-surfaces |
| C94 plugin-tab-slug-reserved-or-colliding | docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugin-fixture-surfaces |
| C95 pending-artifact-import-expires | docs/plugins/feature-plugins.md "Approve an agent-built artifact" | event | none |
| C96 artifact-activation-refused | docs/plugins/feature-plugins.md "Approve an agent-built artifact" | ambient | config-plugins-include |
| C97 no-connected-browser-no-activation-receipt | docs/plugins/feature-plugins.md "Approve an agent-built artifact" | ambient | plugin-fixture-feature-ui |
| C98 marketplace-feed-falls-back | docs/cli/plugins/marketplace.md "Marketplace" | ambient | none |
| C99 claude-marketplace-sources-available | docs/cli/plugins/install.md "Marketplace shorthand"; docs/cli/plugins/install.md "Marketplace sources"; docs/cli/plugins/install.md "Remote marketplace rules"; docs/cli/plugins/install.md "Marketplace shorthand", "Marketplace sources" | ambient | marketplace-local |
| C100 keyword-results-change-during-paging | docs/gateway/protocol/rpc-system-and-channels.md "Bulk keyword discovery" | event | none |
| C101 client-on-gateway-without-catalog-methods | docs/gateway/protocol/rpc-system-and-channels.md "ClawHub catalog discovery" | ambient | none |
| C102 generated-plugin-metadata-stale | docs/plugins/tool-plugins.md "`plugin entry not found: ./dist/index.js`"; docs/plugins/tool-plugins.md "`plugin entry does not expose defineToolPlugin metadata`"; docs/plugins/tool-plugins.md "`openclaw.plugin.json generated metadata is stale`"; docs/plugins/tool-plugins.md "`package.json openclaw.extensions must include ./dist/index.js`"; docs/cli/plugins/authoring.md "Author"; docs/plugins/tool-plugins.md "Generated metadata"; docs/plugins/tool-plugins.md "Validate in CI"; docs/plugins/tool-plugins.md "Troubleshooting" | ambient | none |
| C103 scaffold-or-pack-target-exists | docs/plugins/tool-plugins.md "Quickstart"; docs/cli/plugins/authoring.md "Feature scaffold and artifacts" | ambient | none |
| C104 codex-plugin-installed-enabled-accessible-states | docs/plugins/codex-native-plugins.md "Requirements"; docs/plugins/codex-native-plugins.md "How native plugin setup works"; docs/plugins/codex-native-plugins.md "Manage plugins from chat"; docs/plugins/codex-native-plugins.md "Requirements", "How native plugin setup works", "Support boundary", "Manage plugins from chat" | ambient | none |
| C105 codex-plugin-app-needs-sign-in | docs/plugins/codex-native-plugins.md "Quickstart"; docs/plugins/codex-native-plugins.md "Manage plugins from chat" | ambient | none |
| C106 codex-scheduled-run-with-captured-app-authority | docs/plugins/codex-native-plugins.md "Scheduled automations" | ambient | none |
| C107 codex-app-inventory-cached-stale-or-failed | docs/plugins/codex-native-plugins.md "App inventory and ownership"; docs/plugins/codex-native-plugins.md "Thread app config"; docs/plugins/codex-native-plugins.md "Troubleshooting"; docs/plugins/codex-native-plugins.md "App inventory and ownership", "Connected account apps", "Thread app config" | ambient | none |
| C108 codex-account-apps-admitted-by-allow-all-plugins | docs/plugins/codex-native-plugins.md "Connected account apps" | ambient | none |
| C109 codex-destructive-action-policy | docs/plugins/codex-native-plugins.md "Destructive action policy"; docs/plugins/codex-native-plugins.md "Destructive action policy", "Native approval mode", "Approval examples" | ambient | none |
| C110 codex-plugin-change-applies-to-new-conversations | docs/plugins/codex-native-plugins.md "Quickstart"; docs/plugins/codex-native-plugins.md "Quickstart", "Connected account apps", "Troubleshooting" | event | none |
| C111 bun-runtime | docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation" | ambient | none |
| C112 docker-image-with-bundled-source-overlay | docs/cli/plugins/list.md "List"; docs/tools/plugin.md "Blocked plugin path ownership" | ambient | none |
| C113 source-checkout-host-built-plugins | docs/plugins/dependency-resolution.md "Bundled plugins"; docs/cli/plugins/uninstall-and-update.md "Update"; docs/plugins/plugin-inventory.md "Definitions"; docs/plugins/architecture.md "Execution model" | ambient | none |
| C114 maintainer-install-overrides-environment | docs/plugins/install-overrides.md "Environment"; docs/plugins/install-overrides.md "Behavior"; docs/cli/plugins/install.md "Install"; docs/plugins/install-overrides.md "Environment", "Behavior" | ambient | none |
| C115 lifecycle-timing-or-load-debug-environment | docs/cli/plugins.md "Commands"; docs/cli/plugins/inspect-and-diagnose.md "Doctor" | ambient | plugins-broken-installs |
| C116 claw-references-plugin | docs/plugins/manage-plugins.md "Uninstall plugins"; docs/cli/plugins/install.md "Install" | ambient | claws-package-installed |
| C117 bundled-code-mode-executor-survives-plugin-disable | docs/plugins/sdk-entrypoints.md "Code Mode executor runtime" | ambient | none |
| C118 external-channel-catalog-file | docs/plugins/architecture-internals/packaging.md "Channel catalog metadata" | ambient | plugins-external-channel-catalog |
| C119 disabled-or-unconfigured-channel-plugin-loads-setup-entry | docs/plugins/architecture-internals/packaging.md "Package packs" | ambient | plugins-policy-mixed |
| C120 plugin-method-in-reserved-admin-namespace | docs/plugins/architecture-internals/packaging.md "Package packs"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins"; docs/plugins/building-plugins.md "Import conventions" | ambient | plugin-fixture-surfaces |
| C121 optional-plugin-tool-not-allowlisted | docs/plugins/plugin-permission-requests.md "Choose the right gate"; docs/plugins/building-plugins.md "Registering tools"; docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)" | ambient | plugin-fixture-surfaces |
| C122 tool-result-mismatches-output-schema | docs/plugins/tool-plugins.md "Output contracts" | ambient | plugin-fixture-surfaces |
| C123 skill-preview-connection-retired | docs/plugins/architecture.md "Skill previews"; docs/plugins/feature-plugins.md "Define operations once", "Build and reload"; docs/plugins/sdk-overview/host-hooks.md "Docked link readers" | event | plugin-fixture-surfaces |
| C124 plugin-runtime-cleanup-on-session-reset-or-delete | docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | event | plugin-fixture-surfaces |
| C125 invalid-board-widget-content-kind | docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugins-broken-installs |
| C126 trusted-policy-or-middleware-without-contract | docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins"; docs/plugins/sdk-overview/host-hooks.md "When to use tool-result middleware"; docs/plugins/building-plugins.md "Quickstart"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins", "When to use tool-result middleware" | ambient | plugin-fixture-surfaces |
| C127 load-path-re-added-during-uninstall-drain | docs/cli/plugins/uninstall-and-update.md "Uninstall" | event | plugins-local-sources, mock-provider-tool-calls |
| C128 uninstall-drain-or-file-removal-fails | docs/cli/plugins/uninstall-and-update.md "Uninstall" | event | plugin-fixture-surfaces |
| C129 pending-doctor-repairs-or-migrations-at-update | docs/cli/plugins/uninstall-and-update.md "Update" | ambient | plugins-legacy-state |
| C130 update-finalization-fails-and-rolls-back | docs/cli/plugins/uninstall-and-update.md "Update" | event | none |
| C131 official-plugin-renamed-or-id-replaced | docs/cli/plugins/uninstall-and-update.md "Resolving plugin id vs npm spec"; docs/plugins/architecture-internals/packaging.md "Channel catalog metadata" | ambient | none |
| C132 clawhub-and-npm-release-lag | docs/cli/plugins/uninstall-and-update.md "Existing plugin source choices" | ambient | none |
| C133 core-update-converges-plugins | docs/cli/plugins/uninstall-and-update.md "Update"; docs/cli/plugins/uninstall-and-update.md "Beta channel updates"; docs/plugins/manifest.md "Retained state checks" | event | none |
| C134 mixed-case-plugin-id | docs/cli/plugins.md "`openclaw plugins`"; docs/cli/plugins/uninstall-and-update.md "Uninstall"; docs/plugins/manifest.md "Configuration validation" | ambient | plugins-local-sources |
| C135 channel-pairing-request-observed-by-plugin | docs/plugins/hooks/reference.md "Channel pairing requests" | ambient | channels-test-accounts, plugin-fixture-surfaces |
| C136 inbound-claim-fails-for-bound-conversation | docs/plugins/hooks/reference.md "Registration and execution" | ambient | none |
| C137 failed-compaction-emits-no-after-compaction | docs/plugins/hooks/reference.md "Hook catalog" | ambient | none |
| C138 required-companion-plugin-missing | docs/plugins/manifest.md "Top-level field reference" | ambient | plugins-local-sources |
| C139 legacy-plugin-id-in-config | docs/plugins/manifest.md "Top-level field reference" | ambient | plugins-policy-mixed |
| C140 plugin-mcp-server-overridden-by-operator | docs/plugins/manifest.md "Top-level field reference"; docs/plugins/bundles.md "MCP for embedded OpenClaw" | ambient | plugins-local-sources |
| C141 broken-capability-catalog-entry | docs/plugins/manifest.md "Capability catalogs" | ambient | plugins-broken-installs |
| C142 missing-or-invalid-plugin-manifest | docs/plugins/manifest.md "(intro)"; docs/plugins/manifest.md "Configuration validation"; docs/cli/plugins/inspect-and-diagnose.md "Doctor"; docs/plugins/manifest.md "(intro)", "JSON Schema requirements", "Capability catalogs", "Configuration validation"; docs/cli/plugins/install.md "Archives" | ambient | plugins-broken-installs |
| C143 install-policy-warns-or-blocks | docs/tools/plugin.md "Operator install policy"; docs/cli/plugins/install.md "--acknowledge-install-policy-warning"; docs/cli/plugins/uninstall-and-update.md "--acknowledge-install-policy-warning on update"; docs/plugins/hooks/lifecycle.md "Install hooks"; docs/gateway/protocol/rpc-system-and-channels.md "Plugin management" | ambient | config-install-policy |
| C144 prompt-injection-disallowed-for-plugin | docs/plugins/hooks.md "Permissions and scope"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugins-local-sources |
| C145 same-plugin-id-from-several-sources | docs/plugins/architecture.md "Execution model"; docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary" | ambient | plugins-local-sources |
| C146 second-session-discussion-provider-registered | docs/plugins/sdk-overview.md "Session discussion provider" | ambient | none |
| C147 enabled-plugin-adds-media-catalog-category | docs/plugins/manifest.md "Catalog categories" | ambient | plugins-bundled-and-external |
| C148 workspace-discovery-without-system-owner | docs/cli/plugins/inspect-and-diagnose.md "Inspect" | ambient | none |
| C149 cli-connected-to-remote-gateway-with-local-source | docs/cli/plugins/install.md "Install"; docs/gateway/protocol/rpc-system-and-channels.md "Plugin management" | ambient | none |
| C150 plugin-cli-registered-lazily-on-first-invocation | docs/plugins/architecture.md "Architecture overview" | ambient | plugin-fixture-surfaces |
| C151 plugin-tool-delivery-only-in-active-channel-turn | docs/plugins/building-plugins.md "Registering tools"; docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)" | ambient | channels-test-accounts, plugin-fixture-surfaces |
| C152 plugin-tool-constructed-in-sandboxed-session | docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)" | ambient | none |
| C153 config-references-missing-downloadable-plugin | docs/plugins/dependency-resolution.md "Startup and reload"; docs/plugins/bundles.md "Runtime dependencies and cleanup" | ambient | plugins-legacy-state |
| C154 file-symlinks-unavailable | docs/plugins/architecture.md "Runtime instance and source lifetime" | ambient | none |
| C155 metadata-snapshot-reused-after-startup | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary" | ambient | plugin-fixture-surfaces |
| C156 plugin-registration-throws | docs/plugins/architecture.md "Architecture overview"; docs/plugins/architecture.md "Architecture overview", "Plugin metadata snapshot and lookup table", "Compatibility signals"; docs/tools/plugin.md "Troubleshooting"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugins-broken-installs |
| C157 read-only-operator | docs/plugins/manage-plugins.md "Use the Control UI"; docs/gateway/protocol/rpc-system-and-channels.md "Plugin management" | ambient | operator-read-only-profile |
| C158 gateway-restart-reloads-plugins | docs/plugins/hooks/lifecycle.md "Gateway lifecycle"; docs/plugins/hooks/lifecycle.md "Safe external cron projection"; docs/plugins/hooks/reference.md "Hook catalog"; docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/plugins/architecture-internals/load-pipeline.md "Manifest-first behavior"; docs/plugins/architecture-internals/load-pipeline.md "Load pipeline"; docs/tools/plugin.md "Plugin hooks"; docs/tools/plugin.md "Troubleshooting"; docs/cli/plugins/list.md "List"; docs/plugins/building-plugins.md "Quickstart"; docs/plugins/dependency-resolution.md "Startup and reload"; docs/cli/plugins/inspect-and-diagnose.md "Registry"; docs/plugins/hooks/lifecycle.md "Gateway lifecycle", "Safe external cron projection"; docs/plugins/manage-plugins.md "Apply changes and inspect" | event | plugin-fixture-surfaces, mock-provider-held-turn |
| C159 plugin-registry-missing-or-stale-at-startup | docs/cli/plugins/inspect-and-diagnose.md "Registry"; docs/cli/plugins/list.md "List" | event | plugin-fixture-surfaces |
| C160 running-gateway-differs-from-cold-inventory | docs/tools/plugin.md "Verify the active Gateway"; docs/cli/plugins/list.md "List"; docs/plugins/manage-plugins.md "Apply changes and inspect"; docs/tools/plugin.md "Verify the active Gateway", "Plugin hooks"; docs/cli/plugins/uninstall-and-update.md "Reload"; docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)" | ambient | plugin-fixture-surfaces |
| C161 hoisted-dependencies-in-managed-project | docs/plugins/dependency-resolution.md "Hoisted transitive dependencies" | ambient | plugins-npm-tracked |
| C162 plugin-dock-conversation-exists | docs/plugins/feature-plugins.md "Host capabilities"; docs/plugins/feature-plugins.md "Dock a conversation" | ambient | plugin-fixture-feature-ui |
| C163 plugin-from-another-clawhub-registry | docs/plugins/manage-plugins.md "Use the Control UI" | ambient | none |
| C164 native-capture-directory-missing | docs/plugins/architecture.md "Runtime instance and source lifetime" | event | plugins-native-dependency |
| C165 native-dependency-shared-between-captures | docs/plugins/architecture.md "Runtime instance and source lifetime" | ambient | plugins-native-dependency |
| C166 plugin-inspection-disposal-fails | docs/cli/plugins/list.md "List"; docs/cli/plugins/inspect-and-diagnose.md "Doctor"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugins-broken-installs |
| C167 installed-inventory-beyond-twelve | docs/plugins/manage-plugins.md "Use the Control UI" | ambient | plugins-bundled-and-external |
| C168 hook-only-plugin-startup-intent | docs/tools/plugin.md "Plugin hooks"; docs/cli/plugins/list.md "List"; docs/plugins/architecture-internals/load-pipeline.md "Manifest-first behavior" | ambient | plugin-fixture-surfaces |
| C169 operator-hook-timeouts | docs/plugins/hooks/reference.md "Registration and execution" | ambient | plugin-fixture-surfaces |
| C170 install-policy-unavailable | docs/plugins/hooks/lifecycle.md "Install hooks" | ambient | none |
| C171 legacy-enabled-plugin-without-acceptance | docs/plugins/manage-plugins.md "Capability consent" | ambient | plugin-legacy-enabled-unreviewed |
| C172 host-peer-link-dangling | docs/plugins/dependency-resolution.md "Host peer dependency"; docs/plugins/architecture.md "Runtime instance and source lifetime"; docs/cli/plugins/inspect-and-diagnose.md "Registry"; docs/cli/plugins/install.md "Archives" | ambient | plugins-legacy-state |
| C173 control-ui-other-gateway | docs/plugins/feature-plugins.md "(intro)" | ambient | gateway-second-instance |
| C174 third-party-cookie-blocking | docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | none |
| C175 signed-feed-without-key | docs/cli/plugins/marketplace.md "Marketplace" | ambient | none |
| C176 remote-marketplace-entry-escapes | docs/cli/plugins/install.md "Remote marketplace rules" | ambient | none |
| C177 reinstall-preserves-disabled | docs/plugins/manage-plugins.md "Capability consent"; docs/cli/plugins/install.md "--force confirmation and reinstall vs update" | ambient (left by disable) | none |
| C178 uninstall-marker-retained | docs/plugins/manage-plugins.md "Uninstall plugins"; docs/cli/plugins/uninstall-and-update.md "Uninstall"; docs/plugins/manifest.md "Configuration validation" | ambient (left by uninstall) | none |
| C179 bundle-mcp-timeouts | docs/plugins/bundles.md "Transports" | ambient | none |
| C180 artifact-replaces-inference-plugin | docs/plugins/feature-plugins.md "Approve an agent-built artifact" | event | none |
| C181 node-worker-hook-admission | docs/plugins/hooks.md "Choose a hook" | ambient | none |
| C182 zip-name-collision | docs/cli/plugins/install.md "Sources and locators" | ambient | none |
| C183 official-entry-for-bundled-only-plugin | docs/plugins/plugin-inventory.md "Install a plugin", "Definitions" | ambient | plugins-bundled-and-external |
| C184 cli-invocation-plugin-resources | docs/plugins/architecture.md "Plugin metadata snapshot and lookup table"; docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins" | ambient | plugin-fixture-surfaces |
| C185 doctor-plugin-repairs | docs/tools/plugin.md "Configure plugin policy", "Troubleshooting"; docs/plugins/dependency-resolution.md "Startup and reload", "Legacy cleanup"; docs/cli/plugins/inspect-and-diagnose.md "Registry"; docs/cli/plugins/list.md "Plugin index"; docs/plugins/bundles.md "Runtime dependencies and cleanup" | event | plugins-legacy-state |
| C186 sdk-catalog-loader-default-call | added at step 6 from break 142557 (no listed document) | ambient | plugin-fixture-surfaces |
| C187 redaction-patterns-copied-from-defaults | added at step 6 from break 145553 (no listed document) | ambient | config-hand-edited |

## Headings walked
docs/tools/plugin.md "(intro)": none
docs/tools/plugin.md "Requirements": none
docs/tools/plugin.md "Quick start": C1, C2, C19, C40
docs/tools/plugin.md "Find the plugin": none
docs/tools/plugin.md "Install the plugin": none
docs/tools/plugin.md "Configure and enable it": none
docs/tools/plugin.md "Apply the changes": none
docs/tools/plugin.md "Verify runtime registration": none
docs/tools/plugin.md "Configuration": none
docs/tools/plugin.md "Choose an install source": C46
docs/tools/plugin.md "Operator install policy": C143
docs/tools/plugin.md "Configure plugin policy": C17, C18, C19, C20, C21, C22, C23, C24, C25, C26, C27, C28, C185
docs/tools/plugin.md "Understand plugin formats": C30
docs/tools/plugin.md "Plugin hooks": C1, C11, C158, C160, C168
docs/tools/plugin.md "Verify the active Gateway": C11, C160
docs/tools/plugin.md "Troubleshooting": C16, C23, C50, C51, C52, C60, C63, C156, C158, C185
docs/tools/plugin.md "Plugin runtime trust refused": C22, C41
docs/tools/plugin.md "Blocked plugin path ownership": C42, C112
docs/tools/plugin.md "Slow plugin tool setup": C72
docs/tools/plugin.md "Related": none
docs/plugins/manage-plugins.md "(intro)": none
docs/plugins/manage-plugins.md "Use the Control UI": C3, C4, C7, C8, C10, C16, C18, C19, C157, C163, C167
docs/plugins/manage-plugins.md "List and search plugins": C51
docs/plugins/manage-plugins.md "Enable and disable plugins": C25
docs/plugins/manage-plugins.md "Capability consent": C20, C28, C37, C38, C39, C40, C41, C171, C177
docs/plugins/manage-plugins.md "Install plugins": C34, C40, C52, C54, C55
docs/plugins/manage-plugins.md "Apply changes and inspect": C1, C2, C11, C12, C13, C158, C160
docs/plugins/manage-plugins.md "Manage plugins from an agent conversation": C10, C15
docs/plugins/manage-plugins.md "Update plugins": C34, C35, C49
docs/plugins/manage-plugins.md "Uninstall plugins": C16, C34, C116, C178
docs/plugins/manage-plugins.md "Choose a source": C29
docs/plugins/manage-plugins.md "Publish plugins": none
docs/plugins/manage-plugins.md "Related": none
docs/cli/plugins.md "(intro)": none
docs/cli/plugins.md "`openclaw plugins`": C2, C134
docs/cli/plugins.md "Commands": C16, C25, C115
docs/cli/plugins.md "Plugins pages": none
docs/cli/plugins.md "Where each section moved": none
docs/cli/plugins.md "Related": none
docs/cli/plugins/install.md "(intro)": none
docs/cli/plugins/install.md "Install": C2, C3, C10, C19, C22, C28, C37, C39, C40, C41, C45, C114, C116, C149
docs/cli/plugins/install.md "Sources and locators": C46, C47, C182
docs/cli/plugins/install.md "Config includes and invalid-config repair": C52, C53, C54
docs/cli/plugins/install.md "--force confirmation and reinstall vs update": C40, C50, C55, C56, C177
docs/cli/plugins/install.md "--pin scope": C49
docs/cli/plugins/install.md "--acknowledge-install-policy-warning": C143
docs/cli/plugins/install.md "ClawHub security audit": C43
docs/cli/plugins/install.md "Hook packs and npm specs": C33, C46
docs/cli/plugins/install.md "Git repositories": C55
docs/cli/plugins/install.md "Archives": C57, C142, C172
docs/cli/plugins/install.md "Marketplace shorthand": C99
docs/cli/plugins/install.md "Marketplace sources": C99
docs/cli/plugins/install.md "Remote marketplace rules": C99, C176
docs/cli/plugins/install.md "Local paths and bundle formats": C27, C28, C29, C30
docs/cli/plugins/install.md "Enable installed plugins": C2, C17, C18, C19
docs/cli/plugins/list.md "(intro)": none
docs/cli/plugins/list.md "List": C1, C11, C12, C21, C22, C51, C74, C112, C158, C159, C160, C166, C168
docs/cli/plugins/list.md "Plugin index": C57, C58, C185
docs/cli/plugins/inspect-and-diagnose.md "(intro)": none
docs/cli/plugins/inspect-and-diagnose.md "Inspect": C2, C27, C34, C35, C51, C61, C148
docs/cli/plugins/inspect-and-diagnose.md "Doctor": C23, C42, C60, C115, C142, C166
docs/cli/plugins/inspect-and-diagnose.md "Registry": C56, C57, C59, C158, C159, C172, C185
docs/cli/plugins/uninstall-and-update.md "(intro)": C2, C14
docs/cli/plugins/uninstall-and-update.md "Uninstall": C20, C24, C34, C35, C36, C40, C127, C128, C134, C178
docs/cli/plugins/uninstall-and-update.md "Update": C36, C57, C113, C129, C130, C133
docs/cli/plugins/uninstall-and-update.md "Resolving plugin id vs npm spec": C34, C49, C131
docs/cli/plugins/uninstall-and-update.md "Beta channel updates": C45, C133
docs/cli/plugins/uninstall-and-update.md "Existing plugin source choices": C49, C132
docs/cli/plugins/uninstall-and-update.md "Version checks and integrity drift": C47, C48, C49
docs/cli/plugins/uninstall-and-update.md "--acknowledge-install-policy-warning on update": C143
docs/cli/plugins/uninstall-and-update.md "ClawHub Security Audit on update": C43
docs/cli/plugins/uninstall-and-update.md "Reload": C3, C4, C5, C6, C7, C8, C9, C11, C13, C15, C16, C38, C40, C160
docs/cli/plugins/marketplace.md "(intro)": none
docs/cli/plugins/marketplace.md "Marketplace": C98, C175
docs/cli/plugins/authoring.md "(intro)": none
docs/cli/plugins/authoring.md "Author": C102
docs/cli/plugins/authoring.md "Feature scaffold and artifacts": C86, C103
docs/cli/plugins/authoring.md "Provider scaffold": none
docs/plugins/install-overrides.md "(intro)": none
docs/plugins/install-overrides.md "Environment": C114
docs/plugins/install-overrides.md "Behavior": C114
docs/plugins/install-overrides.md "Package E2E": none
docs/plugins/dependency-resolution.md "(intro)": C51
docs/plugins/dependency-resolution.md "Responsibility split": C51
docs/plugins/dependency-resolution.md "Install roots": C56, C57
docs/plugins/dependency-resolution.md "npm-pack tarball installs": none
docs/plugins/dependency-resolution.md "Missing runtime imports": C51
docs/plugins/dependency-resolution.md "Hoisted transitive dependencies": C161
docs/plugins/dependency-resolution.md "Lockfile policy": none
docs/plugins/dependency-resolution.md "Verify a package tarball": none
docs/plugins/dependency-resolution.md "Bundled runtime dependencies": none
docs/plugins/dependency-resolution.md "Host peer dependency": C57, C172
docs/plugins/dependency-resolution.md "git installs": none
docs/plugins/dependency-resolution.md "Local plugins": C28, C51
docs/plugins/dependency-resolution.md "Startup and reload": C51, C57, C153, C158, C185
docs/plugins/dependency-resolution.md "Bundled plugins": C113
docs/plugins/dependency-resolution.md "Native imports from a standalone source build": none
docs/plugins/dependency-resolution.md "Legacy cleanup": C57, C185
docs/plugins/bundles.md "(intro)": none
docs/plugins/bundles.md "Why bundles exist": none
docs/plugins/bundles.md "Install a bundle": C2, C30
docs/plugins/bundles.md "Install from a directory, archive, or marketplace": none
docs/plugins/bundles.md "Verify detection": none
docs/plugins/bundles.md "Use the bundle": none
docs/plugins/bundles.md "What OpenClaw maps from bundles": none
docs/plugins/bundles.md "Supported now": C30
docs/plugins/bundles.md "Skill content": C30
docs/plugins/bundles.md "Hook packs": C30
docs/plugins/bundles.md "Embedded OpenClaw settings": C30
docs/plugins/bundles.md "Embedded OpenClaw LSP": C30, C32
docs/plugins/bundles.md "Detected but not executed": C30
docs/plugins/bundles.md "MCP for embedded OpenClaw": C30, C31, C140
docs/plugins/bundles.md "Transports": C31, C179
docs/plugins/bundles.md "Tool naming": C30, C31
docs/plugins/bundles.md "Bundle formats": C30
docs/plugins/bundles.md "Agent Plugins bundles": C30
docs/plugins/bundles.md "Codex bundles": none
docs/plugins/bundles.md "Claude bundles": C30
docs/plugins/bundles.md "Cursor bundles": C30
docs/plugins/bundles.md "Detection precedence": C30
docs/plugins/bundles.md "Runtime dependencies and cleanup": C153, C185
docs/plugins/bundles.md "Security": C30
docs/plugins/bundles.md "Troubleshooting": none
docs/plugins/bundles.md "Bundle is detected but capabilities do not run": none
docs/plugins/bundles.md "Claude command, agent, or output-style files do not appear": none
docs/plugins/bundles.md "Claude settings do not apply": none
docs/plugins/bundles.md "Claude hooks do not execute": none
docs/plugins/bundles.md "Related": none
docs/plugins/community.md "(intro)": none
docs/plugins/community.md "Find plugins": none
docs/plugins/community.md "Publish plugins": C43
docs/plugins/community.md "Related": none
docs/plugins/compatibility.md "(intro)": C62
docs/plugins/compatibility.md "Compatibility registry": none
docs/plugins/compatibility.md "Deprecation policy": C62
docs/plugins/compatibility.md "Current compatibility areas": C62
docs/plugins/compatibility.md "Session-store bridge retirement": C61
docs/plugins/compatibility.md "Synchronous plugin state": C62
docs/plugins/compatibility.md "Session agent resolution aliases": none
docs/plugins/compatibility.md "Auth profile cooldown classifications": none
docs/plugins/compatibility.md "Channel prompt-context identifier aliases": none
docs/plugins/compatibility.md "WhatsApp inbound callback retirement": none
docs/plugins/compatibility.md "Plugin inspector package": none
docs/plugins/compatibility.md "Maintainer acceptance lane": none
docs/plugins/compatibility.md "Release notes": none
docs/plugins/compatibility.md "Related": none
docs/plugins/plugin-inventory.md "(intro)": none
docs/plugins/plugin-inventory.md "Definitions": C25, C113, C183
docs/plugins/plugin-inventory.md "Install a plugin": C2, C25, C183
docs/plugins/plugin-inventory.md "Core npm package": none
docs/plugins/plugin-inventory.md "Official external packages": none
docs/plugins/plugin-inventory.md "Source checkout only": none
docs/plugins/plugin-inventory.md "How this page is built": none
docs/plugins/plugin-permission-requests.md "(intro)": none
docs/plugins/plugin-permission-requests.md "Choose the right gate": C121
docs/plugins/plugin-permission-requests.md "Request approval before a tool call": C79, C80
docs/plugins/plugin-permission-requests.md "Declare approval scope": C79
docs/plugins/plugin-permission-requests.md "Decision behavior": C79, C80, C81, C82
docs/plugins/plugin-permission-requests.md "Route approval prompts": C83, C84
docs/plugins/plugin-permission-requests.md "Codex native permissions": C85
docs/plugins/plugin-permission-requests.md "Troubleshooting": C82
docs/plugins/plugin-permission-requests.md "Related": none
docs/plugins/architecture.md "(intro)": none
docs/plugins/architecture.md "Public capability model": none
docs/plugins/architecture.md "External compatibility stance": none
docs/plugins/architecture.md "Plugin shapes": none
docs/plugins/architecture.md "plain-capability": none
docs/plugins/architecture.md "hybrid-capability": none
docs/plugins/architecture.md "hook-only": none
docs/plugins/architecture.md "non-capability": none
docs/plugins/architecture.md "Compatibility signals": C62, C156
docs/plugins/architecture.md "Architecture overview": C69, C150, C156
docs/plugins/architecture.md "Manifest + discovery": none
docs/plugins/architecture.md "Enablement + validation": none
docs/plugins/architecture.md "Runtime loading": none
docs/plugins/architecture.md "Surface consumption": none
docs/plugins/architecture.md "Plugin metadata snapshot and lookup table": C3, C4, C5, C6, C7, C8, C9, C13, C15, C24, C26, C31, C61, C64, C68, C70, C155, C156, C158, C184
docs/plugins/architecture.md "Runtime instance and source lifetime": C11, C15, C28, C64, C65, C66, C67, C69, C111, C154, C160, C164, C165, C172
docs/plugins/architecture.md "Activation planning": none
docs/plugins/architecture.md "Channel plugins and the shared message tool": none
docs/plugins/architecture.md "Capability ownership model": none
docs/plugins/architecture.md "Vendor multi-capability": none
docs/plugins/architecture.md "Vendor single-capability": none
docs/plugins/architecture.md "Feature plugin": none
docs/plugins/architecture.md "Define the capability": none
docs/plugins/architecture.md "Expose through the SDK": none
docs/plugins/architecture.md "Wire consumers": none
docs/plugins/architecture.md "Vendor implementations": none
docs/plugins/architecture.md "Capability layering": none
docs/plugins/architecture.md "Core capability layer": none
docs/plugins/architecture.md "Vendor plugin layer": none
docs/plugins/architecture.md "Channel/feature plugin layer": none
docs/plugins/architecture.md "Multi-capability company plugin example": none
docs/plugins/architecture.md "Capability example: video understanding": none
docs/plugins/architecture.md "Core defines the contract": none
docs/plugins/architecture.md "Vendor plugins register": none
docs/plugins/architecture.md "Consumers use the shared behavior": none
docs/plugins/architecture.md "Contracts and enforcement": C63
docs/plugins/architecture.md "Runtime registration enforcement": none
docs/plugins/architecture.md "Contract tests": none
docs/plugins/architecture.md "What belongs in a contract": none
docs/plugins/architecture.md "Good contracts": none
docs/plugins/architecture.md "Bad contracts": none
docs/plugins/architecture.md "Skill previews": C91, C123
docs/plugins/architecture.md "Execution model": C22, C27, C28, C63, C113, C145
docs/plugins/architecture.md "Export boundary": none
docs/plugins/architecture.md "Internals and reference": none
docs/plugins/architecture.md "Related": none
docs/plugins/architecture-internals/load-pipeline.md "(intro)": none
docs/plugins/architecture-internals/load-pipeline.md "Load pipeline": C42, C158
docs/plugins/architecture-internals/load-pipeline.md "Manifest-first behavior": C26, C63, C158, C168
docs/plugins/architecture-internals/load-pipeline.md "Plugin cache boundary": C12, C37, C63, C68, C69, C145, C155
docs/plugins/architecture-internals/load-pipeline.md "Registry model": none
docs/plugins/architecture-internals/packaging.md "(intro)": none
docs/plugins/architecture-internals/packaging.md "Plugin SDK import paths": C15, C61
docs/plugins/architecture-internals/packaging.md "Package packs": C34, C42, C119, C120
docs/plugins/architecture-internals/packaging.md "Channel catalog metadata": C118, C131
docs/plugins/manifest.md "(intro)": C142
docs/plugins/manifest.md "What this file does": none
docs/plugins/manifest.md "Use it for:": none
docs/plugins/manifest.md "Where each field is documented": none
docs/plugins/manifest.md "Model fields": none
docs/plugins/manifest.md "Provider fields": none
docs/plugins/manifest.md "Setup and auth fields": none
docs/plugins/manifest.md "Capability fields": none
docs/plugins/manifest.md "Host surface fields": none
docs/plugins/manifest.md "Config and secret fields": none
docs/plugins/manifest.md "Manifest and package.json fields": none
docs/plugins/manifest.md "Minimal example": none
docs/plugins/manifest.md "Rich example": none
docs/plugins/manifest.md "Top-level field reference": C25, C26, C34, C138, C139, C140
docs/plugins/manifest.md "Catalog categories": C147
docs/plugins/manifest.md "JSON Schema requirements": C52, C142
docs/plugins/manifest.md "Retained state checks": C133
docs/plugins/manifest.md "Validation behavior": none
docs/plugins/manifest.md "Capability catalogs": C141, C142
docs/plugins/manifest.md "Configuration validation": C20, C23, C24, C134, C142, C178
docs/plugins/manifest.md "Notes": C24, C62
docs/plugins/manifest.md "Related": none
docs/plugins/hooks.md "(intro)": C62, C63
docs/plugins/hooks.md "Quick start": C1
docs/plugins/hooks.md "Permissions and scope": C1, C74, C75, C144
docs/plugins/hooks.md "Choose a hook": C76, C181
docs/plugins/hooks.md "Troubleshooting": C73, C77
docs/plugins/hooks.md "Upcoming deprecations": C62
docs/plugins/hooks.md "Where each section moved": none
docs/plugins/hooks.md "Hook reference": none
docs/plugins/hooks.md "Tool call policy hooks": none
docs/plugins/hooks.md "Prompt and session hooks": none
docs/plugins/hooks.md "Message and delivery hooks": none
docs/plugins/hooks.md "Gateway and install lifecycle hooks": none
docs/plugins/hooks.md "Related": none
docs/plugins/hooks/lifecycle.md "(intro)": none
docs/plugins/hooks/lifecycle.md "Install hooks": C73, C143, C170
docs/plugins/hooks/lifecycle.md "Gateway lifecycle": C71, C158
docs/plugins/hooks/lifecycle.md "Safe external cron projection": C71, C158
docs/plugins/hooks/reference.md "(intro)": none
docs/plugins/hooks/reference.md "Registration and execution": C73, C77, C78, C136, C169
docs/plugins/hooks/reference.md "Hook catalog": C1, C15, C74, C75, C137, C158
docs/plugins/hooks/reference.md "Agent turn": none
docs/plugins/hooks/reference.md "Conversation observation": none
docs/plugins/hooks/reference.md "Tools": none
docs/plugins/hooks/reference.md "Messages and delivery": none
docs/plugins/hooks/reference.md "Sessions and compaction": none
docs/plugins/hooks/reference.md "Subagents": none
docs/plugins/hooks/reference.md "Lifecycle": none
docs/plugins/hooks/reference.md "Skill lifecycle": none
docs/plugins/hooks/reference.md "Channel pairing requests": C135
docs/plugins/sdk-overview.md "(intro)": none
docs/plugins/sdk-overview.md "API stability": C86
docs/plugins/sdk-overview.md "What each page covers": none
docs/plugins/sdk-overview.md "Registration API": none
docs/plugins/sdk-overview.md "Session discussion provider": C146
docs/plugins/sdk-overview.md "API object fields": none
docs/plugins/sdk-overview.md "Where each section moved": none
docs/plugins/sdk-overview.md "Docked link readers": none
docs/plugins/sdk-overview.md "Related": none
docs/plugins/sdk-overview/host-hooks.md "(intro)": none
docs/plugins/sdk-overview/host-hooks.md "Host hooks for workflow plugins": C62, C74, C87, C91, C93, C94, C120, C124, C125, C126, C144, C156, C166, C174, C184
docs/plugins/sdk-overview/host-hooks.md "When to use tool-result middleware": C126
docs/plugins/sdk-overview/host-hooks.md "Sandbox backends": none
docs/plugins/sdk-overview/host-hooks.md "Docked link readers": C91, C93, C123
docs/plugins/sdk-entrypoints.md "(intro)": none
docs/plugins/sdk-entrypoints.md "Where each section moved": none
docs/plugins/sdk-entrypoints.md "Plugin shapes": none
docs/plugins/sdk-entrypoints.md "Related": none
docs/plugins/sdk-entrypoints.md "Code Mode executor runtime": C117
docs/plugins/sdk-entrypoints.md "Native MCP App adapters": none
docs/plugins/sdk-entrypoints.md "MCP subprocess runtime": none
docs/plugins/sdk-entrypoints.md "Workspace access": none
docs/plugins/sdk-entrypoints.md "Agent workspace context": none
docs/plugins/sdk-entrypoints.md "Tool failure diagnostics": none
docs/plugins/sdk-entrypoints.md "ACP harness turns": none
docs/plugins/building-plugins.md "(intro)": none
docs/plugins/building-plugins.md "Requirements": none
docs/plugins/building-plugins.md "Choose the plugin shape": none
docs/plugins/building-plugins.md "Quickstart": C126, C158
docs/plugins/building-plugins.md "Create package metadata": none
docs/plugins/building-plugins.md "Register the tool": none
docs/plugins/building-plugins.md "Test the runtime": none
docs/plugins/building-plugins.md "Test the package install": none
docs/plugins/building-plugins.md "Publish": none
docs/plugins/building-plugins.md "Install": none
docs/plugins/building-plugins.md "Add plugin artwork": none
docs/plugins/building-plugins.md "Registering tools": C63, C121, C151
docs/plugins/building-plugins.md "Import conventions": C120
docs/plugins/building-plugins.md "Pre-submission checklist": none
docs/plugins/building-plugins.md "Test against beta releases": none
docs/plugins/building-plugins.md "Next steps": none
docs/plugins/building-plugins.md "Related": none
docs/plugins/tool-plugins.md "(intro)": none
docs/plugins/tool-plugins.md "Requirements": none
docs/plugins/tool-plugins.md "Quickstart": C103
docs/plugins/tool-plugins.md "Write a tool": none
docs/plugins/tool-plugins.md "Optional and constructor-built tools (the heading at line 122)": C11, C15, C121, C151, C152, C160
docs/plugins/tool-plugins.md "Owner-authorized continuations": C15
docs/plugins/tool-plugins.md "Return values": none
docs/plugins/tool-plugins.md "Output contracts": C122
docs/plugins/tool-plugins.md "Deliver the reply directly": none
docs/plugins/tool-plugins.md "Configuration": none
docs/plugins/tool-plugins.md "Generated metadata": C102
docs/plugins/tool-plugins.md "Package metadata": none
docs/plugins/tool-plugins.md "Validate in CI": C102
docs/plugins/tool-plugins.md "Install and inspect locally": C2
docs/plugins/tool-plugins.md "Publish": none
docs/plugins/tool-plugins.md "Troubleshooting": C102
docs/plugins/tool-plugins.md "`plugin entry not found: ./dist/index.js`": C102
docs/plugins/tool-plugins.md "`plugin entry does not expose defineToolPlugin metadata`": C102
docs/plugins/tool-plugins.md "`openclaw.plugin.json generated metadata is stale`": C102
docs/plugins/tool-plugins.md "`package.json openclaw.extensions must include ./dist/index.js`": C102
docs/plugins/tool-plugins.md "`Cannot find package 'typebox'`": C51
docs/plugins/tool-plugins.md "Tool does not appear after install": C10
docs/plugins/tool-plugins.md "See also": none
docs/plugins/feature-plugins.md "(intro)": C87, C173
docs/plugins/feature-plugins.md "Enable custom plugin UI": C86
docs/plugins/feature-plugins.md "Create a feature plugin": C88
docs/plugins/feature-plugins.md "Define operations once": C91, C123
docs/plugins/feature-plugins.md "Contribute and replace views": C92, C93
docs/plugins/feature-plugins.md "Host capabilities": C162
docs/plugins/feature-plugins.md "Dock a conversation": C92, C162
docs/plugins/feature-plugins.md "Build and reload": C89, C90, C91, C123
docs/plugins/feature-plugins.md "Approve an agent-built artifact": C2, C53, C95, C96, C97, C180
docs/plugins/codex-native-plugins.md "(intro)": none
docs/plugins/codex-native-plugins.md "Requirements": C104
docs/plugins/codex-native-plugins.md "Quickstart": C105, C110
docs/plugins/codex-native-plugins.md "Scheduled automations": C106
docs/plugins/codex-native-plugins.md "Manage plugins from chat": C104, C105
docs/plugins/codex-native-plugins.md "How native plugin setup works": C104
docs/plugins/codex-native-plugins.md "Support boundary": C104
docs/plugins/codex-native-plugins.md "App inventory and ownership": C107
docs/plugins/codex-native-plugins.md "Connected account apps": C107, C108, C110
docs/plugins/codex-native-plugins.md "Thread app config": C107
docs/plugins/codex-native-plugins.md "Approval decision order": none
docs/plugins/codex-native-plugins.md "Which configuration owns each setting": none
docs/plugins/codex-native-plugins.md "Native tool enablement": none
docs/plugins/codex-native-plugins.md "Native approval mode": C109
docs/plugins/codex-native-plugins.md "Destructive action policy": C109
docs/plugins/codex-native-plugins.md "Approval examples": C109
docs/plugins/codex-native-plugins.md "Troubleshooting": C107, C110
docs/plugins/codex-native-plugins.md "Related": none
docs/gateway/protocol/rpc-system-and-channels.md "(intro)": none
docs/gateway/protocol/rpc-system-and-channels.md "System and identity": none
docs/gateway/protocol/rpc-system-and-channels.md "Models and usage": none
docs/gateway/protocol/rpc-system-and-channels.md "Memory": none
docs/gateway/protocol/rpc-system-and-channels.md "Channels and login helpers": none
docs/gateway/protocol/rpc-system-and-channels.md "Channel DM pairing": none
docs/gateway/protocol/rpc-system-and-channels.md "Plugin management": C16, C37, C44, C143, C149, C157
docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation": C7, C8, C10, C14, C16, C35, C37, C44, C53, C111
docs/gateway/protocol/rpc-system-and-channels.md "ClawHub catalog discovery": C101
docs/gateway/protocol/rpc-system-and-channels.md "Browse and search": C44
docs/gateway/protocol/rpc-system-and-channels.md "Bulk keyword discovery": C44, C100
docs/gateway/protocol/rpc-system-and-channels.md "Upstream contracts and gaps": none
docs/gateway/protocol/rpc-system-and-channels.md "Messaging and logs": none
docs/gateway/protocol/rpc-system-and-channels.md "Operator terminal": none

## Breaks cross-check
| Break | Phase | Note |
| --- | --- | --- |
| 159650 prevent WhatsApp Doctor failures after updates | event-native-capture-directory-missing | condition native-capture-directory-missing added at step 6 (cited: architecture "Runtime instance and source lifetime"); Doctor, reload and restart after a native plugin's recorded capture directory is removed; persona addition plugins-native-dependency |
| 141836 support Flux voice-note transcription | none | Deepgram transcription is the plugin's own feature (bound: owned by its feature area) and needs the real Deepgram service; lifecycle phases are selected by the extensions path but do not transcribe audio |
| 127469 respect provenance in automatic context | none | memory plugin feature (bound: memory plugins owned by their feature area); needs a legacy memory index and slow embeddings |
| 126391 prevent malformed streamed tool calls | none | provider stream parsing owned by models (bound); needs a real provider's streamed tool-call output |
| 160181 release plugin resources when help finishes | inspect-plugin | condition plugin-inspection-disposal-fails added at step 6; runtime inspection of a plugin whose dispose throws, plus root --help in run-plugin-cli-command |
| 159536 native plugins lose companion libraries during capture | reload-plugin | condition native-dependency-shared-between-captures added at step 6; reload and Doctor of native plugins that share a dependency file (diagnose-plugins also records Doctor) |
| 148901 updates fail when configured agents have no legacy history | event-gateway-restart-reloads-plugins | plugins-legacy-state includes an unused configured agent with an empty legacy sessions.json, a pending deferred plugin session migration and no database; restart and Doctor (event-doctor-repairs-legacy-plugin-state) record the startup refusal |
| 146713 rebuild outdated provenance on search | none | memory plugin feature (bound); needs an index written by a newer version |
| 144420 share API-key editing and removal | none | provider auth owned by models (bound); needs two clients editing one key |
| 143837 compose prepared catalog sources before lookup | start-gateway-with-plugins | persona addition config-provider-without-models: a bundled provider with credentials and settings but no models array, auto-enabled at startup (condition bundled-plugin-auto-activated-by-config); event-gateway-restart-reloads-plugins also records it |
| 142557 harden SDK catalog loads with passive defaults | plugin-registrations-recorded | the fixture plugin's sdkProbeMethod calls the public SDK catalog loader without options; its response records discovered models |
| 164989 read model context and watermarks through the history reader | none | needs a remote OpenClaw worker placement (cloud workers, outside the bound) |
| 150291 prepare three bundled plugins for catalog publication | list-installed-plugins | plugins.list curated official picks and install routes for bundled-only plugins; browse-plugin-catalog also records catalog entries |
| 163850 deslop Feishu, WhatsApp, and Teams | none | the Teams plugin's Doctor recovery guidance is Doctor repair (bound: owned by update) and needs retired Teams state |
| 157135 preserve steering across reconnects and show queued input | none | the in-area path is a Workboard manifest; the symptom is chat scrolling, owned by sessions |
| 145553 preserve public status URLs during credential redaction | none | not mapped: the break is masking of encoded form values and Digest authorization under copied redaction patterns, owned by logging; the in-area path is an SDK re-export, and the hook turn that sends a public status URL does not exercise that masking |
| 166049 open public threads at their regular links | none | chat link routing owned by sessions and the Control UI; the in-area paths are the X plugin's feature code |
| 137131 hydrate published models from models.dev | none | outside the product's reach: needs an upstream models.dev document larger than the publisher's cap (external data) |

## Undocumented conditions
sdk-catalog-loader-default-call: needed by 142557, stated in no document (an installed plugin calling the public SDK model-catalog loader without options; no listed document states how discovery behaves for that call); from run 2
redaction-patterns-copied-from-defaults: needed by 145553, stated in no document (logging.redactPatterns copied from the shipped defaults while plugin SDK output and before_prompt_build see user text); from run 2

## Reconciliation
Runs: run 1 and run 2 are two independent runs of steps 1 to 7 on this input file and revision; run 1 is the base of every merged phase. Comparison numbers are in comparison.md.
Operations: run 1's grouping is kept (finer: listing and inspecting, refreshing the registry and diagnosing, pages and customizing are separate operations with their own entry-point families); "Review and accept a plugin's capabilities" is taken from run 2 as a finer operation with its own family (the capability consent dialog); run 2's "Manage plugins from chat or an agent conversation" groups by surface, so its entry points and commands are placed under the operation each one performs.
C167 installed-inventory-beyond-twelve: from run 2 only; a state or event its document heading states with its own consequence
C168 hook-only-plugin-startup-intent: from run 2 only; a state or event its document heading states with its own consequence
C169 operator-hook-timeouts: from run 2 only; a state or event its document heading states with its own consequence
C170 install-policy-unavailable: from run 2 only; a state or event its document heading states with its own consequence
C171 legacy-enabled-plugin-without-acceptance: from run 2 only; a state or event its document heading states with its own consequence
C172 host-peer-link-dangling: from run 2 only; a state or event its document heading states with its own consequence
C173 control-ui-other-gateway: from run 2 only; a state or event its document heading states with its own consequence
C174 third-party-cookie-blocking: from run 2 only; a state or event its document heading states with its own consequence
C175 signed-feed-without-key: from run 2 only; a state or event its document heading states with its own consequence
C176 remote-marketplace-entry-escapes: from run 2 only; a state or event its document heading states with its own consequence
C177 reinstall-preserves-disabled: from run 2 only; a state or event its document heading states with its own consequence
C178 uninstall-marker-retained: from run 2 only; a state or event its document heading states with its own consequence
C179 bundle-mcp-timeouts: from run 2 only; a state or event its document heading states with its own consequence
C180 artifact-replaces-inference-plugin: from run 2 only; a state or event its document heading states with its own consequence
C181 node-worker-hook-admission: from run 2 only; a state or event its document heading states with its own consequence
C182 zip-name-collision: from run 2 only; a state or event its document heading states with its own consequence
C183 official-entry-for-bundled-only-plugin: from run 2 only; a state or event its document heading states with its own consequence
C184 cli-invocation-plugin-resources: from run 2 only; a state or event its document heading states with its own consequence
C185 doctor-plugin-repairs: from run 2 only; a state or event its document heading states with its own consequence
C186 sdk-catalog-loader-default-call: from run 2 only; a state or event its document heading states with its own consequence
C187 redaction-patterns-copied-from-defaults: from run 2 only; a state or event its document heading states with its own consequence
C5 reload-wait-cancelled-before-publication: from run 1 only; a state or event its document heading states with its own consequence
C9 recovery-cannot-complete-ready-state-reports-plugin-reload: from run 1 only; a state or event its document heading states with its own consequence
C28 load-path-or-linked-local-plugin: from run 1 only; a state or event its document heading states with its own consequence
C31 bundle-mcp-tools-in-agent-turn: from run 1 only; a state or event its document heading states with its own consequence
C32 turn-cancel-during-bundle-lsp-startup: from run 1 only; a state or event its document heading states with its own consequence
C33 hook-pack-installed: from run 1 only; a state or event its document heading states with its own consequence
C36 orphan-install-record: from run 1 only; a state or event its document heading states with its own consequence
C38 update-declares-new-capabilities: from run 1 only; a state or event its document heading states with its own consequence
C41 trust-gated-capability-refused-for-local-copy: from run 1 only; a state or event its document heading states with its own consequence
C48 installed-plugin-already-at-target-version: from run 1 only; a state or event its document heading states with its own consequence
C52 host-config-or-plugin-config-invalid: from run 1 only; a state or event its document heading states with its own consequence
C56 superseded-plugin-generation-retired: from run 1 only; a state or event its document heading states with its own consequence
C59 persisted-registry-differs-from-derived: from run 1 only; a state or event its document heading states with its own consequence
C76 hooks-not-emitted-by-native-harness: from run 1 only; a state or event its document heading states with its own consequence
C77 several-plugins-handle-one-hook: from run 1 only; a state or event its document heading states with its own consequence
C78 hook-limited-to-eligible-triggers: from run 1 only; a state or event its document heading states with its own consequence
C84 slack-plugin-approval-reviewer-lists: from run 1 only; a state or event its document heading states with its own consequence
C90 plugin-ui-activation-fails: from run 1 only; a state or event its document heading states with its own consequence
C92 plugin-view-session-identity-changes: from run 1 only; a state or event its document heading states with its own consequence
C94 plugin-tab-slug-reserved-or-colliding: from run 1 only; a state or event its document heading states with its own consequence
C96 artifact-activation-refused: from run 1 only; a state or event its document heading states with its own consequence
C97 no-connected-browser-no-activation-receipt: from run 1 only; a state or event its document heading states with its own consequence
C100 keyword-results-change-during-paging: from run 1 only; a state or event its document heading states with its own consequence
C101 client-on-gateway-without-catalog-methods: from run 1 only; a state or event its document heading states with its own consequence
C102 generated-plugin-metadata-stale: from run 1 only; a state or event its document heading states with its own consequence
C103 scaffold-or-pack-target-exists: from run 1 only; a state or event its document heading states with its own consequence
C108 codex-account-apps-admitted-by-allow-all-plugins: from run 1 only; a state or event its document heading states with its own consequence
C115 lifecycle-timing-or-load-debug-environment: from run 1 only; a state or event its document heading states with its own consequence
C122 tool-result-mismatches-output-schema: from run 1 only; a state or event its document heading states with its own consequence
C124 plugin-runtime-cleanup-on-session-reset-or-delete: from run 1 only; a state or event its document heading states with its own consequence
C125 invalid-board-widget-content-kind: from run 1 only; a state or event its document heading states with its own consequence
C128 uninstall-drain-or-file-removal-fails: from run 1 only; a state or event its document heading states with its own consequence
C130 update-finalization-fails-and-rolls-back: from run 1 only; a state or event its document heading states with its own consequence
C131 official-plugin-renamed-or-id-replaced: from run 1 only; a state or event its document heading states with its own consequence
C132 clawhub-and-npm-release-lag: from run 1 only; a state or event its document heading states with its own consequence
C134 mixed-case-plugin-id: from run 1 only; a state or event its document heading states with its own consequence
C135 channel-pairing-request-observed-by-plugin: from run 1 only; a state or event its document heading states with its own consequence
C136 inbound-claim-fails-for-bound-conversation: from run 1 only; a state or event its document heading states with its own consequence
C137 failed-compaction-emits-no-after-compaction: from run 1 only; a state or event its document heading states with its own consequence
C139 legacy-plugin-id-in-config: from run 1 only; a state or event its document heading states with its own consequence
C140 plugin-mcp-server-overridden-by-operator: from run 1 only; a state or event its document heading states with its own consequence
C141 broken-capability-catalog-entry: from run 1 only; a state or event its document heading states with its own consequence
C144 prompt-injection-disallowed-for-plugin: from run 1 only; a state or event its document heading states with its own consequence
C145 same-plugin-id-from-several-sources: from run 1 only; a state or event its document heading states with its own consequence
C146 second-session-discussion-provider-registered: from run 1 only; a state or event its document heading states with its own consequence
C148 workspace-discovery-without-system-owner: from run 1 only; a state or event its document heading states with its own consequence
C150 plugin-cli-registered-lazily-on-first-invocation: from run 1 only; a state or event its document heading states with its own consequence
C153 config-references-missing-downloadable-plugin: from run 1 only; a state or event its document heading states with its own consequence
C154 file-symlinks-unavailable: from run 1 only; a state or event its document heading states with its own consequence
C155 metadata-snapshot-reused-after-startup: from run 1 only; a state or event its document heading states with its own consequence
C161 hoisted-dependencies-in-managed-project: from run 1 only; a state or event its document heading states with its own consequence
C162 plugin-dock-conversation-exists: from run 1 only; a state or event its document heading states with its own consequence
C163 plugin-from-another-clawhub-registry: from run 1 only; a state or event its document heading states with its own consequence
C166 plugin-inspection-disposal-fails: from run 1 only; a state or event its document heading states with its own consequence
UI Plugins hub "All" chip: entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI Plugins hub section "View all": entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI catalog detail publisher profile link (clawhub.ai): entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI catalog detail README code-block copy: entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI plugin settings page back link: entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI plugin Permissions "Conversation access": entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI plugin Permissions "Prompt context access": entry point from run 2 only; kept, placed or excluded as run 2 listed it
host.ui.registerNavigation: entry point from run 2 only; kept, placed or excluded as run 2 listed it
host.ui.registerReplacement: entry point from run 2 only; kept, placed or excluded as run 2 listed it
/plugin (singular): entry point from run 2 only; kept, placed or excluded as run 2 listed it
tools.catalog: entry point from run 2 only; kept, placed or excluded as run 2 listed it
mcp.authLogin: entry point from run 2 only; kept, placed or excluded as run 2 listed it
config.get, config.schema, config.set, config.patch: entry point from run 2 only; kept, placed or excluded as run 2 listed it
openclaw-plugin-inspector: entry point from run 2 only; kept, placed or excluded as run 2 listed it
api.on: entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI Logbook plugin page controls (ui/src/pages/plugin/logbook-view.ts): entry point from run 2 only; kept, placed or excluded as run 2 listed it
UI settings navigation, sidebar, theme and account controls around the plugin pages: entry point from run 2 only; kept, placed or excluded as run 2 listed it
src/gateway/methods/core-descriptors.ts: run 1 excluded it as an internal method table, run 2 placed it as a from-gateway file found by the search list; placed, since a file the search finds is an entry point
apps/android/app/src/main/java/ai/openclaw/app/AndroidScreenshotFixture.kt: run 2 placed it, run 1 excluded it as test-only; kept excluded as a correction, since it is a screenshot test fixture
phase review-capability-consent: from run 2 only; covers an operation or event condition no run 1 phase performs
phase reinstall-disabled-plugin: from run 2 only; covers an operation or event condition no run 1 phase performs
phase event-install-activation-fails: from run 2 only; covers an operation or event condition no run 1 phase performs
phase event-plugin-approval-no-route: from run 2 only; covers an operation or event condition no run 1 phase performs
phase event-config-externally-managed: from run 2 only; covers an operation or event condition no run 1 phase performs
phase setup-plugin-tool-turn-in-flight: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase start-gateway-with-plugins: 3 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase browse-plugin-catalog: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase list-installed-plugins: 5 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase install-plugin-from-cli-sources: 5 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase install-plugin-in-control-ui: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase enable-and-disable-plugin: 5 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase configure-plugin-settings-in-control-ui: 4 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase connect-plugin-account-in-control-ui: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase set-plugin-loading-policy-in-control-ui: 7 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase run-plugin-cli-command: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase inspect-plugin: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase install-plugin-from-chat-and-agent: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase plugin-hooks-shape-agent-turns: 6 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase approve-plugin-permission: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase plugin-hooks-follow-sessions-and-subagents: 6 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase plugin-hooks-follow-lifecycle: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase plugin-registrations-recorded: 5 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase use-plugin-tools-in-turns: 3 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase run-plugin-session-action: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase use-plugin-pages-and-widgets: 8 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase author-tool-plugin: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase activate-agent-built-artifact: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase diagnose-plugins: 4 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase manage-native-codex-plugins: 3 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase reload-plugin: 7 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase update-plugin: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase uninstall-plugin: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-plugin-config-edit-hot-replaces-instance: 4 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-bundled-code-edited-while-loaded: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-reload-drain-budget-exceeded: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-replacement-fails-before-publication: 5 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-concurrent-lifecycle-request: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-plugin-hook-handler-times-out: 3 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-plugin-approval-times-out: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-run-aborted-with-pending-approval: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-control-ui-reconnects: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-cron-reconciled-and-changed: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-gateway-stopped-change-saved: 1 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-gateway-restart-reloads-plugins: 4 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-managed-plugin-payload-tampered: 3 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-native-capture-directory-missing: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
phase event-doctor-repairs-legacy-plugin-state: 2 command(s) from run 2 added, each exercising an entry point, a variant or a condition the run 1 phase lacks
correction: reload-plugin: dropped 1 command(s): join of a held call the setup phase already holds (base joins it in event-reload-drain-budget-exceeded)
correction: approve-plugin-permission: dropped 1 command(s): join of an approval call whose start duplicated the base call
correction: event-reload-drain-budget-exceeded: dropped 1 command(s): join of a held call whose start duplicated the base call
correction: event-run-aborted-with-pending-approval: dropped 1 command(s): join of an approval call whose start duplicated the base call
correction: author-and-pack-feature-plugin: dropped 1 command(s): duplicate pack through a shell redirect with a run path inside quotes; the plain pack command stays
correction: activate-agent-built-artifact: artifact path passed with --arg-path outside quotes instead of inside the JSON argument
correction: review-capability-consent: run file renamed consent-review-inspect.json (one writer per run file)
correction: event-captures-fall-back-to-system-temp: $OPENCLAW_HOME moved inside a single-quoted shell argument
correction: event-superseded-generation-retired: $OPENCLAW_HOME moved inside a single-quoted shell argument
correction: event-gateway-killed: $OPENCLAW_HOME moved inside a single-quoted shell argument
correction: requires: traits with no placeholder attached to the phases that run under their condition: plugins-legacy-state -> event-doctor-repairs-legacy-plugin-state, diagnose-plugins, list-installed-plugins, event-gateway-restart-reloads-plugins, update-plugin; plugin-legacy-enabled-unreviewed -> review-capability-consent, enable-and-disable-plugin; plugin-registry-stale -> refresh-plugin-registry, start-gateway-with-plugins; config-plugin-approvals-forwarded -> event-plugin-approvals-forwarded-to-chat; config-provider-without-models -> start-gateway-with-plugins; config-hand-edited -> plugin-hooks-shape-agent-turns; config-plugins-include -> enable-and-disable-plugin
correction: setup-plugin-tool-turn-in-flight: timeoutMs 300000 -> 300000 for merged commands (sum 475000)
correction: install-plugin-from-chat-and-agent: timeoutMs 300000 -> 300000 for merged commands (sum 390000)
correction: enable-and-disable-plugin: timeoutMs 300000 -> 300000 for merged commands (sum 360000)
correction: configure-plugin-settings-in-control-ui: timeoutMs 240000 -> 290000 for merged commands (sum 290000)
correction: reload-plugin: timeoutMs 300000 -> 300000 for merged commands (sum 425000)
correction: use-plugin-pages-and-widgets: timeoutMs 280000 -> 300000 for merged commands (sum 465000)
correction: run-plugin-session-action: timeoutMs 120000 -> 240000 for merged commands (sum 240000)
correction: use-plugin-tools-in-turns: timeoutMs 300000 -> 300000 for merged commands (sum 355000)
correction: plugin-hooks-shape-agent-turns: timeoutMs 300000 -> 300000 for merged commands (sum 455000)
correction: plugin-hooks-follow-sessions-and-subagents: timeoutMs 240000 -> 300000 for merged commands (sum 405000)
correction: plugin-registrations-recorded: timeoutMs 180000 -> 220000 for merged commands (sum 215000)
correction: manage-native-codex-plugins: timeoutMs 300000 -> 300000 for merged commands (sum 360000)
correction: event-plugin-config-edit-hot-replaces-instance: timeoutMs 120000 -> 150000 for merged commands (sum 150000)
correction: event-concurrent-lifecycle-request: timeoutMs 300000 -> 300000 for merged commands (sum 330000)
correction: event-plugin-approval-times-out: timeoutMs 90000 -> 120000 for merged commands (sum 120000)
correction: event-run-aborted-with-pending-approval: timeoutMs 210000 -> 240000 for merged commands (sum 235000)
correction: event-plugin-hook-handler-times-out: timeoutMs 150000 -> 210000 for merged commands (sum 210000)
correction: event-replacement-fails-before-publication: timeoutMs 280000 -> 300000 for merged commands (sum 345000)
correction: setup split by condition: setup-plugin-tool-turn-in-flight (held plugin tool call) and setup-turn-in-flight-main (held main-session turn, from the second run)
correction: install-plugin-from-chat-and-agent: split for the 300000 ms bound; commands added from the second run moved to install-plugin-from-chat-and-agent-continued
correction: enable-and-disable-plugin: split for the 300000 ms bound; commands added from the second run moved to enable-and-disable-plugin-continued
correction: reload-plugin: split for the 300000 ms bound; commands added from the second run moved to reload-plugin-continued
correction: use-plugin-pages-and-widgets: split for the 300000 ms bound; commands added from the second run moved to use-plugin-pages-and-widgets-continued
correction: use-plugin-tools-in-turns: split for the 300000 ms bound; commands added from the second run moved to use-plugin-tools-in-turns-continued
correction: plugin-hooks-shape-agent-turns: split for the 300000 ms bound; commands added from the second run moved to plugin-hooks-shape-agent-turns-continued
correction: plugin-hooks-follow-sessions-and-subagents: split for the 300000 ms bound; commands added from the second run moved to plugin-hooks-follow-sessions-and-subagents-continued
correction: manage-native-codex-plugins: split for the 300000 ms bound; commands added from the second run moved to manage-native-codex-plugins-continued
correction: event-concurrent-lifecycle-request: split for the 300000 ms bound; commands added from the second run moved to event-concurrent-lifecycle-request-continued
correction: event-replacement-fails-before-publication: split for the 300000 ms bound; commands added from the second run moved to event-replacement-fails-before-publication-continued
traits: run 2 names merged into run 1 names where they describe the same persona content: plugin-fixture-all-surfaces -> plugin-fixture-surfaces (keys catalogProbeMethod -> sdkProbeMethod, gatewayMethod -> methodName, httpRoutePath -> routePath, reservedMethod -> reservedMethodName), marketplace-local-fixture -> marketplace-local (path -> marketplacePath), plugin-native-dependency-installed -> plugins-native-dependency, config-plugins-include-file -> config-plugins-include, config-provider-auto-enable -> config-provider-without-models, config-install-policy keys warnPackPath/blockPackPath -> warnPackagePath/blockPackagePath; run 2's single-fixture traits (plugin-pack-*, plugin-disabled-with-config, plugin-load-path-unrecorded, plugin-workspace-discovered, plugin-legacy-enabled-unreviewed, plugin-registry-stale, plugin-authoring-workspace, session-plugin-tools, clawhub-catalog-reachable, codex-harness-native-plugins) stay separate; run 2's plugin-artifact-packed is the artifact run 1 packs during the run, so no trait is needed
names: run 2's Control UI flow names, patch file names and script forms rewritten to run 1's (plugins-settings-installed -> plugins-installed-inventory, plugin-install-ui -> plugin-install-from-catalog, plugin-settings-enable-toggle -> plugin-settings-toggle, plugin-settings-configure -> plugin-settings-editor, plugin-ui-customize -> plugins-customize-ui, plugin-tab-page -> plugin-tab-and-contributions, plugin-uninstall-ui -> plugin-uninstall; plugin-fixture-edit -> plugin-source-edit, plugin-capture-prune -> the env exec removal run 1 uses, gateway-call-as -> gateway-call --profile); every data file under verify/templates/plugins/patches/
search list: run 1 reported the openclaw tool actions plugin_install, plugin_activate_artifact and plugin_uninstall and the /plugins chat command handlers; run 2 reported the plugin_activate_artifact literal, the parsePluginsCommand symbol and the codex_plugins literal; both entry points are already placed from the documents; the input file is unchanged, since both runs searched it as written
breaks: the seven mapped breaks are mapped by both runs; 145553, which run 2 mapped, is not mapped (correction below)
correction after both runs: the input file's glob src/infra/plugin-activation.ts named no file at 7e80556f; the module is ui/src/lib/plugin-activation.ts, so the glob in the input file, the template paths and the Bounds line above name that file. Phase path globs that matched no file were corrected the same way: src/plugins/skill*.ts -> src/plugins/management-skill-read.ts (preview-plugin-skill), src/agents/**/lsp*.ts -> src/agents/agent-bundle-lsp-*.ts (event-turn-cancel-during-bundle-lsp-startup), and src/cron/**/plugin*.ts removed from plugin-hooks-follow-lifecycle (only test files match it). No entry point or condition came from these globs.
counting: entry points are counted one per control, method, command, route or call site; a line in Operations or Excluded entry points that names two controls counts two, which gives the 374 in coverage.md and comparison.md after excluding the internal broadcasts
/btw (chat command): entry point from run 1 only; kept as run 1 listed it
/new, /reset (chat command): entry point from run 1 only; kept as run 1 listed it
Broadcast events plugins.changed, plugins.install.progress, plugins.controlUi.changed, plugin.approval.requested, plugin.approval.resolved: entry point from run 1 only; kept as run 1 listed it
Credential API key field: entry point from run 1 only; kept as run 1 listed it
Docked link reader: entry point from run 1 only; kept as run 1 listed it
Plugin approval prompt decision buttons (Allow once, Allow always, Deny): entry point from run 1 only; kept as run 1 listed it
Plugin frame session navigation (openclaw-plugin-session-open): entry point from run 1 only; kept as run 1 listed it
Plugin overview MCP server details button: entry point from run 1 only; kept as run 1 listed it
Plugin settings "Retry" (config read or write): entry point from run 1 only; kept as run 1 listed it
Plugin settings "Try again" (inspection retry): entry point from run 1 only; kept as run 1 listed it
Plugins hub "View all" (documented as "Show all") for Installed plugins: entry point from run 1 only; kept as run 1 listed it
Secret reference "Source" select: entry point from run 1 only; kept as run 1 listed it
Secret reference value field: entry point from run 1 only; kept as run 1 listed it
api.onConversationBindingResolved (plugin call): entry point from run 1 only; kept as run 1 listed it
openclaw claws status (CLI command): entry point from run 1 only; kept as run 1 listed it
openclaw logs --follow (CLI command): entry point from run 1 only; kept as run 1 listed it
openclaw mcp set (CLI command): entry point from run 1 only; kept as run 1 listed it
openclaw onboard (CLI command): entry point from run 1 only; kept as run 1 listed it
openclaw skills search (CLI command): entry point from run 1 only; kept as run 1 listed it
openclaw tool action plugin_install: entry point from run 1 only; kept as run 1 listed it
openclaw tool action plugin_uninstall: entry point from run 1 only; kept as run 1 listed it
plugin.surface.refresh (Gateway method): entry point from run 1 only; kept as run 1 listed it
session discussion provider (openclaw/plugin-sdk/session-discussion) (plugin call): entry point from run 1 only; kept as run 1 listed it
correction after review: configure-plugin-settings-in-control-ui: restores configure-plugin-settings-in-control-ui-fixture-config.json at the end of the phase
correction after review: use-plugin-tools-in-turns: restores use-plugin-tools-in-turns-tools-allow.json at the end of the phase
correction after review: event-cron-reconciled-and-changed: cron-reload-touch dropped; its cron-disabled and cron-enabled changes already reload cron config
correction after review: set-plugin-loading-policy-in-control-ui: one save covers allow, deny, enabled and the memory slot, restored after Doctor, so later phases run with the policy the persona holds
correction after review: configure-plugin-settings-in-control-ui: the unknown config key is removed again from the saved copy at the end
correction after review: install-plugin-from-cli-sources: official install acknowledges capabilities with the reviewToken of a plugins.inspect it records first
correction after review: plugin-hooks-follow-lifecycle: the cron job file is replaced by cron.update on the persona job, which raises the same cron_changed hook
correction after review: setup phases: the held plugin call and the pending approval run on their own sessions (session-plugin-held, session-approval-held); the main session holds only the in-flight turn
correction after review: approve-plugin-permission: dropped the join of setup handle approval-pending.json (the setup's hold ends before this phase runs)
correction after review: event-reload-drain-budget-exceeded: dropped the join of setup handle plugin-turn.json (the setup's hold ends before this phase runs)
correction after review: operation and event phases: foreground turns and calls move from the main session (held by a setup) to the idle tool session; holds a phase starts and joins itself run on session-plugin-held
correction after review: approve-plugin-permission: starts its own approval-gated call in the background, lists and resolves it, and joins it at the end
correction after review: joins: agent-tool-turn joins pass only the session, --wait and --timeout
correction after review: event-concurrent-lifecycle-request-continued: joins the background reload it starts ({run}/reload-a.json)
correction after review: run-plugin-session-action: browser true (drives control-ui.mjs)
correction after review: author-and-pack-feature-plugin: packs a second time onto the existing artifact, the documented target-exists case
correction after review: list-installed-plugins: its inspect commands moved to inspect-plugin (one operation per phase)
correction after review: event-uninstall-file-removal-fails: moved to the end; it uninstalls and reinstalls the fixture plugin, so every phase that reads the fixture runs before it
correction after review: browse-plugin-catalog: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: browse-plugin-catalog-in-control-ui: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: install-plugin-from-cli-sources: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: install-plugin-through-gateway: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: install-plugin-in-control-ui: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: install-plugin-from-chat-and-agent: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: install-plugin-from-chat-and-agent-continued: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: update-plugin: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: browse-marketplaces-and-feeds: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: author-tool-plugin: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: author-and-pack-feature-plugin: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: event-concurrent-lifecycle-request: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: event-clawhub-registry-unreachable: requires clawhub-registry-local (ClawHub, npm and the marketplace feed served by local fixtures)
correction after review: configure-plugin-settings-in-control-ui: timeoutMs 290000 -> 300000
correction after review: set-plugin-loading-policy-in-control-ui: timeoutMs 240000 -> 300000
correction after review: reload-plugin: timeoutMs 270000 -> 300000
correction after review: use-plugin-pages-and-widgets: timeoutMs 280000 -> 300000
correction after review: approve-plugin-permission: timeoutMs 300000 -> 300000
correction after review: use-plugin-tools-in-turns: timeoutMs 280000 -> 300000
correction after review: plugin-hooks-shape-agent-turns: timeoutMs 280000 -> 300000
correction after review: event-plugin-config-edit-hot-replaces-instance: timeoutMs 150000 -> 270000
correction after review: event-concurrent-lifecycle-request-continued: timeoutMs 60000 -> 180000
correction after review: event-plugin-approvals-forwarded-to-chat: timeoutMs 240000 -> 260000
correction after review: event-passive-reload-disabled: timeoutMs 240000 -> 260000
correction after review: event-control-ui-reconnects: timeoutMs 180000 -> 210000
correction after review: event-plugin-hook-handler-times-out: timeoutMs 210000 -> 270000
correction after review: event-load-path-re-added-during-uninstall-drain: timeoutMs 300000 -> 300000
correction after review: event-replacement-fails-before-publication: timeoutMs 270000 -> 300000
correction after review: timeouts trimmed to fit the 300000 ms bound: configure (editor flow 180000), pages (tab flow 195000), approve (prompt flow 55000), tools (channel turn 40000), hooks (heartbeat 80000), load-path drain (uninstall join 75000)
correction after review: in-phase holds and the approval phase's own pending call run on session-phase-hold, a session no setup holds, so a plan that selects one phase with the setups does not queue its hold behind a setup's
correction after review: break 145553 is not mapped; the phase run 2 named sends a public status URL and does not exercise the encoded form values and Digest authorization the break concerns
correction after review: plugins.controlUi.report is sent by a connected Control UI with the active browser revision; the generic caller cannot send it, so the customize phase records it through the plugins-customize-ui flow and plugins.controlUi.status
correction after review: approve-plugin-permission asks plugin.approval.request for a two-phase acknowledgement, so the call returns the pending id the resolves and waitDecision use
correction after review: event-plugin-approvals-forwarded-to-chat answers the forwarded approval with the id plugin.approval.list returns, through channel-inbound-turn --approve-from
correction after review: event-reload-wait-cancelled starts a held plugin call before the reload so the cancelled wait has admitted work draining
correction after review: Headings walked lists every heading of every listed document with the conditions whose Source names it, and Source names each heading as the document writes it
correction after review: config-change saves through --out; artifact activation reads --artifact-from so the plan selects its archive producer.
correction after review: approval resolvers select exactly one request by session, plugin and tool instead of pending-list order; abort targets the held session; the browser prompt flow creates and resolves its own request id.
correction after review: source installs use a separate package identity; phases replacing or removing persona content follow its readers, preserving run-file dependencies.
correction after review: official inspection uses the discovery catalogId; round 4 names a4ebba8, whose procedure carries sentence-by-sentence reading.

correction after review: unused setup background jobs removed; all remaining background work is joined by its owning phase.
correction after review: system-agent operations run through the operator chat flow, including the exact artifact digest and explicit approval; native UI readers require their fixture and mutating flows restore the Labs setting.
correction after review: channel delivery starts through inbound channel dispatch; the uninstall race uses a managed removal target; active cleanup failure is controlled by a marker read by the live callback.
correction after review: catalog detail uses a discovery id, skill reads declare installed source, filesystem probes use OPENCLAW_STATE_DIR, and the normal-turn join allows its full remaining hold time.
correction after review: destructive ordering includes CLI, Gateway and tool removals, so the capability-widening phase precedes uninstall; CLI-only read-only policy and the unexercised redactor boundary remain uncovered.
correction after review: the entry-point arithmetic now excludes emitted broadcast events consistently with the exclusions above: round 1 312/343 and 315/343; round 2 362/393 and 352/393; round 3 354/374 and 352/374; round 4 334/393 and 373/393.
correction after review: every named config change saves and restores its exact preceding values; update and capability-widening operations precede removal even though both are destructive operations.

correction after review: session compaction and reset use a created session instead of consuming shared persona state; artifact activation temporarily inlines the plugins section and restores its include ownership without losing newly installed values; the multi-entry package starts installed and unreviewed.
correction after review: committed failure is injected by the replacement gateway_start hook; capture fallback is reached on a fresh Gateway allocation with original permissions restored; approval cancellation waits for a matching pending request on a configured route; concurrent lifecycle operations and forced termination wait for the active gateway_stop callback and its live lifecycle lease.

correction after review: mapped historical changes select their exercising phases through SDK and prepared-catalog callers, extension package metadata, deferred plugin startup migration and provider discovery; all seven mappings are checked against their production changed paths. Feature asset publication invokes the selected OpenClaw runtime through OCM after TypeScript compilation.
correction after review: failed UI replacement retains one browser context from working activation through failure and recovery; account connection requires a local HTTP MCP and authorization fixture; uninstall permission injection resolves the current removal target and restores its saved mode.

correction after review: slow-tool, mock-response and channel holds acknowledge their actual admission before a background handle is returned; LSP cancellation waits for a held initialize request and records process cleanup. Skill-preview editing and reopening share one browser controller. Bundled-file faults use a byte-identical private copy of the selected built runtime, preserve the original binding and never mutate shared runtime files.
correction after review: missing-native-capture preparation also resolves current clone-owned references instead of deleting the original persona capture path; the recorded references remain intact for the recovery check.
