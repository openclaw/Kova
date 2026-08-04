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
Prepare or finish a signed Kova release through a pull request.

Usage:
  scripts/release.sh <version> [--remote <name>]

Run the same command twice:
  1. From current main, create the release branch and pull request.
  2. After squash-merging that pull request, update main and rerun to verify
     exact-SHA CI, sign the tag, and push it.
EOF
}

package_version() {
  node -p 'require("./package.json").version'
}

version_at_ref() {
  git show "$1:package.json" |
    node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => console.log(JSON.parse(input).version));'
}

remote_ref_commit() {
  git ls-remote "$remote" "$1" | awk 'NR == 1 { print $1 }'
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

normalize_signing_key() {
  case "$1" in
    key::*|ssh-*|ecdsa-*|sk-*) printf '%s\n' "$1" ;;
    \~/*) printf '%s/%s\n' "$HOME" "${1:2}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

signing_key_public_line() {
  local signing_key="$1"
  local first_field
  case "$signing_key" in
    key::*)
      printf '%s\n' "${signing_key#key::}"
      return
      ;;
    ssh-*|ecdsa-*|sk-*)
      printf '%s\n' "$signing_key"
      return
      ;;
  esac

  [[ -f "$signing_key" ]] || return 1
  read -r first_field _ <"$signing_key" || return 1
  case "$first_field" in
    ssh-*|ecdsa-*|sk-*)
      head -n1 "$signing_key"
      return
      ;;
  esac
  [[ -f "${signing_key}.pub" ]] || return 1
  head -n1 "${signing_key}.pub"
}

key_is_authorized() {
  local signing_key="$1"
  local public_key key_type key_data
  public_key="$(signing_key_public_line "$signing_key")" || return 1
  read -r key_type key_data _ <<<"$public_key" || return 1
  [[ -n "$key_type" && -n "$key_data" ]] || return 1
  awk -v key_type="$key_type" -v key_data="$key_data" '
    {
      for (field = 1; field < NF; field += 1) {
        if ($field == key_type && $(field + 1) == key_data) {
          found = 1
        }
      }
    }
    END { exit found ? 0 : 1 }
  ' "${repo_root}/.github/release-allowed-signers"
}

resolve_release_signing_key() {
  local configured_key candidate default_key_command public_key
  local -a discovered_keys=()

  if [[ -n "${KOVA_RELEASE_SIGNING_KEY:-}" ]]; then
    candidate="$(normalize_signing_key "$KOVA_RELEASE_SIGNING_KEY")"
    if key_is_authorized "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
    echo "error: KOVA_RELEASE_SIGNING_KEY is not an authorized release key" >&2
    return 1
  fi

  configured_key="$(git config --get user.signingkey || true)"
  configured_key="$(normalize_signing_key "$configured_key")"
  if [[ -n "$configured_key" ]] && key_is_authorized "$configured_key"; then
    printf '%s\n' "$configured_key"
    return
  fi

  default_key_command="$(git config --get gpg.ssh.defaultKeyCommand || true)"
  if [[ -n "$default_key_command" ]]; then
    candidate="$(sh -c "$default_key_command" | head -n1)"
    candidate="$(normalize_signing_key "$candidate")"
    if key_is_authorized "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  fi

  if [[ -d "${HOME}/.ssh" ]]; then
    while IFS= read -r public_key; do
      candidate="${public_key%.pub}"
      if [[ ! -f "$candidate" ]]; then
        candidate="$public_key"
      fi
      if key_is_authorized "$candidate"; then
        discovered_keys+=("$candidate")
      fi
    done < <(find "${HOME}/.ssh" -maxdepth 1 -type f -name '*.pub' -print | sort)
  fi

  if [[ "${#discovered_keys[@]}" -eq 1 ]]; then
    printf '%s\n' "${discovered_keys[0]}"
    return
  fi
  if [[ "${#discovered_keys[@]}" -gt 1 ]]; then
    echo "error: multiple authorized release keys found; set KOVA_RELEASE_SIGNING_KEY" >&2
    return 1
  fi
  echo "error: no authorized release signing key found" >&2
  echo "hint: set KOVA_RELEASE_SIGNING_KEY to the matching private key path" >&2
  return 1
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

tracked_dirty_files() {
  {
    git diff --name-only --ignore-submodules --
    git diff --cached --name-only --ignore-submodules --
  } | sort -u
}

require_clean_checkout() {
  local dirty
  dirty="$(tracked_dirty_files)"
  if [[ -n "$dirty" ]]; then
    echo "error: tracked changes are present; commit or stash them before running scripts/release.sh" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi
}

release_commit_is_version_only() {
  local changed
  changed="$(git diff-tree --no-commit-id --name-only -r HEAD | sort -u)"
  [[ "$changed" == $'package-lock.json\npackage.json' ]] || return 1
  "${script_dir}/validate-version-metadata.mjs" "$version" --commit HEAD
}

release_commit_subject_matches() {
  local subject="$1"
  local suffix
  if [[ "$subject" == "$release_commit_message" ]]; then
    return 0
  fi
  suffix="${subject#"$release_commit_message"}"
  [[ "$suffix" =~ ^\ \(#[0-9]+\)$ ]]
}

release_branch_is_version_only() {
  local remote_main_sha release_base_sha commit_count changed
  remote_main_sha="$(remote_ref_commit "refs/heads/main")"
  [[ -n "$remote_main_sha" ]] || {
    echo "error: could not resolve ${remote}/main" >&2
    return 1
  }
  git fetch --quiet "$remote" main
  release_base_sha="$(git merge-base HEAD "$remote_main_sha")"
  commit_count="$(git rev-list --count "${release_base_sha}..HEAD")"
  changed="$(git diff --name-only "${release_base_sha}..HEAD" | sort -u)"
  if [[ "$commit_count" != "1" || "$changed" != $'package-lock.json\npackage.json' ]]; then
    echo "error: ${release_branch} must contain exactly one version-only commit" >&2
    return 1
  fi
  release_commit_subject_matches "$(git log -1 --pretty=%s)" &&
    release_commit_is_version_only
}

github() {
  if [[ -n "${KOVA_GH_BIN:-}" ]]; then
    "$KOVA_GH_BIN" "$@"
  elif command -v ghx >/dev/null 2>&1; then
    ghx --no-cache "$@"
  elif command -v gh >/dev/null 2>&1; then
    gh "$@"
  else
    echo "error: ghx or gh is required for release pull requests and CI verification" >&2
    return 1
  fi
}

github_repository() {
  local remote_url repository
  if [[ -n "${KOVA_GITHUB_REPOSITORY:-}" ]]; then
    repository="$KOVA_GITHUB_REPOSITORY"
  else
    remote_url="$(git remote get-url "$remote")"
    case "$remote_url" in
      https://github.com/*)
        repository="${remote_url#https://github.com/}"
        ;;
      git@github.com:*)
        repository="${remote_url#git@github.com:}"
        ;;
      ssh://git@github.com/*)
        repository="${remote_url#ssh://git@github.com/}"
        ;;
      *)
        echo "error: cannot derive a GitHub repository from remote ${remote}; set KOVA_GITHUB_REPOSITORY" >&2
        return 1
        ;;
    esac
    repository="${repository%.git}"
  fi
  if [[ ! "$repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    echo "error: invalid GitHub repository: ${repository}" >&2
    return 1
  fi
  printf '%s\n' "$repository"
}

release_pr_details() {
  local repository="$1"
  local response
  response="$(
    github pr view "$release_branch" \
      --repo "$repository" \
      --json url,state,baseRefName,body \
      2>/dev/null || true
  )"
  [[ -n "$response" ]] || return 1
  PR_JSON="$response" node <<'NODE'
const value = JSON.parse(process.env.PR_JSON);
console.log([
  value.url || "",
  value.state || "",
  value.baseRefName || "",
  typeof value.body === "string" && value.body.trim() ? "body-ok" : "body-empty",
].join("\t"));
NODE
}

ensure_release_pr() {
  local repository details pr_url pr_state pr_base pr_body_state body_file
  repository="$(github_repository)"
  details="$(release_pr_details "$repository" || true)"
  if [[ -n "$details" ]]; then
    IFS=$'\t' read -r pr_url pr_state pr_base pr_body_state <<<"$details"
    if [[ "$pr_state" != "OPEN" || "$pr_base" != "main" ]]; then
      echo "error: existing pull request for ${release_branch} is ${pr_state:-unknown} with base ${pr_base:-unknown}" >&2
      return 1
    fi
    if [[ "$pr_body_state" != "body-ok" ]]; then
      echo "error: existing pull request for ${release_branch} has an empty body" >&2
      return 1
    fi
    printf '%s\n' "$pr_url"
    return
  fi

  body_file="$(mktemp "${TMPDIR:-/tmp}/kova-release-pr.XXXXXX")"
  cat >"$body_file" <<EOF
## What Problem This Solves

Prepares the version metadata for ${tag} through the normal review and CI path.

## Why This Change Was Made

This pull request contains only the package version bump. Squash-merge it so the exact merge commit can pass the main-branch CI gate before the signed release tag is created.

## User Impact

No runtime behavior changes. Release metadata is reviewed and validated before publication.

## Evidence

- Version metadata is limited to \`package.json\` and \`package-lock.json\`.
- Pull-request CI is the validation gate.
- After merge, rerun \`scripts/release.sh ${version} --remote ${remote}\`.
EOF
  if ! pr_url="$(
    github pr create \
      --repo "$repository" \
      --base main \
      --head "$release_branch" \
      --title "$release_commit_message" \
      --body-file "$body_file"
  )" || [[ -z "$pr_url" ]]; then
    rm -f "$body_file"
    echo "error: failed to create the release pull request" >&2
    return 1
  fi
  rm -f "$body_file"

  details="$(release_pr_details "$repository" || true)"
  if [[ -z "$details" ]]; then
    echo "error: created release pull request could not be read back" >&2
    return 1
  fi
  IFS=$'\t' read -r pr_url pr_state pr_base pr_body_state <<<"$details"
  if [[ "$pr_state" != "OPEN" || "$pr_base" != "main" || "$pr_body_state" != "body-ok" ]]; then
    echo "error: created release pull request failed live verification" >&2
    return 1
  fi
  printf '%s\n' "$pr_url"
}

verify_exact_main_ci() {
  local head_sha="$1"
  local repository runs_json result state run_id run_url
  repository="$(github_repository)"
  if ! runs_json="$(
    github run list \
      --repo "$repository" \
      --workflow ci.yml \
      --branch main \
      --event push \
      --commit "$head_sha" \
      --limit 20 \
      --json databaseId,headSha,status,conclusion,url
  )"; then
    echo "error: could not query CI for ${head_sha}" >&2
    return 1
  fi
  result="$(
    CI_RUNS_JSON="$runs_json" node - "$head_sha" <<'NODE'
const headSha = process.argv[2];
const runs = JSON.parse(process.env.CI_RUNS_JSON || "[]");
const run = runs.find((candidate) => candidate.headSha === headSha);
if (!run) {
  console.log("missing\t\t");
} else if (run.status !== "completed") {
  console.log(`pending\t${run.databaseId || ""}\t${run.url || ""}`);
} else if (run.conclusion !== "success") {
  console.log(`failed\t${run.databaseId || ""}\t${run.url || ""}`);
} else {
  console.log(`success\t${run.databaseId || ""}\t${run.url || ""}`);
}
NODE
  )"
  IFS=$'\t' read -r state run_id run_url <<<"$result"
  case "$state" in
    success)
      log_step "Exact-SHA CI passed in run ${run_id}"
      ;;
    pending)
      echo "error: CI run ${run_id} for ${head_sha} is still in progress" >&2
      [[ -n "$run_url" ]] && echo "run: ${run_url}" >&2
      return 1
      ;;
    failed)
      echo "error: CI run ${run_id} for ${head_sha} did not succeed" >&2
      [[ -n "$run_url" ]] && echo "run: ${run_url}" >&2
      return 1
      ;;
    *)
      echo "error: no main-branch CI push run exists for exact commit ${head_sha}" >&2
      echo "hint: wait for CI to start and finish, then rerun this command" >&2
      return 1
      ;;
  esac
}

verify_existing_remote_tag() {
  local remote_main_sha remote_tag_commit_sha remote_tag_object_sha local_tag_object_sha tagged_version
  remote_tag_commit_sha="$(remote_tag_commit)"
  [[ -n "$remote_tag_commit_sha" ]] || return 1
  remote_tag_object_sha="$(remote_tag_object)"
  if ! remote_tag_signature_valid "$remote_tag_object_sha"; then
    echo "error: remote tag ${tag} is not signed by a repository-authorized signer" >&2
    exit 1
  fi

  local_tag_object_sha="$(git rev-parse --verify "refs/tags/${tag}" 2>/dev/null || true)"
  if [[ -n "$local_tag_object_sha" && "$local_tag_object_sha" != "$remote_tag_object_sha" ]]; then
    echo "error: local and remote tag objects differ for ${tag}" >&2
    exit 1
  fi
  if [[ -z "$local_tag_object_sha" ]]; then
    run_step "Adopting verified remote tag ${tag}" \
      git fetch --quiet --force --no-tags "$remote" "refs/tags/${tag}:refs/tags/${tag}"
  fi

  tagged_version="$(version_at_ref "$tag")"
  if [[ "$tagged_version" != "$version" ]]; then
    echo "error: remote tag ${tag} contains package version ${tagged_version:-unknown}" >&2
    exit 1
  fi
  remote_main_sha="$(remote_ref_commit "refs/heads/main")"
  run_step "Fetching ${remote}/main for ancestry verification" git fetch --quiet "$remote" main
  if ! git merge-base --is-ancestor "$remote_tag_commit_sha" "$remote_main_sha"; then
    echo "error: remote tag ${tag} is not reachable from ${remote}/main" >&2
    exit 1
  fi

  cat <<EOF
Release tag ${tag} is already published from verified commit ${remote_tag_commit_sha}.
The tag-triggered workflows own archive validation and publication.
EOF
}

version=""
remote="origin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      shift
      [[ $# -gt 0 ]] || {
        echo "error: --remote requires a value" >&2
        exit 1
      }
      remote="$1"
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

if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "error: git remote not found: $remote" >&2
  exit 1
fi

tag="v${version}"
release_branch="release/${tag}"
release_commit_message="chore(release): bump version to ${version}"
branch="$(git symbolic-ref --quiet --short HEAD || true)"

if verify_existing_remote_tag; then
  exit 0
fi

current_version="$(package_version)"
if [[ -z "$current_version" ]]; then
  echo "error: could not read Kova version from package.json" >&2
  exit 1
fi
"${script_dir}/validate-version-metadata.mjs" "$current_version"

case "$branch" in
  main)
    require_clean_checkout
    remote_main_sha="$(remote_ref_commit "refs/heads/main")"
    head_sha="$(git rev-parse HEAD)"
    if [[ -z "$remote_main_sha" || "$head_sha" != "$remote_main_sha" ]]; then
      echo "error: local main must exactly match ${remote}/main before release work" >&2
      exit 1
    fi

    if [[ "$current_version" == "$version" ]]; then
      if ! release_commit_subject_matches "$(git log -1 --pretty=%s)" ||
        ! release_commit_is_version_only; then
        echo "error: ${version} is on main, but HEAD is not the expected squash-merged release commit" >&2
        exit 1
      fi
      verify_exact_main_ci "$head_sha"

      local_tag_object_sha="$(git rev-parse --verify "refs/tags/${tag}" 2>/dev/null || true)"
      if [[ -n "$local_tag_object_sha" ]]; then
        log_step "Using existing local tag ${tag}"
      else
        release_signing_key="$(resolve_release_signing_key)"
        log_step "Using repository-authorized release key"
        log_step "Creating signed tag ${tag}; git signing may prompt here"
        git -c gpg.format=ssh -c user.signingkey="$release_signing_key" tag -s "$tag" -m "$tag"
      fi
      if [[ "$(git rev-list -n1 "$tag")" != "$head_sha" ]]; then
        echo "error: local tag ${tag} does not point at the release commit" >&2
        exit 1
      fi
      if ! tag_signature_valid "$tag"; then
        echo "error: local tag ${tag} is not signed by a repository-authorized signer" >&2
        exit 1
      fi
      run_step "Pushing signed tag ${tag}" git push "$remote" "$tag"
      cat <<EOF
Release tag ${tag} pushed from ${head_sha}.
The tag-triggered workflows will validate the archive and publish the release.
EOF
      exit 0
    fi

    if git show-ref --verify --quiet "refs/heads/${release_branch}"; then
      echo "error: local branch ${release_branch} already exists; switch to it and rerun" >&2
      exit 1
    fi
    run_step "Creating ${release_branch}" git switch -c "$release_branch"
    ;;
  "$release_branch")
    ;;
  *)
    echo "error: run from main or ${release_branch} (current: ${branch:-detached})" >&2
    exit 1
    ;;
esac

dirty="$(tracked_dirty_files)"
if [[ -n "$dirty" && "$dirty" != $'package-lock.json\npackage.json' ]]; then
  echo "error: release branches may contain only package.json and package-lock.json changes" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

if [[ "$current_version" != "$version" ]]; then
  if [[ -n "$dirty" ]]; then
    echo "error: package metadata is already dirty but does not contain ${version}" >&2
    exit 1
  fi
  run_step "Updating package metadata to ${version}" "${script_dir}/update-version.sh" "$version"
fi
"${script_dir}/validate-version-metadata.mjs" "$version"

release_commit_ready=0
if [[ "$(git log -1 --pretty=%s)" == "$release_commit_message" ]] &&
  release_commit_is_version_only &&
  [[ -z "$(tracked_dirty_files)" ]]; then
  release_commit_ready=1
fi

if [[ "$release_commit_ready" -eq 0 ]]; then
  run_step "Staging package metadata" git add package.json package-lock.json
  if git diff --cached --quiet -- package.json package-lock.json; then
    echo "error: no version changes remain to commit" >&2
    exit 1
  fi
  run_step "Creating release commit" git commit -m "$release_commit_message"
elif [[ -n "$(tracked_dirty_files)" ]]; then
  echo "error: release commit exists but package metadata is still dirty" >&2
  exit 1
else
  log_step "Release commit already exists"
fi

release_branch_is_version_only
run_step "Pushing ${release_branch}" git push --set-upstream "$remote" "$release_branch"
pr_url="$(ensure_release_pr)"

cat <<EOF
Release pull request ready: ${pr_url}

Next:
  1. Squash-merge ${release_branch} into main.
  2. Update local main to the merged commit.
  3. Wait for the exact main-branch CI run to pass.
  4. Rerun: scripts/release.sh ${version} --remote ${remote}
EOF
