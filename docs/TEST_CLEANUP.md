# Test cleanup ledger

Scope: tests, self-checks, fixtures, scenario mappings, and validation gaps.
Land independent changes through narrow PRs. No releases.

| Area | Finding / action | Validation |
| --- | --- | --- |
| Gateway readiness | Replace liveness-based startup admission with `/readyz` and require JSON `ready: true`; keep post-ready liveness sampling. | Eight regression cases pass (all fail on old code). Full suite passes on AWS Crabbox `cbx_338dda870936`. Published OpenClaw `2026.10.10` cold/warm turns return exact `KOVA_AGENT_OK` with matching run IDs in 3318/635 ms; env destroyed, inventory empty. Run `run_3ba734eea3171313a943cc46e35ba96f` still fails unchanged RSS/CPU gates (2083.2 MB / 677.1%). |
| Snapshot runner | Default and full comparison snapshots were byte-identical. Share one baseline while retaining both CLI executions. | 21/21 snapshots passed on AWS Crabbox `cbx_369e11f57fb3`. |
| Snapshot runner | Missing baselines were silently created; update mode ignored command failures, and comparison cases accepted any exit status. Require the expected status, fail missing baselines and command errors, and remove temporary test homes on exit. | AWS Crabbox `cbx_369e11f57fb3`: missing-baseline and update-command-failure probes passed; temporary homes absent after all three runs. |
| Fixtures | All five `fixtures/` files and three `tests/fixtures/` data files have consumers. Retain them. | Traced tracked-file references; no unused data fixture found. |
| Proxy log tests | Remove Node-only uncaught-error demonstration, redundant export/listener checks, and duplicated source-text assertions. Retain real proxy error/drain/shutdown coverage; wait for stream closure instead of fixed sleeps. | Proxy log-stream checks and partial-startup cleanup self-check passed on AWS Crabbox `cbx_e3399467eba5`. |
| Repeated-work audit | Remove the always-empty receipt-lock field and assertions that only confirmed that constant. Check duplicate command attribution, phase reuse, evidence selection, and profile collection counts with a small synthetic registry. | Targeted self-check passed on AWS Crabbox `cbx_32d1c2afed20`. |
| Plan JSON snapshot | Remove the 21,234-line full-catalog golden file and duplicate CLI invocation. Retain the semantic `plan-json` self-check, registry validation, human plan rendering, and matrix JSON snapshots. | AWS Crabbox `cbx_cf1dd03b98e0`: 20/20 remaining snapshots and JSON plan contract checks passed. |
| Real fresh install | Run published OpenClaw `2026.10.10` on Node 24.22.1 through OCM 0.2.48. All scenario commands succeeded; resource gates correctly failed (gateway RSS 1657.5 MB vs 1177 MB, CPU 611.2% vs 250%). Keep thresholds. | AWS Crabbox `cbx_0b718ef22b1f`, run `run_39fe02e88ff5465926ef53a531a3aebb`; disposable env destroyed, inventory empty. |
| Gateway startup readiness | Two scenario runs reached `connect UNAVAILABLE: gateway starting; retry shortly` before an agent turn. The same probe against the retained env subsequently returned exact `KOVA_AGENT_OK` in 3066 ms with matching run IDs. Investigate readiness detection (`/health` is currently used) before adding retries. | AWS Crabbox `cbx_0b718ef22b1f`, reproduction `run_347799ca3bce9327eb6e2a635f06eeac`; retained test env destroyed, inventory empty. |
| Negative CLI checks | Require the CLI's expected error exit (1), successful completion, and the expected diagnostic. A crash or unrelated exit must not pass after printing that diagnostic. | Self-check isolation suite and eight subprocess regression cases pass on AWS Crabbox `cbx_338dda870936`; both old helpers incorrectly accepted exit 2. |
| Cleanup lifecycle | Replace three source-order regexes and a literal protection-command assertion with executed startup/teardown failure cases. Keep bind-failure and shutdown checks. | AWS Crabbox `cbx_dbbdf042c42e`: transport suite and cleanup self-check pass; all three targeted ordering mutations fail the intended behavioral assertion (`run_2af0496f6cb521e3eadf7fb5dd317b8f`). |
| Concurrent agent runner | Replace the always-successful mock with a two-turn rendezvous and mixed failures. Verify exact response text, command/session identity, exit/signal receipts, and complete aggregation. | AWS Crabbox `cbx_ba2a2f963084`: five cases pass. Old check accepts all four mutations (serial execution, substring matching, ignored exit errors, dropped receipts); revised check rejects each, and restored code passes (`run_0a77d444d30bda394e95d9d506ed4c1f`). |
| Soak helper health verdict | Health failures were recorded in JSON but ignored by the helper's exit status. Include health failures in the verdict and replace the success-only mock with eight command/service/HTTP cases, retaining full receipts and frontage routing checks. | AWS Crabbox `cbx_248f6b86b45f`: old exit rule fails the HTTP 503 regression; fixed helper passes all eight cases and existing soak evaluation check (`run_bdb2a9054ece4a23770bc9de8a5644f0`). |
| Required soak evidence | Missing measurements skipped configured gates, and missing failure counts became zero. Reuse required gates and keep incomplete/invalid aggregates unknown, including a malformed receipt beside a valid one. | AWS Crabbox `cbx_033c3e684c36`: expanded evaluation check passes valid, absent, malformed, mixed, aggregation, and threshold controls. All four gate/collector mutations fail the intended assertion; restored code passes (`run_81b60f5e6db22bd92314b31f34c680cc`). |

Audit coverage: references and entry points for all 41 original test modules,
59 self-check modules, data fixtures, snapshots, scenario/profile mappings,
and both website test files. No other unreferenced test module or self-check
export was found. Retain distinct behavioral, isolation, resource-accounting,
packaging, release-contract, and lifecycle-order checks. Pinned-source and
platform-specific checks remain conditional; unused by a default profile does
not mean a supported scenario is dead.

Real runtime proof covers fresh installation and cold/warm Gateway session
turns against published OpenClaw `2026.10.10`. Resource failures remain product
findings, with thresholds unchanged. Mocked harness checks and dry-run
snapshots do not establish OpenClaw E2E behavior for the other scenarios.
