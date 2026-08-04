#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

release_workflow="${repo_root}/.github/workflows/release.yml"
tag_fetch_pattern="\"refs/tags/\${GITHUB_REF_NAME}:refs/tags/\${GITHUB_REF_NAME}\""
tag_commit_pattern="test \"\$(git rev-parse \"\${GITHUB_REF_NAME}^{commit}\")\" = \"\${GITHUB_SHA}\""
tag_verify_pattern="verify-tag \"\${GITHUB_REF_NAME}\""
ci_commit_pattern="--commit \"\$GITHUB_SHA\""
tag_fetch_line="$(
  grep -nF "$tag_fetch_pattern" "$release_workflow" |
    cut -d: -f1
)"
tag_commit_line="$(
  grep -nF "$tag_commit_pattern" "$release_workflow" |
    cut -d: -f1
)"
tag_verify_line="$(grep -nF "$tag_verify_pattern" "$release_workflow" | cut -d: -f1)"
if [[ -z "$tag_fetch_line" ||
  -z "$tag_commit_line" ||
  -z "$tag_verify_line" ||
  "$tag_fetch_line" -ge "$tag_commit_line" ||
  "$tag_commit_line" -ge "$tag_verify_line" ]]; then
  echo "error: release workflow must bind the fetched annotated tag to the event commit before verifying it" >&2
  exit 1
fi
if grep -qF 'npm run check:full' "$release_workflow"; then
  echo "error: tag builds must not repeat the exact-SHA CI check suite" >&2
  exit 1
fi
if ! grep -qF 'gh run list' "$release_workflow" ||
  ! grep -qF -- "$ci_commit_pattern" "$release_workflow"; then
  echo "error: tag builds must verify exact-SHA main CI before packaging" >&2
  exit 1
fi

clawsweeper_workflow="${repo_root}/.github/workflows/clawsweeper-dispatch.yml"
comment_filter_line="$(grep -nF -- '- name: Pre-filter ClawSweeper comment' "$clawsweeper_workflow" | cut -d: -f1)"
dispatch_token_line="$(grep -nF -- '- name: Create ClawSweeper dispatch token' "$clawsweeper_workflow" | cut -d: -f1)"
if [[ -z "$comment_filter_line" ||
  -z "$dispatch_token_line" ||
  "$comment_filter_line" -ge "$dispatch_token_line" ]]; then
  echo "error: ClawSweeper comments must be filtered before dispatch token creation" >&2
  exit 1
fi
if ! sed -n "${dispatch_token_line},$((dispatch_token_line + 12))p" "$clawsweeper_workflow" |
  grep -qF "steps.comment_filter.outputs.is_command == 'true'"; then
  echo "error: ClawSweeper dispatch token must be gated by the comment filter" >&2
  exit 1
fi
if ! grep -qF "contains(github.event.comment.body, '/clawsweeper')" "$clawsweeper_workflow"; then
  echo "error: ordinary issue comments must skip the ClawSweeper dispatch job" >&2
  exit 1
fi

ssh-keygen -q -t ed25519 -N "" -f "${tmp}/release-signing-key"
release_public_key="$(cat "${tmp}/release-signing-key.pub")"

mock_gh="${tmp}/mock-gh"
cat >"$mock_gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
subcommand="${2:-}"
shift 2

case "${command_name}:${subcommand}" in
  pr:view)
    [[ -s "$KOVA_MOCK_PR_JSON" ]] || exit 1
    cat "$KOVA_MOCK_PR_JSON"
    ;;
  pr:create)
    if [[ "${KOVA_MOCK_PR_CREATE_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    body_file=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --body-file)
          shift
          body_file="${1:-}"
          ;;
      esac
      shift
    done
    [[ -n "$body_file" && -s "$body_file" ]]
    cp "$body_file" "$KOVA_MOCK_PR_BODY"
    PR_BODY="$(cat "$body_file")" node - <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(
  process.env.KOVA_MOCK_PR_JSON,
  JSON.stringify({
    url: "https://github.com/openclaw/Kova/pull/999",
    state: "OPEN",
    baseRefName: "main",
    body: process.env.PR_BODY,
  }),
);
NODE
    printf '%s\n' "https://github.com/openclaw/Kova/pull/999"
    ;;
  run:list)
    cat "$KOVA_MOCK_RUNS_JSON"
    ;;
  *)
    echo "unexpected mock gh command: ${command_name} ${subcommand}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$mock_gh"

