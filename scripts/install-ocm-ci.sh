#!/usr/bin/env bash
set -euo pipefail

version="v0.2.46"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset="ocm-x86_64-unknown-linux-gnu.tar.gz"
    expected_sha256="8981ec7937532f324c477b30c239dcd7f5ed60c32fe5dedde5fccd9d4ffbd739"
    ;;
  Darwin:arm64)
    asset="ocm-aarch64-apple-darwin.tar.gz"
    expected_sha256="ff25d72ad60b04937b0646b8017b128e03b7ba2f7534a1bd9cd2a5bd3aabf5d4"
    ;;
  *)
    echo "unsupported OCM CI platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
archive_path="$tmp_dir/$asset"
curl -fsSL "https://github.com/openclaw/ocm/releases/download/$version/$asset" -o "$archive_path"
actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "OCM checksum mismatch for $asset" >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$tmp_dir"
install -d "$HOME/.local/bin"
install -m 0755 "$tmp_dir/ocm" "$HOME/.local/bin/ocm"
