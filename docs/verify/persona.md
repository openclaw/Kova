# Persona

A persona is the installation both sides of a verification start from. It is
built once, kept as a durable OCM environment and an export of it, and cloned
from that export for every run.
Templates name what they need from it as traits; phases read concrete values
from it through `{persona:<trait>:<key>}`.

The OpenClaw persona, `openclaw-verification-user`, is a user who has run
OpenClaw for months: history across several agents, saved and shared sessions,
bundled plugins and an external plugin with its install records, an agent
database at an older schema, a channel on Kova's conformance channel, a
scheduled job,
hand-edited config and a workspace with files. It is built from real content
produced through OpenClaw's own commands, not from markers.

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
- **Key**: a concrete identifier a trait exposes, such as a session key, an
  agent id, a file path or a marker string. Phases reference it as
  `{persona:<trait>:<key>}` and the manifest resolves it. A key value uses
  only letters, digits and `.`, `_`, `-`, `:`, `/`, `@`, so it can be placed in
  a shell command or a JSON string without quoting.
- **Builder**: the commands that put a trait into a fresh environment, through
  OpenClaw's own commands or a catalogue script. A builder runs once, when the
  persona is built, never during a verification.
- **Check**: one read command that proves the trait is present and prints its
  keys. It runs at build time and in `kova persona verify`.
- **Manifest**: `persona.json`, the record of what one build of the persona
  contains: every trait, every key's value, the runtime it was built with, the
  build time and the content hash of the exported environment.
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
   environment on the pinned runtime, runs every builder in dependency order,
   runs every check, exports the environment and writes the manifest. A
   persona whose check fails is not a persona.
3. A verification never changes the persona. Every clone is made by importing
   the export after checking its hash against the manifest, so every run starts
   from the same content. The durable environment is the source the export was
   made from, and it is protected with `ocm env protect`.
4. Test credentials only. Traits use Kova's mock provider and its conformance
   channel, which need no credentials. When a trait needs a test account, the
   definition names that credential in `credentials`; the build reads its
   value from Kova's credential store (`kova setup`), and the value never
   appears in a definition, a manifest or a repository. The exported
   environment is still treated as secret-bearing and is never committed.
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
      "keys": { "<key>": "<what it identifies>" },
      "needs": ["<trait id>"],
      "builder": ["<command against {env}>"],
      "check": "<one command that prints the keys as JSON>"
    }
  ],
  "support": {
    "existing": ["<script path>"],
    "toWrite": ["<script path>  (<what it builds>; <flags>)"]
  }
}
```

## Manifest Form

`persona.json`, written by `kova persona build` into its `--out` directory:

```json
{
  "schema": "kova.verify.persona-manifest.v1",
  "persona": "openclaw-verification-user",
  "version": "<build time as YYYYMMDDTHHMMSSZ>",
  "runtime": { "selector": "npm:2026.9.9", "resolved": "<exact version and digest>" },
  "definition": { "path": "<the definition given to --seed>", "sha256": "<its hash>" },
  "env": { "name": "<durable env name>", "export": "<path to the .ocm-env.tar>", "sha256": "<hash>" },
  "doctor": "<Doctor output after the build>",
  "traits": {
    "<trait id>": { "keys": { "<key>": "<value>" }, "checkedAt": "<time>" }
  }
}
```

## Commands

```sh
kova persona build  --seed <definition> --out <dir> --execute
kova persona verify --persona <manifest>
kova persona show   --persona <manifest> --json
```

- `build` is the only command that creates a durable environment. Without
  `--execute` it prints what it would do.
- `verify` checks the export's hash, imports it into a clone, runs every check
  of the definition the manifest records on the clone, and destroys the clone. It
  refuses a definition whose hash differs from the manifest's. The scheduled
  maintenance pass runs it, and `kova verify run` runs the same checks on its
  clones before the first phase, so a drifted persona is caught before a
  comparison is made.
- `show` prints the manifest; `kova verify plan` uses it to resolve keys and
  records its path and hash in the plan, and `kova verify run` makes its
  clones from the export it names.

## Defining A Trait

1. Take the trait name from a template's `requires` and the content sentence
   from the template's coverage table.
2. Name every key a phase reads through `{persona:<trait>:<key>}`, and no key
   that no phase reads.
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

1. Create a fresh environment on the pinned runtime with the service
   installed, the Gateway started and the mock provider configured.
2. Order traits by `needs`; refuse a cycle.
3. For each trait, run its builder, then its check, and record the keys. A
   failed check stops the build and names the trait; no manifest is written.
4. Stop the Gateway cleanly, run Doctor and record its output in the manifest.
5. Protect the environment, create a named OCM snapshot, export it, hash the
   export and write the manifest.
6. Verify once from a clone: import the export into a throwaway environment,
   start it, run every check and destroy it.

## Maintenance

The [scheduled maintenance pass](README.md#the-model) runs
`kova persona verify` daily. It rebuilds the persona when a check fails, when
the definition gains a trait, or when the pinned runtime moves, and it records
the manifest version it produced. It reports every trait a template's
`requires` names that the definition still lacks. It never edits OpenClaw.
