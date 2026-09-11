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

Setup bounds its OCM version probe to 30 seconds. A timed-out probe fails the
required prerequisite check, reports the timeout, and makes setup exit nonzero.

`run` and `matrix run` are dry-run unless `--execute` is present. Matrix runs
also accept `--parallel`, `--repeat`, `--include`, `--exclude`, and `--gate`.
Kova defaults to deterministic mock auth; use `--auth live` only after
configuring credentials with `kova setup`.

Kova stores credentials, reports, artifacts, and baselines under `~/.kova` by
default. See [Agent Usage](AGENT_USAGE.md) for safe execution, cloned-user
upgrades, baseline policy, cleanup, and report handoff.

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
