# CLI Reference

Kova requires Node.js 22.5.0 or newer. `kova setup` checks this prerequisite.

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
| `kova verify plan` | Assemble phases for a change from templates and a persona manifest. |
| `kova verify run` | Execute a plan on disposable persona copies and record checkpoints. |
| `kova verify compare` | Classify recorded checkpoint differences and write a verdict. |
| `kova catalogue list` | List the fixed command forms for a product. |
| `kova catalogue check` | Check template and persona commands against a product catalogue. |
| `kova persona build` | Build a protected OpenClaw environment and checked export. |
| `kova persona verify` | Import an export, check its traits and destroy the copy. |
| `kova persona show` | Print a built persona manifest. |
| `kova run --scenario <id>` | Plan or execute one scenario against one target. |
| `kova matrix plan --profile <id>` | Resolve a profile without executing it. |
| `kova matrix run --profile <id>` | Plan or execute a profile matrix. |
| `kova reports` | List stored reports and short run IDs. |
| `kova report <run-id>` | Render a stored report. |
| `kova report compare <a> <b>` | Compare a baseline and current report. |
| `kova report bundle <run-id>` | Create a portable evidence bundle. |
| `kova report paste <run-id>` | Create a fixer-ready handoff. |
| `kova cleanup` | Remove stale Kova-owned environments or artifacts. |

## Personas

```sh
kova persona build --definition personas/openclaw-verification-user.json --out exports/openclaw --execute
kova persona verify --persona exports/openclaw/persona.json --json
# Use an isolated OCM name prefix for builds or verification copies:
kova persona build --definition personas/openclaw-verification-user.json --out exports/openclaw --env-prefix kova-notebook --execute
kova persona show --persona exports/openclaw/persona.json --json
```

Without `--execute`, build prints the runtime, output location and dependency-ordered
builders and checks without creating files or environments. Execution requires an
empty output directory and OCM with state-inclusive config and plugin-path
relocation (see the persona contract below). The
provided definition pins OpenClaw 2026.9.9 and uses the local mock provider and Kova conformance channel; no external credentials
are required. Definitions are trusted executable input, checked against the
catalogue before any environment is created.

The durable environment is protected and stopped after a successful build. Its
Gateway runs as an owned foreground process; no OCM service is installed. Keep
its definition and export with the manifest: verify checks both hashes before
importing, validates the read commands it will execute, starts only the new copy
and removes it afterward. Historical builder commands are not executed or
required to remain in the current catalogue; new builds validate all commands. A failed build names
the trait, removes its incomplete environment and produces no `persona.json`.
Cleanup errors name the environment that still needs attention. Exports may contain
private installation data and are ignored by Git. See the [persona contract](verify/persona.md)
for the definition, manifest and lifecycle.

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
remains a value. Flags must follow the complete command head; placing a flag
between command words produces a `flag-placement` finding, even when the
product CLI accepts that spelling. For example, use `sessions cleanup --json`
instead of `sessions --json cleanup`. The listed OCM commands extract
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

## Verification plans

```sh
kova verify plan --repo ../openclaw --baseline <sha> --change <sha> \
  --intent intent.txt --persona persona.json --out plan.json
```

`plan` reads the two commits, the persona manifest and Kova's `verify/` data.
It selects phases by changed paths, adds setup and file dependencies, and
orders the result. `--extra-phases <file>` adds intent phases and expected
differences. `--json` also prints the complete written plan.

The checkout's origin must identify a GitHub owner/repository through HTTPS or
the supported `git@github.com:` and `ssh://git@github.com/` forms. HTTPS userinfo,
query strings, fragments and malformed repository components are refused;
only the owner/repository identity is recorded.

Documentation and test paths appear in `ignored`; shipped workspace templates
and skills remain eligible. A change containing only ignored paths produces an
empty plan unless intent phases are supplied. Missing traits, keys and commands
marked `toWrite` appear in `withheld`; dependent phases are withheld too.
Uncovered paths appear in `unmapped`. A catalogue finding other than `toWrite`,
a missing or ambiguous file producer, or conflicting order refuses the plan
without replacing the output file. No phase command or model runs during planning.

The [plan contract](verify/plan-and-verdict.md) defines the JSON output,
dependencies and persona resolution. `verify run` executes the saved plan;
`verify compare` classifies the recorded differences.

## Verification runs

```sh
kova verify run --plan plan.json \
  --target-baseline local-build:/path/to/baseline \
  --target-change local-build:/path/to/change --execute --json
```

