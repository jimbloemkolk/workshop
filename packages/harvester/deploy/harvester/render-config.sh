#!/usr/bin/env bash
#
# render-config.sh — materialize the harvester config templates with the real LiveKit
# API secret. Runs ON THE BOX as the applepie tier user (ExecStartPre of
# harvester-livekit.container and harvester-egress.container) — Linux/bash-5/GNU; the
# macOS-portability rules do NOT apply here.
#
# Why: livekit-server and egress only take their key/secret from a config FILE, but the
# repo's secret mechanism is the podman secret store (values live in git nowhere). So
# the committed templates (config/*.tpl, placeholder __LIVEKIT_API_SECRET__) are
# rendered at every service start onto the user's tmpfs runtime dir — the secret never
# touches persistent disk, and a reboot (empty tmpfs) self-heals. Idempotent: both
# units run it; last writer wins with identical content.
#
# The value is substituted with bash string replacement, not sed/awk argv, so the
# secret never appears on a command line.
set -euo pipefail

src="/data/apps/applepie/harvester/config"
out="${XDG_RUNTIME_DIR:?}/harvester"

secret="$(podman secret inspect --showsecret --format '{{.SecretData}}' harvester-livekit-api-secret)"
[[ -n "$secret" ]] || { echo "render-config.sh: podman secret harvester-livekit-api-secret is empty/missing" >&2; exit 1; }

# Host-side secrecy comes from the 0700 dir (under the user's private tmpfs runtime
# dir); the FILES must be world-readable because the egress container runs as uid 1001
# (not container-root) and reads its bind-mounted config — 0600 files are root-only
# inside the container and egress dies with "open /etc/egress.yaml: permission denied".
umask 077
mkdir -p "$out"
for tpl in "$src"/*.tpl; do
	name="$(basename "${tpl%.tpl}")"
	content="$(<"$tpl")"
	printf '%s\n' "${content//__LIVEKIT_API_SECRET__/$secret}" >"$out/$name"
	chmod 644 "$out/$name"
done
