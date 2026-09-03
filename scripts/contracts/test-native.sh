#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/../.." && pwd)"
image_repository="ghcr.io/base/base-anvil"
image_tag="sha-2114980688558cbb2505fc42cb0f2b9e641cc8db"
image_digest="sha256:d834bcd07858170c8803b1022f051fbcb346ccd8d033126cc683e357646278e4"
local_image="$image_repository:$image_tag"
immutable_image="$image_repository@$image_digest"

command -v docker >/dev/null
command -v jq >/dev/null
docker info >/dev/null

if ! docker image inspect "$local_image" >/dev/null 2>&1; then
  docker pull "$immutable_image"
  docker tag "$immutable_image" "$local_image"
fi

image_manifest="$(docker run --rm --entrypoint /bin/cat "$local_image" /usr/local/share/base-anvil/MANIFEST.json)"
jq -e '
  .base.sha == "2114980688558cbb2505fc42cb0f2b9e641cc8db" and
  .base_anvil.sha == "3983d1f5c13592c5074bb47df67fa58f1295d758" and
  .base_std.sha == "4571b325c1b9c4d6e21c59d2b7f9b4b60f62ec7c"
' >/dev/null <<<"$image_manifest"

docker run --rm \
  --entrypoint /usr/local/bin/forge \
  -e FOUNDRY_BASE=true \
  -v "$repository_root:/src" \
  -w /src/contracts \
  "$local_image" \
  test "$@"
