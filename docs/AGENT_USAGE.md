# Agent Usage

Kova is built so agents can run serious OpenClaw runtime validation without
custom instructions every time.

## Operating Model

- Kova tests OpenClaw. OCM provisions the lab.
- Durable user envs are clone sources, never mutation targets.
- JSON is the agent contract. Markdown is the human report.
- If an `ocm-operator` skill is available, load it before executing real
  scenarios. The repo-local copy lives at `.agents/skills/ocm-operator`.

## Standard Flow

### 1. Verify prerequisites

```sh
node bin/kova.mjs setup --ci --json
node bin/kova.mjs self-check --json
```

For non-interactive auth setup:

```sh
node bin/kova.mjs setup --non-interactive --auth env-only \
  --provider openai --env-var OPENAI_API_KEY --json
```

### 2. Inspect scenarios

```sh
node bin/kova.mjs plan --json
node bin/kova.mjs plan --scenario fresh-install --state missing-plugin-index --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix plan --profile release --target runtime:stable \
  --include tag:plugins --exclude state:broken-plugin-deps --json
```

Use `inventory plan` to find OpenClaw capabilities Kova does not yet model:

```sh
node bin/kova.mjs inventory plan \
  --openclaw-bin openclaw --openclaw-repo /path/to/openclaw --json
```

When `--openclaw-repo` is present, inventory also compares Kova's OpenClaw
message-channel capability catalog with `src/channels/message/types.ts`. That
source drift check is inventory signal only. Runtime and matrix runs use
`channel-capability-preflight` to probe the selected OpenClaw runtime package
instead.

Use `inventory repeated-work` before optimizing Kova runs so duplicated scenario
commands and collector pressure are measured from the registry instead of guessed:

```sh
node bin/kova.mjs inventory repeated-work --json
```

Package-script discovery defaults to `--script-scope product` so internal
maintenance scripts do not drown out OpenClaw capability coverage. Unmodeled
entries are planning warnings until they are intentionally promoted to gate
policy.

Omit `--json` for the dashboard view. Use `--plain` only when a downstream tool
still expects compact text.

### 3. Dry-run

```sh
node bin/kova.mjs run --target runtime:stable \
  --scenario fresh-install --state fresh --json
```

### 4. Execute

A single scenario:

```sh
node bin/kova.mjs run --target runtime:stable \
  --scenario fresh-install --state missing-plugin-index --execute --json
```

A named matrix:

```sh
node bin/kova.mjs matrix run --profile smoke \
  --target runtime:stable --execute --json
```

With filters:

```sh
node bin/kova.mjs matrix run --profile release --target runtime:stable \
  --include scenario:fresh-install --execute --json

node bin/kova.mjs matrix run --profile release --target runtime:stable \
  --include tag:plugins --exclude state:broken-plugin-deps \
  --parallel 2 --execute --json

node bin/kova.mjs matrix run --profile release \
  --target local-build:/path/to/openclaw \
  --include scenario:release-runtime-startup --execute --gate --json
```

Matrix runs emit a bundle path in the JSON receipt. Bundles include
`artifact-index.json` with relative paths, byte sizes, and SHA-256 hashes.

The `exhaustive` profile requires `--allow-exhaustive`. Use plan or filtered
dry-runs first.

Filtered gate slices are reject-only: a selected blocking scenario failure
means `DO_NOT_SHIP`, but a passing partial slice stays `PARTIAL` because it
cannot approve the full release gate. Non-ship gates retain artifacts under
`artifacts/release-gates/<runId>/`.

### 5. Read the report

Read `*.summary.json` first. Use Markdown for the human decision summary and
the full JSON report when raw phase, command, or collector evidence is needed.
For failures, start with `decision`, `findings`, and `failureBrief`.

### 6. Handoff

```sh
node bin/kova.mjs report summarize reports/<run>.json --json
node bin/kova.mjs report paste reports/<run>.json
node bin/kova.mjs report compare reports/<baseline>.json reports/<current>.json --json
node bin/kova.mjs report bundle reports/<run>.json --json
```

## Targets

Use release-shaped targets when validating release behavior:

```sh
--target npm:2026.5.12
--target release:beta
--target runtime:test-build-1
--target local-build:/path/to/openclaw
```

