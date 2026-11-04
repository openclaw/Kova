# Test cleanup ledger

Scope: tests, self-checks, fixtures, scenario mappings, and validation gaps.
Land independent changes through narrow PRs. No releases.

| Area | Finding / action | Validation |
| --- | --- | --- |
| Snapshot runner | Default and full comparison snapshots were byte-identical. Share one baseline while retaining both CLI executions. | 21/21 snapshots passed on AWS Crabbox `cbx_369e11f57fb3`. |
| Snapshot runner | Missing baselines were silently created; update mode ignored command failures, and comparison cases accepted any exit status. Require the expected status, fail missing baselines and command errors, and remove temporary test homes on exit. | AWS Crabbox `cbx_369e11f57fb3`: missing-baseline and update-command-failure probes passed; temporary homes absent after all three runs. |
| Fixtures | All five `fixtures/` files and three `tests/fixtures/` data files have consumers. Retain them. | Traced tracked-file references; no unused data fixture found. |
| Proxy log tests | Remove Node-only uncaught-error demonstration, redundant export/listener checks, and duplicated source-text assertions. Retain real proxy error/drain/shutdown coverage; wait for stream closure instead of fixed sleeps. | Proxy log-stream checks and partial-startup cleanup self-check passed on AWS Crabbox `cbx_e3399467eba5`. |

Remaining audit: standalone test overlap, self-check assertions, scenario and
feature mappings, website tests, and real OpenClaw execution coverage. Mocked
harness checks and dry-run snapshots do not establish OpenClaw E2E behavior.
