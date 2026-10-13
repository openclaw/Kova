# Comparison: plugins

Union: 379 entry points, 187 conditions, 183 condition headings

| Run | Entry points found | Conditions found | Condition headings found |
|---|---|---|---|
| 1 | 359/379 | 166/187 | 178/183 |
| 2 | 353/379 | 133/187 | 152/183 |

Run 1 found 94.7% of the entry points, 88.8% of the conditions and 97.3% of the condition headings; run 2 found 93.1%, 71.1% and 83.1%. Entry points clear nine tenths for both runs. Condition headings clear it for run 1 only. This is a known shortfall: this derivation was limited to four rounds (a limit set for this derivation; the procedure itself sets none), the fourth round did not close the gap, and the template is published from the best round with the shortfall stated here.

## How the numbers are counted

- Entry points: the union by name, counted one per control, method, command, route or call site; a line that names two controls counts two. `derivation.md` lists them on 365 lines. A run found an entry point when it placed it in an operation or excluded it with a reason. `derivation.md` `## Reconciliation` lists every entry point only one run found and every correction.
- Conditions: the union by meaning. Run 2's conditions match 112 of run 1's (several run 2 conditions match two run 1 conditions); 21 conditions are run 2 only and 54 are run 1 only.
- Condition headings: the headings of the listed documents under which either run found a condition, taken from the headings each condition's Source names and matched to the heading text in the document at OpenClaw `7e80556f` (Step, Tab and Accordion titles are headings; a run's paraphrase of a heading counts as that heading). A run found a heading when at least one of its conditions names it. This measure does not depend on how many conditions a run draws from one passage.

## Rounds on OpenClaw 7e80556f

Each round is two independent runs of steps 1 to 7 on the same area input file and revision. The procedure is the derivation page proposed in openclaw/Kova#169 (`docs/verify/derive-area-template.md`); each round ran under the rules of the revision named below.

| Round | Area input file | Procedure revision | Entry points found | Condition headings found | Conditions found |
|---|---|---|---|---|---|
| 1 | first version: 30 documents, no search list | rules of #169 at 7ac9313 (no search rule for other areas' code, no granularity rule, no headings walk) | 317/348 and 320/348 (91.1%, 92.0%) | 62/76 and 61/76 (81.6%, 80.3%) | 67/78 and 66/78 (85.9%, 84.6%) |
| 2 | adds `docs/plugins/sdk-overview/host-hooks.md` (one run had added it from a link) and bound decisions on runtime and deployment variants and on labels that exist only in locale files | rules of #169 at a4dc35c (adds: other areas' code found by search, one entry point per file; one condition per state or event with its own consequence) | 367/398 and 357/398 (92.2%, 89.7%) | 81/103 and 86/103 (78.6%, 83.5%) | 94/114 and 94/114 (82.5%, 82.5%) |
| 3 (this template) | this file: adds the `search` list (21 symbols, 25 literals) with its scope, the HTTP routes, and one name per `api.register*` method | rules of #169 at c3c28a3 (adds: both runs search the input file's list; every listed document walked heading by heading) | 359/379 and 353/379 (94.7%, 93.1%) | 178/183 and 152/183 (97.3%, 83.1%) | 166/187 and 133/187 (88.8%, 71.1%) |
| 4 | same as round 3 | rules of #169 at c3c28a3 plus a completeness wording that #169 does not carry: each sentence or list item under a heading read in turn | 339/399 and 379/399 (85.0%, 95.0%) | 157/184 and 148/184 (85.3%, 80.4%) | not reconciled by meaning: 199 and 335 conditions listed |

Round 4's first attempt was stopped before either run wrote output and was replaced by two fresh runs on the pinned revision; its numbers are those of the fresh runs. Round 3 is published: its lower run is higher than every other round's lower run on entry points (93.1%) and on condition headings (83.1%), and it is the latest round reconciled by meaning.

## Residual cause

From round 3 on, the area input file no longer explains the gap: both runs read the same documents and searched the same list, and both clear nine tenths of the entry points. In round 3 both runs found conditions under 147 of the 183 condition headings. The remaining difference is reading: which passages a run treats as a lasting state or an event with its own consequence, and how many conditions it draws from one passage. Reading sentence by sentence (round 4) widened the gap instead of closing it: one run listed 199 conditions and the other 335 from the same headings, and the lower run's entry points fell to 85.0%.

The procedure gives no fixed count of conditions per sentence, so the share depends on the reader. Measuring at heading level removes the count from the comparison and leaves only whether a run read a passage as holding a condition at all; round 3's run 2 still misses 31 headings run 1 found, 13 of them in `docs/plugins/tool-plugins.md` (its quickstart, generated metadata and troubleshooting entries), the rest spread over `feature-plugins.md` ("Host capabilities", "Contribute and replace views", "Dock a conversation"), the bundle formats in `bundles.md`, and one or two headings in each of ten other documents.
