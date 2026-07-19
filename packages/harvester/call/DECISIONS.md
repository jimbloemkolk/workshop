# Decisions — implementation session 2026-07-05/06

Decisions **made during the build** that INTENT/DESIGN/IMPLEMENTATION left
open (or that filled gaps those documents didn't anticipate). Anything
already settled there is not repeated. Ordered roughly by phase.

## Workspace & config

- **TS-source workspace packages, no build step.** `core` and `call` expose
  `exports: { ".": ./src/index.ts }` (single barrel). tsx resolves and
  compiles TS straight out of node_modules symlinks; tsc reads the same
  file for types. No dist, no sub-path exports until something needs them.
- **Dotenv layering:** core owns `loadDotenv(extraDirs)`; search order is
  cwd → host package root(s) → core root; existing environment always wins.
  The backend passes its own package root; call relies on the host having
  loaded env first (documented in `config.ts`).
- **`LIVEKIT_PUBLIC_URL` added to CallConfig** (default = `LIVEKIT_URL`).
  Decision 3 fixed the env list, but browsers must dial LiveKit at an
  address that can diverge from the compose-internal one the backend uses.
  Optional, additive; both dev shapes work without it.
- **`markerMinMs` is read twice** (backend Config and CallConfig) from the
  same `HARVESTER_MARKER_MIN_MS` env var, rather than widening the settled
  CallHost interface or moving it into core config. Same knob, same value,
  two readers.
- **Join-link base falls back to the request origin** when
  `HARVESTER_PUBLIC_URL` is unset — makes dev links correct with zero
  config, on localhost and tailnet IPs alike.

## Media stack & timeline

- **Same-path volume contract:** compose mounts
  `${HARVESTER_DATA_DIR}:${HARVESTER_DATA_DIR}` (interpolated from
  `packages/harvester/.env`), so a backend-side absolute path is a valid
  egress-side filepath *verbatim* — in dev exactly like on the homelab. No
  path-mapping config exists anywhere.
- **Segment anchoring = `endedAt − ffprobe(file).duration`** (both ends
  precise), not egress `startedAt` (≈1 s early — egress startup, measured
  in the spike). t0 = earliest segment start.
- **Marks are stamped live against a provisional t0** (earliest egress
  `startedAt`) and **shifted onto the refined timeline at finalize**;
  results clamp to ≥ 0. Marks pressed before any egress runs stamp at 0.
- **`track_segments` rows are written only at finalize**, after the
  never-silently-partial verification. During the call, recorder state
  lives in memory + `events.jsonl`; crash recovery rebuilds it from the
  log plus the LiveKit server API (`egress_requested` log entries carry
  the file naming so `seq` survives a restart).
- **Egress participants are filtered by the `EG_` identity prefix**
  (observed in the spike), applied in webhooks, gap derivation and the
  join-page UI.
- **Track-file naming `tracks/<identity>.<n>.ogg`** with a per-participant
  counter, assigned by us via `DirectFileOutput` (not `{track_id}`
  templates) so filenames are human-readable and rejoin order is legible.

## Marks

- **Mode is decided client-side and sent on the `up` edge** — the server
  sees identical down/up edges for both gestures and cannot distinguish a
  tap from a hold; `markers.mode` stays null until the span closes.
- **MarkButton gesture spec:** press < 400 ms = tap (span stays open,
  toggle); ≥ 400 ms = hold (release closes). Window blur closes the span
  only while physically pressing — an open *toggle* span deliberately
  survives blur/screen-lock (that's its point on mobile).
- **Offline queue lives in the join page**, flushes on socket reconnect,
  capped at 200 edges server-side; a flush arriving before any egress
  (no provisional t0) is dropped — there is no timeline to stamp against.
- **Call sockets get their handlers inside the call package**
  (`io.on('connection')` + `socket.data.call` set by the verification
  middleware); the backend's local handlers explicitly skip call sockets.
  Mark payloads carry no session/identity, per decision 7.
- **The end-call route is unauthenticated**, consistent with every other
  API route: security rides the tailnet (INTENT). A leaked join link
  grants LiveKit access anyway; adding auth to one route buys nothing.

## Ingest & harvest

- **Merge interleaving uses an "order time" carry:** unaligned words
  inherit their predecessor's time so they never drift from their
  neighbors; stable sort keeps within-track order on ties.
- **Rebuilt segments split on speaker change or a >2 s same-speaker
  pause** — sentence granularity from the per-track transcripts is not
  preserved (it doesn't survive interleaving anyway).
- **Playback master:** `adelay=<offset>:all=1` per track + `amix
  normalize=0` (no volume drop), 48 kHz mono FLAC.
- **Speakers rows:** label = identity (`jim`), `participantId` matched by
  lower-cased display name against the participants table.
- **Span derivation runs inside `harvestSession`** (wipe + re-derive on
  every harvest, including re-harvests), includes `unclosed` marks with an
  end, and the schema's `insights.markerId → harvestSpanId` rename landed
  with the phase-2 schema while the write-side plumbing landed in phase 5 —
  a deliberate transient since all phases shipped in one session.
- **Review-attention flags are computed client-side** in ReviewView from
  `sessionDetail` extras (gaps, harvestSpans + memberIds): overlaps-gap and
  >10-min-toggle. Nothing stored, per the settled assumption.
- **Gap-line prompt note is conditional** — the harvest intro explains
  `--- connection gap ---` lines only when gaps exist, keeping the
  zero-gap prompt byte-identical to today's.

## Verification & deploy

- **`e2e --call` orchestration lives in the backend** (it needs
  HarvesterService; dependency direction forbids call → backend); the
  speaking bots live in the call package with a *dynamic* import of
  `@livekit/rtc-node` (a devDependency never loaded by `serve`).
- **The call e2e sandboxes its data dir under the real
  `HARVESTER_DATA_DIR`** — the egress container can only write inside the
  shared volume, so `os.tmpdir()` sandboxes are impossible by design.
- **Doctor proves reachability/validity only** (LiveKit API round-trip,
  token mint/verify, secret pair, volume writable); the egress *worker* is
  only provable by actually recording — that's `e2e --call`'s job.
- **Dockerfile runs the backend from source via tsx** (same as dev, no
  build step for the JS), bakes the uv-synced transcriber env with
  `HARVESTER_TRANSCRIBER_BACKEND=ct2`, and bakes the Claude Code CLI; login
  state is a mounted volume. Image is x86_64-only (torchcodec wheels).
- **One commit per phase**, each carrying its verification story in the
  commit message.
