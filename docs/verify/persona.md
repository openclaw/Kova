# Persona

A persona is the installation both sides of a verification start from. It is
built once, kept as a durable OCM environment and an export of it, and cloned
from that export for every run.
Templates name what they need from it as traits; phases read concrete values
from it through `{persona:<trait>:<key>}`.

The OpenClaw persona definition, `openclaw-verification-user`, declares fifty traits
covering its foundation, session content, configuration, identities and stores.
Its runtime is pinned to `npm:2026.9.9`. `sessions-organized-mixed` and
`session-imported-draft` require OpenClaw 2026.10.3 and are recorded as withheld,
without keys or saved content. The pin remains 2026.9.9 so older comparison
targets remain eligible. Its saved
content includes long compacted history with a reset boundary, a measured
pre-compaction context, pruned tool-result projections, an active goal, a
progress card, cancelled and interrupted inputs, an expired idle session and a
publicly shared session. Local mock models provide held streaming replies,
explicit tool calls, serial requests and one-time overflow responses. The saved
provider also returns structured summaries for OpenClaw compaction requests.
The one-minute idle policy applies to thread sessions; direct and group sessions
retain their prepared context. The overflow session selects `openai/mock-overflow`: its
first provider request overflows, and recovery replies with `KOVA_AGENT_OK`.
Content is produced through OpenClaw's commands and checked again on an import.