Without `--execute`, this validates the plan, persona and targets and prints the
proposed phases and copies. It creates no environments or output directories.
`verify run` and `verify compare` require Node.js 22.19.0 or newer for SQLite checkpoints; other
commands retain the Node.js 22.5.0 minimum. Both targets must be clean OpenClaw
checkouts at exactly the commits in the plan. Their versions must be at least
the persona's pinned runtime version. Execution requires native OCM on the same
host; `KOVA_OCM_TRANSPORT_JSON` is unsupported. Import/export temporary files stay
in private directories owned by the run and are removed after each command.
The persona must have a checked `--include-state` export, and its definition's
check scripts must be present in the running Kova installation. Traits withheld
by `minimumRuntime` are accepted when the manifest's successful and withheld
entries match its definition and bound runtime; only successful traits are
checked in the copies. Historical builder commands are retained as provenance
and are not executed or required in the current catalogue. This version accepts
credential-free mock personas. Recordings preserve selected non-secret state. Known generated pairing, signing
and audit secrets are removed from SQLite and retired device JSON files. Generated
Gateway and hook credentials are removed from OpenClaw JSON/JSON5 configuration, its backups and temporary configuration writes, including
initial state and cached copies. Credential-valued row keys become stable SHA-256
fingerprints so distinct rows remain comparable.

The Gateway caller removes public-sharing bearer tokens from sharing and
membership responses before stdout, output files and background records are
written. Sharing metadata remains observable. File-content responses apply the
same credential policy as state capture, using requested and resolved file
identities. TLS and proxy key defaults are relative to the copied OpenClaw state,
not arbitrary path suffixes. Custom Gateway TLS key paths come from the selected
runtime's effective configuration, with its Gateway working directory and home;
configuration includes and environment expansion are resolved by OpenClaw.
Each copy retains every observed key and configuration declaration until
cleanup, including paths replaced by later configuration changes. Mutation
admission records the preceding configuration; subsequent observations retain
the new declarations, and state capture refreshes effective configuration.
Direct and already-running background file calls share that path history for
every readable copy, including companions reached through another Gateway.
Before retaining returned bytes, the caller refreshes effective declarations
for every readable copy within its existing deadline, then merges the latest
operation history. This also covers a companion configuration change that
has committed before the run observes the completed command.
Asset responses apply the same policy to their decoded base64 bytes while
preserving refs, MIME types, errors and unrelated content. Relative document
paths use one file-list metadata lookup to obtain the authoritative root, then
the asset request is fixed to that absolute document path. A missing local
root or an asset identity that changes during the read prevents capture.
Background asset results retain only resolved file identities in their private
envelope; legacy asset records without those identities cannot be replayed
safely because the original document directory was not retained.
Legacy JSON policies apply only at primary/profile state locations or declared
configuration files, including the corresponding fields in include fragments.
Ordinary workspace documents remain byte-for-byte intact, including PEM examples
and paths that resemble key defaults. Case-equivalent spellings share a policy
only when the filesystem confirms they name the same regular file; distinct
files on case-sensitive filesystems remain distinct. Private verification paths
and SQLite sidecar omissions also verify differently cased aliases. Fresh captures
recheck that identity. Verified alias pairs stay in the private result policy for joins after
cleanup. Background file results retain their derived capture policy in the
private operation envelope, bound to that
operation and environment, so joining a completed result does not require
the deleted copy. Older results without declarations require the source
environment to remain available. Original product hashes remain available for conditional writes;
recorded content is filtered and must not be treated as an unmodified config copy.
Native attachment grants are filtered from command output, collected logs,
and declared product log files selected through state, file or asset capture.
Only exact observed values and their JSON-escaped forms are removed; unrelated
bytes and files remain intact. The existing private operation envelope retains
only value fingerprints and declared log paths, so delayed reads and joins after
cleanup use the same protection without retaining grant values. Pending native
attachment output blocks affected log captures until it is known. Malformed or
truncated output makes the phase incomplete and prevents later log capture for
that copy. While this protection applies, a native product log with an incomplete
final record also fails capture explicitly; it is never silently truncated.
Frozen config
patches and attachment temporary files stay inside the disposable environment,
are excluded from observations and are removed with the environment. Valid
Gateway credential references remain metadata and are never resolved for capture.

SQLite WAL/SHM files and rollback journals are not independent observations. The final standard
phase reads environment metadata and captures selected state through this recorder;
raw OCM snapshots and snapshot-producing upgrades are refused in phases and
persona checks. Planned runtime binding uses `ocm start --no-service`. Regenerate
older plans that contain snapshot-producing commands.
Evidence remains private because other
selected state can be sensitive.

The persona definition and its configured programs must be trusted. Copies have
separate environments, stores and ports, but execution has no OS-level boundary.
Programmable configuration is accepted: configured MCP servers, hooks and other
programs retain the host user's permissions, including access outside the copy.
Destination checks and working directories do not confine those programs, even
when they run during persona checks or Doctor. Use a credential-free definition
with only the mock provider and Kova's own plugins.

Relative `KOVA_HOME` paths are resolved before execution. Gateway authentication
comes from the selected copy's JSON/JSON5 configuration, with no fallback to
another environment's configuration or token. Include-based, environment-derived
and SecretRef-derived Gateway authentication is refused with an explicit error.

