# Comparison: channels

Revision: 7e80556f503d26ddde64e274bfb50cbbec7830f5
Date: 2026-10-13

State: reconciled with a known shortfall after the permitted rerun.
The procedure's nine-tenths acceptance was not met.

Union: 460 entry points, 1054 conditions, 269 current condition-bearing document headings.
The recorded final-round reconciliation contained 645 conditions and 258
condition-bearing headings. Later reconciliation adds 409 in-scope current
conditions. Of those, 408 are source-only meanings without extra discovery credit.
The other is the separately recorded Mattermost behavior in the second final run,
whose combined Teams/Mattermost record now has two distinct native outcomes. Unsupported
dynamic-group failure and live logout ordering are restored from the earlier
round, where they were already counted; neither final run receives credit.
Existing outbound adapters, directory Groups, pairing approve, message Core,
Member info, Poll, Adding or updating a channel formatter, and broadcast Fields
and Troubleshooting, plus iMessage specifics and Moderation (Discord), are eleven additional condition-bearing headings in the current inventory. The historical
round 2 heading denominator stays 258. Restored composite meanings keep their
original IDs and credit; missing observations affect planned coverage.

| Round | Run | Entry points found | Condition headings found |
|---|---|---|---|
| 1 | 1 | 317/339 (93.5%) | 214/245 (87.3%) |
| 1 | 2 | 297/339 (87.6%) | 227/245 (92.7%) |
| 2 | 1 | 413/460 (89.8%) | 246/258 (95.3%) |
| 2 | 2 | 383/460 (83.3%) | 248/258 (96.1%) |

An entry point is found when a run lists it, placed or excluded with a reason. The recorded sendAttachment action is retained as excluded compatibility evidence: iMessage advertises upload-file instead. All four recorded runs named both spellings, so this changes placement only and preserves their separate historical discovery records. Source inspection moved 36 non-executable search matches from placed to excluded internal evidence, including 17 additional records identified by checking every one of the 116 code-search matches that remained placed. That placement-only correction retained each recorded discovery for the run that listed it; its then-current union and discovery shares did not change. The later named-entry correction below supersedes those entry totals.
Equivalent names identify the same entry point. A combined entry receives credit
for each control, callback or HTTP method and path it explicitly names. A
method-unspecified route family does not establish discovery of an individual
HTTP method. Distinct
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
corrected entry-point shares are 89.8% and 83.3%, both below nine tenths. Historical
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

The original individual-condition inventories contained 201 and 289 records in
round 1, and 586 and 511 records in round 2. These are raw recorded row counts;
reconciliation splits combined meanings and joins equivalent conditions, so they
are distinct from the following meaning-based coverage numerators.

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

The Nostr HTTP handler exposes GET and PUT on
`/api/channels/nostr/<account>/profile`, plus POST on
`/api/channels/nostr/<account>/profile/import`. The second run in round 2 explicitly
named PUT profile and POST profile import in its combined label, so splitting that
label adds one discovery credit. The first run named no HTTP entry. Neither named
GET. In round 1, both runs named only a method-unspecified profile route; neither
receives credit for a method it did not enumerate. UI actions and HTTP methods
remain separate entries, even when one invokes the other.

Replacing one HTTP family with three methods adds two entries to each round's
corrected inventory. Round 1 loses its former generic-family credit for each run;
round 2 retains the first run's credit count and adds one for the second. These
figures supersede 318/332 and 298/332, and 399/435 and 378/435. GET is a source-review
addition with no run credit. That earlier accounting recorded 313 placed and 125 excluded
entries; the later excluded-entry correction below supersedes its total. This is an accounting correction to recorded inputs, without a new
independent derivation. Both rounds retain the stated acceptance shortfall.

Earlier corrections added conditions 646–704. Presentation, ingress and inbound
consumer audits add in-scope conditions 705–771, channel routing adds 772–774,
CLI reconciliation adds 775–815, message and join-history reconciliation adds
816–847, formatting adds 848–874, channel RPC reconciliation adds 875–884, and broadcast
reconciliation adds 885–895; the overlapping mention-policy list condition is 896.
No additional derivation run was performed.
Typed exec/plugin approval delivery and resolution are excluded by the area
bound and do not enter the current denominator. Unsupported dynamic-group
failure and live logout ordering were recorded in round 1; their existing
credit and that round’s union remain unchanged. Neither final run receives
credit for those restored conditions or the other current additions.