make_repo() {
  local name="$1"
  local root="${tmp}/${name}"
  local repo="${root}/repo"
  local remote="${root}/remote.git"

  git init --bare --quiet --initial-branch=main "$remote"
  git init --quiet --initial-branch=main "$repo"
  mkdir -p "${repo}/.github" "${repo}/scripts"
  printf 'release@openclaw.invalid namespaces="git" %s\n' "$release_public_key" >"${repo}/.github/release-allowed-signers"
  cp "${repo_root}/package.json" "${repo}/package.json"
  cp "${repo_root}/package-lock.json" "${repo}/package-lock.json"
  cp "${script_dir}/release.sh" "${repo}/scripts/release.sh"
  cp "${script_dir}/update-version.sh" "${repo}/scripts/update-version.sh"
  cp "${script_dir}/validate-version.mjs" "${repo}/scripts/validate-version.mjs"
  cp "${script_dir}/validate-version-metadata.mjs" "${repo}/scripts/validate-version-metadata.mjs"
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
  : >"${root}/pr.json"
  printf '[]\n' >"${root}/runs.json"
  printf '%s\n' "$repo"
}

run_release() {
  local repo="$1"
  local version="$2"
  local root
  shift 2
  root="$(dirname "$repo")"
  (
    cd "$repo"
    KOVA_GH_BIN="$mock_gh" \
      KOVA_GITHUB_REPOSITORY="openclaw/Kova" \
      KOVA_MOCK_PR_JSON="${root}/pr.json" \
      KOVA_MOCK_PR_BODY="${root}/pr-body.md" \
      KOVA_MOCK_RUNS_JSON="${root}/runs.json" \
      scripts/release.sh "$version" "$@"
  )
}

record_successful_ci() {
  local repo="$1"
  local root head_sha
  root="$(dirname "$repo")"
  head_sha="$(git -C "$repo" rev-parse HEAD)"
  node - "${root}/runs.json" "$head_sha" <<'NODE'
const fs = require("node:fs");
const [path, headSha] = process.argv.slice(2);
fs.writeFileSync(
  path,
  `${JSON.stringify([{
    databaseId: 12345,
    headSha,
    status: "completed",
    conclusion: "success",
    url: "https://github.com/openclaw/Kova/actions/runs/12345",
  }])}\n`,
);
NODE
}

squash_release_to_main() {
  local repo="$1"
  local version="$2"
  local release_branch="release/v${version}"
  git -C "$repo" switch --quiet main
  git -C "$repo" reset --quiet --hard origin/main
  git -C "$repo" merge --quiet --squash "$release_branch"
  git -C "$repo" commit --quiet -m "chore(release): bump version to ${version} (#999)"
  git -C "$repo" push --quiet origin main
}

current_version="$(node -p 'require("./package.json").version')"
if [[ "$current_version" == "0.0.0-release-contract" ]]; then
  test_version="0.0.1-release-contract"
else
  test_version="0.0.0-release-contract"
fi
tag="v${test_version}"
release_branch="release/${tag}"

