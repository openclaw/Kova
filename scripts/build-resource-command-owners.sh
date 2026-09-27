#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
temporary_dir="$(mktemp -d "${repo_root}/.resource-command-owner.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

for output_architecture in x64 arm64; do
  if [[ "$output_architecture" == "x64" ]]; then
    image="ghcr.io/rust-cross/rust-musl-cross@sha256:fb7229c2a7dd84957e3a46f8bec7d01c4ec7c295ad159606623093a0a9286253"
    compiler="x86_64-unknown-linux-musl-gcc"
  else
    image="ghcr.io/rust-cross/rust-musl-cross@sha256:c9403b20663fca32f703b4201672120d8a634d5ebcaf95d013f0140382432a17"
    compiler="aarch64-unknown-linux-musl-gcc"
  fi
  docker run --rm --platform linux/amd64 -v "${repo_root}:/work" -w /work "$image" \
    "$compiler" -std=c11 -Wall -Wextra -Werror -Os -static -s -Wl,--build-id=none \
    support/resource-command-owner.c -o "${temporary_dir#${repo_root}/}/resource-command-owner-${output_architecture}"
  payload="${temporary_dir}/resource-command-owner-${output_architecture}.b64"
  gzip -9 -n -c "${temporary_dir}/resource-command-owner-${output_architecture}" | base64 | tr -d '\n' > "$payload"
  printf '\n' >> "$payload"
  committed="${repo_root}/support/bin/linux-${output_architecture}/resource-command-owner.b64"
  if [[ "${1:-}" == "--check" ]]; then
    cmp "$payload" "$committed"
  else
    mkdir -p "$(dirname "$committed")"
    cp "$payload" "$committed"
  fi
  shasum -a 256 "${temporary_dir}/resource-command-owner-${output_architecture}"
done
