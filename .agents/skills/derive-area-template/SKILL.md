---
name: derive-area-template
description: "Derive or refresh a kova verify area template for one OpenClaw area from its entry points and documents."
---

# Derive Area Template

Produce `verify/templates/<area>/` for one OpenClaw area by the procedure in
`docs/verify/derive-area-template.md`. That page owns the definitions, the
rules of every step and every file form; this skill is its checklist. Read the
page in full before step 1, and read [Persona](../../../docs/verify/persona.md)
and [Command catalogue](../../../docs/verify/catalogue.md) for trait names,
placeholders and command rules.

## Inputs

- The OpenClaw checkout at a named revision. Record the full sha.
- `verify/areas/<area>.json` in the area input file form. If it is missing,
  stop and ask for it; do not invent bounds.
- The path to the known breaks for OpenClaw, in the page's known breaks form,
  used from step 6 on.
- `catalogue/openclaw.json` and the persona manifest, when they exist, to name
  existing commands and traits.

## Steps

Each step names the section of the page it follows. Do not skip, merge or
reorder steps, and write each step's output before starting the next.

1. **Bound the area** (Step 1). Read every document the input file lists, in
   full. Add a document only when a listed one links to it and it describes an
   operation of this area. Output: `## Bounds` and `## Excluded paths` in
   `derivation.md`.
2. **Enumerate entry points and group them into operations** (Step 2). List
   every Gateway method, CLI command, UI action, channel route, scheduled job,
   agent or subagent call and plugin call; find calls from other areas by
   searching the source for the input file's `search` symbols and literals,
   one `from <area>` entry point per file found; group
   them by what the user is doing. Output: `## Operations` and
   `## Excluded entry points`.
3. **Enumerate standing conditions** (Step 3). From the documents only, never
   from incidents; walk every document heading by heading; one condition per
   state or event with its own consequence; mark each ambient or event with its
   source heading and persona trait. Output: `## Conditions` and
   `## Headings walked`.
4. **Write the phases** (Step 4). Setup, then operations in the order a user's
   session goes, then events; consuming and destructive phases last. Commands
   only from the catalogue or `support.toWrite`; placeholders only `{env}`,
   `{kovaRoot}`, `{run}`, `{persona:<trait>:<key>}`; every trait a phase needs
   in its own `requires`; no expected value or assertion. Output: the `phases`
   array of `template.json`.
5. **Complete the template header** (Step 5). Fill `id`, `title`, `objective`,
   `paths`, `requires` and `support`. Output: `template.json` complete, with
   no fields outside the template form.
6. **Cross-check against known breaks** (Step 6). Map every break in the
   area's globs to a phase; for each `none`, return to step 2 or 3 and redo
   step 4 for the affected phases. Never copy a break into the template.
   Output: `## Breaks cross-check` and, when needed,
   `## Undocumented conditions`.
7. **Write the coverage table** (Step 7). Output: `coverage.md` in the coverage
   table form, with uncovered items and persona additions by name.
8. **Reconcile two runs into the template** (Step 8). Steps 1 to 7 run twice,
   independently: two separate sessions or agents that share nothing but the
   input file, the revision and the page, each writing into its own working
   directory. Reconcile by the page's rules; reconciliation adds and never
   drops what one run covered. Then make every command the template uses known
   to the catalogue: a `toWrite` entry per new script, a checked `existing`
   entry per new OpenClaw command, Gateway method or OCM operation. Output: `template.json`,
   `derivation.md` with `## Reconciliation`, `coverage.md` and
   `comparison.md` in `verify/templates/<area>/`.

## Finish

Check the five acceptance conditions on the page. When a run found less than
nine tenths of the reconciled union of entry points or conditions (an entry
point excluded with a reason counts as found), fix the area input file or the
document list as the page says and repeat both runs. When
`catalogue/openclaw.json` exists, run:

```sh
node bin/kova.mjs catalogue check --product openclaw --templates verify/templates --personas personas --json
```

Every finding other than a `toWrite` entry must be fixed before finishing;
`toWrite` entries are expected until their scripts exist. Report the coverage
counts, the persona additions, the `support.toWrite` scripts and any
acceptance condition that does not hold.