The current inventory contains 269 condition-bearing headings. This does not
change the historical 258-heading union or either final run’s recorded heading
credit. Restored composites retain their original credit. Against the current
1054-condition inventory, supplemental condition-by-meaning shares are
592/1054 (56.2%) and 591/1054 (56.1%). The second numerator adds one
explicitly recorded Mattermost meaning after separating it from Teams; it does
not assign discovery credit to a source-only addition. The historical
645-condition comparison and per-round condition-heading
acceptance shares above remain unchanged. Entry-point arithmetic is corrected below. Planned coverage is a separate
measure in coverage.md.

The channel configuration Advanced settings disclosure is one named control with show and hide states. Both runs in round 1 explicitly listed it, so their then-current 334-entry comparison and discovery counts did not change at that correction. Neither final-round run listed it: generic config fields, the separate Nostr profile advanced toggle and excluded app-shell settings do not establish discovery of this disclosure. Restoring it adds one placed entry to the current inventory, with no final-round credit. That restoration produced a union of 438 entries, 313 placed and 125 excluded; its round 2 entry shares were 399/438 (91.1%) and 379/438 (86.5%), superseding 399/437 (91.3%) and 379/437 (86.7%). The later excluded-entry correction below supersedes those entry figures. The recorded source inventories, per-round condition-heading denominators and known acceptance shortfall are unchanged. No new derivation run was performed.

The finite iMessage section correction adds one current condition: an admitted group reply returns to the same native chat_id. All four preserved runs recorded the iMessage specifics heading as none, so neither historical condition credit nor either recorded heading denominator changes. The current inventory gains that condition-bearing heading; no new derivation or live iMessage observation is claimed.

The bounded implicit-mention and ambient-history correction adds 10 current conditions without new historical credit. Native producer and policy-consumer qualifiers remain on conditions 96–99; their supplied observations are outside or partial. Condition 170 keeps its recorded full room-event window meaning, while ordinary Telegram history selection after the last bot reply is recorded separately. All source headings in that correction were already condition-bearing, so its then-current 268 headings and historical 245/258 denominators did not change. No new derivation or runtime flow was added.

The thread-ownership observation is withdrawn because a supplied thread identifier does not establish missing native owner evidence; condition 62 remains inventoried and outside planned reach. The directly related conformance unknown-owner input is also removed. One current condition records private room-event assistant text being excluded from later history. Immediate quiet output 164 and the rolling room window 170 retain their separate meanings. All original discovery credit and historical heading denominators remain unchanged; no new derivation or runtime flow is claimed.

The finite bot-created-thread correction adds the omitted requireMentionInBotThreads state as one current condition. Confirmed ownership with no effective override preserves the ordinary mention requirement and implicit-reply facts; unknown ownership remains condition 62. Neither original pair explicitly recorded the omitted-setting branch, and no supplied recipe establishes it. No historical discovery credit, heading denominator or runtime flow changes.

The complete bounded location-document correction adds eight current conditions for omitted-source inference, numeric text formatting, optional prompt-field omission and Matrix geo_uri parameters. These meanings receive no historical discovery credit. Existing 181 is partial because the Telegram extractor does not supply location captions, and 184 is partial because no mixed-media input is supplied. Native message-tool location omission remains an observed result, distinct from other origins that reject mixed payloads. Current and recorded heading denominators are unchanged; no new derivation, input or runtime flow is added.

The finite Discord presence and bounded location-metadata correction adds 17 current conditions without historical discovery credit. The earlier reconnect-suppression and burst-limit qualifiers remain on condition 495 under its existing credit. The two unsupported human-arrival inputs are removed, while the separate bot set-presence action remains. Source headings in that correction were already condition-bearing, so its then-current 268 headings and historical denominators 245/258 did not change. The targeted native notification wake can run without a recurring heartbeat schedule; event queueing, wake handling and a visible greeting remain distinct outcomes.

Pairing capability reconciliation withdraws seven conformance-only recipes and five complete-condition credits because the supplied probe has no native pairing adapter. The five originally recorded Telegram cases remain. That pairing correction left its then-current condition inventory and per-round discovery measurements unchanged; current totals include the subsequent source reconciliation.

