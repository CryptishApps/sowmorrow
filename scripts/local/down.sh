#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_tools docker jq npx

if container_exists; then
  if container_is_ours; then
    docker rm --force "$container_name" >/dev/null
    echo "removed $container_name"
  else
    echo "A container named $container_name exists but was not started by this stack; leaving it alone." >&2
    exit 1
  fi
else
  echo "no $container_name container to remove"
fi

rm -f "$state_file"
rm -f "$repository_root/contracts/deployments/local-31337.generated.json"
rm -rf "$repository_root/contracts/broadcast/DeployTestFixtures.s.sol/31337"
npx tsx "$repository_root/scripts/contracts/manifest-from-broadcast.ts" --pending
npx prettier --write "$repository_root/contracts/deployments/local-31337.json" >/dev/null
echo "local stack down"
