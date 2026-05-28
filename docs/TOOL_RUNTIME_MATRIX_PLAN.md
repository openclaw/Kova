# Tool Runtime Matrix Plan

Kova's exhaustive profile should prove OpenClaw's high-risk tool execution
surfaces, not only startup, plugin management, and message turns. Today it
exercises MCP initialization with `tools/list`, browser automation, agent turns,
and many command paths. It does not yet explicitly prove cron-triggered runs,
safe exec behavior, or real tool calls through the tool runtime.

## Goal

Add a tool runtime matrix that validates cron, exec, MCP tool calls, and
tool-failure containment in disposable OpenClaw envs.

The matrix should answer:

- Can a scheduled or cron-triggered agent run start, finish, and report status?
- Are cron session ids, trigger metadata, timeout policy, and logs attributed as
  cron rather than a normal user turn?
- Can the exec tool run a harmless command and return bounded output?
- Are dangerous or malformed exec requests blocked, sanitized, or reported
  without executing destructive payloads?
- Does the MCP bridge successfully call at least one real tool, not just list
  available tools?
- Do tool failures stay attributed to the tool/runtime instead of crashing the
  gateway or poisoning later agent turns?

## Non-Goals

- Do not run destructive shell commands.
- Do not mutate durable user envs.
- Do not depend on live credentials or external network services.
- Do not treat a mocked helper as proof if OpenClaw has a real user-facing
  command or runtime path for the same behavior.
- Do not require wall-clock waiting for long cron schedules; use explicit
  trigger, short interval, or run-now paths where OpenClaw exposes them.

## Current Coverage

Already covered or partially covered:

- `mcp-runtime-start-stop`: starts MCP stdio bridge, initializes, and runs
  `tools/list`.
- `browser-automation-smoke`: starts browser automation and checks health.
- Agent message lanes: CLI, Gateway RPC, TUI, OpenAI-compatible, provider
  failure modes, adversarial input, and concurrent turns.
- Command path checks: status, plugins, models, dashboard, media understanding,
  workspace scan, network offline.

Missing first-class coverage:

- Cron lifecycle and cron-triggered agent execution.
- Exec tool success, blocked dangerous input, timeout, and output limits.
- MCP `tools/call` against at least one deterministic safe tool.
- Tool-call normalization aliases such as `tools/exec` or `functions.exec`
  in release-shaped runtime behavior.
- Tool runtime leak checks after failed or timed-out tool calls.

## Proposed Surfaces

### `cron-runtime`

Owner area: `cron-runtime`.

Process roles:

- `gateway`
- `command-tree`
- `agent-process`
- `cron-runtime`
- `mock-provider`

Requirements:

- `cron-run-starts`: a disposable cron/automation run can be created and
  triggered without manual interaction.
- `cron-run-completes`: the run reaches a terminal success/failure state within
  threshold and emits a bounded report.
- `cron-trigger-attribution`: session id, trigger, logs, and report evidence
  show cron-specific attribution.
- `cron-timeout-contained`: a deliberately slow cron run times out cleanly and
  does not degrade gateway health.

### `exec-tool-safety`

Owner area: `agent-tool-runtime`.

Process roles:

- `gateway`
- `command-tree`
- `agent-process`
- `tool-runtime`
- `mock-provider`

Requirements:

- `exec-safe-command`: the exec tool can run a harmless command such as
  `printf KOVA_EXEC_OK` in a disposable workspace.
- `exec-dangerous-command-blocked`: destructive-looking commands are never run.
  The fixture should ask for an inert sentinel command such as
  `echo KOVA_EXEC_BLOCKED_TEST_1234` when proving the blocked path.
- `exec-output-bounded`: large output is truncated or summarized according to
  OpenClaw's output budget.
- `exec-timeout-contained`: long-running commands time out and leave no
  orphaned process.
- `exec-alias-normalization`: supported tool aliases normalize to the intended
  exec tool, while unknown aliases fail clearly.

### `mcp-tool-call`

Owner area: `mcp-runtime`.

Process roles:

- `gateway`
- `command-tree`
- `mcp-runtime`

Requirements:

- `mcp-tools-list`: existing listing behavior remains green.
- `mcp-tools-call-safe`: invoke one deterministic safe tool and verify the
  JSON-RPC result shape.
