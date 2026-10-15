# Contract Registry

Kova models OpenClaw coverage with declarative contracts. Add a new OpenClaw
capability or user state by updating JSON first; change engine code only when
the new contract needs evidence that Kova cannot already collect.

## Add A Surface

Create `surfaces/<id>.json`.

Required fields:

- `id`: stable kebab-case surface id.
- `title`: short human name.
- `ownerArea`: OpenClaw subsystem likely to own failures.
- `description`: what OpenClaw behavior this surface proves.
- `purposes`: Kova purposes this surface is relevant to, such as `release`,
  `regression`, `diagnostic`, `performance`, `upgrade`, `plugin`, `provider`,
  or `soak`.
- `processRoles`: role ids from `process-roles/*.json`.
- `thresholds`: default pass/fail thresholds for the surface.
- `diagnostics`: source-build timeline expectations when available.
- `requirements`: stable requirement ids for this surface. Each requirement owns
  the states or state traits, target kinds, and metrics that prove that part of
  the surface contract.

If a surface or scenario sets `postReadyHealthP95Ms`, Kova also derives zero
budgets for `postReadyHealthFailures` and `finalHealthFailures` unless those
failure thresholds are explicitly configured. This keeps health-latency
contracts from passing when the probes are fast only because they failed.

Then:

1. Add or update one scenario in `scenarios/*.json` with `"surface": "<id>"`
   and `proves` entries for the requirement ids it exercises.
2. Add missing metric ids to `metrics/known.json`.
3. Add state fixture hooks or traits in `states/*.json` only when the
   requirement needs a new user condition.
4. Add profile requirement coverage in `profiles/*.json` only when the surface
   requirement should be part of that profile.
5. Run `node bin/kova.mjs plan --json`.
6. Run a dry-run for the scenario.
7. Add self-check coverage if the surface introduces new evidence parsing.

Do not add a surface for an implementation detail. A surface should represent a
real OpenClaw workflow a user or release gate cares about.

## Phase Measurement Scope

Scenario and state lifecycle phases may set `measurementScope` to `product`,
`harness`, or `cleanup`. Resource gates use only `product` phases. Source
acquisition, cloning, stable-source startup, provisioning, auth, fixture setup,
and target-build phases are harness work. Candidate upgrades, post-upgrade
validation, and gateway user turns are product work. Framework cleanup is
recorded as cleanup work rather than product measurement.

Scope belongs to the prepared phase because command resource samples and
post-phase process snapshots share one owner. Command results cannot override
their phase's scope. Product resource headlines use the versioned identity
`primary-role-product-scope-v3`, which keeps process-specific roles disjoint,
tracks owned harness processes by validated PID, and avoids duplicate
primary-role threshold findings.

## Add A State

Create `states/<id>.json`.

Required fields:

- `id`: stable kebab-case state id.
- `title`: short human name.
- `objective`: what user history or degraded condition this state models.
- `traits`: known traits validated by Kova.
- `riskArea`: what can break when this state is used.
- `ownerArea`: OpenClaw subsystem most likely to own state-specific failures.
- `setupEvidence`: what proves setup happened.
- `cleanupGuarantees`: what Kova must clean or destroy after execution.

Lifecycle command phases are optional. If a state needs setup, keep commands
inside disposable Kova envs and make the evidence explicit. Existing user state
must be represented through clone/import metadata, not direct mutation of a
durable env.

Scenario phases and state lifecycle steps may set `collectionIntent` to one of
`full`, `post-ready-health`, `service-only`, or `skip-env`. Omit it unless the
phase has a narrower proof contract than full env collection. Kova defaults to
`full`, and failed phases use full collection even when they requested a narrower
intent.

Put positive state compatibility on surface requirements through `states` or
`stateTraits`. Add `incompatibleSurfaces` only for hard safety blocks where a
fixture must never run against a surface; do not store empty compatibility
lists.

Then:

1. Pair the state with compatible scenarios or profile entries.
2. Add or update surface requirements when this state becomes required proof
   for a surface.
