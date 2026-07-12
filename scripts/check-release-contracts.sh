#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_repo() {
  local name="$1"
  local root="${tmp}/${name}"
  local repo="${root}/repo"
  local remote="${root}/remote.git"

  git init --bare --quiet --initial-branch=main "$remote"
  git init --quiet --initial-branch=main "$repo"
  mkdir -p "${repo}/scripts"
  cp "${repo_root}/package.json" "${repo}/package.json"
  cp "${repo_root}/package-lock.json" "${repo}/package-lock.json"
  cp "${script_dir}/release.sh" "${repo}/scripts/release.sh"
  cp "${script_dir}/update-version.sh" "${repo}/scripts/update-version.sh"
  cp "${script_dir}/validate-version.mjs" "${repo}/scripts/validate-version.mjs"
  chmod +x "${repo}/scripts/"*
  git -C "$repo" config user.name "Kova release contract"
  git -C "$repo" config user.email "kova-release-contract@example.invalid"
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m "test: initial release state"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push --quiet -u origin main
  printf '%s\n' "$repo"
}

current_version="$(node -p 'require("./package.json").version')"
if [[ "$current_version" == "0.0.0-release-contract" ]]; then
  test_version="0.0.1-release-contract"
else
  test_version="0.0.0-release-contract"
fi

stale_repo="$(make_repo stale-main)"
git clone --quiet "${tmp}/stale-main/remote.git" "${tmp}/stale-main/upstream"
git -C "${tmp}/stale-main/upstream" config user.name "Kova upstream"
git -C "${tmp}/stale-main/upstream" config user.email "kova-upstream@example.invalid"
touch "${tmp}/stale-main/upstream/upstream-change"
git -C "${tmp}/stale-main/upstream" add upstream-change
git -C "${tmp}/stale-main/upstream" commit --quiet -m "test: advance remote"
git -C "${tmp}/stale-main/upstream" push --quiet
stale_before="$(git -C "$stale_repo" status --porcelain=v1)"
if stale_output="$(cd "$stale_repo" && scripts/release.sh "$test_version" --skip-checks 2>&1)"; then
  echo "error: stale local main unexpectedly passed release validation" >&2
  exit 1
fi
grep -q "local main is not current" <<<"$stale_output"
test "$(git -C "$stale_repo" status --porcelain=v1)" = "$stale_before"

unsigned_repo="$(make_repo unsigned-tag)"
(
  cd "$unsigned_repo"
  npm version "$test_version" --no-git-tag-version --ignore-scripts >/dev/null
  git add package.json package-lock.json
  git commit --quiet -m "chore: bump version to ${test_version}"
  git push --quiet origin main
  git -c tag.gpgSign=false tag -a "v${test_version}" -m "v${test_version}"
)
if unsigned_output="$(cd "$unsigned_repo" && scripts/release.sh "$test_version" --skip-checks 2>&1)"; then
  echo "error: unsigned release tag unexpectedly passed validation" >&2
  exit 1
fi
grep -q "existing tag v${test_version} is not signed" <<<"$unsigned_output"

partial_repo="$(make_repo partial-remote)"
(
  cd "$partial_repo"
  npm version "$test_version" --no-git-tag-version --ignore-scripts >/dev/null
  git add package.json package-lock.json
  git commit --quiet -m "chore: bump version to ${test_version}"
  git -c tag.gpgSign=false tag -a "v${test_version}" -m "v${test_version}"
  git push --quiet origin "v${test_version}"
)
if partial_output="$(cd "$partial_repo" && scripts/release.sh "$test_version" --skip-checks 2>&1)"; then
  echo "error: partial remote release state unexpectedly passed validation" >&2
  exit 1
fi
grep -q "remote tag v${test_version} exists while origin/main is still at the release parent" <<<"$partial_output"

echo "release contract checks passed"
