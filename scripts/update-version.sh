#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date '+%H:%M:%S'
}

log_step() {
  printf '[%s] %s\n' "$(timestamp)" "$*" >&2
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

lockfile_version="$(node -p 'require("./package-lock.json").version')"
lockfile_root_version="$(node -p 'require("./package-lock.json").packages[""].version')"
if [[ "$current_version" == "$new_version" && "$lockfile_version" == "$new_version" && "$lockfile_root_version" == "$new_version" ]]; then
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
updated_lockfile_version="$(node -p 'require("./package-lock.json").version')"
updated_lockfile_root_version="$(node -p 'require("./package-lock.json").packages[""].version')"
if [[ "$updated_version" != "$new_version" || "$updated_lockfile_version" != "$new_version" || "$updated_lockfile_root_version" != "$new_version" ]]; then
  rollback
  echo "error: package metadata did not update cleanly" >&2
  exit 1
fi

echo "Updated Kova version: ${current_version} -> ${new_version}"
