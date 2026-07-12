# Changelog

All notable changes to Kova are documented in this file.

## [Unreleased]

### Fixed

- Fixed OpenClaw inventory discovery to recognize canonical JSON5 plugin manifests consistently across platforms while deterministically bounding scans.
- Isolated concurrent self-check OCM identities, child environments, runtime names, and temp cleanup ownership.
- Hardened performance baseline persistence, unstable-group detection, and repeated-work audit isolation.
- Fixed web reports to reset matrix deltas across missing samples, preserve scenario breach status, render blocked OG verdicts safely, revalidate mutable OG images, and normalize rounded minute durations.
- Made matrix gates honor scenario-wide policies and validate all seven coverage dimensions only from records that actually executed.
- Stopped parallel matrix workers from scheduling new scenarios after a rejection, drained active workers before rethrowing, and made lifecycle command indexes phase-wide to prevent artifact overwrites.
- Fixed web release projections to select same-day priors numerically, match headline deltas by scenario, metric, and unit, label comparisons with the measured metric, and median-aggregate repeated turn measurements.
- Hardened release validation against missing, malformed, misplaced, partial, or incomplete provider, health, snapshot, plugin-security, command-timing, and measurement evidence.
- Hardened runtime teardown with collision-resistant local-build names, exact OCM missing-resource matching, awaited proxy shutdown, and independent cleanup stages.
- Centralized disposable environment cleanup in Kova's lifecycle and removed stale scenario cleanup commands and unused raw selector substitutions.
- Hardened registry and evaluation integrity for capability catalogs, workflow derivation, thresholds, and malformed harness evidence.
