# Changelog

All notable changes to Kova are documented in this file.

## [Unreleased]

### Fixed

- Made terminal reports width-safe for Unicode, narrow layouts, wrapped shell hints, duration rollover, and strict numeric samples.
- Hardened command execution with bounded streaming redaction, POSIX process-group cleanup, strict optional-log matching, and direct scenario command validation.
- Hardened artifact confidentiality by redacting credential-bearing logs before persistence and containing OpenClaw state collection against symlink escapes and hostile filesystem inputs.
- Hardened mock-provider and diagnostic process handling to reject non-decimal PID state, migrate active legacy providers safely, reject stale startup metadata, avoid signaling unrelated processes, retain retryable PID state, and preserve colliding diagnostic artifacts.
- Fixed OpenClaw inventory discovery to recognize canonical JSON5 plugin manifests consistently across platforms while deterministically bounding scans.
- Isolated concurrent self-check OCM identities, child environments, runtime names, and temp cleanup ownership.
- Escape runtime-derived Markdown and paste fields without changing JSON report data.
- Keep RSS and CPU role peaks independently attributed to their actual scenarios.
- Hardened performance baseline persistence, unstable-group detection, and repeated-work audit isolation.
- Fixed web reports to reset matrix deltas across missing samples, preserve scenario breach status, render blocked OG verdicts safely, revalidate mutable OG images, and normalize rounded minute durations.
- Made matrix gates honor scenario-wide policies and validate all seven coverage dimensions only from records that actually executed.
- Stopped parallel matrix workers from scheduling new scenarios after a rejection, drained active workers before rethrowing, and made lifecycle command indexes phase-wide to prevent artifact overwrites.
- Fixed web release projections to select same-day priors numerically, match headline deltas by scenario, metric, and unit, label comparisons with the measured metric, and median-aggregate repeated turn measurements.
- Fixed report status precedence, repeated-sample diagnostics, finding identity, worst-case metrics, confidence labels, blocked outcomes, and rendered CLI guidance.
- Hardened release validation against missing, malformed, misplaced, partial, or incomplete provider, health, snapshot, plugin-security, command-timing, and measurement evidence.
- Hardened release publishing and run evidence contracts so invalid payloads are rejected and missing final metrics cannot be reported as healthy.
- Hardened runtime teardown with collision-resistant local-build names, exact OCM missing-resource matching, awaited proxy shutdown, and independent cleanup stages.
- Centralized disposable environment cleanup in Kova's lifecycle and removed stale scenario cleanup commands and unused raw selector substitutions.
- Hardened registry and evaluation integrity for capability catalogs, workflow derivation, thresholds, and malformed harness evidence.
- Fixed credential setup to validate provider/CLI pairings and recover concurrent or interrupted updates through a durable transaction journal and cross-process lock.
- Replaced external CLI credential-file guessing with native Codex and Claude authentication status checks.
- Hardened interactive setup with no-echo secret input, JSON-clean stdout, terminal-state restoration, and real directory write probes.
- Hardened CLI option and error contracts, release versioning and provenance checks, release archive packaging, pinned CI dependencies, and Crabbox hydration state.
- Hardened collector evidence integrity across profiles, provider attribution, process sampling, diagnostics, timelines, state fixtures, redaction, and artifact retention.
- Made report, portable USTAR bundle, retained-artifact, and baseline publication concurrency-safe, rollback-aware, crash-cleaning, and fail-closed on incomplete evidence.
- Kept installed release self-checks independent of source-only test fixtures.
- Made cleanup skip active, retained, recent, and unknown-state environments by default, finalized local runtimes after failures, and made failed comparisons exit non-zero in every output format.
