#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/../.." && pwd)"
requested_network="${1:-}"

if [[ -z "$requested_network" ]]; then
  case "${SOWMORROW_DEPLOYMENT_CHAIN_ID:-}" in
    8453) requested_network="base-mainnet" ;;
    84532) requested_network="base-sepolia" ;;
    *)
      echo "Pass base-mainnet|base-sepolia, or set SOWMORROW_DEPLOYMENT_CHAIN_ID to 8453 or 84532." >&2
      exit 2
      ;;
  esac
fi

case "$requested_network" in
  base-mainnet)
    expected_chain_id="8453"
    rpc_url="${BASE_MAINNET_RPC_URL:-}"
    manifest_path="$repository_root/contracts/deployments/base-mainnet-8453.json"
    ;;
  base-sepolia)
    expected_chain_id="84532"
    rpc_url="${BASE_SEPOLIA_RPC_URL:-}"
    manifest_path="$repository_root/contracts/deployments/base-sepolia-84532.json"
    ;;
  *)
    echo "Usage: $0 base-mainnet|base-sepolia" >&2
    exit 2
    ;;
esac

if [[ -z "$rpc_url" ]]; then
  echo "The RPC URL for $requested_network is not configured." >&2
  exit 2
fi

command -v cast >/dev/null
command -v jq >/dev/null

actual_chain_id="$(cast chain-id --rpc-url "$rpc_url")"
if [[ "$actual_chain_id" != "$expected_chain_id" ]]; then
  echo "RPC chain mismatch: expected $expected_chain_id, received $actual_chain_id" >&2
  exit 1
fi

b20_factory="0xB20f000000000000000000000000000000000000"
while IFS= read -r stock_address; do
  is_b20="$(cast call --json --rpc-url "$rpc_url" "$b20_factory" 'isB20(address)(bool)' "$stock_address" | jq -r '.[0] | tostring')"
  is_initialized="$(cast call --json --rpc-url "$rpc_url" "$b20_factory" 'isB20Initialized(address)(bool)' "$stock_address" | jq -r '.[0] | tostring')"
  precision="$(cast call --json --rpc-url "$rpc_url" "$stock_address" 'WAD_PRECISION()(uint256)' | jq -r '.[0]')"
  multiplier="$(cast call --json --rpc-url "$rpc_url" "$stock_address" 'multiplier()(uint256)' | jq -r '.[0]')"
  if [[ "$is_b20" != "true" || "$is_initialized" != "true" || "$precision" != "1000000000000000000" || "$multiplier" == "0" ]]; then
    echo "B20 validation failed for $stock_address" >&2
    exit 1
  fi
done < <(jq -r '.stocks[].address' "$manifest_path")

vault_address="$(jq -r '.vaultAddress // empty' "$manifest_path")"
if [[ -n "$vault_address" ]]; then
  deployment_block="$(jq -r '.deploymentBlock' "$manifest_path")"
  expected_runtime_hash="$(jq -r '.runtimeBytecodeHash' "$manifest_path")"
  expected_version="$(jq -r '.contractVersion' "$manifest_path")"
  expected_owner="$(jq -r '.owner.address' "$manifest_path" | tr '[:upper:]' '[:lower:]')"
  expected_creation_paused="$(jq -r '.expectedCreationPaused | tostring' "$manifest_path")"
  vault_code="$(cast code --rpc-url "$rpc_url" "$vault_address")"
  if [[ "$vault_code" == "0x" ]]; then
    echo "No vault bytecode at $vault_address" >&2
    exit 1
  fi
  deployment_code="$(cast code --rpc-url "$rpc_url" --block "$deployment_block" "$vault_address")"
  if [[ "$deployment_code" == "0x" ]]; then
    echo "No vault bytecode at the recorded deployment block" >&2
    exit 1
  fi
  actual_runtime_hash="$(cast keccak "$vault_code")"
  actual_version="$(cast call --json --rpc-url "$rpc_url" "$vault_address" 'VERSION()(string)' | jq -r '.[0]')"
  actual_owner="$(cast call --json --rpc-url "$rpc_url" "$vault_address" 'owner()(address)' | jq -r '.[0]' | tr '[:upper:]' '[:lower:]')"
  actual_creation_paused="$(cast call --json --rpc-url "$rpc_url" "$vault_address" 'creationPaused()(bool)' | jq -r '.[0] | tostring')"
  if [[ "$actual_runtime_hash" != "$expected_runtime_hash" || "$actual_version" != "$expected_version" || "$actual_owner" != "$expected_owner" || "$actual_creation_paused" != "$expected_creation_paused" ]]; then
    echo "Vault manifest validation failed for $vault_address" >&2
    exit 1
  fi
  if [[ "$requested_network" == "base-mainnet" ]]; then
    owner_code="$(cast code --rpc-url "$rpc_url" "$expected_owner")"
    if [[ "$owner_code" == "0x" ]]; then
      echo "The recorded mainnet owner is not a contract" >&2
      exit 1
    fi
  fi
  while IFS= read -r stock_address; do
    supported="$(cast call --json --rpc-url "$rpc_url" "$vault_address" 'supportedStock(address)(bool)' "$stock_address" | jq -r '.[0] | tostring')"
    if [[ "$supported" != "true" ]]; then
      echo "The vault does not support manifest stock $stock_address" >&2
      exit 1
    fi
  done < <(jq -r '.stocks[].address' "$manifest_path")
fi

echo "$requested_network read-only checks passed on chain $actual_chain_id"
