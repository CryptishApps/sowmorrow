#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../local" && pwd)/common.sh"
require_tools docker jq cast

observed_chain_id="$(rpc_chain_id)"
if [[ "$observed_chain_id" != "$local_chain_id" ]]; then
  echo "No local chain $local_chain_id on $local_rpc_url; run 'npm run local:up' first." >&2
  exit 2
fi

FOUNDRY_PROFILE=integration \
run_base_forge test \
  --fork-url "http://127.0.0.1:8545" \
  --match-path 'test/fixtures/LocalNodeIntegration.t.sol' \
  "$@"
