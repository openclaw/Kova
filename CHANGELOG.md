# Changelog

All notable changes to Kova are documented in this file.

## [Unreleased]

### Fixed

- Hardened performance baseline persistence, unstable-group detection, and repeated-work audit isolation.
- Fixed web reports to reset matrix deltas across missing samples, preserve scenario breach status, render blocked OG verdicts safely, revalidate mutable OG images, and normalize rounded minute durations.
- Made matrix gates honor scenario-wide policies and validate all seven coverage dimensions only from records that actually executed.
- Stopped parallel matrix workers from scheduling new scenarios after a rejection, drained active workers before rethrowing, and made lifecycle command indexes phase-wide to prevent artifact overwrites.
- Fixed web release projections to select same-day priors numerically, match headline deltas by scenario, metric, and unit, label comparisons with the measured metric, and median-aggregate repeated turn measurements.
- Hardened release validation against missing, malformed, misplaced, partial, or incomplete provider, health, snapshot, plugin-security, command-timing, and measurement evidence.
