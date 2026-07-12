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
Prepare or resume a signed Kova release from the current main branch.

Usage:
  scripts/release.sh <version> [--remote <name>] [--skip-checks]

Examples:
  scripts/release.sh 0.2.0
  scripts/release.sh 1.0.0-beta.1 --remote upstream
EOF
}

package_version() {
  node -p 'require("./package.json").version'
}

ref_commit() {
  git rev-list -n1 "$1" 2>/dev/null || true
}

remote_ref_commit() {
  git ls-remote "$remote" "$1" | awk 'NR==1 { print $1 }'
}

remote_tag_object() {
  remote_ref_commit "refs/tags/${tag}"
}

remote_tag_commit() {
  git ls-remote "$remote" "refs/tags/${tag}^{}" "refs/tags/${tag}" | awk '
    $2 ~ /\^\{\}$/ { print $1; found=1; exit }
    NR == 1 { first=$1 }
    END { if (!found && first != "") print first }
  '
}

tag_signature_valid() {
  git -c gpg.format=ssh \
    -c gpg.ssh.allowedSignersFile="${repo_root}/.github/release-allowed-signers" \
    verify-tag "$1" >/dev/null 2>&1
}

remote_tag_signature_valid() {
  local expected_object_sha="$1"
  local temp_ref="refs/kova-release-check/${tag}"
  local fetched_object_sha=""
  local valid=0

  git update-ref -d "$temp_ref" >/dev/null 2>&1 || true
  if git fetch --quiet --force --no-tags "$remote" "refs/tags/${tag}:${temp_ref}"; then
    fetched_object_sha="$(git rev-parse --verify "$temp_ref" 2>/dev/null || true)"
    if [[ "$fetched_object_sha" == "$expected_object_sha" ]] && tag_signature_valid "$temp_ref"; then
      valid=1
    fi
  fi
  git update-ref -d "$temp_ref" >/dev/null 2>&1 || true
  [[ "$valid" -eq 1 ]]
}

refresh_dirty_files() {
  dirty_files=()
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    dirty_files+=("$file")
  done < <(
    {
      git diff --name-only --ignore-submodules --
      git diff --cached --name-only --ignore-submodules --
    } | sort -u
  )
}

only_version_files_dirty() {
  local file
  [[ "${#dirty_files[@]}" -gt 0 ]] || return 1
  for file in "${dirty_files[@]}"; do
    case "$file" in
      package.json|package-lock.json)
        ;;
      *)
        return 1
        ;;
    esac
  done
  "${script_dir}/validate-version-metadata.mjs" "$version"
}

is_release_commit() {
  [[ "$(git log -1 --pretty=%s 2>/dev/null || true)" == "$release_commit_message" ]] || return 1
  [[ "$(git diff-tree --no-commit-id --name-only -r HEAD | sort -u)" == $'package-lock.json\npackage.json' ]] || return 1
  [[ "$(git show HEAD:package.json | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => console.log(JSON.parse(input).version));')" == "$version" ]]
}

log_resume_state() {
  log_step "resume state: $*"
}

log_skip() {
  log_step "skip: $*"
}

version=""
remote="origin"
skip_checks=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      shift
      [[ $# -gt 0 ]] || { echo "error: --remote requires a value" >&2; exit 1; }
      remote="$1"
      ;;
    --skip-checks)
      skip_checks=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$version" ]]; then
        echo "error: version was already provided: $version" >&2
        usage >&2
        exit 1
      fi
      version="$1"
      ;;
  esac
  shift
done

if [[ -z "$version" ]]; then
  usage >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "$repo_root"

"${script_dir}/validate-version.mjs" "$version"

branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "$branch" != "main" ]]; then
  echo "error: releases must be prepared from the main branch (current: ${branch:-detached})" >&2
  exit 1
fi

if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "error: git remote not found: $remote" >&2
  exit 1
fi

tag="v${version}"
release_commit_message="chore: bump version to ${version}"
current_version="$(package_version)"

