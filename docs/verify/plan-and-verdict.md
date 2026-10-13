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

The plan uses the intent file to add phases that exercise the goal and the
protected behavior. The comparison uses it to tell an intended difference from
a break. Nothing else in a verification reads free text.

## Selecting Phases

`kova verify plan` selects phases by script, without judgement:

1. Read the changed paths with `git diff --name-only <baseline> <change>` in
   `--repo`.
2. Drop every path that matches an `ignore` glob in `verify/standard.json`
   (documentation and tests).
3. Match each remaining path against the `paths` of every area file in
   `verify/areas/`. A path no area owns is recorded in `unmapped` as
   `no template for <path>`; the verdict repeats it.
4. In each matched area's template, select every phase whose own `paths`
   match a changed path. A template's `setup` phases are selected whenever any
   other phase of that template is.
5. Add the standard phases before and after everything else.
6. Add the phases from `--extra-phases`, if given. These are the phases written
   from the intent file; see [Intent phases](#intent-phases).
7. Resolve every `{persona:<trait>:<key>}` placeholder from the persona
   manifest. A phase that needs a trait or key the manifest lacks is
   withheld: it is listed in `withheld` with what is missing, and it does not
   run.
8. Run the catalogue check on every command. A phase that calls an entry with
   status `toWrite` is withheld the same way. Any other finding (a command with
   no entry, a flag the entry does not list, a placeholder outside the allowed
   four) refuses the whole plan; nothing is written.

A documentation-only or test-only change selects no area and yields a plan with
only the standard phases and no template phases.

Nobody edits a plan after it is written. A different plan is a different run.

## Standard Phases

The standard phases run on both sides around everything else. They are fixed
in `verify/standard.json`:

- before: clone the persona, start the Gateway, read status;
- after: read status, run Doctor, stop the Gateway, snapshot the state.

Starting the change runtime on a clone of the persona is itself an existing
installation being updated: the persona is always built with an older
OpenClaw than either side, so the first start migrates its data on both sides.
A difference in that migration is a difference like any other. The explicit
upgrade journeys are not standard phases; they are the first phases of the
`update` template and run only when the change touches that area.

## Intent Phases

`kova verify plan` never calls a model. The phases that exercise the change's
goal and its protected behavior are written outside Kova, by an agent or a
person given only the intent file and the change's diff, and passed to `plan`
with `--extra-phases <file>`. The file holds a JSON array of phases in the template
phase form (see [Template form](derive-area-template.md#template-form)), each
with `from` set to `intent:goal` or `intent:protected`. Their commands come
from the catalogue and pass the same check as template commands.

## Plan Form

`plan.json`, written by `kova verify plan`:

```json
{
  "schema": "kova.verify.plan.v1",
  "change": {
    "repo": "openclaw/openclaw",
    "baseline": "<40-character sha>",
    "change": "<40-character sha>",
    "paths": ["src/config/sessions/session-transcript-search.ts"]
  },
  "intent": {
    "goal": "<the Goal line>",
    "protected": "<the Protected line>"
  },
  "persona": { "id": "openclaw-verification-user", "version": "<manifest version>" },
  "phases": [
    { "id": "clone-persona", "from": "standard" },
    { "id": "start-gateway", "from": "standard" },
    { "id": "status-before", "from": "standard" },
    { "id": "active-turn", "from": "template:sessions" },
    { "id": "search-during-turn", "from": "template:sessions" },
    { "id": "search-after-restart", "from": "template:sessions" },
    { "id": "goal-search-complete", "from": "intent:goal" },
    { "id": "protected-progress-cards", "from": "intent:protected" },
    { "id": "status-after", "from": "standard" },
    { "id": "doctor", "from": "standard" },
    { "id": "stop", "from": "standard" },
    { "id": "snapshot", "from": "standard" }
  ],
  "withheld": [
    { "id": "delete-during-search", "from": "template:sessions", "missing": ["trait:sessions-thousands-near-cap"] }
  ],
  "unmapped": [],
  "extraPhases": { "file": "<path given to --extra-phases>", "input": ["intent", "diff"] }
}
```

Each entry in `phases` carries the full phase as its template or the extra
phases file defines it, with placeholders other than `{env}` and `{run}`
already resolved; the example shows only `id` and `from`. `from` records where
every phase came from: `standard`, `template:<area>`, `intent:goal` or
`intent:protected`. The persona manifest version is recorded so a verdict is
never compared across persona builds.

## Running The Plan

`kova verify run --plan plan.json --target-baseline <selector> --target-change
<selector> --execute`:

- clones the persona twice and runs `kova persona verify`'s checks on each
  clone before the first phase, so a drifted persona is caught before anything
  is compared;
- installs the baseline target on one clone and the change target on the
  other, using Kova's selectors (`local-build:<path>`, `npm:<version>`,
  `runtime:<name>`);
- runs the phases on both sides in parallel, resolving `{env}` to the side's
  environment and `{run}` to the side's run directory;
- records a checkpoint after every phase on each side;
- reports a side that fails before its first phase as `not started`, and
  compares nothing for it;
- caches the baseline side, keyed by the baseline commit and the plan's hash,
  together with two noise runs (see [Noise floor](#noise-floor));
- writes `run.json` with both run ids, the targets and every phase's outcome,
  and destroys its clones.

Phases run in plan order. A command started with `--background` keeps running
under later phases until a later command joins it with `--wait`; see the
[background protocol](catalogue.md#background-protocol).

## Checkpoint Form

After every phase, on each side, Kova records:

```text
checkpoints/<side>/<phase-id>/
  commands.json   each command, its exit code, stdout, stderr and duration
  responses.json  Gateway and HTTP replies made during the phase
  logs.txt        Gateway and agent log lines since the previous checkpoint
  timing.json     per-command and per-request durations
  state/          snapshot of the OPENCLAW_HOME paths the phase names
  doctor.json     when the phase's checkpoint list includes doctor
  screen.png      when a browser step ran
```

`<side>` is `baseline` or `change`. A phase's `checkpoint` list names what to
record: `responses`, `logs`, `timing`, `state:<path>` (for example
`state:sessions`), `doctor`, `screen`. Command results are always recorded.

## Noise Floor

Two runs of the same commit differ in timestamps, ids and ordering. To keep
those out of the verdict, the baseline side is run twice more at the baseline
commit and cached with it. Every difference between those two runs is part of
the noise set, and compare excludes it from every comparison against that
baseline. The verdict records how many differences the noise set removed.

## Classes

Compare pairs the checkpoints of each phase and lists every difference by
phase and signal (`responses`, `logs`, `timing`, `state`, `doctor`, `screen`,
`commands`). Timing differs when a command or request reaches its bound on one
side and not on the other; absolute durations are recorded but never measured
against a threshold, and RSS and CPU are not part of the verdict.

Each difference gets exactly one class. The table is read top to bottom and the
first row that matches wins:

| Class | Matches when | Effect |
|---|---|---|
| `break` | Seen on the change side only, not explained by the intent file, and seen again when the change side is rerun | Verdict `breaks` |
| `intended` | Seen on the change side only and explained by the `Goal:` line | None; `explainedBy` names the line |
| `not-caused` | Seen on both sides | Listed in `issues`; never counts against the change |
| `fixed` | Seen on the baseline side only | None |
| `flaky` | Seen on the change side only, not explained, and not seen again on one rerun | Verdict `unresolved` |

A difference is explained by the `Goal:` line when it is recorded in a phase
written from that line (`from: "intent:goal"`): those phases exist to show the
intended difference. A difference in a phase written from the `Protected:` line
is never intended.

The verdict is `breaks` when any difference is a `break`, otherwise
`unresolved` when any is `flaky`, otherwise `good-to-go`.

## Verdict Form

`verdict.json`, written by `kova verify compare`:

```json
{
  "schema": "kova.verify.v1",
  "change": { "repo": "openclaw/openclaw", "baseline": "<sha>", "change": "<sha>" },
  "persona": { "id": "openclaw-verification-user", "version": "<manifest version>" },
  "verdict": "good-to-go | breaks | unresolved",
  "differences": [
    { "phase": "search-during-turn", "signal": "timing", "baseline": "1.2s", "change": "hang > 60s", "class": "break", "explainedBy": null },
    { "phase": "goal-search-complete", "signal": "responses", "baseline": "indexing", "change": "complete", "class": "intended", "explainedBy": "intent:goal" },
    { "phase": "doctor", "signal": "logs", "baseline": "warn X", "change": "warn X", "class": "not-caused", "issue": true }
  ],
  "issues": [
    { "phase": "doctor", "seenOn": "both", "summary": "warn X on the baseline" }
  ],
  "withheld": [],
  "unmapped": [],
  "noiseExcluded": 3,
  "runs": { "baseline": "<run id>", "change": "<run id>", "noise": ["<run id>", "<run id>"] }
}
```

`issues.md` lists the `not-caused` rows for a human reader: each issue, the
phase it was seen in and the evidence on both sides. Issues are problems that
exist without the change; they are reported so they can be fixed on their own,
and they never block the change.

`kova verify compare` is separate from `kova report compare`, which compares
two Kova reports for status and metric regressions and keeps its
`kova.compare.v1` form unchanged.