Execution builds package runtimes through OCM, imports five disposable copies
(one baseline, two change and two baseline noise copies), checks the persona
content and runs the phases in order on each copy. Persona-provided environments
are exported and imported separately for each copy. Their keys resolve to those
copies, including the companion used by `gateway-second-instance`. Saved CLI
pairing and profile checks are prepared inside the imported copy. Imports and
runtime preparation are serialized to respect shared runtime
ownership; product phases remain parallel. Persona checks and phase commands
use a working directory inside their copy, and filesystem destinations are checked after resolving aliases. Gateway processes run in the
foreground without managed services. Product file logs are collected as well as
console output. Repeated destination flags are refused. Helper input files,
including cursor targets, stay inside the copy's output directory. Config patches must
keep known data paths inside the copies and cannot remove the owned log destination
or introduce includes or paths dependent on the shell environment. Gateway request parameters, including response-file inputs, are resolved once
before their destinations are checked. Config patch commands read private copies
of the validated bytes. `config set` applies the same destination and log-baseline
checks to dot or bracket paths and JSON5 or raw values. Shell execution through session messages (`/bash` and `!`) is refused, as is
arbitrary environment execution. Help, polling and stopping scoped shell jobs
remain available. Configuration writes in session-creation messages use
the same destination checks, including TTS preferences and log-file changes.
Debug changes to storage paths that need unavailable runtime settings
are refused. Inherited TTS and cache-output locations are cleared for child
commands; explicit configuration values remain checked.
Explicit session working directories and
file paths must be absolute paths in the copied environments; ambiguous relative
file paths and project, catalog or remote creation selectors are refused.
Session file writes cannot replace the copied configuration. Product destinations
cannot overlap recorded evidence. Ordinary request text remains unchanged.
Rejected command inputs are recorded with exit code 2; later phases still
collect diagnostics. Log offsets advance only after a complete checkpoint is published. An unset `logging.file`
receives a path inside the clone; an explicit path must be absolute and clone-owned. Includes and environment
substitutions in log configuration are refused instead of reading shared logs.
Log capture above 16 MiB or rotation that loses continuity marks the checkpoint incomplete.
Plans must begin with the standard target binding. OCM operands must name the
owned copies, and phase output cannot replace checkpoint or background metadata.
Arbitrary `ocm env exec`, environment creation, and `ocm service` commands are
refused in phase commands; update those phases to the
foreground catalogue entries before running them.

The Gateway caller uses `--from` to bind batch patches to described sessions,
select one stoppable running process from a complete process list, or scope a
search to a created or imported session. Conflicting identities are refused.
Creation responses include `createdIds` according to the catalogue's request
and response rules; explicitly supplied session keys and reused imports do not
declare a new session identity. Each call releases its connection resources
before returning, including after a malformed response, timeout or cancellation
when the peer ignores closure.

Results are under `$KOVA_HOME/artifacts/verify/<id>/`, including `run.json`, the
exact plan, comparison declarations, catalogue and per-copy checkpoints.
The complete persona source exports remain under the run's `.persona/`
directory, with hashes in `run.json.personaExports`; command records always
retain declared `createdIds`. Keep the run directory private like its persona
export. These inputs let comparison distinguish existing ids from newly created
ones without selecting every state path or response. A
command exiting 2 makes its phase incomplete. Failure before the first phase
completes leaves the copy marked not started. These observations are recorded
for comparison; the run command does not decide the product verdict. A failed
capture is recorded under the copy's `captureErrors` and makes that phase
incomplete, while subsequent phases still execute.

The baseline and noise checkpoints can be reused when their cache key and
content hashes match. A dirty Kova checkout bypasses the cache. Secondary
persona exports are checked again before reuse. Execution removes its imported
environments and temporary runtimes, preserving the persona and the evidence.
A cleanup failure is recorded in `run.json` and makes the command exit nonzero.

## Verification comparison

```sh
kova verify compare --run <run-id> --json
```

Reads the saved plan, catalogue, normalization declarations and all five copies
from `$KOVA_HOME/artifacts/verify/<run-id>/`. It writes `verdict.json` in the
`kova.verify.v1` form, `issues.md` and `noise.json` beside `run.json`.
The verdict counts suppressed items by phase and category; `noise.json` records
each item and its exclusion reason, including recognized derived SQLite storage.
Its `findings` list groups classified rows by signal, class and address pattern,
with a total, per-phase counts and representative values. The complete `rows`
list remains the audit trail. `issues.md` begins with that findings table before
the shared failures. Saved build-ID declarations align Control UI assets by name
without dropping endpoints or hiding changed outcomes. `--json` also prints the
verdict; otherwise the command prints a short result. A completed comparison
exits zero for any verdict; read `verdict` to distinguish `good-to-go`, `breaks`
and `unresolved`. Invalid UTF-8 in checkpoint text produces `unresolved` with
copy, phase, file and decoding failure under `damaged`; affected phases produce
no rows. Other invalid input or unreadable recordings exit nonzero.
For undamaged recordings, any observed break makes the verdict `breaks`, even
when another phase is incomplete or a copy did not start. `notExercised` lists
those missing observations and the captured failing commands with their exits.

Every remaining difference becomes `fixed`, `intended`, `flaky` or `break`,
while failures shared with the baseline become `not-caused` and appear in
`issues.md`. Only an exact saved `intent.expects` entry makes a difference
intended. The two noise copies exclude varying items; undeclared varying
addresses appear in `undeclared`. No release threshold is read. See
[Rows and classification](verify/plan-and-verdict.md#rows) for normalization,
the first-match table, and verdict precedence.
