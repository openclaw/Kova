# Release Update Recovery

The [release-update-recovery scenario](../scenarios/release-update-recovery.json)
implements the original recovery proposal. It uses the
[update-recovery-plugin-user state](../states/update-recovery-plugin-user.json)
in a disposable environment and appears in the
[release](../profiles/release.json) and [exhaustive](../profiles/exhaustive.json)
profiles.

## Sequence

1. Start a stable source environment and capture its version, status, plugins, and service state.
2. Apply plugin-pressure state and upgrade with the requested target selector.
3. Check status, plugin listing, and plugin update dry-run behavior.
4. Run [structured doctor repair](../support/run-doctor-repair.mjs) and check status again.
5. Retry the same upgrade selector and capture the resulting version.
6. [Restore the first upgrade snapshot](../support/restore-first-ocm-upgrade-snapshot.mjs), then check status, plugins, and logs.

The [surface contract](../surfaces/release-update-recovery.json) defines the
required evidence and thresholds for plugin usability, doctor outcomes, target
stability, rollback availability/success, and preservation of plugin data.
Scenario and profile overrides remain authoritative; this document does not
introduce a separate set of numeric gates.

## Interpreting results

Inspect selected versions, doctor findings, rollback evidence, and post-rollback
health in the JSON report. A successful OCM command alone is insufficient proof
of OpenClaw recovery. Once OpenClaw runs, broken plugin, doctor, update, or rollback
behavior is product evidence; inability to provision the lab is a harness blocker.

The scenario and profile definitions replace the original proposal's
implementation and rollout checklist. Future changes to target-selection or
rollback requirements must update the surface, scenario, evaluator, and tests
together. Do not infer support for a different rollback mechanism from this
snapshot-based scenario.

Preview with `kova run --target runtime:stable --scenario release-update-recovery --json`.
Follow [Agent Usage](AGENT_USAGE.md) before adding `--execute`. Durable user
environments must be cloned before upgrade or migration testing.
