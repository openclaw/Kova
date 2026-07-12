#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ssh-keygen -q -t ed25519 -N "" -f "${tmp}/release-signing-key"
release_public_key="$(cat "${tmp}/release-signing-key.pub")"

make_repo() {
  local name="$1"
  local root="${tmp}/${name}"
  local repo="${root}/repo"
  local remote="${root}/remote.git"

  git init --bare --quiet --initial-branch=main "$remote"
  git init --quiet --initial-branch=main "$repo"
  mkdir -p "${repo}/.github" "${repo}/scripts"
  printf 'release@openclaw.invalid namespaces="git" %s\n' "$release_public_key" > "${repo}/.github/release-allowed-signers"
  cp "${repo_root}/package.json" "${repo}/package.json"
  cp "${repo_root}/package-lock.json" "${repo}/package-lock.json"
  cp "${script_dir}/release.sh" "${repo}/scripts/release.sh"
  cp "${script_dir}/update-version.sh" "${repo}/scripts/update-version.sh"
  cp "${script_dir}/validate-version.mjs" "${repo}/scripts/validate-version.mjs"
  cat > "${repo}/scripts/package-release.sh" <<'EOF'
#!/bin/sh
set -eu
if [ -n "${KOVA_RELEASE_ARCHIVE_PROOF:-}" ]; then
  git rev-parse HEAD > "$KOVA_RELEASE_ARCHIVE_PROOF"
fi
EOF
  chmod +x "${repo}/scripts/"*
  git -C "$repo" config user.name "Kova release contract"
  git -C "$repo" config user.email "kova-release-contract@example.invalid"
  git -C "$repo" config gpg.format ssh
  git -C "$repo" config user.signingkey "${tmp}/release-signing-key"
  git -C "$repo" config gpg.ssh.allowedSignersFile "${repo}/.github/release-allowed-signers"
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

fresh_repo="$(make_repo fresh-release)"
fresh_bin="${tmp}/fresh-release/bin"
real_npm="$(command -v npm)"
mkdir -p "$fresh_bin"
cat > "${fresh_bin}/npm" <<'EOF'
#!/bin/sh
case "$1:$2" in
  version:*)
    exec "$KOVA_REAL_NPM" "$@"
    ;;
  run:check:full)
    exit 0
    ;;
esac
exec "$KOVA_REAL_NPM" "$@"
EOF
chmod +x "${fresh_bin}/npm"
(
  cd "$fresh_repo"
  archive_proof="${tmp}/fresh-release-archive-head"
  PATH="${fresh_bin}:$PATH" KOVA_REAL_NPM="$real_npm" KOVA_RELEASE_ARCHIVE_PROOF="$archive_proof" scripts/release.sh "$test_version" >/dev/null
  test "$(git diff-tree --no-commit-id --name-only -r HEAD | sort -u)" = $'package-lock.json\npackage.json'
  test "$(node -p 'require("./package.json").version')" = "$test_version"
  test "$(node -p 'require("./package-lock.json").version')" = "$test_version"
  test "$(node -p 'require("./package-lock.json").packages[""].version')" = "$test_version"
  test "$(cat "$archive_proof")" = "$(git rev-parse HEAD)"
  test -z "$(git status --porcelain=v1)"
  test "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/main | awk '{ print $1 }')"
  test "$(git rev-parse HEAD)" = "$(git ls-remote origin "refs/tags/v${test_version}^{}" | awk '{ print $1 }')"
  scripts/release.sh "$test_version" --skip-checks >/dev/null
)

prebumped_repo="$(make_repo prebumped-manifest)"
(
  cd "$prebumped_repo"
  node - "$test_version" <<'NODE'
  const fs = require("node:fs");
  const path = "package.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.version = process.argv[2];
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  PATH="${fresh_bin}:$PATH" KOVA_REAL_NPM="$real_npm" scripts/release.sh "$test_version" --skip-checks >/dev/null
  test "$(git diff-tree --no-commit-id --name-only -r HEAD | sort -u)" = $'package-lock.json\npackage.json'
  test "$(node -p 'require("./package-lock.json").version')" = "$test_version"
  test "$(node -p 'require("./package-lock.json").packages[""].version')" = "$test_version"
  test -z "$(git status --porcelain=v1)"
)

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
grep -q "remote tag v${test_version} is not signed by a repository-authorized signer" <<<"$partial_output"
if grep -q "push main explicitly" <<<"$partial_output"; then
  echo "error: untrusted partial remote release recommended advancing main" >&2
  exit 1
fi

signed_partial_repo="$(make_repo signed-partial-remote)"
(
  cd "$signed_partial_repo"
  npm version "$test_version" --no-git-tag-version --ignore-scripts >/dev/null
  git add package.json package-lock.json
  git commit --quiet -m "chore: bump version to ${test_version}"
  git tag -s "v${test_version}" -m "v${test_version}"
  git push --quiet origin "v${test_version}"
)
if signed_partial_output="$(cd "$signed_partial_repo" && scripts/release.sh "$test_version" --skip-checks 2>&1)"; then
  echo "error: signed partial remote release state unexpectedly passed validation" >&2
  exit 1
fi
grep -q "remote tag v${test_version} exists while origin/main is still at the release parent" <<<"$signed_partial_output"
grep -q "push main explicitly" <<<"$signed_partial_output"

retry_repo="$(make_repo remote-tag-retry)"
(
  cd "$retry_repo"
  npm version "$test_version" --no-git-tag-version --ignore-scripts >/dev/null
  git add package.json package-lock.json
  git commit --quiet -m "chore: bump version to ${test_version}"
  git push --quiet origin main
  git tag -s "v${test_version}" -m "v${test_version}"
  git push --quiet origin "v${test_version}"
  git tag -d "v${test_version}" >/dev/null
)
(cd "$retry_repo" && scripts/release.sh "$test_version" --skip-checks >/dev/null)
test "$(git -C "$retry_repo" rev-parse "v${test_version}^{commit}")" = "$(git -C "$retry_repo" rev-parse HEAD)"

echo "release contract checks passed"
