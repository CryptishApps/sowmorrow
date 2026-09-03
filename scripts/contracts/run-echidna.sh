#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOL_ROOT="$REPOSITORY_ROOT/.cache/tools/echidna-2.3.3"
ARCHIVE="$TOOL_ROOT/echidna.tar.gz"
BINARY="$TOOL_ROOT/echidna"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    URL="https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-aarch64-macos.tar.gz"
    EXPECTED_SHA256="8e16a43d8c37b74365ef259ea986e074b8a717309f770c7ff3d1f9fb891a7902"
    ;;
  Darwin-x86_64)
    URL="https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-x86_64-macos.tar.gz"
    EXPECTED_SHA256="8fa994e6589ce00b548b0aa183e60b5e123e9d9ce7aae6a6228ea667eb5c0194"
    ;;
  Linux-aarch64|Linux-arm64)
    URL="https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-aarch64-linux.tar.gz"
    EXPECTED_SHA256="a8853108ac57a43b550c8053dd1cd760fcc5347a9c4c389135fa0ae82a69a221"
    ;;
  Linux-x86_64)
    URL="https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-x86_64-linux.tar.gz"
    EXPECTED_SHA256="436d26cb5af34c6c525812b857ac53f218c7f6ad07d69495ef88bc4cdc85c764"
    ;;
  *)
    echo "Unsupported Echidna platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$TOOL_ROOT"
if [[ ! -x "$BINARY" ]]; then
  curl --fail --location --silent --show-error "$URL" --output "$ARCHIVE"
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    echo "Echidna archive checksum mismatch" >&2
    exit 1
  fi
  tar -xzf "$ARCHIVE" -C "$TOOL_ROOT"
fi

cd "$REPOSITORY_ROOT/contracts"
rm -rf security/corpus security/reports/echidna-coverage
mkdir -p security/reports
ECHIDNA_LOG="$(mktemp "${TMPDIR:-/tmp}/sowmorrow-echidna.XXXXXX")"
trap 'rm -f "$ECHIDNA_LOG"' EXIT

set +e
FOUNDRY_BYTECODE_HASH=ipfs uv run --project security --frozen "$BINARY" test/EchidnaSowmorrowVault.sol \
  --contract EchidnaSowmorrowVault \
  --config security/echidna.yaml 2>&1 | tee "$ECHIDNA_LOG"
ECHIDNA_STATUS="${PIPESTATUS[0]}"
set -e

if grep -Fq '] Crashed:' "$ECHIDNA_LOG"; then
  echo "Echidna terminated with an internal crash" >&2
  exit 1
fi

exit "$ECHIDNA_STATUS"
