# Comparison: channels

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

State: reconciled with a known shortfall after the permitted rerun.
The procedure's nine-tenths acceptance was not met.

Union: 435 entry points, 655 conditions, 258 condition-bearing document headings.
The recorded-run reconciliation contained 645 conditions; source review added ten
documented inspection conditions that neither run found.

| Round | Run | Entry points found | Condition headings found |
|---|---|---|---|
| 1 | 1 | 318/332 (95.8%) | 214/245 (87.3%) |
| 1 | 2 | 298/332 (89.8%) | 227/245 (92.7%) |
| 2 | 1 | 399/435 (91.7%) | 246/258 (95.3%) |
| 2 | 2 | 378/435 (86.9%) | 248/258 (96.1%) |

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
completeness rule. The first run fell short on condition headings, and the second on entry points
after the individual-control correction below. Differences
included troubleshooting signatures, ambient-room examples, SDK sections and
restart recovery. The eight condition-bearing restart-recovery headings came from
a document the first run added under step 1.

Round 2 used input version 3: 36 listed documents, 41 search symbols and 20
literals, with the sentence-by-sentence rule and clarified bounds. The public
phase, command and reconciliation requirements from
[the derivation procedure](../../../docs/verify/derive-area-template.md) were
applied when combining the results. Both runs passed the heading measure. The
second run's 86.9% entry-point share remains below nine tenths. Historical
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

The Nostr profile form exposes eight separately editable controls: `name`,
`displayName`, `about`, `picture`, `banner`, `website`, `nip05`, and `lud16` in
`ui/src/pages/channels/view.nostr-profile-form.ts`. Each run listed the form fields
as one generic family. That grouping breaches the one-control-per-entry rule.
The corrected inventory replaces that family with eight named controls. Neither
run receives discovery credit for individual names it did not enumerate, so the
corrected denominator includes eight reconciliation corrections with no individual
run credit. This correction applies to both rounds: it supersedes the intermediate
319/325 and 299/325, and 400/428 and 379/428 figures. It is a correction of recorded
granularity, without another derivation run.

Source review added conditions 646–655 for asynchronous ingress inspection under
"Durable ingress monitors", a heading both runs had already found. No derivation
was rerun and neither receives discovery credit for these additions. Against the
corrected 655-condition inventory, the supplemental condition-by-meaning shares
are 592/655 (90.4%) and 590/655 (90.1%). The entry-point and condition-heading
acceptance shares above are unchanged.
