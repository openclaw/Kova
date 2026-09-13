# Tool Runtime Coverage

The original tool-runtime proposal is implemented as four scenarios. The JSON
contracts are the current source of truth for phases, thresholds, and profile
membership; this page describes their coverage boundaries.

| Scenario | Current proof |
|---|---|
| [cron-runtime](../scenarios/cron-runtime.json) | Register and trigger a disposable cron entry through OpenClaw, inspect completion and trigger attribution, then check gateway health. |
| [exec-tool-safety](../scenarios/exec-tool-safety.json) | Read OpenClaw exec policy and exercise Kova's safe-command, inert blocked-input, output-budget, timeout, and process-leak fixtures. |
| [mcp-tool-call](../scenarios/mcp-tool-call.json) | Initialize the real MCP bridge, list tools, call cron status, reject an invalid tool, and verify clean shutdown. |
| [tool-failure-containment](../scenarios/tool-failure-containment.json) | Run the blocked-input, oversized-output, and timeout fixture paths, then verify gateway health. |

All four appear in the [release](../profiles/release.json) and
[exhaustive](../profiles/exhaustive.json) profiles. Their states are
[cron-user](../states/cron-user.json),
[exec-tool-user](../states/exec-tool-user.json), and
[mcp-tool-user](../states/mcp-tool-user.json).

## Evidence boundaries

The exec scenarios explicitly test a Kova fixture alongside OpenClaw policy
visibility. They do not claim to prove every model-driven OpenClaw exec path or
alias. The cron scenario covers registration, run-now completion, and attribution;
a separate cron-timeout scenario from the original proposal is not implemented.
Expanding either boundary requires new product-path evidence and contracts.

The helpers write structured evidence and bounded transcripts under the run's
artifact directory:

- [run-cron-runtime-smoke.mjs](../support/run-cron-runtime-smoke.mjs)
- [run-exec-tool-safety.mjs](../support/run-exec-tool-safety.mjs)
- [mcp-tool-call-smoke.mjs](../support/mcp-tool-call-smoke.mjs)

Fixtures must remain harmless: blocked-input cases use inert sentinels,
output-budget cases generate synthetic text, and timeout cases own their child
processes. Never substitute destructive payloads or durable user state.

## Running

Preview the profile with `kova matrix plan --profile release --target runtime:stable --json`.
For a focused dry run, use `kova run --target runtime:stable --scenario mcp-tool-call --json`.
Add `--execute` only after following [Agent Usage](AGENT_USAGE.md). Inspect the
JSON evidence and cleanup result, not just the helper's exit code.
