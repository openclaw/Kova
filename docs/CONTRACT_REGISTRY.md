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
