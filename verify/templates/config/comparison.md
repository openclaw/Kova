# Comparison: config

Union: 291 entry points, 459 conditions under 63 condition headings

| Run | Entry points found | Conditions found | Condition headings found |
|---|---|---|---|
| 1 | 284/291 (97.6%) | 426/459 (92.81%) | 62/63 (98.4%) |
| 2 | 287/291 (98.6%) | 414/459 (90.20%) | 62/63 (98.4%) |

Both runs satisfy acceptance: at least nine tenths of the reconciled union of entry points and of condition headings. Condition-row shares are reported separately. Revision 7e80556f503d26ddde64e274bfb50cbbec7830f5; area input file verify/areas/config.json as committed; procedure revision 4 (below). The template, derivation.md and coverage.md in this directory are the reconciliation of these two runs.

## How the shares were counted

- Entry points: one list per run (placed or excluded), files matched by path and every other entry point by name. Run 1 alone listed 4: the segmented On/Off/Auto choice (run 2 folded it into the choice field), the Import theme card (run 2 listed only the import field and button), extensions/matrix/src/matrix/monitor/startup.ts (run 2 judged its injected `replaceConfigFile` callback not a call of the listed symbol) and src/agents/tools/gateway-tool.ts as a file (run 2 counted only its two tool actions). Run 2 alone listed 7: the Settings navigation Retry (run 1 listed it as a shell control) and the Setup wizard section and five new-entry draft controls of the collection editor (run 1 did not enumerate them).
- Conditions: matched heading by heading through `## Headings walked`, pairing rows by meaning, then reviewing every unpaired row and every pair whose wording differed. Where one run named a state inside a broader row of the other, the two count as one condition (derivation.md, Reconciliation). Run 1's 45 conditions that run 2 did not list sit mostly in the retired-config list of docs/gateway/doctor/config-migrations.md (run 1 took one row per retired input, run 2 one row for the list), its webhook listener and missing-plugin sections, and the attention chips and footer statements of the Settings section. Run 2's 33 sit mostly in docs/cli/config.md (values, paths, validate and dry-run failure statements) and in single statements of the hot-reload and Redaction sections.
- Condition headings: a heading under which either run found a condition. Each run missed one: run 1 recorded nothing under docs/cli/config.md "If dry-run fails" (it read the list of failure kinds as the outcome of the dry-run operation), and run 2 nothing under "--dry-run --json fields" (it read the field list as an output format).

The remaining round 4 difference is granularity inside sections both runs read and these two headings, which each run read but recorded differently.

## Procedure revisions

