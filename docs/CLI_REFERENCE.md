# CLI Reference

Kova's human-facing commands render a dashboard by default. Add `--json` for
the stable machine contract, `--plain` for compact text, `--no-progress` to
silence streaming, or `--ascii` for Unicode-free output. Color, width,
`NO_COLOR`, and CI runners are detected automatically.

Run `kova help <command>` for the complete flags and examples for a command.

Value options accept `--name value` or `--name=value`; the inline form preserves
all characters after the first `=`, including additional equals signs. Boolean
options accept only a bare flag, `=true`, or `=false`.

## Commands

| Command | Purpose |
|---|---|
| `kova version` | Print Kova and runtime information. |
| `kova setup` | Verify prerequisites, configure auth, and create Kova directories. |
| `kova self-check` | Run Kova's dry-run, parser, evaluator, and gate checks. |
| `kova plan` | Inspect surfaces, scenarios, states, profiles, and metrics. |
| `kova inventory plan` | Find OpenClaw capabilities that Kova does not model. |
| `kova inventory repeated-work` | Find duplicate scenario commands and collector pressure. |
| `kova catalogue list` | List the fixed command forms for a product. |
| `kova catalogue check` | Check template and persona commands against a product catalogue. |
| `kova run --scenario <id>` | Plan or execute one scenario against one target. |
| `kova matrix plan --profile <id>` | Resolve a profile without executing it. |
| `kova matrix run --profile <id>` | Plan or execute a profile matrix. |
| `kova reports` | List stored reports and short run IDs. |
| `kova report <run-id>` | Render a stored report. |
| `kova report compare <a> <b>` | Compare a baseline and current report. |
| `kova report bundle <run-id>` | Create a portable evidence bundle. |
| `kova report paste <run-id>` | Create a fixer-ready handoff. |
| `kova cleanup` | Remove stale Kova-owned environments or artifacts. |

The `kova verify` and `kova persona` commands are forthcoming; [Kova Verify](verify/README.md) describes them.

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

Setup bounds its OCM version probe to 30 seconds. A timed-out probe fails the
required prerequisite check, reports the timeout, and makes setup exit nonzero.

`run` and `matrix run` are dry-run unless `--execute` is present. Matrix runs
also accept `--parallel`, `--repeat`, `--include`, `--exclude`, and `--gate`.
Kova defaults to deterministic mock auth; use `--auth live` only after
configuring credentials with `kova setup`.

Kova stores credentials, reports, artifacts, and baselines under `~/.kova` by
default. See [Agent Usage](AGENT_USAGE.md) for safe execution, cloned-user
upgrades, baseline policy, cleanup, and report handoff.

`cleanup artifacts` recognizes current run IDs (`kova-YYMMDD-HHMMSS-<hex>`)
and legacy timestamp IDs. Directories must be older than `--older-than-days`
to qualify. With `--execute`, cleanup attempts every eligible directory and
exits nonzero if any removal fails, in every output format. The JSON receipt
retains each directory's status and error so automation can identify incomplete
cleanup.

### Command-output assertions

Scenarios can use `support/assert-command-output.mjs` to require a literal,
case-insensitive output marker and an exit status. `--retries` is the maximum
number of executions, including the first attempt; successful
`kova.commandOutputAssertion.v2` receipts record the number actually executed in
`attempts`. For example, a command that succeeds immediately with `--retries 3`
reports `attempts: 1`.

`--expect-status`, `--retries`, and `--delay-ms` accept decimal integers.
Retries must be positive and delay must be non-negative. Malformed values such
as `1junk` or `1.5` are rejected before executing the command.

### Cross-user performance runs

`KOVA_OCM_TRANSPORT_JSON` configures an operator-owned argv transport for OCM.
Without it, Kova retains its ordinary same-user behavior. With it, the supported
scenarios are `fresh-install`, `gateway-performance`, `bundled-plugin-startup`,
and `agent-cold-warm-message`. Supported states are `fresh`, `onboarded-user`,
`many-bundled-plugins`, and `mock-openai-provider`, including the release
profile's agent cold/warm entry. Other scenario/state combinations are rejected
before execution; this is not support for the complete release matrix.

```json
{
  "prefix": ["/usr/bin/sudo", "-n", "-u", "candidate", "--"],
  "binary": "/opt/ocm/ocm",
  "env": {
    "HOME": "/var/lib/performance-candidate",
    "PATH": "/opt/runtime/bin:/opt/ocm:/usr/bin:/bin"
  },
  "cwd": "/var/lib/performance-candidate"
}
```

The prefix and binary are structured argv, not shell expressions. `cwd` is
optional and defaults to `env.HOME`. Kova invokes GNU `/usr/bin/env -C <cwd> -i`
**after** the prefix switches user; it does not try to enter the candidate's
private directory as the runner. This backend requires GNU env with `-C`, not
BSD env. A failed directory change fails the command.

Run Kova as a separate measurement principal with immutable Node, Kova, helper,
and OCM inputs. Its checkout, mock-provider owner files, `KOVA_HOME`, reports,
and bundle destinations must have non-candidate-writable ancestors. The target
repository, OCM state, and runtime processes belong to the candidate principal.
Neither principal needs direct access to the other's private home. Do not widen
permissions on report parents to make a cross-user run work.

