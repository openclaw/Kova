# Dirty Plugin Coverage

Dirty-plugin validation is implemented by the
[dirty-plugin-state scenario](../scenarios/dirty-plugin-state.json) and
[matching surface](../surfaces/dirty-plugin-state.json). It starts a disposable
environment, applies synthetic plugin state, runs plugin inspection and doctor
repair, restarts the gateway, and verifies the resulting integrity evidence.

## Supported states

- [Local edits](../states/dirty-plugin-local-edits.json): an installed plugin with a checksum-protected user edit.
- [Stale dependencies](../states/dirty-plugin-stale-deps.json): stale dependency metadata or files.
- [Manifest drift](../states/dirty-plugin-manifest-drift.json): inconsistent plugin metadata.
- [Disabled broken plugin](../states/dirty-plugin-disabled-broken.json): broken files on a disabled plugin.
- [Development symlink](../states/dirty-plugin-symlink-dev.json): a plugin linked to a disposable development tree.
- [Partial installation](../states/dirty-plugin-partial-install.json): an incomplete plugin installation.

The [release profile](../profiles/release.json) selects local edits; the
[exhaustive profile](../profiles/exhaustive.json) selects all six states. Read
those profiles for current gate policy rather than treating the original
proposal's rollout order as a pending checklist.

## Ownership and evidence

[support/dirty-plugin-state.mjs](../support/dirty-plugin-state.mjs) prepares and
verifies fixtures inside the selected disposable environment. State lifecycle
steps define when preparation and verification occur. OpenClaw's actual plugin,
doctor, restart, and status commands provide product evidence.

The checks distinguish detecting or reporting dirty state from preserving it.
A command exit alone cannot prove that local edits or symlink targets survived.
The surface defines required metrics for reporting, checksums, destructive
changes, plugin usability, and gateway survival; the
[report schema](REPORT_SCHEMA.md) describes their representation.

Upgrade and rollback coverage belongs to
[release update recovery](RELEASE_UPDATE_RECOVERY_PLAN.md), which composes plugin
pressure with a source-to-target upgrade and rollback. Durable user environments
remain clone sources, never direct fixture targets.

Preview with `kova run --target runtime:stable --scenario dirty-plugin-state --state dirty-plugin-local-edits --json`.
See [Agent Usage](AGENT_USAGE.md) before adding `--execute`.
