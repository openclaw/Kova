# Kova Scenario Hierarchy

Kova measures OpenClaw behavior by runtime path, not by whichever client first
exposed that path.

## Gateway Session

`gateway-session-send-turn` is the shared Gateway session messaging benchmark.
It calls `sessions.create`, `sessions.send`, `agent.wait`, and `chat.history`
directly over Gateway RPC with mock auth/provider. Use it for the core Control UI, dashboard,
and channel message path.

The helper reports three outcomes in JSON `recordStatus`:

- `PASS` (`ok: true`, exit 0): the submitted run completes successfully and its
  explicitly associated reply exactly matches the expected text.
- `FAIL` (`ok: false`, exit 1): the submitted run fails, does not finish within
  the timeout, or its associated reply does not satisfy the requested text/count.
  Terminal errors preserve the Gateway's error text.
- `BLOCKED` (`ok: false`, exit 1): no authoritative association between the
  submitted run and a reply is available before the timeout. The reason names
  the missing association; the helper never infers ownership from message order
  or input-consumption receipts. Existing harness setup failures also use this status.

Earlier matching replies cannot satisfy a new send. `runId` identifies the
submitted run on success and failure (`null` when its identity could not be
verified). A reply must carry that run id or the submitted idempotency key.
`replyRunId` identifies the explicitly associated reply execution; if it differs,
that execution must also finish successfully. It stays `null` when no binding is
available. Existing timing, history and assistant-text fields remain.
`--min-assistant-count` still requires that many visible assistant replies in
the returned history, in addition to a matching reply from the submitted run.
Forwarded, scheduled and other projected inputs are not assistant replies.

The `gateway-session-send-turn` cold/warm commands and
`gateway-session-send-turn-existing-user` continue to support direct turns.
If another turn causes their input to queue and the Gateway omits an explicit
reply association, they now report `BLOCKED` instead of accepting an inferred
queued reply. Direct callers of the support script have the same behavior.

This scenario owns:

- cold and warm Gateway session turn timing
- pre-provider, provider, and post-provider timing
- Gateway session diagnostics timeline attribution
- Gateway process RSS/CPU as the primary product resource signal
- helper process cost under `gateway-session-client`

## Dashboard

`dashboard-readiness` is dashboard-specific coverage. It verifies the dashboard
command, URL/websocket entry, and post-dashboard Gateway health. It does not own
the shared message-turn benchmark.

## Channels

Channel scenarios should prove adapter behavior: the channel can create or
route a user turn into the shared Gateway session path and recover/report
adapter-specific failures. They should compare against `gateway-session-send-turn`
instead of duplicating the core Gateway session benchmark.

## Agent CLI

Agent CLI scenarios measure CLI client behavior separately:

- `agent-cli-local-turn` covers short-lived local agent CLI turns.
- `agent-gateway-rpc-turn` covers `openclaw agent` as a CLI client crossing the
  Gateway agent RPC path.

CLI process cost should stay on CLI roles. It should not be used as the primary
acceptance signal for Control UI, dashboard, or channel users.


### Automatic compaction verification

`support/run-gateway-session-send-turn.mjs --require-auto-compaction true`
requires `--create-session false` and a canonical existing session key. It reads
that session's current measured prompt budget, adds bounded notebook input above
its remaining headroom, and uses the ordinary submitted-run completion and reply
checks. It then requires a new native compaction entry after the recorded event
sequence in the same session window. Existing entries and hook compactions do
not satisfy the assertion. The `compaction` result records the before budget,
input size, submitted run ID and new entry IDs, without printing the filler or
stored history. Preparation failures are BLOCKED; a successful turn without a
new native compaction is FAIL. The mode uses the persona storage reader and
requires Node.js 22.19.0 or newer. Omitting the flag or passing `false` preserves
the ordinary send behavior and result fields.