Only the configured environment and explicit per-command diagnostic, profiler,
build-profile, env-name, and config-contract values cross the transport. HOME
and PATH stay fixed. Ambient credentials and the transport configuration do not
cross. The mock provider and assertions stay on the measurement principal;
the mock port is passed as a validated value. The two fixed config/pressure
state writers run through OCM without exposing the private Kova checkout.
Candidate Node profiling options are not loaded into the measurement helpers.
Ambient runner `NODE_OPTIONS` are not forwarded. Candidate Node options come
from the configured transport environment and Kova's generated instrumentation.

OCM must support
`ocm env artifact export ENV --path RELATIVE_ENV_HOME --max-bytes N`.
Timeline and profiler files are staged below the candidate's environment home.
Kova independently bounds exported bytes, accepts only complete zero-exit
streams, and atomically retains them in its own selected destinations. Limits
are 1 MiB for config, 16 MiB for diagnostic reports, and 64 MiB per timeline,
CPU/heap profile, or heap snapshot. Failed exports preserve earlier complete
artifacts but fail the current collection; partial data never counts as success.
Active collection first creates bounded, closed copies in the candidate home.
It copies the byte extent observed when each source is opened; later appends
do not invalidate export of that closed copy. This is not an atomic snapshot
or attestation of candidate data. Malformed records remain visible to the
existing parsers. Copies are removed after collection, within the collection
deadline; incomplete cleanup is reported and requires environment teardown.
Normal teardown stops the service, exports exit-flushed profiles, then destroys
the environment. Retained environments are not stopped or destroyed.

The OCM control plane and its responses remain candidate-owned. Exported
diagnostics, claimed PIDs, runtime identity, and candidate-authored benchmark
values are untrusted data, not attestations. They cannot select A-side source
paths, executable code, destinations, or signal targets. An integrating runner
must admit the Kova revision separately: custom, unreviewed Kova code belongs
in a diagnostic-only sandbox, not the trusted measurement principal.

Use identical transport and instrumentation for baseline and candidate.
Transport overhead remains in measured command time. Existing thresholds and
CPU coverage checks are unchanged. Cross-user process observation can be
restricted by host policy; missing evidence must not qualify a run.

Timeouts still fail. Killing the measurement process group or receiving an OCM
stop/destroy success does not prove all candidate descendants are gone. The
outer privileged runner must quiesce the known candidate UID on every outcome.
Kova does not signal a measurement-side process using a candidate-reported PID.
Failed exports cancel and join the owned launcher and file pipeline before
removing temporary files. Cancellation has a separate two-second settlement
bound; it cannot make a late export successful. If settlement cannot be
confirmed, Kova reports cleanup uncertainty and retains the temporary path
rather than racing an outstanding file creation.

## Command catalogue

```sh
kova catalogue list --product openclaw --json
kova catalogue check --product openclaw --templates verify/templates --personas personas --json
```

`list` prints the catalogue document with `--json`, or one entry per line.
`check` recursively reads JSON files in both supplied directories; either path
may also name one JSON file. Each file must be a template or persona of the
corresponding schema. Missing paths, empty directories and malformed inputs
are findings; symbolic links are rejected.

The check reads every phase command and every persona builder and check. It
never runs those commands. It reports unknown command heads, unlisted flags,
invalid placeholders, shell syntax outside the permitted quoting rules and
entries whose status is `toWrite`. Every finding makes the exit status nonzero.
Catalogue schema errors and duplicate entries also fail the command. A rejected
path does not prevent readable sibling files from being checked.

Flags declare whether they take no value, a required value or an optional value.
The check consumes those operands before matching the complete command, so a
boolean flag cannot hide an unknown subcommand and a value beginning with `--`
remains a value. OCM command words precede options; OpenClaw child options
follow the child name. A parent option keeps its original meaning and is not
rebound to a same-named child option. The listed OCM commands extract
switches before value options and reject repeated flags; the command form determines
whether and where a `--` separator is required. Unquoted pathname patterns and parentheses are rejected because
the shell can expand them or interpret them as operators; brace expansion is
rejected too, even when its individual members are quoted. Placeholders must be
spelled contiguously in the command text; `{env}`, `{run}`, `{kovaRoot}` and the standard-phase `{target}` must also be
unescaped. NUL is rejected. Spaces and tabs delimit
arguments; other Unicode whitespace stays within its argument. Command forms use `[<path>]` for optional positionals and
`<keys...>` for variadic positionals.

Product commands use `ocm @{env} --` or `ocm @{persona:<trait>:env} --`. Both
resolve to the same catalogue entry. For each run, the primary environment and
every persona-provided environment are cloned; the plan resolves each environment
placeholder to that run's clone. The catalogue check validates the written forms
without creating environments or resolving their names.

JSON checks return `schema: "kova.verify.catalogue-check.v1"`, `product`,
`revision`, `ok`, `files`, `commandCount` and `findings`. Each finding identifies
its source file and JSON pointer (`at`), a `code` and a message; command findings
also include the command and, when resolved, the entry or flag involved.
Without `--json`, the check prints a pass/fail count and one line per finding.
See [Command Catalogue](verify/catalogue.md) for entry and command syntax.
