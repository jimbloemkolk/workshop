#!/usr/bin/env bash
# Build the harvester app image and (optionally) push it to the Forgejo
# registry, tagged with the current git short sha.
#
#   ./build-image.sh                    # build :<sha> only
#   ./build-image.sh --latest           # also tag :latest
#   ./build-image.sh --push             # build, then push :<sha>
#   ./build-image.sh --push --latest    # push both tags (what auto-update pulls)
#   ./build-image.sh --remote ...       # build on the remote podman connection
#                                       # (default "lab"): layers, cache and
#                                       # pushed bytes stay server-side; only
#                                       # the build context uploads (kept small
#                                       # by the repo-root .dockerignore)
#
# One-time setup for --remote:
#   lab$ systemctl --user enable --now podman.socket
#   mac$ podman system connection add lab \
#          ssh://jim@lab.diplodocus-decibel.ts.net/run/user/1000/podman/podman.sock
#
# Pushing needs a one-time login where the push runs. Note the lab cannot
# reach its own :443 (hairpin — see deploy/HOMELAB.md), so remote pushes go
# through the high port; the package in Forgejo is the same either way:
#   podman -c lab login git.jimbloemkolk.nl
#   PUSH_IMAGE=git.jimbloemkolk.nl/jim/harvester ./build-image.sh --remote --push --latest
#
# Env overrides: IMAGE, TAG, ENGINE, CONNECTION (remote name), PUSH_IMAGE.
#
# Build targets x86_64 (torchcodec ships no linux/aarch64 wheels). On an
# Apple-Silicon Mac a local build needs a podman machine with rosetta=true
# and 8+ GB memory — or just use --remote.
set -euo pipefail

IMAGE=${IMAGE:-git.jimbloemkolk.nl/jim/harvester}
TAG=${TAG:-$(git rev-parse --short HEAD)}
ROOT=$(cd "$(dirname "$0")/../.." && pwd) # repo root = build context

push=0 latest=0 remote=0
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    --latest) latest=1 ;;
    --remote) remote=1 ;;
    *) echo "usage: $0 [--push] [--latest] [--remote]" >&2; exit 2 ;;
  esac
done

if (( remote )); then
  engine=(podman -c "${CONNECTION:-lab}")
else
  engine=(${ENGINE:-$(command -v podman || command -v docker)})
fi

tags=(-t "$IMAGE:$TAG")
(( latest )) && tags+=(-t "$IMAGE:latest")

"${engine[@]}" build --platform linux/amd64 \
  -f "$ROOT/packages/harvester/backend/Dockerfile" \
  "${tags[@]}" \
  "$ROOT"

if (( push )); then
  PUSH_IMAGE=${PUSH_IMAGE:-$IMAGE}
  for t in "$TAG" $( (( latest )) && echo latest ); do
    if [[ "$PUSH_IMAGE" != "$IMAGE" ]]; then
      "${engine[@]}" tag "$IMAGE:$t" "$PUSH_IMAGE:$t"
    fi
    "${engine[@]}" push "$PUSH_IMAGE:$t"
  done
  echo "pushed $PUSH_IMAGE:$TAG$( (( latest )) && echo ' and :latest')"
else
  echo "built $IMAGE:$TAG$( (( latest )) && echo ' (and :latest)') — rerun with --push to publish"
fi
