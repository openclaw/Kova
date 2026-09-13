#!/usr/bin/env bash
set -euo pipefail

version="v0.2.44"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset="ocm-x86_64-unknown-linux-gnu.tar.gz"
    expected_sha256="73c9ae077986bbb76e79cf1ded9ed285547124c045c91d08e4330552b7e805b0"
    ;;
  Darwin:arm64)
    asset="ocm-aarch64-apple-darwin.tar.gz"
    expected_sha256="5af02cca61951f3bad795e435871a337645cf95c247ac51eef4899fe066e2011"
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
