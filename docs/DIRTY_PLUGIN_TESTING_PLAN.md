# Dirty Plugin Testing Plan

Kova should validate OpenClaw against plugin states that look like real user
machines, not only clean fixture installs. Release updates often fail where
plugins are locally edited, partially installed, symlinked, stale, disabled, or
otherwise outside the happy path.

This plan adds dirty-plugin coverage that can run independently and also feed
the release update recovery scenario.

## Goal

Prove OpenClaw can inspect, update, repair, skip, or contain dirty plugin state
without breaking the gateway, corrupting user plugin files, drifting versions,
or trapping users in an unrepairable release.

The dirty-plugin matrix should answer:

- Does `plugins list` survive dirty plugin records?
- Does `plugins update --all --dry-run` report dirty plugins clearly?
- Does gateway startup skip or contain broken dirty plugins?
- Does `doctor --fix` avoid destructive rewrites of user plugin work?
- Does upgrade preserve dirty plugin files or create recoverable backups?
- Does rollback restore OpenClaw runtime state without losing plugin-local data?

## Dirty Plugin States

Add one state per dirty shape. Keep them small and composable so profile entries
can select the exact risk being tested.

### `dirty-plugin-local-edits`

An installed external plugin with local file edits after install.

Evidence:

- install record exists
- plugin files exist
- a dirty marker file or modified source file exists
- checksum before and after upgrade/doctor proves edits were preserved

Expected behavior:

- OpenClaw must not silently overwrite local edits.
- `plugins list` should remain usable.
- `doctor --fix` should preserve files or report that it refused destructive
  repair.

### `dirty-plugin-stale-deps`

An installed plugin with stale `node_modules`, runtime dependency metadata, or
lockfile data from an older runtime.

Evidence:

- stale dependency marker exists
- plugin dependency path exists
- plugin command output reports stale or missing dependency state

Expected behavior:

- Gateway remains usable.
- Dependency errors are reported against the plugin, not as generic startup
  failure.
- Update or doctor can restage safely, or clearly reports manual action.

### `dirty-plugin-manifest-drift`

Plugin manifest and package metadata disagree.

Examples:

- `manifest.json` id does not match package name
- manifest version differs from package version
- entry file points to a missing file

Expected behavior:

- Plugin command surfaces the mismatch.
- Gateway does not crash.
- Doctor output names the plugin and mismatch.

### `dirty-plugin-disabled-broken`

A disabled plugin has broken files or missing dependencies.

Expected behavior:

- Disabled plugin must not break gateway startup.
- `plugins list` should show disabled/broken state.
- Update and doctor should not enable or load it accidentally.

### `dirty-plugin-symlink-dev`

An installed plugin points at a symlinked local development directory.

Expected behavior:

- Update does not replace the symlink target.
- Doctor does not follow the symlink destructively.
- Plugin diagnostics include the resolved path or enough evidence to debug.

### `dirty-plugin-partial-install`

Plugin install record exists, but plugin files are missing or incomplete.

Expected behavior:

- `plugins list` reports the partial install.
- `doctor --fix` either removes/repairs the partial record safely or reports a
  clear unrepaired finding.
- Gateway health survives.

## Proposed Contracts

### Surface

Add `surfaces/dirty-plugin-state.json`.

Suggested requirements:

- `list-survives-dirty-state`
- `update-dry-run-reports-dirty-state`
- `doctor-preserves-user-files`
- `gateway-survives-dirty-plugin`
- `upgrade-preserves-dirty-plugin-data`

Suggested owner area: `plugins`.

Suggested process roles:

- `gateway`
- `command-tree`
- `plugin-cli`
- `doctor-cli`
- `runtime-management`

### States

Add state fixtures under `states/`:

- `dirty-plugin-local-edits.json`
- `dirty-plugin-stale-deps.json`
- `dirty-plugin-manifest-drift.json`
- `dirty-plugin-disabled-broken.json`
- `dirty-plugin-symlink-dev.json`
- `dirty-plugin-partial-install.json`

