# Command Catalogue

The catalogue is the fixed set of commands a phase may call. Templates, persona
builders and checks, and the phases written from an intent file all draw from
it. A command that is not in the catalogue is not a valid phase command:
`kova verify plan` refuses it before anything runs.

The catalogue keeps verification honest in two ways. Every command has a fixed
form and a known output, so checkpoints compare field by field. And no command
decides whether OpenClaw answered correctly; only the comparison does.

## Definitions

- **Entry**: one way to do one thing to the product, with a fixed command form,
  named flags and a fixed output. There is one entry per thing; two entries
  that do the same thing are a defect.
- **Kind**: `product` (an OpenClaw command, run as `ocm @{env} -- <command>`
  or `ocm @{persona:<trait>:env} -- <command>`),
  `gateway` (one Gateway method, called by name through Kova's generic Gateway
  caller `support/verify/gateway-call.mjs`; there is
  one `gateway` entry per method), `script` (a Kova support script that wraps
  one method or one short flow and prints JSON), `ocm` (an OCM lifecycle
  operation on the environment).
- **Wraps**: the product method, command or operation the entry performs. A
  `script` entry names it; for a `gateway` entry it is the method.
- **Side**: `read` (observes, changes nothing), `write` (changes product
  state), `destructive` (removes or replaces state, or restarts or stops the
  Gateway).
- **Handle**: a JSON file under `{run}/` that a background entry writes when it
  starts and a later command reads with `--wait`.
