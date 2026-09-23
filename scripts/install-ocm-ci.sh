#!/usr/bin/env bash
set -euo pipefail

version="v0.2.47"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset="ocm-x86_64-unknown-linux-gnu.tar.gz"
    expected_sha256="05e0bb598fe391c75fe7668e159d7eb09168b4298b5d8d0999786e79e97d0642"
    ;;
  Darwin:arm64)
    asset="ocm-aarch64-apple-darwin.tar.gz"
    expected_sha256="53a1fe66324624a8fd5e81adb16eae656a8e1c627c6bc3b242bca4cbbe0a583e"
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