Never use OpenClaw source/dev commands as proof that a published package will
work. For a local checkout, prefer `local-build:<path>`; that routes through
OCM's release-shaped local runtime build.

## Auth

Kova defaults to `--auth mock`, so dry-runs and executions model an OpenClaw
env with deliberate model auth unless the scenario/state explicitly tests
missing or broken auth. Use `--auth live` only after credentials are configured
with `kova setup`. Live runs are environment-dependent evidence, not
deterministic baseline evidence.

Interactive `kova setup` asks provider first, then auth method. Both prompts
accept the number or the name.

`openai + external-cli` uses Codex CLI; `anthropic + external-cli` uses
Claude CLI. Use API-key or env-only auth for `custom-openai`.

For supported API-key and env-only providers, live auth setup runs OpenClaw's
own non-interactive `onboard` path with env-backed SecretRefs. Live auth paths
that do not expose a stable OpenClaw command path are labeled fixture setup
and must not be cited as proof that OpenClaw onboarding/auth UX passed.

## Baselines

Only update baselines from a reviewed-good run:

```sh
node bin/kova.mjs matrix run --profile smoke --target runtime:stable \
  --repeat 3 --execute --save-baseline --reviewed-good --json
```

Do not pass `--reviewed-good` until evidence is clean: records pass, violations
are empty, performance groups are stable, and any gate or baseline comparison
is not blocking.

Do not save baselines from `--node-profile`, `--heap-snapshot`,
`--deep-profile`, or `--profile-on-failure` runs. Those are diagnostic runs and
their numbers can include profiler overhead.

## Existing-User Testing

Existing-user testing must clone source state:

```sh
node bin/kova.mjs run \
  --scenario upgrade-existing-user \
  --source-env <existing-env> \
  --from npm:2026.4.20 \
  --target npm:2026.5.12 \
  --execute
```

Scenarios that use `--source-env` may reference that durable env only in the
first `ocm env clone {sourceEnv} {env}` command. Kova rejects contracts that
inspect, upgrade, start, or otherwise touch the source env directly.

Focused upgrade lanes are target-specific and Kova validates the selector:

```sh
node bin/kova.mjs matrix run --profile release-upgrade \
  --target release:beta --execute --json

node bin/kova.mjs matrix run --profile local-build-upgrade \
  --target local-build:/path/to/openclaw \
  --source-env <existing-env> --execute --json
```

`release-upgrade` is specifically stable-to-beta; running it with
`release:stable` is rejected. `local-build-upgrade` exercises stable-release
and cloned existing-user upgrades against the release-shaped local build.

Never mutate durable envs directly for Kova tests unless a human explicitly
asks for that exact env to be changed.

## Cleanup

To retain a failing lab:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install \
  --execute --retain-on-failure
```

Otherwise Kova cleans up automatically. Cleanup retries transient shutdown
races before reporting failure.

Inspect and destroy stale Kova envs:

```sh
node bin/kova.mjs cleanup envs --json
node bin/kova.mjs cleanup envs --execute
```

Prune old run artifact directories:

```sh
node bin/kova.mjs cleanup artifacts --older-than-days 14 --json
node bin/kova.mjs cleanup artifacts --older-than-days 14 --execute
```

## Reporting Back

When reporting to a human:

- lead with `PASS`, `FAIL`, `INCOMPLETE`, `BLOCKED`, or `SKIPPED`
- include the scenario id and target
- include the failing command only on failure
- include concise evidence from the JSON report
- include gateway PID/RSS/CPU only when they explain the issue
- include health failure and p95 metrics when startup or responsiveness is
  the concern
- include threshold violations before raw logs
- classify OpenClaw failures separately from harness/provisioning blockers
- mention cleanup status
- use `kova report paste <report.json>` as the starting point for fixer
  handoffs

Do not paste large successful command outputs. They live in the JSON report.

## Status Meanings

- `PASS` — OpenClaw behavior met the scenario contract.
- `FAIL` — OpenClaw ran but violated the contract.
- `INCOMPLETE` — not enough proof to judge.
- `BLOCKED` — harness, OCM, platform, or prerequisites prevented testing.
- `SKIPPED` — intentionally not run.
