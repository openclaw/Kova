#!/usr/bin/env bash
set -euo pipefail

[[ "${DRY_RUN:-}" == true ]] || { echo "Manual release runs must be dry runs" >&2; exit 1; }
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo "Rehearse main only" >&2; exit 1; }
[[ "${REQUESTED_VERSION:-}" == "$(node -p 'require("./package.json").version')" ]] || { echo "Version must match package.json" >&2; exit 1; }
[[ "${GITHUB_SHA:-}" == "$(git rev-parse origin/main)" ]] || { echo "Rehearse current main only" >&2; exit 1; }
