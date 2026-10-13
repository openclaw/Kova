# Derivation: channels

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

Reconciled by step 8 from two independent runs of steps 1 to 7, run 1 and run 2, on the same area input file (verify/areas/channels.json) and the same revision.

## Bounds
Paths: src/channels/*/**, src/channels/[!s]*.ts, src/channels/s[!e]*.ts, src/channels/sender-label.ts, src/routing/**, src/pairing/pairing-*.ts, src/polls.ts, src/poll-params.ts, src/infra/outbound/**, src/infra/channel-*.ts, src/infra/channels-status-issues.ts, src/infra/delivery-queue*.ts, src/infra/delivery-recovery*.ts, src/infra/session-delivery-queue*.ts, src/infra/message-tool-run-outcome-store*.ts, src/auto-reply/dispatch*.ts, src/auto-reply/inbound*.ts, src/auto-reply/chunk*.ts, src/auto-reply/envelope*.ts, src/auto-reply/group*.ts, src/auto-reply/media*.ts, src/auto-reply/send*.ts, src/auto-reply/sender*.ts, src/auto-reply/source*.ts, src/auto-reply/reply/dispatch*.ts, src/auto-reply/reply/inbound*.ts, src/auto-reply/reply/block*.ts, src/auto-reply/reply/typing*.ts, src/auto-reply/reply/route*.ts, src/auto-reply/reply/routing*.ts, src/auto-reply/reply/channel*.ts, src/auto-reply/reply/mentions*.ts, src/auto-reply/reply/group*.ts, src/auto-reply/reply/message*.ts, src/auto-reply/reply/conversation*.ts, src/auto-reply/reply/history*.ts, src/auto-reply/reply/origin*.ts, src/auto-reply/reply/source*.ts, src/auto-reply/reply/progress*.ts, src/gateway/server-methods/channels*.ts, src/gateway/server-methods/channel-pairing.ts, src/gateway/server-methods/send*.ts, src/gateway/server-methods/message-*.ts, src/gateway/server-methods/web.ts, src/gateway/server-methods/users-channel-identities.ts, src/cli/channels-cli*.ts, src/cli/channel-auth.ts, src/cli/channel-options.ts, src/cli/directory-cli.ts, src/cli/pairing-cli.ts, src/cli/pairing-command-format.ts, src/cli/message-*.ts, src/cli/outbound-send-deps.ts, src/cli/send-runtime/**, src/cli/program/message/**, src/cli/program/register.message.ts, src/commands/channels.ts, src/commands/channels/**, src/commands/channel-setup/**, src/commands/configure.channels.ts, src/commands/doctor-channel-ingress.ts, src/plugin-sdk/channel-*.ts, ui/src/pages/channels/**, extensions/a2a/src/**, extensions/buzz/src/**, extensions/clickclack/src/**, extensions/discord/src/**, extensions/feishu/src/**, extensions/googlechat/src/**, extensions/imessage/src/**, extensions/irc/src/**, extensions/line/src/**, extensions/matrix/src/**, extensions/mattermost/src/**, extensions/msteams/src/**, extensions/nextcloud-talk/src/**, extensions/nostr/src/**, extensions/raft/src/**, extensions/reef/src/**, extensions/signal/src/**, extensions/slack/src/**, extensions/sms/src/**, extensions/synology-chat/src/**, extensions/telegram/src/**, extensions/tlon/src/**, extensions/twitch/src/**, extensions/whatsapp/src/**, extensions/x/src/**, extensions/zalo/src/**, extensions/zalouser/src/**
Documents: docs/channels/index.md, docs/channels/channel-routing.md, docs/channels/groups.md, docs/channels/group-messages.md, docs/channels/broadcast-groups.md, docs/channels/access-groups.md, docs/channels/ambient-room-events.md, docs/channels/bot-loop-protection.md, docs/channels/location.md, docs/channels/pairing.md, docs/channels/troubleshooting.md, docs/cli/channels.md, docs/cli/message.md, docs/cli/directory.md, docs/cli/pairing.md, docs/concepts/messages.md, docs/concepts/streaming.md, docs/concepts/progress-drafts.md, docs/concepts/typing-indicators.md, docs/concepts/markdown-formatting.md, docs/concepts/retry.md, docs/tools/reactions.md, docs/gateway/config-channels.md, docs/gateway/config-channels/commands.md, docs/gateway/config-channels/community-chat.md, docs/gateway/config-channels/mention-gating-and-history.md, docs/gateway/config-channels/personal-messaging.md, docs/gateway/config-channels/shared-policies.md, docs/gateway/config-channels/workplace-chat.md, docs/gateway/protocol/rpc-system-and-channels.md, docs/plugins/sdk-channel-inbound.md, docs/plugins/sdk-channel-ingress.md, docs/plugins/sdk-channel-outbound.md, docs/plugins/message-presentation.md, docs/tools/agent-send.md, docs/gateway/restart-recovery.md, docs/gateway/config-agents/messages-and-talk.md (added: linked from docs/concepts/messages.md, by run 1)

## Excluded paths
src/channels/session*.ts, chat.* methods and the Control UI chat (webchat is not a channel), docs/tools/subagents/thread-bound-sessions.md, docs/web/webchat.md: owned by sessions
src/infra/update-channels.ts, src/infra/state-migrations.* and openclaw update --channel (release channels): owned by update
extensions/*/package.json, extensions/*/openclaw.plugin.json and other plugin manifests, plugin install, enable, disable and update, docs/plugins/sdk-channel-plugins.md and docs/plugins/sdk-channel-plugins/*: owned by plugins
src/config/** read, write, patch, reload and schema validation mechanics: owned by config (what a channel config key does at runtime stays here)
src/channels/qa-channel/**, extensions/qa-channel/**, extensions/qa-lab/**, docs/channels/qa-channel.md: test-only
src/infra/approval-*, src/plugin-sdk/approval-*, exec and plugin approval delivery and approval reactions: owned by approvals
src/pairing/setup-code.ts, src/pairing/join-code.ts, devices.*, node pairing: owned by nodes
Discord voice (extensions/discord/src/voice/**), docs/nodes/talk/*: owned by talk
src/auto-reply/commands*, src/auto-reply/command*, src/auto-reply/reply/commands*: owned by commands (files among them found by the search list are listed as entry points of kind from commands; native command menus an adapter registers stay here)
src/auto-reply/reply/agent-*, src/auto-reply/reply/get-reply*, src/auto-reply/reply/queue*, src/auto-reply/reply/followup*, docs/concepts/queue.md: owned by agents (files among them found by the search list are listed as entry points of kind from agents)
src/gateway/server-channels.ts, src/gateway/channel-health-monitor.ts, src/gateway/channel-thaw-restart.ts, src/gateway/host-thaw-recovery.ts, src/gateway/server-reload-channel-restart.ts: owned by gateway lifecycle (they start, stop and restart channel accounts; src/gateway/server-channels.ts is found by the search list and stays listed as an entry point)
src/infra/heartbeat-*, src/cron/**: owned by heartbeat and cron (they reach this area and are listed as entry points of kind from heartbeat and from cron)
docs/channels/<id>.md and docs/channels/<id>/* (adapter pages): not read, by the bound; each adapter's platform features are recorded once in coverage.md
Telegram and Discord adapters outside Kova's shim and fixture, and every other adapter's live platform: outside this template's reach (another platform account)
Not excluded but outside the area globs (reported for the area input file): src/agents/tools/message-tool*.ts (the message tool whose actions the bound places here) and ui/src/lib/channels/** (the Channels page data layer, listed as an entry point); phases that exercise them name them in their paths

## Operations
| Operation | Entry points | Kinds |
| --- | --- | --- |
| Set up a channel account | openclaw channels add; openclaw configure (Channels section, configure.channels.ts); Available channel: Set up; Browse all channels (guided setup tile); Detail panel: Run setup; Setup wizard: Continue (and answer fields); Setup wizard: Close / Cancel; Setup and detail docs links (View docs, Open link); packages/gateway-protocol/src/schema/wizard.ts (openclaw channels); src/agents/credential-safety-prompt.ts (openclaw channels); src/commands/configure.wizard.ts (removeChannelConfigWizard); src/commands/setup.ts (openclaw channels); src/flows/channel-setup.prompts.ts (openclaw pairing); src/flows/channel-setup.status.ts (openclaw pairing); src/flows/channel-setup.ts (openclaw channels); src/system-agent/chat-wizard-host.ts (openclaw channels); src/system-agent/operations-execute.ts (openclaw channels); Setup wizard answer field (text, select, multiselect, confirm); Setup wizard reveal secret toggle; Setup wizard Open link | CLI command; UI action; from gateway protocol; from agents; from configure; from setup; from onboarding flows; from system agent |
| Edit a channel's settings on the Channels page | Channel config form fields; Channel config: Save; Channel config: Reload | UI action |
| Link a channel account by QR or interactive login | web.login.start; web.login.wait; openclaw channels login; Setup wizard: Show QR / Regenerate QR (WhatsApp); Setup wizard: Wait for scan (WhatsApp); WhatsApp card: Show QR / Relink; WhatsApp card: Wait for scan | Gateway method; CLI command; UI action |
| Check channel status and health | channels.status; openclaw channels list; openclaw channels status; Channels page route (/channels); Connected channel tile: open details; Available channel tile: open details; Detail panel: Probe; Detail panel: Close; Card refresh icon; WhatsApp card: Refresh; Nostr card: Refresh; apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt ("channels.status"); src/cli/error-format.ts (openclaw channels); src/cli/program/help.ts (openclaw channels, openclaw message); src/cli/program/route-args.ts (openclaw channels); src/cli/update-cli/status.ts ("channels.status"); src/commands/agents.commands.list.ts (openclaw channels); src/commands/doctor-gateway-health.ts ("channels.status", openclaw channels); src/commands/health.ts (probeAccount); src/commands/status.scan-overview.ts ("channels.status"); src/commands/status.scan.gateway.ts (openclaw channels); src/gateway/health/account-context.ts (probeAccount); src/gateway/health/collector.ts (probeAccount); src/gateway/methods/core-descriptors.ts ("channels.logout", "channels.pairing.approve", "channels.pairing.dismiss", "channels.pairing.list", "channels.start", "channels.status", "channels.stop", "message.action", "users.linkChannelIdentity", "users.listChannelIdentities", "users.unlinkChannelIdentity", "web.login.start", "web.login.wait"); src/gateway/server-startup-log.ts (openclaw channels); src/infra/exec-control-command-guard.ts (openclaw channels); src/plugin-sdk/status-helpers.ts (auditAccount, probeAccount); ui/src/lib/channels/index.ts ("channels.logout", "channels.pairing.approve", "channels.pairing.dismiss", "channels.pairing.list", "channels.status", "web.login.start", "web.login.wait"); Channel detail Docs link | Gateway method; CLI command; UI action; from android app; from CLI program; from update; from agents; from doctor; from health; from status; from gateway health; from gateway core; from gateway startup; from exec; from plugin SDK; from Control UI |
| Check what a channel account can do | openclaw channels capabilities | CLI command |
| Read channel logs | openclaw channels logs | CLI command |
| Stop, start or recover a channel account | channels.start; channels.stop; extensions/admin-http-rpc/src/methods.ts ("channels.logout", "channels.start", "channels.status", "channels.stop", "web.login.start", "web.login.wait"); src/gateway/server-channel-account-lifetime.ts (stopAccount); src/gateway/server-channels.ts (startAccount, stopAccount) | Gateway method; from admin HTTP RPC plugin; from gateway runtime |
| Look up contacts, groups and ids | openclaw channels resolve; openclaw directory self; openclaw directory peers list; openclaw directory groups list; openclaw directory groups members; src/gateway/worker-environments/repository-project-admission.ts (openclaw directory) | CLI command; from cloud workers |
| Decide who may message the agent | channels.pairing.list; channels.pairing.approve; channels.pairing.dismiss; openclaw pairing list; openclaw pairing approve; DM access requests: channel filter; DM access requests: account filter; DM access requests: Review account; DM access request: Approve; DM access request: Dismiss; DM access request: Sender details; Approve dialog: Notify the requester after approval; Approve dialog: Also make this sender the first command owner; Approve / Dismiss dialog: confirm; Approve / Dismiss dialog: Cancel; src/auto-reply/reply/commands-allowlist.ts (addChannelAllowFromStoreEntry, readChannelAllowFromStore, removeChannelAllowFromStoreEntry); src/commands/doctor-command-owner.ts (openclaw channels); src/commands/doctor/shared/allowlist-policy-repair.ts (readChannelAllowFromStore); src/gateway/method-scopes.ts ("channels.pairing.approve"); src/plugins/compat/channel-pairing-record.ts (readChannelAllowFromStore); src/plugins/hook-types.ts (openclaw pairing); src/security/audit-channel.ts (resolveAgentRoute); DM access requests refresh | Gateway method; CLI command; UI action; from commands; from doctor; from gateway auth; from plugins; from security |
| Link a channel sender to a Gateway user | users.linkChannelIdentity; users.unlinkChannelIdentity; users.listChannelIdentities; packages/gateway-protocol/src/core-request-params.ts ("users.linkChannelIdentity", "users.listChannelIdentities", "users.unlinkChannelIdentity"); src/gateway/methods/core-profile-access.ts ("users.linkChannelIdentity", "users.listChannelIdentities", "users.unlinkChannelIdentity") | Gateway method; from gateway protocol; from gateway users |
| Message the agent from a chat app | a2a inbound monitor (extensions/a2a/src); buzz inbound monitor (extensions/buzz/src); clickclack inbound monitor (extensions/clickclack/src); discord inbound monitor (extensions/discord/src); feishu inbound monitor (extensions/feishu/src); googlechat inbound monitor (extensions/googlechat/src); imessage inbound monitor (extensions/imessage/src); irc inbound monitor (extensions/irc/src); line inbound monitor (extensions/line/src); matrix inbound monitor (extensions/matrix/src); mattermost inbound monitor (extensions/mattermost/src); msteams inbound monitor (extensions/msteams/src); nextcloud-talk inbound monitor (extensions/nextcloud-talk/src); nostr inbound monitor (extensions/nostr/src); raft inbound monitor (extensions/raft/src); reef inbound monitor (extensions/reef/src); signal inbound monitor (extensions/signal/src); slack inbound monitor (extensions/slack/src); sms inbound monitor (extensions/sms/src); synology-chat inbound monitor (extensions/synology-chat/src); telegram inbound monitor (extensions/telegram/src); tlon inbound monitor (extensions/tlon/src); twitch inbound monitor (extensions/twitch/src); whatsapp inbound monitor (extensions/whatsapp/src); x inbound monitor (extensions/x/src); zalo inbound monitor (extensions/zalo/src); zalouser inbound monitor (extensions/zalouser/src); extensions/policy/src/doctor/strictness.ts (resolveAgentRoute); extensions/policy/src/policy-routing.ts (resolveAgentRoute); src/auto-reply/reply/followup-delivery.ts (routeReply); src/auto-reply/reply/provider-dispatcher.ts (dispatchInboundMessage, dispatchInboundMessageWithBufferedDispatcher, dispatchInboundMessageWithDispatcher, dispatchReplyFromConfig); src/auto-reply/reply/provider-dispatcher.types.ts (dispatchReplyFromConfig); src/commands/doctor/shared/legacy-config-binding-repair.ts (resolveAgentRoute); src/gateway/conversation-route-ownership.ts (resolveAgentRoute); src/gateway/server-methods/chat-send-agent-dispatch.ts (dispatchInboundMessage); src/gateway/server-methods/chat-send-message-injection.ts (dispatchInboundMessage); src/gateway/server-plugins.ts (dispatchReplyFromConfig); src/infra/event-session-routing.ts (resolveAgentRoute); src/plugin-sdk/inbound-reply-dispatch.ts (dispatchChannelInboundReply); src/plugin-sdk/reply-runtime.ts (dispatchInboundMessage, dispatchInboundMessageWithBufferedDispatcher, dispatchInboundMessageWithDispatcher); src/plugin-sdk/routing.ts (resolveAgentRoute); src/plugins/compat/deprecation-marking.ts (dispatchReplyFromConfig); src/plugins/compat/session-persistence-records.ts (resolveAgentRoute); src/plugins/registry-runtime.ts (dispatchReplyFromConfig); src/plugins/runtime/index.ts (dispatchReplyFromConfig); src/plugins/runtime/runtime-channel.ts (dispatchReplyFromConfig, readChannelAllowFromStore, recordChannelActivity, removeChannelAllowFromStoreEntry, resolveAgentRoute, runChannelTurn, upsertChannelPairingRequest); src/plugins/runtime/types-channel.ts (dispatchReplyFromConfig, recordChannelActivity, resolveAgentRoute, runChannelTurn); src/plugins/runtime/types.ts (dispatchReplyFromConfig); src/transcripts/capture.ts (resolveAgentRoute) | channel route; from policy plugin; from agents; from doctor; from sessions; from plugins; from gateway events; from plugin SDK; from transcripts |
| Answer an interactive control in a chat | Presentation button callback; Presentation select callback; Question choice callback; src/agents/tools/question-prompt-send.ts (sendDurableMessageBatchCore) | channel route; from agents (ask_user) |
| Use a channel's native command menu | Native command menu invocation; src/auto-reply/reply/commands-private-route.ts (routeReply); src/auto-reply/reply/commands-reset-hooks.ts (routeReply) | channel route; from commands |
| Bind a chat conversation to a session or agent | extensions/codex/src/conversation-binding-hooks.ts (getSessionBindingService); src/agents/spawn-plan.ts (getSessionBindingService); src/agents/subagents/spawn/acp-spawn-runtime.ts (getSessionBindingService); src/agents/subagents/spawn/acp-spawn.ts (getSessionBindingService); src/agents/subagents/spawn/subagent-spawn-thread-binding.ts (getSessionBindingService); src/agents/subagents/spawn/subagent-spawn.runtime.ts (getSessionBindingService); src/auto-reply/reply/acp-reset-target.ts (getSessionBindingService); src/auto-reply/reply/commands-acp/bindings.ts (getSessionBindingService); src/auto-reply/reply/commands-acp/lifecycle.ts (getSessionBindingService); src/auto-reply/reply/commands-session.ts (getSessionBindingService); src/auto-reply/reply/session-conversation-binding.ts (getSessionBindingService); src/auto-reply/reply/session.ts (getSessionBindingService); src/gateway/server-methods/chat-origin-routing.ts (getSessionBindingService); src/gateway/session-reset-service.ts (getSessionBindingService); src/plugin-sdk/conversation-binding-runtime.ts (getSessionBindingService); src/plugin-sdk/conversation-runtime.ts (getSessionBindingService, readChannelAllowFromStore, registerSessionBindingAdapter, upsertChannelPairingRequest); src/plugin-sdk/session-binding-runtime.ts (getSessionBindingService, registerSessionBindingAdapter); src/plugin-sdk/thread-bindings-runtime.ts (registerSessionBindingAdapter); src/plugin-sdk/thread-bindings-session-runtime.ts (registerSessionBindingAdapter); src/plugins/compat/registry-records.ts (getSessionBindingService); src/plugins/conversation-binding.ts (getSessionBindingService); src/plugins/session-conversation-binding.ts (getSessionBindingService) | from codex plugin; from agents; from subagents; from ACP; from commands; from sessions; from plugin SDK; from plugins |
| Send a message to a chat | send; message.action; openclaw message send; message tool action send; message tool action reply; message tool action sendWithEffect; message tool action conversation-open; src/agents/embedded-agent-message-delivery.ts (outbound/message.js); src/agents/openclaw-plugin-tools.ts (runMessageAction); src/agents/tools/message-tool-execution.ts (runMessageAction); src/agents/tools/sessions-send-tool.a2a.ts (method: "send"); src/commands/message.ts (openclaw message, runMessageAction); src/gateway/conversation-send.ts (sendGatewayConversationMessage); src/gateway/conversation-turn.ts (sendGatewayConversationMessage); src/gateway/server-instance-runtime.ts (method: "send", outbound/message.js); src/gateway/server-methods/conversations.ts (method: "send"); src/gateway/server-methods/core-handlers.ts ("message.action"); src/gateway/session-method-policy.ts ("message.action"); src/infra/approval-gateway-runtime.types.ts (method: "send"); src/plugins/host-hook-attachments.ts (outbound/message.js); src/plugins/registry-runtime-session-ownership.ts ("message.action"); scripts/auth-monitor.sh | Gateway method; CLI command; agent call; from agents; from agents (message tool); from sessions; from CLI commands (openclaw message body); from gateway runtime; from gateway core; from approvals; from plugins; from operator scripts |
| Send one message to several chats | openclaw message broadcast; message tool action broadcast | CLI command; agent call |
| Run a poll in a chat | poll; openclaw message poll; message tool action poll; message tool action poll-vote; extensions/discord/runtime-api.ts (sendPoll); extensions/telegram/runtime-api.ts (sendPoll); extensions/whatsapp/runtime-api.ts (sendPoll); src/plugin-sdk/core.ts (sendPoll) | Gateway method; CLI command; agent call; from discord plugin package; from telegram plugin package; from whatsapp plugin package; from plugin SDK |
| React to messages | openclaw message react; openclaw message reactions; message tool action react; message tool action reactions; Inbound reaction notification; src/gateway/server-methods/sessions-reactions.ts (runMessageAction) | CLI command; agent call; channel route; from sessions |
| Use and upload emoji and stickers | openclaw message emoji list; openclaw message emoji upload; openclaw message sticker send; openclaw message sticker upload; message tool action sticker; message tool action sticker-search; message tool action emoji-list; message tool action emoji-upload; message tool action sticker-upload | CLI command; agent call |
| Read and search a chat's history | openclaw message search; openclaw message read; message tool action read; message tool action search | CLI command; agent call |
| Edit, delete or unsend a sent message | openclaw message edit; openclaw message delete; message tool action edit; message tool action unsend; message tool action delete | CLI command; agent call |
| Pin messages | openclaw message pin; openclaw message unpin; openclaw message pins; message tool action pin; message tool action unpin; message tool action list-pins | CLI command; agent call |
| Work with threads and topics | openclaw message thread create; openclaw message thread list; openclaw message thread reply; message tool action thread-create; message tool action thread-list; message tool action thread-reply; message tool action topic-create; message tool action topic-edit | CLI command; agent call |
| Look up a server's channels, roles, members and permissions | openclaw message permissions; openclaw message role info; openclaw message channel info; openclaw message channel list; openclaw message member info; message tool action permissions; message tool action member-info; message tool action role-info; message tool action channel-info; message tool action channel-list | CLI command; agent call |
| Manage a server's channels and categories | message tool action channel-create; message tool action channel-edit; message tool action channel-delete; message tool action channel-move; message tool action category-create; message tool action category-edit; message tool action category-delete | agent call |
| Schedule and list server events | openclaw message event list; openclaw message event create; message tool action event-list; message tool action event-create | CLI command; agent call |
| Check who is in a voice channel | openclaw message voice status; message tool action voice-status | CLI command; agent call |
| Moderate members | openclaw message role add; openclaw message role remove; openclaw message timeout; openclaw message kick; openclaw message ban; message tool action role-add; message tool action role-remove; message tool action timeout; message tool action kick; message tool action ban | CLI command; agent call |
| Manage a group chat's name, icon and members | message tool action renameGroup; message tool action setGroupIcon; message tool action addParticipant; message tool action removeParticipant; message tool action leaveGroup | agent call |
| Set the bot's profile and presence | Nostr card: Edit profile; Nostr profile name field; Nostr profile displayName field; Nostr profile about field; Nostr profile picture field; Nostr profile banner field; Nostr profile website field; Nostr profile nip05 field; Nostr profile lud16 field; Nostr profile: Save and publish; Nostr profile: Import from relays; Nostr profile: Show / Hide advanced; Nostr profile: Cancel; message tool action set-profile; message tool action set-presence; Nostr profile HTTP routes (PUT profile, POST profile import) | UI action; agent call; plugin call |
| Transfer files through a chat | message tool action sendAttachment; message tool action download-file; message tool action upload-file; src/gateway/tool-upload-policy.ts ("message.action"); src/gateway/upload-policy.ts ("message.action") | agent call; from gateway uploads |
| Deliver agent, cron, heartbeat and sub-agent output to a chat | openclaw agent --deliver; Cron job delivery; Heartbeat delivery; Subagent announce to a channel; apps/macos/Sources/OpenClaw/AppState.swift (enqueueDelivery); src/agents/bash-tools.exec-approval-followup.ts (outbound/message.js); src/agents/command/delivery-result.ts (sendDurableMessageBatchCore); src/agents/command/delivery.ts (resolveAgentDeliveryPlanWithSessionRoute, sendDurableMessageBatchCore); src/agents/command/session-helpers.ts (resolveAgentDeliveryPlanWithSessionRoute); src/agents/subagents/announce/subagent-announce-delivery.runtime.ts (outbound/message.js); src/agents/subagents/announce/subagent-announce-delivery.ts (scheduleSessionDelivery); src/agents/subagents/completion/subagent-completion-admission.store.ts (scheduleSessionDelivery); src/commands/doctor/cron/warnings.ts (openclaw channels); src/cron/delivery.ts (sendDurableMessageBatchCore); src/cron/isolated-agent/delivery-dispatch.ts (sendDurableMessageBatchCore); src/cron/isolated-agent/delivery-outbound.runtime.ts (sendDurableMessageBatchCore); src/gateway/agent-turn/agent-delivery-phase.ts (resolveAgentDeliveryPlanWithSessionRoute); src/gateway/server-methods/agent-session-reset.ts (resolveAgentDeliveryPlanWithSessionRoute); src/gateway/server-node-events.ts (sendDurableMessageBatchCore); src/infra/exec-approval-forwarder.runtime.ts (sendDurableMessageBatchCore); src/infra/exec-approval-forwarder.ts (sendDurableMessageBatchCore); src/infra/heartbeat-dispatch.ts (sendDurableMessageBatchCore); src/infra/heartbeat-runner-run.ts (dispatchInboundMessage); src/media-understanding/echo-transcript.ts (sendDurableMessageBatchCore); src/skills/workshop/review-outcome.ts (sendDurableMessageBatchCore); src/talk/client-voice-mutation-digest-owner.ts (sendDurableMessageBatchCore) | from agents; from cron; from heartbeat; from subagents; from macos app; from doctor; from sessions; from nodes; from approvals; from media understanding; from skills; from talk |
| Inspect and resubmit failed inbound events | openclaw channels dead-letters list; openclaw channels dead-letters resubmit; src/flows/doctor-health-contribution-runners.state.ts (noteChannelIngressDeadLetters) | CLI command; from doctor |
| Have pending deliveries and inbound events recovered | Outbound delivery queue recovery pass; Session delivery queue recovery; Channel ingress drain poll; src/gateway/server-restart-sentinel-notice.ts (deliverOutboundPayloads, deliverOutboundPayloadsInternal, drainPendingDeliveriesCore, runOutboundDelivery, sendDurableMessageBatchCore); src/gateway/server-restart-sentinel.ts (enqueueSessionDelivery); src/gateway/server-runtime-services.ts (deliverOutboundPayloads, deliverOutboundPayloadsInternal, drainPendingDeliveriesCore, recoverPendingDeliveries, schedulePendingSessionDeliveries, startSessionDeliveryRuntime); src/plugin-sdk/delivery-queue-runtime.ts (deliverOutboundPayloads, deliverOutboundPayloadsInternal, drainPendingDeliveriesCore) | scheduled job; from gateway restart; from gateway runtime; from plugin SDK |
| Log out of a channel account | channels.logout; openclaw channels logout; WhatsApp card: Logout | Gateway method; CLI command; UI action |
| Remove or disable a channel account | openclaw channels remove | CLI command |

## Excluded entry points
Discord voice channels: owned by talk (bound); distinct from the Discord inbound monitor
qqbot (docs/channels/index.md, no source in this checkout): external plugin, no source at this revision (bound)
wechat (docs/channels/index.md, no source in this checkout): external plugin, no source at this revision (bound)
wecom (docs/channels/index.md, no source in this checkout): external plugin, no source at this revision (bound)
yuanbao (docs/channels/index.md, no source in this checkout): external plugin, no source at this revision (bound)
zaloclawbot (docs/channels/index.md, no source in this checkout): external plugin, no source at this revision (bound)
WebChat (docs/channels/index.md entry): owned by sessions (bound: webchat is not a channel)
Voice Call plugin (docs/channels/index.md related plugin): owned by talk (bound)
extensions/buzz/README.md (openclaw channels, openclaw directory, openclaw message): documentation text, not a code path
extensions/clickclack/README.md (openclaw channels): documentation text, not a code path
extensions/matrix/CHANGELOG.md (openclaw channels, openclaw message): documentation text, not a code path
extensions/reef/README.md (openclaw channels): documentation text, not a code path
extensions/telegram/README.md (openclaw channels): documentation text, not a code path
extensions/zalouser/README.md (openclaw channels, openclaw directory, openclaw message): documentation text, not a code path
src/wizard/i18n/locales/en.ts (openclaw channels): translation strings, not a code path
src/wizard/i18n/locales/zh-CN.ts (openclaw channels): translation strings, not a code path
src/wizard/i18n/locales/zh-TW.ts (openclaw channels): translation strings, not a code path
ui/src/i18n/.i18n/ar.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/de.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/es.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/fa.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/fr.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/hi.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/id.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/it.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/ja-JP.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/ko.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/nl.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/pl.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/pt-BR.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/ru.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/th.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/tr.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/uk.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/vi.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/zh-CN.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
ui/src/i18n/.i18n/zh-TW.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): translation strings, not a code path
extensions/qa-channel/src/channel.ts (startAccount): test-only (bound: qa-lab and qa-channel)
extensions/qa-channel/src/inbound.ts (resolveAgentRoute): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/harness-runtime.ts (resolveAgentRoute): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/lab-server.ts (startAccount): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/live-transports/matrix/adapter.runtime.ts ("message.action"): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-message-actions.ts ("message.action"): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/live-transports/shared/live-channel-status.ts ("channels.status"): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/live-transports/telegram/userbot-driver.runtime.ts (method: "send"): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.gateway.ts ("message.action"): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/qa-transport.ts ("channels.status"): test-only (bound: qa-lab and qa-channel)
extensions/qa-lab/src/suite-runtime-flow.ts (resolveAgentRoute): test-only (bound: qa-lab and qa-channel)
Channel status, presence and health broadcast events to clients: internal: broadcast events are not entry points
Control UI shell controls (navigation, theme, account, settings panel): shell
wizard.start / wizard.next / wizard.cancel (setup wizard steps): consumed from onboarding wizard
config.get / config.schema / config.patch (channel config form): consumed from config
plugins install triggered by channels add: consumed from plugins (bound)
/activation: owned by commands (bound: slash command parsing and execution)
/session unbind, /session idle, /session max-age, /agents (thread bindings): owned by sessions (bound: thread-bound subagent sessions)
openclaw devices / openclaw nodes / /pair (node and device pairing): owned by nodes (bound)
conversations_list / conversations_send / conversations_turn tools and conversations.* methods: owned by sessions (bound); files found by search that call them are listed above as from sessions
Exec and plugin approval delivery and approval reactions: owned by approvals (bound)
openclaw agents bind / unbind / bindings: owned by agents
openclaw gateway call channels.start / channels.stop: generic Gateway caller; the methods are listed above
chat.send and the Control UI chat: owned by sessions (bound: webchat is not a channel)
session.reactions.*: owned by sessions (bound); sessions-reactions.ts found by search is listed above
openclaw update --channel and release channels: owned by update (bound)
Adapter-specific features on docs/channels/<id>.md pages (whatsapp_login tool, matrix verify, Slack slash command, Discord components): outside this template (bound: adapter pages are not read)
plugins.list (Channels page plugin presentation): consumed from plugins
kova.channelProbe.status, reset, inject, observations: harness, not an entry point (bound): Kova conformance channel
config/test-mock-exports-baseline.txt: test-only
qa/scenarios/channels/native-command-session-target.yaml: test-only
qa/scenarios/channels/telegram-startup-getme-live.yaml: test-only
qa/scenarios/channels/telegram-startup-getme-outcomes.yaml: test-only
qa/scenarios/ui/control-ui-assistant-transcript-role-boundary.yaml: test-only
qa/scenarios/ui/control-ui-qa-channel-image-roundtrip.yaml: test-only
scripts/audit-seams.mts: internal: lint and audit tooling, no runtime path
scripts/check-deprecated-api-usage.mts: internal: lint and audit tooling, no runtime path
scripts/check-no-deprecated-channel-access.ts: internal: lint and audit tooling, no runtime path
scripts/check-no-pairing-store-group-auth.mts: internal: lint and audit tooling, no runtime path
scripts/check-pairing-account-scope.mts: internal: lint and audit tooling, no runtime path
scripts/control-ui-mock-dev.ts: test-only (mock Gateway for UI development)
scripts/dev/discord-acp-plain-language-smoke.ts: test-only (development smoke script)
scripts/lib/plugin-sdk-shipped-surface.json: internal: lint and audit tooling, no runtime path
scripts/run-openclaw-podman.sh: internal: names the command in a usage comment only
security/opengrep/precise.yml: internal: lint and audit tooling, no runtime path
taxonomy.yaml: internal: documentation metadata, no runtime path
appcast.xml: internal: release-notes text, no runtime path
appcast-arm64.xml: internal: release-notes text, no runtime path
appcast-x86_64.xml: internal: release-notes text, no runtime path
test/type-contracts/plugin-service-scheduling.ts: test-only
src/plugin-sdk/plugin-state-test-runtime.ts: test-only

## Conditions
| # | Condition | Source | Kind | Persona trait |
| --- | --- | --- | --- | --- |
| 1 | Channel account added on a running Gateway, applied by hot reload | docs/channels/index.md "Which channel should I connect first?"; docs/cli/channels.md "Add / remove accounts" | event | channel-telegram-shim, channels-test-accounts |
| 2 | Bot joins an allowed group and posts one room introduction | docs/channels/index.md "Group join introductions"; docs/gateway/config-channels/personal-messaging.md "Telegram"; docs/gateway/config-channels/personal-messaging.md "LINE"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/community-chat.md "Matrix"; docs/gateway/config-channels/workplace-chat.md "Slack" | event | channel-group-joinable, channel-groups-mixed |
| 3 | Join introductions turned off (joinIntro false) | docs/channels/index.md "Group join introductions" | ambient | config-join-intro-off, channel-groups-mixed |
| 4 | Room history unavailable at join, introduced from metadata only | docs/channels/index.md "Group join introductions" | ambient | channel-group-joinable, channel-groups-mixed |
| 5 | Discord join with no qualifying text channel, skip recorded | docs/channels/index.md "Group join introductions"; docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture |
| 6 | Durable 90-day join-introduction claim, not repeated on reconnect or restart | docs/channels/index.md "Group join introductions" | ambient | channel-group-introduced, channel-groups-mixed |
| 7 | Stale Discord server-available events after restart ignored | docs/channels/index.md "Group join introductions" | event | channel-discord-fixture |
| 8 | Matrix startup snapshots, membership updates and unaccepted invites do not introduce | docs/channels/index.md "Group join introductions"; docs/gateway/config-channels/community-chat.md "Matrix" | event | channel-real-accounts |
| 9 | Re-invite after join claim expired introduces again | docs/channels/index.md "Group join introductions" | event | channel-group-introduced, channel-groups-mixed |
| 10 | Introduction turn on untrusted room content: no tools, 60-second bound | docs/channels/index.md "Group join introductions" | event | channel-group-joinable, channel-groups-mixed |
| 11 | Join into a room the access policy does not allow, no introduction | docs/channels/index.md "Group join introductions" | event | channel-group-joinable, channel-groups-mixed |
| 12 | Telegram reply with markdown image syntax converted to media reply | docs/channels/index.md "Delivery notes" | ambient | mock-provider-markdown-reply |
| 13 | Slack multi-person DM routed as a group chat | docs/channels/index.md "Delivery notes" | ambient | none |
| 14 | Channel plugin installed on demand, loaded only when the channel is active (WhatsApp) | docs/channels/index.md "Delivery notes" | ambient | config-channel-not-installed |
| 15 | Two bots replying to each other, stopped by bot loop protection | docs/channels/index.md "Delivery notes"; docs/channels/bot-loop-protection.md "Bot loop protection"; docs/channels/bot-loop-protection.md "Defaults"; docs/gateway/config-channels/community-chat.md "Discord" | event | channel-bot-peer |
| 16 | Bot-authored inbound accepted (allowBots) | docs/channels/bot-loop-protection.md "Bot loop protection" | ambient | channel-bot-peer |
| 17 | Ambient room events: unmentioned room chatter recorded as quiet context | docs/channels/index.md "Delivery notes"; docs/channels/groups.md "Groups"; docs/channels/ambient-room-events.md "Ambient room events"; docs/channels/ambient-room-events.md "Recommended setup"; docs/concepts/messages.md "Silent replies"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | channel-group-ambient, channel-ambient-room |
| 18 | Several channels running at once, each chat routed on its own | docs/channels/index.md "Notes"; docs/cli/message.md "Channel selection"; docs/cli/pairing.md "pairing list" | ambient | channels-test-accounts |
| 19 | DM pairing and allowlists enforced on unknown senders | docs/channels/index.md "Notes"; docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | channels-test-accounts |
| 20 | DM scope main: DMs from every channel converge on the main session | docs/channels/channel-routing.md "Channels & routing"; docs/channels/groups.md "Session keys"; docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | session-main-rolling |
| 21 | Several accounts on one channel with an explicit default account | docs/channels/channel-routing.md "Key terms"; docs/cli/pairing.md "Commands"; docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)" | ambient | channel-multi-account, channel-accounts-multiple |
| 22 | Several accounts on one channel without a default, first normalized id used | docs/channels/channel-routing.md "Key terms"; docs/gateway/config-channels/personal-messaging.md "WhatsApp"; docs/gateway/config-channels/personal-messaging.md "Telegram" | ambient | channel-multi-account-no-default, channel-accounts-multiple |
| 23 | Plugin send receipt reporting failure, suppression or dry run leaves stored route unchanged | docs/channels/channel-routing.md "Outbound target prefixes"; docs/cli/message.md "Send" | event | channel-probe-conversations |
| 24 | Confirmed partial send establishes route without mirroring content as delivered | docs/channels/channel-routing.md "Outbound target prefixes"; docs/cli/message.md "Send"; docs/plugins/sdk-channel-inbound.md "Delivery settlement contract"; docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership"; docs/tools/agent-send.md "Behavior" | event | channel-telegram-shim, mock-provider-long-reply, channel-probe-conversations |
| 25 | DM scope per-peer | docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | dm-scope-isolated |
| 26 | DM scope per-channel-peer | docs/channels/channel-routing.md "Session key shapes (examples)"; docs/tools/agent-send.md "Behavior" | ambient | config-dm-scope-per-channel-peer, dm-scope-isolated |
| 27 | DM scope per-account-channel-peer | docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | config-dm-scope-per-account, dm-scope-isolated |
| 28 | Route binding overriding DM scope for its peers | docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | config-bindings-tiers |
| 29 | External DMs sharing main history under a per-account direct-chat runtime key | docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | session-main-rolling |
| 30 | Group scope per-group | docs/channels/channel-routing.md "Session key shapes (examples)"; docs/channels/groups.md "Session keys" | ambient | session-group-watched, channel-groups-mixed |
| 31 | Group scope main globally | docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | config-group-scope-main, config-bindings-tiers |
| 32 | Binding overriding group scope for selected rooms | docs/channels/channel-routing.md "Session key shapes (examples)"; docs/channels/groups.md "Session keys" | ambient | config-bindings-tiers |
| 33 | Slack or Discord thread keyed as its own session | docs/channels/channel-routing.md "Session key shapes (examples)" | ambient | channel-thread-session, channel-groups-mixed |
| 34 | Telegram forum topic keyed into the group session | docs/channels/channel-routing.md "Session key shapes (examples)"; docs/channels/groups.md "Session keys" | ambient | channel-telegram-forum, channel-groups-mixed |
| 35 | Non-owner DM while main DM route is pinned to the single allowFrom owner | docs/channels/channel-routing.md "Main DM route pinning" | event | channel-dm-owner-pinned, session-main-rolling |
| 36 | Guarded inbound (createIfMissing false) with no session creates no route-only session | docs/channels/channel-routing.md "Guarded inbound recording" | event | channel-probe-conversations |
| 37 | Exact peer binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 38 | Thread inherits parent peer binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 39 | Peer-kind wildcard binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 40 | Discord guild-and-roles binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 41 | Discord guild binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 42 | Slack team binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | none |
| 43 | Account binding | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)"; docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)" | ambient | config-bindings-tiers |
| 44 | Channel-wide binding (accountId *) | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 45 | No binding matches, fallback owner used | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 46 | Several agents with no owner and no matching binding, no agent picked | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | env-explicit-fleet-no-owner, config-bindings-tiers |
| 47 | Binding with several match fields, all must match | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-bindings-tiers |
| 48 | Legacy default-agent markers awaiting doctor --fix | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | config-legacy-default-markers, config-legacy-route-markers |
| 49 | No agent roster, single main agent receives every route | docs/channels/channel-routing.md "Routing rules (how an agent is chosen)" | ambient | env-fresh-no-roster |
| 50 | Broadcast group running several agents for one room message | docs/channels/channel-routing.md "Broadcast groups (run multiple agents)"; docs/channels/broadcast-groups.md "Overview"; docs/plugins/sdk-channel-inbound.md "Agent group dispatch" | ambient | channel-broadcast-group |
| 51 | Legacy WhatsApp broadcast array with single-pass fan-out | docs/channels/channel-routing.md "Broadcast groups (run multiple agents)"; docs/channels/broadcast-groups.md "Overview"; docs/channels/broadcast-groups.md "Basic setup" | ambient | none |
| 52 | ACP binding on a broadcast room stays exclusive and bypasses fan-out | docs/channels/channel-routing.md "Broadcast groups (run multiple agents)"; docs/channels/broadcast-groups.md "Message flow"; docs/channels/broadcast-groups.md "Routing"; docs/plugins/sdk-channel-inbound.md "Agent group dispatch" | ambient | config-acp-binding, channel-broadcast-group |
| 53 | Inbound reply to an earlier message carries reply context | docs/channels/channel-routing.md "Reply context" | event | channel-probe-conversations |
| 54 | Default groupPolicy allowlist: unlisted group or sender blocked | docs/channels/groups.md "Beginner intro (2 minutes)"; docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | channel-group-allowlisted, channel-groups-mixed |
| 55 | Group replies require a mention (requireMention default) | docs/channels/groups.md "Beginner intro (2 minutes)"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | channel-group-allowlisted |
| 56 | Final reply text posted to the room automatically (visibleReplies automatic) | docs/channels/groups.md "Beginner intro (2 minutes)" | ambient | channel-group-allowlisted, channel-groups-mixed |
| 57 | groupPolicy disabled drops every group message | docs/channels/groups.md "Beginner intro (2 minutes)"; docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | config-group-policy-disabled, channel-groups-mixed |
| 58 | Unmentioned message in a mention-gated group stored as context only | docs/channels/groups.md "Beginner intro (2 minutes)"; docs/plugins/sdk-channel-ingress.md "Routes and activation" | event | channel-group-allowlisted, channel-groups-mixed |
| 59 | Always-on group (requireMention false), every message triggers | docs/channels/groups.md "Beginner intro (2 minutes)"; docs/channels/group-messages.md "Behavior"; docs/channels/groups.md "Mention gating (default)" | ambient | channel-group-always-on, channel-groups-mixed |
| 60 | requireMentionInBotThreads false: unmentioned follow-ups accepted in bot-created thread | docs/channels/groups.md "Bot-created threads" | ambient | channel-bot-thread, channel-groups-mixed |
| 61 | requireMentionInBotThreads true: mention required in bot-created thread | docs/channels/groups.md "Bot-created threads" | ambient | channel-bot-thread, channel-groups-mixed |
| 62 | Thread ownership unknown or evicted from bounded cache, ordinary mention rules | docs/channels/groups.md "Bot-created threads" | event | channel-bot-thread, channel-groups-mixed |
| 63 | Bot replied in a thread someone else created, not treated as creator | docs/channels/groups.md "Bot-created threads" | event | channel-groups-mixed |
| 64 | Mention rules or allowlists changed while an admitted turn is in flight | docs/channels/groups.md "Bot-created threads" | event | channel-group-allowlisted, config-channel-patches, mock-provider-held-turn, channel-groups-mixed |
| 65 | Telegram privacy mode on, unmentioned group messages not delivered | docs/channels/groups.md "Bot-created threads"; docs/channels/ambient-room-events.md "Telegram example" | ambient | channel-telegram-shim |
| 66 | Discord Message Content Intent off, unmentioned messages not delivered | docs/channels/groups.md "Bot-created threads"; docs/gateway/config-channels/community-chat.md "Discord" | ambient | channel-discord-fixture |
| 67 | Slack without channel membership or message event subscription | docs/channels/groups.md "Bot-created threads" | ambient | none |
| 68 | Microsoft Teams without ChannelMessage.Read.Group permission | docs/channels/groups.md "Bot-created threads" | ambient | none |
| 69 | Google Chat interaction webhook gives no unmentioned messages or thread owners | docs/channels/groups.md "Bot-created threads" | ambient | none |
| 70 | Group visible replies through the message tool only | docs/channels/groups.md "Visible replies" | ambient | config-visible-replies-tool |
| 71 | Tool-only delivery, model returns final text without the message tool, kept private with bounded recovery | docs/channels/groups.md "Visible replies"; docs/channels/ambient-room-events.md "Visible reply modes"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | event | channel-group-allowlisted, config-visible-replies-tool, mock-provider-final-text-only |
| 72 | Tool-only delivery with message tool unavailable under tool policy, falls back to automatic | docs/channels/groups.md "Visible replies"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | config-visible-replies-tool-denied, config-visible-replies-tool |
| 73 | Tool-only visible replies for every source chat (messages.visibleReplies) | docs/channels/groups.md "Visible replies"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating"; docs/gateway/config-agents/messages-and-talk.md "Other message keys" | ambient | config-visible-replies-tool |
| 74 | Group silent replies allowed (silentReply.group allow, NO_REPLY) | docs/channels/groups.md "Visible replies"; docs/concepts/messages.md "Silent replies" | ambient | config-silent-group-allow, channel-groups-mixed |
| 75 | Clean empty or reasoning-only group turn treated as NO_REPLY | docs/channels/groups.md "Scope configured mention patterns"; docs/channels/groups.md "Visible replies" | event | channel-group-allowlisted, config-silent-group-allow, mock-provider-empty-turn, channel-groups-mixed |
| 76 | Plugin-owned conversation binding, plugin reply is the visible response | docs/channels/groups.md "Visible replies"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | channel-plugin-binding |
| 77 | Verbose on for a channel session, tool and progress summaries posted | docs/channels/groups.md "Visible replies" | ambient | channel-groups-mixed |
| 78 | messages config changed and applied without restart | docs/channels/groups.md "Visible replies"; docs/channels/ambient-room-events.md "Prerequisites"; docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | event | channel-group-allowlisted, config-channel-patches, config-visible-replies-tool |
| 79 | Config reload off, channel and messages changes need a restart | docs/channels/groups.md "Visible replies"; docs/channels/ambient-room-events.md "Prerequisites" | ambient | config-reload-off, config-visible-replies-tool |
| 80 | Authorized command turn under tool-only delivery replies visibly | docs/channels/groups.md "Visible replies" | event | channel-group-allowlisted, channel-paired-sender, channel-telegram-shim, config-visible-replies-tool |
| 81 | Unauthorized text command in a group stays message-tool-only | docs/channels/groups.md "Visible replies" | event | channel-group-allowlisted, channel-paired-sender, channel-telegram-shim, config-visible-replies-tool |
| 82 | contextVisibility all: supplemental context kept as received | docs/channels/groups.md "Context visibility and allowlists"; docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | ambient | channel-group-allowlisted |
| 83 | contextVisibility allowlist | docs/channels/groups.md "Context visibility and allowlists" | ambient | config-context-visibility, channel-groups-mixed |
| 84 | contextVisibility allowlist_quote | docs/channels/groups.md "Context visibility and allowlists" | ambient | config-context-visibility, channel-groups-mixed |
| 85 | Unknown contextVisibility combination fails closed | docs/channels/groups.md "Context visibility and allowlists" | ambient | config-context-visibility-unknown, channel-groups-mixed |
| 86 | Prompt with several senders' context, tool policy from originating requester | docs/channels/groups.md "Context visibility and allowlists" | ambient | channel-group-allowlisted, channel-groups-mixed |
| 87 | Group with very long opaque id shown under shortened stable label | docs/channels/groups.md "Display labels" | ambient | channel-group-long-id, channel-groups-mixed |
| 88 | groupPolicy open bypasses allowlists, mention gating still applies | docs/channels/groups.md "Group policy"; docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | config-group-policy-open, channel-groups-mixed |
| 89 | Signal groupAllowFrom matching group id or sender | docs/channels/groups.md "Group policy" | ambient | none |
| 90 | DM-paired sender not authorized in groups | docs/channels/groups.md "Group policy"; docs/channels/pairing.md "Approve from the Control UI" | ambient | channel-paired-sender, channel-groups-mixed |
| 91 | Matrix room-name or unresolved allowlist keys ignored unless name matching enabled | docs/channels/groups.md "Group policy" | ambient | none |
| 92 | Discord and Slack group DMs controlled separately | docs/channels/groups.md "Group policy" | ambient | config-discord-group-dms |
| 93 | Telegram @username sender allowlist entries never match, warning logged | docs/channels/groups.md "Group policy" | ambient | config-telegram-username-allow |
| 94 | Empty group allowlist blocks every group message | docs/channels/groups.md "Group policy"; docs/channels/groups.md "Beginner intro (2 minutes)" | ambient | config-group-allowlist-empty, channel-groups-mixed |
| 95 | Missing channels.<provider> block fails closed to allowlist, logged once per account | docs/channels/groups.md "Group policy"; docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | config-provider-block-missing, channel-groups-mixed |
| 96 | Reply to the bot counted as a mention | docs/channels/groups.md "Mention gating (default)"; docs/plugins/sdk-channel-ingress.md "Routes and activation" | event | channel-group-allowlisted, channel-groups-mixed |
| 97 | Quote of the bot counted as a mention | docs/channels/groups.md "Mention gating (default)" | event | channel-real-accounts, channel-groups-mixed |
| 98 | Bot having joined the thread counted as a mention | docs/channels/groups.md "Mention gating (default)" | event | channel-real-accounts, channel-groups-mixed |
| 99 | Implicit mentions turned off | docs/channels/groups.md "Mention gating (default)"; docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | ambient | config-implicit-mentions-off, channel-groups-mixed |
| 100 | Native mention triggers where regex patterns are denied | docs/channels/groups.md "Scope configured mention patterns" | event | config-mention-patterns-scoped, channel-groups-mixed |
| 101 | Regex mention patterns mode deny with allowIn rooms | docs/channels/groups.md "Scope configured mention patterns" | ambient | config-mention-patterns-scoped, channel-groups-mixed |
| 102 | Regex mention patterns mode allow with denyIn rooms | docs/channels/groups.md "Scope configured mention patterns" | ambient | config-mention-patterns-scoped, channel-groups-mixed |
| 103 | Account-level mention pattern policy overrides channel policy | docs/channels/groups.md "Scope configured mention patterns" | ambient | config-mention-account-policy, channel-groups-mixed |
| 104 | Invalid or unsafe mention patterns ignored with a warning | docs/channels/groups.md "Scope configured mention patterns"; docs/channels/group-messages.md "Config example (WhatsApp)" | ambient | config-mention-pattern-invalid, channel-groups-mixed |
| 105 | Mention patterns derived from agent identity when none set, suppressed by empty list | docs/channels/groups.md "Scope configured mention patterns"; docs/channels/group-messages.md "WhatsApp group messages" | ambient | channel-group-allowlisted, channel-groups-mixed |
| 106 | Pending skipped messages kept as group history up to historyLimit | docs/channels/groups.md "Scope configured mention patterns"; docs/channels/group-messages.md "Behavior"; docs/channels/group-messages.md "Config example (WhatsApp)"; docs/channels/ambient-room-events.md "History"; docs/concepts/messages.md "Prompt bodies and history context" | ambient | channel-group-history, channel-groups-mixed |
| 107 | Group history context disabled (historyLimit 0) | docs/channels/groups.md "Scope configured mention patterns"; docs/channels/ambient-room-events.md "History"; docs/concepts/messages.md "Prompt bodies and history context" | ambient | config-history-limit-zero, channel-groups-mixed |
| 108 | Group or per-sender tool restrictions on a room | docs/channels/groups.md "Group/channel tool restrictions (optional)" | ambient | config-group-tools, channel-groups-mixed |
| 109 | Restricted sender's turn delegated or queued keeps the restriction | docs/channels/groups.md "Group/channel tool restrictions (optional)" | event | channel-groups-mixed |
| 110 | Retired unprefixed toolsBySender keys awaiting doctor --fix | docs/channels/groups.md "Group/channel tool restrictions (optional)" | ambient | config-tools-by-sender-legacy, config-legacy-route-markers |
| 111 | Wildcard group entry allowing all groups with default mention behaviour | docs/channels/groups.md "Group allowlists" | ambient | channel-group-allowlisted |
| 112 | Stored group activation mode overriding requireMention | docs/channels/groups.md "Activation (owner-only)"; docs/channels/group-messages.md "Behavior" | ambient | channel-group-activation, channel-groups-mixed |
| 113 | First turn of a new group session carries the group intro | docs/channels/groups.md "Context fields"; docs/channels/group-messages.md "Behavior" | event | channel-group-allowlisted, channel-paired-sender, channel-groups-mixed |
| 114 | Group names and participant labels rendered as fenced untrusted metadata | docs/channels/groups.md "Context fields" | ambient | channel-group-allowlisted, channel-groups-mixed |
| 115 | Channel table mode does not preserve tables, Markdown tables discouraged | docs/channels/groups.md "Context fields" | ambient | config-table-mode-off |
| 116 | WhatsApp group woken by @-mention, pattern, E.164 digits or quoted reply | docs/channels/group-messages.md "Behavior" | event | none |
| 117 | WhatsApp group not in channels.whatsapp.groups dropped with a log hint | docs/channels/group-messages.md "Behavior" | event | channel-real-accounts |
| 118 | WhatsApp group on a non-default account keyed with account suffix | docs/channels/group-messages.md "Behavior" | ambient | none |
| 119 | Ephemeral or view-once WhatsApp message unwrapped so a ping still triggers | docs/channels/group-messages.md "Behavior" | event | channel-real-accounts |
| 120 | Pending group context injected and cleared after the run | docs/channels/group-messages.md "Behavior" | event | channel-groups-mixed |
| 121 | Non-owner /activation ignored and stored as context only | docs/channels/group-messages.md "Activation command (owner-only)" | event | channel-group-activation, channel-group-allowlisted, channel-groups-mixed |
| 122 | Identical repeated group batch skipped as echo | docs/channels/group-messages.md "Known considerations" | event | channel-group-allowlisted, channel-groups-mixed |
| 123 | Bot's own delivered message echoed back skipped | docs/channels/group-messages.md "Known considerations" | event | channel-groups-mixed |
| 124 | Allowed group that has never triggered a run has no session row | docs/channels/group-messages.md "Known considerations" | ambient | channel-groups-mixed |
| 125 | Typing starts immediately under message-tool-only visible replies | docs/channels/group-messages.md "Known considerations"; docs/concepts/typing-indicators.md "Defaults" | ambient | config-visible-replies-tool |
| 126 | Mention of a broadcast participant satisfies the room mention gate | docs/channels/broadcast-groups.md "Overview" | event | channel-broadcast-group, channel-group-allowlisted |
| 127 | Broadcast turn budget smaller than eligible participants, configured order decides | docs/channels/broadcast-groups.md "Agent group threads"; docs/plugins/sdk-channel-inbound.md "Agent group dispatch" | ambient | channel-broadcast-group |
| 128 | Qualified WhatsApp broadcast key takes precedence over unqualified | docs/channels/broadcast-groups.md "Agent group threads" | ambient | none |
| 129 | Preview and progress drafts disabled for qualified broadcast group threads | docs/channels/broadcast-groups.md "Agent group threads"; docs/concepts/streaming.md ""Stream chunks or everything"" | ambient | channel-broadcast-group |
| 130 | Inbound mentioning some participants selects only them for round one | docs/channels/broadcast-groups.md "Mention selection" | event | channel-broadcast-group, channel-group-allowlisted |
| 131 | Inbound mentioning no participant selects all | docs/channels/broadcast-groups.md "Mention selection" | event | channel-broadcast-group, channel-group-allowlisted |
| 132 | Broadcast mentionGating false selects all participants | docs/channels/broadcast-groups.md "Mention selection" | ambient | config-broadcast-gating-off, channel-broadcast-group |
| 133 | Follow-up round with bounded digest of sibling finals | docs/channels/broadcast-groups.md "Bounded follow-up rounds" | event | channel-broadcast-group, channel-group-allowlisted |
| 134 | All participants pass, broadcast thread ends | docs/channels/broadcast-groups.md "Bounded follow-up rounds" | event | channel-broadcast-group, channel-group-allowlisted |
| 135 | Sibling finals over the digest limits | docs/channels/broadcast-groups.md "Bounded follow-up rounds" | event | channel-broadcast-group |
| 136 | maxRounds or maxTurns reached or cancelled, no further turns | docs/channels/broadcast-groups.md "Bounded follow-up rounds"; docs/channels/bot-loop-protection.md "Internal agent group rounds" | event | channel-broadcast-group, channel-group-allowlisted, channel-paired-sender |
| 137 | Gateway restart during a broadcast round loses round and budget | docs/channels/broadcast-groups.md "Bounded follow-up rounds"; docs/channels/broadcast-groups.md "Limitations"; docs/channels/bot-loop-protection.md "Internal agent group rounds" | event | channel-broadcast-group, channel-group-allowlisted |
| 138 | Broadcast strategy sequential | docs/channels/broadcast-groups.md "Processing strategy" | ambient | channel-broadcast-group |
| 139 | Multi-participant broadcast replies labelled with participant name | docs/channels/broadcast-groups.md "Participant labels" | ambient | channel-broadcast-group |
| 140 | Deleting an agent listed in a broadcast entry prunes it | docs/channels/broadcast-groups.md "Basic setup" | event | channel-broadcast-group, channel-group-allowlisted |
| 141 | Legacy agents.list roster awaiting doctor --fix before broadcast membership resolves | docs/channels/broadcast-groups.md "Basic setup" | ambient | config-legacy-agents-list |
| 142 | WhatsApp audio transcribed once before broadcast fan-out | docs/channels/broadcast-groups.md "Message flow" | event | channel-real-accounts |
| 143 | Broadcast delivery and hooks use the responding participant's session and media roots | docs/channels/broadcast-groups.md "Session isolation" | ambient | channel-broadcast-group |
| 144 | WhatsApp group context buffer shared by broadcast agents and cleared after fan-out | docs/channels/broadcast-groups.md "Session isolation"; docs/channels/broadcast-groups.md "Basic setup" | ambient | none |
| 145 | One broadcast agent fails while others continue | docs/channels/broadcast-groups.md "Best practices" | event | channel-broadcast-group, channel-group-allowlisted |
| 146 | Broadcast entry takes priority over route binding for the same peer | docs/channels/broadcast-groups.md "Routing" | ambient | channel-broadcast-group |
| 147 | Broadcast participants share one account's transport rate limits | docs/channels/broadcast-groups.md "Limitations" | ambient | channel-broadcast-group |
| 148 | Access group defined but referenced by no allowlist grants nothing | docs/channels/access-groups.md "Access groups" | ambient | channel-access-groups |
| 149 | Static access group with shared (*) members | docs/channels/access-groups.md "Static message sender groups" | ambient | config-access-group |
| 150 | Static access group with per-channel members (ids not translated between channels) | docs/channels/access-groups.md "Static message sender groups" | ambient | config-access-group, channel-access-groups |
| 151 | DM allowlist referencing an access group | docs/channels/access-groups.md "Reference groups from allowlists"; docs/channels/pairing.md "Reusable sender groups" | ambient | config-access-group, channel-access-groups |
| 152 | Group sender allowlist referencing an access group | docs/channels/access-groups.md "Reference groups from allowlists"; docs/channels/pairing.md "Reusable sender groups" | ambient | config-access-group, channel-access-groups |
| 153 | Per-room allowlist referencing an access group | docs/channels/access-groups.md "Reference groups from allowlists" | ambient | channel-access-groups |
| 154 | Command authorization reusing an access-group allowlist | docs/channels/access-groups.md "Supported message-channel paths"; docs/channels/access-groups.md "Reference groups from allowlists" | ambient | config-access-group, channel-access-groups |
| 155 | Discord channel-audience access group resolved at authorization time | docs/channels/access-groups.md "Discord channel audiences" | ambient | none |
| 156 | Discord channel-audience lookup failing, fails closed | docs/channels/access-groups.md "Discord channel audiences"; docs/plugins/sdk-channel-ingress.md "Access groups" | event | channel-discord-fixture |
| 157 | dmPolicy open without * in effective DM allowlist | docs/channels/access-groups.md "Security notes"; docs/channels/pairing.md "1) DM pairing (inbound chat access)" | ambient | config-dm-open-no-star, channel-access-groups |
| 158 | Allowlist referencing a missing access group authorizes nobody | docs/channels/access-groups.md "Security notes"; docs/plugins/sdk-channel-ingress.md "Access groups" | ambient | config-access-group-missing, channel-access-groups |
| 159 | Invalid allowlist and policy combination reported by doctor | docs/channels/access-groups.md "Troubleshooting" | ambient | channel-access-groups |
| 160 | room_event set on a channel without ambient support keeps existing group behaviour | docs/channels/ambient-room-events.md "Ambient room events" | ambient | channel-ambient-unsupported |
| 161 | room_event on a still mention-gated room, unmentioned messages never become room events | docs/channels/ambient-room-events.md "Prerequisites" | ambient | channel-group-allowlisted, channel-ambient-room |
| 162 | Ambient room agent without the message tool listens but never speaks | docs/channels/ambient-room-events.md "Prerequisites" | ambient | config-agent-coding-profile, channel-ambient-room |
| 163 | Mention, command, stop or DM in an ambient room still handled as user request | docs/channels/ambient-room-events.md "What changes" | event | channel-group-allowlisted, channel-group-ambient, channel-paired-sender, channel-probe-conversations, channel-ambient-room |
| 164 | Room event final text kept private unless message send | docs/channels/ambient-room-events.md "What changes"; docs/channels/ambient-room-events.md "Visible reply modes"; docs/channels/ambient-room-events.md "Troubleshooting" | ambient | channel-group-ambient, channel-ambient-room |
| 165 | Typing and lifecycle status reactions suppressed for room events | docs/channels/ambient-room-events.md "What changes" | ambient | channel-group-ambient, channel-ambient-room |
| 166 | ackReactionScope all sends ack reaction for room events | docs/channels/ambient-room-events.md "What changes"; docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | config-ack-scope-all, channel-ambient-room |
| 167 | Room allowlist entry with enabled false | docs/channels/ambient-room-events.md "Discord example" | ambient | config-room-entry-disabled, channel-groups-mixed |
| 168 | Slack channel allowlist keyed by name instead of ID never matches | docs/channels/ambient-room-events.md "Slack example" | ambient | none |
| 169 | Agent-level room-event override in a room shared by several agents | docs/channels/ambient-room-events.md "Agent specific policy" | ambient | config-ambient-agent-override, channel-ambient-room |
| 170 | Telegram always-on rolling group history window, room events get full window | docs/channels/ambient-room-events.md "History" | ambient | channel-telegram-shim |
| 171 | Retired Telegram includeGroupHistoryContext key awaiting doctor --fix | docs/channels/ambient-room-events.md "History" | ambient | config-telegram-retired-history-key, config-legacy-route-markers |
| 172 | Slack ambient room without history scope for its room type | docs/channels/ambient-room-events.md "Troubleshooting" | ambient | none |
| 173 | allowBots false: bot messages refused as turns but visible as context | docs/channels/bot-loop-protection.md "Bot loop protection"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | channel-bot-peer |
| 174 | Two bots exchanging slower than the pair budget continue | docs/channels/bot-loop-protection.md "Bot loop protection" | event | channel-bot-peer |
| 175 | Shared botLoopProtection defaults under channels.defaults | docs/channels/bot-loop-protection.md "Configure shared defaults" | ambient | channel-bot-peer |
| 176 | Bot loop protection disabled | docs/channels/bot-loop-protection.md "Configure shared defaults" | ambient | config-bot-loop-disabled, channel-bot-peer |
| 177 | botLoopProtection overridden per room, account or channel, narrowest wins | docs/channels/bot-loop-protection.md "Override per channel, account, or room" | ambient | config-bot-loop-override, channel-bot-peer |
| 178 | Channel without reliable inbound bot identity keeps only self-message and access filters | docs/channels/bot-loop-protection.md "Channel support" | ambient | channel-bot-identity-unknown, channel-probe-conversations |
| 179 | Internal broadcast continuation with distinct identity not suppressed by inbound dedupe | docs/channels/bot-loop-protection.md "Internal agent group rounds" | event | channel-broadcast-group, channel-group-allowlisted |
| 180 | Inbound shared location pin normalized into coordinates and context | docs/channels/location.md "Channel location parsing"; docs/channels/location.md "Text formatting"; docs/channels/location.md "Context fields" | event | channel-telegram-shim |
| 181 | Inbound named place or venue with name, address and caption as untrusted metadata | docs/channels/location.md "Text formatting"; docs/channels/location.md "Context fields"; docs/channels/location.md "Channel notes"; docs/channels/location.md "Channel location parsing" | event | channel-telegram-shim |
| 182 | Inbound live location share | docs/channels/location.md "Text formatting"; docs/channels/location.md "Context fields"; docs/channels/location.md "Channel notes"; docs/channels/location.md "Channel location parsing" | event | channel-telegram-shim |
| 183 | Outbound location payload (pin or venue) sent with message send | docs/channels/location.md "Outbound payloads" | event | channel-telegram-shim |
| 184 | Outbound location mixed with text or media, or incomplete venue pair, fails | docs/channels/location.md "Outbound payloads" | event | channel-telegram-shim |
| 185 | Channel without location parameter support | docs/channels/location.md "Outbound payloads" | ambient | channel-probe-conversations |
| 186 | Unknown sender DMs under dmPolicy pairing, given a code and not processed | docs/channels/pairing.md "1) DM pairing (inbound chat access)" | event | channel-probe-conversations, channel-dm-pairing |
| 187 | dmPolicy open with concrete allowFrom entries admits only those senders | docs/channels/pairing.md "1) DM pairing (inbound chat access)" | ambient | config-dm-open-concrete, channel-dm-pairing |
| 188 | Pairing request expires after one hour | docs/channels/pairing.md "1) DM pairing (inbound chat access)"; docs/gateway/config-channels/shared-policies.md "DM and group access" | event | channel-dm-pairing |
| 189 | Sender with a pending request DMs again, no new pairing message | docs/channels/pairing.md "1) DM pairing (inbound chat access)" | event | channel-pairing-pending, channel-dm-pairing |
| 190 | Three pending pairing requests on one account, further requests ignored | docs/channels/pairing.md "1) DM pairing (inbound chat access)"; docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | channel-pairing-cap, channel-dm-pairing |
| 191 | No command owner configured, approval bootstraps the first owner | docs/channels/pairing.md "Approve from the Control UI"; docs/channels/pairing.md "Approve from the CLI"; docs/channels/pairing.md "Set up an owner without DM pairing"; docs/cli/pairing.md "Owner bootstrap"; docs/gateway/protocol/rpc-system-and-channels.md "Channel DM pairing" | ambient | config-no-command-owner, channel-dm-pairing |
| 192 | Dismissed pairing request sender requests access again | docs/channels/pairing.md "Approve from the Control UI" | event | channel-pairing-pending, channel-dm-pairing |
| 193 | Command owner already configured, later approvals grant DM access only | docs/channels/pairing.md "Approve from the CLI"; docs/channels/pairing.md "Set up an owner without DM pairing" | ambient | channel-paired-sender, channel-dm-pairing |
| 194 | Manually allowlisted non-owner sends an owner-only command | docs/channels/pairing.md "Approve from the CLI" | event | config-dm-policy-allowlist |
| 195 | Pairing requests and approved senders stored per channel and account | docs/channels/pairing.md "Where the state lives" | ambient | channel-paired-sender, channel-dm-pairing |
| 196 | Legacy pairing and allowFrom JSON files not read until doctor --fix imports them | docs/channels/pairing.md "Where the state lives" | ambient | channel-pairing-legacy-files |
| 197 | Connected channel account probe reports works or audit ok | docs/channels/troubleshooting.md "Command ladder" | ambient | channels-test-accounts |
| 198 | Channel plugin failed to load after an update (corrupted dependencies) | docs/channels/troubleshooting.md "After an update"; docs/cli/channels.md "Common commands" | ambient | channel-plugin-deps-corrupt, channel-plugin-broken, channel-plugin-load-broken |
| 199 | WhatsApp connected, no DM replies while sender awaits pairing | docs/channels/troubleshooting.md "WhatsApp failure signatures" | ambient | none |
| 200 | WhatsApp group messages ignored by mention gating | docs/channels/troubleshooting.md "WhatsApp failure signatures" | ambient | none |
| 201 | WhatsApp QR login times out with 408 behind unreachable proxy | docs/channels/troubleshooting.md "WhatsApp failure signatures" | event | none |
| 202 | WhatsApp disconnect and relogin loop flagged as recent reconnects | docs/channels/troubleshooting.md "WhatsApp failure signatures" | event | channel-real-accounts |
| 203 | WhatsApp status=408 request time-out loop | docs/channels/troubleshooting.md "WhatsApp failure signatures" | event | channel-real-accounts |
| 204 | WhatsApp replies late while stale local TUI clients degrade the event loop | docs/channels/troubleshooting.md "WhatsApp failure signatures" | ambient | none |
| 205 | Telegram /start with no usable reply flow while pairing pending | docs/channels/troubleshooting.md "Telegram failure signatures" | event | channel-telegram-shim, channel-dm-pairing |
| 206 | Telegram group silent under mention requirement or privacy mode | docs/channels/troubleshooting.md "Telegram failure signatures" | ambient | channel-telegram-shim |
| 207 | Telegram send failures with network errors to the Bot API | docs/channels/troubleshooting.md "Telegram failure signatures" | event | channel-telegram-shim |
| 208 | Telegram getMe 401 at startup for bad token | docs/channels/troubleshooting.md "Telegram failure signatures" | event | none |
| 209 | Telegram polling stalls or slow reconnects | docs/channels/troubleshooting.md "Telegram failure signatures" | event | channel-telegram-shim |
| 210 | Telegram setMyCommands rejected with BOT_COMMANDS_TOO_MUCH | docs/channels/troubleshooting.md "Telegram failure signatures" | event | none |
| 211 | Telegram @username allowlist blocking owner after upgrade | docs/channels/troubleshooting.md "Telegram failure signatures" | ambient | config-telegram-username-allow |
| 212 | Discord bot online but no guild replies (not allowed or no content intent) | docs/channels/troubleshooting.md "Discord failure signatures" | ambient | channel-discord-fixture |
| 213 | Discord group messages dropped by mention gating | docs/channels/troubleshooting.md "Discord failure signatures" | ambient | channel-discord-fixture |
| 214 | Discord typing or token usage with no message (room event or missed message tool) | docs/channels/troubleshooting.md "Discord failure signatures" | event | channel-discord-fixture |
| 215 | Discord DM replies missing while sender awaits pairing | docs/channels/troubleshooting.md "Discord failure signatures" | ambient | channel-discord-fixture |
| 216 | Discord guild entry that gained a channels map denies unlisted channels | docs/channels/troubleshooting.md "Discord failure signatures" | ambient | channel-discord-fixture |
| 217 | Discord room history and other bots' attachments unseen under requireMention or without allowBots | docs/channels/troubleshooting.md "Discord failure signatures" | ambient | channel-discord-fixture |
| 218 | Discord ambient-room agent without message tool never posts | docs/channels/troubleshooting.md "Discord failure signatures" | ambient | channel-discord-fixture |
| 219 | Slack socket mode connected but no responses (tokens, scopes, configured_unavailable) | docs/channels/troubleshooting.md "Slack failure signatures" | ambient | none |
| 220 | Slack DMs blocked pending pairing | docs/channels/troubleshooting.md "Slack failure signatures" | ambient | none |
| 221 | Slack channel message ignored by groupPolicy or channel allowlist | docs/channels/troubleshooting.md "Slack failure signatures" | ambient | none |
| 222 | iMessage imsg missing or non-macOS host | docs/channels/troubleshooting.md "iMessage failure signatures" | ambient | none |
| 223 | iMessage sends but cannot receive without automation permission | docs/channels/troubleshooting.md "iMessage failure signatures" | ambient | none |
| 224 | iMessage DM sender blocked pending pairing | docs/channels/troubleshooting.md "iMessage failure signatures" | ambient | none |
| 225 | Signal daemon reachable but bot silent | docs/channels/troubleshooting.md "Signal failure signatures" | ambient | none |
| 226 | Signal DM blocked pending pairing | docs/channels/troubleshooting.md "Signal failure signatures" | ambient | none |
| 227 | Signal group replies not triggering under group allowlist or mention patterns | docs/channels/troubleshooting.md "Signal failure signatures" | ambient | none |
| 228 | QQ Bot wrong appId or clientSecret replies gone to Mars | docs/channels/troubleshooting.md "QQ Bot failure signatures" | ambient | none |
| 229 | QQ Bot receives no inbound messages | docs/channels/troubleshooting.md "QQ Bot failure signatures" | ambient | none |
| 230 | QQ Bot voice not transcribed without STT provider | docs/channels/troubleshooting.md "QQ Bot failure signatures" | ambient | none |
| 231 | QQ Bot proactive messages blocked without recent interaction | docs/channels/troubleshooting.md "QQ Bot failure signatures" | ambient | none |
| 232 | Matrix room messages ignored by policy, allowlist or mention gating | docs/channels/troubleshooting.md "Matrix failure signatures" | ambient | none |
| 233 | Matrix DMs not processed pending pairing | docs/channels/troubleshooting.md "Matrix failure signatures" | ambient | none |
| 234 | Matrix encrypted rooms failing on unverified device | docs/channels/troubleshooting.md "Matrix failure signatures" | ambient | none |
| 235 | Matrix key backup restore pending or broken | docs/channels/troubleshooting.md "Matrix failure signatures" | ambient | none |
| 236 | Matrix cross-signing or bootstrap state wrong | docs/channels/troubleshooting.md "Matrix failure signatures" | ambient | none |
| 237 | Crash-loop breaker suppresses channel auto-start after repeated unclean boots | docs/channels/troubleshooting.md "Gateway up but channel never connects"; docs/gateway/protocol/rpc-system-and-channels.md "Channels and login helpers"; docs/gateway/restart-recovery.md "Safety valves and observability" | ambient | channel-probe-conversations |
| 238 | Unclean-boot window drains, deferred channel auto-start resumes | docs/channels/troubleshooting.md "Gateway up but channel never connects"; docs/gateway/restart-recovery.md "Safety valves and observability" | event | channel-probe-conversations |
| 239 | Bundled channels without an account and catalog channels not on disk | docs/cli/channels.md "Common commands" | ambient | channels-test-accounts |
| 240 | Disabled channel plugin stays installed in inventory | docs/cli/channels.md "Common commands" | ambient | config-channel-plugin-disabled, channel-plugin-load-broken |
| 241 | Explicit multi-agent fleet without a System Agent owner, no plugin discovery workspace | docs/cli/channels.md "Common commands"; docs/cli/message.md "Agent ownership" | ambient | agents-three-configured, channel-accounts-multiple |
| 242 | Workspace-scoped channel plugin discovered through the selected agent's workspace | docs/cli/channels.md "Common commands" | ambient | channel-workspace-plugin |
| 243 | Installed channel plugin with untracked or inconsistent provenance omits docsPath | docs/cli/channels.md "Common commands" | ambient | channel-plugin-untracked, channel-plugin-load-broken |
| 244 | Unknown configuration and stale connections kept in recorded channel status | docs/cli/channels.md "Status / capabilities / resolve / logs" | ambient | channels-test-accounts |
| 245 | Channel probe exceeding per-channel deadline returns recorded state with warning | docs/cli/channels.md "Status / capabilities / resolve / logs" | event | channel-probe-conversations |
| 246 | Gateway unreachable, channel status falls back to config-only summary | docs/cli/channels.md "Status / capabilities / resolve / logs"; docs/cli/channels.md "Troubleshooting"; docs/cli/message.md "Channel selection" | ambient | channels-test-accounts |
| 247 | Channel status during Gateway startup reported as starting | docs/cli/channels.md "Status / capabilities / resolve / logs" | event | channels-test-accounts |
| 248 | Inbound event exhausting retry policy retained as dead letter | docs/cli/channels.md "Inbound dead letters" | event | channel-ingress-aged-pending, channel-ingress-dead-letters, channel-probe-conversations |
| 249 | Dead letter resubmitted while pending or claimed refused | docs/cli/channels.md "Inbound dead letters" | event | channel-ingress-dead-letters, channel-probe-conversations |
| 250 | Completed inbound event not resubmittable | docs/cli/channels.md "Inbound dead letters" | ambient | channel-ingress-dead-letters, channel-probe-conversations |
| 251 | Dead-letter rows from before payload retention listed but not resubmittable | docs/cli/channels.md "Inbound dead letters" | ambient | channel-dead-letters-legacy, channel-ingress-dead-letters |
| 252 | Connected quiet account after provider restart has no session row | docs/cli/channels.md "Inbound dead letters" | ambient | channel-discord-fixture, channels-test-accounts |
| 253 | Removing or disabling an account while its listener runs stops the listener first | docs/cli/channels.md "Add / remove accounts" | event | channel-telegram-shim, channels-test-accounts |
| 254 | Third-party channel plugin on the legacy shared setup adapter | docs/cli/channels.md "Add / remove accounts" | ambient | none |
| 255 | Guided channels add in a non-TTY shell exits immediately | docs/cli/channels.md "Add / remove accounts" | event | none |
| 256 | Non-default account added to single-account top-level config promotes values | docs/cli/channels.md "Add / remove accounts"; docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)" | event | channel-single-account-toplevel, channels-test-accounts |
| 257 | Mixed named-account and top-level config awaiting doctor --fix | docs/cli/channels.md "Add / remove accounts"; docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)" | ambient | config-mixed-account, config-legacy-route-markers |
| 258 | Channel-only binding without accountId matches the default account | docs/cli/channels.md "Add / remove accounts"; docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)" | ambient | config-bindings-tiers |
| 259 | CLI state or config path differs from the local Gateway service, login or add refuse to write | docs/cli/channels.md "Login and logout (interactive)" | ambient | cli-profile-mismatched |
| 260 | Remote-mode Gateway: login saves auth locally | docs/cli/channels.md "Login and logout (interactive)" | ambient | config-gateway-remote |
| 261 | Remote-mode Gateway: logout fails on a Gateway error | docs/cli/channels.md "Login and logout (interactive)" | event | config-gateway-remote, channels-test-accounts |
| 262 | Logout while local Gateway unreachable falls back to local auth cleanup | docs/cli/channels.md "Login and logout (interactive)" | event | channel-telegram-shim, channels-test-accounts |
| 263 | Logout of an account with no credentials leaves config unrewritten | docs/cli/channels.md "Login and logout (interactive)" | event | channel-probe-conversations, channels-test-accounts |
| 264 | Login while another lifecycle operation owns the account, start skipped | docs/cli/channels.md "Login and logout (interactive)" | event | channel-real-accounts |
| 265 | Interactive channel login from agent exec blocked | docs/cli/channels.md "Login and logout (interactive)" | event | channels-test-accounts |
| 266 | Explicitly started account absent from static account list shown while owned | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | channel-account-unlisted, channel-probe-conversations |
| 267 | Host thaw after maintenance gap triggers channel recovery, retries expire after ten minutes | docs/cli/channels.md "Per-account recovery (non-destructive)"; docs/gateway/restart-recovery.md "Host sleep and process freezes" | event | channels-test-accounts |
| 268 | Host thaw while CPU-busy skips thaw recovery | docs/cli/channels.md "Per-account recovery (non-destructive)"; docs/gateway/restart-recovery.md "Host sleep and process freezes" | event | channels-test-accounts |
| 269 | Start or stop while another task owns the account returns retry | docs/cli/channels.md "Per-account recovery (non-destructive)" | event | channels-test-accounts |
| 270 | Disabled channel account skipped without resolving credentials | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | config-channel-account-disabled, channel-accounts-multiple |
| 271 | Unconfigured or unlinked channel account skipped at start | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | config-channel-account-unconfigured, channel-accounts-multiple |
| 272 | Unsupported channel account skipped at start | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | channel-accounts-multiple |
| 273 | Enabled account with unavailable configured secret, start returns an error | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | config-channel-secret-missing, channel-accounts-multiple |
| 274 | SecretRef credential unavailable in the command path reported as degraded | docs/cli/channels.md "Troubleshooting"; docs/cli/channels.md "Resolve names to IDs"; docs/cli/message.md "SecretRef resolution"; docs/gateway/config-channels/workplace-chat.md "Slack"; docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | config-channel-secret-missing, channel-accounts-multiple |
| 275 | Manually stopped account suppresses automatic start | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | channel-account-stopped, channel-accounts-multiple |
| 276 | Automatic start suppressed (autostart-suppressed) | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | channel-accounts-multiple |
| 277 | Automatic start suppressed (ambient-suppressed) | docs/cli/channels.md "Per-account recovery (non-destructive)" | ambient | channel-accounts-multiple |
| 278 | Stalled capability check step reported while other accounts continue | docs/cli/channels.md "Capabilities check" | event | channel-probe-conversations |
| 279 | Channel without live capability checks reports check unavailable | docs/cli/channels.md "Capabilities check" | ambient | channels-test-accounts |
| 280 | Several directory entries sharing one name, active match preferred | docs/cli/channels.md "Resolve names to IDs" | ambient | channel-discord-fixture |
| 281 | Exactly one channel configured, selected by default for message actions | docs/cli/message.md "Channel selection" | ambient | channels-test-accounts |
| 282 | Gateway-owned message action while the Gateway is unreachable fails | docs/cli/message.md "Channel selection" | event | channels-test-accounts |
| 283 | Target name missing from directory cache resolved by live lookup | docs/cli/message.md "Target formats (-t, --target)" | event | channel-discord-fixture |
| 284 | Local message action runs plugin shutdown hooks within 2.5-second budget | docs/cli/message.md "Common flags" | event | channel-probe-conversations, channels-test-accounts |
| 285 | Plugin disposal pending at exit defers state database drain | docs/cli/message.md "Common flags" | event | channel-probe-conversations, channels-test-accounts |
| 286 | Unresolved SecretRef on an unrelated channel does not block a targeted action | docs/cli/message.md "SecretRef resolution" | ambient | config-channel-secret-missing, channel-accounts-multiple |
| 287 | Unresolved SecretRef on the selected channel fails closed | docs/cli/message.md "SecretRef resolution" | ambient | channel-accounts-multiple |
| 288 | Send suppressed by a message hook, nonzero exit | docs/cli/message.md "Send"; docs/tools/agent-send.md "Behavior" | event | plugin-message-hooks |
| 289 | Consecutive photos to Telegram grouped into an album | docs/cli/message.md "Send" | event | channel-telegram-shim |
| 290 | Presentation chart and table blocks without native support sent as text | docs/cli/message.md "Send"; docs/plugins/message-presentation.md "Core render flow"; docs/plugins/message-presentation.md "Contract" | ambient | channel-interactive-message, channel-probe-conversations |
| 291 | Telegram Mini App buttons rendered only in private chats | docs/cli/message.md "Send" | ambient | channel-interactive-message |
| 292 | Broadcast send where a target fails, is suppressed or partially delivers | docs/cli/message.md "Broadcast" | event | channel-group-allowlisted, channel-probe-conversations, channel-accounts-multiple |
| 293 | Directory listing with no entries names the channel and account | docs/cli/directory.md "Common flags"; docs/cli/directory.md "Notes" | ambient | channel-probe-conversations, channel-groups-mixed |
| 294 | Directory results backed by config allowlists and groups | docs/cli/directory.md "Notes" | ambient | channel-group-allowlisted, channel-groups-mixed |
| 295 | WhatsApp live group listing while another process owns the session | docs/cli/directory.md "Notes" | ambient | none |
| 296 | Installed channel plugin without directory support | docs/cli/directory.md "Notes" | ambient | channel-probe-conversations |
| 297 | Channel without a self resolver reports self-identity-unsupported | docs/cli/directory.md "Self ("me")" | ambient | channel-telegram-shim |
| 298 | Self lookup returns no identity | docs/cli/directory.md "Self ("me")" | ambient | channel-discord-fixture |
| 299 | No Gateway owns the state directory, pairing commands take offline ownership | docs/cli/pairing.md "openclaw pairing" | ambient | channel-dm-pairing |
| 300 | Listing pairing requests prunes expired or excess requests | docs/cli/pairing.md "openclaw pairing"; docs/gateway/protocol/rpc-system-and-channels.md "Channel DM pairing" | event | none |
| 301 | Pairing RPC to older Gateway, missing credentials, refusal or uncertain reply, no local fallback | docs/cli/pairing.md "openclaw pairing"; docs/gateway/protocol/rpc-system-and-channels.md "Channel DM pairing" | event | channel-pairing-pending, channel-dm-pairing |
| 302 | Senders approved before first-owner bootstrap with no command owner, doctor warns | docs/cli/pairing.md "Owner bootstrap" | ambient | channel-paired-before-bootstrap |
| 303 | Channel redelivers a message after reconnect, deduplicated | docs/concepts/messages.md "Inbound dedupe" | event | channel-telegram-shim, channel-probe-conversations |
| 304 | Inbound dedupe cache entry expired or evicted | docs/concepts/messages.md "Inbound dedupe" | event | channel-probe-conversations |
| 305 | Rapid text messages from one sender batched into one turn | docs/concepts/messages.md "Inbound debouncing"; docs/gateway/config-agents/messages-and-talk.md "Inbound debounce" | event | config-inbound-debounce, channel-debounce |
| 306 | Media or attachment in a burst flushes debounce immediately | docs/concepts/messages.md "Inbound debouncing"; docs/gateway/config-agents/messages-and-talk.md "Inbound debounce" | event | channel-probe-conversations, config-inbound-debounce, channel-debounce |
| 307 | Control command bypasses debounce | docs/concepts/messages.md "Inbound debouncing"; docs/gateway/config-agents/messages-and-talk.md "Inbound debounce" | event | config-inbound-debounce, channel-debounce |
| 308 | Telegram default 300 ms quiet window | docs/concepts/messages.md "Inbound debouncing"; docs/gateway/config-agents/messages-and-talk.md "Inbound debounce" | ambient | channel-telegram-shim, channel-debounce |
| 309 | Inbound debounce disabled per channel | docs/concepts/messages.md "Inbound debouncing"; docs/gateway/config-agents/messages-and-talk.md "Inbound debounce" | ambient | config-debounce-off, channel-debounce |
| 310 | Telegram long paste assembled from continuations within 1.5 seconds | docs/concepts/messages.md "Inbound debouncing"; docs/gateway/config-agents/messages-and-talk.md "Inbound debounce" | event | channel-telegram-shim, mock-provider-long-reply |
| 311 | Debounce settings changed while a batch is pending | docs/concepts/messages.md "Inbound debouncing" | event | config-channel-patches, config-inbound-debounce, channel-debounce |
| 312 | Structured history, reply, forwarded and channel metadata rendered as untrusted context | docs/concepts/messages.md "Prompt bodies and history context" | ambient | channel-group-history |
| 313 | Inbound message while a run is active, steered or queued | docs/concepts/messages.md "Queueing and followups"; docs/gateway/config-agents/messages-and-talk.md "Queue" | event | channel-plugin-binding, mock-provider-held-turn, channel-probe-conversations |
| 314 | Durably accepted turn fails before its answer, one compact error reply | docs/concepts/messages.md "Channel run ownership" | event | channel-probe-conversations, mock-provider-failing |
| 315 | Block streaming enabled on a channel | docs/concepts/messages.md "Streaming, chunking, and batching"; docs/concepts/streaming.md "Streaming and chunking" | ambient | config-block-streaming, channel-streaming-modes |
| 316 | Reply longer than the text limit chunked without splitting fenced code | docs/concepts/messages.md "Streaming, chunking, and batching"; docs/concepts/streaming.md "Block streaming (channel messages)"; docs/concepts/streaming.md "Chunking algorithm (low/high bounds)" | event | channel-telegram-shim, mock-provider-long-reply, channel-probe-conversations |
| 317 | Human-like delay between block replies | docs/concepts/messages.md "Streaming, chunking, and batching"; docs/concepts/streaming.md "Human-like pacing between blocks" | ambient | config-human-delay, channel-streaming-modes |
| 318 | Stale flat streaming keys awaiting doctor --fix | docs/concepts/messages.md "Streaming, chunking, and batching"; docs/concepts/streaming.md "Block streaming (channel messages)"; docs/concepts/streaming.md "Legacy key migration"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | config-streaming-flat-keys, config-streaming-legacy-keys, config-legacy-route-markers |
| 319 | QQ Bot block replies streaming unless its streaming mode is off | docs/concepts/messages.md "Streaming, chunking, and batching" | ambient | none |
| 320 | Telegram reasoning streamed into a transient draft bubble | docs/concepts/messages.md "Reasoning visibility and tokens"; docs/concepts/streaming.md "Telegram" | ambient | config-telegram-reasoning-stream |
| 321 | Per-channel or per-account responsePrefix | docs/concepts/messages.md "Prefixes, threading, and replies"; docs/gateway/config-agents/messages-and-talk.md "Response prefix" | ambient | config-response-prefix |
| 322 | Response prefix with unresolved model placeholders omitted from message tool and CLI sends | docs/concepts/messages.md "Prefixes, threading, and replies" | event | channel-probe-conversations, config-response-prefix |
| 323 | Explicit send already carrying the prefix not duplicated | docs/concepts/messages.md "Prefixes, threading, and replies" | event | config-response-prefix |
| 324 | Reply threading per replyToMode | docs/concepts/messages.md "Prefixes, threading, and replies" | ambient | channels-test-accounts, channel-groups-mixed |
| 325 | NO_REPLY token in a channel session never delivered as text | docs/concepts/messages.md "Silent replies" | event | channel-group-allowlisted, config-silent-group-allow, mock-provider-no-reply |
| 326 | Silent reply with pending tool media delivers media only | docs/concepts/messages.md "Silent replies" | event | channel-probe-conversations, mock-provider-media-reply |
| 327 | Required answer left undelivered needs recovery | docs/concepts/messages.md "Silent replies" | event | channel-telegram-shim, channel-probe-conversations |
| 328 | Retired internal silentReply setting removed by doctor | docs/concepts/messages.md "Silent replies" | ambient | config-legacy-route-markers |
| 329 | Generic runner failure on an optional turn stays quiet | docs/concepts/messages.md "Silent replies" | event | channel-group-allowlisted, config-silent-group-allow, mock-provider-failing, channel-groups-mixed |
| 330 | Classified provider failure notice delivered to the chat | docs/concepts/messages.md "Silent replies" | event | channel-probe-conversations, mock-provider-failing |
| 331 | Delivery already confirmed or owned when reply recovery runs, no duplicate | docs/concepts/messages.md "Silent replies" | event | channel-probe-conversations |
| 332 | Preview streaming active, temporary preview edited while reply generates | docs/concepts/streaming.md "Streaming and chunking" | ambient | channel-telegram-shim |
| 333 | Block streaming flushing on each text_end | docs/concepts/streaming.md "Block streaming (channel messages)" | ambient | config-block-streaming |
| 334 | Block streaming flushing at message_end | docs/concepts/streaming.md "Block streaming (channel messages)" | ambient | config-block-streaming, channel-streaming-modes |
| 335 | Newline chunk mode, paragraph boundaries | docs/concepts/streaming.md "Block streaming (channel messages)" | ambient | config-chunk-newline, channel-streaming-modes |
| 336 | Discord reply taller than maxLinesPerMessage split | docs/concepts/streaming.md "Block streaming (channel messages)"; docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture, mock-provider-long-reply |
| 337 | before_agent_finalize hook deferring replies, later answer supersedes | docs/concepts/streaming.md "Media delivery with block streaming" | event | mock-provider-tool-calls, plugin-message-hooks |
| 338 | Media-bearing assistant message with block streaming off sent at boundary with caption | docs/concepts/streaming.md "Media delivery with block streaming" | event | channel-probe-conversations |
| 339 | Media streamed early and repeated in final delivered once | docs/concepts/streaming.md "Media delivery with block streaming" | event | config-block-streaming, mock-provider-media-reply, channel-streaming-modes |
| 340 | Exact duplicate final payload suppressed | docs/concepts/streaming.md "Media delivery with block streaming" | event | channel-probe-conversations, mock-provider-media-reply, channel-streaming-modes |
| 341 | Several steered inputs in one run each get their own answer | docs/concepts/streaming.md "Media delivery with block streaming" | event | channel-probe-conversations, mock-provider-held-turn |
| 342 | Fenced code block forced to split, closed and reopened | docs/concepts/streaming.md "Chunking algorithm (low/high bounds)" | event | config-block-streaming, mock-provider-long-reply, channel-probe-conversations |
| 343 | Markdown table kept in one chunk when it fits, else split at rows | docs/concepts/streaming.md "Chunking algorithm (low/high bounds)" | event | config-block-streaming, mock-provider-long-reply, channel-streaming-modes |
| 344 | Block chunks coalesced on idle gaps | docs/concepts/streaming.md "Coalescing (merge streamed blocks)" | ambient | config-block-streaming, channel-streaming-modes |
| 345 | Block streaming off (default), final replies only | docs/concepts/streaming.md ""Stream chunks or everything"" | ambient | config-streaming-mode |
| 346 | Explicit Discord or Telegram preview mode over inherited block default | docs/concepts/streaming.md ""Stream chunks or everything"" | ambient | config-preview-over-block, channel-streaming-modes |
| 347 | Reply-modifying hook prevents Telegram previews, blocks use hooked delivery | docs/concepts/streaming.md ""Stream chunks or everything"" | event | mock-provider-tool-calls, plugin-message-hooks |
| 348 | Preview streaming off | docs/concepts/streaming.md "Preview streaming modes"; docs/concepts/progress-drafts.md "Choose a mode" | ambient | config-streaming-mode, channel-streaming-modes |
| 349 | Telegram streaming off: final-only with progress chatter suppressed | docs/concepts/streaming.md "Tool-progress preview updates"; docs/concepts/streaming.md "Preview streaming modes" | ambient | config-streaming-mode, channel-streaming-modes |
| 350 | Preview streaming partial | docs/concepts/streaming.md "Preview streaming modes"; docs/concepts/progress-drafts.md "Choose a mode" | ambient | config-streaming-mode, channel-streaming-modes |
| 351 | Preview streaming block | docs/concepts/streaming.md "Preview streaming modes"; docs/concepts/progress-drafts.md "Choose a mode" | ambient | config-streaming-mode, channel-streaming-modes |
| 352 | Preview streaming progress | docs/concepts/streaming.md "Preview streaming modes"; docs/concepts/streaming.md "Channel mapping"; docs/concepts/progress-drafts.md "Progress drafts"; docs/concepts/progress-drafts.md "Choose a mode" | ambient | channel-telegram-shim, channel-streaming-modes |
| 353 | Microsoft Teams or Mattermost block mode, rotating posts without native preview | docs/concepts/streaming.md "Preview streaming modes" | ambient | none |
| 354 | Slack native streaming transport in partial mode | docs/concepts/streaming.md "Channel mapping" | ambient | none |
| 355 | Slack top-level DMs without a reply thread show no thread-style preview | docs/concepts/streaming.md "Channel mapping" | ambient | none |
| 356 | Slack native agent card in reply threads during progress | docs/concepts/streaming.md "Slack" | ambient | none |
| 357 | Slack failed turn keeps card marked Failed | docs/concepts/streaming.md "Slack" | event | channel-real-accounts, mock-provider-failing |
| 358 | Slack cards link to OpenClaw only with publicOrigin | docs/concepts/streaming.md "Slack" | ambient | none |
| 359 | Slack top-level progress turns use a typing reaction instead of preview | docs/concepts/streaming.md "Slack"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 360 | Short initial Telegram preview debounced then materialized | docs/concepts/streaming.md "Telegram" | event | config-streaming-mode, mock-provider-held-turn |
| 361 | Long Telegram final reuses preview for first chunk | docs/concepts/streaming.md "Telegram" | event | config-streaming-mode, mock-provider-long-reply |
| 362 | Progress draft keeps updating while parent yields to sub-agents | docs/concepts/streaming.md "Telegram"; docs/concepts/progress-drafts.md "Finalization"; docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership" | event | channel-telegram-shim, mock-provider-tool-calls |
| 363 | Telegram plan previews as native checkboxes (richMessages) | docs/concepts/streaming.md "Telegram"; docs/plugins/message-presentation.md "Renderer contract" | ambient | config-telegram-rich-messages |
| 364 | Final preview edit failing falls back to normal delivery and cleans preview | docs/concepts/streaming.md "Telegram"; docs/concepts/progress-drafts.md "Finalization" | event | config-streaming-mode, mock-provider-held-turn, mock-provider-long-reply |
| 365 | Preview streaming skipped because block streaming explicitly enabled | docs/concepts/streaming.md "Telegram"; docs/concepts/streaming.md "Discord"; docs/concepts/streaming.md ""Stream chunks or everything"" | ambient | config-block-streaming, channel-streaming-modes |
| 366 | Telegram selected-quote reply skips the answer preview | docs/concepts/streaming.md "Telegram"; docs/concepts/progress-drafts.md "Troubleshooting" | event | channel-telegram-shim |
| 367 | Progress draft with rolling tool log (progress.toolProgress) | docs/concepts/streaming.md "Discord"; docs/concepts/progress-drafts.md "Progress drafts"; docs/concepts/progress-drafts.md "Show the tool log"; docs/concepts/streaming.md "Tool-progress preview updates" | ambient | config-streaming-mode, channel-streaming-modes |
| 368 | Error final keeps progress draft as the failed-turn record | docs/concepts/streaming.md "Discord"; docs/concepts/progress-drafts.md "Finalization"; docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership" | event | channel-discord-fixture, mock-provider-failing |
| 369 | Final media, error or explicit-reply payload cancels pending previews | docs/concepts/streaming.md "Discord"; docs/concepts/progress-drafts.md "Finalization" | event | channel-discord-fixture, mock-provider-media-reply, config-streaming-mode, mock-provider-long-reply, channel-streaming-modes |
| 370 | Mattermost preview deleted before finalize, fresh final post | docs/concepts/streaming.md "Mattermost" | event | channel-real-accounts, mock-provider-held-turn |
| 371 | Matrix media-only, error or reply-target-mismatch final redacts stale preview | docs/concepts/streaming.md "Matrix"; docs/concepts/streaming.md "Mattermost" | event | channel-real-accounts, mock-provider-media-reply |
| 372 | Tool-progress lines streamed into the live preview | docs/concepts/streaming.md "Tool-progress preview updates" | ambient | mock-provider-tool-calls, channel-streaming-modes |
| 373 | Long-running tool emits typed progress before returning | docs/concepts/streaming.md "Tool-progress preview updates"; docs/concepts/progress-drafts.md "Control progress lines" | event | channel-telegram-shim, mock-provider-tool-calls, channel-streaming-modes |
| 374 | Command text shown raw in progress lines | docs/concepts/streaming.md "Tool-progress preview updates"; docs/concepts/progress-drafts.md "Command/exec text" | ambient | config-command-text-raw, channel-streaming-modes |
| 375 | Progress card replacing plan state in a channel draft | docs/concepts/streaming.md "Progress draft rendering" | ambient | session-progress-card |
| 376 | Progress card cleared, checklist removed and empty draft deleted | docs/concepts/streaming.md "Progress draft rendering" | event | channel-telegram-shim, mock-provider-tool-calls, channel-streaming-modes |
| 377 | Failed or blocked draft write leaves previous plan | docs/concepts/streaming.md "Progress draft rendering" | event | channel-telegram-shim, mock-provider-tool-calls, channel-streaming-modes |
| 378 | Progress draft line limits configured (maxLines, maxLineChars) | docs/concepts/progress-drafts.md "Line limits"; docs/concepts/streaming.md "Progress draft rendering" | ambient | config-streaming-mode, mock-provider-tool-calls, channel-streaming-modes |
| 379 | Commentary progress lane renders pre-tool narration | docs/concepts/streaming.md "Commentary progress lane"; docs/concepts/progress-drafts.md "Commentary lane"; docs/concepts/streaming.md "Progress draft rendering" | ambient | config-progress-commentary, channel-streaming-modes |
| 380 | Standalone tool-progress messages suppressed while a progress draft is active | docs/concepts/progress-drafts.md "Quick start"; docs/concepts/progress-drafts.md "Show the tool log" | ambient | channel-telegram-shim |
| 381 | Short or text-only turn shows no progress draft before start delay | docs/concepts/progress-drafts.md "Quick start"; docs/concepts/progress-drafts.md "What users see"; docs/concepts/progress-drafts.md "Progress drafts" | event | channel-telegram-shim, channel-streaming-modes |
| 382 | Custom, pooled or hidden progress label | docs/concepts/progress-drafts.md "Configure labels"; docs/concepts/streaming.md "Progress draft rendering" | ambient | config-progress-label, channel-streaming-modes |
| 383 | Late completion for an older operation cannot replace current status | docs/concepts/progress-drafts.md "Control progress lines" | event | channel-telegram-shim, mock-provider-tool-calls |
| 384 | Tool progress detail mode raw | docs/concepts/progress-drafts.md "Detail mode" | ambient | config-tool-detail-raw, channel-streaming-modes |
| 385 | Model preamble used as progress status headline | docs/concepts/progress-drafts.md "Status headline" | ambient | mock-provider-tool-calls |
| 386 | Utility-model filler headline after about 20 seconds quiet on Discord | docs/concepts/progress-drafts.md "Status headline" | event | channel-discord-fixture, mock-provider-held-turn |
| 387 | No utility model or narration off, no filler headline | docs/concepts/progress-drafts.md "Status headline" | ambient | channel-streaming-modes |
| 388 | Turn ended or replaced while narration request pending, cancelled | docs/concepts/progress-drafts.md "Status headline" | event | channel-discord-fixture, channel-paired-sender, mock-provider-held-turn |
| 389 | Telegram message landing between progress draft and answer, draft reposted below | docs/concepts/progress-drafts.md "Channel behavior" | event | channel-telegram-shim, mock-provider-tool-calls |
| 390 | Channel without safe edit support falls back to typing or final-only | docs/concepts/progress-drafts.md "Channel behavior" | ambient | channel-probe-conversations |
| 391 | Partial or block draft finalized in place as the answer | docs/concepts/progress-drafts.md "Finalization"; docs/concepts/streaming.md "Preview streaming modes" | event | config-streaming-mode, channel-streaming-modes |
| 392 | Final answer with too many chunks sent through normal delivery | docs/concepts/progress-drafts.md "Finalization" | event | config-streaming-mode, mock-provider-long-reply, channel-streaming-modes |
| 393 | Final answer with an approval prompt sent through normal delivery | docs/concepts/progress-drafts.md "Finalization" | event | channel-streaming-modes |
| 394 | Old Telegram draft that cannot be edited, final sent fresh | docs/concepts/progress-drafts.md "Troubleshooting"; docs/concepts/progress-drafts.md "Finalization" | event | config-streaming-mode, mock-provider-held-turn, channel-streaming-modes |
| 395 | Typing refreshed on keepalive cadence while a run is active | docs/concepts/typing-indicators.md "Typing indicators"; docs/concepts/typing-indicators.md "Notes" | ambient | mock-provider-held-turn, channel-typing-modes |
| 396 | Typing starts when the model loop begins in a direct chat | docs/concepts/typing-indicators.md "Defaults" | event | channel-telegram-shim, mock-provider-held-turn, channel-typing-modes |
| 397 | Typing starts immediately for a mentioned group message | docs/concepts/typing-indicators.md "Defaults" | event | channel-telegram-shim, channel-typing-modes |
| 398 | Unmentioned group run typing waits for user-visible activity | docs/concepts/typing-indicators.md "Defaults" | event | channel-group-allowlisted, channel-group-always-on, channel-groups-mixed |
| 399 | Heartbeat run on typing-capable target shows typing at start | docs/concepts/typing-indicators.md "Defaults" | event | config-heartbeat-short |
| 400 | Heartbeat target none, unresolved, delivery-disabled or non-typing shows no typing | docs/concepts/typing-indicators.md "Notes"; docs/concepts/typing-indicators.md "Defaults" | ambient | config-heartbeat-no-target, config-heartbeat-short |
| 401 | typingMode never | docs/concepts/typing-indicators.md "Modes" | ambient | config-typing-mode, channel-typing-modes |
| 402 | typingMode instant, typing even for silent-token run | docs/concepts/typing-indicators.md "Modes" | ambient | config-typing-mode, channel-typing-modes |
| 403 | typingMode thinking | docs/concepts/typing-indicators.md "Modes" | ambient | config-typing-mode, channel-typing-modes |
| 404 | typingMode message | docs/concepts/typing-indicators.md "Modes" | ambient | config-typing-mode, channel-typing-modes |
| 405 | Per-agent typingMode override | docs/concepts/typing-indicators.md "Configuration" | ambient | config-typing-agent-override |
| 406 | Reply with Markdown styles rendered into each channel's native markup | docs/concepts/markdown-formatting.md "Markdown formatting"; docs/concepts/markdown-formatting.md "Pipeline" | event | channel-discord-fixture, channel-telegram-shim, mock-provider-markdown-reply |
| 407 | Reply containing raw inline HTML kept or escaped per renderer | docs/concepts/markdown-formatting.md "Pipeline" | event | channel-telegram-shim, mock-provider-markdown-reply, channel-probe-conversations |
| 408 | Markdown links rewritten per channel link policy | docs/concepts/markdown-formatting.md "Link policy"; docs/concepts/markdown-formatting.md "Pipeline" | event | channel-discord-fixture, channel-telegram-shim, mock-provider-markdown-reply |
| 409 | markdown.tables code | docs/concepts/markdown-formatting.md "Table handling" | ambient | mock-provider-markdown-reply, channel-markdown-tables |
| 410 | markdown.tables bullets | docs/concepts/markdown-formatting.md "Table handling" | ambient | config-tables-bullets, channel-markdown-tables |
| 411 | markdown.tables block | docs/concepts/markdown-formatting.md "Table handling" | ambient | config-tables-block, channel-markdown-tables |
| 412 | markdown.tables off | docs/concepts/markdown-formatting.md "Table handling" | ambient | config-tables-off, channel-markdown-tables |
| 413 | Chunk boundary inside a styled span, style reopened | docs/concepts/markdown-formatting.md "Chunking rules" | event | channel-telegram-shim, mock-provider-long-reply |
| 414 | Spoiler markers rendered on Signal and Telegram, plain elsewhere | docs/concepts/markdown-formatting.md "Spoilers" | event | channel-discord-fixture, channel-telegram-shim, mock-provider-markdown-reply |
| 415 | Details disclosure native with richMessages, flattened elsewhere | docs/concepts/markdown-formatting.md "Collapsible details" | event | channel-telegram-shim, mock-provider-markdown-reply |
| 416 | Stray <final> markers removed outside code | docs/concepts/markdown-formatting.md "Common gotchas" | event | channel-probe-conversations, mock-provider-markdown-reply |
| 417 | Slack angle-bracket tokens surviving escaping | docs/concepts/markdown-formatting.md "Common gotchas" | ambient | none |
| 418 | Channel send transient failure retried per request with jittered backoff | docs/concepts/retry.md "Defaults" | event | channel-telegram-shim |
| 419 | Composite outbound flow failing mid-way, completed steps not retried | docs/concepts/retry.md "Notes" | event | channel-probe-conversations, channel-telegram-shim |
| 420 | Discord Gateway WebSocket reconnect loop | docs/concepts/retry.md "Defaults" | event | channel-discord-fixture |
| 421 | Discord send or REST call 429, timeout or 5xx retried | docs/concepts/retry.md "Discord" | event | channel-discord-fixture |
| 422 | Telegram text send outcome ambiguous after sending, not replayed | docs/concepts/retry.md "Telegram" | event | channel-telegram-shim |
| 423 | Telegram send rejected by flood control retried after retry_after | docs/concepts/retry.md "Telegram" | event | channel-telegram-shim |
| 424 | Telegram text send proven not started retried | docs/concepts/retry.md "Telegram" | event | none |
| 425 | Telegram preview edit transient failure retried without replacing | docs/concepts/retry.md "Telegram" | event | config-streaming-mode, mock-provider-held-turn |
| 426 | Telegram HTML parse error falls back to plain text without retry | docs/concepts/retry.md "Telegram" | event | channel-telegram-shim, mock-provider-markdown-reply |
| 427 | Durable delivery producer claim expired or replaced, budget not charged | docs/concepts/retry.md "Durable outbound delivery" | event | channel-probe-conversations |
| 428 | Vanished delivery producer recovered after last lease expires | docs/concepts/retry.md "Durable outbound delivery" | event | channel-delivery-queued, channel-probe-conversations |
| 429 | Send started when lease expired, reconciled before replay | docs/concepts/retry.md "Durable outbound delivery" | event | channel-telegram-shim, channel-probe-conversations |
| 430 | Producer leases renew through brief Gateway stalls | docs/concepts/retry.md "Durable outbound delivery" | ambient | channel-delivery-queued, channel-probe-conversations |
| 431 | Control UI reaction on a channel-origin prompt mirrored to the channel | docs/tools/reactions.md "Reactions" | event | channel-probe-conversations |
| 432 | Reaction with trackToolCalls reused for the status reaction lifecycle | docs/tools/reactions.md "How it works" | event | channel-discord-fixture, mock-provider-tool-calls |
| 433 | Nextcloud Talk reaction removal rejected (add-only) | docs/tools/reactions.md "Channel behavior" | ambient | none |
| 434 | WhatsApp single bot reaction slot, new replaces old | docs/tools/reactions.md "Channel behavior" | event | channel-real-accounts |
| 435 | Signal inbound reaction notifications (reactionNotifications) | docs/tools/reactions.md "Channel behavior"; docs/gateway/config-channels/personal-messaging.md "Signal"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 436 | Telegram react and emoji-list gated by actions.reactions | docs/tools/reactions.md "Channel behavior"; docs/gateway/config-channels/personal-messaging.md "Telegram"; docs/gateway/config-channels/community-chat.md "Discord" | ambient | config-telegram-reactions-off |
| 437 | iMessage reactions mapped to tapbacks | docs/tools/reactions.md "Channel behavior" | ambient | none |
| 438 | Feishu clearAll reaction semantics | docs/tools/reactions.md "Channel behavior" | ambient | none |
| 439 | reactionLevel off | docs/tools/reactions.md "Reaction level" | ambient | config-reaction-level-off, channel-reaction-level |
| 440 | reactionLevel ack | docs/tools/reactions.md "Reaction level" | ambient | channel-reaction-level |
| 441 | reactionLevel minimal | docs/tools/reactions.md "Reaction level" | ambient | channel-telegram-shim, channel-reaction-level |
| 442 | reactionLevel extensive | docs/tools/reactions.md "Reaction level" | ambient | channel-reaction-level |
| 443 | Channel starts automatically because its config section exists | docs/gateway/config-channels.md "Channels" | event | channels-test-accounts |
| 444 | Channel or account enabled false, not started | docs/gateway/config-channels.md "Channels" | ambient | config-channel-disabled, channel-accounts-multiple |
| 445 | Native command menus registered (commands.native auto) | docs/gateway/config-channels/commands.md "Commands (chat command handling)" | ambient | channel-telegram-shim |
| 446 | Discord native commands false, registration and cleanup skipped | docs/gateway/config-channels/commands.md "Commands (chat command handling)" | ambient | config-discord-native-commands-off, channel-discord-fixture |
| 447 | Extra Telegram bot menu entries (customCommands) | docs/gateway/config-channels/commands.md "Commands (chat command handling)" | ambient | config-telegram-custom-commands |
| 448 | Per-provider commands.allowFrom as the only command authorization source | docs/gateway/config-channels/commands.md "Commands (chat command handling)" | ambient | config-commands-allowfrom |
| 449 | Channel or account configWrites false refuses config mutations | docs/gateway/config-channels/workplace-chat.md "Slack"; docs/gateway/config-channels/workplace-chat.md "Mattermost"; docs/gateway/config-channels/workplace-chat.md "Microsoft Teams"; docs/gateway/config-channels/commands.md "Commands (chat command handling)" | ambient | config-writes-off, channel-groups-mixed |
| 450 | Tool-only recovery retry strands again, only a sanitized diagnostic delivered | docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | event | channel-group-allowlisted, config-visible-replies-tool, mock-provider-final-text-only |
| 451 | Host-owned terminal output under tool-only replies delivered normally | docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | event | channel-paired-sender, config-visible-replies-tool |
| 452 | Outbound delivery denied by sendPolicy | docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | config-send-policy-deny, config-visible-replies-tool |
| 453 | Harness default visible-reply mode applies to direct chats only | docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | config-visible-replies-tool |
| 454 | Group where no native mention or pattern can detect a mention, gating not enforced | docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating" | ambient | config-mention-undetectable, channel-groups-mixed |
| 455 | DM history windowed by dmHistoryLimit or per-DM historyLimit | docs/gateway/config-channels/mention-gating-and-history.md "DM history limits" | ambient | config-dm-history-limit, channel-dm-history |
| 456 | Account-level dms map replaces the root dms map | docs/gateway/config-channels/mention-gating-and-history.md "DM history limits" | ambient | config-dm-history-account-map, channel-dm-history |
| 457 | Ambiguous DM session key uses the account default | docs/gateway/config-channels/mention-gating-and-history.md "DM history limits" | event | config-channel-patches, config-dm-history-limit, channel-dm-history |
| 458 | Self-chat mode ignores native mentions, answers only text patterns | docs/gateway/config-channels/mention-gating-and-history.md "Self-chat mode" | ambient | none |
| 459 | dmPolicy allowlist admits only allowFrom or paired senders | docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | config-dm-policy-allowlist, channel-dm-pairing |
| 460 | dmPolicy open with allowFrom * admits all DMs | docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | config-dm-policy-open, channel-dm-pairing |
| 461 | dmPolicy disabled ignores all inbound DMs | docs/gateway/config-channels/shared-policies.md "DM and group access" | ambient | config-dm-policy-disabled, channel-dm-pairing |
| 462 | channels.defaults.groupPolicy applies only where channel policy unset | docs/gateway/config-channels/shared-policies.md "DM and group access"; docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | ambient | config-default-group-policy, channel-groups-mixed |
| 463 | Channel, group, topic or DM peer pinned to a model (modelByChannel) | docs/gateway/config-channels/shared-policies.md "Channel model overrides" | ambient | config-model-by-channel, channel-model-pins |
| 464 | Session /model override not replaced by modelByChannel | docs/gateway/config-channels/shared-policies.md "Channel model overrides" | ambient | config-model-override-session, channel-model-pins |
| 465 | channels.defaults or modelByChannel changed, runtimes refreshed without restart | docs/gateway/config-channels/shared-policies.md "Channel model overrides"; docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | event | channel-probe-conversations, config-channel-patches, channel-model-pins |
| 466 | Heartbeat showOk true delivers HEARTBEAT_OK | docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | ambient | config-heartbeat-short |
| 467 | Heartbeat showAlerts false | docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | ambient | config-heartbeat-alerts-off, config-heartbeat-short |
| 468 | Heartbeat useIndicator false | docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat" | ambient | config-heartbeat-indicator-off, config-heartbeat-short |
| 469 | Environment tokens apply only to the default account | docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Google Chat" | ambient | config-env-token-default, channel-accounts-multiple |
| 470 | Account inherits channel policy, explicit account value wins | docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)" | ambient | channel-multi-account, channel-accounts-multiple |
| 471 | WhatsApp starts automatically when a linked session exists | docs/gateway/config-channels/personal-messaging.md "WhatsApp" | event | channel-real-accounts |
| 472 | Persistent ACP binding on a channel conversation | docs/gateway/config-channels/personal-messaging.md "WhatsApp"; docs/gateway/config-channels/personal-messaging.md "Telegram"; docs/gateway/config-channels/community-chat.md "Discord" | ambient | config-acp-binding |
| 473 | Legacy single-account WhatsApp auth directory awaiting doctor migration | docs/gateway/config-channels/personal-messaging.md "WhatsApp" | ambient | none |
| 474 | Telegram token from tokenFile (symlink rejected) or TELEGRAM_BOT_TOKEN | docs/gateway/config-channels/personal-messaging.md "Telegram" | ambient | channel-telegram-shim |
| 475 | Telegram apiRoot with /bot<TOKEN> suffix awaiting doctor --fix | docs/gateway/config-channels/personal-messaging.md "Telegram" | ambient | none |
| 476 | Self-hosted Telegram Bot API in local mode with trusted file roots | docs/gateway/config-channels/personal-messaging.md "Telegram" | ambient | none |
| 477 | Telegram supergroup migration config write blocked by configWrites false | docs/gateway/config-channels/personal-messaging.md "Telegram" | event | channel-telegram-shim |
| 478 | Signal pinned to one account identity at startup | docs/gateway/config-channels/personal-messaging.md "Signal" | ambient | none |
| 479 | Retired BlueBubbles config not a supported runtime surface | docs/gateway/config-channels/personal-messaging.md "iMessage" | ambient | config-legacy-route-markers |
| 480 | iMessage through SSH wrapper to a remote Messages Mac | docs/gateway/config-channels/personal-messaging.md "iMessage" | ambient | none |
| 481 | iMessage reads work but sends fail with AppleEvents -1743 | docs/gateway/config-channels/personal-messaging.md "iMessage" | ambient | none |
| 482 | iMessage send transport falls back from IMCore bridge to AppleScript | docs/gateway/config-channels/personal-messaging.md "iMessage" | event | none |
| 483 | iMessage includeAttachments off by default | docs/gateway/config-channels/personal-messaging.md "iMessage" | ambient | none |
| 484 | iMessage inbound recovery after bridge or Gateway restart | docs/gateway/config-channels/personal-messaging.md "iMessage" | event | channel-real-accounts |
| 485 | iMessage group registry gate needs explicit chat_id or wildcard | docs/gateway/config-channels/personal-messaging.md "iMessage" | ambient | none |
| 486 | Remote imsg v0.13.4 limits (poll votes need pollOptionId; no attachment replies to nonzero parts) | docs/gateway/config-channels/personal-messaging.md "iMessage" | ambient | none |
| 487 | Direct Discord outbound call with explicit token, policy from selected account | docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture |
| 488 | Discord action groups toggled gate message tool actions | docs/gateway/config-channels/community-chat.md "Discord" | ambient | none |
| 489 | allowBots mentions: bot messages admitted only with an active bot mention | docs/gateway/config-channels/community-chat.md "Discord" | ambient | channel-bot-peer |
| 490 | Discord message addressed to another identity dropped under ignoreOtherMentions | docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture |
| 491 | Outbound @handle mapped to Discord user ids through mentionAliases | docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture |
| 492 | Outbound Discord URLs not expanded (suppressEmbeds) | docs/gateway/config-channels/community-chat.md "Discord" | ambient | channel-discord-fixture |
| 493 | Interactive component callback after its TTL expired | docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture, channel-interactive-message |
| 494 | Discord bot presence follows runtime availability | docs/gateway/config-channels/community-chat.md "Discord" | ambient | none |
| 495 | Discord human presence arrivals routed as system events | docs/gateway/config-channels/community-chat.md "Discord" | event | channel-discord-fixture |
| 496 | Mutable name or tag allowlist matching re-enabled | docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Google Chat" | ambient | config-name-matching |
| 497 | Reaction notifications off | docs/tools/reactions.md "Channel behavior"; docs/gateway/config-channels/personal-messaging.md "Signal"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | channel-reaction-level |
| 498 | Reaction notifications own | docs/tools/reactions.md "Channel behavior"; docs/gateway/config-channels/personal-messaging.md "Signal"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | channel-reaction-level |
| 499 | Reaction notifications all | docs/tools/reactions.md "Channel behavior"; docs/gateway/config-channels/personal-messaging.md "Signal"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | channel-reaction-level |
| 500 | Reaction notifications allowlist | docs/tools/reactions.md "Channel behavior"; docs/gateway/config-channels/personal-messaging.md "Signal"; docs/gateway/config-channels/community-chat.md "Discord"; docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | channel-reaction-level |
| 501 | Matrix traffic through an explicit proxy | docs/gateway/config-channels/community-chat.md "Matrix" | ambient | none |
| 502 | Matrix private-network homeserver | docs/gateway/config-channels/community-chat.md "Matrix" | ambient | none |
| 503 | Matrix autoJoin off, invites ignored | docs/gateway/config-channels/community-chat.md "Matrix" | ambient | none |
| 504 | Matrix autoJoin allowlist or always joins invited rooms | docs/gateway/config-channels/community-chat.md "Matrix" | event | none |
| 505 | Matrix DMs isolated per room | docs/gateway/config-channels/community-chat.md "Matrix" | ambient | none |
| 506 | IRC NickServ identification | docs/gateway/config-channels/community-chat.md "IRC" | ambient | none |
| 507 | Google Chat service account from inline JSON, file or SecretRef | docs/gateway/config-channels/workplace-chat.md "Google Chat" | ambient | none |
| 508 | Slack in Socket Mode | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 509 | Slack in HTTP mode | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 510 | Slack postAs user | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 511 | Slack Enterprise Grid org-wide install | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 512 | Retired Slack enterpriseOrgInstall key awaiting doctor --fix | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | config-legacy-route-markers |
| 513 | Slack group DM the app never joined unseen | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 514 | Slack unfurls off for bot replies | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 515 | Slack thread history per thread or shared (thread.historyScope) | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 516 | New Slack threads inherit parent transcript | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 517 | Existing thread messages fetched when a Slack thread session starts | docs/gateway/config-channels/workplace-chat.md "Slack" | event | channel-real-accounts |
| 518 | Temporary Slack typing reaction on the inbound message while a reply runs | docs/gateway/config-channels/workplace-chat.md "Slack" | ambient | none |
| 519 | Mattermost chatmode oncall | docs/gateway/config-channels/workplace-chat.md "Mattermost" | ambient | none |
| 520 | Mattermost chatmode onmessage | docs/gateway/config-channels/workplace-chat.md "Mattermost" | ambient | none |
| 521 | Mattermost chatmode onchar | docs/gateway/config-channels/workplace-chat.md "Mattermost" | ambient | none |
| 522 | Mattermost slash command registration failed, callbacks rejected | docs/gateway/config-channels/workplace-chat.md "Mattermost" | event | none |
| 523 | web.login.start without a channel selects first QR-capable provider | docs/gateway/protocol/rpc-system-and-channels.md "Channels and login helpers" | event | channel-real-accounts |
| 524 | QR login completes in web.login.wait and starts the channel | docs/gateway/protocol/rpc-system-and-channels.md "Channels and login helpers" | event | none |
| 525 | Channel ingress result presented after its scope changed, context rejected | docs/plugins/sdk-channel-ingress.md "Runtime resolver"; docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-probe-conversations, mock-provider-held-turn |
| 526 | Inbound reply whose parent cannot be fetched still carries the reference | docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-telegram-shim, channel-probe-conversations |
| 527 | Quoted bot text is context only, does not admit a bot turn | docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-bot-peer, channel-probe-conversations |
| 528 | Self-authored quote media skipped by default | docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-telegram-shim, channel-probe-conversations |
| 529 | Native command authorization revoked during binding preparation blocks next effect | docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-discord-fixture, channel-paired-sender, config-channel-patches |
| 530 | Intentional inbound skip logged once per account and conversation key | docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-group-allowlisted, channel-groups-mixed |
| 531 | Media-only inbound event with empty body | docs/plugins/sdk-channel-inbound.md "Core helpers" | event | channel-discord-fixture, channel-probe-conversations, channel-telegram-shim |
| 532 | Plugin using deprecated MediaPath/MediaUrls context fields | docs/plugins/sdk-channel-inbound.md "Core helpers" | ambient | channel-plugin-legacy-media-fields |
| 533 | Platform-owned recent history passed as inbound history window | docs/plugins/sdk-channel-inbound.md "Platform-selected history windows" | ambient | channel-group-history |
| 534 | Platform history fetch failing without restoring stale cache | docs/plugins/sdk-channel-inbound.md "Platform-selected history windows" | event | channel-discord-fixture |
| 535 | Internal wake turn does not reset session or replace binding | docs/plugins/sdk-channel-inbound.md "Internal turn sources" | event | config-heartbeat-short |
| 536 | Legacy Provider labels translated to InternalTurnSource | docs/plugins/sdk-channel-inbound.md "Internal turn sources" | ambient | config-heartbeat-short |
| 537 | Receive acknowledgment after the receive record (default) | docs/plugins/sdk-channel-inbound.md "Receive acknowledgment policy" | ambient | config-ack-after-record, channel-probe-conversations |
| 538 | Receive acknowledgment after agent dispatch | docs/plugins/sdk-channel-inbound.md "Receive acknowledgment policy" | ambient | config-ack-after-dispatch, channel-probe-conversations |
| 539 | Receive acknowledgment after durable send | docs/plugins/sdk-channel-inbound.md "Receive acknowledgment policy" | ambient | config-ack-after-send, channel-probe-conversations |
| 540 | Manual receive acknowledgment | docs/plugins/sdk-channel-inbound.md "Receive acknowledgment policy" | ambient | config-ack-manual, channel-probe-conversations |
| 541 | Unconfirmed send outcome recorded as unknown custody, no duplicate fallback | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-telegram-shim, channel-probe-conversations |
| 542 | Payload suppressed by a channel transform | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-probe-conversations |
| 543 | Payload intentionally suppressed by channel policy (preparePayload null) | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-probe-conversations |
| 544 | Proven no-send kept by durable recovery without fallback | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-telegram-shim, channel-probe-conversations |
| 545 | Delayed native finalization of a streamed message | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | none |
| 546 | Native command recording inbound metadata against a different session | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-telegram-shim |
| 547 | Inbound while agent database awaits startup inspection rejected, transport retries | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract"; docs/gateway/restart-recovery.md "How interrupted work is detected" | event | channel-telegram-shim, channel-probe-conversations |
| 548 | Inbound metadata write failing without failing the turn | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-probe-conversations |
| 549 | Native send that never started emits no message_sent | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | event | channel-telegram-shim, channel-probe-conversations |
| 550 | Payload-rewriting hooks registered, previews buffered | docs/plugins/sdk-channel-inbound.md "Delivery settlement contract" | ambient | plugin-message-hooks |
| 551 | Plugin on deprecated runtime.channel.turn alias | docs/plugins/sdk-channel-inbound.md "Migration" | ambient | channel-plugin-turn-alias |
| 552 | Several admitted messages batched into one context, results in source order | docs/plugins/sdk-channel-ingress.md "Runtime resolver" | event | config-inbound-debounce, channel-debounce |
| 553 | Sender without provable identity kept as unresolved participant observation | docs/plugins/sdk-channel-ingress.md "Product participant identity" | ambient | channel-probe-conversations |
| 554 | Execution-identity audit collection enabled | docs/plugins/sdk-channel-ingress.md "Result" | ambient | channel-identity-audit |
| 555 | Queued turn mixing several participants or stale evidence, attribution unknown | docs/plugins/sdk-channel-ingress.md "Result" | event | channel-identity-audit |
| 556 | allowFrom entries matching only mutable identifiers do not authorize | docs/plugins/sdk-channel-ingress.md "Identifier authentication" | ambient | config-mutable-allowlist, channel-groups-mixed |
| 557 | Minimum identifier authentication refuses weaker claims | docs/plugins/sdk-channel-ingress.md "Identifier authentication" | ambient | config-min-identifier-auth, channel-groups-mixed |
| 558 | Per-message authentication map missing a field treated as unverified | docs/plugins/sdk-channel-ingress.md "Identifier authentication" | event | none |
| 559 | Third-party plugin on deprecated dangerous or mutableIdentifierMatching fields | docs/plugins/sdk-channel-ingress.md "Identifier authentication" | ambient | none |
| 560 | Reaction, button, callback or native command from unknown sender cannot start pairing | docs/plugins/sdk-channel-ingress.md "Event modes" | event | channel-interactive-message, channel-telegram-shim, channel-dm-pairing |
| 561 | Interactive callback actor not matching original subject refused | docs/plugins/sdk-channel-ingress.md "Event modes" | event | channel-interactive-message, channel-probe-admission, channel-probe-bound-controls |
| 562 | Sender not in a room's sender allowlist blocked by route gate | docs/plugins/sdk-channel-ingress.md "Routes and activation" | event | channel-group-allowlisted |
| 563 | Mention activation evaluated before sender gates | docs/plugins/sdk-channel-ingress.md "Routes and activation" | ambient | config-activation-before-sender, channel-groups-mixed |
| 564 | Raw sender values and allowlist entries kept out of resolved state and diagnostics | docs/plugins/sdk-channel-ingress.md "Redaction" | ambient | channel-probe-conversations |
| 565 | Durable ingress append retries exhausted, transport callback rejected | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-telegram-shim, channel-probe-conversations |
| 566 | Ingress claim with mismatched decoded id or lane rejected | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-telegram-shim, channel-probe-conversations |
| 567 | Duplicate platform event admitted to durable ingress queue not inserted twice | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-telegram-shim, channel-probe-conversations |
| 568 | Event re-admitted after retention pruned its row | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-dead-letters, channel-telegram-shim, channel-probe-conversations |
| 569 | Ingress delivery deferred, claim held until adoption | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-probe-conversations |
| 570 | Shutdown or abort with unadopted ingress work leaves it retryable | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-telegram-shim, mock-provider-held-turn, channel-probe-conversations |
| 571 | Ingress delivery failing, cancelled or abandoned before adoption | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-probe-conversations |
| 572 | Several inbound claims answered by one turn settled together | docs/plugins/sdk-channel-outbound.md "One turn, several durable claims" | event | channel-telegram-shim, channel-debounce |
| 573 | Claim taken by another owner during fan-in adoption fails the rest | docs/plugins/sdk-channel-outbound.md "One turn, several durable claims" | event | channel-telegram-shim, channel-debounce |
| 574 | Deferred deliveries hold or release drain start slots | docs/plugins/sdk-channel-outbound.md "Start slots and deferral" | event | channel-telegram-shim, config-channel-patches, mock-provider-held-turn |
| 575 | Deferred ingress claim without heartbeat reaches watchdog timeout | docs/plugins/sdk-channel-outbound.md "Deferred claim heartbeats" | event | channel-telegram-shim, mock-provider-held-turn, channel-probe-conversations |
| 576 | Preview retained after accepted error final or unused preview with no final | docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership" | event | channel-streaming-modes |
| 577 | Preview cleanup failure does not replace accepted delivery result | docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership" | event | channel-telegram-shim, mock-provider-tool-calls, channel-streaming-modes |
| 578 | Bot's own outbound message redelivered as inbound dropped within 30 seconds | docs/plugins/sdk-channel-outbound.md "Outbound echo suppression" | event | channel-probe-conversations |
| 579 | HTML formatting sanitized for plain-text transport | docs/plugins/sdk-channel-outbound.md "Plain-text sanitization" | event | channel-probe-conversations |
| 580 | Batch parts landing in conflicting provider threads | docs/plugins/sdk-channel-outbound.md "Delivery Evidence" | event | none |
| 581 | Adapter intentionally omitting a send (not_sent) | docs/plugins/sdk-channel-outbound.md "Delivery Evidence" | event | channel-probe-conversations |
| 582 | Permanent local preflight rejection not retried | docs/plugins/sdk-channel-outbound.md "Delivery Evidence" | event | channel-probe-conversations, channel-accounts-multiple |
| 583 | Required durable send intent persistence failing stops delivery | docs/plugins/sdk-channel-outbound.md "Durable sends" | event | channel-probe-conversations |
| 584 | Best-effort durable send queue write fails, live-only send | docs/plugins/sdk-channel-outbound.md "Durable sends" | event | channel-probe-conversations |
| 585 | Send suppressed as ambiguous because adapter returned no identity | docs/plugins/sdk-channel-outbound.md "Durable sends" | event | channel-probe-conversations |
| 586 | Batch mixing sent, suppressed and failed payloads with per-payload outcomes | docs/plugins/sdk-channel-outbound.md "Durable sends" | event | channel-probe-conversations |
| 587 | Gateway OUTBOUND_DELIVERY_QUEUED, pending and not resent | docs/plugins/sdk-channel-outbound.md "Durable sends" | event | channel-delivery-queued, channel-probe-conversations |
| 588 | First send creating a thread adopted for later payloads | docs/plugins/sdk-channel-outbound.md "Durable sends" | event | channel-discord-fixture |
| 589 | Ambiguous provider send reconciled automatically | docs/plugins/sdk-channel-outbound.md "Automatic unknown-send reconciliation" | event | channel-telegram-shim |
| 590 | Deferred delivery permanently rejected by admission | docs/plugins/sdk-channel-outbound.md "Deferred delivery admission" | event | channel-probe-conversations, channel-accounts-multiple |
| 591 | Channel plugin importing removed channel-message SDK subpath fails to load | docs/plugins/sdk-channel-outbound.md "Migrating from channel-message" | ambient | channel-plugin-legacy-sdk, channel-plugin-load-broken |
| 592 | Command button or select option clicked runs the native command | docs/plugins/message-presentation.md "Contract" | event | none |
| 593 | Callback button or select option clicked delivers opaque plugin data | docs/plugins/message-presentation.md "Contract" | event | none |
| 594 | Live question answered, expired or cancelled elsewhere, actions removed | docs/plugins/message-presentation.md "Contract" | event | channel-telegram-shim |
| 595 | Question switched to free-text answer path (Force Reply) | docs/plugins/message-presentation.md "Contract" | event | channel-telegram-shim |
| 596 | Question choices as text or numbered reactions where native callbacks unavailable | docs/plugins/message-presentation.md "Contract" | event | channel-interactive-message |
| 597 | Invalid or incomplete chart or table block dropped | docs/plugins/message-presentation.md "Contract" | event | channel-interactive-message, channel-probe-conversations |
| 598 | Disabled button without supportsDisabled degraded to label text | docs/plugins/message-presentation.md "Contract" | event | channel-interactive-message, channel-telegram-shim |
| 599 | Reusable button kept available after successful interaction | docs/plugins/message-presentation.md "Contract" | event | channel-interactive-message |
| 600 | More controls than action limits, lower-priority dropped or kept as text | docs/plugins/message-presentation.md "Contract"; docs/plugins/message-presentation.md "Renderer contract" | event | channel-interactive-message, channel-telegram-shim |
| 601 | Adapter cannot render a presentation, conservative text fallback | docs/plugins/message-presentation.md "Core render flow"; docs/plugins/message-presentation.md "Button value fallback visibility"; docs/plugins/message-presentation.md "Provider mapping" | event | channel-interactive-message, channel-probe-conversations |
| 602 | Interactive controls on a channel that cannot render them, callback values hidden | docs/plugins/message-presentation.md "Core render flow"; docs/plugins/message-presentation.md "Button value fallback visibility"; docs/plugins/message-presentation.md "Provider mapping" | event | channel-interactive-message, channel-probe-conversations |
| 603 | Authored fallback text shipped when every data block degrades | docs/plugins/message-presentation.md "Degradation rules" | event | channel-interactive-message, channel-probe-conversations |
| 604 | Telegram inline buttons unavailable, text fallback | docs/plugins/message-presentation.md "Degradation rules" | ambient | config-telegram-inline-buttons-off |
| 605 | Optional delivery pin failing leaves message intact | docs/plugins/message-presentation.md "Degradation rules" | event | channel-telegram-shim |
| 606 | Required delivery pin failing reported as partial failure | docs/plugins/message-presentation.md "Degradation rules" | event | channel-telegram-shim |
| 607 | Producer sending the deprecated interactive payload subset | docs/plugins/message-presentation.md "Presentation vs InteractiveReply" | ambient | channel-interactive-message, channel-probe-conversations |
| 608 | Divider-only presentation | docs/plugins/message-presentation.md "Presentation vs InteractiveReply" | event | channel-probe-conversations |
| 609 | Pinned delivery of a chunked message pins first chunk | docs/plugins/message-presentation.md "Delivery pin" | event | channel-telegram-shim, mock-provider-long-reply |
| 610 | Send owner closing while adapter waits to pin | docs/plugins/message-presentation.md "Delivery pin" | event | channel-telegram-shim |
| 611 | Stable outbound-only identity through a provider-owned session | docs/tools/agent-send.md "Behavior" | ambient | config-outbound-only-identity, channels-test-accounts |
| 612 | Agent reply delivered to a different channel or account than its session | docs/tools/agent-send.md "Behavior" | event | channels-test-accounts |
| 613 | Gateway timeout after accepted agent turn with --deliver, may still deliver | docs/tools/agent-send.md "Behavior" | event | channel-probe-conversations, mock-provider-held-turn, channels-test-accounts |
| 614 | Acknowledgment reaction placed on an admitted inbound message | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | event | channel-telegram-shim |
| 615 | Acknowledgment reactions disabled (ackReaction empty or scope off) | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | config-ack-off |
| 616 | Ack scope group-mentions (default) | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | channel-group-allowlisted |
| 617 | Ack scope group-all | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | config-ack-scope-group-all |
| 618 | Ack scope direct | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | config-ack-scope-direct |
| 619 | WhatsApp with messages.ackReaction unset sends no acknowledgment | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | none |
| 620 | Lifecycle status reactions enabled | docs/gateway/config-agents/messages-and-talk.md "Ack reaction" | ambient | config-status-reactions |
| 621 | Retired WhatsApp inbound messagePrefix awaiting doctor move to responsePrefix | docs/gateway/config-agents/messages-and-talk.md "Other message keys" | ambient | none |
| 622 | Per-reply usage footer (messages.responseUsage) | docs/gateway/config-agents/messages-and-talk.md "Other message keys" | ambient | config-response-usage |
| 623 | Message-tool-only turn without durable ingress claim at recovery tombstoned | docs/gateway/restart-recovery.md "Restart recovery"; docs/gateway/restart-recovery.md "Automatic resume" | event | channel-group-allowlisted, config-visible-replies-tool, mock-provider-held-turn |
| 624 | Queued outbound deliveries drained and undelivered replies retried after restart | docs/gateway/restart-recovery.md "What survives a restart" | event | channel-telegram-shim, channel-probe-conversations |
| 625 | Delivery exhausting retry budget settles its session without resending | docs/gateway/restart-recovery.md "What survives a restart" | event | channel-telegram-shim, channel-probe-conversations |
| 626 | Crash after detached completion entered a parent turn with a channel route | docs/gateway/restart-recovery.md "What survives a restart" | event | channel-real-accounts |
| 627 | Pending final with uncertain delivery outcome noticed on next turn | docs/gateway/restart-recovery.md "What survives a restart"; docs/gateway/restart-recovery.md "Automatic resume" | event | channel-telegram-shim, channel-probe-conversations |
| 628 | Requested restart fences new work while active turns drain | docs/gateway/restart-recovery.md "Graceful restarts drain first" | event | channel-probe-conversations, mock-provider-held-turn |
| 629 | Interrupted external restart skips channel and plugin teardown for stop deadline | docs/gateway/restart-recovery.md "Systemd stop deadlines" | event | channel-probe-conversations |
| 630 | Gateway suspended through gateway.suspend, channel recovery deferred | docs/gateway/restart-recovery.md "Host sleep and process freezes" | event | channels-test-accounts |
| 631 | Channel turn in flight on a main session records recovery delivery claim | docs/gateway/restart-recovery.md "How interrupted work is detected" | ambient | mock-provider-held-turn |
| 632 | Unacknowledged inbound replayed after crash waits for writable admission | docs/gateway/restart-recovery.md "How interrupted work is detected" | event | channel-probe-admission, channel-probe-conversations |
| 633 | Final reply produced but undelivered before restart included in resumed turn | docs/gateway/restart-recovery.md "Automatic resume" | event | channel-telegram-shim |
| 634 | Recovered turn on a channel route sends resumption notice and final on same route | docs/gateway/restart-recovery.md "Automatic resume" | event | channel-telegram-shim, mock-provider-held-turn, channel-probe-conversations |
| 635 | Telegram typing renewed while a recovered turn runs | docs/gateway/restart-recovery.md "Automatic resume" | event | channel-telegram-shim, mock-provider-held-turn |
| 636 | Channel without guarded typing hook during recovery sends notice only | docs/gateway/restart-recovery.md "Automatic resume" | ambient | channel-probe-conversations |
| 637 | Channel message to a tombstoned session gets one recovery reminder | docs/gateway/restart-recovery.md "Automatic resume" | event | session-tombstoned, channel-probe-conversations |
| 638 | Message-tool send with unknown provider outcome after crash resumed restart-safe | docs/gateway/restart-recovery.md "Automatic resume" | event | config-visible-replies-tool, mock-provider-tool-calls |
| 639 | Agent-requested restart posts outcome to originating chat | docs/gateway/restart-recovery.md "Agent-requested restarts" | event | channel-telegram-shim, mock-provider-tool-calls, channel-probe-conversations |
| 640 | channels.start manual override while crash-loop breaker suppresses auto-start | docs/gateway/restart-recovery.md "Safety valves and observability"; docs/channels/troubleshooting.md "Gateway up but channel never connects" | event | channel-probe-conversations |
| 641 | Recovered replies run reply_payload_sending before channel delivery | docs/gateway/restart-recovery.md "Safety valves and observability"; docs/gateway/restart-recovery.md "Automatic resume" | event | mock-provider-held-turn, plugin-message-hooks, channel-probe-conversations |
| 642 | Inbound during restart drain rejected with explicit restart error | docs/gateway/restart-recovery.md "What is not resumed" | event | channel-probe-conversations, mock-provider-held-turn |
| 643 | Background process completion already polled during a channel turn, notice not repeated | added at step 6 from PR [OpenClaw #138188](https://github.com/openclaw/openclaw/pull/138188) (no listed document); none (break [OpenClaw #138188](https://github.com/openclaw/openclaw/pull/138188)) | event | channel-probe-conversations, mock-provider-tool-calls, config-heartbeat-short |
| 644 | Retired Microsoft Teams JSON state on disk, doctor explains recovery | added at step 6 from PR [OpenClaw #163850](https://github.com/openclaw/openclaw/pull/163850) (no listed document); none (break [OpenClaw #163850](https://github.com/openclaw/openclaw/pull/163850)) | ambient | channel-teams-retired-state |
| 645 | Queued channel turn cancelled while the active turn's bound plugin work runs | none (break [OpenClaw #164230](https://github.com/openclaw/openclaw/pull/164230)) | event | mock-provider-held-turn |
| 646 | A host supporting an asynchronous inspection companion selects it for admission and claim validation | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | ambient | channel-ingress-monitor-fixture |
| 647 | An older host ignores the asynchronous companion and uses the synchronous fallback | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | ambient | channel-ingress-monitor-fixture, channel-ingress-legacy-host |
| 648 | The standard raw-event convenience monitor keeps synchronous inspection | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | ambient | channel-ingress-monitor-fixture |
| 649 | Pending asynchronous admission inspection preserves the accepted admission order | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |
| 650 | Shutdown or waitForIdle joins accepted admission inspection and its pending durable append | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |
| 651 | Pending claim inspection remains joined when the channel owns separate delivery grace | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |
| 652 | Shutdown during claim inspection is rechecked before delivery | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |
| 653 | Claim cancellation during inspection is rechecked before delivery | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |
| 654 | Pending claim inspections occupy the existing start slots | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |
| 655 | Pending claim inspections keep activity busy until inspection finishes or transfers to delivery | docs/plugins/sdk-channel-outbound.md "Durable ingress monitors" | event | channel-ingress-monitor-fixture |

## Headings walked
docs/channels/index.md "Chat channels": none
docs/channels/index.md "Which channel should I connect first?": 1
docs/channels/index.md "Supported channels": none
docs/channels/index.md "Related communication plugins": none (owned by talk)
docs/channels/index.md "Group join introductions": 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
docs/channels/index.md "Delivery notes": 12, 13, 14, 15, 16, 17, 174
docs/channels/index.md "Notes": 18, 19
docs/channels/channel-routing.md "Channels & routing": 20
docs/channels/channel-routing.md "Key terms": 21, 22
docs/channels/channel-routing.md "Outbound target prefixes": 23, 24
docs/channels/channel-routing.md "Session key shapes (examples)": 20, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34
docs/channels/channel-routing.md "Main DM route pinning": 35
docs/channels/channel-routing.md "Guarded inbound recording": 36
docs/channels/channel-routing.md "Routing rules (how an agent is chosen)": 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49
docs/channels/channel-routing.md "Broadcast groups (run multiple agents)": 50, 51, 52
docs/channels/channel-routing.md "Config overview": none
docs/channels/channel-routing.md "Session storage": none (owned by sessions)
docs/channels/channel-routing.md "WebChat behavior": none (owned by sessions)
docs/channels/channel-routing.md "Reply context": 53
docs/channels/channel-routing.md "Related": none
docs/channels/channel-routing.md "Channel routing": none
docs/channels/groups.md "Groups": 17
docs/channels/groups.md "Beginner intro (2 minutes)": 54, 55, 56, 57, 58, 59, 94
docs/channels/groups.md "Bot-created threads": 60, 61, 62, 63, 64, 65, 66, 67, 68, 69
docs/channels/groups.md "Visible replies": 56, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81
docs/channels/groups.md "Context visibility and allowlists": 82, 83, 84, 85, 86
docs/channels/groups.md "Session keys": 20, 25, 26, 27, 30, 31, 32, 34
docs/channels/groups.md "Pattern: personal DMs + public groups (single agent)": none (owned by sandbox)
docs/channels/groups.md "Display labels": 87
docs/channels/groups.md "Group policy": 54, 57, 88, 89, 90, 91, 92, 93, 94, 95
docs/channels/groups.md "Mention gating (default)": 59, 96, 97, 98, 99
docs/channels/groups.md "Scope configured mention patterns": 74, 75, 100, 101, 102, 103, 104, 105, 106, 107
docs/channels/groups.md "Group/channel tool restrictions (optional)": 108, 109, 110
docs/channels/groups.md "Group allowlists": 54, 90, 94, 111
docs/channels/groups.md "Activation (owner-only)": 112
docs/channels/groups.md "Context fields": 113, 114, 115
docs/channels/groups.md "iMessage specifics": none
docs/channels/groups.md "Related": none
docs/channels/group-messages.md "WhatsApp group messages": 105
docs/channels/group-messages.md "Behavior": 54, 57, 59, 74, 75, 77, 88, 94, 106, 112, 113, 114, 116, 117, 118, 119, 120
docs/channels/group-messages.md "Config example (WhatsApp)": 104, 106, 107
docs/channels/group-messages.md "Activation command (owner-only)": 112, 121
docs/channels/group-messages.md "How to use": 77, 88
docs/channels/group-messages.md "Testing / verification": none
docs/channels/group-messages.md "Known considerations": 122, 123, 124, 125
docs/channels/group-messages.md "Related": none
docs/channels/broadcast-groups.md "Overview": 50, 51, 126
docs/channels/broadcast-groups.md "Configuration": none
docs/channels/broadcast-groups.md "Agent group threads": 50, 127, 128, 129
docs/channels/broadcast-groups.md "Mention selection": 130, 131, 132
docs/channels/broadcast-groups.md "Bounded follow-up rounds": 133, 134, 135, 136, 137, 138
docs/channels/broadcast-groups.md "Participant labels": 139
docs/channels/broadcast-groups.md "Basic setup": 48, 51, 140, 141, 144
docs/channels/broadcast-groups.md "Processing strategy": 138
docs/channels/broadcast-groups.md "Complete example": none
docs/channels/broadcast-groups.md "How it works": none
docs/channels/broadcast-groups.md "Message flow": 50, 51, 52, 54, 94, 138, 142, 144
docs/channels/broadcast-groups.md "Session isolation": 50, 51, 143, 144
docs/channels/broadcast-groups.md "Example: isolated sessions": none
docs/channels/broadcast-groups.md "Use cases": none
docs/channels/broadcast-groups.md "Best practices": 145
docs/channels/broadcast-groups.md "Compatibility": none
docs/channels/broadcast-groups.md "Providers": 51, 144
docs/channels/broadcast-groups.md "Routing": 52, 146
docs/channels/broadcast-groups.md "Troubleshooting": none
docs/channels/broadcast-groups.md "Examples": none
docs/channels/broadcast-groups.md "API reference": none
docs/channels/broadcast-groups.md "Config schema": none
docs/channels/broadcast-groups.md "Fields": none
docs/channels/broadcast-groups.md "Limitations": 137, 147
docs/channels/broadcast-groups.md "Related": none
docs/channels/broadcast-groups.md "Broadcast groups": 51, 144
docs/channels/access-groups.md "Access groups": 148
docs/channels/access-groups.md "Static message sender groups": 149, 150
docs/channels/access-groups.md "Reference groups from allowlists": 151, 152, 153, 154
docs/channels/access-groups.md "Supported message-channel paths": 151, 152, 153, 154
docs/channels/access-groups.md "Discord channel audiences": 155, 156
docs/channels/access-groups.md "Plugin diagnostics": none
docs/channels/access-groups.md "Security notes": 157, 158
docs/channels/access-groups.md "Troubleshooting": 159
docs/channels/access-groups.md "Related": none
docs/channels/ambient-room-events.md "Ambient room events": 17, 70, 160
docs/channels/ambient-room-events.md "Recommended setup": 17, 54, 94
docs/channels/ambient-room-events.md "Prerequisites": 78, 79, 161, 162
docs/channels/ambient-room-events.md "What changes": 163, 164, 165, 166
docs/channels/ambient-room-events.md "Discord example": 167
docs/channels/ambient-room-events.md "Slack example": 167, 168
docs/channels/ambient-room-events.md "Telegram example": 65
docs/channels/ambient-room-events.md "Agent specific policy": 169
docs/channels/ambient-room-events.md "Visible reply modes": 56, 71, 164, 165
docs/channels/ambient-room-events.md "History": 106, 107, 170, 171
docs/channels/ambient-room-events.md "Troubleshooting": 65, 164, 165, 172
docs/channels/ambient-room-events.md "Related": none
docs/channels/bot-loop-protection.md "Bot loop protection": 15, 16, 173, 174
docs/channels/bot-loop-protection.md "Defaults": 15, 174
docs/channels/bot-loop-protection.md "Configure shared defaults": 175, 176, 177
docs/channels/bot-loop-protection.md "Override per channel, account, or room": 177
docs/channels/bot-loop-protection.md "Channel support": 178
docs/channels/bot-loop-protection.md "Internal agent group rounds": 133, 134, 136, 137, 179
docs/channels/location.md "Channel location parsing": 180, 181, 182
docs/channels/location.md "Text formatting": 180, 181, 182
docs/channels/location.md "Context fields": 180, 181, 182
docs/channels/location.md "Outbound payloads": 183, 184, 185
docs/channels/location.md "Channel notes": 180, 181, 182
docs/channels/location.md "Related": none
docs/channels/pairing.md "Pairing": none
docs/channels/pairing.md "1) DM pairing (inbound chat access)": 157, 186, 187, 188, 189, 190
docs/channels/pairing.md "Approve from the Control UI": 90, 191, 192
docs/channels/pairing.md "Approve from the CLI": 191, 193, 194
docs/channels/pairing.md "Set up an owner without DM pairing": 191, 193
docs/channels/pairing.md "Reusable sender groups": 151, 152, 153, 154
docs/channels/pairing.md "Where the state lives": 90, 195, 196
docs/channels/pairing.md "2) Node device pairing (iOS/Android/macOS/headless nodes)": none (owned by nodes)
docs/channels/pairing.md "Pair from the Control UI (recommended)": none (owned by nodes)
docs/channels/pairing.md "Pair via Telegram": none (owned by nodes)
docs/channels/pairing.md "Approve a node device": none (owned by nodes)
docs/channels/pairing.md "Optional trusted-CIDR node auto-approve": none (owned by nodes)
docs/channels/pairing.md "Node pairing state storage": none (owned by nodes)
docs/channels/pairing.md "Notes": none (owned by nodes)
docs/channels/pairing.md "Related docs": none
docs/channels/troubleshooting.md "Channel troubleshooting": none
docs/channels/troubleshooting.md "Command ladder": 197
docs/channels/troubleshooting.md "After an update": 198
docs/channels/troubleshooting.md "WhatsApp": none
docs/channels/troubleshooting.md "WhatsApp failure signatures": 199, 200, 201, 202, 203, 204
docs/channels/troubleshooting.md "Telegram": none
docs/channels/troubleshooting.md "Telegram failure signatures": 205, 206, 207, 208, 209, 210, 211
docs/channels/troubleshooting.md "Discord": none
docs/channels/troubleshooting.md "Discord failure signatures": 212, 213, 214, 215, 216, 217, 218
docs/channels/troubleshooting.md "Slack": none
docs/channels/troubleshooting.md "Slack failure signatures": 219, 220, 221
docs/channels/troubleshooting.md "iMessage": none
docs/channels/troubleshooting.md "iMessage failure signatures": 222, 223, 224
docs/channels/troubleshooting.md "Signal": none
docs/channels/troubleshooting.md "Signal failure signatures": 225, 226, 227
docs/channels/troubleshooting.md "QQ Bot": none
docs/channels/troubleshooting.md "QQ Bot failure signatures": 228, 229, 230, 231
docs/channels/troubleshooting.md "Matrix": none
docs/channels/troubleshooting.md "Matrix failure signatures": 232, 233, 234, 235, 236
docs/channels/troubleshooting.md "Gateway up but channel never connects": 237, 238, 640
docs/channels/troubleshooting.md "Related": none
docs/cli/channels.md "openclaw channels": none
docs/cli/channels.md "Common commands": 198, 239, 240, 241, 242, 243
docs/cli/channels.md "Status / capabilities / resolve / logs": 244, 245, 246, 247
docs/cli/channels.md "Inbound dead letters": 248, 249, 250, 251, 252
docs/cli/channels.md "Add / remove accounts": 1, 253, 254, 255, 256, 257, 258
docs/cli/channels.md "Login and logout (interactive)": 259, 260, 261, 262, 263, 264, 265
docs/cli/channels.md "Per-account recovery (non-destructive)": 237, 238, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 640
docs/cli/channels.md "Troubleshooting": 246, 273, 274
docs/cli/channels.md "Capabilities check": 278, 279
docs/cli/channels.md "Resolve names to IDs": 239, 273, 274, 280
docs/cli/channels.md "Related": none
docs/cli/channels.md "Channels": none
docs/cli/message.md "openclaw message": none
docs/cli/message.md "Channel selection": 18, 246, 281, 282
docs/cli/message.md "Agent ownership": 241
docs/cli/message.md "Target formats (-t, --target)": 283
docs/cli/message.md "Common flags": 284, 285
docs/cli/message.md "SecretRef resolution": 274, 286, 287
docs/cli/message.md "Actions": none
docs/cli/message.md "Core": none
docs/cli/message.md "Member info": none
docs/cli/message.md "Send": 23, 24, 288, 289, 290, 291
docs/cli/message.md "Poll": none
docs/cli/message.md "Threads": none
docs/cli/message.md "Emojis": none
docs/cli/message.md "Stickers": none
docs/cli/message.md "Roles, channels, voice, events (Discord)": none
docs/cli/message.md "Moderation (Discord)": none
docs/cli/message.md "Broadcast": 292
docs/cli/message.md "Related": none
docs/cli/message.md "Message": none
docs/cli/directory.md "openclaw directory": none
docs/cli/directory.md "Common flags": 281, 293, 294
docs/cli/directory.md "Notes": 286, 293, 294, 295, 296
docs/cli/directory.md "Using results with message send": none
docs/cli/directory.md "ID formats by channel": none
docs/cli/directory.md "Self ("me")": 297, 298
docs/cli/directory.md "Peers (contacts/users)": none
docs/cli/directory.md "Groups": none
docs/cli/directory.md "Related": none
docs/cli/directory.md "Directory": none
docs/cli/pairing.md "openclaw pairing": 188, 190, 192, 299, 300, 301
docs/cli/pairing.md "Commands": 21, 195
docs/cli/pairing.md "pairing list": 18
docs/cli/pairing.md "pairing approve": none
docs/cli/pairing.md "Owner bootstrap": 191, 193, 301, 302
docs/cli/pairing.md "Related": none
docs/cli/pairing.md "Pairing CLI": none
docs/concepts/messages.md "Messages": none
docs/concepts/messages.md "Inbound dedupe": 303, 304
docs/concepts/messages.md "Inbound debouncing": 305, 306, 307, 308, 309, 310, 311
docs/concepts/messages.md "Sessions and devices": 20, 30
docs/concepts/messages.md "Prompt bodies and history context": 106, 107, 114, 120, 312
docs/concepts/messages.md "Tool result metadata": none (owned by agents)
docs/concepts/messages.md "Queueing and followups": 313
docs/concepts/messages.md "Channel run ownership": 314
docs/concepts/messages.md "Streaming, chunking, and batching": 315, 316, 317, 318, 319
docs/concepts/messages.md "Reasoning visibility and tokens": 320
docs/concepts/messages.md "Prefixes, threading, and replies": 321, 322, 323, 324
docs/concepts/messages.md "Silent replies": 17, 74, 75, 164, 165, 325, 326, 327, 328, 329, 330, 331
docs/concepts/messages.md "Related": none
docs/concepts/streaming.md "Streaming and chunking": 315, 332
docs/concepts/streaming.md "Control UI startup status": none (owned by sessions)
docs/concepts/streaming.md "Block streaming (channel messages)": 315, 316, 318, 333, 334, 335, 336
docs/concepts/streaming.md "Media delivery with block streaming": 337, 338, 339, 340, 341
docs/concepts/streaming.md "Chunking algorithm (low/high bounds)": 316, 342, 343
docs/concepts/streaming.md "Coalescing (merge streamed blocks)": 344
docs/concepts/streaming.md "Human-like pacing between blocks": 317
docs/concepts/streaming.md ""Stream chunks or everything"": 129, 315, 319, 334, 345, 346, 347, 365
docs/concepts/streaming.md "Preview streaming modes": 318, 348, 349, 350, 351, 352, 353, 391
docs/concepts/streaming.md "Channel mapping": 352, 353, 354, 355, 356, 357, 358
docs/concepts/streaming.md "Legacy key migration": 318
docs/concepts/streaming.md "Runtime behavior": none
docs/concepts/streaming.md "Telegram": 315, 320, 350, 351, 352, 360, 361, 362, 363, 364, 365, 366, 391
docs/concepts/streaming.md "Discord": 315, 351, 352, 365, 367, 368, 369
docs/concepts/streaming.md "Slack": 356, 357, 358, 359
docs/concepts/streaming.md "Mattermost": 353, 370, 371
docs/concepts/streaming.md "Matrix": 370, 371
docs/concepts/streaming.md "Tool-progress preview updates": 348, 349, 367, 372, 373, 374
docs/concepts/streaming.md "Progress draft rendering": 375, 376, 377, 378, 379, 382
docs/concepts/streaming.md "Commentary progress lane": 378, 379, 382
docs/concepts/streaming.md "Related": none
docs/concepts/progress-drafts.md "Progress drafts": 352, 367, 381
docs/concepts/progress-drafts.md "Quick start": 352, 380, 381
docs/concepts/progress-drafts.md "What users see": 381
docs/concepts/progress-drafts.md "Choose a mode": 348, 349, 350, 351, 352, 391
docs/concepts/progress-drafts.md "Configure labels": 378, 379, 382
docs/concepts/progress-drafts.md "Control progress lines": 367, 372, 373, 374, 383
docs/concepts/progress-drafts.md "Detail mode": 384
docs/concepts/progress-drafts.md "Command/exec text": 367, 372, 374
docs/concepts/progress-drafts.md "Commentary lane": 378, 379, 382
docs/concepts/progress-drafts.md "Status headline": 385, 386, 387, 388
docs/concepts/progress-drafts.md "Line limits": 378, 379, 382
docs/concepts/progress-drafts.md "Show the tool log": 367, 372, 374, 380
docs/concepts/progress-drafts.md "Channel behavior": 353, 356, 357, 358, 389, 390
docs/concepts/progress-drafts.md "Finalization": 350, 362, 364, 368, 369, 391, 392, 393, 394
docs/concepts/progress-drafts.md "Troubleshooting": 129, 348, 349, 366, 392, 393, 394
docs/concepts/progress-drafts.md "Related": none
docs/concepts/typing-indicators.md "Typing indicators": 395
docs/concepts/typing-indicators.md "Defaults": 125, 396, 397, 398, 399, 400
docs/concepts/typing-indicators.md "Modes": 401, 402, 403, 404
docs/concepts/typing-indicators.md "Configuration": 405
docs/concepts/typing-indicators.md "Notes": 395, 399, 400, 403, 404
docs/concepts/typing-indicators.md "Related": none
docs/concepts/markdown-formatting.md "Markdown formatting": 406, 413
docs/concepts/markdown-formatting.md "Pipeline": 406, 407, 408
docs/concepts/markdown-formatting.md "IR example": none
docs/concepts/markdown-formatting.md "Table handling": 363, 409, 410, 411, 412
docs/concepts/markdown-formatting.md "Chunking rules": 413
docs/concepts/markdown-formatting.md "Link policy": 406, 408
docs/concepts/markdown-formatting.md "Spoilers": 414
docs/concepts/markdown-formatting.md "Collapsible details": 415
docs/concepts/markdown-formatting.md "Adding or updating a channel formatter": none
docs/concepts/markdown-formatting.md "Common gotchas": 406, 408, 416, 417
docs/concepts/markdown-formatting.md "Related": none
docs/concepts/retry.md "Goals": 419
docs/concepts/retry.md "Defaults": 418, 420
docs/concepts/retry.md "Behavior": none
docs/concepts/retry.md "Model providers": none (owned by models)
docs/concepts/retry.md "Managed Git operations": none (owned by worktrees)
docs/concepts/retry.md "Discord": 421
docs/concepts/retry.md "Telegram": 422, 423, 424, 425, 426
docs/concepts/retry.md "Configuration": none
docs/concepts/retry.md "Notes": 419
docs/concepts/retry.md "Durable outbound delivery": 427, 428, 429, 430
docs/concepts/retry.md "Related": none
docs/concepts/retry.md "Retry policy": none
docs/tools/reactions.md "Reactions": 431
docs/tools/reactions.md "How it works": 432
docs/tools/reactions.md "Channel behavior": 433, 434, 435, 436, 437, 438, 497, 498, 499, 500
docs/tools/reactions.md "Reaction level": 439, 440, 441, 442
docs/tools/reactions.md "Related": none
docs/gateway/config-channels.md "Configuration — channels": none
docs/gateway/config-channels.md "Channels": 443, 444
docs/gateway/config-channels.md "Other plugin channels": none
docs/gateway/config-channels.md "What each page covers": none
docs/gateway/config-channels.md "Where each section moved": none
docs/gateway/config-channels.md "Related": none
docs/gateway/config-channels/commands.md "Configuration — chat commands": none
docs/gateway/config-channels/commands.md "Commands (chat command handling)": 445, 446, 447, 448, 449
docs/gateway/config-channels/community-chat.md "Configuration — community chat channels": none
docs/gateway/config-channels/community-chat.md "Discord": 2, 3, 5, 15, 16, 21, 22, 66, 173, 174, 318, 336, 435, 436, 469, 472, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499, 500
docs/gateway/config-channels/community-chat.md "Matrix": 2, 8, 21, 22, 501, 502, 503, 504, 505
docs/gateway/config-channels/community-chat.md "IRC": 21, 22, 449, 506
docs/gateway/config-channels/mention-gating-and-history.md "Configuration — group mention gating and history": none
docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating": 17, 55, 58, 70, 71, 72, 73, 76, 78, 79, 104, 106, 107, 164, 165, 450, 451, 452, 453, 454
docs/gateway/config-channels/mention-gating-and-history.md "DM history limits": 455, 456, 457
docs/gateway/config-channels/mention-gating-and-history.md "Self-chat mode": 458
docs/gateway/config-channels/personal-messaging.md "Configuration — personal messaging channels": none
docs/gateway/config-channels/personal-messaging.md "WhatsApp": 21, 22, 52, 471, 472, 473
docs/gateway/config-channels/personal-messaging.md "Telegram": 2, 4, 21, 22, 52, 350, 391, 436, 472, 474, 475, 476, 477
docs/gateway/config-channels/personal-messaging.md "Signal": 21, 22, 433, 434, 435, 437, 438, 449, 478, 497, 498, 499, 500
docs/gateway/config-channels/personal-messaging.md "iMessage": 21, 22, 52, 222, 223, 449, 479, 480, 481, 482, 483, 484, 485, 486
docs/gateway/config-channels/personal-messaging.md "LINE": 2, 3, 4
docs/gateway/config-channels/shared-policies.md "Configuration — shared channel policies": none
docs/gateway/config-channels/shared-policies.md "DM and group access": 19, 54, 57, 88, 94, 95, 186, 188, 190, 459, 460, 461, 462
docs/gateway/config-channels/shared-policies.md "Channel model overrides": 463, 464, 465
docs/gateway/config-channels/shared-policies.md "Channel defaults and heartbeat": 82, 83, 84, 99, 462, 465, 466, 467, 468
docs/gateway/config-channels/shared-policies.md "Multi-account (all channels)": 21, 22, 43, 256, 257, 258, 469, 470
docs/gateway/config-channels/workplace-chat.md "Configuration — workplace chat channels": none
docs/gateway/config-channels/workplace-chat.md "Google Chat": 469, 496, 507
docs/gateway/config-channels/workplace-chat.md "Slack": 2, 16, 21, 22, 92, 173, 219, 274, 318, 356, 357, 358, 359, 435, 449, 488, 497, 498, 499, 500, 508, 509, 510, 511, 512, 513, 514, 515, 516, 517, 518
docs/gateway/config-channels/workplace-chat.md "Mattermost": 21, 22, 59, 449, 519, 520, 521, 522
docs/gateway/config-channels/workplace-chat.md "Microsoft Teams": 449
docs/gateway/protocol/rpc-system-and-channels.md "Gateway protocol system and channel methods": none
docs/gateway/protocol/rpc-system-and-channels.md "System and identity": none (owned by gateway core)
docs/gateway/protocol/rpc-system-and-channels.md "Models and usage": none (owned by models and usage)
docs/gateway/protocol/rpc-system-and-channels.md "Memory": none (owned by memory)
docs/gateway/protocol/rpc-system-and-channels.md "Channels and login helpers": 237, 266, 269, 270, 271, 272, 275, 276, 277, 523, 524
docs/gateway/protocol/rpc-system-and-channels.md "Channel DM pairing": 188, 190, 191, 300, 301
docs/gateway/protocol/rpc-system-and-channels.md "Plugin management": none (owned by plugins)
docs/gateway/protocol/rpc-system-and-channels.md "Catalog detail and client confirmation": none (owned by plugins)
docs/gateway/protocol/rpc-system-and-channels.md "ClawHub catalog discovery": none (owned by plugins)
docs/gateway/protocol/rpc-system-and-channels.md "Browse and search": none (owned by plugins)
docs/gateway/protocol/rpc-system-and-channels.md "Bulk keyword discovery": none (owned by plugins)
docs/gateway/protocol/rpc-system-and-channels.md "Upstream contracts and gaps": none (owned by plugins)
docs/gateway/protocol/rpc-system-and-channels.md "Messaging and logs": none
docs/gateway/protocol/rpc-system-and-channels.md "Operator terminal": none (owned by terminal)
docs/plugins/sdk-channel-inbound.md "Channel inbound API": none
docs/plugins/sdk-channel-inbound.md "Core helpers": 525, 526, 527, 528, 529, 530, 531, 532
docs/plugins/sdk-channel-inbound.md "Platform-selected history windows": 533, 534
docs/plugins/sdk-channel-inbound.md "Agent group dispatch": 50, 52, 127, 137
docs/plugins/sdk-channel-inbound.md "Internal turn sources": 535, 536
docs/plugins/sdk-channel-inbound.md "Receive acknowledgment policy": 537, 538, 539, 540
docs/plugins/sdk-channel-inbound.md "Delivery settlement contract": 24, 288, 541, 542, 543, 544, 545, 546, 547, 548, 549, 550
docs/plugins/sdk-channel-inbound.md "Migration": 551
docs/plugins/sdk-channel-inbound.md "Related": none
docs/plugins/sdk-channel-ingress.md "Channel ingress API": none
docs/plugins/sdk-channel-ingress.md "Runtime resolver": 525, 552
docs/plugins/sdk-channel-ingress.md "Product participant identity": 553
docs/plugins/sdk-channel-ingress.md "Result": 525, 554, 555
docs/plugins/sdk-channel-ingress.md "Identifier authentication": 556, 557, 558, 559
docs/plugins/sdk-channel-ingress.md "Bundled channel declarations": 556, 557
docs/plugins/sdk-channel-ingress.md "Access groups": 156, 158
docs/plugins/sdk-channel-ingress.md "Event modes": 560, 561
docs/plugins/sdk-channel-ingress.md "Routes and activation": 58, 96, 97, 98, 99, 562, 563
docs/plugins/sdk-channel-ingress.md "Redaction": 564
docs/plugins/sdk-channel-ingress.md "Verification": none
docs/plugins/sdk-channel-ingress.md "Related": none
docs/plugins/sdk-channel-outbound.md "Channel outbound API": none
docs/plugins/sdk-channel-outbound.md "Durable ingress monitors": 565, 566, 567, 568, 569, 570, 571, 646, 647, 648, 649, 650, 651, 652, 653, 654, 655
docs/plugins/sdk-channel-outbound.md "One turn, several durable claims": 572, 573
docs/plugins/sdk-channel-outbound.md "Start slots and deferral": 574
docs/plugins/sdk-channel-outbound.md "Deferred claim heartbeats": 575
docs/plugins/sdk-channel-outbound.md "Adapter": none
docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership": 24, 362, 368, 542, 543, 549, 576, 577
docs/plugins/sdk-channel-outbound.md "Outbound echo suppression": 578
docs/plugins/sdk-channel-outbound.md "Plain-text sanitization": 579
docs/plugins/sdk-channel-outbound.md "Delivery Evidence": 549, 580, 581, 582
docs/plugins/sdk-channel-outbound.md "Existing outbound adapters": none
docs/plugins/sdk-channel-outbound.md "Durable sends": 541, 583, 584, 585, 586, 587, 588
docs/plugins/sdk-channel-outbound.md "Automatic unknown-send reconciliation": 589
docs/plugins/sdk-channel-outbound.md "Deferred delivery admission": 590
docs/plugins/sdk-channel-outbound.md "Compatibility dispatch": none
docs/plugins/sdk-channel-outbound.md "Migrating from channel-message": 591
docs/plugins/sdk-channel-outbound.md "Related": none
docs/plugins/message-presentation.md "Message presentation": none
docs/plugins/message-presentation.md "Contract": 290, 592, 593, 594, 595, 596, 597, 598, 599, 600
docs/plugins/message-presentation.md "Producer examples": none
docs/plugins/message-presentation.md "Renderer contract": 363, 600
docs/plugins/message-presentation.md "Core render flow": 290, 601, 602
docs/plugins/message-presentation.md "Degradation rules": 290, 603, 604, 605, 606
docs/plugins/message-presentation.md "Button value fallback visibility": 601, 602
docs/plugins/message-presentation.md "Provider mapping": 353, 601, 602, 604
docs/plugins/message-presentation.md "Presentation vs InteractiveReply": 607, 608
docs/plugins/message-presentation.md "Delivery pin": 605, 606, 609, 610
docs/plugins/message-presentation.md "Plugin author checklist": none
docs/plugins/message-presentation.md "Related docs": none
docs/tools/agent-send.md "Agent send": none
docs/tools/agent-send.md "Quick start": 611, 612
docs/tools/agent-send.md "Flags": none
docs/tools/agent-send.md "Behavior": 24, 26, 288, 585, 586, 611, 612, 613
docs/tools/agent-send.md "Examples": none
docs/tools/agent-send.md "Related": none
docs/gateway/restart-recovery.md "Restart recovery": 623
docs/gateway/restart-recovery.md "What survives a restart": 624, 625, 626, 627
docs/gateway/restart-recovery.md "Graceful restarts drain first": 628
docs/gateway/restart-recovery.md "Maintenance custody observations": none (owned by the gateway service)
docs/gateway/restart-recovery.md "Systemd stop deadlines": 629
docs/gateway/restart-recovery.md "Launchd stop deadlines": none (owned by the gateway service)
docs/gateway/restart-recovery.md "Host sleep and process freezes": 267, 268, 630
docs/gateway/restart-recovery.md "Recovery after a failed update": none (owned by update)
docs/gateway/restart-recovery.md "How interrupted work is detected": 547, 631, 632
docs/gateway/restart-recovery.md "Automatic resume": 623, 627, 633, 634, 635, 636, 637, 638, 641
docs/gateway/restart-recovery.md "Subagents": none (owned by sessions)
docs/gateway/restart-recovery.md "Agent-requested restarts": 639
docs/gateway/restart-recovery.md "Safety valves and observability": 237, 238, 634, 637, 640, 641
docs/gateway/restart-recovery.md "Verify recovery after an update": none (owned by update)
docs/gateway/restart-recovery.md "What is not resumed": 642
docs/gateway/config-agents/messages-and-talk.md "Configuration — messages and talk": none
docs/gateway/config-agents/messages-and-talk.md "Messages": none
docs/gateway/config-agents/messages-and-talk.md "Response prefix": 321
docs/gateway/config-agents/messages-and-talk.md "Ack reaction": 166, 614, 615, 616, 617, 618, 619, 620
docs/gateway/config-agents/messages-and-talk.md "Queue": 313
docs/gateway/config-agents/messages-and-talk.md "Inbound debounce": 305, 306, 307, 308, 309, 310
docs/gateway/config-agents/messages-and-talk.md "Other message keys": 73, 621, 622
docs/gateway/config-agents/messages-and-talk.md "TTS (text-to-speech)": none (owned by talk)
docs/gateway/config-agents/messages-and-talk.md "Talk": none (owned by talk)

## Breaks cross-check
Only records of kind known-broken whose change touches a production path inside the area globs are breaks here. Records of kind ordinary ([OpenClaw #155088](https://github.com/openclaw/openclaw/pull/155088), [OpenClaw #159197](https://github.com/openclaw/openclaw/pull/159197), [OpenClaw #153399](https://github.com/openclaw/openclaw/pull/153399), [OpenClaw #156367](https://github.com/openclaw/openclaw/pull/156367), [OpenClaw #151461](https://github.com/openclaw/openclaw/pull/151461), [OpenClaw #155573](https://github.com/openclaw/openclaw/pull/155573)) also touch area paths but are not breaks; run 1 counted them and they are not counted.

| Break | Phase | Note |
| --- | --- | --- |
| [OpenClaw #164230](https://github.com/openclaw/openclaw/pull/164230) | event-queued-turn-cancelled-plugin-work, event-inbound-while-run-active | In-area path src/auto-reply/reply/dispatch-from-config.lifecycle.ts. A queued channel turn is cancelled while the active turn's bound plugin work runs, then the conversation is reset; whether the active turn completes and the reset waits is recorded. Mapped by both runs; the dedicated phase comes from run 2 and the condition it needs is listed under Undocumented conditions. |
| [OpenClaw #138188](https://github.com/openclaw/openclaw/pull/138188) | event-polled-completion-not-renotified | In-area path src/auto-reply/reply/dispatch-from-config.finalize.ts. A channel turn polls a background process that already completed; whether the completion notice reaches the chat again is recorded. Mapped by both runs; condition listed under Undocumented conditions. |
| [OpenClaw #163850](https://github.com/openclaw/openclaw/pull/163850) | event-retired-teams-state-doctor, check-channel-status-under-states-1 | In-area paths under extensions/feishu, extensions/whatsapp and extensions/msteams. Doctor runs with retired Microsoft Teams JSON state on disk and its recovery guidance is recorded; the Feishu, WhatsApp and Teams runtime paths need real accounts and are outside reach. Mapped by both runs. |
| [OpenClaw #164989](https://github.com/openclaw/openclaw/pull/164989) | none | Outside reach: the duplicate replies and silent first turn happen only with a remote OpenClaw worker, which this template's environment does not provide. |
| [OpenClaw #165600](https://github.com/openclaw/openclaw/pull/165600) | none | Outside this template: the failing request is chat.send on an Incognito Control UI session, owned by sessions (bound); the in-area path dispatch-from-config.prepare-context.ts is exercised by every channel turn, which cannot produce an Incognito session. |
| [OpenClaw #166049](https://github.com/openclaw/openclaw/pull/166049) | none | Outside this template: the failure is the Control UI chat link for public threads under token or password auth, owned by sessions; the in-area X adapter paths need a real X account (outside reach). |

## Undocumented conditions
643. Background process completion already polled during a channel turn, notice not repeated: needed by [OpenClaw #138188](https://github.com/openclaw/openclaw/pull/138188), stated in no document
644. Retired Microsoft Teams JSON state on disk, doctor explains recovery: needed by [OpenClaw #163850](https://github.com/openclaw/openclaw/pull/163850), stated in no document
645. Queued channel turn cancelled while the active turn's bound plugin work runs: needed by [OpenClaw #164230](https://github.com/openclaw/openclaw/pull/164230), stated in no document

## Reconciliation
Entry points and conditions taken from only one run are listed one by one; operations, phases, persona traits and commands are summarised with every decision that changed or merged them.

### Entry points from one run only
Discord voice channels: from run 1 only; kept as a distinct excluded talk surface, separate from the Discord inbound monitor
Channels page route (/channels): from run 1 only; placed by run 1 in "Check channel status and health"; kept because reconciliation never drops an entry point either run found
DM access request: Sender details: from run 1 only; placed by run 1 in "Decide who may message the agent"; kept because reconciliation never drops an entry point either run found
openclaw agent --deliver: from run 1 only; placed by run 1 in "Deliver agent, cron, heartbeat and sub-agent output to a chat"; kept because reconciliation never drops an entry point either run found
Cron job delivery: from run 1 only; placed by run 1 in "Deliver agent, cron, heartbeat and sub-agent output to a chat"; kept because reconciliation never drops an entry point either run found
Heartbeat delivery: from run 1 only; placed by run 1 in "Deliver agent, cron, heartbeat and sub-agent output to a chat"; kept because reconciliation never drops an entry point either run found
Subagent announce to a channel: from run 1 only; placed by run 1 in "Deliver agent, cron, heartbeat and sub-agent output to a chat"; kept because reconciliation never drops an entry point either run found
extensions/buzz/README.md (openclaw channels, openclaw directory, openclaw message): from run 1 only; excluded by run 1 (documentation text, not a code path); kept so the entry point stays accounted for
extensions/clickclack/README.md (openclaw channels): from run 1 only; excluded by run 1 (documentation text, not a code path); kept so the entry point stays accounted for
extensions/matrix/CHANGELOG.md (openclaw channels, openclaw message): from run 1 only; excluded by run 1 (documentation text, not a code path); kept so the entry point stays accounted for
extensions/reef/README.md (openclaw channels): from run 1 only; excluded by run 1 (documentation text, not a code path); kept so the entry point stays accounted for
extensions/telegram/README.md (openclaw channels): from run 1 only; excluded by run 1 (documentation text, not a code path); kept so the entry point stays accounted for
extensions/zalouser/README.md (openclaw channels, openclaw directory, openclaw message): from run 1 only; excluded by run 1 (documentation text, not a code path); kept so the entry point stays accounted for
src/wizard/i18n/locales/en.ts (openclaw channels): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
src/wizard/i18n/locales/zh-CN.ts (openclaw channels): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
src/wizard/i18n/locales/zh-TW.ts (openclaw channels): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/ar.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/de.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/es.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/fa.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/fr.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/hi.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/id.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/it.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/ja-JP.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/ko.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/nl.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/pl.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/pt-BR.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/ru.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/th.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/tr.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/uk.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/vi.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/zh-CN.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
ui/src/i18n/.i18n/zh-TW.tm.jsonl ("channels.pairing.approve", "channels.pairing.dismiss"): from run 1 only; excluded by run 1 (translation strings, not a code path); kept so the entry point stays accounted for
Channel status, presence and health broadcast events to clients: from run 1 only; excluded by run 1 (internal: broadcast events are not entry points); kept so the entry point stays accounted for
plugins install triggered by channels add: from run 1 only; excluded by run 1 (consumed from plugins (bound)); kept so the entry point stays accounted for
/activation: from run 1 only; excluded by run 1 (owned by commands (bound: slash command parsing and execution)); kept so the entry point stays accounted for
/session unbind, /session idle, /session max-age, /agents (thread bindings): from run 1 only; excluded by run 1 (owned by sessions (bound: thread-bound subagent sessions)); kept so the entry point stays accounted for
openclaw devices / openclaw nodes / /pair (node and device pairing): from run 1 only; excluded by run 1 (owned by nodes (bound)); kept so the entry point stays accounted for
conversations_list / conversations_send / conversations_turn tools and conversations.* methods: from run 1 only; excluded by run 1 (owned by sessions (bound); files found by search that call them are listed above as from sessions); kept so the entry point stays accounted for
Exec and plugin approval delivery and approval reactions: from run 1 only; excluded by run 1 (owned by approvals (bound)); kept so the entry point stays accounted for
openclaw agents bind / unbind / bindings: from run 1 only; excluded by run 1 (owned by agents); kept so the entry point stays accounted for
openclaw gateway call channels.start / channels.stop: from run 1 only; excluded by run 1 (generic Gateway caller; the methods are listed above); kept so the entry point stays accounted for
chat.send and the Control UI chat: from run 1 only; excluded by run 1 (owned by sessions (bound: webchat is not a channel)); kept so the entry point stays accounted for
session.reactions.*: from run 1 only; excluded by run 1 (owned by sessions (bound); sessions-reactions.ts found by search is listed above); kept so the entry point stays accounted for
openclaw update --channel and release channels: from run 1 only; excluded by run 1 (owned by update (bound)); kept so the entry point stays accounted for
Adapter-specific features on docs/channels/<id>.md pages (whatsapp_login tool, matrix verify, Slack slash command, Discord components): from run 1 only; excluded by run 1 (outside this template (bound: adapter pages are not read)); kept so the entry point stays accounted for
DM access requests refresh: from run 2 only; placed by run 2 in "Decide who may message the agent"; kept because reconciliation never drops an entry point either run found
Setup wizard reveal secret toggle: from run 2 only; placed by run 2 in "Set up a channel account"; kept because reconciliation never drops an entry point either run found
Nostr profile HTTP routes (PUT profile, POST profile import): from run 2 only; placed by run 2 in "Set the bot's profile and presence"; kept because reconciliation never drops an entry point either run found
plugins.list (Channels page plugin presentation): from run 2 only; excluded by run 2 (consumed from plugins); kept so the entry point stays accounted for
kova.channelProbe.status, reset, inject, observations: from run 2 only; excluded by run 2 (harness, not an entry point (bound): Kova conformance channel); kept so the entry point stays accounted for
config/test-mock-exports-baseline.txt: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
qa/scenarios/channels/native-command-session-target.yaml: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
qa/scenarios/channels/telegram-startup-getme-live.yaml: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
qa/scenarios/channels/telegram-startup-getme-outcomes.yaml: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
qa/scenarios/ui/control-ui-assistant-transcript-role-boundary.yaml: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
qa/scenarios/ui/control-ui-qa-channel-image-roundtrip.yaml: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
scripts/audit-seams.mts: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
scripts/auth-monitor.sh: from run 2 only; placed by run 2 in "Send a message to a chat"; kept because reconciliation never drops an entry point either run found
scripts/check-deprecated-api-usage.mts: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
scripts/check-no-deprecated-channel-access.ts: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
scripts/check-no-pairing-store-group-auth.mts: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
scripts/check-pairing-account-scope.mts: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
scripts/control-ui-mock-dev.ts: from run 2 only; excluded by run 2 (test-only (mock Gateway for UI development)); kept so the entry point stays accounted for
scripts/dev/discord-acp-plain-language-smoke.ts: from run 2 only; excluded by run 2 (test-only (development smoke script)); kept so the entry point stays accounted for
scripts/lib/plugin-sdk-shipped-surface.json: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
scripts/run-openclaw-podman.sh: from run 2 only; excluded by run 2 (internal: names the command in a usage comment only); kept so the entry point stays accounted for
security/opengrep/precise.yml: from run 2 only; excluded by run 2 (internal: lint and audit tooling, no runtime path); kept so the entry point stays accounted for
taxonomy.yaml: from run 2 only; excluded by run 2 (internal: documentation metadata, no runtime path); kept so the entry point stays accounted for
appcast.xml: from run 2 only; excluded by run 2 (internal: release-notes text, no runtime path); kept so the entry point stays accounted for
appcast-arm64.xml: from run 2 only; excluded by run 2 (internal: release-notes text, no runtime path); kept so the entry point stays accounted for
appcast-x86_64.xml: from run 2 only; excluded by run 2 (internal: release-notes text, no runtime path); kept so the entry point stays accounted for
test/type-contracts/plugin-service-scheduling.ts: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for
src/plugin-sdk/plugin-state-test-runtime.ts: from run 2 only; excluded by run 2 (test-only); kept so the entry point stays accounted for

### Entry points one run placed and the other excluded
apps/macos/Sources/OpenClaw/AppState.swift (enqueueDelivery): placed by run 1 in "Deliver agent, cron, heartbeat and sub-agent output to a chat", excluded by run 2 (internal: enqueueDelivery there is an unrelated voice-wake trigger method; no call into this area); placed in "Deliver agent, cron, heartbeat and sub-agent output to a chat", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
extensions/policy/src/doctor/strictness.ts (resolveAgentRoute): placed by run 1 in "Message the agent from a chat app", excluded by run 2 (internal: resolveAgentRoute appears only in a comment); placed in "Message the agent from a chat app", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/agents/credential-safety-prompt.ts (openclaw channels): placed by run 1 in "Set up a channel account", excluded by run 2 (internal: names the command in prompt guidance only); placed in "Set up a channel account", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/cli/error-format.ts (openclaw channels): placed by run 1 in "Check channel status and health", excluded by run 2 (internal: names the command in an error hint only); placed in "Check channel status and health", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/cli/program/help.ts (openclaw channels, openclaw message): placed by run 1 in "Check channel status and health", excluded by run 2 (internal: names the command in help text only); placed in "Check channel status and health", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/commands/agents.commands.list.ts (openclaw channels): placed by run 1 in "Check channel status and health", excluded by run 2 (internal: names the command in a hint only); placed in "Check channel status and health", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/commands/doctor-command-owner.ts (openclaw channels): placed by run 1 in "Approve or dismiss a DM access request", excluded by run 2 (internal: names the command in a doctor hint only); placed in "Decide who may message the agent", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/commands/doctor/cron/warnings.ts (openclaw channels): placed by run 1 in "Deliver agent, cron, heartbeat and sub-agent output to a chat", excluded by run 2 (internal: names the command in a doctor hint only); placed in "Deliver agent, cron, heartbeat and sub-agent output to a chat", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/commands/setup.ts (openclaw channels): placed by run 1 in "Set up a channel account", excluded by run 2 (internal: names the command in a setup hint only); placed in "Set up a channel account", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/commands/status.scan.gateway.ts (openclaw channels): placed by run 1 in "Check channel status and health", excluded by run 2 (internal: names the command in a status hint only); placed in "Check channel status and health", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/gateway/server-startup-log.ts (openclaw channels): placed by run 1 in "Check channel status and health", excluded by run 2 (internal: names the command in a startup log hint only); placed in "Check channel status and health", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/gateway/worker-environments/repository-project-admission.ts (openclaw directory): placed by run 1 in "Look up channel ids and names", excluded by run 2 (internal: the literal matches ".openclaw directory" in a comment; no call into this area); placed in "Look up contacts, groups and ids", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/plugins/compat/channel-pairing-record.ts (readChannelAllowFromStore): placed by run 1 in "Approve or dismiss a DM access request", excluded by run 2 (deprecated: compatibility record text for a deprecated SDK reader); placed in "Decide who may message the agent", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/plugins/compat/deprecation-marking.ts (dispatchReplyFromConfig): placed by run 1 in "Message the agent from a chat app", excluded by run 2 (deprecated: compatibility record text for a deprecated SDK entry); placed in "Message the agent from a chat app", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/plugins/compat/registry-records.ts (getSessionBindingService): placed by run 1 in "Bind a chat conversation to a session or agent", excluded by run 2 (deprecated: compatibility record text for a deprecated SDK entry); placed in "Bind a chat conversation to a session or agent", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/plugins/compat/session-persistence-records.ts (resolveAgentRoute): placed by run 1 in "Message the agent from a chat app", excluded by run 2 (deprecated: compatibility record text for a deprecated SDK entry); placed in "Message the agent from a chat app", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/plugins/hook-types.ts (openclaw pairing): placed by run 1 in "Approve or dismiss a DM access request", excluded by run 2 (internal: names the command in a type comment only); placed in "Decide who may message the agent", because step 8 places an entry point one run placed and the other excluded, and the search list found the file
src/system-agent/operations-execute.ts (openclaw channels): placed by run 1 in "Set up a channel account", excluded by run 2 (internal: names the command in a reply hint only); placed in "Set up a channel account", because step 8 places an entry point one run placed and the other excluded, and the search list found the file

### Entry points the runs placed in different operations
openclaw channels capabilities: run 1 placed it in "Check channel status and health", run 2 in "Check what a channel account can do"; placed in "Check what a channel account can do" because run 2's finer operation has its own entry-point family
openclaw channels logs: run 1 placed it in "Check channel status and health", run 2 in "Read channel logs"; placed in "Read channel logs" because run 2's finer operation has its own entry-point family
openclaw message broadcast: run 1 placed it in "Send a message to a chat", run 2 in "Send one message to several chats"; placed in "Send one message to several chats" because run 2's finer operation has its own entry-point family
openclaw message emoji list: run 1 placed it in "React to messages", run 2 in "Use and upload emoji and stickers"; placed in "Use and upload emoji and stickers" because the CLI command family openclaw message emoji holds both list and upload
openclaw message permissions: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message edit: run 1 placed it in "Read, edit, delete or search chat messages", run 2 in "Edit, delete or unsend a sent message"; placed in "Edit, delete or unsend a sent message" because run 2's finer operation has its own entry-point family
openclaw message delete: run 1 placed it in "Read, edit, delete or search chat messages", run 2 in "Edit, delete or unsend a sent message"; placed in "Edit, delete or unsend a sent message" because run 2's finer operation has its own entry-point family
openclaw message role info: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message role add: run 1 placed it in "Moderate members", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Moderate members" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message role remove: run 1 placed it in "Moderate members", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Moderate members" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message channel info: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message channel list: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message member info: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
openclaw message voice status: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Check who is in a voice channel"; placed in "Check who is in a voice channel" because run 2's finer operation has its own entry-point family
openclaw message event list: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Schedule and list server events"; placed in "Schedule and list server events" because run 2's finer operation has its own entry-point family
openclaw message event create: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Schedule and list server events"; placed in "Schedule and list server events" because run 2's finer operation has its own entry-point family
Channel config form fields: run 1 placed it in "Set up a channel account", run 2 in "Edit a channel's settings on the Channels page"; placed in "Edit a channel's settings on the Channels page" because run 2's finer operation has its own entry-point family
Channel config: Save: run 1 placed it in "Set up a channel account", run 2 in "Edit a channel's settings on the Channels page"; placed in "Edit a channel's settings on the Channels page" because run 2's finer operation has its own entry-point family
Channel config: Reload: run 1 placed it in "Set up a channel account", run 2 in "Edit a channel's settings on the Channels page"; placed in "Edit a channel's settings on the Channels page" because run 2's finer operation has its own entry-point family
message tool action broadcast: run 1 placed it in "Send a message to a chat", run 2 in "Send one message to several chats"; placed in "Send one message to several chats" because run 2's finer operation has its own entry-point family
message tool action edit: run 1 placed it in "Read, edit, delete or search chat messages", run 2 in "Edit, delete or unsend a sent message"; placed in "Edit, delete or unsend a sent message" because run 2's finer operation has its own entry-point family
message tool action unsend: run 1 placed it in "Read, edit, delete or search chat messages", run 2 in "Edit, delete or unsend a sent message"; placed in "Edit, delete or unsend a sent message" because run 2's finer operation has its own entry-point family
message tool action sendAttachment: run 1 placed it in "Transfer files through a chat", run 2 in "Send a message to a chat"; placed in "Transfer files through a chat" because an attachment send is a file transfer
message tool action delete: run 1 placed it in "Read, edit, delete or search chat messages", run 2 in "Edit, delete or unsend a sent message"; placed in "Edit, delete or unsend a sent message" because run 2's finer operation has its own entry-point family
message tool action permissions: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action member-info: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action role-info: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action emoji-list: run 1 placed it in "React to messages", run 2 in "Use and upload emoji and stickers"; placed in "Use and upload emoji and stickers" because it lists emoji, the family of the emoji and sticker operation
message tool action role-add: run 1 placed it in "Moderate members", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Moderate members" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action role-remove: run 1 placed it in "Moderate members", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Moderate members" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action channel-info: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action channel-list: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Look up a server's channels, roles, members and permissions" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action channel-create: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action channel-edit: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action channel-delete: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action channel-move: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action category-create: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action category-edit: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action category-delete: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Inspect and manage a server's channels, roles and members"; placed in "Manage a server's channels and categories" because run 1's finer server operations are kept: reading a server, changing its channels and categories, and moderating members
message tool action voice-status: run 1 placed it in "Look up a server's channels, roles, members and permissions", run 2 in "Check who is in a voice channel"; placed in "Check who is in a voice channel" because run 2's finer operation has its own entry-point family
message tool action event-list: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Schedule and list server events"; placed in "Schedule and list server events" because run 2's finer operation has its own entry-point family
message tool action event-create: run 1 placed it in "Manage a server's channels, categories and events", run 2 in "Schedule and list server events"; placed in "Schedule and list server events" because run 2's finer operation has its own entry-point family
Channel ingress drain poll: run 1 placed it in "Inspect and resubmit failed inbound events", run 2 in "Have pending deliveries and inbound events recovered"; placed in "Have pending deliveries and inbound events recovered" because the drain poll is a scheduled recovery job like the other two queue jobs
extensions/admin-http-rpc/src/methods.ts ("channels.logout", "channels.start", "channels.status", "channels.stop", "web.login.start", "web.login.wait"): run 1 placed it in "Stop, start or recover a channel account", run 2 in "Check which channels are connected and healthy"; placed in "Stop, start or recover a channel account" because the admin HTTP methods start and stop accounts besides reading status
src/auto-reply/reply/commands-private-route.ts (routeReply): run 1 placed it in "Use a channel's native command menu", run 2 in "Send a message to a chat"; placed in "Use a channel's native command menu" because the private route answers native command invocations
src/auto-reply/reply/commands-reset-hooks.ts (routeReply): run 1 placed it in "Use a channel's native command menu", run 2 in "Send a message to a chat"; placed in "Use a channel's native command menu" because the reset hook answers native command invocations
src/auto-reply/reply/followup-delivery.ts (routeReply): run 1 placed it in "Deliver agent, cron, heartbeat and sub-agent output to a chat", run 2 in "Message the agent from a chat app"; placed in "Message the agent from a chat app" because follow-up delivery routes the reply of a channel turn back to its chat
src/auto-reply/reply/session.ts (getSessionBindingService): run 1 placed it in "Message the agent from a chat app", run 2 in "Keep a chat thread bound to its session"; placed in "Bind a chat conversation to a session or agent" because the session lookup resolves conversation bindings
src/flows/channel-setup.prompts.ts (openclaw pairing): run 1 placed it in "Approve or dismiss a DM access request", run 2 in "Connect a channel account"; placed in "Set up a channel account" because the file belongs to the channel setup flow
src/flows/channel-setup.status.ts (openclaw pairing): run 1 placed it in "Approve or dismiss a DM access request", run 2 in "Connect a channel account"; placed in "Set up a channel account" because the file belongs to the channel setup flow
src/gateway/server-restart-sentinel-notice.ts (deliverOutboundPayloads, deliverOutboundPayloadsInternal, drainPendingDeliveriesCore, runOutboundDelivery, sendDurableMessageBatchCore): run 1 placed it in "Recover undelivered replies after a restart", run 2 in "Get a reply delivered from a job, heartbeat or another agent"; placed in "Have pending deliveries and inbound events recovered" because the restart notice is delivered by the restart recovery path
src/gateway/server-restart-sentinel.ts (enqueueSessionDelivery): run 1 placed it in "Recover undelivered replies after a restart", run 2 in "Get a reply delivered from a job, heartbeat or another agent"; placed in "Have pending deliveries and inbound events recovered" because the restart notice is delivered by the restart recovery path
src/infra/approval-gateway-runtime.types.ts (method: "send"): run 1 placed it in "Send a message to a chat", run 2 in "Get a reply delivered from a job, heartbeat or another agent"; placed in "Send a message to a chat" because the type names the send method
src/infra/exec-control-command-guard.ts (openclaw channels): run 1 placed it in "Check channel status and health", run 2 in "Link a channel account by QR or interactive login"; placed in "Check channel status and health" because the guard names channel commands that status and login share; run 1 kept it with status
src/plugin-sdk/conversation-runtime.ts (getSessionBindingService, readChannelAllowFromStore, registerSessionBindingAdapter, upsertChannelPairingRequest): run 1 placed it in "Approve or dismiss a DM access request", run 2 in "Keep a chat thread bound to its session"; placed in "Bind a chat conversation to a session or agent" because the file registers the session binding adapter that binding phases exercise
src/security/audit-channel.ts (resolveAgentRoute): run 1 placed it in "Change who may message the agent", run 2 in "Route chats to agents with bindings"; placed in "Decide who may message the agent" because the security audit reports allowlist and route access, which is who may message the agent
ui/src/lib/channels/index.ts ("channels.logout", "channels.pairing.approve", "channels.pairing.dismiss", "channels.pairing.list", "channels.status", "web.login.start", "web.login.wait"): run 1 placed it in "Approve or dismiss a DM access request", run 2 in "Check which channels are connected and healthy"; placed in "Check channel status and health" because it is the Channels page data layer that the status view reads first

### Conditions from one run only
16. Bot-authored inbound accepted (allowBots): from run 2 only; documented under docs/channels/index.md "Delivery notes"; kept because reconciliation keeps every condition either run found
19. DM pairing and allowlists enforced on unknown senders: from run 1 only; documented under docs/channels/index.md "Notes"; kept because reconciliation keeps every condition either run found
53. Inbound reply to an earlier message carries reply context: from run 2 only; documented under docs/channels/channel-routing.md "Reply context"; kept because reconciliation keeps every condition either run found
55. Group replies require a mention (requireMention default): from run 1 only; documented under docs/channels/groups.md "Beginner intro (2 minutes)"; kept because reconciliation keeps every condition either run found
63. Bot replied in a thread someone else created, not treated as creator: from run 2 only; documented under docs/channels/groups.md "Bot-created threads"; kept because reconciliation keeps every condition either run found
69. Google Chat interaction webhook gives no unmentioned messages or thread owners: from run 1 only; documented under docs/channels/groups.md "Bot-created threads"; kept because reconciliation keeps every condition either run found
77. Verbose on for a channel session, tool and progress summaries posted: from run 2 only; documented under docs/channels/groups.md "Visible replies"; kept because reconciliation keeps every condition either run found
82. contextVisibility all: supplemental context kept as received: from run 1 only; documented under docs/channels/groups.md "Context visibility and allowlists"; kept because reconciliation keeps every condition either run found
89. Signal groupAllowFrom matching group id or sender: from run 1 only; documented under docs/channels/groups.md "Group policy"; kept because reconciliation keeps every condition either run found
109. Restricted sender's turn delegated or queued keeps the restriction: from run 2 only; documented under docs/channels/groups.md "Group/channel tool restrictions (optional)"; kept because reconciliation keeps every condition either run found
111. Wildcard group entry allowing all groups with default mention behaviour: from run 1 only; documented under docs/channels/groups.md "Group allowlists"; kept because reconciliation keeps every condition either run found
115. Channel table mode does not preserve tables, Markdown tables discouraged: from run 1 only; documented under docs/channels/groups.md "Context fields"; kept because reconciliation keeps every condition either run found
117. WhatsApp group not in channels.whatsapp.groups dropped with a log hint: from run 1 only; documented under docs/channels/group-messages.md "Behavior"; kept because reconciliation keeps every condition either run found
120. Pending group context injected and cleared after the run: from run 2 only; documented under docs/channels/group-messages.md "Behavior"; kept because reconciliation keeps every condition either run found
123. Bot's own delivered message echoed back skipped: from run 2 only; documented under docs/channels/group-messages.md "Known considerations"; kept because reconciliation keeps every condition either run found
124. Allowed group that has never triggered a run has no session row: from run 2 only; documented under docs/channels/group-messages.md "Known considerations"; kept because reconciliation keeps every condition either run found
128. Qualified WhatsApp broadcast key takes precedence over unqualified: from run 1 only; documented under docs/channels/broadcast-groups.md "Agent group threads"; kept because reconciliation keeps every condition either run found
135. Sibling finals over the digest limits: from run 2 only; documented under docs/channels/broadcast-groups.md "Bounded follow-up rounds"; kept because reconciliation keeps every condition either run found
141. Legacy agents.list roster awaiting doctor --fix before broadcast membership resolves: from run 1 only; documented under docs/channels/broadcast-groups.md "Basic setup"; kept because reconciliation keeps every condition either run found
142. WhatsApp audio transcribed once before broadcast fan-out: from run 1 only; documented under docs/channels/broadcast-groups.md "Message flow"; kept because reconciliation keeps every condition either run found
143. Broadcast delivery and hooks use the responding participant's session and media roots: from run 1 only; documented under docs/channels/broadcast-groups.md "Session isolation"; kept because reconciliation keeps every condition either run found
148. Access group defined but referenced by no allowlist grants nothing: from run 2 only; documented under docs/channels/access-groups.md "Access groups"; kept because reconciliation keeps every condition either run found
149. Static access group with shared (*) members: from run 1 only; documented under docs/channels/access-groups.md "Static message sender groups"; kept because reconciliation keeps every condition either run found
153. Per-room allowlist referencing an access group: from run 2 only; documented under docs/channels/access-groups.md "Reference groups from allowlists"; kept because reconciliation keeps every condition either run found
159. Invalid allowlist and policy combination reported by doctor: from run 2 only; documented under docs/channels/access-groups.md "Troubleshooting"; kept because reconciliation keeps every condition either run found
160. room_event set on a channel without ambient support keeps existing group behaviour: from run 1 only; documented under docs/channels/ambient-room-events.md "Ambient room events (introduction)"; kept because reconciliation keeps every condition either run found
168. Slack channel allowlist keyed by name instead of ID never matches: from run 2 only; documented under docs/channels/ambient-room-events.md "Slack example"; kept because reconciliation keeps every condition either run found
175. Shared botLoopProtection defaults under channels.defaults: from run 1 only; documented under docs/channels/bot-loop-protection.md "Configure shared defaults"; kept because reconciliation keeps every condition either run found
183. Outbound location payload (pin or venue) sent with message send: from run 1 only; documented under docs/channels/location.md "Outbound payloads"; kept because reconciliation keeps every condition either run found
194. Manually allowlisted non-owner sends an owner-only command: from run 1 only; documented under docs/channels/pairing.md "Approve from the CLI"; kept because reconciliation keeps every condition either run found
197. Connected channel account probe reports works or audit ok: from run 1 only; documented under docs/channels/troubleshooting.md "Command ladder"; kept because reconciliation keeps every condition either run found
242. Workspace-scoped channel plugin discovered through the selected agent's workspace: from run 1 only; documented under docs/cli/channels.md "Common commands"; kept because reconciliation keeps every condition either run found
254. Third-party channel plugin on the legacy shared setup adapter: from run 2 only; documented under docs/cli/channels.md "Add / remove accounts"; kept because reconciliation keeps every condition either run found
255. Guided channels add in a non-TTY shell exits immediately: from run 2 only; documented under docs/cli/channels.md "Add / remove accounts"; kept because reconciliation keeps every condition either run found
260. Remote-mode Gateway: login saves auth locally: from run 1 only; documented under docs/cli/channels.md "Login and logout (interactive)"; kept because reconciliation keeps every condition either run found
265. Interactive channel login from agent exec blocked: from run 2 only; documented under docs/cli/channels.md "Login and logout (interactive)"; kept because reconciliation keeps every condition either run found
272. Unsupported channel account skipped at start: from run 2 only; documented under docs/cli/channels.md "Per-account recovery (non-destructive)"; kept because reconciliation keeps every condition either run found
276. Automatic start suppressed (autostart-suppressed): from run 2 only; documented under docs/cli/channels.md "Per-account recovery (non-destructive)"; kept because reconciliation keeps every condition either run found
277. Automatic start suppressed (ambient-suppressed): from run 2 only; documented under docs/cli/channels.md "Per-account recovery (non-destructive)"; kept because reconciliation keeps every condition either run found
279. Channel without live capability checks reports check unavailable: from run 1 only; documented under docs/cli/channels.md "Capabilities check"; kept because reconciliation keeps every condition either run found
282. Gateway-owned message action while the Gateway is unreachable fails: from run 2 only; documented under docs/cli/message.md "Channel selection"; kept because reconciliation keeps every condition either run found
287. Unresolved SecretRef on the selected channel fails closed: from run 2 only; documented under docs/cli/message.md "SecretRef resolution"; kept because reconciliation keeps every condition either run found
300. Listing pairing requests prunes expired or excess requests: from run 1 only; documented under docs/cli/pairing.md "openclaw pairing"; kept because reconciliation keeps every condition either run found
302. Senders approved before first-owner bootstrap with no command owner, doctor warns: from run 1 only; documented under docs/cli/pairing.md "Owner bootstrap"; kept because reconciliation keeps every condition either run found
312. Structured history, reply, forwarded and channel metadata rendered as untrusted context: from run 1 only; documented under docs/concepts/messages.md "Prompt bodies and history context"; kept because reconciliation keeps every condition either run found
319. QQ Bot block replies streaming unless its streaming mode is off: from run 2 only; documented under docs/concepts/messages.md "Streaming, chunking, and batching"; kept because reconciliation keeps every condition either run found
323. Explicit send already carrying the prefix not duplicated: from run 2 only; documented under docs/concepts/messages.md "Prefixes, threading, and replies"; kept because reconciliation keeps every condition either run found
325. NO_REPLY token in a channel session never delivered as text: from run 1 only; documented under docs/concepts/messages.md "Silent replies"; kept because reconciliation keeps every condition either run found
328. Retired internal silentReply setting removed by doctor: from run 2 only; documented under docs/concepts/messages.md "Silent replies"; kept because reconciliation keeps every condition either run found
331. Delivery already confirmed or owned when reply recovery runs, no duplicate: from run 2 only; documented under docs/concepts/messages.md "Silent replies"; kept because reconciliation keeps every condition either run found
332. Preview streaming active, temporary preview edited while reply generates: from run 1 only; documented under docs/concepts/streaming.md "Streaming and chunking (introduction)"; kept because reconciliation keeps every condition either run found
333. Block streaming flushing on each text_end: from run 1 only; documented under docs/concepts/streaming.md "Block streaming (channel messages)"; kept because reconciliation keeps every condition either run found
345. Block streaming off (default), final replies only: from run 1 only; documented under docs/concepts/streaming.md ""Stream chunks or everything""; kept because reconciliation keeps every condition either run found
353. Microsoft Teams or Mattermost block mode, rotating posts without native preview: from run 2 only; documented under docs/concepts/streaming.md "Preview streaming modes"; kept because reconciliation keeps every condition either run found
354. Slack native streaming transport in partial mode: from run 1 only; documented under docs/concepts/streaming.md "Channel mapping"; kept because reconciliation keeps every condition either run found
355. Slack top-level DMs without a reply thread show no thread-style preview: from run 1 only; documented under docs/concepts/streaming.md "Channel mapping"; kept because reconciliation keeps every condition either run found
375. Progress card replacing plan state in a channel draft: from run 1 only; documented under docs/concepts/streaming.md "Progress draft rendering"; kept because reconciliation keeps every condition either run found
380. Standalone tool-progress messages suppressed while a progress draft is active: from run 1 only; documented under docs/concepts/progress-drafts.md "Quick start"; kept because reconciliation keeps every condition either run found
385. Model preamble used as progress status headline: from run 1 only; documented under docs/concepts/progress-drafts.md "Status headline"; kept because reconciliation keeps every condition either run found
387. No utility model or narration off, no filler headline: from run 2 only; documented under docs/concepts/progress-drafts.md "Status headline"; kept because reconciliation keeps every condition either run found
393. Final answer with an approval prompt sent through normal delivery: from run 2 only; documented under docs/concepts/progress-drafts.md "Finalization"; kept because reconciliation keeps every condition either run found
405. Per-agent typingMode override: from run 1 only; documented under docs/concepts/typing-indicators.md "Configuration"; kept because reconciliation keeps every condition either run found
417. Slack angle-bracket tokens surviving escaping: from run 1 only; documented under docs/concepts/markdown-formatting.md "Common gotchas"; kept because reconciliation keeps every condition either run found
418. Channel send transient failure retried per request with jittered backoff: from run 1 only; documented under docs/concepts/retry.md "Defaults"; kept because reconciliation keeps every condition either run found
424. Telegram text send proven not started retried: from run 2 only; documented under docs/concepts/retry.md "Telegram"; kept because reconciliation keeps every condition either run found
438. Feishu clearAll reaction semantics: from run 2 only; documented under docs/tools/reactions.md "Channel behavior"; kept because reconciliation keeps every condition either run found
448. Per-provider commands.allowFrom as the only command authorization source: from run 1 only; documented under docs/gateway/config-channels/commands.md "Commands (chat command handling)"; kept because reconciliation keeps every condition either run found
453. Harness default visible-reply mode applies to direct chats only: from run 2 only; documented under docs/gateway/config-channels/mention-gating-and-history.md "Group chat mention gating"; kept because reconciliation keeps every condition either run found
472. Persistent ACP binding on a channel conversation: from run 1 only; documented under docs/gateway/config-channels/personal-messaging.md "WhatsApp"; kept because reconciliation keeps every condition either run found
482. iMessage send transport falls back from IMCore bridge to AppleScript: from run 2 only; documented under docs/gateway/config-channels/personal-messaging.md "iMessage"; kept because reconciliation keeps every condition either run found
486. Remote imsg v0.13.4 limits (poll votes need pollOptionId; no attachment replies to nonzero parts): from run 2 only; documented under docs/gateway/config-channels/personal-messaging.md "iMessage"; kept because reconciliation keeps every condition either run found
488. Discord action groups toggled gate message tool actions: from run 2 only; documented under docs/gateway/config-channels/community-chat.md "Discord"; kept because reconciliation keeps every condition either run found
502. Matrix private-network homeserver: from run 2 only; documented under docs/gateway/config-channels/community-chat.md "Matrix"; kept because reconciliation keeps every condition either run found
504. Matrix autoJoin allowlist or always joins invited rooms: from run 2 only; documented under docs/gateway/config-channels/community-chat.md "Matrix"; kept because reconciliation keeps every condition either run found
507. Google Chat service account from inline JSON, file or SecretRef: from run 2 only; documented under docs/gateway/config-channels/workplace-chat.md "Google Chat"; kept because reconciliation keeps every condition either run found
513. Slack group DM the app never joined unseen: from run 1 only; documented under docs/gateway/config-channels/workplace-chat.md "Slack"; kept because reconciliation keeps every condition either run found
518. Temporary Slack typing reaction on the inbound message while a reply runs: from run 1 only; documented under docs/gateway/config-channels/workplace-chat.md "Slack"; kept because reconciliation keeps every condition either run found
529. Native command authorization revoked during binding preparation blocks next effect: from run 1 only; documented under docs/plugins/sdk-channel-inbound.md "Core helpers"; kept because reconciliation keeps every condition either run found
532. Plugin using deprecated MediaPath/MediaUrls context fields: from run 1 only; documented under docs/plugins/sdk-channel-inbound.md "Core helpers"; kept because reconciliation keeps every condition either run found
536. Legacy Provider labels translated to InternalTurnSource: from run 1 only; documented under docs/plugins/sdk-channel-inbound.md "Internal turn sources"; kept because reconciliation keeps every condition either run found
554. Execution-identity audit collection enabled: from run 2 only; documented under docs/plugins/sdk-channel-ingress.md "Result"; kept because reconciliation keeps every condition either run found
555. Queued turn mixing several participants or stale evidence, attribution unknown: from run 2 only; documented under docs/plugins/sdk-channel-ingress.md "Result"; kept because reconciliation keeps every condition either run found
558. Per-message authentication map missing a field treated as unverified: from run 2 only; documented under docs/plugins/sdk-channel-ingress.md "Identifier authentication"; kept because reconciliation keeps every condition either run found
559. Third-party plugin on deprecated dangerous or mutableIdentifierMatching fields: from run 2 only; documented under docs/plugins/sdk-channel-ingress.md "Identifier authentication"; kept because reconciliation keeps every condition either run found
562. Sender not in a room's sender allowlist blocked by route gate: from run 1 only; documented under docs/plugins/sdk-channel-ingress.md "Routes and activation"; kept because reconciliation keeps every condition either run found
564. Raw sender values and allowlist entries kept out of resolved state and diagnostics: from run 1 only; documented under docs/plugins/sdk-channel-ingress.md "Redaction"; kept because reconciliation keeps every condition either run found
569. Ingress delivery deferred, claim held until adoption: from run 2 only; documented under docs/plugins/sdk-channel-outbound.md "Durable ingress monitors"; kept because reconciliation keeps every condition either run found
571. Ingress delivery failing, cancelled or abandoned before adoption: from run 2 only; documented under docs/plugins/sdk-channel-outbound.md "Durable ingress monitors"; kept because reconciliation keeps every condition either run found
576. Preview retained after accepted error final or unused preview with no final: from run 2 only; documented under docs/plugins/sdk-channel-outbound.md "Progress and preview delivery ownership"; kept because reconciliation keeps every condition either run found
580. Batch parts landing in conflicting provider threads: from run 2 only; documented under docs/plugins/sdk-channel-outbound.md "Delivery Evidence"; kept because reconciliation keeps every condition either run found
586. Batch mixing sent, suppressed and failed payloads with per-payload outcomes: from run 2 only; documented under docs/plugins/sdk-channel-outbound.md "Durable sends"; kept because reconciliation keeps every condition either run found
592. Command button or select option clicked runs the native command: from run 2 only; documented under docs/plugins/message-presentation.md "Contract"; kept because reconciliation keeps every condition either run found
593. Callback button or select option clicked delivers opaque plugin data: from run 2 only; documented under docs/plugins/message-presentation.md "Contract"; kept because reconciliation keeps every condition either run found
608. Divider-only presentation: from run 2 only; documented under docs/plugins/message-presentation.md "Presentation vs InteractiveReply"; kept because reconciliation keeps every condition either run found
612. Agent reply delivered to a different channel or account than its session: from run 2 only; documented under docs/tools/agent-send.md "Quick start"; kept because reconciliation keeps every condition either run found
614. Acknowledgment reaction placed on an admitted inbound message: from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
615. Acknowledgment reactions disabled (ackReaction empty or scope off): from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
616. Ack scope group-mentions (default): from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
617. Ack scope group-all: from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
618. Ack scope direct: from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
619. WhatsApp with messages.ackReaction unset sends no acknowledgment: from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
620. Lifecycle status reactions enabled: from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Ack reaction"; kept because reconciliation keeps every condition either run found
621. Retired WhatsApp inbound messagePrefix awaiting doctor move to responsePrefix: from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Other message keys"; kept because reconciliation keeps every condition either run found
622. Per-reply usage footer (messages.responseUsage): from run 1 only; documented under docs/gateway/config-agents/messages-and-talk.md "Other message keys"; kept because reconciliation keeps every condition either run found
631. Channel turn in flight on a main session records recovery delivery claim: from run 2 only; documented under docs/gateway/restart-recovery.md "How interrupted work is detected"; kept because reconciliation keeps every condition either run found
633. Final reply produced but undelivered before restart included in resumed turn: from run 1 only; documented under docs/gateway/restart-recovery.md "Automatic resume"; kept because reconciliation keeps every condition either run found
636. Channel without guarded typing hook during recovery sends notice only: from run 2 only; documented under docs/gateway/restart-recovery.md "Automatic resume"; kept because reconciliation keeps every condition either run found
645. Queued channel turn cancelled while the active turn's bound plugin work runs: from run 2 only; added for a known break and stated in no document (see Undocumented conditions); kept because reconciliation keeps every condition either run found

### Operations
"Edit a channel's settings on the Channels page": from run 2 only as a separate operation (run 1 grouped its controls under setting up an account); kept because the channel config form controls are a family of their own on the Channels page.
"Check what a channel account can do" and "Read channel logs": from run 2 only as separate operations; kept because each has its own CLI command (openclaw channels capabilities, openclaw channels logs).
"Send one message to several chats": from run 2 only as a separate operation; kept because openclaw message broadcast is its own CLI command.
"Read and search a chat's history" and "Edit, delete or unsend a sent message": from run 2 only, replacing run 1's single read, edit, delete and search operation; kept because read and search, and edit and delete, are separate CLI commands.
"Schedule and list server events" and "Check who is in a voice channel": from run 2 only as separate operations; kept because openclaw message event and openclaw message voice are their own CLI commands.
"Look up a server's channels, roles, members and permissions", "Manage a server's channels and categories" and "Moderate members": run 1's finer split of run 2's single server operation is kept (reading a server, changing its structure, moderating members, the last including role add and remove).
"Use and upload emoji and stickers": run 2's grouping is kept, so emoji list joins emoji upload under one CLI command family; run 1 had placed emoji list with reactions.
"Decide who may message the agent": run 2's coarser operation is kept; run 1's separate "Change who may message the agent" had no entry-point family of its own.
"Message the agent from a chat app": run 1's coarser operation is kept; run 2's "Route chats to agents with bindings" had no entry-point family of its own.
"React to messages": run 1's coarser operation is kept; run 2's "React to the agent's message in a chat" is one channel route without a family of its own.
"Have pending deliveries and inbound events recovered": run 2's name and grouping are kept, so the channel ingress drain poll joins the two delivery queue recovery jobs.
Every other operation was found by both runs; the reconciled name is the clearer of the two.

### Phases
Template totals: 533 phases (2 setup, 162 operation, 369 event). These are commands to be recorded by a future run, not observations from an executed template.
The two setup phases retain the recorded several-channels and held-turn conditions. The held-turn wrapper has an explicit admission-only startup timeout and a later bounded join that releases the mock response; it must report interruptions across Gateway restarts, rather than claiming that the same turn remains active through them.
The operation choices retain the finer command families described above: 10 bases came from run 1 and 26 from run 2. Commands from the other run remain only for a different entry point, variant, condition or required output. Five whole phases were folded into existing flows: noninteractive configure (unsupported flags, already covered by the recorded interactive flow), the second repeated status-summary phase, the second repeated heartbeat phase, the duplicate identity-link flow and the duplicate authorized-command event. Twelve repeated reads without a state transition and three duplicate recorded probe cases were removed. The mutation case was removed from the history-reading phase because the edit operation already records it.
The event content preserves the initial merge's 123 single-base selections, 51 merged selections, 28 pairs separated for timeout or platform reach, and 90 event phases found by only one run. All 280 event conditions remain represented. The 19 event flows for conditions the union classifies as ambient remain as ways to exercise those conditions.
Preceding-command steps make saved-output dependencies explicit between phases. Bounded final joins account for background handles that otherwise had no reader; setup-service joins match all relevant paths so selection of a channel phase also selects their cleanup. A join depends on its writer and needs no additional persona content of its own.
Order follows setup, user operations and events, with content-consuming operations after their readers and restart, crash and recovery flows late. The final joins observe completion or cancellation of the task-owned background work and stop the shim services. Each output file has one writer and every file reader follows its writer.

### Persona traits
Merged as the same persona content, one name kept and applied in every command: channel-probe-installed (run 2) into channel-probe-conversations; channel-live-accounts (run 2) into channel-real-accounts; channel-dead-letters (run 1) into channel-ingress-dead-letters; channel-message-hook (run 2) into plugin-message-hooks; channel-visible-replies-tool (run 2) into config-visible-replies-tool; channel-response-prefix (run 2) into config-response-prefix; channel-bindings-mixed (run 2) into config-bindings-tiers; channel-msteams-retired-state (run 1) into channel-teams-retired-state; config-cli-path-mismatch (run 1) into cli-profile-mismatched. channel-telegram-shim, channel-bot-peer and channel-broadcast-group had the same name in both runs; their keys were joined.
Keys renamed where both runs named the same value: channel-telegram-shim dmChat, groupChat, lastBotMessageId and spareAccountId become dmChatId, groupChatId, botMessageId and newAccount; channel-bot-peer botSender becomes botId; channel-broadcast-group group becomes groupId; dm-scope-isolated peer becomes peerId (the existing key); run 1's Telegram dead-letter eventId becomes telegramEventId so it does not collide with run 2's conformance-channel eventId; patternText becomes patternWord and longText becomes longWord, values that are single identifiers.
Presentation payloads: run 1's keys that held presentation JSON (channel-interactive-message *Json, config-telegram-inline-buttons-off buttonsJson) and run 2's presentation file keys (channel-probe-conversations *File for presentations) cannot hold JSON as a persona key value; each is replaced by the payload written in the command as a single-quoted literal following docs/plugins/message-presentation.md, and openclaw message send --presentation takes JSON, not a path.
Traits kept as separate because their persona content differs (one run described a bundle of states, the other one state each): run 1's config-* traits for group, DM, mention, streaming, typing, table and ack states and run 2's channel-groups-mixed, channel-dm-pairing, channel-streaming-modes, channel-typing-modes, channel-markdown-tables, channel-reaction-level, channel-access-groups, channel-accounts-multiple, channel-dm-history and channel-debounce.

### Commands
One convention across the template: support/verify/live-channel-turn.mjs and live-channel-event.mjs (run 2) become support/verify/channel-inbound-turn.mjs with --channel and --event; channel-inbound-turn.mjs always names --channel (kova-channel-probe for Kova's conformance channel); --mention is a switch; reply targets are --reply-to with the values bot-last, bot-last-quote, bot-last-media, missing-parent or a message id (run 1's --reply-to-bot, --quote-bot, --reply-to-bot-media and --reply-to-missing); channel-probe-fault.mjs takes --fault like channel-platform-fault.mjs (run 2's --mode); support/verify/gateway-crash-loop.mjs --unclean-boots (run 2) becomes support/verify/gateway-kill.mjs --repeat; gateway-freeze.mjs takes --freeze-ms and --busy-ms (run 2's --pause-ms, run 1's --busy switch); Control UI flows use one name each (channels-hub, channels-setup-wizard, channels-config-edit, channels-pairing-review); product commands are written ocm @{env} -- <command> and listed as product: openclaw <command>. Every timeout flag is in milliseconds (--timeout for scripts still to be written, --timeout-ms for the existing Gateway-start helper).
Run files: the turn-in-flight handle is channel-turn-in-flight.json for both runs; run 2's drain-turn.json and drain-hold.json became drain-turn-2.json and drain-hold-2.json because run 1 used the same names; run 1's second qr-start.json became qr-start-complete.json.

### Corrections of rule breaches
17 test files from run 1 and the doctor end-to-end harness file from run 2 are not carried, following the test-file exclusion rule. The remaining entry points number 435 after separating the Discord voice exclusion from the inbound monitor.
Run 1 counted six records of kind ordinary ([OpenClaw #155088](https://github.com/openclaw/openclaw/pull/155088), [OpenClaw #159197](https://github.com/openclaw/openclaw/pull/159197), [OpenClaw #153399](https://github.com/openclaw/openclaw/pull/153399), [OpenClaw #156367](https://github.com/openclaw/openclaw/pull/156367), [OpenClaw #151461](https://github.com/openclaw/openclaw/pull/151461), [OpenClaw #155573](https://github.com/openclaw/openclaw/pull/155573)) as breaks; they are not breaks and are not counted.
Run 2 wrote one command with a placeholder nested inside another placeholder (the legacy plugin account); it now reads {persona:channel-real-accounts:legacyPluginAccount}.
Run 1 read a run directory through --echo-from that no command wrote with --out; the first command now writes {run}/echo.json and the second reads it.
Run 1 passed openclaw agent --timeout 5, a value in seconds; that phase's base comes from run 2, which reaches the same lost-connection condition through a probe fault, so the seconds-valued flag is not carried.

### Command and lifecycle corrections
The pinned CLI registers configure with --section only, pairing approve without --json, and agents delete with --force rather than --yes. channels status --channel and channels add with an optional positional channel are valid. The identity methods require profileId and, for linking or unlinking, identity containing channelId, accountId and senderId; the requests now follow that shape.
The installed conformance, adapter, probe and capability scripts evaluate expected outcomes and therefore are not called by this template. Their recorded cases are retained as explicitly unavailable observation wrappers that must return raw results without assertions. The adapter installation flow likewise has an explicit observation wrapper. The existing mock-script writer cannot accept --env and --script; the provider-failure phase now requires the recorded mock-provider-failing content and sends its marker.
Every called product form is listed under support.toWrite. OCM service operations and log reads use named, unavailable wrappers with their product operation and flags. No support implementation or catalogue entry is supplied here. Background joins require the wrapper to cancel unfinished task-owned work after its timeout and record that fact.
The recorded inbound-during-restart flow used a synchronous restart followed by injection. Its unavailable overlap wrapper now starts the same restart asynchronously, observes draining, injects before releasing the held turn, and records both responses and timing. This defines the required orchestration; it is not evidence that it ran.
The setup paths and background lifetimes require careful handling across selected phases. Restart flows retain their own held-turn handles where recorded. A future executor must record any loss of the ambient held-turn condition instead of treating every subsequent phase as still busy.

### Enumeration counts and evidence limits
The recorded-run reconciliation contained 435 entry points, 347 placed and 88 excluded, and 645 conditions. Run 1 found 399 of the entry points and 592 of the conditions; run 2 found 378 of the entry points and 590 of the conditions. Explicit combined labels receive credit for the controls they name: channel and account filters, wizard answer fields, the setup Open link control and the detail Docs link. Presentation button, select and question-choice callbacks remain three distinct entry points.
Run 2 remains below the required nine-tenths share of entry points. Reconciliation preserves the recorded coverage but cannot satisfy that acceptance criterion without another independently authorized derivation. Neither run nor this reconciliation supplies runtime observations for the proposed template.

The legacy-plugin add flow passes a credential-store name to its declared observation wrapper. A real credential is never a persona key or a command string, and the wrapper must not print it. The shim token keys are synthetic local fixture identifiers.

### Product input and overlapping-flow corrections
The message.action calls supply distinct idempotencyKey values required by the pinned Gateway schema. Question prompts use questions containing id, header, question and option objects. Their tool turns start in the background, capture the exact pending request and native prompt, and remain active until the callback or question.resolve response and a final join. The Other path submits an actual reply to the captured Force Reply prompt. The select interaction has its own select presentation and saved output, separate from the button presentation.
Discord channel and category creation outputs are retained separately. Later edits, moves and deletes bind channelId, categoryId and parentId from those results; a final cleanup flow retains the same IDs. Sticker calls use stickerId, sticker uploads supply description and tags, and member and role calls identify the actual user, role and channel. Telegram sticker search and Discord reaction listing use supported adapter actions. Matrix profile changes and poll voting, iMessage attachment and message effects, and Slack download remain separate real-account variants; the reachable Telegram, Discord and conformance flows remain in their existing operations.
The repeated streaming and typing cases now call a configured-turn wrapper with explicit account and agent-default patches. It applies the real configuration, records adoption and the inbound turn, then restores the changed keys, including unset values. The persona route for these cases has no conflicting per-agent mode overrides. Equivalent mode invocations and repeated observations were consolidated without removing a condition.
The media and command debounce flows use two Telegram shim updates within a configured two-second pending window. The first update returns at buffered admission, the second is injected after 100 milliseconds without waiting for the first turn, and both completions are joined. The wrapper restores the prior debounce configuration even on interruption.
Suspension uses a live background owner: gateway.suspend.prepare receives requestId and drain, its returned suspensionId is saved privately, intermediate status uses that ID, and resume and cancellation cleanup use the same ID. Printed responses redact the token. Breaker recovery is a slow event with a 420000-millisecond bound and a status observation 310000 milliseconds after the three crashes; the product defers recovery until the latest unclean boot plus 300001 milliseconds. Database faults target delivery_queue_entries and channel_ingress_events.
Authored fallback passes a reply payload containing text, presentationTextMode set to fallback and a table presentation through the channel-outbound delivery API. Its explicitly limited conformance renderer allows core to select the authored fallback instead of silently exercising an ordinary table send.
The current conformance plugin still fixes the account to default, the conversation to direct and command authorization to true. The declared admission capability is additional missing support, beyond its SDK import repair: it must pass real account, conversation, sender, mention and command facts through the product ingress resolver and context builder, preserve the exact host result, and enter the inbound event runner. These phases require the channel-probe-admission persona capability and request --admission sdk; they do not claim the present probe covers those gates.

The generic Nostr form-field family is expanded into its eight named controls (name, displayName, about, picture, banner, website, nip05 and lud16), as defined in ui/src/pages/channels/view.nostr-profile-form.ts. Neither recorded run named the individual controls; comparison.md preserves that enumeration gap instead of awarding discovery credit. This corrects the one-control-per-entry rule without another derivation.

### Configuration and resource ownership reconciliation
A complete scan of within-phase commands, ignoring only artifact-directory and output-file names, found 33 repeated-command groups. Nine groups are deliberate before/after observations or repeated events with real intervening state changes: account stop/start, pairing approval, unlisted-account stop, both dead-letter recovery listings, crash-breaker manual start, the two restart/recovery pairs, and suspend/resume. The remaining groups were corrected: 21 invocations now change actual policy or routing configuration, and 27 unchanged observations were consolidated. A single observation can record coexisting properties, including admission, reply delivery, metadata, typing and history; it is not counted repeatedly merely because those properties have separate names. Telegram and Discord platform-specific states keep their separately declared shim/fixture scenarios.
Mention allowIn/denyIn, context visibility, bot-thread mention policy, wildcard groups, bot admission, broadcast budgets/strategy and routing tiers now have explicit scoped configuration transitions. A parent binding names the actual parent peer. Each binding-tier invocation replaces the competing binding set for that observation and restores it afterward; fallback and no-owner cases use an empty set. These transitions use config.get/config.patch and the existing resolvers, not output-directory labels.
The ambient held turn has its own account route, a dedicated agent main session and independent mock-provider capacity. Ordinary DM and group operations therefore do not queue behind that held response. Deliberate same-session overlap remains in the dedicated event flows.
Spawned Discord sessions capture the childSessionKey and its actual delivery context through sessions.list, correlated with the fixture-created thread response. Follow-ups and the binding-idle command read that captured conversation. The former conformance-thread spawn is consolidated into this supported Discord flow. CLI-created and tool-created Discord threads also have separate captured outputs, replies using those outputs, and cleanup by their actual IDs.
The model-facing iMessage attachment action is upload-file; sendAttachment is the native compatibility name, not a valid tool-discovery entry. Telegram unsend is replaced by one live iMessage flow that sends a fresh message and retracts its captured native ID. Discord conversation-open is replaced by a separate live Slack flow with userIds. These live variants include their actual adapter paths, while reachable sibling operations remain separate. The media-bearing iMessage group-session flow replaces the duplicate malformed icon operation.
The resource sweep covers account creation/logout/removal, pairing approvals, message deletion/retraction, member moderation, thread/category creation, uploads and events. Cases that consume state use distinct account, request, message and member identifiers. The token and hot-reload account creations have separate final removals. Category/channel and thread follow-ups consume recorded creation IDs. Upload/event results retain their created IDs; fixture objects belong to the disposable transport, while live-platform cleanup limitations remain explicit in coverage.
Pending/claimed resubmission uses four dedicated failed events, separate from earlier successful-recovery and completed-row cases. Pending observations stop the Gateway so the queue cannot drain before the second CLI request. Claimed observations retain the held-response path through that request and read the actual queue state before proceeding. Both paths release their hold and restore service state on cancellation. A missed claimed interval is unavailable evidence, not completed-row coverage.
The startup-inspection wrapper operates on the real forked agent-schema-inspection child. It checks process identity, parentage and disposable-environment ownership, pauses only that child, waits for the actual per-agent deferred-inspection interval after the five-second foreground cutoff, injects during that interval, and resumes the same child on every exit path. Capture and hold are bounded. Failure to capture the interval records unavailable evidence; it does not manufacture an inspection hook or count a later ordinary inbound.
The origin-subject case creates a real conformance control whose callback record retains the originating subject. A different admitted actor activates that captured control, and the existing ingress resolver receives the stored origin and actual actor separately. No bundled adapter at the pinned revision supplies this SDK event mode, so this requires the declared conformance capability; it is not attributed to ordinary Telegram button handling.

The remaining non-thread spawn calls retain their returned child identifiers as outputs and use the model-facing completionTarget parent option for parent delivery, rather than an ignored announce field.

The native-ID and concurrency pass retains live Matrix identifiers in persona-provided files, captures the actual live Discord thread through reply and cleanup, and submits held-turn follow-ups before joining them. Named Telegram account additions use synthetic fixture tokens rather than default-account environment credentials. Outbound retry exhaustion observes native scheduled attempts within explicit slow bounds. Generic ingress exhaustion additionally requires a genuinely aged pending event; the missing aged fixture is recorded instead of treating a short fresh-event run as exhaustion.

The cross-phase consolidation also retains each repeated atomic probe or shim scenario once: reply context, media final, command and callback buttons, outbound echo, partial final edit, four receive-ack modes, Telegram declared workflows and Discord adapter observation. Their canonical flows keep the selection-path union and required event kind. The duplicate combined direct-chat phase is removed after moving its unique session listing to the retained Telegram flow. Routing shares its common tiers and retains a separate direct wildcard and the two explicit session-scope variants; fallback and no-owner observations use distinct actual owner inputs.

Conditions 646–655 were added during source review from the asynchronous inspection sentences under docs/plugins/sdk-channel-outbound.md "Durable ingress monitors". Both recorded derivations cited this heading but omitted these ten states. Neither receives discovery credit for them. They cover companion selection and compatibility, synchronous convenience behavior, ordered admission, stop/idle joins, claim cancellation, start capacity and activity. The original 645-condition reconciliation remains historical; the corrected inventory has 655 conditions, with 368 ambient and 287 event. The older-host compatibility case remains outside reach on the pinned current host.

Claimed-resubmission observations now hold the native event before adoption, using an SDK delivery gate or the actual Telegram media hydration request. Watchdog observation keeps native lease refresh but supplies no deferred-heartbeat renewal and waits beyond the real five-minute deadline. Guarded recording targets a dedicated absent per-group session through the actual recorder with createIfMissing false; no agent dispatch creates that session first.

Interruptions wait for captured native send, persistence, producer-lease or active recovery boundaries. A model held before output does not supply a delivery lease, and admission completion does not prove a send started. Native unacknowledged-input coverage uses the manual-ack conformance route; the Telegram sibling records only interrupted-turn recovery. The unsupported generic-spawn substitute for detached Codex completion is folded into the real-harness phase, whose missing platform prerequisite remains explicit.

The related ingress shutdown and deferred-slot flows also capture actual native claim/callback state before stopping or patching. Their whole sequences own release, cancellation, configuration restoration and service recovery. Pending-state resubmissions join the late disruptive section after the ambient held turn is finished. Detached helper handles are removed when their complete lifecycle moves inside a single bounded wrapper.