- `mcp-tools-call-invalid`: invalid tool name or malformed arguments return a
  protocol error without crashing the bridge.
- `mcp-bridge-clean-exit`: no MCP bridge process leaks after success or error.

### `tool-failure-containment`

Owner area: `agent-tool-runtime`.

Process roles:

- `gateway`
- `command-tree`
- `agent-process`
- `tool-runtime`
- `mock-provider`

Requirements:

- `tool-error-attributed`: failed tool calls are named in report/log evidence.
- `post-tool-health`: gateway and agent command paths remain usable after tool
  error, timeout, or blocked execution.
- `tool-result-redaction`: command output and error snippets are bounded and do
  not leak environment secrets.

## States

Add small states only where needed:

### `cron-user`

Disposable user state with a cron-capable agent config, mock provider auth, and
short timeout settings.

Evidence:

- cron config exists
- target agent/session id exists
- mock provider is configured

### `exec-tool-user`

Disposable user state with a writable workspace and model config that can drive
tool calls through a mock provider or deterministic tool-call fixture.

Evidence:

- workspace path exists under the disposable env
- marker file path for safe exec output exists
- environment contains a non-secret test marker only

### `mcp-tool-user`

Disposable user state for MCP tool calls. Prefer `fresh` if no additional state
is required.

Evidence:

- MCP bridge can connect to disposable gateway
- artifact dir captures JSON-RPC request/response transcripts

## Scenarios

### `cron-runtime`

Suggested phases:

1. `start`
   - Start disposable env with mock provider auth.
   - Verify gateway health.

2. `cron-register`
   - Create a short-lived cron or automation entry through OpenClaw's real
     command path.
   - Prefer an explicit run-now command if available.

3. `cron-run`
   - Trigger or wait for exactly one run.
   - Capture run id, session id, status, duration, and provider request count.

4. `cron-timeout`
   - Run a deliberately slow cron fixture with a short timeout.
   - Assert timeout is reported as cron/tool runtime behavior.

5. `post-health`
   - Run `status` and a simple agent/message command after cron activity.
   - Capture logs.

### `exec-tool-safety`

Suggested phases:

1. `start`
   - Start disposable env with mock provider/tool-call fixture.

2. `safe-exec`
   - Drive a harmless exec request.
   - Verify output includes `KOVA_EXEC_OK`.

3. `blocked-exec`
   - Drive malicious-looking user/tool input that must not execute literally.
   - Fixture proof must be an inert sentinel, for example:
     `echo KOVA_EXEC_BLOCKED_TEST_1234`.

4. `output-budget`
   - Drive a command that prints a large deterministic payload.
   - Verify output is bounded and report includes truncation metadata.

5. `timeout`
   - Drive a long-running command with a short timeout.
   - Verify timeout status and no process leak.

6. `post-health`
   - Verify status and a normal agent turn still work.

### `mcp-tool-call`

Suggested phases:

1. `start`
   - Start disposable env and gateway.

2. `mcp-initialize`
   - Initialize MCP stdio bridge.

3. `tools-list`
   - Capture available tools.

4. `tools-call-safe`
   - Invoke a deterministic safe tool. If no suitable built-in is stable,
     add a Kova fixture plugin that registers `kova_echo` and returns
     `{ "ok": true, "text": "KOVA_MCP_TOOL_OK" }`.

5. `tools-call-invalid`
   - Call a missing tool or send malformed args.
   - Assert a bounded JSON-RPC error.

6. `shutdown`
   - Close bridge and verify no process leak.

### `tool-failure-containment`

This can either be a standalone scenario or shared evaluator checks across
`exec-tool-safety`, `mcp-tool-call`, and existing provider failure scenarios.

Suggested phases:

1. `tool-error`
   - Trigger a deterministic failing tool.

2. `tool-timeout`
   - Trigger a deterministic timeout.

3. `recovery-turn`
   - Run a normal agent turn after the failure.

4. `logs`
   - Capture bounded logs and verify attribution.

## Safe Fixture Design

All fixtures must be harmless by construction.

Use these patterns:

- Safe exec success: `printf KOVA_EXEC_OK`.
- Dangerous-input test: ask OpenClaw to block/report input that contains strings
  like `rm -rf /`, but the fixture command that actually runs must be an echo
  sentinel such as `echo KOVA_EXEC_BLOCKED_TEST_1234`.
