#!/usr/bin/env bash
set -euo pipefail

if ! command -v expect >/dev/null 2>&1; then
  case "$(uname -s)" in
    Linux)
      sudo apt-get update
      sudo apt-get install --no-install-recommends --yes expect
      ;;
    Darwin)
      brew install expect
      ;;
    *)
      echo "unsupported PTY test platform: $(uname -s)" >&2
      exit 1
      ;;
  esac
fi

expect -v
