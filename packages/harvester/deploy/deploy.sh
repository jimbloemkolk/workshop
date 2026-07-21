#!/usr/bin/env bash
#
# deploy.sh — push applepie stacks (caddy, harvester) to the homelab box over SSH, via
# Jesse's actual reachable entry point: Tailscale SSH into dev-hub (root@applepie.<tailnet
# domain>.ts.net) — the same path works for anyone on the tailnet, not just Jim, since
# it's a share/tailnet grant rather than a host-level account. Scoped-down cousin of
# server-config's homelab/quadlet/deploy.sh: single fixed tier, no admin-sudo channel, no
# backup.yml/digest.sh registration (those need that admin channel — see ../README.md
# § What's NOT here). dev-hub itself (the tier's tailnet machine/pod) is deployed from
# server-config, not from here — this script never touches it.
#
# "root" here is dev-hub's OWN container root, mapped by rootless podman's userns to the
# unprivileged applepie Linux user on the box — not real host root (see server-config's
# homelab/quadlet/applepie/dev-hub/README.md § Security model). No XDG_RUNTIME_DIR/`id -u`
# juggling for podman/systemctl calls below: dev-hub's own /etc/environment already
# points CONTAINER_HOST/DBUS_SESSION_BUS_ADDRESS at the right sockets for any login,
# and (unlike a raw host login) `id -u` inside dev-hub would report 0 (its own userns
# root), which is the WRONG uid for computing /run/user/<uid> paths against the real host.
#
# Per (stack) in {caddy, harvester}:
#   rsync deploy/<stack>/  ->  applepie@box:/data/apps/applepie/<stack>/ (bind-mounted
#     into dev-hub at the identical path — see dev-hub.container)
#   copy unit files -> /home/applepie/.config/containers/systemd/ (also bind-mounted;
#     NOT $HOME-relative, since $HOME for root-in-dev-hub is /root, not /home/applepie)
#   systemctl --user daemon-reload ; restart each container/pod/build unit
#
# harvester ALSO gets a second, bigger sync: harvester-app.build's Dockerfile needs the
# repo root as build context (root manifests + packages/harvester + packages/transcriber
# — see harvester-app.build's own comment), so that subset is synced separately to
# /data/apps/applepie/harvester-src/ before the restart. Built NATIVELY on the box (x86_64
# lab, x86_64-only Dockerfile) — no registry, no push.
#
# Usage:
#   ./deploy.sh                  # both stacks
#   ./deploy.sh caddy            # one stack
#   ./deploy.sh caddy harvester
#
# Secrets: each stack declares what it needs via `Secret=<name>,...` in its *.container
# units. Before restarting, deploy.sh reads those names, checks the applepie tier's
# podman store, and interactively resolves any missing ones (enter now / skip / recheck).
# Nothing secret is committed or written to disk.
#
# Images: before restarting, deploy pulls every registry Image= the deployed stacks
# reference (skipping *.build refs — those are unit names realised on the box, not
# registry pulls). A failed pull only warns; the restart proceeds on the local image.
#
# Env:
#   HOMELAB_HOST              ssh host/alias of dev-hub (default: applepie.diplodocus-decibel.ts.net)
#   HOMELAB_APPS_DIR          apps root on the box        (default: /data/apps)
#   DEPLOY_PROVISION_SECRETS  set to 0 to skip the secret pass (default: 1)
#   DEPLOY_PULL_IMAGES        set to 0 to skip the image-refresh pass (default: 1)
#
set -euo pipefail

# macOS's default ssh_config has `SendEnv LANG LC_*`, so whatever locale is set on the
# CALLER's machine (yours, or Jesse's — either could be running this) gets forwarded and
# overrides dev-hub's own container-level locale default (C.UTF-8) for that SSH session,
# surfacing as "cannot change locale" warnings when the remote doesn't have that locale's
# data generated. Clearing them HERE, in deploy.sh's own process, means ssh has nothing
# matching SendEnv's pattern to forward — regardless of whose machine or locale it is.
unset LANG LC_ALL LC_CTYPE LC_NUMERIC LC_TIME LC_COLLATE LC_MONETARY LC_MESSAGES \
      LC_PAPER LC_NAME LC_ADDRESS LC_TELEPHONE LC_MEASUREMENT LC_IDENTIFICATION

BOX="${HOMELAB_HOST:-applepie.diplodocus-decibel.ts.net}"
APPS_DIR="${HOMELAB_APPS_DIR:-/data/apps}"
TIER=applepie
TARGET="root@$BOX"
QDIR=/home/applepie/.config/containers/systemd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# List immediate subdirectory names of $1, one per line, sorted. Shell glob (not `find
# -printf`, GNU-only) — macOS ships BSD find.
subdirs() {
	local d
	( cd "$1" 2>/dev/null || return
	  shopt -s nullglob
	  for d in */; do printf '%s\n' "${d%/}"; done )
}

rpodman() { ssh "$TARGET" "podman $*"; }

