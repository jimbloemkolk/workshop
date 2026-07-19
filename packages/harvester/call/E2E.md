# Running the e2e suite against the real stack

A runbook for actually exercising `e2e --call` / `e2e --table` on this
machine — not what they verify (that's [DESIGN.md](DESIGN.md#deployment--verification)),
but how to get them running and what to do when they don't. Written after a
first real run of `e2e --table` (2026-07-18) alongside a regression pass of
`e2e --call` and the plain `e2e`.

## Before touching anything: check for contention

This machine runs parallel Claude sessions in sibling worktrees
(`repo.git.voip`, `repo.git.void-sonnet`, …) that all resolve to the **same**
Docker Compose project name (derived from the directory `packages/harvester`,
identical in every worktree) and the same default `HARVESTER_DATA_DIR` and
port `4747`. Bringing the stack up from one worktree can silently recreate
another session's containers with different secrets — see
[ISSUES.md #1](ISSUES.md#1-parallel-worktree-sessions-fight-over-shared-machine-state-big)
for what that looked like the first time it happened. Before starting:

```sh
docker ps -a --format 'table {{.Names}}\t{{.Status}}'   # anything harvester-* already Up?
lsof -i :4747                                            # is a dev backend or another e2e run using it?
```

If containers are already `Up`, someone (a sibling session, or you five
minutes ago) is using the stack — coordinate before running `docker compose
up` or an `e2e --call`/`e2e --table` run, both of which bind port 4747
themselves (`e2e --call`/`--table` start their own server on the webhook
port — that's the whole reason they insist the dev backend be stopped
first).

## Bring the stack up

```sh
cd packages/harvester
docker compose up -d          # redis, livekit, egress — reads .env for HARVESTER_DATA_DIR
```

`.env` (gitignored) needs `HARVESTER_DATA_DIR` set — the repo's dev one is
already there. `backend/.env` needs the matching `LIVEKIT_URL` /
`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` triple — also already present for
local dev. If Docker Desktop itself isn't running yet: `open -a Docker`,
then poll `docker info` until it responds (took ~20s cold).

Confirm readiness:

```sh
pnpm --filter @workshop/harvester-backend run doctor
```

Expect `livekit reachable`, `token mint round-trip`, `webhook receiver
configured`, `egress volume path writable` all `[ok]`. `HARVESTER_VAULT_DIR`/
`HARVESTER_PUBLIC_URL` warnings are fine to ignore for e2e purposes.

## Run the suite

Three variants, cheapest/fastest first. Use `--no-llm` unless you're
specifically checking harvest quality — it swaps in a fixture harvester
instead of burning a real Agent SDK turn:

```sh
# pure pipeline (transcribe → label → harvest → export), no LiveKit involved
pnpm --filter @workshop/harvester-backend run e2e -- --no-llm

# two-party call: two rtc-node bots, a mid-call drop (gap), per-track transcript
pnpm --filter @workshop/harvester-backend run e2e -- --call --no-llm

# solo/table recording: one bot speaking BOTH dialogue voices mixed onto one
# track, asserts diarization + the labeling stage (added 2026-07-18 when the
# old avfoundation local-capture path was retired in favor of this)
pnpm --filter @workshop/harvester-backend run e2e -- --table --no-llm
```

Each prints `[ok]`/`[FAIL]` per assertion and a final `<variant> e2e
passed|FAILED`. All three passed cleanly against this stack on 2026-07-18
(`--call`: 3 track files incl. jesse's rejoin, gap, spans, 2 insights;
`--table`: 1 track, 2 diarized speakers, labeling reached, 2 insights).

Requires on `PATH`: `ffmpeg`, macOS `say` with at least one `nl_NL`/`nl_BE`
voice installed (System Settings → Spoken Content) — both e2e variants
synthesize their dialogue with it — and, for non-`--no-llm` runs, `claude`
logged in (Agent SDK auth rides it).

## Cleanup

`e2e --call`/`e2e --table` sandbox their session data **under the real
`HARVESTER_DATA_DIR`**, not a system temp dir — egress can only write inside
the volume already shared with the containers (`ISSUES.md #4`). They do
**not** delete it afterward. Look for `call-e2e-*`/`table-e2e-*` folders and
`rm -rf` the ones you created once you're done inspecting them:

```sh
ls ~/.local/share/harvester/ | grep -e2e
```

The plain `e2e` (no `--call`/`--table`) uses a real OS temp dir and cleans up
via the OS as usual — nothing to do there.

Leaving `docker compose` containers running between sessions is fine (they
sit idle); `docker compose stop` if you want them off, `docker compose down`
to also drop the containers (volumes/named data survive either way since
they're bind mounts to `HARVESTER_DATA_DIR`, not compose volumes).

## Troubleshooting

- **`cannot listen on :4747 — stop the dev backend first`**: something else
  already owns the port — a `pnpm dev`/`serve` instance, or another e2e run
  (yours or a sibling worktree's). `lsof -i :4747` to find it.
- **LiveKit join hangs / "negotiation timed out"**: usually a
  `livekit-server` vs. `livekit-client` protocol mismatch after either gets
  bumped — see [ISSUES.md #11](ISSUES.md#11-browser-negotiation-timed-out--livekit-client-20-vs-server-v18-2026-07-12).
  The rtc-node bots don't always catch this; if in doubt, do one real
  two-browser-tab call too.
- **`no Dutch \`say\` voices installed`**: System Settings → Spoken Content →
  add a Dutch voice (any of `nl_NL`/`nl_BE`), no restart needed.
- **Diarization finds only 1 speaker in `--table`** (should be 2): check the
  mixed PCM actually has both voices — `mixPcm` amixes `dialogue.pcm.get('jim')`
  and `.get('jesse')` from `synthesizeDialogue`; a regression in either of
  those would silently produce a single-voice track that still "passes" the
  webhook/egress plumbing but fails diarization.
- **Token signature invalid despite the HMAC checking out locally**: a
  sibling worktree's `docker compose up` recreated your containers with its
  own secrets — see the contention section above.