The workspace traits share one session bound to a managed Git worktree. Its
repository lives inside the persona environment and contains edited notes plus
an HTML page with a relative stylesheet and SVG asset. Checks verify the saved bytes, hashes,
uncommitted diff, worktree ownership and Git metadata through the current
environment's paths. State-inclusive import needs OCM's stored-path relocation
support ([OCM #367](https://github.com/openclaw/ocm/pull/367)); an import that still
points at the source environment fails the checks instead of repairing it.
Two synthetic local human profiles support a read-only shared session with a
pending suggestion. The newer-runtime imported draft uses the same identities.
A named CLI profile holds
its generated device authentication inside the environment; keys and tokens
never appear in its manifest or command output. Import reconnects that existing
profile at the clone's new origin and rejects missing or revoked pairing.
Generated device credentials and the local hook token stay only in the
environment, imported clones and private export. Personas with
`cli-profile-paired` or `sessions-synthetic-automation` do not create an OCM snapshot.
Profile checks temporarily admit the two synthetic identities through a loopback
trusted-proxy configuration, then restore ordinary token authentication. The
saved profiles do not require an external identity provider.
Live queued inputs and process identifiers belong to each verification run
rather than the durable persona.

Large history is built from five thousand completed mock turns. Builds can take
tens of minutes; each builder has a two-hour limit. Checks inspect real saved
history through a bounded, read-only SQLite snapshot, including compressed
records. The session-content builders and checks require Node.js 22.19.0 or newer.

`support/persona/make-session.mjs` creates and populates one session, returning
its `key` and `sessionId`; the catalogue declares both generated identifiers.
The `--worktree` flag prepares an environment-owned repository and asks
OpenClaw to create its managed checkout as part of session creation.
`support/persona/workspace-changes.mjs` applies the saved file edits separately.
Further content uses fixed operations on `support/persona/populate-session.mjs`:
`fill-to-threshold`, `prune-tool-results`, `create-goal`, `put-progress-card`,
`interrupt-inputs`, `enable-public-share` and `expire-idle`. Each has its own
catalogue entry and appears separately in the definition's builder lists.
Reset and archive policies use the existing OpenClaw `config set` command.
Public-sharing failures omit bearer data while retaining timeout exit code 3;
ordinary product errors use exit code 1.

The additional session content includes ninety completed main-session notebook
turns from direct channel and browser-chat entry points, forty human group
messages with an ambient main-session watch, explicit watched peers, and a
persistent conformance-channel child-thread binding. An idle parent retains
finished children, including a child that yielded and resumed; live processes
and pending turns are created by verification phases instead of exported.

The research agent holds more than five thousand sessions, including aged,
pinned and archived rows. Session maintenance stays in warning mode so the
saved starting conditions survive import. Historical timestamps and nonmanual
archive reasons are fixture metadata applied through the installed runtime's
session-store API; they do not claim that the corresponding maintenance or
recovery event occurred during the build. Normal sessions, forks, pinning,
snoozing and grouping use Gateway operations.

A synthetic Claude-format notebook is stored inside the environment and
selected through `CLAUDE_CONFIG_DIR` when its Gateway starts. Checks require
complete catalog content and verify the imported draft is hidden from the
second non-admin operator. A saved Arabic preference supplies the browser
command's `--locale` argument; it is not an OpenClaw config setting. The
heartbeat instructions, isolated scheduled job and linked DM scope also survive
export. A separately protected companion environment uses the same runtime and
its own port; verification runs clone that companion before using it.

Builds and verification copies may use `--env-prefix <name>` to isolate their
OCM names on shared hosts. The prefix accepts 1–40 lower-case letters, digits
and hyphens, starting with a letter; a unique suffix is always appended.

Persona traits are separate from the `traits` of Kova states in `states/*.json`.
A state models one user condition for one scenario and is set up inside a
disposable environment; a persona holds many traits at once in one durable
environment that every verification clones.

## Definitions

- **Persona**: one durable OCM environment plus its manifest. There is one
  persona per product for ordinary verification; a variant exists only when a
  template proves it needs one, and a plan uses it by passing the variant's
  manifest to `--persona`.
- **Trait**: one piece of content the persona holds, named `<noun>-<qualifier>`
  in lower-case hyphenated words, for example `session-long-compacted`. A trait
  is what a template's `requires` lists.
- **Minimum runtime**: an optional exact OpenClaw version in a trait's
  `minimumRuntime` field. A lower bound runtime withholds that trait and every
  trait depending on it. A prerelease precedes the corresponding stable release;
  for example, 2026.10.3-beta.1 does not satisfy a minimum of 2026.10.3.
- **Key**: a concrete identifier a trait exposes, such as a session key, an
  agent id, a file path or a marker string. Phases reference it as
  `{persona:<trait>:<key>}` and the manifest resolves it. A key value uses
  only letters, digits and `.`, `_`, `-`, `:`, `/`, `@`, so it can be placed in
  a shell command or a JSON string without quoting.
- **Builder**: the commands that put a trait into a fresh environment, through
  OpenClaw's own commands or a catalogue script. A builder runs once, when the
  persona is built, never during a verification.
- **Check**: one read command that proves the trait is present and prints its
  keys as one JSON object whose top-level fields are the trait's key names. It
  runs at build time and in `kova persona verify`.
- **Manifest**: `persona.json`, the record of what one build of the persona
  contains: each successfully built trait and its keys, the runtime it was built
  with, the build time and the content hash of the exported environment.
  `withheldTraits` separately records unsupported traits and their reasons.
- **Pinned runtime**: the OpenClaw version the persona is built with. It is
  never newer than any baseline or change that runs against it;
  `kova verify run` refuses a target older than it. The OpenClaw persona pins
  `npm:2026.9.9`.

## Rules

1. The persona is never newer than either side. Cloning it and starting either
   side's runtime on it is an existing installation being updated: the first start
   migrates the persona's data on the baseline and on the change alike, and
   any difference in that migration is a difference like any other. Explicit
   updater journeys are phases of the `update` template, not a property of the
   persona.
2. The persona is built, not hand-made. `kova persona build` creates a fresh
   environment on the pinned runtime, runs each supported trait's builder and
   then its check in dependency order, exports the environment and
   writes the manifest. A
   persona whose check fails is not a persona.
3. A verification never changes the persona. Every clone is made by importing
   the export after checking its hash against the manifest, so every run starts
   from the same content. The durable environment is the source the export was
   made from, and it is protected with `ocm env protect`.
4. Test credentials only. Traits use Kova's mock model provider (the one Kova
   scenarios use by default) and its channel conformance support, which need
   no credentials. When a trait needs a test account, the
   definition names that credential in `credentials`; the build reads its
   value from Kova's credential store (`kova setup`), and the value never
   appears in a definition, a manifest or a repository. The exported
   environment is still treated as secret-bearing and is never committed.
   The initial build command accepts only an empty `credentials` list; credential
   store integration is not implemented.
5. Keys are resolved from the manifest, never guessed, and a build refuses a
   key value outside the allowed characters. A phase whose
   `requires` lists a trait the manifest lacks, or whose commands name a trait
   or key the manifest lacks, is withheld by `kova verify plan`, before any
   environment is created.
6. Mock behavior is a trait too. A provider that streams slowly, serves one
   request at a time or returns an overflow error is content of the persona
   (its configuration and the mock's script), named like any other trait.
7. A trait a template requires and the persona lacks is a persona addition. It
   is listed in the template's coverage, the plan withholds the phases that
   need it, and the verdict lists them. A persona addition becomes part of the
   persona through [Defining a trait](#defining-a-trait); the scheduled
   maintenance pass reports the additions still open.
8. The manifest version is recorded in every plan and every verdict. A rebuild
   produces a new version, and verdicts are comparable only within one
   version.

A persona describes content, never outcomes: no expected behavior appears
anywhere in a definition or a manifest.

## Definition Form

`personas/<product>-<name>.json`, for OpenClaw
`personas/openclaw-verification-user.json`:

```json
{
  "schema": "kova.verify.persona.v1",
  "id": "openclaw-verification-user",
  "title": "A user who has run OpenClaw for months",
  "objective": "<one sentence: who this user is and what their installation holds>",
  "runtime": { "selector": "npm:2026.9.9", "policy": "<how and when the pin moves>" },
  "credentials": ["<name of a test credential the build needs>"],
  "traits": [
    {
      "id": "<noun-qualifier>",
      "content": "<one sentence: what is in the environment>",
      "minimumRuntime": "2026.10.3",
      "keys": { "<key>": "<what it identifies>" },
      "needs": ["<trait id>"],
      "builder": ["<command against {env}>"],
      "check": "<one command that prints the keys as JSON>"
    }
  ],
  "support": {
    "existing": ["<script path>"],
    "toWrite": ["<script path>  (<what it builds>; <flags>)"],
    "fixtures": ["<fixture file path>"]
  }
}
```

During a build, `{env}` is the environment being built, `{kovaRoot}` the Kova
root, `{run}` a working directory for the build, and `{persona:<trait>:<key>}`
the key a trait listed in `needs` recorded when its check ran earlier in the
same build. Builders and checks follow the same command rules as phase
commands (see [Commands](plan-and-verdict.md#commands)).

Omit `minimumRuntime` when a trait works on the pinned runtime. Every definition
and command is validated before runtime selection, including withheld traits.
Dry runs list only runnable builders and checks, and report the withheld traits
and reasons separately. Actual builds use the version in the exact bound runtime
receipt. Dependency withholding propagates through the entire dependency graph.

## Sessions Identity Keys

The sessions template requires the following key declarations in the owning
traits. These are additions to each trait's other keys, not a built persona or
example identifier values. Their checks must read the identities from the
created content. Until a manifest contains them, planning withholds the phases
that need them.

```json
[
  {
    "id": "session-workspace-changes",
    "keys": {
      "sessionId": "the durable session id for key",
      "processId": "the process recorded for that session"
    }
  },
  {
    "id": "session-shared-readonly",
    "keys": {
      "sessionId": "the durable session id for key",
      "memberIdentityId": "the sharing identity id of the teammate for this session",
      "suggestionId": "the id of its stored pending suggestion"
    }
  }
]
```

A sharing identity is distinct from a human profile id. A process incarnation
is observed during a run: `sessions.processes.stop` reads `instanceId` from the
earlier `sessions.processes.list` output for the matching process and session.
Likewise, `sessions.setInvolvement` reads `expectedSessionId` from an earlier
`sessions.describe` output for the newly created session. These observations
are passed through the catalogue entry's `--from` input, not stored as persona
keys. GitHub publication request ids require a real publication and are outside
the credential-free sessions template.

## Manifest Form

`persona.json`, written by `kova persona build` into its `--out` directory:

```json
{
  "schema": "kova.verify.persona-manifest.v1",
  "persona": "openclaw-verification-user",
  "version": "<build time as YYYYMMDDTHHMMSSZ>",
  "runtime": {
    "selector": "npm:2026.9.9",
    "resolved": "<exact version and digest>",
    "ocm": {
      "binary": "<absolute path to the native OCM executable>",
      "version": "<OCM --version output>",
      "sha256": "<hash of that executable>",
      "commit": "<commit reported by the executable, when available>"
    }
  },
  "definition": { "path": "<the file given to --definition>", "sha256": "<its hash>" },
  "env": { "name": "<durable env name>", "root": "<original environment root>", "export": "<path to the .ocm-env.tar>", "includeState": true, "sha256": "<hash>" },
  "doctor": "<Doctor output after the build>",
  "traits": {
    "<trait id>": { "keys": { "<key>": "<value>" }, "checkedAt": "<time>" }
  },
  "withheldTraits": {
    "<newer-trait-id>": {
      "minimumRuntime": "2026.10.3",
      "reason": "requires OpenClaw 2026.10.3; bound runtime is 2026.9.9"
    }
  }
}
```

`runtime.ocm` is recorded by the build itself. This corrects the earlier manifest
form, which identified the OpenClaw runtime but omitted the OCM used to create and
export it. `binary` resolves symlinks and the supported npm launcher to the native
executable; an OCM transport is inspected under its configured user, environment
and working directory. Unknown script launchers are refused. `version` preserves
the executable's trimmed `--version` output, and `commit` is omitted unless that
output reports a commit. The build never infers a commit from a nearby checkout.
`show` includes this saved record; it does not validate or select the recorded OCM
for later invocations. Older manifests without `runtime.ocm` remain readable.

Withheld records have no `keys` or `checkedAt`. Their `minimumRuntime` is the
highest requirement from the trait or its withheld dependencies. A dependent
record also lists its directly withheld trait ids in `dependencies` and names
them in its reason. Verification recomputes these records from the hashed
definition and bound runtime, rejecting altered reasons, invented keys, and
unexplained omissions. Older manifests without `withheldTraits` remain valid
when every declared trait is supported and present. Templates see withheld
traits as absent, so phases requiring their keys remain withheld.

## Commands

```sh
kova persona build  --definition <file> --out <dir> --execute
kova persona verify --persona <manifest>
kova persona show   --persona <manifest> --json
```

- `build` is the only command that creates a durable environment. Without
  `--execute` it prints what it would do.
  Its output directory must be empty. The generated environment name begins with
  `kova-persona-`. Failed builds remove their incomplete environment; a successful
  build keeps it protected and stopped. Cleanup failure is reported with the
  affected environment name. SIGINT and SIGTERM stop new work, let the current
  command settle, and await cleanup of the owned Gateway, mock provider and
  incomplete environment.
- `verify` checks the export's hash, imports it into a clone, runs every check
  supported by the recorded runtime on the clone, and destroys the clone. It
  rebinds the saved mock provider's loopback URL while retaining the model defaults
  and agent overrides that the checks inspect. It
  refuses a definition whose hash differs from the manifest's. The scheduled
  maintenance pass runs it, and `kova verify run` runs the same checks on its
  clones before the first phase, so a drifted persona is caught before a
  comparison is made.
- `show` prints the manifest; `kova verify plan` uses it to resolve keys and
  records its path and hash in the plan, and `kova verify run` makes its
  clones from the export it names.

Imported trait checks use `createPersonaGateway` and `checkPersonaTraits` from
`src/persona/lifecycle.mjs`. These helpers supply the saved catalog directory,
rebind existing CLI pairing to the clone's origin, and switch to the saved human
identities for profile checks. A caller that clones additional environments passes
its remapped trait keys to the checker; the companion check inspects that copy
instead of the protected source. Command validation remains the caller's
responsibility through `checkCommand`.

## Defining A Trait

1. Take the trait name from a template's `requires` and the content sentence
   from the template's coverage table.
2. Name every key a phase or another trait's builder reads through
   `{persona:<trait>:<key>}`, and no key that none of them reads.
3. Write the builder from OpenClaw's own commands first
   (`ocm @{env} -- <command>`, a config patch, a Gateway method through a
   catalogue script). Use a fixture file only where no product command can
   produce the content, such as a corrupt database generation or a legacy
   store, and list the file under `support`.
4. Write the check as one read command whose JSON output carries the keys.
5. List `needs`: the traits that must exist first.
6. Build the persona and run the check. A trait enters the definition only
   once its check passes on a fresh build.

## Build Procedure

What `kova persona build` does:

1. Record the selected OCM executable before creating an environment. Create a
   fresh environment on the pinned runtime, configure the mock provider
   and start a foreground Gateway owned by the build process. No OCM service is
   installed or started. Restart that Gateway after each trait builder so checks
   observe its current configuration. Historical transcript timestamps and local
   hook configuration are written while this same foreground owner is stopped.
2. Order traits by `needs`; refuse a cycle.
3. Record unsupported traits and their dependents as withheld. For each runnable
   trait, run its builder, then its check, and record the keys. A
   failed check stops the build and names the trait; no manifest is written.
4. After each disk-budget, stale-lock, corrupt-generation and quarantined-generation
   trait, restart the Gateway, check the content, stop it for Doctor, and check again
   after restart. Record these Doctor results and the final Doctor output in the
   manifest.
5. Protect the environment. For personas without `cli-profile-paired` or
   `sessions-synthetic-automation`, create
   a named OCM snapshot. Export the environment with
   `ocm env export <env> --include-state --output <file>`, and hash the export.
   This requires OCM with state-inclusive config and plugin-path relocation
   ([source revision d92fa50](https://github.com/openclaw/ocm/commit/d92fa50edc0a031d54ef14bd4ae52e3a0ab8c769)
   or a release containing it; OCM 0.3.3 is insufficient). The archive preserves
   durable state with coherent SQLite snapshots, including plugin install records.
   Record `env.includeState: true` in the manifest.
6. Verify once from a clone: import the export into a throwaway environment,
   start it, run every supported check and destroy it.

The final `persona.json` is published only after that import check succeeds and
the OCM executable's path, version and hash still match the initial record.
`runtime.resolved` is `<exact version>@<npm sha512 integrity>` from OCM's runtime
receipt. Definition and export paths are absolute when built; readers also accept
paths relative to the manifest. Each check prints exactly its declared keys as
strings. A check that exits unsuccessfully, prints malformed JSON, omits a key or
returns an unsafe value refuses the build. Clone verification compares stable
identifiers with the manifest. For absolute keys inside `env.root`, verification
changes only that root to the imported environment root and compares the remaining
path. Other keys must match exactly. Older manifests without `env.root` are accepted
only when they contain no absolute keys.

## Maintenance

The [scheduled maintenance pass](README.md#the-model) runs
`kova persona verify` daily. It rebuilds the persona when a check fails, when
the definition gains a trait, or when the pinned runtime moves, and it records
the manifest version it produced. It reports every trait a template's
`requires` names that the definition still lacks. It never edits OpenClaw.

### Builder operations

Builder lists expose configuration changes, session patches, visibility,
suggestions, historical metadata, channel turns, forks and profile configuration
as separate commands. Commands pass generated session identities through JSON
receipts under `{run}`. A collection command repeats one product operation over
its named rows; it does not also patch, populate or archive them. Trait checks
continue to derive the same keys from saved content.

The paired CLI profile authenticates before a separate command writes its remote
endpoint configuration. Companion cloning and protection are separate commands;
Gateway startup is verified as runtime evidence rather than hidden inside cloning.

A saved definition remains part of the manifest's integrity check after its
builder commands are renamed or retired. Verification validates its current
read commands against the catalogue and checks the original definition and
export hashes; it never executes the saved builders. New builds continue to
validate every builder and check against the current catalogue.

### Session store content

The store traits preserve conditions for later operations on disposable clones:

- `transcripts-cold-stored` contains a product-extracted cold archive and a hot
  transcript old enough for extraction. The check verifies compressed content,
  stored hashes, message identities and eligibility without restoring the archive.
  Automatic cold storage remains disabled so the eligible transcript stays hot.
  Extraction phases enable it on their clone and restart the existing foreground
  owner before running extraction.
- `store-over-disk-budget` contains a retained reset archive, a product-created
  deletion archive, an unreferenced historical generation and an entry-cap archive.
  Warning maintenance preserves them. Persistent database and archive bytes exceed
  the configured budget even after export checkpoints remove WAL files.
- `store-rows-legacy-aliases` stages actual legacy `provider` and `lastProvider`
  fields without their canonical replacements. `store-legacy-sessions-json` stages
  pending legacy history containing `KOVA_LEGACY_HISTORY` and an empty legacy store
  for the unused idle agent. Their manifest `path` keys name the staged files;
  active stores remain startable. The `persona-legacy-store-activate` catalogue
  operation installs both on a stopped, unprotected clone before Doctor repairs
  them. It refuses a live Gateway or an existing destination.
- `sessions-stale-peer-dm-rows` holds three completed inbound DM sessions with
  isolated peer keys. A cleanup phase sets `session.dmScope` to `main` on its clone
  before invoking `sessions cleanup --fix-dm-scope`; the persona retains isolation.
- `sessions-synthetic-automation` holds real completed cron, webhook and isolated
  heartbeat turns. A generated local-only hook token enables the bounded persona
  hook endpoint; it is never printed. Because current model runs are stateless,
  an explicitly historical model-run fixture supplies the aged saved row.
- `sessions-stale-lock-files` contains expired legacy lock residue from exited
  owners. It does not represent a current session lease or claim that current
  Doctor versions implement the retired lock cleanup mechanism.
- `store-corrupt-generation` supplies a minimal corrupt SQLite fixture beside the
  live database. `store-quarantined-generation` uses Doctor recovery on a separate
  copy and verifies the preserved `.corrupt-<timestamp>` file. The live database
  remains intact. The fixture's construction is documented beside its binary.

Product commands create session content and perform extraction, deletion and
recovery. Historical timestamps, legacy reset archives and obsolete entry formats
use bounded fixtures where current commands cannot produce that historical state.
Each operation has its own catalogue entry. Checks read saved content and reject
missing, changed or incomplete fixtures.
