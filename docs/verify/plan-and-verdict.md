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

## The Standard File

`verify/standard.json` holds what every plan shares:

```json
{
  "schema": "kova.verify.standard.v1",
  "ignore": {
    "documentation": ["docs/**", "**/*.md", "!docs/reference/templates/**", "!skills/**", "!custodian-skills/**", "!extensions/*/skills/**"],
    "tests": ["**/*.test.ts", "test/**"]
  },
  "compressed": [
    { "path": "agents/*/agent/openclaw-agent.sqlite", "table": "transcript_events", "column": "event_zstd", "codec": "zstd" }
  ],
  "stateIds": [
    { "path": "agents/*/agent/openclaw-agent.sqlite", "table": "session_windows", "column": "session_id", "recordKey": "session_key", "order": "created_at" }
  ],
  "before": [{ "id": "use-target", "commands": ["..."], "checkpoint": ["logs"], "timeoutMs": 300000 }],
  "after": [{ "id": "doctor", "commands": ["..."], "checkpoint": ["doctor"], "timeoutMs": 120000 }]
}
```

`ignore` lists the paths a plan never selects phases for: documentation and
test files. A file OpenClaw ships and loads at run time, such as a workspace
template or a bundled skill, is product behavior and is never ignored; the
globs exclude it with `!`. A path is ignored when it matches a glob in either
list and matches no `!` glob in that list; the order of the globs does not
matter. `stateIds` declares where OpenClaw stores ids it
generates without a command reporting them, and `compressed` the database
columns OpenClaw stores compressed (see [Rows](#rows)); the example's table
and column names are illustrative. `before` and `after` are the standard
phases, each in the template phase form without `kind`, `paths` or
`requires`; they alone may use the `{target}` placeholder, the installed OCM
runtime name prepared for the side's target selector:

- before: `use-target` switches the clone to the side's target runtime,
  `start-gateway` starts the owned foreground Gateway and writes
  `{run}/gateway.json`, and `status-before` reads status;
- after: `status-after` reads status, `doctor` runs Doctor, `stop-gateway`
  joins that handle to stop the owned Gateway, `snapshot` snapshots the state.

The persona is always built with an OpenClaw no newer than either side, so
starting the Gateway on the side's runtime is an existing installation being
updated: the first start migrates the persona's data, and the `start-gateway`
checkpoint records it on both sides. A difference in that migration is a
difference like any other. The explicit upgrade journeys are not standard
phases; they belong to the `update` template and run only when the change
touches that area.

## Phase Identity

Every phase in a plan has a qualified id, `<source>/<id>`: `standard/<id>` for
a standard phase, `<area>/<id>` for a template phase and `intent/<id>` for an
intent phase. Ids are unique within their source, so qualified ids are unique
within a plan. Checkpoints, dependencies, `expects`, `withheld` and the verdict
all name phases by qualified id.

## Selecting Phases

`kova verify plan` selects phases by script, without judgement:

1. Read the changed paths with `git diff --name-only --no-renames -z <baseline> <change>` in
   `--repo`. Renames contribute both the removed and added paths.
2. Set aside every path that matches an `ignore` glob; the plan lists them in
   `ignored`, and the verdict repeats the list. When nothing remains and no
   intent phase is given, the plan is empty: `plan` writes it with no phases
   and `run` refuses it, because there is nothing to compare.
3. Select every phase, in any template, whose own `paths` match a remaining
   path. A phase's paths may lie outside its own area's globs, such as a call
   site in another area that enters this one.
4. Record every remaining path that no selected phase lists in `unmapped`: as
   `no phase for <path> in <area>` when an area file in `verify/areas/` owns
   it, otherwise as `no template for <path>`.
5. Add the phases from `--extra-phases`, if given.
6. Add the phases every selected phase depends on: a template's `setup` phases
   whenever any other phase of that template is selected, and, repeatedly, the
   phase that writes each `{run}` file a selected phase reads, whichever
   source it comes from (see [Order and dependencies](#order-and-dependencies)).
   A `{run}` file that a selected phase reads and no phase writes refuses the
   plan. A selected command with `--background --handle` also includes every
   phase that joins that handle with `--wait`, preserving the producer-before-
   reader order. A background start with no join refuses the plan. Every join
   records command status, timeout and creation metadata; its phase keeps its
   chosen checkpoint signals, including whether to retain JSON responses.
7. Add the standard phases. A plan for a change with any non-ignored path, or
   with any intent phase, always runs them, even when no template phase is
   selected, so the Gateway start, the migration and Doctor are compared for
   every change.
8. Check every phase against the persona manifest. A phase is withheld when a
   trait in its `requires` is missing from the manifest, or when a
   `{persona:<trait>:<key>}` placeholder in its commands names a trait or key
   the manifest lacks. Other placeholders of that form are resolved to their
   values, except environment keys, which remain placeholders until `run`
   creates each clone's copy. The catalogue check uses the command as written
   before this resolution. The resolved commands are checked again so a key
   value cannot introduce an unlisted option or remove a required operand.
9. Run the catalogue check on every command. A phase that calls an entry with
   status `toWrite` is withheld. Any other finding (a command with no entry, a
   flag the entry does not list, a placeholder that is not allowed there)
   refuses the whole plan, and nothing is written.
10. Order the phases (see [Order and dependencies](#order-and-dependencies)).

A withheld phase is listed in `withheld` with what is missing, and it does not
run. A phase that depends on a withheld phase is withheld with it; when a
`setup` phase is withheld, every other phase of its template is withheld
too. A background producer is also withheld when a required join is withheld,
so an active start cannot lose its recorded completion. The verdict
repeats `unmapped` and `withheld`, so a reader sees what was not exercised.

Nobody edits a plan after it is written. A different plan is a different run.

## Order And Dependencies

A phase depends on another when one of its commands reads a `{run}/<name>`
file the other phase writes: the writer names it with `--handle` or `--out`,
the reader with `--wait`, `--from` or another `--*-from` flag. The plan finds
these pairs from the command text. A `{run}` file name may be written by the
commands of only one phase; when two phases write the same name, the plan is
refused and names them, even within the same template. A reader therefore
joins one producing phase, whichever source it comes from. A phase may read
a file it wrote earlier in its own command list. For these dependency checks,
environment aliases naming the same source environment denote one identity,
including an alias of the primary persona environment. The written commands
keep their original symbolic placeholders; a source environment name is not
substituted into an output filename.

The plan orders all selected phases so that every one of these holds:

1. the standard `before` phases come first and the standard `after` phases
   last;
2. phases of one template keep the template's order;
3. a phase that writes a `{run}` file comes before every phase that reads it;
4. a phase that removes or replaces persona content, that is, one that calls a
   `destructive` catalogue entry with a `{persona:<trait>:<key>}` value, comes
   after every other phase that names any key of that trait or lists it in
   `requires`, unless that phase also removes or replaces content of the same
   trait; such phases keep the tie-break order among themselves. Restarting or
   stopping the Gateway calls a `destructive` entry without a persona value; it
   removes no persona content and this rule does not order it.

Where these leave a choice, `setup` phases come before `operation` phases and
those before `event` phases; then templates go in order of area id, with
intent phases after every area; then each source keeps its own order. An
intent phase takes the `kind` it declares. When the rules cannot all hold, the
plan is refused and names the phases in conflict.

## Intent Phases

`kova verify plan` never calls a model. The phases that exercise the change's
goal and its protected behavior are written outside Kova, by an agent or a
person whose only description of the change is the intent file and the
change's diff; they draw commands, persona keys and phase ids from the
catalogue, the persona manifest and the templates. The phases are passed to
`plan` with `--extra-phases <file>`. Their commands come from the catalogue and pass
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
    { "phase": "intent/goal-search-complete", "signal": "responses", "at": "0/result/indexing", "change": false },
    { "phase": "sessions/search-history", "signal": "responses", "at": "0/result/indexing", "change": false }
  ]
}
```

`phases` are in the template phase form (see
[Template form](derive-area-template.md#template-form)) plus `from`, set to
`intent:goal` or `intent:protected`.

`expects` lists each difference the `Goal:` line predicts. An entry names a
qualified phase, a signal, the item within that signal (`at`, in the form the
[Rows](#rows) section gives for that signal) and the value the change side is
predicted to show there (`change`), which is `{"absent": true}` when the item
is predicted to disappear. Nothing is ever expected from the
`Protected:` line. `expects` is the only way a difference becomes `intended`,
and only a difference at that exact item with that exact change-side value:
any other difference in the same phase and signal is classed on its own.

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
    "expects": [
      { "phase": "intent/goal-search-complete", "signal": "responses", "at": "0/result/indexing", "change": false },
      { "phase": "sessions/search-history", "signal": "responses", "at": "0/result/indexing", "change": false }
    ]
  },
  "persona": {
    "id": "openclaw-verification-user",
    "version": "<manifest version>",
    "manifest": "<absolute path of the persona.json given to --persona>",
    "sha256": "<hash of that manifest>"
  },
  "phases": [
    { "id": "standard/use-target", "from": "standard" },
    { "id": "standard/start-gateway", "from": "standard" },
    { "id": "standard/status-before", "from": "standard" },
    { "id": "sessions/setup-turn-in-flight", "from": "template:sessions" },
    { "id": "sessions/search-history", "from": "template:sessions" },
    { "id": "intent/goal-search-complete", "from": "intent:goal" },
    { "id": "standard/status-after", "from": "standard" },
    { "id": "standard/doctor", "from": "standard" },
    { "id": "standard/stop-gateway", "from": "standard" },
    { "id": "standard/snapshot", "from": "standard" }
  ],
  "phasesSha256": "<hash of the phases array>",
  "withheld": [
    { "id": "sessions/delete-during-search", "from": "template:sessions", "missing": ["trait:sessions-thousands-near-cap"] }
  ],
  "unmapped": [],
  "ignored": ["docs/concepts/session.md"],
  "extraPhases": { "file": "<path given to --extra-phases>" }
}
```

- `change.paths` lists every changed path, before the ignore globs are applied.
- Each entry in `phases` carries the full phase as its source defines it, with
  its qualified id, in run order, with `{persona:…}` already replaced except
  `{persona:<trait>:env}`, which `run` resolves to each clone's copy;
  `{kovaRoot}`, `{env}` and `{run}` are replaced by `run`, from the Kova that
  runs the plan and per clone, so the scripts that run are always the ones
  the cache key describes. The
  example shows only `id` and `from`, and assumes the catalogue has the
  generic Gateway caller.
- `from` records where every phase came from: `standard`, `template:<area>`,
  `intent:goal` or `intent:protected`.
- `phasesSha256` is the SHA-256 of the `phases` array serialized as JSON with
  object keys sorted and no whitespace. It identifies the phases to run,
  independently of the change, so a later change that selects the same phases
  can reuse a cached baseline.
- `withheld[].missing` names each missing thing as `trait:<trait>`,
  `key:<trait>:<key>`, `entry:<catalogue entry id>` or `phase:<qualified id>`.
- `intent.expects` is copied from the extra phases file.
- `persona` records the manifest the plan was resolved against; `run` refuses
  a manifest whose hash differs.

## Running The Plan

`kova verify run --plan plan.json --target-baseline local-build:<path>
--target-change local-build:<path> --execute`:

1. Checks the targets. Each must be a `local-build:` checkout whose `HEAD` is
   exactly the plan's commit for that side, with no uncommitted changes; any
   other selector, commit or state is refused, so a verdict always describes
   the commits it names. It reads each target's OpenClaw version and refuses a
   target older than the persona's runtime: running older code on newer data
   is a downgrade, and every difference it showed would be spurious.
2. Checks the persona export's hash against the manifest, then creates every
   clone by importing that export: one clone for the baseline side, two for
   the change side, and two for the baseline noise runs (see
   [Noise floor](#noise-floor)). The baseline and noise clones are skipped
   when a cached baseline matches the cache key: the baseline commit, the
   manifest hash, `phasesSha256`, the Kova revision running the plan (its
   commit in a source checkout, its version when installed) and the OCM
   version, since Kova's scripts, its comparison rules and OCM's environment
   handling shape every recorded value. The key is the SHA-256 of those five
   values joined by line breaks. When the Kova
   checkout has uncommitted changes, the run neither reads nor writes the
   cache and records all three baseline clones afresh.
   A persona trait that provides an environment of its own is cloned the same
   way for each clone, and `{persona:<trait>:env}` resolves to that clone's
   copy; a run never touches the durable second installation.
3. Runs `kova persona verify`'s checks on every clone, still on the persona's
   own runtime, so a drifted persona is caught before either target touches
   its data.
4. Runs the phases on every clone in parallel, in plan order, resolving `{env}`
   to the clone's environment and `{run}` to the clone's directory. The first
   standard phase switches the clone to its side's target.
5. Records a checkpoint after every phase on every clone.
6. Reports a clone that fails before its first phase completes as
   `not started`.
7. Caches the baseline clone's directory and the two noise directories under
   that key, in `verify/cache/<key hash>/` in Kova's artifact store.
8. Writes `run.json` and destroys the clones.

Every run has an id and a directory in Kova's artifact store (under `~/.kova`
by default), laid out as:

```text
verify/<run id>/
  run.json
  baseline/      the baseline clone's directory, or a link to the cached one
  change-1/      the first change clone's directory
  change-2/      the second change clone's directory
  noise-1/       the first noise clone's directory, or a link to the cached one
  noise-2/       the second
  verdict.json   written by compare
  issues.md      written by compare
```

`run.json`:

```json
{
  "schema": "kova.verify.run.v1",
  "id": "<run id>",
  "plan": { "path": "<plan.json>", "sha256": "<hash>" },
  "kova": "<Kova commit or version>",
  "ocm": "<OCM version>",
  "targets": {
    "baseline": { "selector": "local-build:<path>", "commit": "<sha>", "version": "<OpenClaw version>" },
    "change": { "selector": "local-build:<path>", "commit": "<sha>", "version": "<OpenClaw version>" }
  },
  "clones": {
    "baseline": { "cached": false, "started": true, "phases": { "<qualified id>": "recorded | no checkpoint" } },
    "change-1": { "started": true, "phases": {} },
    "change-2": { "started": true, "phases": {} },
    "noise-1": { "cached": false, "started": true, "phases": {} },
    "noise-2": { "cached": false, "started": true, "phases": {} }
  }
}
```

Cost: every run needs five clones of the persona, each running the whole plan
in parallel: the baseline, two change clones and two noise clones. The
baseline and the two noise clones are cached per baseline commit, plan phases,
persona build, Kova revision and OCM version, so a later change with the same
key needs only its two change clones.

Like Kova's existing `kova run`, `kova verify run` is a dry run unless
`--execute` is present: without it, it prints what it would do.

A command started with `--background` keeps running under later phases until a
later command joins it with `--wait`; see the
[background protocol](catalogue.md#background-protocol).

## Commands

Phase commands are shell command strings, run the way Kova runs scenario
commands. So that the catalogue bounds what a phase runs, a phase command may
contain `$`, a backtick, `;`, `|`, `&`, `<`, `>` or a line break only inside a
single-quoted argument, where the shell does not interpret them; the catalogue
check refuses any other occurrence.

`{env}`, `{kovaRoot}`, `{run}` and, in standard phases, `{target}` are
replaced shell-quoted, so they may appear anywhere outside quotes, including
inside a word (`ocm @{env} -- plugins list`, `{run}/turn.json`); the catalogue
check refuses them inside a quoted argument. A product command may instead
name an environment the persona holds, `ocm @{persona:<trait>:env} -- ...`,
which the plan checks like any persona key and `run` resolves to each clone's
copy. A script that needs
a run file's content inside JSON reads it through a `--*-from` flag instead. A
`{persona:<trait>:<key>}` value is replaced as it is and may appear anywhere,
including inside a single-quoted JSON argument: a persona key value uses only
letters, digits and `.`, `_`, `-`, `:`, `/`, `@`, which are safe both as a
shell word and inside a JSON string (see [Persona](persona.md#rules)).
`{kovaRoot}` is the root of the Kova checkout or installation running the
plan.

## Checkpoint Form

After every phase, on each clone, Kova records into
`<clone directory>/checkpoints/<qualified id>/`:

```text
commands.json   always: each command, its exit code, its stdout when that is not JSON, stderr and duration
responses.json  with responses: the JSON each command printed on stdout, by command index
logs.txt        with logs: Gateway and agent log lines since the previous checkpoint
timing.json     with timing: each command's duration and whether it reached its bound
state/          with state:<path>: a snapshot of that path in the clone's OpenClaw state directory
doctor.json     with doctor: Doctor's JSON output
screen.png      with screen: the last browser screenshot, when a browser step ran
```

A phase's `checkpoint` list names what to record beyond `commands.json`:
`responses`, `logs`, `timing`, `state:<path>` (for example
`state:agents/main/agent/openclaw-agent.sqlite`),
`doctor`, `screen`.

## Rows

Compare splits every checkpoint into items and compares the sides item by
item. A row is one phase, one signal and one item:

| Signal | Item and its address (`at`) | Value |
|---|---|---|
| `checkpoint` | the phase itself (`at` is empty) | `true` when recorded, `false` when not |
| `commands` | a command's exit code, by index (`0/exit`); each normalized line of its text stdout (`0/stdout/<line text>`) | the exit code; the line's count |
| `responses` | one JSON node, by command index and JSON pointer (`0/result/items/0/title`) | a leaf's JSON value; for a container, `{"type": "array", "length": <n>}` or `{"type": "object", "keys": [<sorted keys>]}` |
| `logs` | one normalized log line, by its text | the number of times it appears |
| `timing` | one command, by index | `true` when it reached its bound, `false` when not |
| `state` | see [State items](#state-items) | as for `responses`, or the line's normalized text, or a content hash |
| `doctor` | one Doctor finding, by its code or text | `true` when present |
| `screen` | the screenshot (`at` is empty) | its SHA-256 content hash |

A command's bound is its `--timeout`, or the product's own timeout flag for a
`product` command that has one, or the phase's `timeoutMs` when it has
neither. An item one side has and the other lacks has the value
`{"absent": true}` on the side that lacks it. Absolute durations, RSS and CPU
are recorded but never compared.

### State items

`state:<path>` names a file or directory relative to the clone's OpenClaw
state directory. Each file in it becomes items by its kind:

- a SQLite database: each row's presence is one item, addressed by path,
  table and primary key (`agents/main/agent/openclaw-agent.sqlite:sessions/<key>`),
  valued `true`; each column of the row is its own item, addressed by that
  address and the column name. A TEXT column that holds JSON is parsed, and
  each of its JSON nodes is an item, addressed by the column and a JSON
  pointer. A column OpenClaw stores compressed, declared in the standard
  file's `compressed` list (for example a zstd `event_zstd` column), is
  decompressed and then parsed the same way. Kova reads the database through
  SQLite's read-only online backup, so the snapshot is consistent while the
  Gateway runs; the `-wal` and `-shm` side files are never compared on their
  own.
- a JSON or JSON5 file: one item per JSON node, addressed by path and JSON
  pointer.
- a JSON Lines file: one item per JSON node, addressed by path, line number
  and JSON pointer.
- any other text file: one item per line, addressed by path and line number,
  valued by its normalized text.
- any other file: one item, addressed by path, valued by its SHA-256 content
  hash.

### Normalization

Before items are built, every checkpoint is normalized.

Text lines (log lines, text stdout and text state lines): timestamps become
`<time>`, durations `<duration>`, process ids `<pid>` and port numbers
`<port>`.

Generated ids are replaced only where a declaration says a value is one, so a
model id, a hash or any other value is never mistaken for one and is compared
as it is. There are two declarations:

- A catalogue entry's `creates` lists the JSON pointers in its output that
  hold ids OpenClaw generated for a resource the command created, such as a
  new session's key or id (see [Catalogue form](catalogue.md#catalogue-form)).
  Such an id becomes `<id:<qualified phase>/<command index><pointer>>`,
  naming the command in the plan that created the resource. The token is the
  same on every clone, because the plan is, and it does not move when the id
  also appears elsewhere first.
- The standard file's `stateIds` names the state stores where OpenClaw
  generates ids without a command reporting them: the table and column, the
  stable field of the owning record (`recordKey`) and, when one record key can
  own several ids over time, the column that orders them (`order`). Such an id
  becomes `<id:<path>#<record key value>/<field>/<n>>`, where `<n>` is the id's
  position among the ids of that record key by `order`, counting from 1 (and
  always 1 without `order`). When two or more ids under one record key share
  the same `order` value (or there is no `order`), they share `<n>` and each
  token gains a further part, `.<m>`, the id's position among those tied ids
  by the table's rowid, counting from 1; ids without a tie carry no `.<m>`.
  The token names the owning record; only ties depend on rowid order. A record key that is
  itself a generated id must be declared too, and is replaced first.

Ids present in the persona export are never replaced, whatever declares them,
so an existing id that a change wrongly replaces still shows as a
difference.

Each declared id is replaced by its token wherever its string appears, inside
other strings too (a session key that embeds a generated id), in JSON values,
JSON object keys, file paths and text lines. A row that involves a declared id
can therefore differ only through the id's presence or its position, never
through its value. Values no declaration covers stay as they are; when they
vary from run to run, the noise runs drop them.

An undeclared value that varies from run to run inside an address (a SQLite
primary key, a JSON object key or a file path) gives each clone different
addresses, which the noise runs cannot pair. Compare finds every address
segment that differs between the two noise runs, lists its pattern in the
verdict's `undeclared` list, and drops the items under it; the fix is to
declare that id.

## Noise Floor

Two runs of the same commit still differ in some items after normalization,
such as a value the product computes from the clock, or a log line that
appears only when independent work interleaves one way. The two noise runs repeat
the baseline side at the baseline commit. Every item whose value differs
between them belongs to the noise set, and compare drops rows for those items
before classing. The noise set holds items, not whole signals: a new log line
or a changed response field still counts when the same phase and signal also
hold a noisy item. The verdict records how many rows the noise set removed.

## Classes

`kova verify compare --run <run id> [--json]` reads `run.json`, the plan it
names and the clone directories, and writes `verdict.json` and `issues.md` into
the run's directory; with `--json` it also prints the verdict.

Compare builds rows for the baseline clone against each change clone. A row is
one of two things:

- a **difference**: the baseline and the change clone recorded different values
  for the same item. A phase recorded on one side only is a difference in the
  `checkpoint` signal.
- a **shared failure**: both sides recorded the same failure in the same
  phase. A failure is a command that exited non-zero or reached its bound, an
  error or warning log line (a line OpenClaw logged at level `error` or
  `warn`), or a Doctor finding. The same failure means the same command with
  the same exit code or the same reached bound, the same normalized log line,
  or the same Doctor finding; a command that exits non-zero with a different
  code on each side is a difference. An error or warning line present on both
  sides is a shared failure whatever its count on each side.

A phase is **incomplete** when the baseline clone and a change clone both lack
its checkpoint, or when either noise clone lacks it: without the noise runs,
noise cannot be told apart from a difference. A phase is also incomplete when
any of its commands exits `2` on any clone. For `script` and `gateway`
entries, `2` means the call was malformed; `product` and `ocm` entries keep
their own exit-code meanings, but any exit `2` still makes the phase
incomplete and the verdict `unresolved`.

Each row gets exactly one class. The table is read top to bottom and the first
row that matches wins:

| Class | Matches when | Effect |
|---|---|---|
| `not-caused` | A shared failure | Listed in `issues`; never counts against the change |
| `fixed` | A difference where only the baseline side failed: the baseline recorded a failure the change side did not, or has no checkpoint for a phase the change side recorded | None |
| `intended` | A difference at an item `intent.expects` names, where the change side shows the predicted value | None; `explainedBy` is `intent:goal` |
| `flaky` | Any other difference at an item where only one of the two change clones differs from the baseline | Verdict `unresolved` |
| `break` | Any other difference: both change clones differ from the baseline at the item, whether or not their values agree | Verdict `breaks` |

An intent phase is compared like any other: a command in it that fails the
same way on both sides is a shared failure, classed `not-caused`.

Where a phase came from never makes a difference intended: a crash, an error or
a timeout in a phase written from the `Goal:` line is a difference in the
`commands`, `logs` or `timing` signal, and it is classed `flaky` or `break`
unless `expects` predicts that exact item and value.

The verdict is `unresolved` when any command exits `2` on any clone.
Otherwise it is `breaks` when any row is a `break`; otherwise `unresolved` when
any row is `flaky`, any of the five clones did not start, any phase is
incomplete, or `undeclared` is not empty;
otherwise `good-to-go`. `good-to-go` speaks only for the phases that ran; the
verdict's `unmapped` and `withheld` lists say what did not.

## Verdict Form

`verdict.json`, written by `kova verify compare`:

```json
{
  "schema": "kova.verify.v1",
  "change": { "repo": "openclaw/openclaw", "baseline": "<sha>", "change": "<sha>" },
  "persona": { "id": "openclaw-verification-user", "version": "<manifest version>" },
  "verdict": "good-to-go | breaks | unresolved",
  "rows": [
    { "phase": "sessions/search-history", "signal": "timing", "at": "0", "clones": ["change-1", "change-2"], "baseline": false, "change": true, "class": "break", "explainedBy": null },
    { "phase": "intent/goal-search-complete", "signal": "responses", "at": "0/result/indexing", "clones": ["change-1", "change-2"], "baseline": true, "change": false, "class": "intended", "explainedBy": "intent:goal" },
    { "phase": "standard/doctor", "signal": "doctor", "at": "<finding code>", "clones": ["change-1", "change-2"], "baseline": true, "change": true, "class": "not-caused", "explainedBy": null }
  ],
  "issues": [
    { "phase": "standard/doctor", "signal": "doctor", "at": "<finding code>", "summary": "<the finding>, recorded on both sides" }
  ],
  "intent": { "goal": "<the Goal line>", "protected": "<the Protected line>" },
  "notStarted": ["<clone name>"],
  "incomplete": ["<qualified id>"],
  "withheld": [],
  "unmapped": [],
  "ignored": [],
  "undeclared": ["<state path or JSON pointer with the varying segment as *>"],
  "noiseExcluded": 3,
  "run": "<run id>"
}
```

`rows` holds every classed row, differences and shared failures alike. A row
that both change clones show with the same value is listed once, with both
clones in `clones`; when the two change clones show different values for the
same item, each is listed with its own clone. A `flaky` row lists the one
clone that shows it. `issues` repeats the `not-caused` rows with a one-line
summary. `issues.md` lists the
same rows for a human reader: each issue, the phase it was seen in and the
evidence on both sides. Issues are problems that exist without the change;
they are reported so they can be fixed on their own, and they never block the
change.

`kova verify compare` is separate from `kova report compare`, which compares
two Kova reports for status and metric regressions and keeps its
`kova.compare.v1` form unchanged.


The standard Gateway lifecycle uses the task-owned foreground start/stop entries,
with `--no-service` runtime preparation. It does not install or start an OCM
service. A phase that pauses the Gateway for a database fixture reads the same
`{run}/gateway.json` handle; that file has one producing standard phase.
