# Session condition derivation

These phases refine the known-break mappings in [the sessions derivation](../sessions/derivation.md). No new model derivation or historical coverage percentage is claimed.

| Historical mapping | Phase | Established condition |
| --- | --- | --- |
| 167163 | event-concurrent-search-and-card-save | Preconnected searches overlap a card save and chat write. |
| 167029 | search-completeness | Stable matches are observed across repeated scoped and concurrent searches. |
| 165600 | incognito-send-admission | Creation and first send share the live Incognito connection. |
| 163821 | event-placement-reconcile | Live and absent Incognito placements coexist with an invalid ordinary locator. |
| 164989 | event-worker-cancel-followup | A real paired worker executes an ordinary turn, cancellation and first follow-up. |
| 162560 | event-frame-paused-send | Animation frames stop before an accepted active send is observed. |
| 163030 | event-cold-fork-admission | A non-admin caller forks cold history before a warm retry. |
| 160126 | event-dismiss-unfinished-card | Unfinished and note-only cards are dismissed and read back. |
| 146713 | event-memory-rollback-search | Ordinary search sees newer retained index provenance and counted local embeddings. |

The conditions have separate output files and no cross-condition mutable fixture dependency. The cold fork observes the first restoration before the broad sessions administrative fork. Generated resources and file fixtures are cleaned through their owning operation or the disposable clone; process and Gateway restoration time is reserved inside the command deadline.