Each state should:

- mutate only disposable Kova envs
- write explicit marker/checksum evidence
- use local fixture plugins under `support/plugins/`
- avoid network installs unless a scenario explicitly tests network behavior
- declare cleanup guarantees through env destruction, not manual durable cleanup

### Scenarios

Add two scenario styles.

#### `dirty-plugin-state`

Focused plugin-state survival without an OpenClaw version upgrade.

Suggested phases:

1. `start`
   - Start a disposable env.
   - Apply the dirty plugin state after provision if needed.

2. `plugin-inspect`
   - Run `ocm @{env} -- plugins list`.
   - Run `ocm @{env} -- plugins update --all --dry-run`.

3. `doctor`
   - Run `ocm @{env} -- doctor --fix`.
   - Run `ocm @{env} -- status`.

4. `restart`
   - Restart gateway.
   - Capture logs.
   - Re-run `plugins list`.

5. `integrity`
   - Compare dirty plugin marker/checksum before and after doctor/restart.

#### `release-update-dirty-plugin-recovery`

Upgrade-focused dirty plugin lane. This can either be a standalone scenario or
an entry/state pairing for `release-update-recovery`.

Suggested phases:

1. `source`
   - Start source version/channel.
   - Install or write dirty plugin state.
   - Capture pre-upgrade checksums.

2. `upgrade`
   - Run `ocm upgrade {env} {upgradeSelector} --json`.

3. `post-upgrade-plugin-health`
   - Run `status`, `plugins list`, and `plugins update --all --dry-run`.

4. `doctor`
   - Run `doctor --fix`.
   - Verify dirty files are preserved or a backup is recorded.

5. `retry-and-rollback`
   - Verify update retry does not drift target version.
   - Verify rollback metadata and rollback behavior.

6. `integrity`
   - Compare plugin checksums before upgrade, after doctor, and after rollback.

## Metrics And Thresholds

Add metric ids only where existing metrics are insufficient.

Likely metrics:

- `dirtyPluginDetected`
- `dirtyPluginReported`
- `dirtyPluginChecksumPreserved`
- `dirtyPluginBackupCreated`
- `dirtyPluginUnexpectedlyEnabled`
- `pluginsUsableWithDirtyState`
- `doctorDestructiveChangeCount`
- `doctorUnrepairedFindingCount`
- `gatewaySurvivedDirtyPlugin`
- `rollbackPreservedPluginData`

Suggested thresholds:

```json
{
  "statusMs": 10000,
  "pluginsListMs": 15000,
  "pluginUpdateDryRunMs": 30000,
  "doctorFixMs": 60000,
  "dirtyPluginDetected": 1,
  "dirtyPluginReported": 1,
  "dirtyPluginChecksumPreserved": 1,
  "doctorDestructiveChangeCount": 0,
  "pluginsUsableWithDirtyState": 1,
  "gatewaySurvivedDirtyPlugin": 1
}
```

For states that intentionally model a broken plugin, allow plugin load failure
counts only when the gateway remains healthy and the report clearly attributes
the failure to the dirty plugin.

## Fixture Design

Create reusable local fixtures under `support/plugins/dirty/`.

Suggested fixture layout:

```text
support/plugins/dirty/
  local-edits/
  stale-deps/
  manifest-drift/
  disabled-broken/
  symlink-dev/
  partial-install/
```

Prefer deterministic marker files and checksums over fragile log-only evidence.

## Plugin Inspector Findings

The dirty fixtures should stay aligned with `openclaw/plugin-inspector`, because
that repo models the plugin author contract OpenClaw is expected to tolerate in
the wild.

Useful fixture seams from plugin-inspector:

- `openclaw.plugin.json`, not legacy ad hoc names, is the manifest file.
- Package metadata should include `openclaw.entrypoint` or
  `openclaw.entry`; missing entrypoints map to package-loader failures.
- Manifest `contracts` keys are compared against OpenClaw
  `PluginManifestContracts`; unknown contract keys are real compatibility
  evidence.