fresh_repo="$(make_repo fresh-release)"
fresh_root="$(dirname "$fresh_repo")"
fresh_main="$(git -C "$fresh_repo" rev-parse HEAD)"
run_release "$fresh_repo" "$test_version" >/dev/null
test "$(git -C "$fresh_repo" branch --show-current)" = "$release_branch"
test "$(git -C "$fresh_repo" ls-remote origin refs/heads/main | awk '{ print $1 }')" = "$fresh_main"
test "$(git -C "$fresh_repo" ls-remote origin "refs/heads/${release_branch}" | awk '{ print $1 }')" = "$(git -C "$fresh_repo" rev-parse HEAD)"
test -z "$(git -C "$fresh_repo" ls-remote origin "refs/tags/${tag}")"
test "$(git -C "$fresh_repo" diff-tree --no-commit-id --name-only -r HEAD | sort -u)" = $'package-lock.json\npackage.json'
grep -qF "Squash-merge it" "${fresh_root}/pr-body.md"
run_release "$fresh_repo" "$test_version" >/dev/null
test -z "$(git -C "$fresh_repo" status --porcelain=v1)"

squash_release_to_main "$fresh_repo" "$test_version"
fresh_release_sha="$(git -C "$fresh_repo" rev-parse HEAD)"
if missing_ci_output="$(run_release "$fresh_repo" "$test_version" 2>&1)"; then
  echo "error: release tag unexpectedly passed without exact-SHA CI" >&2
  exit 1
fi
grep -qF "no main-branch CI push run exists for exact commit ${fresh_release_sha}" <<<"$missing_ci_output"
test -z "$(git -C "$fresh_repo" tag --list "$tag")"

record_successful_ci "$fresh_repo"
run_release "$fresh_repo" "$test_version" >/dev/null
test "$(git -C "$fresh_repo" rev-list -n1 "$tag")" = "$fresh_release_sha"
test "$(git -C "$fresh_repo" ls-remote origin "refs/tags/${tag}^{}" | awk '{ print $1 }')" = "$fresh_release_sha"
git -C "$fresh_repo" -c gpg.format=ssh \
  -c gpg.ssh.allowedSignersFile="${fresh_repo}/.github/release-allowed-signers" \
  verify-tag "$tag" >/dev/null
git -C "$fresh_repo" tag -d "$tag" >/dev/null
run_release "$fresh_repo" "$test_version" >/dev/null
test "$(git -C "$fresh_repo" rev-list -n1 "$tag")" = "$fresh_release_sha"

stale_repo="$(make_repo stale-main)"
git clone --quiet "$(dirname "$stale_repo")/remote.git" "${tmp}/stale-upstream"
git -C "${tmp}/stale-upstream" config user.name "Kova upstream"
git -C "${tmp}/stale-upstream" config user.email "kova-upstream@example.invalid"
touch "${tmp}/stale-upstream/upstream-change"
git -C "${tmp}/stale-upstream" add upstream-change
git -C "${tmp}/stale-upstream" commit --quiet -m "test: advance remote"
git -C "${tmp}/stale-upstream" push --quiet
if stale_output="$(run_release "$stale_repo" "$test_version" 2>&1)"; then
  echo "error: stale local main unexpectedly passed release validation" >&2
  exit 1
fi
grep -qF "local main must exactly match origin/main" <<<"$stale_output"
test "$(git -C "$stale_repo" branch --show-current)" = "main"

wrong_base_repo="$(make_repo wrong-base-pr)"
wrong_base_root="$(dirname "$wrong_base_repo")"
printf '%s\n' '{"url":"https://github.com/openclaw/Kova/pull/998","state":"OPEN","baseRefName":"develop","body":"wrong base"}' >"${wrong_base_root}/pr.json"
if wrong_base_output="$(run_release "$wrong_base_repo" "$test_version" 2>&1)"; then
  echo "error: wrong-base release pull request unexpectedly passed" >&2
  exit 1
fi
grep -qF "with base develop" <<<"$wrong_base_output"
test -z "$(git -C "$wrong_base_repo" ls-remote origin "refs/tags/${tag}")"

