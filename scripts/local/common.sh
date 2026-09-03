#!/usr/bin/env bash
# Shared configuration for the scoped Sowmorrow local stack. Sourced, never executed.

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_directory/../.." && pwd)"
toolchain_lock="$repository_root/contracts/toolchain.lock.json"

container_name="sowmorrow-base-anvil"
container_label="sowmorrow.local-stack=owned"
state_directory="$repository_root/.cache/local-stack"
state_file="$state_directory/state.json"

local_chain_id="31337"
local_rpc_host="127.0.0.1"
local_rpc_port="${SOWMORROW_LOCAL_RPC_PORT:-8545}"
local_rpc_url="http://$local_rpc_host:$local_rpc_port"

# Anvil development account 0. The local node exposes it only on loopback as an unlocked account.
local_deployer_address="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || {
      echo "Required tool not found on PATH: $tool" >&2
      exit 2
    }
  done
}

image_reference() {
  local repository tag
  repository="$(jq -r '.baseNative.repository' "$toolchain_lock")"
  tag="$(jq -r '.baseNative.tag' "$toolchain_lock")"
  echo "$repository:$tag"
}

immutable_image_reference() {
  local repository digest
  repository="$(jq -r '.baseNative.repository' "$toolchain_lock")"
  digest="$(jq -r '.baseNative.indexDigest' "$toolchain_lock")"
  echo "$repository@$digest"
}

container_is_ours() {
  local label
  label="$(docker inspect --format '{{index .Config.Labels "sowmorrow.local-stack"}}' "$container_name" 2>/dev/null || true)"
  [[ "$label" == "owned" ]]
}

container_exists() {
  docker container inspect "$container_name" >/dev/null 2>&1
}

rpc_chain_id() {
  cast chain-id --rpc-url "$local_rpc_url" 2>/dev/null || true
}

genesis_hash() {
  cast block 0 --json --rpc-url "$local_rpc_url" 2>/dev/null | jq -r '(.data.hash // .hash) // empty'
}

# Upstream Foundry refuses the `base` network family that base-anvil advertises, so every RPC-facing
# Foundry invocation runs the pinned image's own `forge` inside the node's network namespace.
run_base_forge() {
  docker run --rm \
    --entrypoint /usr/local/bin/forge \
    --network "container:$container_name" \
    --env FOUNDRY_BASE=true \
    --env "FOUNDRY_PROFILE=${FOUNDRY_PROFILE:-default}" \
    --volume "$repository_root:/src" \
    --workdir /src/contracts \
    "$(image_reference)" \
    "$@"
}