- Revision 1 (round 1): steps 1 to 8 without a search rule for code in other areas, a granularity rule for conditions or a heading walk.
- Revision 2 (round 2): revision 1 plus one condition per state or event with its own consequence, Control UI connection states counted.
- Revision 3 (round 3): revision 2 plus the `search` object of the area file for code in other areas, and a walk of every heading recorded under `## Headings walked`.
- Revision 4 (round 4): revision 3 plus sentence-by-sentence reading under each heading; this is step 3 as docs/verify/derive-area-template.md states it. The template form of that page (each phase's own `requires`, one writer per `{run}` file) and its command and isolation rules were applied at reconciliation.

## Every round

Every round used OpenClaw 7e80556f503d26ddde64e274bfb50cbbec7830f5. Both runs of a round read the same input file and procedure revision. The entry-point and condition-heading acceptance below applies the final criterion to all four recorded rounds. Individual enumerated counts are retained separately from counts credited after reconciliation.

## Round 1

Union: 443 entry points, 37 condition headings; the individual-condition union was estimated at about 56 and was not fully reconciled.

| Run | Procedure revision | Entry points found | Condition headings found | Individual conditions found |
|---|---|---|---|---|
| 1 | revision 1 | 355/443 (80.1%) | 32/37 (86.5%) | 39 enumerated; credited share estimated at about 70% |
| 2 | revision 1 | 312/443 (70.4%) | 28/37 (75.7%) | 52 enumerated; credited share estimated at about 93% |

Remaining differences: the runs counted cross-area calls, native callers, sidebar controls and excluded shell surfaces differently; they also grouped conditions differently. The input bound initially named only the neighbouring areas.
Acceptance: historical shortfall on both required shares; superseded by later rounds.
Rerun cap: the derivation was later capped at round 4; not reached here.
Known shortfall: both runs were below nine tenths on entry points and condition headings, for the causes above.

## Round 2

Union: 294 entry points, 60 condition headings; the individual-condition union and credited shares were not fully reconciled.

| Run | Procedure revision | Entry points found | Condition headings found | Individual conditions found |
|---|---|---|---|---|
| 1 | revision 2 | 290/294 (98.6%) | 55/60 (91.7%) | 183 enumerated; complete credited share not computed |
| 2 | revision 2 | 280/294 (95.2%) | 53/60 (88.3%) | 140 enumerated; complete credited share not computed |

Remaining differences: the revised counting rules aligned most entry points, but the runs selected different statements and headings from the same documents. Six search hits that were not calls were removed from run 1's entry census.
Acceptance: historical shortfall for run 2's heading share; superseded by later rounds.
Rerun cap: the derivation was later capped at round 4; not reached here.
Known shortfall: run 2 found 53/60 condition headings (88.3%).

## Round 3

Union: 279 entry points, 68 condition headings, 209 individual conditions in the recorded reconciliation.

| Run | Procedure revision | Entry points found | Condition headings found | Individual conditions found |
|---|---|---|---|---|
| 1 | revision 3 | 276/279 (98.9%) | 66/68 (97.1%) | 195 enumerated; 195/209 credited (93.3%) |
| 2 | revision 3 | 274/279 (98.2%) | 58/68 (85.3%) | 158 enumerated; 173/209 credited (82.8%) after splitting explicitly combined statements |

Remaining differences: five caller files were found only by run 1, and three controls only by run 2. Most condition differences came from document sections whose owning area the input bound did not name; the next input named those sections explicitly.
Acceptance: historical shortfall for run 2's heading share; superseded by round 4.
Rerun cap: four rounds; the cap had not yet been reached.
Known shortfall: run 2 found 58/68 condition headings (85.3%).

## Round 4

Union: 291 entry points, 63 condition headings, 459 reconciled individual conditions.

| Run | Procedure revision | Entry points found | Condition headings found | Individual conditions found |
|---|---|---|---|---|
| 1 | revision 4 | 284/291 (97.6%) | 62/63 (98.4%) | 428 enumerated; 426/459 credited (92.81%) after reconciliation |
| 2 | revision 4 | 287/291 (98.6%) | 62/63 (98.4%) | 406 enumerated; 414/459 credited (90.20%) after reconciliation |

Remaining differences: the entry controls, two differently interpreted headings, retired-key detail and Settings statements named in the counting explanation above. Composite and duplicate condition identities are resolved in derivation.md.
Acceptance: both runs reach nine tenths on entry points and condition headings.
Rerun cap: four rounds; reached. No further derivation was run.
Known shortfall: none on the acceptance shares. The remaining input-bound and execution gaps are disclosed below and in coverage.md.

## Historical counting notes

The round 1 and round 3 entry-point unions were recounted from the preserved enumerations. Names and source paths identify entries; aliases and different labels for the same control are matched. Explicitly combined controls count at the finer granularity, such as text and number fields, Form and Raw switches, quiet-hours start and end, and the Settings shortcut and menu item. A generic group that does not name its controls stays a separate entry. Credited counts can therefore exceed enumerated rows. Run 2 in round 1 is credited with the theme-default accent control explicitly included in its preset entry. Its combined select/segmented field and Show API key/secret-reference editor each name two controls, and its `/debug show|set|unset|reset` entry names four commands; these are counted separately even when only one run lists them. A file-level caller record stays one entry by path, including the exec-policy writer and log-tail sink; command names in its description do not turn it into a separate command inventory. Round 2 retains its recorded entry reconciliation; its raw 140/183 ratio is not a bound on credited coverage, since a single row can explicitly contain several conditions.

Rounds 1 and 2 had no heading walk; their heading shares are recovered from condition citations, splitting multiple named headings and matching introduction and shortened FAQ labels. Quoted values inside a heading, such as "lan" and "tailnet", are not extra headings. These recounts replace the earlier 39- and 67-heading estimates. Rounds 3 and 4 use `## Headings walked`. Earlier individual-condition estimates remain explicitly qualified and are not the acceptance measure.

What each change fixed:

- Round 1 to 2: the runs disagreed on which code outside the area counts (one run placed every caller it found, the other excluded plugin, channel and agent writes as owned elsewhere), listed Settings sidebar links one by one or once, and split or merged conditions differently. The bound now fixes how entry points are counted, and code found by the search is never excluded as owned elsewhere.
- Round 2 to 3: with entry points aligned, one run found 183 conditions and the other 140; both read the same documents but recorded different statements. Walking every heading makes a skipped heading visible.
- Round 3 to 4: two thirds of the first run's extra conditions came from sections whose owner the input file did not name (Gateway probe warnings, FAQ questions about binding and tokens, the model and gateway sections of `openclaw configure`). The input file now names, for each document, which sections belong to config.

## Known shortfalls

Round 4 is the last round of this derivation; these gaps are recorded here instead of being closed by another round.

- The bound gives docs/gateway/config-secrets-env.md to secrets, but its `${VAR:-fallback}` defaults, empty fallbacks, nested and literal forms, and the restoring of authored fallbacks on write-back describe src/config/env-substitution.ts and src/config/env-preserve-authored.ts, which are in this area's paths. No condition or phase covers them. The next derivation should list those sections as config's.
- Run 2 reported two config writers missing from `search.symbols`: promoteConfigSnapshotToLastKnownGood (called from src/gateway/server-startup-finish.ts) and recoverConfigFromJsonRootSuffix (called from src/commands/doctor-config-preflight-legacy-config.ts). The area file is left as both runs read it; their callers are in the paths of the phases that exercise them, but they are not counted as entry points. The next derivation should add both symbols.
- The second-environment phases from the recorded runs are retained with per-clone persona environments. They require the named environment exports and support scripts before they can execute; the template itself does not create those environments.

The round 3 entry-point residual is five caller files found only by run 1 (the agents page, memory panel, dreaming page and two cloud-worker pages) and three controls found only by run 2 (the native Settings route, Learn more link and draft Cancel). Its select-or-segmented control explicitly covers both controls run 2 named separately. Round 1's much larger residual comes from the recorded differences in cross-area calls, individual settings controls, native callers and excluded shell surfaces described above.

Coverage limits after reconciliation include dependent consumer behavior that the saved phases do not drive. Those conditions stay in the reconciled derivation and in the heading census; coverage.md identifies them as uncovered. A config write and a subsequent config read alone do not establish terminal, connection, authentication, admission or plugin-work consequences.

The final condition count also merges two composite/contained duplicates: the same-store handoff statement into condition 45, and messages.tts migration into condition 337. Both source citations and each run's membership are retained. Condition identifiers remain stable rather than shifting the later coverage references.

After the full composite-condition reconciliation and the additional credit for run 2 C38, the condition-row shares are 426/459 (92.81%) and 414/459 (90.20%). Acceptance remains the entry-point and condition-heading measures. The matches and retained distinct states are listed in derivation.md; no new derivation was run.
