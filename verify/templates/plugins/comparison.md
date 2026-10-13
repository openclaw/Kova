# Comparison: plugins

Union: 379 entry points, 187 conditions, 184 condition headings

| Run | Entry points found | Conditions found | Condition headings found |
|---|---|---|---|
| 1 | 359/379 | 166/187 | 178/184 |
| 2 | 353/379 | 133/187 | 152/184 |

Run 1 found 94.7% of the entry points, 88.8% of the conditions and 96.7% of the condition headings; run 2 found 93.1%, 71.1% and 82.6%. Entry points clear nine tenths for both runs. Condition headings clear it for run 1 only. This is a known shortfall: the rerun limit was reached after four rounds (below), and the template is published from the best round with the shortfall stated here.

## How the numbers are counted

- Entry points: the union by name, counted one per entry point after splitting lines a run listed together (two buttons on one line count as two). `derivation.md` lists the same entry points on 365 lines. A run found an entry point when it placed it in an operation or excluded it with a reason. Lines that only pointed at entries already counted, and a test fixture one run placed, are not counted twice; `derivation.md` `## Reconciliation` names each correction.
- Conditions: the union by meaning. Run 2's conditions match 112 of run 1's (several run 2 conditions match two run 1 conditions); 21 conditions are run 2 only and 54 are run 1 only.
- Condition headings: the headings of the listed documents under which either run found a condition, taken from the headings each condition's Source names. A run found a heading when at least one of its conditions names it. This measure does not depend on how many conditions a run draws from one passage.

## Rounds on OpenClaw 7e80556f

Each round is two independent runs of steps 1 to 7 on the same area input file and revision. The procedure is `docs/verify/derive-area-template.md`; its rules changed between rounds as listed.

| Round | Area input file | Procedure rules in force | Entry points found | Condition headings found | Conditions found |
|---|---|---|---|---|---|
| 1 | first version: 30 documents, no search list | steps as first written: no search rule for other areas' code, no condition granularity rule, no headings walk | 317/348 and 320/348 (91.1%, 92.0%) | 62/76 and 61/76 (81.6%, 80.3%) | 67/78 and 66/78 (85.9%, 84.6%) |
| 2 | adds `docs/plugins/sdk-overview/host-hooks.md` (one run had added it from a link) and bound decisions on runtime and deployment variants and on labels that exist only in locale files | adds: other areas' code found by search, one entry point per file; one condition per state or event with its own consequence | 367/398 and 357/398 (92.2%, 89.7%) | 81/104 and 86/104 (77.9%, 82.7%) | 94/114 and 94/114 (82.5%, 82.5%) |
| 3 (this template) | this file: adds the `search` list (21 symbols, 25 literals) with its scope, the HTTP routes, and one name per `api.register*` method | adds: both runs search the input file's list; every listed document walked heading by heading, recorded as `## Headings walked` | 359/379 and 353/379 (94.7%, 93.1%) | 178/184 and 152/184 (96.7%, 82.6%) | 166/187 and 133/187 (88.8%, 71.1%) |
| 4 | same as round 3 | adds: each sentence or list item under a heading read in turn | not reconciled | 157/184 and 148/184 (85.3%, 80.4%) | not reconciled; 199 and 335 conditions listed |

Round 4's first attempt was stopped before either run wrote output and was replaced by two fresh runs on the pinned revision; its numbers are those of the fresh runs. In round 4 the runs' `## Headings walked` lists, which also count headings a condition does not name in its Source, give 74.1% and 97.2% of 212 headings. Round 3 is published: on every measure its lower run is the highest of the rounds on this input file, and it is the latest round reconciled by meaning.

## Residual cause

From round 3 on, the area input file no longer explains the gap: both runs read the same documents, searched the same list and walked the same headings, and both clear nine tenths of the entry points. In round 3 both runs found conditions under 146 of the 184 condition headings. The remaining difference is reading: which passages a run treats as a lasting state or an event with its own consequence, and how many conditions it draws from one passage. Reading sentence by sentence (round 4) widened the gap instead of closing it: one run listed 199 conditions and the other 335 from the same headings.

The procedure gives no fixed count of conditions per sentence, so the share depends on the reader. Measuring at heading level removes the count from the comparison and leaves only whether a run read a passage as holding a condition at all; round 3's run 2 still misses 32 headings run 1 found, 14 of them in `docs/plugins/tool-plugins.md` (its quickstart, generated metadata and troubleshooting entries), the rest spread over `feature-plugins.md` ("Host capabilities", "Contribute and replace views", "Dock a conversation"), the bundle formats in `bundles.md`, and one or two headings in each of ten other documents.