- Timeout test: spawn a sleep with an explicit short timeout and verify cleanup.
- Output budget test: print deterministic repeated text, not env vars or files.
- MCP safe tool: local fixture plugin returning a static JSON payload.

Never use these as executable commands:

- `rm -rf /`
- recursive delete of a real user path
- credential/env dumping
- network exfiltration
- fork bombs or unbounded process creation

## Metrics And Thresholds

Likely metric ids:

- `cronRegisterMs`
- `cronRunMs`
- `cronRunCompleted`
- `cronRunTimedOut`
- `cronTriggerAttributed`
- `execSafeCommandMs`
- `execSafeCommandSucceeded`
- `execDangerousCommandBlocked`
- `execOutputTruncated`
- `execTimeoutMs`
- `execProcessLeaks`
- `mcpToolsCallMs`
- `mcpToolCallSucceeded`
- `mcpToolCallErrorAttributed`
- `toolFailureAttributed`
- `postToolHealthMs`

Suggested thresholds:

```json
{
  "cronRegisterMs": 10000,
  "cronRunMs": 60000,
  "cronRunCompleted": 1,
  "cronRunTimedOut": 1,
  "cronTriggerAttributed": 1,
  "execSafeCommandMs": 10000,
  "execSafeCommandSucceeded": 1,
  "execDangerousCommandBlocked": 1,
  "execOutputTruncated": 1,
  "execTimeoutMs": 15000,
  "execProcessLeaks": 0,
  "mcpToolsCallMs": 10000,
  "mcpToolCallSucceeded": 1,
  "mcpToolCallErrorAttributed": 1,
  "toolFailureAttributed": 1,
  "postToolHealthMs": 10000
}
```

## Harness Work

Likely support helpers:

- `support/run-cron-runtime-smoke.mjs`
  - creates or triggers one cron run
  - captures run id, session id, status, provider requests, and logs

- `support/run-exec-tool-safety.mjs`
  - drives safe, blocked, output-budget, and timeout exec cases
  - captures process leak evidence

- `support/mcp-tool-call-smoke.mjs`
  - extends the existing MCP bridge smoke from `tools/list` to `tools/call`
  - writes JSON-RPC transcripts

- `support/plugins/kova-mcp-tool-fixture/`
  - optional local plugin if OpenClaw lacks a deterministic built-in MCP tool
    safe enough for release-gate use

Evaluator/parser work:

- parse cron run status and session trigger metadata
- parse exec result status, output truncation, timeout, and process leak data
- parse MCP JSON-RPC result/error envelopes
- classify tool failures as OpenClaw `FAIL`, not harness `BLOCKED`, when the
  gateway started and the tool path failed

## Profile Placement

Add focused coverage to:

- `profiles/exhaustive.json`

Add smoke-sized coverage to:

- `profiles/release.json` as warning coverage first

Consider a future dedicated profile:

- `profiles/tool-runtime.json`

Promote to blocking release-gate coverage after the scenarios are stable on a
reviewed-good release.

## Acceptance Criteria

- Dry-run planning resolves all new surfaces without gaps.
- Real runs mutate only disposable Kova envs.
- MCP coverage includes at least one `tools/call`, not only `tools/list`.
- Exec dangerous-input tests prove the dangerous payload was not executed.
- Cron runs include trigger/session attribution in the JSON report.
- Tool timeout and failure scenarios leave no process leaks.
- Gateway health and a normal follow-up command work after each tool failure.
- Markdown reports stay concise, while JSON reports include request/response,
  command, duration, and bounded log evidence.

## Implementation Order

1. Add surface contracts and metric ids.
2. Add `cron-user`, `exec-tool-user`, and optional `mcp-tool-user` states.
3. Extend MCP helper or add `mcp-tool-call-smoke.mjs`.
4. Add `mcp-tool-call` scenario first because it builds on existing MCP smoke.
5. Add safe exec helper and `exec-tool-safety` scenario.
6. Add cron helper and `cron-runtime` scenario.
7. Add evaluator/parser support for tool results, blocked exec, timeout, and
   process leaks.
8. Add exhaustive profile entries.
9. Run dry-run matrix planning and `self-check`.
10. Execute focused real runs against a reviewed-good target.
11. Add release warning coverage.
12. Promote stable lanes to blocking release gate.
