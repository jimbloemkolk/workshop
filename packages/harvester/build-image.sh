#!/usr/bin/env bash
# Build the harvester app image locally, tagged with the current git short sha.
#
#   ./build-image.sh                    # build :<sha> only
#   ./build-image.sh --latest           # also tag :latest
#   ./build-image.sh --remote ...       # build on the remote podman connection
#                                       # (default "lab"): layers/cache stay
#                                       # server-side; only the build context
#                                       # uploads (kept small by the repo-root
#                                       # .dockerignore)
#
# No registry push anymore — Jesse's applepie fork builds via a Quadlet Build unit
# directly on the box (packages/harvester/deploy/harvester/harvester-app.build,
# triggered by deploy.sh), not a build-here-push-there-pull-there pipeline. This script
# is now just a standalone/manual build tool (e.g. for a local sanity build before
# trusting the Quadlet build, or for Jim's own pods-experimental instance — see that
# stack's server-config README for its still-registry-based update flow, which this
# script alone no longer completes without a manual `podman push` of its own).
#
# One-time setup for --remote:
#   lab$ systemctl --user enable --now podman.socket
#   mac$ podman system connection add lab \
#          ssh://jim@lab.diplodocus-decibel.ts.net/run/user/1000/podman/podman.sock
#
# Env overrides: IMAGE, TAG, ENGINE, CONNECTION (remote name).
#
# Build targets x86_64 (torchcodec ships no linux/aarch64 wheels). On an
# Apple-Silicon Mac a local build needs a podman machine with rosetta=true
# and 8+ GB memory — or just use --remote.
set -euo pipefail

IMAGE=${IMAGE:-git.jimbloemkolk.nl/jim/harvester}
TAG=${TAG:-$(git rev-parse --short HEAD)}
ROOT=$(cd "$(dirname "$0")/../.." && pwd) # repo root = build context

latest=0 remote=0
for arg in "$@"; do
  case "$arg" in
    --latest) latest=1 ;;
    --remote) remote=1 ;;
    *) echo "usage: $0 [--latest] [--remote]" >&2; exit 2 ;;
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

echo "built $IMAGE:$TAG$( (( latest )) && echo ' (and :latest)')"
