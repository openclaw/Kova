# CLI Reference

Kova's human-facing commands render a dashboard by default. Add `--json` for
the stable machine contract, `--plain` for compact text, `--no-progress` to
silence streaming, or `--ascii` for Unicode-free output. Color, width,
`NO_COLOR`, and CI runners are detected automatically.

Run `kova help <command>` for the complete flags and examples for a command.

## Commands

| Command | Purpose |
|---|---|
| `kova version` | Print Kova and runtime information. |
| `kova setup` | Verify prerequisites, configure auth, and create Kova directories. |
| `kova self-check` | Run Kova's dry-run, parser, evaluator, and gate checks. |
| `kova plan` | Inspect surfaces, scenarios, states, profiles, and metrics. |
| `kova inventory plan` | Find OpenClaw capabilities that Kova does not model. |
| `kova inventory repeated-work` | Find duplicate scenario commands and collector pressure. |
| `kova run --scenario <id>` | Plan or execute one scenario against one target. |
| `kova matrix plan --profile <id>` | Resolve a profile without executing it. |
| `kova matrix run --profile <id>` | Plan or execute a profile matrix. |
| `kova reports` | List stored reports and short run IDs. |
| `kova report <run-id>` | Render a stored report. |
| `kova report compare <a> <b>` | Compare a baseline and current report. |
| `kova report bundle <run-id>` | Create a portable evidence bundle. |
| `kova report paste <run-id>` | Create a fixer-ready handoff. |
| `kova cleanup` | Remove stale Kova-owned environments or artifacts. |

## Target selectors

| Selector | Meaning |
|---|---|
| `npm:<version>` | Published OpenClaw version |
| `release:<name>` | Published release track such as `stable` or `beta` |
| `runtime:<name>` | Existing OCM runtime |
| `local-build:<repo-path>` | Release-shaped runtime built from a local checkout |

Use release-shaped targets when validating release behavior. A source checkout
should be selected with `local-build:<repo-path>` so Kova tests the packaged
runtime rather than an OpenClaw development command.

## Profiles

| Profile | Coverage |
|---|---|
| `smoke` | Fresh install, plugin dependency and lifecycle, and gateway performance paths |
| `release` | Broad ship-gate coverage across runtime paths and platforms |
| `diagnostic` | Release-shaped local builds with timeline and profiler expectations |
| `soak` | Memory growth, filesystem pressure, restarts, and provider responsiveness |
| `adversarial` | Hostile-looking input and malformed runtime conditions |
| `doctor-upgrade` | Doctor repair across meaningful historical config boundaries |
| `release-upgrade` | Stable-to-beta release-track upgrades |
| `local-build-upgrade` | Stable and cloned-user upgrades into a local build |
| `rolling-upgrade` | Upgrades from recent published OpenClaw versions |
| `official-plugins` | Published official plugin install paths |
| `web-release` | Metrics used by public release reports |
| `exhaustive` | The full local matrix; execution requires `--allow-exhaustive` |

`kova plan --json` is the authoritative inventory. Profile definitions live in
`profiles/*.json` and can change as coverage grows.

## Execution controls

`run` and `matrix run` are dry-run unless `--execute` is present. Matrix runs
also accept `--parallel`, `--repeat`, `--include`, `--exclude`, and `--gate`.
Kova defaults to deterministic mock auth; use `--auth live` only after
configuring credentials with `kova setup`.

Kova stores credentials, reports, artifacts, and baselines under `~/.kova` by
default. See [Agent Usage](AGENT_USAGE.md) for safe execution, cloned-user
upgrades, baseline policy, cleanup, and report handoff.