- **Status**: `existing` (the command exists: a script or the generic caller
  in Kova, or an OpenClaw or OCM command at the catalogue's revision) or
  `toWrite` (named by a template or persona, not yet implemented). A `toWrite`
  entry may appear in a template; the plan withholds the phases that call it
  until it exists.

## Rules

1. One entry does one thing. A script wraps one product method, or one short
   flow OpenClaw itself defines (a resume under a pseudo-terminal, a Control
   UI flow). It does not combine operations a phase could list separately.
2. Every `script` and `gateway` entry prints JSON on stdout and nothing else
   there. Diagnostics go to stderr. The output is the checkpoint's `responses`
   record for that command. A `product` or `ocm` entry uses the command's own
   JSON output flag when it has one; its output is recorded as printed.
3. Exit codes of `script` and `gateway` entries: `0` OpenClaw returned a
   result, whatever it was; `1` OpenClaw returned an error, recorded in the
   JSON;
   `2` the call was malformed; `3` the entry's own timeout elapsed. A
   `product` or `ocm` entry keeps the command's own exit codes. An entry never
   decides whether the answer was right.
4. No expected values. An entry has no flag that asserts, matches or expects.
   The one exception is a marker string passed to OpenClaw as content, such as
   a message text.
5. Timeouts are milliseconds everywhere, on a flag named `--timeout`. Product
   commands that take their own timeout keep the product's flag. A chat send with
   `--after-ms` waits before starting that call budget, including in background mode.
6. Background entries follow the [background protocol](#background-protocol).
7. Placeholders in a phase command are `{env}`, `{kovaRoot}`, `{run}` and
   `{persona:<trait>:<key>}`, plus `{target}` in standard phases only, and no
   others. The plan and the run resolve them
   before the command runs, as [Commands](plan-and-verdict.md#commands)
   describes; an entry never sees a placeholder and never resolves one. A
   value an earlier command produced is read from the file that command wrote
   under `{run}`, through one of the entry's own `--*-from <file>` flags, such
   as `--from` or `--session-from`.
8. Flags are the entry's contract. A phase may not pass a flag the entry does
   not list; the plan refuses it. Each flag says whether it takes a value
   (`none`, `required` or `optional`), so the check can tell a flag's value
   from the next operand. The parameters a `gateway` entry passes in
   `--params` belong to the Gateway method; the Gateway validates them, not the
   catalogue.
9. A product command enters the catalogue by its exact form and the flags
   phases use, checked against OpenClaw's own `--help` at the catalogue's
   recorded revision. A product flag that disappears retires the entry, and
   the scheduled maintenance pass reports every phase that used it.
10. A new `script` entry comes only from a template's or persona's
    `support.toWrite`, by [Adding an entry](#adding-an-entry); when the script
    exists, its status flips to `existing` and nothing else changes. A
    `product`, `gateway` or `ocm` entry is added, by the same section, when a
    template or persona first uses that command or method; the area-template
    derivation does this in its step 8.

## Background Protocol

An entry marked `background` accepts:

```sh
<entry> --background --handle {run}/<name>.json [other flags]
<entry> --wait {run}/<name>.json [--timeout <ms>]
```

The first form starts the operation, writes the handle and returns. The second
joins the operation and prints its final JSON. A handle holds:

```json
{ "entry": "<id>", "startedAt": "<time>", "env": "<env>", "ref": { } }
```

`ref` is whatever the entry needs to find the operation again: a run id, a
session key, a process id. This is how a template keeps a turn in flight while
later phases search, delete or restart around it.

## Catalogue Form

`catalogue/<product>.json`, for OpenClaw `catalogue/openclaw.json`:

```json
{
  "schema": "kova.verify.catalogue.v1",
  "product": "openclaw",
  "revision": "<OpenClaw revision the product entries were checked against>",
  "entries": [
    {
      "id": "<kebab-case id>",
      "kind": "product | gateway | script | ocm",
      "wraps": "<method, command or operation>",
      "command": "<exact command form with placeholders and <flag> slots>",
      "flags": { "--name": { "description": "<meaning; durations in milliseconds>", "value": "none | required | optional" } },
      "prints": ["<top-level JSON field>"],
      "creates": ["<JSON pointer to an id OpenClaw generated for a resource this command created>"],
      "side": "read | write | destructive",
      "background": false,
      "status": "existing | toWrite"
    }
  ]
}
```

An entry has no other fields. In `command`, a slot in angle brackets, such as
`<name>` or `<ms>`, marks a value the phase fills in; a positional the command
may omit is shown in square brackets (`[<path>]`) and one that repeats with
three dots (`<keys...>`). A `product` entry's environment argument is
`@{env}` or `@{persona:<trait>:env}`; the check accepts both, and the plan
resolves the second like any persona key. A persona trait that provides an
environment is cloned by `kova verify run` for each clone, like the primary
environment, and `{persona:<trait>:env}` resolves to that clone's copy; a run
never touches the durable second installation. `creates` lists, as JSON
pointers into the entry's output (`*` matches any array index), each field
holding an id OpenClaw generated for a resource the command created, such as
a new session's key; it is empty for a command that creates nothing. Compare
uses it to give generated ids the same name on every clone (see
[Rows](plan-and-verdict.md#normalization)); the token names the concrete
pointer, with the actual array index, so two ids the same command created
get two tokens.

## Commands

```sh
kova catalogue list  --product openclaw --json
kova catalogue check --product openclaw --templates <dir> --personas <dir> --json
```

`list` prints the entries. `check` reads every phase command and every builder
and check in the given templates and personas, resolves each to an entry by
its command head, and reports:

- commands with no entry;
- flags an entry does not list;
- two entries used for the same thing;
- placeholders that are not allowed, or not allowed where they appear;
- shell substitutions or operators outside single quotes (see
  [Commands](plan-and-verdict.md#commands));
- `toWrite` entries not yet implemented.

The command head is the command's words up to its first flag or value slot,
with placeholders kept as written; `kova catalogue check` and the check inside
`kova verify plan` both compute it on the command as the template or phase
file writes it, before any placeholder is replaced: `node {kovaRoot}/support/verify/chat-send.mjs`
for a script, `ocm @{env} -- plugins list` for an OpenClaw command run
through OCM, `ocm service restart` for an OCM operation. For the generic
Gateway caller the head also includes the `--method` value, so each Gateway
method resolves to its own entry.

Flags must follow all fixed words of the complete command head; a flag interleaved among those words is outside catalogue syntax and produces a `flag-placement` finding, regardless of what OpenClaw accepts.

For a `product` entry's lookup, `@{env}` and
`@{persona:<trait>:env}` are equivalent environment operands: the check uses
`@{env}` for either when comparing command heads. The plan keeps the original
operand so `run` binds it to the primary or persona-provided clone as required.
The two forms do not require duplicate entries for the same operation.

`check` exits non-zero on any finding, `toWrite` entries included, so it shows
what remains to be written. `kova verify plan` runs the same check on the plan
it writes: it withholds phases that call a `toWrite` entry and refuses to write
a plan with any other finding.

## Adding An Entry

For a script:

1. Take the script path and the sentence in parentheses (what it wraps or
   builds, and its flags) from the template's or persona's `support.toWrite`
   line.
2. Give the entry an id, its kind, what it wraps, its exact command form, its
   side, and whether it needs `background`.
3. List every flag phases pass to it, with its meaning and whether it takes a
   value, from the phases that call it; a duration is given in milliseconds.
   Drop any flag that would assert.
4. Name the top-level fields its JSON prints, and in `creates` the fields that
   hold ids of resources it creates.
5. Add the entry with status `toWrite`. Implement the script, run
   `kova catalogue check`, and flip the status to `existing`.

For an OpenClaw command (a `product: <command>` line in `support.toWrite`), a
Gateway method or an OCM operation a template or persona uses for the first
time:

1. Check the exact command form and the flags phases use against OpenClaw's or
   OCM's own `--help` at the catalogue's revision, or the Gateway method name
   against the methods the Gateway registers there.
2. Fill every field of the [catalogue form](#catalogue-form): its id, its kind
   (`product`, `gateway` or `ocm`), what it wraps, its exact command, its
   flags, the top-level fields of its JSON output when it has one, `creates`,
   its side and whether it runs in the background.
3. Add it with status `existing` when the command can run today. A `gateway`
   entry is `existing` only when both the method is registered and Kova's
   generic Gateway caller exists; until the caller is written, every `gateway`
   entry has status `toWrite`, and the plan withholds the phases that call it.

## Gateway verification scripts

The scripts in `support/verify/` record product responses as JSON. A successful
response is recorded even when it describes an empty page, an unavailable public
share, a skipped heartbeat or a refused tool action. Background forms use the
same handle and join protocol as the generic Gateway caller.

The original chat-send, held-turn and fixture operations can run directly, but
their catalogue entries also declare later forms that are still unavailable:
`chat-send --busy-from` and `--expect-cancelled`, held-turn `--from` with
`--require-active` and `--min-remaining-ms`, and fixture `--out` and
`--restore --from`. Their additional cancellation, active-hold and quarantine-ID
output fields belong to those pending contracts. These three entries keep
`toWrite`; catalogue status applies to the whole entry, so planning withholds
phases that use them until the extensions are implemented. The original fixed
output contracts remain covered separately by the script checks.

`chat-send` and `session-turn-hold` wait for the submitted run and read its
history. Replies are included only when the returned message identifies that
run; unrelated historical answers are not substituted. `agent-tool-turn` records
only tool calls and results associated with the submitted run. An absent
association remains visible as an empty reply or missing tool result. The tool
entry reads the matching raw result through `sessions.get`, preserving product
metadata separately from command stdout. Known native creation receipts, including
automation jobs and enqueued runs, contribute their new IDs; reused declarations
and observed job IDs do not. Dispatched tools retain their raw envelope while
creation IDs and accepted child sessions come from the identified native result.

During `verify run`, effective tool arguments are resolved once from their input
files and checked before dispatch. Read/write/edit paths and explicit execution or
child-session and scheduler working directories must be canonical absolute paths inside an
owned copy, outside recorder output. Session creation refuses registered projects,
remote source or placement selectors, and managed worktrees whose repository and
Git storage ownership cannot be established by these checks. This includes
managed worktrees requested with an owned `cwd`: Git can still select external
shared storage or inherit a repository. Writes cannot replace protected configuration
files. File tools touching files that require credential or log filtering are
refused using the copies' current and retained file policies: write receipts and
edit errors can also contain previous file contents. Use filtered Gateway file
operations or state snapshots for those files. Read admission also checks the
filename variants OpenClaw may try after an exact miss, without changing the
requested path. The same
checks apply to mock tool markers and the persona tool model's `Call <tool> with`
requests carried by chat, channel input, goal-resume notes, companion questions
and selected text, nested session messages, and newly supplied cron prompt text.
Replay checks the admitted goal note against the saved request before sending it.
The mock treats OpenClaw external-content blocks, including extracted attachments,
as data rather than tool or hold instructions. Explicit `tool_call` requests use an unambiguous named tool
or `openclaw:core:<name>` id with a nested `args` object; flattened or alternative
selector forms cannot establish the checked destination.
Protected tool fields must use literal strings and objects. Encoded scheduler
objects, coerced worktree flags and alternate source-selector keys are refused
before OpenClaw can reinterpret them. Explicit remote execution selectors are
also refused. Opaque tool programs still follow the trusted-program rule;
these checks do not provide an OS sandbox. Direct script invocation retains its
existing product-tool behavior.

`session-turn-hold --hold-ms` controls the mock response for that call. It sends
a `KOVA_VERIFY_HOLD` message containing the duration and progress-card choice.
The local mock honours this request without changing the persona's default held
reply. The tool entry sends `KOVA_TOOL_CALL` with the requested tool and JSON
arguments. These markers are content for Kova's local mock provider.

`goal-control --action edit` requires `--objective`. Other status changes accept
`--note`. To replay an operation, save the first result with `--out`, then pass
that file through `--from` with `--replay`, the same session, goal and action.
The saved `request` contains the original operation id and issue time. Replay
rejects a different target or changed content; it never creates another id.

`stage-session-store-fixture` allows up to 150 seconds after its operation timeout
for rollback and restart. The runner waits for that cleanup before subsequent
commands or checkpoints; unresolved cleanup stops the clone. Cancellation also
joins the bounded cleanup. It requires `--gateway-handle` for the clone's owned
foreground Gateway. The fixture must already be staged inside the selected agent directory,
including its `fixtures/` subdirectory. The script pauses that Gateway, retains the current
database and its SQLite sidecars, swaps in the fixture, runs Doctor's SQLite
recovery command and restarts through the same owner. `--restore` restores the
retained file set. A failed preparation rolls back before restart.
The retained backup and intermediate restore copies are private verification
files, excluded from state snapshots and direct file-tool access.
Timeout cleanup remains bounded and may continue through rollback and restart before
the script returns. Custom or
shared stores and remote OCM transports are refused before mutation. No managed
service is started or stopped.

For `channel-inbound-turn`, use the persona's admitted probe peer: direct peers
are `dm:kova-probe-user` or its suffixed variants, and group peers are
`group:kova-probe-group` or its suffixed variants. A thread peer is
`group:<parent-id>/thread:<thread-id>` with an admitted group parent. Group routing passes the
actual group type into OpenClaw; `@bot` is the probe's explicit mention marker.
The output records the resulting route and delivery observations. Inbound
channel admission uses the installed probe's command normalization before checking
writable destinations. Rebuild personas containing an older probe before using
these forms through `verify run`.

`public-thread-read` reads an already-public session anonymously and its generic
share preview. Share tokens stay in memory and are redacted from returned HTML.
`run-resume` uses a pseudo-terminal and records the rendered output. A handoff
input contains `handoff` as the product's base64url payload or its decoded
object; a URL input contains `url` as an exact session URL for this environment.
The script exits the TUI after it renders a session, without submitting a turn.