- Cold import readiness distinguishes missing build output, TypeScript loader
  requirements, missing dependencies, missing SDK aliases, and side-effect-prone
  top-level imports.
- Runtime capture watches SDK imports, `api.on(...)` hooks, and registrar calls
  such as `api.registerTool(...)`.

OpenClaw adds a few harness-critical constraints:

- Installed plugin directory scanners intentionally ignore dot dirs,
  `node_modules`, backup dirs, disabled dirs, and `.bak` paths.
- `doctor --fix` participates in plugin registry migration and update repair,
  so dirty states must preserve user-authored plugin files while still allowing
  repair metadata to change.
- Packaged bundled-plugin skill tests already treat `SKILL.md` symlink escapes
  as a meaningful failure class, so symlink fixtures should keep symlink targets
  inside the disposable env and verify the link itself is preserved.

The first executable dirty fixtures therefore use inspector-shaped metadata:

- `dirty-plugin-local-edits`: valid manifest, valid package entrypoint, SDK
  import, tool contract, and a user edit checksum.
- `dirty-plugin-stale-deps`: valid manifest plus stale `node_modules` evidence
  and runtime dependency metadata.
- `dirty-plugin-manifest-drift`: manifest/package id and version drift, unknown
  contract key, unknown top-level field, and missing package entrypoint.
- `dirty-plugin-disabled-broken`: disabled install record with broken manifest
  and runtime files; it must not be enabled or loaded accidentally.
- `dirty-plugin-symlink-dev`: installed path is a symlink to an in-env dev
  target; update and doctor must not replace the symlink or mutate the target.
- `dirty-plugin-partial-install`: install record exists while plugin files are
  missing.

Example marker evidence:

- `kova-dirty-plugin-marker.json`
- `kova-before.sha256`
- `kova-after-doctor.sha256`
- `kova-after-rollback.sha256`

Do not use real user plugin directories. Do not install from arbitrary remote
URLs in the default lane.

## Report Evidence

Reports should make dirty-plugin failures easy to hand off:

- plugin id
- dirty state id
- install record path
- plugin root path
- pre/post checksums
- whether doctor changed files
- whether a backup was created
- plugin command status and duration
- gateway health after plugin inspection, doctor, restart, upgrade, and
  rollback

## Profile Placement

Add focused dirty-plugin coverage to:

- `profiles/exhaustive.json`
- a future `profiles/dirty-plugins.json` if the lane grows

Add release-update dirty-plugin coverage to:

- `profiles/release.json` as warning coverage first
- `profiles/channel-upgrade.json` if it runs against published channels
- `profiles/local-build-upgrade.json` for release-shaped local builds

Promote only the most representative dirty-plugin lane to blocking release
coverage at first, likely `dirty-plugin-local-edits` or
`dirty-plugin-partial-install`.

## Acceptance Criteria

- Each dirty-plugin state has a dry-run plan and at least one executable
  scenario pairing.
- Dirty plugin fixture setup writes explicit evidence and checksums.
- `plugins list`, `plugins update --all --dry-run`, `doctor --fix`, restart,
  and logs are captured.
- Kova fails when OpenClaw corrupts local plugin files, silently enables disabled
  broken plugins, crashes the gateway, or hides plugin errors behind generic
  failures.
- Release-update dirty-plugin runs also fail on update retry version drift or
  rollback data loss.

## Implementation Order

1. Add `surfaces/dirty-plugin-state.json`.
2. Add fixture helpers under `support/plugins/dirty/`.
3. Add `dirty-plugin-local-edits` and `dirty-plugin-partial-install` states
   first.
4. Add `scenarios/dirty-plugin-state.json`.
5. Add evaluator/parser support for checksums, dirty detection, doctor changes,
   and plugin usability.
6. Add exhaustive profile entries.
7. Run dry-run and self-check.
8. Execute focused dirty-plugin runs against a known-good target.
9. Wire one dirty-plugin state into the release update recovery scenario.
10. Add remaining dirty states after the first two lanes produce useful reports.