3. Run `node bin/kova.mjs plan --json`.
4. Dry-run at least one scenario/state pair.
5. Execute a disposable scenario when the state lifecycle mutates files,
   services, plugins, or runtimes.

## Validation Rules

Self-check and plan validation must fail for:

- unknown surface, state, process role, metric, or profile references
- unknown purpose references
- scenarios that prove unknown surface requirements
- surface requirements that reference unknown states, traits, target kinds, or
  metrics
- invalid state traits
- malformed lifecycle phases
- scenario/state pairs that violate requirement state contracts or hard
  incompatibility blocks
- profile entries that require unknown surfaces or states
- profile gate coverage that uses derived policy fields instead of
  `requirements` or `platforms`

If a new surface or state needs exceptions to these rules, the contract is too
loose. Tighten the JSON or add a focused validator.

## Command Catalogue Entries

`catalogue/<product>.json` uses `schema: "kova.verify.catalogue.v1"`, a product
name, the inspected product `revision` and an `entries` array. Each entry has
exactly `id`, `kind`, `wraps`, `command`, `flags`, `prints`, `creates`, `side`,
`background` and `status`; the [catalogue contract](verify/catalogue.md)
defines their meanings. Duplicate ids, command heads and wrapped operations
are rejected.

Every `flags` value has exactly `description` and `value`, for example
`"--json": { "description": "print JSON", "value": "none" }` or
`"--timeout": { "description": "milliseconds", "value": "required" }`.
`value` is `none`, `required` or `optional`. Command forms spell optional and
variadic positionals explicitly, as `[<path>]`, `<keys...>` or `[<keys...>]`.
Product environment arguments are `@{env}` or `@{persona:<trait>:env}`; each
refers to its own clone for the run, including persona-provided environments.

`creates` is an array of JSON pointers into command output, with `*` for array
indices, naming generated resource ids. Use an empty array when no such id is
reported. Do not declare caller-supplied ids, existing resource ids, or secrets.
A method that can return either a new or existing id cannot express that
condition through an unconditional pointer; leave it undeclared rather than
hide a meaningful difference. Such varying addresses remain visible through
the comparison's undeclared-id reporting.

Each Gateway method has its own entry, including its literal `--method` value
in the command head. Its status remains `toWrite` until the generic caller
exists. Product forms and flags must match OpenClaw's help at the recorded
revision; the catalogue is not permission to invent missing product commands.
Run `kova catalogue check --product <product> --templates <dir> --personas <dir>`
when editing definitions. A nonzero result for `toWrite` records pending work
and must not be suppressed to make an unfinished template appear executable.

## Persona definition and manifest

`personas/<name>.json` uses `schema: "kova.verify.persona.v1"`, an id, title,
objective, pinned runtime, credential names and an array of traits. Each trait
declares content, key descriptions, dependencies in `needs`, builder commands and
one read check. Commands must resolve to implemented catalogue entries. Builds
reject missing dependencies, cycles and undeclared key references before creating
an environment. The initial definition has five foundation traits and no credentials.

`kova persona build` writes `persona.json` with
`schema: "kova.verify.persona-manifest.v1"`, persona id, UTC build version, runtime
selector and exact version with npm integrity, definition path and SHA-256,
durable environment name and source `root`, export path, `includeState: true` and SHA-256, Doctor
output, and a trait map whose entries contain `keys` and `checkedAt`. Keys are strings restricted to
letters, digits and `.`, `_`, `-`, `:`, `/`, `@`.

The export and definition hashes must match before verification imports a copy.
Every check runs against that copy and cleanup destroys it even when a check fails.
Builds publish the manifest only after all build checks and an import check pass.
The durable environment remains protected; exports are private artifacts and are
excluded from Git. See [Persona](verify/persona.md) for the full forms.

Persona support operations have individual catalogue entries with fixed success
fields. Their failures print `{ "error": { "code": "product|usage|timeout",
"message": "..." } }` on stdout, with exit 1, 2 or 3 respectively.
New persona manifests record `runtime.ocm` with the selected executable path,
reported version and binary SHA-256, plus a commit when that executable reports
one. `show` prints the saved record; it does not verify the current executable.

