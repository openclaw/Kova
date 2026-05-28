# What Kova Is

Kova is the OpenClaw runtime validation lab. It proves OpenClaw works end-to-end
on a real machine: install, upgrade, gateway, sessions, plugins, agent turns,
providers, dashboards, TUIs, MCP, browsers, soak — with execution evidence,
not synthetic confidence.

Kova uses OCM as the harness control plane. OCM provisions disposable envs,
installs runtimes, clones user states, supervises services, and cleans up.
OpenClaw is the product under test.

## The Model

```text
execution surface × user state × target runtime × platform
```

Kova doesn't just run commands. It exercises a real OpenClaw capability under
a real user condition, against a specific build, on a specific machine.

## Surfaces

Surfaces are declarative files under `surfaces/*.json` (29 today). Each surface
defines an OpenClaw capability — gateway startup, agent turn, plugin install,
TUI, dashboard, provider/model discovery, upgrade, MCP, browser, workspace
scan — along with its owner area, required metrics, process roles, thresholds,
diagnostics expectations, and supported states. New capabilities are added by
data contract, not hardcoded logic.

## States

States are declarative (26 today). They model user history and environment:
fresh user, onboarded user, old-release user, release-configured user,
broken-plugin-deps, missing-plugin-index, model auth configured/missing,
external plugin, large workspace, slow filesystem, failed upgrade, stale
runtime deps, gateway already running, and more.

A state registry rejects nonsense pairings. Upgrade scenarios require an
old-release or existing-user state — never a fresh one.

## Scenarios

A scenario is the concrete workflow that tests one surface. It declares the
surface, supported states, target kinds, phases, expected evidence, thresholds,
and cleanup. Kova rejects scenarios with unknown surfaces, states, metrics,
process roles, or invalid pairings.

There are 42 scenarios today, spanning install, upgrade paths, gateway
performance and sessions, plugin lifecycle, agent turns and provider failure
modes (timeout, malformed, slow, streaming stall, concurrent, recovery,
offline, missing auth), TUI, dashboard, MCP, browser automation, OpenAI
compatibility, provider/model discovery, workspace scan pressure, failure
injection, and soak.

## Profiles

Profiles define coverage policy (8 today):

- `smoke` — fast confidence over core paths
- `release` — ship / no-ship gate
- `diagnostic` — local release-shaped builds with timeline expectations
- `soak` — long-running pressure and stability
- `release-upgrade` — published release-track upgrade matrix
- `local-build-upgrade` — upgrade into a local build
- `official-plugins` — bundled and official plugin coverage
- `exhaustive` — the full sweep, gated by `--allow-exhaustive`

A release run answers, plainly: what was tested, what is missing, what
failed, and whether the result is `SHIP`, `DO_NOT_SHIP`, `PARTIAL`, or
`BLOCKED`.

## Process Roles

Kova attributes CPU and RSS by role (21 today), so reports never have to
say "memory was high." Roles include `gateway`, `gateway-tree`,
`gateway-session-client`, `command-tree`, `runtime-staging`,
`runtime-management`, `package-manager`, `plugin-cli`, `model-cli`,
`agent-cli`, `agent-process`, `dashboard-cli`, `tui-cli`, `status-cli`,
`doctor-cli`, `browser-sidecar`, `mcp-runtime`, `openai-compatible-client`,
`mock-provider`, `build-tooling`, and `cleanup`.

## Collectors

Collectors produce the real evidence behind every verdict:

- **readiness** — TCP listening, health-ready, slow startup, hard failure
- **resources** — continuous CPU and RSS samples by process role
- **logs** — dependency errors, plugin failures, provider/auth signals
- **timeline** — OpenClaw spans (`gateway.startup`, `config.normalize`,
  `runtimeDeps.stage`, `agent.turn`, …)
- **profiles & heap** — CPU and heap evidence on `--deep-profile`
- **diagnostics** — structured OpenClaw evidence where emitted
- **attribution** — per-turn agent CLI, gateway-session, and pre-provider
  timing splits

If Kova says something passed or failed, it came from observed execution.

## Diagnostics Lanes

Published releases may not carry every span yet. Kova runs two lanes:

