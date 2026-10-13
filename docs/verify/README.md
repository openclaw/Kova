# Kova Verify

`kova verify` answers one question about a single OpenClaw change: does it
break anything a user does in the parts of the product it touches? It runs the
same plan against the change and against its baseline, both starting from the
same long-lived user installation, records what each side did after every step,
and compares the two records. The result is a verdict: `good-to-go`, `breaks`
or `unresolved`, with every difference explained.

The rest of Kova asks whether a release-shaped runtime meets its contracts:
scenarios, states, profiles, thresholds and the release gate. `kova verify`
asks a narrower, relative question and does not change any of that. It reuses
Kova's target selectors, local builds, OCM lifecycle, evidence collection and
report store; it adds no threshold and does not feed the release gate.

> Status: `kova verify`, `kova persona` and `kova catalogue` are not available
> yet. These pages define the forms and procedures the implementation follows.
> Each change that builds a command updates the page that describes its form.

## The model

```text
change + baseline  →  plan (areas, templates, intent)  →  run on two persona clones
                   →  checkpoints per phase per side   →  compare  →  verdict + issues
```

- **Change**: the OpenClaw commit under test, with the paths it changes
  relative to its **baseline**, the commit it is compared against.
- **Intent file**: `intent.txt`, two lines written by whoever asks for the
  verification. `Goal:` states what the change is meant to do; `Protected:`
  states what must not change. The intent file is how an intended difference
  is told apart from a break.
- **Persona**: one durable OCM environment that looks like a user who has run
  OpenClaw for months, built once from a definition and cloned for every run.
  Its content is a set of named **traits**. See [Persona](persona.md).
- **Area**: a part of OpenClaw a user would name as something they do, such as
  sessions, update, plugins, config or channels, owned by a set of source
  paths and described by its own OpenClaw documents.
- **Template**: one per area. Its **phases** exercise the area the way users
  do, under the conditions it normally runs in: a turn in flight, a restart,
  cold storage, a large store. Templates are derived by a fixed procedure, see
  [Deriving an area template](derive-area-template.md).
- **Phase**: one step: an operation performed under conditions, as commands
  against an environment, followed by a checkpoint. A phase records; it never
  asserts.
- **Checkpoint**: what Kova records after a phase on each side: command
  results, Gateway replies, logs, timing, selected state, Doctor output and
  screenshots.
- **Plan**: the phases one change needs, assembled by script from the changed
  paths, the area templates, the standard phases and the phases written from
  the intent file. See [Plan and verdict](plan-and-verdict.md).
- **Command catalogue**: the fixed set of commands a phase may call. A command
  outside the catalogue is refused before anything runs. See
  [Command catalogue](catalogue.md).
- **Verdict**: the comparison of the two sides, phase by phase, with every
  difference classed as a break, intended, not caused by the change, fixed, or
  flaky.
- **Issues**: differences present on both sides. They are real problems in
  OpenClaw that the change did not cause. They are reported, never counted
  against the change.

## The commands

```sh
kova verify plan    --repo <checkout> --baseline <sha> --change <sha> \
                    --intent intent.txt --persona <manifest> \
                    [--extra-phases <file>] --out plan.json
kova verify run     --plan plan.json \
                    --target-baseline <selector> --target-change <selector> --execute
kova verify compare --run <change-run-id> --baseline <baseline-run-id> \
                    [--noise <id>,<id>] --intent intent.txt --json
```

- `plan` is pure file assembly. It reads the changed paths from the checkout,
  matches them to areas and template phases, adds the standard phases, adds
  the phases in `--extra-phases`, withholds phases whose persona keys the
  manifest cannot resolve or whose commands are not written yet, records paths
  no area owns, and refuses to write a plan containing any other command the
  catalogue check rejects. It never calls a
  model; phases written from the intent file arrive as a file.
- `run` clones the persona twice, starts the baseline target on one clone and
  the change target on the other, runs the plan on both, and records a
  checkpoint after every phase on each side. Targets use Kova's selectors
  (`local-build:<path>`, `npm:<version>`, `runtime:<name>`). Like `kova run`,
  it is a dry run unless `--execute` is present, and it destroys its clones
  afterwards.
- `compare` reads the two runs' checkpoints, removes the noise, classes each
  remaining difference and writes `verdict.json` in the `kova.verify.v1` form
  and `issues.md`.

The persona and the catalogue have their own commands:

```sh
kova persona build  --seed <definition> --out <dir> --execute
kova persona verify --persona <manifest>
kova persona show   --persona <manifest> --json
kova catalogue list  --product openclaw --json
kova catalogue check --product openclaw --templates <dir> --personas <dir> --json
```

## Files

| Path | What it holds | Described in |
|---|---|---|
| `verify/standard.json` | The standard phases and the ignored path globs | [Plan and verdict](plan-and-verdict.md#standard-phases) |
| `verify/areas/<area>.json` | An area's owner paths, documents and bound decisions | [Deriving an area template](derive-area-template.md#area-input-file-form) |
| `verify/templates/<area>/template.json` | The area's phases | [Deriving an area template](derive-area-template.md#template-form) |
| `verify/templates/<area>/derivation.md`, `coverage.md`, `comparison.md` | The record of how the template was derived and what it covers | [Deriving an area template](derive-area-template.md#output) |
| `personas/openclaw-verification-user.json` | The persona definition | [Persona](persona.md#definition-form) |
| `catalogue/openclaw.json` | The command catalogue for OpenClaw | [Command catalogue](catalogue.md#catalogue-form) |
| `support/verify/*.mjs`, `support/persona/*.mjs` | Catalogue scripts that wrap one product method or flow each | [Command catalogue](catalogue.md) |

A persona's exported environment is treated as secret-bearing. It lives
outside the repository and is never committed.

## What a verification proves and what it does not

A verdict is relative. `good-to-go` means no phase the plan ran recorded a
difference that only the change side shows and the intent file does not
explain. It does not mean the area is free of problems: differences present on
both sides are issues, reported separately. It says nothing about paths no area owns or phases the
persona could not support; the plan and the verdict list both, so a reader
sees what was not exercised.

A verdict is comparable only with verdicts made from the same persona manifest
version. Rebuilding the persona starts a new series.

## Pages

- [Plan and verdict](plan-and-verdict.md): path selection, the plan form,
  standard phases, the checkpoint form, the noise floor and the verdict form.
- [Persona](persona.md): traits, keys, builders, checks, the definition and
  manifest forms and the build procedure.
- [Command catalogue](catalogue.md): entries, rules, the background protocol,
  placeholders and how an entry is added.
- [Deriving an area template](derive-area-template.md): the procedure that
  produces a template, its forms and its acceptance rule.
