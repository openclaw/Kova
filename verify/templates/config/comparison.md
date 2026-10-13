# Comparison: config

Union: 291 entry points, 462 conditions under 63 condition headings

| Run | Entry points found | Conditions found | Condition headings found |
|---|---|---|---|
| 1 | 284/291 (97.6%) | 428/462 (92.6%) | 62/63 (98.4%) |
| 2 | 287/291 (98.6%) | 417/462 (90.3%) | 62/63 (98.4%) |

Both runs found at least nine tenths of the reconciled union of entry points, of conditions and of condition headings. Revision 7e80556f503d26ddde64e274bfb50cbbec7830f5; area input file verify/areas/config.json as committed; procedure revision 4 (below). The template, derivation.md and coverage.md in this directory are the reconciliation of these two runs.

## How the shares were counted

- Entry points: one list per run (placed or excluded), files matched by path and every other entry point by name. Run 1 alone listed 4: the segmented On/Off/Auto choice (run 2 folded it into the choice field), the Import theme card (run 2 listed only the import field and button), extensions/matrix/src/matrix/monitor/startup.ts (run 2 judged its injected `replaceConfigFile` callback not a call of the listed symbol) and src/agents/tools/gateway-tool.ts as a file (run 2 counted only its two tool actions). Run 2 alone listed 7: the Settings navigation Retry (run 1 listed it as a shell control) and the Setup wizard section and five new-entry draft controls of the collection editor (run 1 did not enumerate them).
- Conditions: matched heading by heading through `## Headings walked`, pairing rows by meaning, then reviewing every unpaired row and every pair whose wording differed. Where one run named a state inside a broader row of the other, the two count as one condition (derivation.md, Reconciliation). Run 1's 45 conditions that run 2 did not list sit mostly in the retired-config list of docs/gateway/doctor/config-migrations.md (run 1 took one row per retired input, run 2 one row for the list), its webhook listener and missing-plugin sections, and the attention chips and footer statements of the Settings section. Run 2's 34 sit mostly in docs/cli/config.md (values, paths, validate and dry-run failure statements) and in single statements of the hot-reload and Redaction sections.
- Condition headings: a heading under which either run found a condition. Each run missed one: run 1 recorded nothing under docs/cli/config.md "If dry-run fails" (it read the list of failure kinds as the outcome of the dry-run operation), and run 2 nothing under "--dry-run --json fields" (it read the field list as an output format).

The remaining round 4 difference is granularity inside sections both runs read and these two headings, which each run read but recorded differently.

## Procedure revisions

- Revision 1 (round 1): steps 1 to 8 without a search rule for code in other areas, a granularity rule for conditions or a heading walk.
- Revision 2 (round 2): revision 1 plus one condition per state or event with its own consequence, Control UI connection states counted.
- Revision 3 (round 3): revision 2 plus the `search` object of the area file for code in other areas, and a walk of every heading recorded under `## Headings walked`.
- Revision 4 (round 4): revision 3 plus sentence-by-sentence reading under each heading; this is step 3 as docs/verify/derive-area-template.md states it. The template form of that page (each phase's own `requires`, one writer per `{run}` file) and its command and isolation rules were applied at reconciliation.

## Every round

Every round read the same OpenClaw revision. Both runs of a round read the same input file and the same procedure revision; each change was made before the next round started.

| Round | Procedure | Input file | Entry points found (run 1, run 2) | Conditions found (run 1, run 2) | Condition headings found (run 1, run 2) | Result |
|---|---|---|---|---|---|---|
| 1 | revision 1 | bound named the neighbouring areas only | estimated about 82% and 69% of about 432 | estimated about 70% and 93% of about 56 | 82.1%, 71.8% of 39 | under nine tenths |
| 2 | revision 2 | bound gained counting rules (Gateway methods, CLI commands, tool actions, a search for code from other areas, redaction sinks, Control UI controls) | 98.6%, 95.2% of 294 | run 1 not computed; run 2 at most 76.5% (the union was at least run 1's 183) | 85.1%, 77.6% of 67 | under nine tenths |
| 3 | revision 3 | search list moved into `search` | not computed one by one; the file entry points agreed but for 5 of 83 | 93.3%, 82.8% of 209 | 97.1%, 85.3% of 68 | under nine tenths |
| 4 | revision 4 | bound names, per document, the sections that are this area's | 97.6%, 98.6% of 291 | 92.6%, 90.3% of 462 | 98.4%, 98.4% of 63 | accepted |

Rounds 1 to 3 fell short and were superseded, so their unions were not reconciled one entry by one entry; the figures marked estimated or not computed cannot be recovered without matching those superseded runs again. Rounds 1 and 2 had no heading walk; their condition headings are counted from the headings each condition cites as its source. Rounds 3 and 4 count them from `## Headings walked`.

What each change fixed:

- Round 1 to 2: the runs disagreed on which code outside the area counts (one run placed every caller it found, the other excluded plugin, channel and agent writes as owned elsewhere), listed Settings sidebar links one by one or once, and split or merged conditions differently. The bound now fixes how entry points are counted, and code found by the search is never excluded as owned elsewhere.
- Round 2 to 3: with entry points aligned, one run found 183 conditions and the other 140; both read the same documents but recorded different statements. Walking every heading makes a skipped heading visible.
- Round 3 to 4: two thirds of the first run's extra conditions came from sections whose owner the input file did not name (Gateway probe warnings, FAQ questions about binding and tokens, the model and gateway sections of `openclaw configure`). The input file now names, for each document, which sections belong to config.

## Known shortfalls

Round 4 is the last round of this derivation; these gaps are recorded here instead of being closed by another round.

- The bound gives docs/gateway/config-secrets-env.md to secrets, but its `${VAR:-fallback}` defaults, empty fallbacks, nested and literal forms, and the restoring of authored fallbacks on write-back describe src/config/env-substitution.ts and src/config/env-preserve-authored.ts, which are in this area's paths. No condition or phase covers them. The next derivation should list those sections as config's.
- Run 2 reported two config writers missing from `search.symbols`: promoteConfigSnapshotToLastKnownGood (called from src/gateway/server-startup-finish.ts) and recoverConfigFromJsonRootSuffix (called from src/commands/doctor-config-preflight-legacy-config.ts). The area file is left as both runs read it; their callers are in the paths of the phases that exercise them, but they are not counted as entry points. The next derivation should add both symbols.
- Phases that needed a second environment (no config file, a symlinked config, a remote Gateway, password auth, switching Gateways) were removed at reconciliation, because one persona environment is cloned per side; their conditions are listed as uncovered in coverage.md.
