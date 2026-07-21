#!/usr/bin/env bash
#
# bootstrap.sh — post-deploy first-run checks for Jesse's harvester fork (applepie
# tier). Runs on the macOS control laptop (bash 3.2 + BSD userland — keep it portable).
# This does NOT deploy — run `./deploy.sh` (in this same deploy/ dir) first, which
# deploys caddy + harvester together; this script only does/checks the steps that have
# to happen AFTER the stack is up. dev-hub (the tier's tailnet machine + pod) is a
# separate stack deployed from server-config, not from here.
#
# What it does (idempotent, safe to re-run):
#   1. wait for the harvester-app container to come up
#   2. check the Claude Code login (Agent SDK auth for the harvest step); if missing,
#      offer to LAUNCH the interactive login for you
#   3. run the app's own `doctor` and show the report
#
# Env:
#   HOMELAB_HOST  ssh host/alias of the box   (default: lab; same var deploy.sh reads)
#
set -euo pipefail

BOX="${HOMELAB_HOST:-lab}"
TARGET="applepie@$BOX"                   # tier == the SSH/service user

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

rpodman() { ssh "$TARGET" "XDG_RUNTIME_DIR=/run/user/\$(id -u) podman $*"; }

# 1. Wait for the app container to answer an exec. Bounded retry loop instead of the
#    GNU-only `timeout` binary — portable on macOS.
log "Waiting for harvester-app to come up on $BOX …"
tries=0
until rpodman exec harvester-app true >/dev/null 2>&1; do
	tries=$((tries + 1))
	[ "$tries" -ge 30 ] && die "harvester-app not up after ~60s — is it deployed? (run: ./deploy.sh ; check: ssh $TARGET 'systemctl --user status harvester-app')"
	sleep 2
done

# 2. Claude Code login state lives in the harvester-claude volume (/root/.claude).
logged_in() { rpodman exec harvester-app test -s /root/.claude/.credentials.json >/dev/null 2>&1; }

if logged_in; then
	log "Claude Code login present."
elif { : >/dev/tty; } 2>/dev/null; then      # a terminal to run the login on?
	log "Claude Code is NOT logged in — the harvest step will fail until this one-time login is done."
	while :; do
		printf '  Launch the interactive login now? [y/n] > ' >&2
		IFS= read -r ans </dev/tty || ans=n
		case "$ans" in
			y|Y)
				log "Opening claude inside harvester-app — complete the /login browser flow,"
				log "then EXIT claude (Ctrl-C twice, or /exit) to hand control back to this script."
				ssh -t "$TARGET" 'XDG_RUNTIME_DIR=/run/user/$(id -u) podman exec -it harvester-app claude /login' || true
				if logged_in; then
					log "Login verified — credentials persist in the harvester-claude volume."
					break
				fi
				log "Still not logged in (no credentials file appeared) — try again?"
				;;
			n|N)
				log "Skipped — the stack runs, but harvest will fail. Re-run this script when ready."
				break
				;;
			*) : ;;
		esac
	done
else
	log "Claude Code is NOT logged in, and there is no TTY here to run the login."
	log "Re-run bootstrap.sh from a terminal, or do it by hand:"
	log "  ssh -t $TARGET 'XDG_RUNTIME_DIR=/run/user/\$(id -u) podman exec -it harvester-app claude'   -> /login"
fi

# 3. The app's own health check.
log "Running doctor (expected non-green in a container: avfoundation/mic) …"
rpodman exec harvester-app pnpm exec tsx src/main.ts doctor || true

log "Done. App: https://harvester.staging.applepie.company   LiveKit signal: wss://livekit-harvester.staging.applepie.company"
log "Reminder: if --node-ip in harvester-livekit.container ever needs updating (the"
log "dev-hub node re-joined the tailnet from scratch), get the new IP from"
log "server-config's homelab/quadlet/applepie/dev-hub/bootstrap.sh, then redeploy here."