if [[ -z "$current_version" ]]; then
  echo "error: could not read Kova version from package.json" >&2
  exit 1
fi

refresh_dirty_files

head_sha="$(git rev-parse HEAD)"
head_is_release_commit=0
if is_release_commit; then
  head_is_release_commit=1
fi

local_tag_commit_sha="$(ref_commit "$tag")"
local_tag_object_sha="$(git rev-parse --verify "refs/tags/${tag}" 2>/dev/null || true)"
remote_tag_object_sha="$(remote_tag_object)"
remote_tag_commit_sha="$(remote_tag_commit)"
remote_main_sha="$(remote_ref_commit "refs/heads/main")"

if [[ -z "$remote_main_sha" ]]; then
  echo "error: could not resolve ${remote}/main" >&2
  exit 1
fi

if [[ -n "$local_tag_commit_sha" && "$local_tag_commit_sha" != "$head_sha" ]]; then
  echo "error: local tag ${tag} already exists and does not point at HEAD" >&2
  exit 1
fi

if [[ -n "$remote_tag_commit_sha" && "$remote_tag_commit_sha" != "$head_sha" ]]; then
  echo "error: remote tag ${tag} already exists on ${remote} and does not point at HEAD" >&2
  exit 1
fi

if [[ -n "$remote_tag_object_sha" ]]; then
  if ! remote_tag_signature_valid "$remote_tag_object_sha"; then
    echo "error: remote tag ${tag} is not signed by a repository-authorized signer" >&2
    exit 1
  fi
  if [[ -n "$local_tag_object_sha" && "$local_tag_object_sha" != "$remote_tag_object_sha" ]]; then
    echo "error: local and remote tag objects differ for ${tag}; reconcile them before retrying" >&2
    exit 1
  fi
  if [[ -z "$local_tag_object_sha" ]]; then
    run_step "Adopting verified remote tag ${tag}" \
      git fetch --quiet --force --no-tags "$remote" "refs/tags/${tag}:refs/tags/${tag}"
    local_tag_object_sha="$(git rev-parse --verify "refs/tags/${tag}")"
    local_tag_commit_sha="$(ref_commit "$tag")"
  fi
fi

if [[ "$head_is_release_commit" -eq 1 ]]; then
  release_base_sha="$(git rev-parse HEAD^)"
  if [[ "$remote_main_sha" == "$release_base_sha" && "$remote_tag_commit_sha" == "$head_sha" ]]; then
    echo "error: remote tag ${tag} exists while ${remote}/main is still at the release parent" >&2
    echo "error: push main explicitly, then rerun the failed Release Build workflow for ${tag}" >&2
    exit 1
  fi
  if [[ "$remote_main_sha" != "$release_base_sha" && "$remote_main_sha" != "$head_sha" ]]; then
    echo "error: ${remote}/main moved since the release commit was created; reconcile before retrying" >&2
    exit 1
  fi
elif [[ "$remote_main_sha" != "$head_sha" ]]; then
  echo "error: local main is not current with ${remote}/main; pull or reconcile before releasing" >&2
  exit 1
fi

need_update_version=0
need_checks=0
need_commit=0

log_step "Preparing release ${tag} from branch ${branch} using remote ${remote}"

if [[ "$current_version" == "$version" ]]; then
  if [[ "${#dirty_files[@]}" -gt 0 ]]; then
    if ! only_version_files_dirty; then
      echo "error: tracked changes are present; commit or stash them before running scripts/release.sh" >&2
      exit 1
    fi
    if [[ "$head_is_release_commit" -eq 1 || -n "$local_tag_commit_sha" || -n "$remote_tag_commit_sha" ]]; then
      echo "error: package.json is dirty for ${version}, but a release commit or tag already exists; clean up release state before retrying" >&2
      exit 1
    fi
    need_update_version=1
    need_checks=1
    need_commit=1
    log_resume_state "package metadata is partially or fully updated to ${version}"
  else
    if [[ "$head_is_release_commit" -ne 1 ]]; then
      echo "error: Kova is already on ${version}, but HEAD is not the expected release commit; clean up or finish that release state manually" >&2
      exit 1
    fi
    log_resume_state "release commit already exists at ${head_sha:0:7}"
  fi
