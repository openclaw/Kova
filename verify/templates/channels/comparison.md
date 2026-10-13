# Comparison: channels

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

State: reconciled with a known shortfall after the permitted rerun.
The procedure's nine-tenths acceptance was not met.

Union: 428 entry points, 645 conditions, 258 condition-bearing document headings.

| Round | Run | Entry points found | Condition headings found |
|---|---|---|---|
| 1 | 1 | 319/325 (98.2%) | 214/245 (87.3%) |
| 1 | 2 | 299/325 (92.0%) | 227/245 (92.7%) |
| 2 | 1 | 400/428 (93.5%) | 246/258 (95.3%) |
| 2 | 2 | 379/428 (88.6%) | 248/258 (96.1%) |

An entry point is found when a run lists it, placed or excluded with a reason.
Equivalent names identify the same entry point. A combined entry receives credit
for each separately listed control or callback it explicitly names. Distinct
native-command, profile HTTP and voice routes remain distinct.

The condition measure counts document headings under which a run records at least
one condition. Its denominator contains every heading under which either run
records a condition. A heading recorded as `none` is not found. Introduction
labels, Markdown formatting and escaped quotation marks are normalized; different
condition wording or granularity does not create additional headings.

Round 1 used input version 2: 34 listed documents, 27 search symbols and 19
literals, with the fixed search list and heading walk introduced at 13:30 UTC on
2026-10-13. Both runs completed before the 13:50 UTC sentence-by-sentence
completeness rule. The first run fell short on condition headings. Differences
included troubleshooting signatures, ambient-room examples, SDK sections and
restart recovery. The eight condition-bearing restart-recovery headings came from
a document the first run added under step 1.

Round 2 used input version 3: 36 listed documents, 41 search symbols and 20
literals, with the sentence-by-sentence rule and clarified bounds. The public
phase, command and reconciliation requirements from
[the derivation procedure](../../../docs/verify/derive-area-template.md) were
applied when combining the results. Both runs passed the heading measure. The
second run's 88.6% entry-point share remains below nine tenths. Historical
procedure versions are identified by these recorded changes; immutable revision
hashes were not retained for them.

The remaining entry-point difference comes principally from unspecified search
roots and file kinds. The first run included 23 translation files and six extension
documents (five READMEs and one CHANGELOG); the second included scripts, QA
scenarios and release-feed files. These recorded differences remain visible. A
future maintenance pass needs explicit search roots and file-kind globs, including
how documentation, translations and release feeds are treated.

The first run also added `docs/gateway/config-agents/messages-and-talk.md` under
step 1. Its five condition-bearing headings are additions to the document set,
rather than missed prescribed reading by the other run. They remain included in
the all-heading denominator above.

For context, the finer condition-by-meaning comparison was 253/320 (79.1%) and
299/320 (93.4%) in round 1, and 592/645 (91.8%) and 590/645 (91.5%) in round 2.
These figures describe differences in sentence-level granularity; they are not
the heading measure used for acceptance here.

Earlier completed attempts used changing inputs and lacked comparable heading
records, so they are diagnostic history rather than acceptance rounds. An
interrupted pair was restarted, then abandoned after the product checkout moved;
it produced no completed comparable pair. Round 2 used the pinned revision and was
the last permitted rerun.

Earlier arithmetic is superseded. Round 1's 314/321 and 299/321 incorrectly merged
distinct native-command and profile HTTP routes into inbound adapters. Round 2's
395/426 and 377/426 omitted a presentation-button callback, combined Discord voice
with inbound messaging, and omitted explicit coverage within combined UI entries.
The corrected figures above preserve those distinctions. Seventeen test files
from the first run and one from the second were removed under the recorded
test-file correction.

No further derivation was performed. The combined result preserves the remaining
shortfall and its cause.
