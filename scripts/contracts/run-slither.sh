#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPOSITORY_ROOT/contracts"
mkdir -p security/reports
report_directory="$(mktemp -d)"
report_path="$report_directory/slither.json"
set +e
# The reviewed production surface is the vault alone. `src/fixtures` holds the chain-restricted
# test faucet, so it is filtered here alongside the library, test, and script trees.
uv run --project security --frozen slither . \
  --config-file slither.config.json \
  --filter-paths "lib|test|script|src/fixtures" \
  --json "$report_path"
set -e
npx tsx "$REPOSITORY_ROOT/scripts/contracts/check-slither-report.ts" "$report_path"
install -m 0644 "$report_path" security/reports/slither.json