# --- podman secret provisioning (interactive) -----------------------------------
secret_names() {  # stack...
	local stack f
	for stack in "$@"; do
		for f in "$SCRIPT_DIR/$stack"/*.container; do
			[ -e "$f" ] || continue
			sed -n 's/^Secret=\([^,]*\).*/\1/p' "$f"
		done
	done | awk 'NF && !seen[$0]++'
}

resolve_secret() {  # name
	local name="$1" ans v1 v2
	while :; do
		printf '\n\033[1;33mSecret\033[0m %s is not set on %s.\n' "$name" "$TARGET" >&2
		printf '  [e] enter now   [s] skip   [r] recheck (add via ssh, then continue) > ' >&2
		IFS= read -r ans </dev/tty || ans=s
		case "$ans" in
			e|E)
				printf '  value (hidden): ' >&2; IFS= read -rs v1 </dev/tty || v1=''
				printf '\033[2m(%d chars)\033[0m\n' "${#v1}" >&2
				printf '  again:          ' >&2; IFS= read -rs v2 </dev/tty || v2=''
				printf '\033[2m(%d chars)\033[0m\n' "${#v2}" >&2
				[ -n "$v1" ] || { printf '  empty — try again.\n' >&2; continue; }
				[ "$v1" = "$v2" ] || { printf '  mismatch (%d vs %d chars) — try again.\n' "${#v1}" "${#v2}" >&2; continue; }
				if printf '%s' "$v1" | rpodman secret create "$name" - >/dev/null 2>&1; then
					printf '  \033[1;32mcreated\033[0m %s\n' "$name" >&2; unset v1 v2; return 0
				fi
				printf '  create failed (already exists? choose recheck).\n' >&2 ;;
			s|S)
				printf '  \033[1;31mskipped\033[0m — %s stays missing; its container may fail to start.\n' "$name" >&2
				return 0 ;;
			r|R|'')
				if rpodman secret inspect "$name" </dev/null >/dev/null 2>&1; then
					printf '  \033[1;32mfound\033[0m %s\n' "$name" >&2; return 0
				fi
				printf '  still missing.\n' >&2 ;;
			*) : ;;
		esac
	done
}

provision_secrets() {  # stack...
	[ "${DEPLOY_PROVISION_SECRETS:-1}" = 1 ] || return 0
	local names name have_tty=1
	names="$(secret_names "$@")"
	[ -n "$names" ] || return 0
	{ : >/dev/tty; } 2>/dev/null || have_tty=0

	# The inspect probes MUST NOT inherit the loop's stdin — same footgun as
	# server-config's deploy.sh: rpodman is ssh, which forwards stdin.
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		rpodman secret inspect "$name" </dev/null >/dev/null 2>&1 && continue
		if [ "$have_tty" = 0 ]; then
			printf '\033[1;31mERR\033[0m secret %s missing and no TTY to prompt — create it: ssh %s '\''podman secret create %s -'\''\n' \
				"$name" "$TARGET" "$name" >&2
			continue
		fi
		resolve_secret "$name"
	done <<EOF
$names
EOF
	return 0
}

