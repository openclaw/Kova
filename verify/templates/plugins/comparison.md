# Comparison: plugins

Union: 379 entry points, 187 conditions

| Run | Entry points found | Conditions found |
|---|---|---|
| 1 | 359/379 | 166/187 |
| 2 | 353/379 | 133/187 |

Run 1 found 94.7% of the entry points and 88.8% of the conditions; run 2 found 93.1% and 71.1%. Entry points clear nine tenths for both runs. Conditions do not clear it for either run, so acceptance 1 of the derivation procedure is not met by this pair. The template is published from this pair because it is the best of four rounds on the pinned revision (see below); the shortfall is recorded here rather than hidden.

## How the numbers are counted

- Entry points: the union by name, counted one per entry point after splitting lines a run listed together (two buttons on one line count as two). `derivation.md` lists the same entry points on 365 lines. A run found an entry point when it placed it in an operation or excluded it with a reason. Lines that only pointed at entries already counted, and a test fixture one run placed, are not counted twice; `derivation.md` `## Reconciliation` names each correction.
- Conditions: the union by meaning, compared heading by heading over the `## Headings walked` lists of both runs. Run 2's conditions match 112 of run 1's (several run 2 conditions match two run 1 conditions); 21 conditions are run 2 only and 54 are run 1 only.

## Rounds on OpenClaw 7e80556f

Each round is two independent runs of steps 1 to 7 on the same area input file and revision. The procedure is `docs/verify/derive-area-template.md`; its rules changed between rounds as listed.

| Round | Area input file | Procedure rules in force | Entry points found | Conditions found |
|---|---|---|---|---|
| 1 | first version: 30 documents, no search list | steps as first written: no search rule for other areas' code, no condition granularity rule, no headings walk | 317/348 and 320/348 (91.1%, 92.0%) | 67/78 and 66/78 (85.9%, 84.6%) |
| 2 | adds `docs/plugins/sdk-overview/host-hooks.md` (one run had added it from a link) and bound decisions on runtime and deployment variants and on labels that exist only in locale files | adds: other areas' code found by search, one entry point per file; one condition per state or event with its own consequence | 367/398 and 357/398 (92.2%, 89.7%) | 94/114 and 94/114 (82.5%, 82.5%) |
| 3 (this template) | this file: adds the `search` list (21 symbols, 25 literals) with its scope, the HTTP routes, and one name per `api.register*` method | adds: both runs search the input file's list; every listed document walked heading by heading, recorded as `## Headings walked` | 359/379 and 353/379 (94.7%, 93.1%) | 166/187 and 133/187 (88.8%, 71.1%) |
| 4 | same as round 3 | adds: each sentence or list item under a heading read in turn | not reconciled | 199 and 335 conditions listed; of the 212 headings where either run found a condition, run 1 found one under 157 (74.1%) and run 2 under 206 (97.2%) |

Round 4's first attempt was stopped before either run wrote output and was replaced by two fresh runs on the pinned revision; its numbers are those of the fresh runs. Round 4 was not reconciled by meaning: at heading level its lower run (74.1%) is further from nine tenths than round 3's (82.6% of 184 headings), and round 3 is the latest round reconciled on this input file.

## Residual cause

From round 3 on, the area input file no longer explains the gap: both runs read the same documents and searched the same list, and both clear nine tenths of the entry points. Conditions still differ, and the difference is not a heading one run skipped. In round 3 both runs found conditions under 146 of the 184 headings where either found one; the rest of the gap is in how many conditions each run draws from the same passage and which sentences it reads as a lasting state or an event with its own consequence. Reading sentence by sentence (round 4) widened the gap instead of closing it: one run listed 199 conditions and the other 335 from the same headings.

The procedure gives no fixed count of conditions per sentence, so the share depends on the reader. Two ways to close it: a fixed form, such as one condition per sentence that states a consequence, written by one run and checked sentence by sentence by the second; or acceptance measured at heading level, where round 3 reached 96.7% and 82.6%.
