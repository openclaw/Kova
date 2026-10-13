# Plan And Verdict

A verification has three steps: `kova verify plan` writes the plan,
`kova verify run` executes it on both sides and records checkpoints, and
`kova verify compare` turns the checkpoints into a verdict. This page defines
what each step reads and writes. See the [overview](README.md) for the terms.

## The Intent File

`intent.txt` holds two lines, written by whoever asks for the verification:

```text
Goal: <what the change is meant to do, as behavior a user sees>
Protected: <what the change must not alter>
```

The intent file is the input for the phases written for this change (see
[Intent phases](#intent-phases)). The plan records both lines so the verdict
shows what the change was checked against.

## Selecting Phases

`kova verify plan` selects phases by script, without judgement:

1. Read the changed paths with `git diff --name-only <baseline> <change>` in
   `--repo`.
2. Drop every path that matches an `ignore` glob in `verify/standard.json`.
   Those globs name documentation and test files.
3. Match each remaining path against the `paths` of every area file in
   `verify/areas/`. A path no area owns is recorded in `unmapped` as
   `no template for <path>`.
4. In each matched area's template, select every phase whose own `paths`
   match a changed path. A path that an area owns but no phase of its template
   lists is recorded in `unmapped` as `no phase for <path> in <area>`.
5. Add the phases each selected phase depends on: a template's `setup` phases
   whenever any other phase of that template is selected, and, repeatedly, any
   phase that writes a `{run}` file a selected phase reads (see
   [Phase order and dependencies](#phase-order-and-dependencies)).
6. Add the phases from `--extra-phases`, if given. These are the phases written
   from the intent file.
7. When any template or intent phase is selected, add the standard phases
   before and after everything else. Otherwise the plan is empty: there is
   nothing to compare.
8. Check every phase against the persona manifest. A phase is withheld when a
   trait in its `requires` is missing from the manifest, or when a
   `{persona:<trait>:<key>}` placeholder in its commands names a trait or key
   the manifest lacks. Every other placeholder of that form is replaced by its
   value.
9. Run the catalogue check on every command. A phase that calls an entry with
   status `toWrite` is withheld. Any other finding (a command with no entry, a
   flag the entry does not list, a placeholder outside the allowed four)
   refuses the whole plan, and nothing is written.

A withheld phase is listed in `withheld` with what is missing, and it does not
run. A phase that depends on a withheld phase is withheld with it. The verdict
repeats `unmapped` and `withheld`, so a reader sees what was not exercised.

A documentation-only or test-only change selects no area and, without intent
phases, yields an empty plan.

Nobody edits a plan after it is written. A different plan is a different run.

## Phase Order And Dependencies

A phase reads a file another phase wrote when a command names a `{run}/<name>`
path that an earlier phase's command produced: through `--handle` or `--out`
on the writer, and `--wait`, `--from` or another `--*-from` flag on the reader.
The plan finds these pairs from the command text and pulls in the writer of
every file a selected phase reads.

Within one template, phases keep the template's order. Across templates, the
plan runs every `setup` phase first, then every `operation` phase, then every
`event` phase; within each kind, templates are taken in order of area id and
phases in template order. Intent phases run after the template phases and
before the closing standard phases.

## Standard Phases

The standard phases run on both sides around everything else. They are fixed
in `verify/standard.json`, which holds the `before` phases, the `after` phases
and the `ignore` globs, each phase in the template phase form:

- before: switch the clone to the side's target runtime, start the Gateway,
  read status;
- after: read status, run Doctor, stop the Gateway, snapshot the state.

The persona is always built with an older OpenClaw than either side, so
starting the Gateway on the side's runtime is an existing installation being
updated: the first start migrates the persona's data, and the `start-gateway`
checkpoint records it on both sides. A difference in that migration is a
difference like any other. The explicit upgrade journeys are not standard
phases; they belong to the `update` template and run only when the change
touches that area.

## Intent Phases

`kova verify plan` never calls a model. The phases that exercise the change's
goal and its protected behavior are written outside Kova, by an agent or a
person given only the intent file and the change's diff, and passed to `plan`
with `--extra-phases <file>`. Their commands come from the catalogue and pass
the same check as template commands. The file holds:

```json
{
  "phases": [
    {
      "id": "goal-search-complete",
      "from": "intent:goal",
      "kind": "operation",
      "intent": "A client searches a long session right after a restart and the result is observed.",
      "paths": [],
      "requires": ["session-long-compacted"],
      "commands": ["node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.search --params '{\"agentId\":\"main\",\"query\":\"{persona:session-long-compacted:searchWord}\"}' --timeout 60000"],
      "checkpoint": ["responses", "logs", "timing"],
      "timeoutMs": 90000,
      "browser": false,
      "slow": false
    }
  ],
  "expects": [
    { "phase": "goal-search-complete", "signal": "responses" },
    { "phase": "search-history", "signal": "responses" }
  ]
}
```

`phases` are in the template phase form (see
[Template form](derive-area-template.md#template-form)) plus `from`, set to
`intent:goal` or `intent:protected`. `expects` names each difference the
`Goal:` line predicts, as a phase and a signal; it may name a template phase as
well as an intent phase. Nothing is ever expected from the `Protected:` line.
`expects` is the only way a difference becomes `intended`; see
[Classes](#classes).

## Plan Form

`plan.json`, written by `kova verify plan`:

```json
{
  "schema": "kova.verify.plan.v1",
  "change": {
    "repo": "<the checkout's origin repository, such as openclaw/openclaw>",
    "baseline": "<40-character sha>",
    "change": "<40-character sha>",
    "paths": ["src/config/sessions/session-transcript-search.ts"]
  },
  "intent": {
    "goal": "<the Goal line>",
    "protected": "<the Protected line>",
    "expects": [{ "phase": "goal-search-complete", "signal": "responses" }]
  },
  "persona": {
    "id": "openclaw-verification-user",
    "version": "<manifest version>",
    "manifest": "<absolute path of the persona.json given to --persona>",
    "sha256": "<hash of that manifest>"
  },
  "phases": [
    { "id": "use-target", "from": "standard" },
    { "id": "start-gateway", "from": "standard" },
    { "id": "status-before", "from": "standard" },
    { "id": "setup-turn-in-flight", "from": "template:sessions" },
    { "id": "search-history", "from": "template:sessions" },
    { "id": "goal-search-complete", "from": "intent:goal" },
    { "id": "status-after", "from": "standard" },
    { "id": "doctor", "from": "standard" },
    { "id": "stop-gateway", "from": "standard" },
    { "id": "snapshot", "from": "standard" }
  ],
  "withheld": [
    { "id": "delete-during-search", "from": "template:sessions", "missing": ["trait:sessions-thousands-near-cap"] }
  ],
  "unmapped": [],
  "extraPhases": { "file": "<path given to --extra-phases>" }
}
```

- `change.paths` lists every changed path, before the ignore globs are applied.
- Each entry in `phases` carries the full phase as its source defines it, with
  `{persona:…}` and `{kovaRoot}` already replaced; `{env}` and `{run}` are
  replaced per side when the plan runs. The example shows only `id` and `from`.
- `from` records where every phase came from: `standard`, `template:<area>`,
  `intent:goal` or `intent:protected`.
- `withheld[].missing` names each missing thing as `trait:<trait>`,
  `key:<trait>:<key>`, `entry:<catalogue entry id>` or `phase:<phase id>`.
- `intent.expects` is copied from the extra phases file.
- `persona` records the manifest the plan was resolved against. `run` uses the
  environment that manifest names and refuses a manifest whose hash differs;
  the version keeps verdicts from different persona builds apart.

## Running The Plan

`kova verify run --plan plan.json --target-baseline <selector> --target-change
<selector> --execute`:

1. Reads the persona manifest the plan records, and reads the OpenClaw version
   of each target. It refuses to start when either target is older than the
   persona's runtime: running older code on newer data is a downgrade, and
   every difference it showed would be spurious.
2. Clones the persona's environment once for the baseline side, twice for the
   change side, and twice more for the baseline noise runs (see
   [Noise floor](#noise-floor)), unless the baseline and its noise runs are
   already cached.
3. Runs `kova persona verify`'s checks on every clone, still on the persona's
   own runtime, so a drifted persona is caught before either target touches
   its data.
4. Runs the phases on every clone in parallel, in plan order, resolving `{env}`
   to the clone's environment and `{run}` to that clone's run directory. The
   first standard phase switches the clone to its side's target, using Kova's
   selectors (`local-build:<path>`, `npm:<version>`, `runtime:<name>`).
5. Records a checkpoint after every phase on every clone.
6. Reports a clone that fails before its first phase completes as
   `not started`.
7. Caches the baseline side and its two noise runs, keyed by the baseline
   target and the plan's hash, so the next change against the same baseline
   and plan reuses them.
8. Writes `run.json` into the change side's run directory: the plan's path and
   hash, every run id, the targets, and every phase's outcome on every clone.
   Then it destroys the clones.

Like `kova run`, it is a dry run unless `--execute` is present: without it, it
prints what it would do.

A command started with `--background` keeps running under later phases until a
later command joins it with `--wait`; see the
[background protocol](catalogue.md#background-protocol).

## Commands

Phase commands are shell command strings, run the way Kova runs scenario
commands. `{env}`, `{kovaRoot}` and `{run}` are replaced shell-quoted. A
`{persona:<trait>:<key>}` value is replaced as it is; a persona key value
therefore uses only letters, digits and `.`, `_`, `-`, `:`, `/`, `@`, which
are safe both as a shell word and inside a JSON string (see
[Persona](persona.md#rules)). `{kovaRoot}` is the root of the Kova checkout or
installation running the plan.

## Checkpoint Form

After every phase, on each clone, Kova records into
`<run directory>/checkpoints/<phase-id>/`:

```text
commands.json   always: each command, its exit code, stderr and duration
responses.json  with responses: the JSON each command printed on stdout
logs.txt        with logs: Gateway and agent log lines since the previous checkpoint
timing.json     with timing: per-command and per-request durations
state/          with state:<path>: a snapshot of that path in the clone's OpenClaw state directory
doctor.json     with doctor: Doctor's JSON output
screen.png      with screen: the last browser screenshot, when a browser step ran
```

A phase's `checkpoint` list names what to record beyond `commands.json`:
`responses`, `logs`, `timing`, `state:<path>` (for example `state:sessions`),
`doctor`, `screen`.

## Noise Floor

Two runs of the same commit differ in timestamps, ids and ordering. To keep
those out of the verdict, the baseline side is run twice more at the baseline
target and cached with it. Every row that differs between those two runs
belongs to the noise set, and compare drops it before classing. The verdict
records how many rows the noise set removed.

## Classes

`kova verify compare --run <change-run-id> --baseline <baseline-run-id>
[--noise <id>,<id>] --json` pairs the checkpoints of each phase. `--noise`
defaults to the noise runs cached with the baseline. Compare writes
`verdict.json` and `issues.md` into the change run's directory and, with
`--json`, prints the verdict. Run ids are in `run.json`, and compare reads the
plan, including `intent.expects`, through it.

Compare lists rows by phase and signal (`checkpoint`, `commands`, `responses`,
`logs`, `timing`, `state`, `doctor`, `screen`). A row is one of two things:

- a **difference**: the baseline side and the change side recorded something
  different for the same phase and signal. A phase with a checkpoint on one
  side only is a difference in the `checkpoint` signal. Timing differs when a
  command or request reaches its bound on one side and not on the other;
  absolute durations are recorded but never measured against a threshold, and
  RSS and CPU are not part of the verdict.
- a **shared failure**: both sides recorded the same failure in the same phase.
  A failure is a command that exited non-zero or reached its bound, an error
  or warning line in the logs, or a Doctor finding.

Each row gets exactly one class. The table is read top to bottom and the first
row that matches wins:

| Class | Matches when | Effect |
|---|---|---|
| `not-caused` | A shared failure | Listed in `issues`; never counts against the change |
| `fixed` | A difference where only the baseline side failed: the baseline recorded a failure the change side did not, or has no checkpoint for a phase the change side recorded | None |
| `intended` | A difference whose phase and signal the plan's `intent.expects` lists | None; `explainedBy` is `intent:goal` |
| `flaky` | Any other difference that only one of the two change runs shows | Verdict `unresolved` |
| `break` | Any other difference | Verdict `breaks` |

Only `intent.expects` makes a difference intended. Where a phase came from does
not: a crash, an error or a timeout in a phase written from the `Goal:` line is
still a difference in the `commands`, `logs` or `timing` signal, and it is
classed `flaky` or `break` unless `expects` names that phase and signal.

The verdict is `breaks` when any row is a `break`; otherwise `unresolved` when
any row is `flaky` or any clone did not start; otherwise `good-to-go`.

## Verdict Form

`verdict.json`, written by `kova verify compare`:

```json
{
  "schema": "kova.verify.v1",
  "change": { "repo": "openclaw/openclaw", "baseline": "<sha>", "change": "<sha>" },
  "persona": { "id": "openclaw-verification-user", "version": "<manifest version>" },
  "verdict": "good-to-go | breaks | unresolved",
  "differences": [
    { "phase": "search-history", "signal": "timing", "baseline": "1.2s", "change": "bound reached at 60s", "class": "break", "explainedBy": null },
    { "phase": "goal-search-complete", "signal": "responses", "baseline": "indexing", "change": "complete", "class": "intended", "explainedBy": "intent:goal" },
    { "phase": "doctor", "signal": "doctor", "baseline": "warning X", "change": "warning X", "class": "not-caused", "explainedBy": null }
  ],
  "issues": [
    { "phase": "doctor", "signal": "doctor", "summary": "warning X, recorded on both sides" }
  ],
  "notStarted": [],
  "withheld": [],
  "unmapped": [],
  "noiseExcluded": 3,
  "runs": { "baseline": "<run id>", "change": ["<run id>", "<run id>"], "noise": ["<run id>", "<run id>"] }
}
```

`differences` holds every classed row, shared failures included; `issues`
repeats the `not-caused` rows with a one-line summary. `issues.md` lists the
same rows for a human reader: each issue, the phase it was seen in and the
evidence on both sides. Issues are problems that exist without the change;
they are reported so they can be fixed on their own, and they never block the
change.

`kova verify compare` is separate from `kova report compare`, which compares
two Kova reports for status and metric regressions and keeps its
`kova.compare.v1` form unchanged.