The finite excluded-entry correction applies the one-method, command, tool or callback rule to every excluded row. Named wizard, configuration, session-command, node-command, agent-binding, fixture-method and Discord voice entries are split. The recorded adapter-feature label yields its named WhatsApp login tool, Matrix verification command and Slack slash callback; generic component wording adds no extra control. The generic approval boundary and session-reaction wildcard are removed from the counted list while their ownership exclusions and source-file callers remain. Gateway-call method arguments, the update option and the already listed WebChat route do not add entries. Shell controls, emitted broadcasts and file-search records keep the procedure's stated granularity.

The first round already named each wizard and recorded configuration method individually. At that excluded-entry correction, its only denominator change was the source-confirmed config.set dependency, which neither run listed: 317/335 (94.6%) and 297/335 (88.7%). In the second round both runs explicitly named all three wizard methods, but only the first named config.get, config.schema and config.patch. The second run's generic reads-and-patches label earns no individual-method credit. Every other added discovery credit comes from an explicit name in its original combined record; unnamed families earn none. The source-only config.set entry received no credit in either round and added one entry to each source-completed denominator. The four confirmation controls below are a later addition.

That correction produced second-round counts of 413/456 (90.6%) and 383/456 (84.0%), with 351 entries named by both runs. Its then-current inventory had 456 entries: 313 placed and 143 excluded. Those figures superseded 317/334, 297/334, 399/438 and 379/438. Original record files remain unchanged; all earlier alias, test-file, Nostr control/HTTP and Advanced settings corrections are preserved. That correction left the condition and heading inventories and their discovery credit unchanged. No new derivation run or observation was performed, and the known entry-point shortfall remains.

The finite group-policy, inbound-policy and acknowledgement correction adds 19 current conditions without historical discovery credit. Recorded hidden-helper, pending-deadline, identity-emoji and acknowledgement-default alternatives remain on conditions 108, 311, 614 and 616 under their original credit and are now partial. Existing conditions 304 and 615 were already incomplete and receive no second deduction. All source headings were already condition-bearing. No new derivation, runtime input, helper or fixture is supplied.

This source reconciliation adds 23 distinct current conditions for history-window/compaction boundaries, provider shared-default precedence, progress settings/privacy/lifetime, native skill-menu settings and removal alternatives. They are source-only additions with no new historical discovery credit or executable inputs. Original meanings in 357, 358, 373, 445 and 470 are restored under their existing identities; 445 and 470 are partial where the existing inputs omit a recorded counterpart. No runtime flow, helper, fixture, capability, operation or entry point is added. Historical condition-heading denominators and recorded condition discovery credit remain unchanged. Moderation (Discord) becomes one additional current condition-bearing heading.

The four separately named controls are Setup wizard confirmation: Yes, Setup wizard confirmation: No, WhatsApp logout confirmation: Logout and WhatsApp logout confirmation: Cancel. None was individually named in the original four entry lists. Generic confirm-step fields and a logout card described as having confirmation keep their original credit but do not earn credit for these separate buttons. Each corrected round gains four source-only denominator entries, with no new discovery credit. These entries remain in their existing setup and logout operations. Existing positive WhatsApp confirmation retains its actual conditional availability; no new Cancel, Yes or No observation is supplied.

The combined reconciliation has 1054 conditions, 408 fully planned and 646 wholly or partly outside reach: 540 ambient and 514 event. The current heading inventory is 269; historical heading denominators 245/258 and the original 645-condition comparison with numerators 592/590 remain unchanged. Current source-only additions total 408 conditions. Separating the second final run’s explicit Teams/Mattermost record adds one more current condition with credit to that run only; supplemental meaning numerators are therefore 592/591. Final entry shares are 413/460 (89.8%) and 383/460 (83.3%), both below nine tenths; round 1 shares are 317/339 (93.5%) and 297/339 (87.6%). The current entry inventory is 460: 317 placed and 143 excluded. Supplemental condition shares are 592/1054 (56.2%) and 591/1054 (56.1%). Original raw records and the acceptance measurements are preserved. Unsupported recorded alternatives remain partial. No new derivation or template execution was performed.
