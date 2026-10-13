# Comparison: config

Union: 291 entry points, 474 conditions under 63 condition headings

| Run | Entry points found | Conditions found | Condition headings found |
|---|---|---|---|
| 1 | 284/291 (97.6%) | 440/474 (92.8%) | 62/63 (98.4%) |
| 2 | 287/291 (98.6%) | 429/474 (90.5%) | 62/63 (98.4%) |

Both runs found at least nine tenths of the reconciled union of entry points, of conditions and of condition headings. A condition heading is a document heading under which either run found a condition; each run missed one (run 1 found nothing under docs/cli/config.md "If dry-run fails", run 2 nothing under "--dry-run --json fields"). Revision 7e80556f503d26ddde64e274bfb50cbbec7830f5; area input file verify/areas/config.json as committed. The template, derivation.md and coverage.md in this directory are the reconciliation of these two runs.

How the conditions were matched: heading by heading through `## Headings walked`, pairing rows by meaning and then reviewing every unpaired row and every pair whose wording differed. A row of one run that names several states another run lists separately counts as finding each of them (derivation.md, Reconciliation). Run 1's 45 conditions that run 2 did not list sit mostly in the retired-config list of docs/gateway/doctor/config-migrations.md (run 1 took one row per retired input, run 2 one row for the list), its webhook listener and missing-plugin sections, and the attention chips and footer statements of the Settings section. Run 2's 34 sit mostly in docs/cli/config.md (values, paths, validate and dry-run failure statements) and in single statements of the hot-reload and Redaction sections.

## Earlier rounds

The derivation took four rounds of two independent runs each. Every round read the same revision; rounds 1 to 3 used earlier input files. The procedure changed between rounds as well; each revision is named below by the rules it added, and both runs of a round read the same input file and the same procedure revision.

Procedure revisions:

- Revision 1 (round 1): steps 1 to 8 without a search rule for code in other areas, a granularity rule for conditions or a heading walk.
- Revision 2 (round 2): revision 1 plus one condition per state or event with its own consequence, Control UI connection states counted.
- Revision 3 (round 3): revision 2 plus the `search` object of the area file for code in other areas, and a walk of every heading recorded under `## Headings walked`.
- Revision 4 (round 4): revision 3 plus sentence-by-sentence reading under each heading; this is step 3 as docs/verify/derive-area-template.md states it. The template form of that page (each phase's own `requires`, one writer per `{run}` file) was applied at reconciliation.

| Round | Procedure | Input file | Entry points found (run 1, run 2) | Conditions found (run 1, run 2) | Condition headings found (run 1, run 2) | Result |
|---|---|---|---|---|---|---|
| 1 | revision 1 | bound named the neighbouring areas only | about 82%, 69% of about 432 | about 70%, 93% of about 56 | 82.1%, 71.8% of 39 | under nine tenths |
| 2 | revision 2 | bound gained counting rules (Gateway methods, CLI commands, tool actions, a search for code from other areas, redaction sinks, Control UI controls) | 98.6%, 95.2% of 294 | run 2 at most 76.5% (union at least 183) | 85.1%, 77.6% of 67 | under nine tenths |
| 3 | revision 3 | search list moved into `search` | above nine tenths for both | 93.3%, 82.8% of 209 | 97.1%, 85.3% of 68 | run 2 under nine tenths |
| 4 | revision 4 | bound names, per document, the sections that are this area's | 97.6%, 98.6% of 291 | 92.8%, 90.5% of 474 | 98.4%, 98.4% of 63 | accepted |

Rounds 1 and 2 had no heading walk; their condition headings are counted from the headings each condition cites as its source. Rounds 3 and 4 count them from `## Headings walked`.

What each change fixed:

- Round 1 to 2: the runs disagreed on which code outside the area counts (one run placed every caller it found, the other excluded plugin, channel and agent writes as owned elsewhere), listed Settings sidebar links one by one or once, and split or merged conditions differently. The bound now fixes how entry points are counted, and code found by the search is never excluded as owned elsewhere.
- Round 2 to 3: with entry points aligned, one run found 183 conditions and the other 140; both read the same documents but recorded different statements. Walking every heading makes a skipped heading visible.
- Round 3 to 4: two thirds of the first run's extra conditions came from sections whose owner the input file did not name (Gateway probe warnings, FAQ questions about binding and tokens, the model and gateway sections of `openclaw configure`). The input file now names, for each document, which sections belong to config.

The remaining difference in round 4 is granularity inside sections both runs read (one row per retired key against one row for the list), not missed sections.
