# Comparison: update

Union: 310 entry points, 520 conditions under 165 condition headings

| Run | Entry points found | Condition headings found |
|---|---|---|
| 1 | 287/310 | 165/165 |
| 2 | 305/310 | 152/165 |

Run 1 found 92.6% of the entry points and conditions under 100% of the condition headings; run 2 found 98.4% and 92.1%. Both runs clear nine tenths on both measures. The template is the reconciliation of these two runs, the third and last round below, and it keeps everything either run found.

Counting:

- An entry point is one line of the reconciled `## Operations` or `## Excluded entry points` list. A run found it when it listed it, placed or excluded.
- A condition heading is a heading, inside the sections the area input file bounds, under which either run recorded at least one condition in its `## Headings walked`. A run found the heading when it recorded at least one condition under it.
- Condition rows, for reference: the reconciled `## Conditions` table has 520 rows, keeping the finer split where the runs grouped differently. Run 1's own table lists 410 of them (78.8%) and run 2's lists 484 (93.1%). By groups merged by meaning (444), run 1 found 334 (75.2%) and run 2 found 408 (91.9%).

## Rounds

Every round ran steps 1 to 7 twice, independently, on OpenClaw 7e80556f503d26ddde64e274bfb50cbbec7830f5. Each round's input file and procedure differ from the one before by the corrections listed for it.

| Round | Runs | Entry points found | Condition headings found | Input file | Procedure |
|---|---|---|---|---|---|
| 1 | A, B | A about 90%, B about 63% of about 232 | A 80.2%, B 91.0% of 111 | paths, documents and bound only | steps as first written, with two rules added during the round: the caller search (code in other areas found by searching for the area's writer functions and literals) and condition granularity (one condition per state or event with its own consequence) |
| 2 | C, D | C 86.8%, D 87.2% of 235 | C 97.5%, D 96.8% of 157 | adds `search` (119 symbols, 15 literals) and the telemetry and slash-command pages with their bounded sections | adds completeness: walk every listed document heading by heading and write `## Headings walked` |
| 3 | 1, 2 | 92.6%, 98.4% of 310 | 100%, 92.1% of 165 | `search` grows to 136 symbols with literals matched as written (for example `command("triage")` instead of a bare command name); bound lines name the startup hooks and scheduled jobs, the other update methods, the consumed commands, terminal prompt choices and the route; adds the container image page's upgrade section and two paths (installation replacement check, pending package lifecycle) | completeness takes each sentence or list item under a heading in turn |

Round 1 had no headings ledger; its condition headings are the headings its conditions cite as their source. Round 1's entry-point union was matched by hand and is approximate.

What each correction fixed:

- Round 1 to round 2: each run had searched for a different set of writer functions (one found about 60 Doctor, config and state call sites, the other 35 restart and update-run call sites), and one run read the telemetry page the other did not. The input file now fixes the search list and the documents.
- Round 2 to round 3: the remaining entry-point differences were bound questions (whether a bare `update` literal, a terminal prompt choice, a consumed follow-up command or another update method counts, and which startup hooks are entry points). The input file now settles each, and both runs of round 3 clear nine tenths of the entry points.

## Residual differences

- Headings: the 13 headings only run 1 recorded conditions under are four headings of docs/install/bun-compatibility.md, which run 1 added under the step 1 rule (linked from docs/install/updating.md for Bun-only installs) and run 2 did not read, and nine headings run 2 walked and recorded as `none` (for example development-channels.md "Dry run" and "Tagging best practices", updating.md "After updating", how-updates-run.md "Git checkout flow"). The next revision of the input file should list docs/install/bun-compatibility.md.
- Condition rows: under the same headings run 2 recorded more conditions than run 1 (482 against 346). The gap sits in the longest sections: how-updates-run.md "Validation and activation", state-migrations.md "Legacy state migration", updating.md "Recommended: `openclaw update`" and "Package-publication recovery", and triage.md "Automatic failure handoff"; the same headings carried it in round 2. These sections pack several outcomes into one sentence, and one reader takes a sentence as one condition where the other takes each clause as its own. A fixed rule in step 3 for how many conditions one sentence yields would close it.