# --- image refresh (pull before restart) -----------------------------------------
image_names() {  # stack...
	local stack f
	for stack in "$@"; do
		for f in "$SCRIPT_DIR/$stack"/*.container; do
			[ -e "$f" ] || continue
			sed -n 's/^Image=//p' "$f"
		done
	done | awk 'NF && $0 !~ /\.(build|image)$/ && !seen[$0]++'
}

pull_images() {  # stack...
	[ "${DEPLOY_PULL_IMAGES:-1}" = 1 ] || return 0
	local names
	names="$(image_names "$@")"
	[ -n "$names" ] || return 0
	log "  refreshing images: $(printf '%s' "$names" | tr '\n' ' ')"
	printf '%s\n' "$names" | ssh "$TARGET" '
		while IFS= read -r img; do
			podman pull -q "$img" >/dev/null 2>&1 </dev/null \
				|| echo "  !! pull failed: $img — deploying the local copy" >&2
		done'
}

# --- live build output ------------------------------------------------------------
# `systemctl --user restart` triggers a unit's Build dependency but doesn't stream its
# log anywhere useful — the build happens, but silently as far as this script's caller
# can see (confirmed: the image DOES end up rebuilt, journalctl -u <name>-build.service
# just after a restart shows the full log). Run the equivalent `podman build` ourselves
# first, as a plain foreground SSH command — stdout of a foreground ssh command streams
# straight to the local terminal, no journal-tailing required. The restart's own
# automatic rebuild afterward is then just an instant cache-hit (identical content).
build_live() {  # image_tag  workdir  containerfile
	local tag="$1" workdir="$2" file="$3"
	log "Building $tag (live output) …"
	ssh "$TARGET" "podman build -f '$file' -t '$tag' '$workdir'" \
		|| die "build failed for $tag"
}

# --- harvester-app.build's build context (repo root subset) ----------------------
# Separate from the small per-stack sync below: the Dockerfile's context is the repo
# root, not deploy/harvester/. Three plain rsyncs (not one clever include/exclude
# filter) — simpler to get right, and macOS's ancient bundled rsync doesn't reliably
# support `**` glob excludes, so every pattern here is a plain basename match.
sync_build_context() {
	local dst="$APPS_DIR/$TIER/harvester-src"
	log "Syncing harvester-app.build's context (repo root subset) …"
	ssh "$TARGET" "mkdir -p '$dst/packages'"
	rsync -az \
		"$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/pnpm-workspace.yaml" \
		"$TARGET:$dst/" \
		|| die "sync of repo-root manifests failed"
	rsync -az --delete \
		--exclude=deploy --exclude=node_modules --exclude=dist --exclude=.env --exclude='*.log' \
		"$REPO_ROOT/packages/harvester/" "$TARGET:$dst/packages/harvester/" \
		|| die "sync of packages/harvester failed"
	rsync -az --delete \
		--exclude=.venv --exclude=__pycache__ --exclude=.env --exclude='*.log' \
		"$REPO_ROOT/packages/transcriber/" "$TARGET:$dst/packages/transcriber/" \
		|| die "sync of packages/transcriber failed"
}

# --- build the stack work list from args -----------------------------------------
declare -a stacks=()
if (($# == 0)); then
	while IFS= read -r s; do stacks+=("$s"); done < <(subdirs "$SCRIPT_DIR")
else
	for arg in "$@"; do
		[[ -d "$SCRIPT_DIR/$arg" ]] || die "unknown stack: $arg"
		stacks+=("$arg")
	done
fi
((${#stacks[@]})) || die "nothing to deploy"

log "Tier $TIER  (ssh $TARGET)  stacks: ${stacks[*]}"

ssh "$TARGET" "mkdir -p '$QDIR'" \
	|| die "cannot reach $TARGET — is dev-hub deployed and sharable (server-config's homelab/quadlet/applepie/dev-hub/)?"

for stack in "${stacks[@]}"; do
	rsync -az --delete "$SCRIPT_DIR/$stack/" "$TARGET:$APPS_DIR/$TIER/$stack/" \
		|| die "rsync $stack failed — is $APPS_DIR/$TIER user-owned?"
done

# Trigger each deployed stack's build LIVE, so the terminal actually shows progress.
for stack in "${stacks[@]}"; do
	case "$stack" in
		caddy)
			build_live localhost/applepie-caddy:latest "$APPS_DIR/$TIER/caddy" Containerfile
			;;
		harvester)
			sync_build_context
			build_live localhost/applepie-harvester-app:latest \
				"$APPS_DIR/$TIER/harvester-src" packages/harvester/backend/Dockerfile
			;;
	esac
done

provision_secrets "${stacks[@]}"
pull_images "${stacks[@]}"

# Apply on the host, as the applepie user (via dev-hub's bind-mounted CONTAINER_HOST /
# DBUS_SESSION_BUS_ADDRESS — no XDG_RUNTIME_DIR export needed here, see header).
ssh "$TARGET" 'bash -s' -- "$APPS_DIR/$TIER" "$QDIR" "${stacks[@]}" <<'REMOTE'
set -euo pipefail
apps_root="$1"; shift
QDIR="$1"; shift
mkdir -p "$QDIR"
shopt -s nullglob
deployed=("$@")

# 1. Install unit files into Quadlet's search directory.
for stack in "${deployed[@]}"; do
	src="$apps_root/$stack"
	[[ -d "$src" ]] || { echo "  !! $stack missing on host, skipping" >&2; continue; }
	for unit in "$src"/*.container "$src"/*.network "$src"/*.pod "$src"/*.volume "$src"/*.build; do
		cp -f "$unit" "$QDIR/"
	done
done

# 1b. Pre-create bind-mount source dirs — rootless podman auto-creates NONE (a missing
# one fails the unit with "statfs: no such file or directory"). Same idiom as
# server-config's deploy.sh.
for stack in "${deployed[@]}"; do
	src="$apps_root/$stack"
	[[ -d "$src" ]] || continue
	for unit in "$src"/*.container "$src"/*.volume; do
		[[ -e "$unit" ]] || continue
		while IFS= read -r hostdir; do
			[[ -n "$hostdir" ]] || continue
			mkdir -p "$hostdir" || echo "  !! could not create bind dir $hostdir" >&2
		done < <(sed -n \
			-e 's#^Volume=\(/data/appdata/[^:]*\):.*#\1#p' \
			-e 's#^Device=\(/data/[^[:space:]]*\).*#\1#p' "$unit")
	done
done

# 2. Regenerate the systemd services from the units (once).
systemctl --user daemon-reload

# 3. (Re)start the container/pod units. Quadlet's generated service names differ by
# unit type: foo.container -> foo.service, foo.pod -> foo-POD.service.
rc=0
for stack in "${deployed[@]}"; do
	src="$apps_root/$stack"
	for unit in "$src"/*.container "$src"/*.pod; do
		case "$unit" in
			*.pod) svc="$(basename "${unit%.*}")-pod.service" ;;
			*)     svc="$(basename "${unit%.*}").service" ;;
		esac
		echo "  ~ restart $svc"
		systemctl --user restart "$svc" \
			|| { echo "  !! $svc failed — see: journalctl --user -u $svc" >&2; rc=1; }
	done
done
exit $rc
REMOTE

log "Deploy complete."
