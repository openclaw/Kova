#!/usr/bin/env bash
set -euo pipefail

version="v0.2.33"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset="ocm-x86_64-unknown-linux-gnu.tar.gz"
    expected_sha256="06b0e46791e750eb044e4a898b6643ad5e7b20224fe0c64f160e35a42f08d00a"
    ;;
  Darwin:arm64)
    asset="ocm-aarch64-apple-darwin.tar.gz"
    expected_sha256="f7444dc4265a76ddb2563743bfd4ff2fb1dfa95a5850004f3ed7092ce487c275"
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
