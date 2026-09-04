#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_tools docker jq cast npx

started_container=""
cleanup_started_container() {
  local status=$?
  if [[ -n "$started_container" ]]; then
    echo "local stack startup failed; removing the container it launched" >&2
    docker rm --force "$container_name" >/dev/null 2>&1 || true
    rm -f "$state_file"
  fi
  exit "$status"
}
trap cleanup_started_container ERR INT TERM

docker info >/dev/null

if container_exists && ! container_is_ours; then
  echo "A container named $container_name already exists and was not started by this stack." >&2
  exit 1
fi

if container_exists; then
  docker rm --force "$container_name" >/dev/null
fi

local_image="$(image_reference)"
immutable_image="$(immutable_image_reference)"
if ! docker image inspect "$local_image" >/dev/null 2>&1; then
  docker pull "$immutable_image"
  docker tag "$immutable_image" "$local_image"
fi

image_manifest="$(docker run --rm --entrypoint /bin/cat "$local_image" /usr/local/share/base-anvil/MANIFEST.json)"
jq -e --argjson lock "$(cat "$toolchain_lock")" '
  .base.sha == $lock.baseNative.baseCommit and
  .base_anvil.sha == $lock.baseNative.baseAnvilCommit and
  .base_std.sha == $lock.baseNative.baseStdSmokeCommit
' >/dev/null <<<"$image_manifest"

mkdir -p "$state_directory"
started_container="$(
  docker run --detach \
    --name "$container_name" \
    --label "$container_label" \
    --publish "$local_rpc_host:$local_rpc_port:8545" \
    "$local_image" \
    --base --host 0.0.0.0 --port 8545 --chain-id "$local_chain_id"
)"

deadline=$((SECONDS + 90))
observed_chain_id=""
while [[ $SECONDS -lt $deadline ]]; do
  observed_chain_id="$(rpc_chain_id)"
  [[ -n "$observed_chain_id" ]] && break
  sleep 1
done

if [[ "$observed_chain_id" != "$local_chain_id" ]]; then
  echo "The launched node never reported chain $local_chain_id on $local_rpc_url (saw '${observed_chain_id:-nothing}')" >&2
  docker logs "$container_name" 2>&1 | tail -20 >&2
  exit 1
fi

observed_genesis="$(genesis_hash)"
if [[ -z "$observed_genesis" ]]; then
  echo "The launched node did not return a genesis block" >&2
  exit 1
fi

jq -n \
  --arg container "$container_name" \
  --arg image "$local_image" \
  --arg rpcUrl "$local_rpc_url" \
  --arg genesisHash "$observed_genesis" \
  --argjson chainId "$local_chain_id" \
  '{container: $container, image: $image, rpcUrl: $rpcUrl, chainId: $chainId, genesisHash: $genesisHash}' \
  >"$state_file"

if [[ "$(rpc_chain_id)" != "$local_chain_id" || "$(genesis_hash)" != "$observed_genesis" ]]; then
  echo "The node behind $local_rpc_url is not the process this script launched; refusing to deploy" >&2
  exit 1
fi

rm -rf "$repository_root/contracts/broadcast/DeployTestFixtures.s.sol/$local_chain_id"
run_base_forge script script/DeployTestFixtures.s.sol:DeployTestFixtures \
  --rpc-url "http://127.0.0.1:8545" \
  --unlocked \
  --sender "$local_deployer_address" \
  --broadcast \
  --slow

npx prettier --write "$repository_root/contracts/deployments/local-31337.generated.json" >/dev/null
npx tsx "$repository_root/scripts/contracts/manifest-from-broadcast.ts"
npx prettier --write "$repository_root/contracts/deployments/local-31337.json" >/dev/null
(cd "$repository_root" && npm run --silent contracts:check-manifests)

manifest_vault="$(jq -r '.vaultAddress' "$repository_root/contracts/deployments/local-31337.json")"
manifest_runtime_hash="$(jq -r '.runtimeBytecodeHash' "$repository_root/contracts/deployments/local-31337.json")"
deployed_runtime_hash="$(cast keccak "$(cast code --rpc-url "$local_rpc_url" "$manifest_vault")")"
if [[ "$deployed_runtime_hash" != "$manifest_runtime_hash" ]]; then
  echo "The vault runtime bytecode on $local_rpc_url does not match the generated manifest" >&2
  exit 1
fi
# `cast call` refuses base-anvil's `base` network family, so the allowlist proof uses raw `eth_call`.
true_word="0x0000000000000000000000000000000000000000000000000000000000000001"
while IFS= read -r fixture_address; do
  supported_call="$(cast calldata 'supportedStock(address)' "$fixture_address")"
  supported="$(cast rpc --rpc-url "$local_rpc_url" eth_call \
    "{\"to\":\"$manifest_vault\",\"data\":\"$supported_call\"}" latest | jq -r .)"
  if [[ "$supported" != "$true_word" ]]; then
    echo "The deployed vault does not support manifest fixture $fixture_address" >&2
    exit 1
  fi
done < <(jq -r '.stocks[].address' "$repository_root/contracts/deployments/local-31337.json")

trap - ERR INT TERM
started_container=""
echo "local stack up on $local_rpc_url (chain $local_chain_id, genesis $observed_genesis)"
