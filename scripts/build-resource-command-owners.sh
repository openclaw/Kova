#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
image="alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
temporary_dir="$(mktemp -d "${repo_root}/.resource-command-owner.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

for architecture in amd64 arm64; do
  output_architecture="$architecture"
  if [[ "$architecture" == "amd64" ]]; then
    output_architecture="x64"
  fi
  mkdir -p "${repo_root}/support/bin/linux-${output_architecture}"
  docker run --rm --platform "linux/${architecture}" \
    -v "${repo_root}:/work" -w /work "$image" sh -c \
    "apk add --no-cache build-base >/dev/null && cc -std=c11 -Wall -Wextra -Werror -Os -static -s -Wl,--build-id=none support/resource-command-owner.c -o ${temporary_dir#${repo_root}/}/resource-command-owner-${output_architecture}"
  gzip -9 -n -c "${temporary_dir}/resource-command-owner-${output_architecture}" | base64 \
    > "${repo_root}/support/bin/linux-${output_architecture}/resource-command-owner.b64"
  shasum -a 256 "${temporary_dir}/resource-command-owner-${output_architecture}"
done