failed_pr_repo="$(make_repo failed-pr-create)"
failed_pr_root="$(dirname "$failed_pr_repo")"
if failed_pr_output="$(
  cd "$failed_pr_repo"
  KOVA_GH_BIN="$mock_gh" \
    KOVA_GITHUB_REPOSITORY="openclaw/Kova" \
    KOVA_MOCK_PR_JSON="${failed_pr_root}/pr.json" \
    KOVA_MOCK_PR_BODY="${failed_pr_root}/pr-body.md" \
    KOVA_MOCK_RUNS_JSON="${failed_pr_root}/runs.json" \
    KOVA_MOCK_PR_CREATE_FAIL=1 \
    scripts/release.sh "$test_version" 2>&1
)"; then
  echo "error: failed pull request creation unexpectedly passed" >&2
  exit 1
fi
grep -qF "failed to create the release pull request" <<<"$failed_pr_output"

poisoned_repo="$(make_repo poisoned-lockfile)"
git -C "$poisoned_repo" switch --quiet -c "$release_branch"
node - "$poisoned_repo" "$test_version" <<'NODE'
const fs = require("node:fs");
const [repo, version] = process.argv.slice(2);
for (const path of ["package.json", "package-lock.json"]) {
  const absolutePath = `${repo}/${path}`;
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  value.version = version;
  if (path === "package-lock.json") {
    value.packages[""].version = version;
    value.packages["node_modules/json5"].resolved = "https://example.invalid/json5.tgz";
  }
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}
NODE
if poisoned_output="$(run_release "$poisoned_repo" "$test_version" 2>&1)"; then
  echo "error: poisoned lockfile unexpectedly passed release validation" >&2
  exit 1
fi
grep -qF "package-lock.json contains changes outside version fields" <<<"$poisoned_output"
test -z "$(git -C "$poisoned_repo" ls-remote origin "refs/tags/${tag}")"

unsigned_repo="$(make_repo unsigned-tag)"
run_release "$unsigned_repo" "$test_version" >/dev/null
squash_release_to_main "$unsigned_repo" "$test_version"
git -C "$unsigned_repo" -c tag.gpgSign=false tag -a "$tag" -m "$tag"
git -C "$unsigned_repo" push --quiet origin "$tag"
if unsigned_output="$(run_release "$unsigned_repo" "$test_version" 2>&1)"; then
  echo "error: unsigned remote tag unexpectedly passed validation" >&2
  exit 1
fi
grep -qF "remote tag ${tag} is not signed by a repository-authorized signer" <<<"$unsigned_output"

auto_key_repo="$(make_repo auto-signing-key)"
auto_key_root="$(dirname "$auto_key_repo")"
auto_key_home="${auto_key_root}/home"
mkdir -p "${auto_key_home}/.ssh"
cp "${tmp}/release-signing-key" "${auto_key_home}/.ssh/id_ed25519"
cp "${tmp}/release-signing-key.pub" "${auto_key_home}/.ssh/id_ed25519.pub"
ssh-keygen -q -t ed25519 -N "" -f "${auto_key_root}/unrelated-signing-key"
git -C "$auto_key_repo" config user.signingkey "${auto_key_root}/unrelated-signing-key"
run_release "$auto_key_repo" "$test_version" >/dev/null
squash_release_to_main "$auto_key_repo" "$test_version"
record_successful_ci "$auto_key_repo"
(
  cd "$auto_key_repo"
  HOME="$auto_key_home" \
    KOVA_GH_BIN="$mock_gh" \
    KOVA_GITHUB_REPOSITORY="openclaw/Kova" \
    KOVA_MOCK_PR_JSON="${auto_key_root}/pr.json" \
    KOVA_MOCK_PR_BODY="${auto_key_root}/pr-body.md" \
    KOVA_MOCK_RUNS_JSON="${auto_key_root}/runs.json" \
    scripts/release.sh "$test_version" >/dev/null
)
test "$(git -C "$auto_key_repo" rev-list -n1 "$tag")" = "$(git -C "$auto_key_repo" rev-parse HEAD)"

echo "release contract checks passed"
