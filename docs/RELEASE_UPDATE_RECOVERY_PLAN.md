# Release Update Recovery Plan

Kova should catch release breaks where an OpenClaw update succeeds far enough
to mutate a user env, then leaves plugins, doctor repair, update retry, or
rollback in a bad state.

This plan models the failure chain reported by a real user:

```text
release update -> plugins fail -> doctor --fix fails -> update again selects
the wrong version -> rollback is unavailable or does not work
```

## Goal

Add a release-gate scenario that proves OpenClaw can recover from a problematic
update path without trapping the user on a broken runtime.

The scenario should answer:

- Did the update choose the requested target version or channel?
- Does OpenClaw remain usable after plugin load/update failures?
- Does `doctor --fix` repair or clearly report unrepaired state?
- Does a second update retry preserve the intended target instead of jumping to
  an unintended version?
- Is rollback metadata present, and can rollback be executed on a disposable
  clone when the update path fails?

## Non-Goals

- Do not mutate a durable user env.
- Do not depend on a user's live plugin secrets, accounts, or external services.
- Do not treat OCM success alone as proof that OpenClaw update recovery works.
- Do not hide OpenClaw failures as harness blockers when the env starts and
  OpenClaw commands fail.

## Current Coverage

Kova already covers related pieces:

- `upgrade-stable-channel-to-beta`: real stable-channel to beta upgrade.
- `upgrade-existing-user`: cloned existing-user upgrade with `plugins list` and
  `doctor --fix`.
- `plugin-missing-runtime-deps`: bad plugin dependency survival.
- `failed-upgrade`: synthetic failed-upgrade residue.

The missing coverage is the full sequence: upgrade, plugin failure, doctor
repair, update retry target stability, rollback availability, and post-rollback
health in one release-shaped scenario.

## Proposed Contracts

### Surface

Add `surfaces/release-update-recovery.json`.

Suggested requirements:

- `plugin-failure-recovery`: update target survives plugin/runtime dependency
  failures and gateway remains usable.
- `doctor-repair-contract`: `doctor --fix` exits successfully when repairable,
  or reports clear unrepaired findings without corrupting state.
- `update-retry-target-stability`: rerunning update does not select an
  unintended version or channel.
- `rollback-available`: rollback metadata is present after upgrade, and
  rollback works on the disposable env.

Suggested owner area: `upgrade`.

Suggested process roles:

- `gateway`
- `command-tree`
- `runtime-management`
- `plugin-cli`
- `doctor-cli`

### State

Add `states/update-recovery-plugin-user.json`.

This state should model a realistic existing user with plugin pressure:

- existing plugin install index
- at least one bundled plugin enabled
- at least one external/local plugin fixture
- optional stale or missing runtime dependency marker
- source release/channel marker

The state must only write into the disposable Kova env after clone/start. It
must not read or mutate durable user envs except through the existing
`ocm env clone {sourceEnv} {env}` flow for existing-user scenarios.

### Scenario

Add `scenarios/release-update-recovery.json`.

Suggested phases:

1. `source`
   - Start or clone a disposable source env on a pinned source version/channel.
   - Capture pre-update `openclaw --version`, `status`, `plugins list`, and
     service status.

2. `upgrade`
   - Run the real update path through OCM:
     `ocm upgrade {env} {upgradeSelector} --json`.
   - Capture selected target version/channel and snapshot id.

3. `plugin-health`
   - Run `ocm @{env} -- plugins list`.
   - Run `ocm @{env} -- plugins update --all --dry-run`.
   - Capture logs and plugin dependency diagnostics.

4. `doctor-repair`
   - Run `ocm @{env} -- doctor --fix`.
   - Require either a successful repair or structured diagnostics that explain
     what remains unrepaired.
   - Verify `status` still works afterward.

5. `update-retry`
   - Run the update command again against the same target selector.
   - Assert the resolved version/channel is unchanged and does not drift to an
     unintended release.

6. `rollback`
   - Inspect rollback/snapshot metadata.
   - Execute rollback on the disposable env if the target supports it.
   - Verify `status`, `plugins list`, and gateway health after rollback.

7. `logs`
   - Capture bounded logs for upgrade, plugin, doctor, retry, and rollback
     evidence.

## Metrics And Thresholds

Add metric ids only if existing evidence cannot express the result.

Likely needed metrics:

- `upgradeSelectedVersionMatchesTarget`
- `updateRetryVersionDrift`
- `rollbackAvailable`
- `rollbackSucceeded`
- `doctorFixSucceeded`
- `doctorUnrepairedFindingCount`
- `pluginsUsableAfterUpgrade`
- `pluginsUsableAfterRollback`

Suggested thresholds:

```json
{
  "upgradeMs": 180000,
  "statusMs": 10000,
  "pluginsListMs": 15000,
  "doctorFixMs": 60000,
  "updateRetryVersionDrift": 0,
  "rollbackAvailable": 1,
  "rollbackSucceeded": 1,
  "pluginsUsableAfterUpgrade": 1,
  "pluginsUsableAfterRollback": 1,
  "pluginLoadFailures": 0
}
```

For a deliberate bad-plugin fixture lane, the plugin failure threshold can be
nonzero, but the scenario must still require gateway survival, clear doctor
output, no target drift, and rollback availability.

## Harness Work

Kova may need a small support parser for OCM/OpenClaw update evidence:

- parse selected target version/channel from `ocm upgrade --json`
- parse current OpenClaw version after update and retry
- parse rollback/snapshot identifiers
- classify doctor output as repaired, unrepaired, or failed-to-run
- record whether plugin commands remained usable

Keep this parser in `support/` or evaluator code depending on whether the data
is produced by a scenario helper or collected from generic phase output.

## Profile Placement

Add the scenario to:

- `profiles/exhaustive.json` as full-spread coverage.
- `profiles/release.json` as warning coverage first.
- `profiles/channel-upgrade.json` if the target lane is channel-specific.
- `profiles/local-build-upgrade.json` if the target lane is a release-shaped
  local build.

Promote to blocking release-gate coverage after it passes consistently on a
reviewed-good release.

## Acceptance Criteria

- A dry-run plan selects the new scenario and resolves coverage without gaps.
- A real run uses only disposable Kova envs.
- The report clearly identifies:
  - source version/channel
  - requested target version/channel
  - actual post-update version/channel
  - actual post-retry version/channel
  - plugin command outcome
  - doctor repair outcome
  - rollback availability and outcome
- A version drift such as retrying into `2026.5.12` when that was not the
  requested target fails the scenario.
- A broken plugin state that prevents `status`, `plugins list`, or rollback from
  working fails as OpenClaw behavior, not as an OCM provisioning blocker.

## Implementation Order

1. Add the surface contract and metrics.
2. Add the disposable plugin-pressure state.
3. Add a dry-run-only scenario skeleton.
4. Add parser/evaluator support for selected version, retry drift, doctor
   outcome, and rollback outcome.
5. Add the scenario to exhaustive only.
6. Run dry-run and self-check.
7. Execute against a pinned known-good source and a candidate target.
8. Add to release/channel/local-build profiles as warning coverage.
9. Promote to blocking gate coverage after stable evidence.