else
  if [[ "${#dirty_files[@]}" -gt 0 ]]; then
    echo "error: tracked changes are present; commit or stash them before running scripts/release.sh" >&2
    exit 1
  fi
  if [[ -n "$local_tag_commit_sha" || -n "$remote_tag_commit_sha" ]]; then
    echo "error: release tag ${tag} already exists, but package.json is still on ${current_version}" >&2
    exit 1
  fi
  need_update_version=1
  need_checks=1
  need_commit=1
fi

if [[ "$skip_checks" -eq 0 ]]; then
  if [[ "$need_checks" -eq 1 ]]; then
    log_step "Local checks are enabled"
  else
    log_skip "local checks already passed before this resume point"
  fi
else
  log_step "Local checks are skipped"
  need_checks=0
fi

if [[ "$need_update_version" -eq 1 ]]; then
  run_step "Updating package.json to ${version}" "${script_dir}/update-version.sh" "$version"
else
  log_skip "package.json is already set to ${version}"
fi

if [[ "$need_checks" -eq 1 ]]; then
  run_step "Running Kova check suite" npm run check:full
fi

if [[ "$need_commit" -eq 1 ]]; then
  run_step "Staging package metadata" git add package.json package-lock.json
  if git diff --cached --quiet --ignore-submodules -- package.json package-lock.json; then
    echo "error: no staged version change remains for ${version}; cannot create release commit" >&2
    exit 1
  fi
  run_step "Creating release commit" git commit -m "$release_commit_message"
  head_sha="$(git rev-parse HEAD)"
else
  log_skip "release commit already exists"
fi

if [[ "$skip_checks" -eq 0 && -z "$local_tag_commit_sha" ]]; then
  run_step "Building release archive" "${script_dir}/package-release.sh" --output-dir ./dist
elif [[ "$skip_checks" -eq 1 ]]; then
  log_skip "release archive build is skipped"
else
  log_skip "release archive was validated before the existing tag was created"
fi

if [[ -z "$local_tag_commit_sha" ]]; then
  log_step "Creating signed tag ${tag}; git signing may prompt here"
  if ! git tag -s "$tag" -m "$tag"; then
    echo "error: failed to create signed tag ${tag}; make sure git tag signing is configured" >&2
    exit 1
  fi
  if ! tag_signature_valid "$tag"; then
    git tag -d "$tag" >/dev/null 2>&1 || true
    echo "error: created tag ${tag} was not signed; configure git tag signing before retrying" >&2
    exit 1
  fi
  log_step "done: Creating signed tag ${tag}"
  local_tag_commit_sha="$(ref_commit "$tag")"
else
  if ! tag_signature_valid "$tag"; then
    echo "error: existing tag ${tag} is not signed" >&2
    exit 1
  fi
  log_skip "local tag ${tag} already exists"
fi

remote_main_sha="$(remote_ref_commit "refs/heads/main")"
remote_tag_commit_sha="$(remote_tag_commit)"

push_targets=()
if [[ "$remote_main_sha" != "$head_sha" ]]; then
  push_targets+=("main")
fi
if [[ "$remote_tag_commit_sha" != "$head_sha" ]]; then
  push_targets+=("$tag")
fi

if [[ "${#push_targets[@]}" -gt 0 ]]; then
  run_step "Atomically pushing ${push_targets[*]} to ${remote}" git push --atomic "$remote" "${push_targets[@]}"
else
  log_skip "main and ${tag} are already pushed to ${remote}"
fi

cat <<EOF
Release prep complete for ${tag}.

Next:
  1. The tag-triggered release workflow will build and smoke-test the archive
  2. GitHub Releases will be published only after those checks pass
EOF
