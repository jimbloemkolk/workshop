# Deploying the call stack

This repo covers two things: running the stack locally via Docker Compose,
and building/pushing the app image. Production deployment (homelab quadlet
units, reverse proxy/HTTPS, secrets, env templates) is owned by the
homelab/Ansible repo
(`server-config/homelab/quadlet/pods-experimental/harvester`) — see that
repo's README for the production path.

```sh
cd packages/harvester
docker compose --profile app up -d --build
```

## Env

`packages/harvester/.env`, next to the compose file:

```sh
HARVESTER_DATA_DIR=/srv/harvester/data        # same absolute path host+containers
HARVESTER_VAULT_DIR=/srv/vault/harvester      # synced vault folder
HARVESTER_PUBLIC_URL=http://localhost:4747
LIVEKIT_API_KEY=harvester
LIVEKIT_API_SECRET=<long random string — 32+ chars, v1.9 refuses shorter>
LIVEKIT_PUBLIC_URL=ws://localhost:7880        # what browsers dial
LIVEKIT_NODE_IP=127.0.0.1                     # only matters for cross-device calls
```

`LIVEKIT_NODE_IP` must be reachable by whatever's dialing in: LiveKit
advertises it in ICE candidates, and the wrong value makes calls join then
drop on a ~15 s loop. The compose file passes
`--node-ip ${LIVEKIT_NODE_IP:-127.0.0.1}`; the default only serves
same-device calls.

## Image platform

Build the app image **on the homelab (x86_64)** with
`packages/harvester/build-image.sh` (`--push` sends it to the Forgejo
registry). The transcriber's `torchcodec` dependency ships no linux/aarch64
wheels, so a cross-build from an Apple-Silicon Mac fails at `uv sync`
(everything before that layer is verified). If you must build on the Mac:
the script already passes `--platform linux/amd64` — it just runs under
emulation, slowly.

## Server prerequisites the laptop got for free

All three are checked by `doctor`:

1. **Transcriber env** — baked into the image (`uv sync`, ct2 backend via
   `HARVESTER_TRANSCRIBER_BACKEND=ct2`). Models download on first use into
   the container; mount a cache volume (`~/.cache/transcriber`) to keep
   them across rebuilds, and set `HF_TOKEN` for diarization of local/import
   sessions.
2. **Claude Code login** for the Agent SDK: mount a persistent volume at
   `/root/.claude` and log in once:
   `docker compose exec app claude` → `/login`.
3. **`HARVESTER_VAULT_DIR`** pointing at a synced vault path (mounted into
   the container at the same absolute path).

## Egress file ownership (Linux caveat)

On Docker Desktop (dev Mac) bind-mount writes arrive as the host user. On
native Linux the egress container writes as **its own uid**; make the data
dir writable for it (e.g. `chmod g+ws` with a shared gid, or run both
containers with matching `user:`). `e2e --call` proves the round-trip.

## Verify

```sh
docker compose exec app pnpm exec tsx src/main.ts doctor
# stop the app container first (the e2e listens on the webhook port itself):
docker compose stop app && pnpm --filter @workshop/harvester-backend run e2e -- --call --no-llm
```

Then the real thing: a two-device call over the compose stack lands in
review. (Cross-device/phone calls need HTTPS — see the homelab repo.) For
the full e2e runbook (both `--call` and `--table`, plus this machine's
parallel-worktree gotchas), see [E2E.md](E2E.md).