- `npm:<version>` and `release:<name>` — proves what users install today.
  Missing timeline data is informational.
- `local-build:<repo>` — proves the release-shaped build. Timeline evidence
  is required, and slow or open spans are promoted into top-level findings.

## Performance, Baselines, And Regressions

A single pass is not proof. Kova supports `--repeat N` and produces median,
p95, max, min, and variance per metric, with noise classification. Baselines
are stored per platform × target × surface × state × scenario.
`kova report compare` produces regression deltas so a report can say:
"functionally passed, but RSS regressed 38% versus baseline."

## Matrix

`kova matrix run` resolves a profile into the concrete cross-product of
targets × surfaces × scenarios × states, executes them, aggregates results,
and applies the coverage gate. `kova matrix plan` shows exactly what will run
before anything executes.

## Agent, Provider, Auth

OpenClaw is an AI assistant, so every env Kova creates normally has model
auth configured. Auth is a run-level concern, not a separate scenario family.

Default policy:

- if live credentials are configured and requested, use live auth
- otherwise default to the deterministic mock provider
- missing or broken auth is reserved for scenarios that explicitly test it

Credentials live in `~/.kova/credentials/`: metadata in `providers.json`,
secrets in `live.env` (mode `0600`), redacted everywhere they surface.
Setup offers explicit choices — API key, env-only, external CLI, OAuth-backed
path, or skip — with no silent provider preference. OpenClaw is configured
through its real onboard / configure / auth paths when testing live behavior.

Agent reports answer: did the agent produce the expected response, which
route was used, time to provider request, first byte, final response, and how
that time splits across CLI startup, gateway attach, provider, and cleanup —
with CPU and RSS attributed to gateway, agent CLI, provider, and child
processes.

## Evidence Ledger

A verdict is only as good as its proof. The evidence ledger declares the
proof a scenario needs (readiness signals, role samples, timeline spans,
agent-turn attribution, regression checks). If required proof is missing,
the verdict cannot be `SHIP` — it is `PARTIAL` or `BLOCKED`. Kova refuses to
declare success without observation.

## Inventory Audit

`kova inventory plan` introspects OpenClaw: CLI commands, package scripts,
plugin manifests, entrypoints, and config surfaces. It flags any capability
that is not yet modeled as a Kova surface — so coverage gaps surface before
a release does.

## Reports

JSON is the machine contract. The full record follows the `kova.report.v1`
schema (command records, stdout/stderr, samples, role peaks, timelines,
parsed metrics, cleanup details, platform metadata). A compact
`*.summary.json` is emitted for agents and CI.

Markdown is the human report: summary, coverage gaps, failures, exact
evidence, owner area, fixer prompt, artifact paths.

The console renders verdict-led dashboards by default for every command.
Escape hatches: `--json` (machine), `--plain` (plain text), `--ascii`
(no Unicode), `--no-progress` (silent streaming), `--color` (force on/off).
CI, `NO_COLOR`, and non-TTY pipes are auto-detected.

Two report helpers exist for handoff: `kova report bundle` produces a
portable evidence pack, and `kova report paste` produces a fixer-ready
prompt. `kova report compare` runs baseline-versus-current deltas.

## Safety

Dry-run is the default. Real execution requires `--execute`. Disposable envs
are destroyed when the run ends; durable user envs are clone sources, never
mutation targets. Exhaustive coverage requires `--allow-exhaustive`. Cleanup
is strict, retried when needed, and reported. A failing lab can be retained
with `--retain-on-failure` when inspection is needed.

Network isolation is a separate concern from OCM state isolation. The planned
macOS-faithful model is a per-worker loopback frontage/proxy layer, where
OpenClaw still runs as a normal macOS process and sees `127.0.0.1`, while the
host control plane addresses each worker through distinct loopback frontages
such as `127.0.1.11`, `127.0.1.12`, and `127.0.1.13`. See
[Network Isolation Plan](NETWORK_ISOLATION_PLAN.md).

## Agent-First

Every Kova command supports `--json`. Plans, inventories, matrix expansions,
runs, reports, comparisons, and bundles all have stable structured contracts.
Repo-local agent skills under `.agents/skills/` (`kova-operator`,
`ocm-operator`) capture the safe workflows Kova expects.
