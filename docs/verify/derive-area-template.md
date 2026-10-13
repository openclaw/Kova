# Deriving An Area Template

An area template tells `kova verify` how users exercise one area of OpenClaw
and under which conditions. The plan for a change is assembled from the
templates of the areas the change touches. This page is the procedure that
produces a template. Derive each area once, and again when the
[scheduled maintenance pass](README.md#the-model) reports that the area's
operations or conditions changed. One derivation runs steps 1 to 7 twice,
independently, and step 8 reconciles the two runs into one template.

The procedure reads OpenClaw's own entry points and documents, not incidents.
Known breaks are used only from step 6 on, to find what the derivation
missed. In a Kova source checkout, the `derive-area-template` skill in
`.agents/skills/` gives an agent these steps as a checklist; it is not part of
the release archive.

## Definitions

- **Area**: one part of the product that users would name as a thing they do,
  owned by a bounded set of source paths and described by its own documents.
  Examples: sessions, update, plugins, config, channels.
- **Entry point**: a way a user or another part of the product reaches the
  area. Kinds: Gateway method, CLI command, UI action, channel route, scheduled
  job, agent or subagent call (including an agent tool action), plugin call,
  and `from <area>` for a call site in another area that enters this one.
- **Operation**: something a user does in the area, named in the user's words.
  One operation usually covers several entry points. Examples: "send a
  message", "search history", "fork a session".
- **Standing condition**: a state the area is normally in, or an event it
  normally goes through, according to the product's documents. Examples: a
  turn in flight, state in cold storage, a Gateway restart, nightly pruning, a
  session of thousands of messages, an incognito session.
- **Phase**: one step of a template: an operation performed under conditions,
  as commands against a product instance, followed by a checkpoint. A phase
  records; it never asserts.
- **Checkpoint**: what is recorded after a phase on each side of a comparison:
  `responses`, `logs`, `timing`, `state:<path>`, `doctor`, `screen`. See the
  [checkpoint form](plan-and-verdict.md#checkpoint-form).
- **Persona trait**: content the persona must contain for a phase to be
  meaningful, named as a short identifier. Example: `session-long-compacted`.
  See [Persona](persona.md).
- **Command catalogue**: the support scripts and product commands a phase may
  call. A phase may name a script that does not exist yet; it is listed under
  `support.toWrite`. See [Command catalogue](catalogue.md).
- **Known breaks**: a JSON file listing OpenClaw changes known to have broken
  user behavior, in the [known breaks form](#known-breaks-form). Its path is
  an input; it can live anywhere, and nothing from it is copied into a
  template.

## Inputs

1. The OpenClaw checkout at a named revision: its source tree and its
   documents.
2. The area's input file `verify/areas/<area>.json` in the
   [area input file form](#area-input-file-form): the area's `id`, its owner
   path globs, the exact list of documents that describe it, the symbols and
   literals step 2 searches for, and the bound decisions (which neighbouring
   areas own which shared entry points). Two runs of this procedure read the
   same input file. When the runs differ because of the bound, the document
   list or the search list, the difference is resolved by editing this file,
   never by preferring one run; every other difference is reconciled by
   step 8.
3. The path to the known breaks for OpenClaw, used from step 6 on.
4. `catalogue/openclaw.json` and the persona manifest, to name existing
   commands and traits. A command or trait they lack is still named, as
   `support.toWrite` or a persona addition.
5. `verify/standard.json`, whose `ignore.tests` globs tell test paths from
   production paths in step 6.

## Output

Files under `verify/templates/<area>/`, written by step 8:

- `template.json` in the [template form](#template-form).
- `derivation.md` in the [derivation record form](#derivation-record-form).
- `coverage.md` in the [coverage table form](#coverage-table-form).
- `comparison.md` in the [comparison form](#comparison-form).

Each of the two runs writes its own `derivation.md`, `coverage.md` and phases
in a working directory of its own, outside `verify/templates/`; only step 8
writes into the template directory.

## Procedure

### Step 1. Bound the area

Do: take the owner globs and the document list from the area's input file.
Read every listed document in full. A document may be added only when a listed
document links to it and it describes an operation of this area; record the
addition. Record the revision.

Output: the `Revision:` and `Date:` lines of `derivation.md`, and its section
`## Bounds`: the globs, and the document paths with each addition marked
`(added: linked from <document>)`.

Rules:

- An entry point belongs to the area when one of the area's documents
  describes it as something the user does here. The input file's bound
  decisions settle shared entry points and operations; do not re-decide them.
  A bound exclude never removes a file step 2's search finds: that file is
  still listed as a `from <area>` entry point, and only its own operations
  belong to the other area.
- Code in another area that reaches this area is not excluded. It is listed in
  step 2 as an entry point of kind `from <area>`.
- Shared infrastructure the area merely uses is excluded and named under
  `## Excluded paths` with its owning area.

### Step 2. Enumerate entry points and group them into operations

Do: for each entry-point kind, list every entry point the area exposes:

- Gateway methods: every registered method whose handler lives under the
  area's globs, or that the area's documents describe.
- CLI commands: every command and subcommand registered from a file under the
  area's globs, or that the area's documents describe.
- UI actions: every action a user can take on the area's pages, from the UI
  page modules under the area's globs and the documents that describe them.
- Channel routes, scheduled jobs, agent and subagent calls, plugin calls: every
  place in the source where the area is entered from elsewhere.

Then group entry points into operations. An operation is named in the user's
words and lists the entry points it covers. Every entry point appears in
exactly one operation, or under `## Excluded entry points` with a one-line
reason (internal, deprecated, test-only, owned by another area).

Output: section `## Operations` of `derivation.md`: a table with columns
Operation, Entry points, Kinds. Then `## Excluded entry points`.

Rules:

- Do not group by implementation. Group by what the user is doing.
- What counts as one entry point: one Gateway method, one CLI command or
  subcommand, one named UI control, one route or call site, one agent tool
  action.
  Flags and parameters are not entry points. Broadcast events the product
  emits are not entry points; list them once under `## Excluded entry points`
  as internal.
- Code in other areas that reaches this area is found by search, not by
  memory: search the source tree for the exact symbols and literals the area
  input file lists under `search` (its writer functions, its method and
  command name literals), and list one entry point per file found, of kind
  `from <area>`. Two runs search for the same list; a run that finds a symbol
  the list lacks reports it for the input file, it does not add its own. A
  file found this way is never excluded as owned elsewhere; only its own
  operations belong to the other area.
- A UI control counts when a document or the page module names it as an action
  with its own effect: a button, menu item, shortcut, link or form field. Shell
  controls shared by every page (navigation, theme, account, settings panel)
  are listed once under `## Excluded entry points` as shell.
- A method of another area that this area's pages call as a dependency
  (listing projects to start a session, reading a model catalog) is listed
  once under `## Excluded entry points` as `consumed from <area>`; it is not an
  operation here.
- The entry-point total in `coverage.md` counts every listed entry point,
  excluded ones included; covered counts those placed in an operation.

### Step 3. Enumerate standing conditions

Do: from the documents read in step 1, list every state the area is normally
in and every event it normally goes through. Take them from the documents' own
statements about lifecycle, state location, isolation, recovery, maintenance,
scale and sharing. Do not take them from incidents; step 6 is the only place
a break can add a condition, and it records that condition as undocumented.

A condition is a state the product is in or an event it goes through on its
own or by configuration, as a document describes it. An action the user
performs is an operation (step 2), not a condition; a manual compaction or a
reset is an operation. The lasting state such an operation leaves (a reset
boundary, a compaction summary in the transcript) is an ambient condition when
a document describes later behavior under it. A state the persona can be put
in counts as an ambient condition when a document describes it as a lasting
state of the product.

Granularity: one condition per state or event a document describes with its
own consequence. A passage that names several states or events yields one
condition each. The Control UI's connection states, and whether it has
finished loading, count when a document describes behavior under them.

Completeness: walk every listed document heading by heading, in order,
including each section the bound names. Under each heading, record every state
or event it states with its own consequence, whether or not a harness can
reach it, or record `none`. Write `## Headings walked` in `derivation.md`: one
line per heading, `<document> "<heading>": <condition numbers> | none`, where a
condition's number is its row number in `## Conditions`, counting from 1. A
heading missing from that list has not been read. Step 8 compares two runs
heading by heading, so a reader's miss shows as a heading where the other run
found a condition.

For each condition record: its name, the document and heading it comes from,
whether it is **ambient** (true while other phases run, such as a turn in
flight) or **event** (needs its own phase, such as a restart), and the persona
trait it needs, if any.

Output: section `## Conditions` of `derivation.md`: a table with columns
Condition, Source, Kind, Persona trait; and section `## Headings walked`.

### Step 4. Write the phases

Do: produce phases of three kinds.

- `setup`: one per ambient condition that must be started rather than provided
  by the persona (a turn in flight, subagents working). It starts the condition
  in the background and later phases run under it.
- `operation`: one per operation from step 2, performed under the ambient
  conditions.
- `event`: one per event condition from step 3, performed on an operation the
  event affects.

Order: setup first, then operations as a user's session would go, then events.
A phase that resets, deletes, archives or otherwise consumes a persona session
runs after every phase that reads that session; destructive and recovery
events run last. The sum of a phase's per-command timeouts may not exceed its
`timeoutMs`.

Each phase has:

- `id`: lower-case words joined by hyphens, unique in the template.
- `kind`: `setup`, `operation` or `event`.
- `intent`: one sentence, what a user is doing and under what condition,
  ending with what is observed.
- `paths`: the source globs of the entry points this phase exercises. The plan
  selects a phase when the change touches one of its paths; `setup` phases are
  selected whenever any phase of the template is.
- `commands`: one or more commands against `{env}`, each calling a product
  command or a catalogue script. A phase that must keep running under later
  phases uses `--background --handle {run}/<name>.json`; a later phase joins it
  with `--wait {run}/<name>.json`.
- `requires`: the persona traits this phase needs, whether or not its commands
  read a key from them (a mock provider's behavior, a configuration the
  persona carries). The plan withholds the phase when the persona lacks one.
- `checkpoint`: the list of what to record, from the defined kinds.
- `timeoutMs`: the bound for the whole phase, at most 300000. A phase that
  needs longer is split, or marked `slow: true`; a `setup` phase is never
  slow. A slow phase may exceed the
  limit, and the plan selects it only when the change touches its own paths
  or when a selected phase reads a `{run}` file it writes, never because
  another phase of its template was selected.
- `browser: true` when a command drives a browser.

Output: the `phases` array of `template.json`.

Rules:

- A phase records; it contains no expected value and no assertion. The
  comparison judges.
- Conditions live in phases. A phase that performs an operation on an idle
  instance when the area's normal state is busy is wrong.
- One operation per phase. Two operations in one phase are two phases, unless
  the condition is that they happen at once; then the intent says so.
- Commands come from the catalogue. A new script is named under
  `support.toWrite` with one line stating the product method it wraps and its
  flags. A product command the catalogue lacks is named there in the form
  `product: <command>  (<what>; <flags>)`.
- Placeholders in commands are `{env}`, `{kovaRoot}`, `{run}` and
  `{persona:<trait>:<key>}` for an identifier the persona provides (a session
  key, an agent id, a file path). No other placeholder and no invented
  literal: a value that names persona content comes from a placeholder, while
  an OpenClaw constant, such as the default agent id `main`, is written as it
  is. A command that needs a value an earlier command produced reads it
  from a file that command wrote under `{run}`; the script that reads it owns
  that resolution.
- Persona traits are named `<noun>-<qualifier>` in lower-case hyphenated
  words. A trait the current persona does not provide is still named; it
  appears in `coverage.md` under persona additions.
- Every persona trait a phase needs is listed in that phase's `requires`,
  including every trait its placeholders name.

### Step 5. Complete the template header

Do: fill `id`, `title`, `objective`, `paths` (from step 1), `requires` (the
union of the phases' `requires`), and `support` (`existing` and `toWrite`).

Output: `template.json` complete.

### Step 6. Cross-check against known breaks

Do: from the known breaks, take every break whose changed paths fall inside
the area's globs. For each, name the phase that would have recorded the
difference, or write `none`. For every `none`, return to step 2 or step 3: an
operation or a condition was missed. Correct it and rerun step 4 for the
affected phases. Repeat until no `none` remains or the remaining ones are
explicitly outside the product's reach (another platform, a real provider's
output) and recorded as such.

Output: section `## Breaks cross-check` of `derivation.md`: a table with
columns Break, Phase, Note.

Rules:

- The breaks correct the derivation; they are never copied into the template.
- A break counts as in the area when at least one of its production paths
  falls inside the globs. A test path is one that matches an `ignore.tests`
  glob in `verify/standard.json`; every other path is a production path. A
  break whose only in-area paths are test paths is listed with the note
  `test-only` and not counted.
- A condition added here must still cite a document. When no document states
  it, add the condition anyway, cite the break in the Note, and list it under a
  `## Undocumented conditions` section of `derivation.md`; the scheduled
  maintenance pass reports that section as a documentation gap in OpenClaw.

### Step 7. Write the coverage table

Do: count operations covered of operations total, conditions covered of
conditions total, entry points covered of entry points total, and breaks
mapped of breaks in the area. An operation is covered when a phase performs
it. A condition is covered when phases run under it: an ambient condition
through a setup phase or a persona trait, an event condition through its own
event phase. An entry point is covered when it is placed in an operation. List
the uncovered items by name.

Output: `coverage.md`.

### Step 8. Reconcile two runs into the template

Do: run steps 1 to 7 twice, independently: two separate sessions or people
that share nothing but the inputs above and this page, each writing into its
own working directory. Then reconcile:

- Entry points: the union by name. An entry point one run placed and the other
  excluded is placed, with the reason recorded.
- Conditions: the union by meaning. Two names for one condition become one,
  keeping both document citations.
- Operations: where the runs grouped differently, keep the finer grouping when
  the finer operation has its own entry-point family (entry points that share
  a Gateway method prefix, a CLI command or a UI page); otherwise keep the
  coarser.
- Phases: for each operation and event condition in the union, take as the
  base the phase whose commands exercise more of that operation's entry
  points, comparing a run's several phases for one operation together; on a
  tie take the phase with the clearer intent. Add a command from the other run
  only when it exercises an entry point, a variant (another mode or flag
  combination of the same entry point) or a condition the base lacks,
  or writes a handle a later phase reads; never duplicate a command that does
  the same thing with different text. Setup phases are merged by condition, one
  per ambient condition. Rewrite script names, flags and their values to one
  convention across the template, with milliseconds for every timeout flag.
- `requires`: the union, duplicates merged by the persona content they
  describe, then renamed to one name and that name applied in every command.
  `support.toWrite` and `support.existing`: the union merged by the product
  method they wrap; a script no phase calls is removed.
- Step 2 and step 3 rules still hold: an item one run placed in breach of them
  (a broadcast event as an entry point, a user action as a condition) is
  corrected, not carried.
- After merging, apply the step 4 order rule again across the whole template.
- Breaks cross-check: the union of mapped breaks.

Output: `verify/templates/<area>/template.json`, `derivation.md` with a
`## Reconciliation` section listing every item taken from only one run, and
`coverage.md`. Also `comparison.md`: for each run, the entry points it found
and the conditions it found, each as a share of the reconciled union. A run
found an entry point when it listed it, placed in an operation or excluded
with a reason.

Rule: reconciliation adds; it never drops an entry point, condition or
operation one run covered. The only removals are the corrections of rule
breaches above and scripts no phase calls.

Then make every command the template uses known to the catalogue, by the
catalogue's [Adding an entry](catalogue.md#adding-an-entry) procedure: a
`toWrite` entry for every script in `support.toWrite`, and an `existing` entry,
checked against OpenClaw's own help or Gateway method list, for every
`product: <command>` line and every Gateway method or OCM operation the
catalogue lacks. Afterwards the plan withholds phases that call a script not
yet written, and refuses nothing the template uses.

## Template Form

```json
{
  "schema": "kova.verify.template.v1",
  "id": "<area>",
  "title": "<area title>",
  "objective": "<one sentence: what users do here and under what normal conditions>",
  "paths": ["<glob>"],
  "requires": ["<persona trait>"],
  "support": {
    "existing": ["<script path>"],
    "toWrite": [
      "<script path>  (<product method>; <flags>)",
      "product: <command>  (<what>; <flags>)"
    ]
  },
  "phases": [
    {
      "id": "<id>",
      "kind": "setup | operation | event",
      "intent": "<one sentence>",
      "paths": ["<glob>"],
      "requires": ["<persona trait>"],
      "commands": ["<command>"],
      "checkpoint": ["responses", "logs", "timing", "state:<path>", "doctor", "screen"],
      "timeoutMs": 60000,
      "browser": false,
      "slow": false
    }
  ]
}
```

No other fields. In particular a template holds no expected value, no
threshold and no record of incidents. A `support.toWrite` line names either a
script still to be written or, in the `product: <command>` form, an OpenClaw
command the catalogue lacks.

Two illustrative phases from a sessions template. The setup phase starts a
turn the mock provider holds open; the operation phase searches history while
that turn is still writing. Script names and flags come from the catalogue,
which is the authority for them.

```json
[
  {
    "id": "setup-turn-in-flight",
    "kind": "setup",
    "intent": "A user has sent the main session a message the model is still answering, so later phases run while that turn is in flight; the started run and its handle are observed.",
    "paths": ["src/gateway/server-methods/chat-*.ts", "src/agents/sessions/**"],
    "requires": ["session-main-rolling", "mock-provider-held-turn"],
    "commands": [
      "node {kovaRoot}/support/verify/session-turn-hold.mjs --env {env} --session-key {persona:session-main-rolling:key} --hold-ms 240000 --background --handle {run}/turn-main.json"
    ],
    "checkpoint": ["responses", "logs", "timing"],
    "timeoutMs": 60000,
    "browser": false,
    "slow": false
  },
  {
    "id": "search-history",
    "kind": "operation",
    "intent": "A client searches transcripts through sessions.search while a turn is in flight; the result set and its timing are observed.",
    "paths": ["src/gateway/server-methods/sessions-search-*.ts", "src/config/sessions/**"],
    "requires": ["session-long-compacted"],
    "commands": [
      "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.search --params '{\"agentId\":\"main\",\"query\":\"{persona:session-long-compacted:searchWord}\",\"limit\":20}' --timeout 60000"
    ],
    "checkpoint": ["responses", "logs", "timing", "state:sessions"],
    "timeoutMs": 90000,
    "browser": false,
    "slow": false
  }
]
```

## Derivation Record Form

```text
# Derivation: <area>

Revision: <sha>
Date: <YYYY-MM-DD>

## Bounds
Paths: <globs>
Documents: <paths>

## Excluded paths
<path>: owned by <area>

## Operations
| Operation | Entry points | Kinds |

## Excluded entry points
<entry point>: <reason>

## Conditions
| Condition | Source | Kind | Persona trait |

## Headings walked
<document> "<heading>": <condition numbers> | none

## Breaks cross-check
| Break | Phase | Note |

## Undocumented conditions
<condition>: needed by <break>, stated in no document

## Reconciliation
<item>: from run <1 or 2> only; <why it was kept>
```

## Coverage Table Form

```text
# Coverage: <area>

Operations: <covered>/<total>
Conditions: <covered>/<total> (<ambient> ambient, <event> event)
Entry points: <placed>/<total> (<excluded> excluded)
Breaks mapped: <mapped>/<in area>

Uncovered:
- <item>: <reason>

Persona additions:
- <trait>: <what the persona must contain> (<keys it provides>)
```

## Comparison Form

```text
# Comparison: <area>

Union: <entry points> entry points, <conditions> conditions

| Run | Entry points found | Conditions found |
|---|---|---|
| 1 | <found>/<union> | <found>/<union> |
| 2 | <found>/<union> | <found>/<union> |
```

A run found an entry point when it listed it, placed in an operation or
excluded with a reason, and found a condition when its `## Conditions` table
lists it under any name step 8 merged.

## Known Breaks Form

```json
{
  "schema": "kova.verify.known-breaks.v1",
  "product": "openclaw",
  "breaks": [
    {
      "id": "<the change that broke behavior: a pull request or commit>",
      "summary": "<one sentence: what users saw break>",
      "paths": ["<every path the change touched>"]
    }
  ]
}
```

## Acceptance

A derivation is accepted when:

1. Two independent runs of this procedure on the same area input file and
   revision each found at least nine tenths of the reconciled union of entry
   points and of conditions, counted as `comparison.md` counts them: an entry
   point excluded with a reason counts as found. Differences in operation
   grouping and phase wording are allowed. A run below nine tenths means the
   input file or this procedure is incomplete: fix it and repeat both runs.
   A difference that comes from the bound is fixed in the area input file; a
   difference that comes from a document one run did not read is fixed by
   listing that document.
2. Every entry point is in an operation or excluded with a reason.
3. Every break in the area maps to a phase, or is recorded as outside the
   product's reach.
4. No phase contains an expected value or assertion.
5. Every persona trait in `requires` is one the persona can provide, or is
   listed as a persona addition.

## Area Input File Form

`verify/areas/<area>.json`:

```json
{
  "schema": "kova.verify.area.v1",
  "id": "<area>",
  "paths": ["<glob>"],
  "documents": ["<path>"],
  "search": {
    "symbols": ["<function or export name>"],
    "literals": ["<method or command name>"]
  },
  "bound": {
    "includes": ["<shared entry point or path>: <reason it is this area's>"],
    "excludes": ["<shared entry point or path>: owned by <area>"]
  }
}
```

`kova verify plan` matches changed paths against the area files' `paths` to
find the templates a change needs.

## Maintenance

The scheduled maintenance pass reruns steps 2 and 3 on the current `main`
revision and diffs the enumerations against the derivation record. A new entry
point or condition reopens step 4 for that operation. A removed one retires its
phase. The pass may edit templates, derivation records and the command
catalogue; it never edits OpenClaw.
