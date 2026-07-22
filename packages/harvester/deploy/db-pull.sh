#!/usr/bin/env bash
#
# db-pull.sh — copy the DEPLOYED harvester SQLite DB off the applepie box down to this
# machine, so you can test locally against real staging data. The reverse direction of
# deploy.sh, over the same Tailscale-SSH-into-dev-hub entry point (root@applepie.<tailnet
# domain>.ts.net); see deploy.sh's header for why "root" here is dev-hub's userns root,
# not real host root, and why no XDG_RUNTIME_DIR/`id -u` juggling is needed for podman.
#
# The DB is a single SQLite file (harvester.db) at the root of the harvester-data volume,
# mounted at /srv/harvester/data inside the harvester-app container (the same-path volume
# contract — see harvester-app.container / harvester.env HARVESTER_DATA_DIR). It runs in
# WAL mode, so the newest committed rows can still live in harvester.db-wal rather than
# the main file. We therefore stream harvester.db* (db + -wal + -shm together, whichever
# exist) out of the running container via `tar`, which is the WAL-safe way to snapshot a
# live SQLite DB with no downtime and no `sqlite3` binary (the image ships none). SQLite
# recovers cleanly from the copied WAL on the next open.
#
# The pulled DB lands in this machine's default data dir (~/.local/share/harvester, or
# $HARVESTER_DATA_DIR), where the local backend reads it. Any DB already there is backed
# up first (timestamped .bak). On the next `serve`, openDb's migrate() brings the pulled
# DB up to your working copy's schema — forward-only, so a staging DB that predates a
# local migration just gets it applied.
#
# This pulls the DB ONLY. Recordings and transcripts live beside it under sessions/ in
# the same volume and are large (audio); pass --with-sessions to stream those too — you
# need them for audio playback and for spoken_at to resolve to real spoken times rather
# than the accept-time fallback.
#
# Usage:
#   ./db-pull.sh                    # DB only, into the default data dir
#   ./db-pull.sh --with-sessions    # DB + all session recordings/transcripts (big)
#   ./db-pull.sh /path/to/datadir   # DB into a sandbox dir (leaves your default untouched;
#                                   #   run the app with HARVESTER_DATA_DIR=/path/to/datadir)
#
# Env:
#   HOMELAB_HOST        ssh host/alias of dev-hub (default: applepie.diplodocus-decibel.ts.net)
#   HARVESTER_DATA_DIR  local destination data dir (default: ~/.local/share/harvester);
#                       a positional dir arg overrides it
#
set -euo pipefail

# Same reason as deploy.sh: macOS forwards LANG/LC_* over SSH (SendEnv), which trips
# "cannot change locale" warnings on dev-hub. Clear them here so ssh has nothing to send.
unset LANG LC_ALL LC_CTYPE LC_NUMERIC LC_TIME LC_COLLATE LC_MONETARY LC_MESSAGES \
      LC_PAPER LC_NAME LC_ADDRESS LC_TELEPHONE LC_MEASUREMENT LC_IDENTIFICATION

BOX="${HOMELAB_HOST:-applepie.diplodocus-decibel.ts.net}"
TARGET="root@$BOX"
CONTAINER=harvester-app
REMOTE_DATA=/srv/harvester/data

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# --- args --------------------------------------------------------------------------
WITH_SESSIONS=0
DEST="${HARVESTER_DATA_DIR:-$HOME/.local/share/harvester}"
for arg in "$@"; do
	case "$arg" in
		--with-sessions) WITH_SESSIONS=1 ;;
		-h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; exit 0 ;;
		-*) die "unknown flag: $arg" ;;
		*) DEST="$arg" ;;
	esac
done

# --- pull --------------------------------------------------------------------------
command -v ssh >/dev/null || die "ssh not found"
mkdir -p "$DEST"

# Back up an existing local DB before overwriting — the pull replaces harvester.db.
if [ -f "$DEST/harvester.db" ]; then
	bak="$DEST/harvester.db.bak-$(date +%Y%m%d-%H%M%S)"
	cp "$DEST/harvester.db" "$bak"
	log "backed up existing DB -> $bak"
fi

log "pulling harvester.db from $CONTAINER on $BOX -> $DEST"
# `podman exec` (no -it) yields a clean binary tar stream; harvester.db* grabs the WAL
# sidecars too when present. pipefail (set above) surfaces a remote-side failure.
ssh "$TARGET" "podman exec $CONTAINER sh -c 'cd $REMOTE_DATA && tar cf - harvester.db*'" \
	| tar xf - -C "$DEST"

[ -s "$DEST/harvester.db" ] || die "pull produced no harvester.db — is $CONTAINER running?"

if [ "$WITH_SESSIONS" = 1 ]; then
	log "pulling session recordings/transcripts (this can be large)…"
	ssh "$TARGET" "podman exec $CONTAINER sh -c 'cd $REMOTE_DATA && [ -d sessions ] && tar cf - sessions || true'" \
		| tar xf - -C "$DEST"
fi

# --- report ------------------------------------------------------------------------
size="$(du -h "$DEST/harvester.db" | cut -f1)"
log "done — harvester.db ($size) in $DEST"
if command -v sqlite3 >/dev/null; then
	sessions="$(sqlite3 "$DEST/harvester.db" 'select count(*) from sessions' 2>/dev/null || echo '?')"
	insights="$(sqlite3 "$DEST/harvester.db" 'select count(*) from insights' 2>/dev/null || echo '?')"
	log "contains $sessions session(s), $insights insight(s)"
fi
[ "$WITH_SESSIONS" = 1 ] || log "DB only — pass --with-sessions for recordings/transcripts"
