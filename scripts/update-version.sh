#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date '+%H:%M:%S'
}

log_step() {
  printf '[%s] %s\n' "$(timestamp)" "$*" >&2
}

run_step() {
  local description="$1"
  shift
  local started_at="$SECONDS"
  log_step "$description"
  if "$@"; then
    log_step "done: ${description} ($((SECONDS - started_at))s)"
  else
    local command_status=$?
    log_step "failed: ${description} ($((SECONDS - started_at))s)"
    return "$command_status"
  fi
}

usage() {
  cat <<'EOF'
Update the Kova package version safely.

Usage:
  scripts/update-version.sh <version>

Examples:
  scripts/update-version.sh 0.2.0
  scripts/update-version.sh 1.0.0-beta.1
EOF
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

new_version="$1"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "$repo_root"

"${script_dir}/validate-version.mjs" "$new_version"

current_version="$(node -p 'require("./package.json").version')"
if [[ -z "$current_version" ]]; then
  echo "error: could not read package version from package.json" >&2
  exit 1
fi

if [[ "$current_version" == "$new_version" ]]; then
  echo "Kova is already on ${new_version}"
  exit 0
fi

backup_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$backup_dir"
}
rollback() {
  cp "$backup_dir/package.json" package.json
  cp "$backup_dir/package-lock.json" package-lock.json
}
trap cleanup EXIT
cp package.json "$backup_dir/package.json"
cp package-lock.json "$backup_dir/package-lock.json"

log_step "Updating package metadata from ${current_version} to ${new_version}"
if ! npm version "$new_version" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null; then
  rollback
  exit 1
fi

updated_version="$(node -p 'require("./package.json").version')"
if [[ "$updated_version" != "$new_version" ]]; then
  rollback
  echo "error: package.json did not update cleanly" >&2
  exit 1
fi

if ! run_step "Verifying version bump with npm run check:full" npm run check:full; then
  rollback
  echo "error: version verification failed; restored package metadata" >&2
  exit 1
fi

echo "Updated Kova version: ${current_version} -> ${new_version}"