## Verification Plan Data

`verify/standard.json` defines the ignore globs, comparison declarations and
standard before/after phases. `verify/areas/*.json` defines path ownership;
`verify/templates/<area>/template.json` supplies phases in the
[template form](verify/derive-area-template.md#template-form). Selection uses
each phase's paths, including paths outside the template's area.

`kova verify plan` writes `schema: "kova.verify.plan.v1"`: exact change commits
and paths, intent lines and expected differences, persona identity and manifest
hash, ordered phases with source labels, their canonical JSON hash, and the
`withheld`, `unmapped` and `ignored` lists. Persona environment keys stay
symbolic for cloning. Each run file has one producing phase. The catalogue
checks the written commands before persona substitution; unfinished entries
withhold phases and other findings refuse the output. See the
[plan form](verify/plan-and-verdict.md#plan-form) for the complete contract.

## Verification Runs And Checkpoints

`kova verify run` writes `schema: "kova.verify.run.v1"` with its id, the saved
plan's path and SHA-256, Kova and OCM identities, both target selectors/commits/
versions, and five `clones`: `baseline`, `change-1`, `change-2`, `noise-1` and
`noise-2`. Each copy records `started`, `cached`, and a map from qualified phase
id to `recorded` or `no checkpoint`. `incomplete`, `notStarted`, errors and
`cleanupErrors` retain execution failures. No comparison verdict is inferred.

Each recorded phase has `commands.json`, an array in command order with
`command`, `exit`, `stdout`, `stderr`, `durationMs` and `timedOut`. JSON stdout is
stored by command index in `responses.json`; the corresponding command stdout
is null. Requested signals add incremental `logs.txt`, `timing.json`
(`durationMs`, `reachedBound`), selected files under `state/`, `doctor.json`, and
`screen.png`. Doctor output is an array in command order, preserving JSON or
text when the command fails to print JSON. Screenshots must be PNG files under
the copy's output directory. A checkpoint is published only when every requested
capture succeeds; partial directories are discarded.

The Gateway caller removes public-sharing bearer tokens from sharing and
membership responses before stdout, output files and background records are
written. Sharing metadata remains observable. File-content responses apply the
same known-file credential policy as state capture, using requested and resolved
file identities. Original product hashes remain available for conditional writes;
recorded content is filtered and must not be treated as an unmodified config copy.
Native attachment grants are also filtered from command output before retention;
malformed or truncated grant output makes the phase incomplete. Frozen config
patches and attachment temporary files stay inside the disposable environment,
are excluded from observations and are removed with the environment. Valid
Gateway credential references remain metadata and are never resolved for capture.

SQLite files are copied through the read-only online backup API and the copies
use standalone journals. A temporary private export inside the disposable
environment is stripped of known generated pairing and installation secrets, then
rebuilt without deleted pages before being saved as evidence. Non-secret rows and
metadata are preserved. Credential-valued bootstrap keys become stable SHA-256
fingerprints prefixed with `redacted:`; secret BLOBs keep their shape as zero bytes.
Retired device identity, authentication and pairing JSON files use the same targeted
redaction. OpenClaw JSON/JSON5 configuration, its backups and temporary configuration writes omit Gateway token/password literals and `hooks.token`
while preserving the remaining configuration. Malformed known secret stores fail capture instead of being copied raw. Older unfiltered caches are not reused. WAL, shared-memory and rollback-journal side files are not independent
state signals, including when explicitly selected. The standard final snapshot
uses this recorder and environment metadata, without creating an OCM snapshot.
Explicit OCM snapshots and snapshot-producing upgrades are refused before dispatch.
Execution requires native OCM; import/export temporary files stay in owned private
export directories and are removed after the operation.
`initial-state/` records selected state before the first phase,
so ids from the persona remain distinguishable from newly generated ids. The
saved `standard.json` retains `stateIds` and `compressed` declarations and
`catalogue.json` retains command `creates` declarations for comparison.

See the [run and checkpoint forms](verify/plan-and-verdict.md#running-the-plan).
