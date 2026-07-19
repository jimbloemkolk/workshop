# Design — Remote Calling

Decision record (2026-07-05, revised same day). [INTENT.md](INTENT.md) says
*why*; this says *how*. When the two disagree, intent wins. The media-stack
decisions (LiveKit, SFU-only, no client fallback recording, one server) were
taken at intent level and are not re-litigated here.

## Placement: a harvester package, one process

- Calling is a workspace package, **`@workshop/harvester-call`** (this
  directory — `packages/harvester/*` is already a pnpm glob), but it runs
  *inside* the harvester backend process. One process, one SQLite DB, one
  session model, one markers table, one review/export flow.
- Why not a separate app: everything runs on one server, so a handoff
  protocol, a versioned manifest, a second DB and a second web app would be
  pure ceremony between two processes on the same disk. The harvester
  backend already is the orchestrator — it shells out to the transcriber
  CLI and drives the pipeline; with calling it additionally drives LiveKit
  via `livekit-server-sdk` and receives its webhooks. (The manifest-versioning
  open question from the intent dissolves with this decision.)
- **Dependency direction is one-way: `backend → call → core`.** The naive
  split is circular (call needs the DB; backend needs call), so the shared
  floor moves *down* into a new leaf package **`@workshop/harvester-core`**
  (`packages/harvester/core`): the Drizzle schema + migrations, DB
  open/migrate, config loading, the transcript contract
  (types + helpers, today's `transcript.ts`), and the transcriber shell-out
  seam. Core imports no workspace package; call imports only core; backend
  imports both. When backend and call both need something, it moves down to
  core — never sideways.
- The schema stays **unified in core**, including call-only tables
  (`track_segments`, `gaps`, `harvest_spans`, the new marker columns): the
  package split is by behavior, not by table ownership, and one migration
  chain beats two.
- The call package owns everything call-shaped: room/token management, the
  webhook receiver (a Fastify plugin the backend mounts), egress control,
  track-segment bookkeeping, the events log and gap derivation, the call
  socket handlers (marks), the ingest step (per-track transcription via the
  core seam, merge, playback master), and the call `doctor` checks. What it
  needs from its host — emitting server events, advancing a finished
  session into the generic pipeline — arrives as a narrow injected
  interface (`{ emit, enterPipeline }`), not an import: that inversion is
  what keeps the graph acyclic as the package grows.
- The backend keeps what is genuinely generic: local recording, harvest /
  review / export, the HTTP + socket server. Harvest-span merging lives
  backend-side with its consumer (it applies to local sessions too); it
  moves to core the day call code needs it.
- Call views stay in `harvester/web` — one frontend app; `/join/<id>` is
  just a standalone route.
- LiveKit config is optional: without `LIVEKIT_URL` the backend never
  mounts the call plugin and the harvester behaves exactly as today
  (laptop, avfoundation). One codebase, two deployment shapes.
- A call session is a normal session with `origin: call` and lifecycle
  `calling → transcribing → harvesting → reviewing → exported` — the
  labeling stage disappears because track identity *is* the speaker.

## Session, rooms & tokens

- Session ids reuse the `YYYY-MM-DD-<4 char suffix>` convention. LiveKit
  room name = session id.
- "Start a call": one button → backend creates the session and mints **two
  LiveKit tokens with fixed identities** (`jim`, `jesse`), returning two
  labeled join links (`/join/<sessionId>#<token>`). Creator taps their own;
  the other is one tap to copy into any messenger. The token rides the URL
  fragment, so it never hits proxy logs.
- **Identity = speaker attribution.** No accounts: the link you were sent
  *is* your identity. LiveKit refuses a second join with a connected
  identity, which catches accidentally swapped links. Small-rooms-later
  stays open (n links instead of 2) without paying for it now.
- Token TTL **12 h** — covers "shall we call tonight?" without becoming a
  standing credential. Rooms auto-create on first join with a 15-minute
  `emptyTimeout` backstop; a room may die and be recreated under the same
  name if both parties drop for long. The session id keys everything, so a
  session spanning multiple room instances is normal, not an error.
- A call **ends** when someone presses *End call* (server deletes the
  room), or automatically 30 min after `room_finished` with no rejoin.
  Ending triggers finalize (below).
- Backend crash mid-call is survivable by construction: the room and its
  egresses live in the LiveKit containers and keep recording. On restart
  the backend re-syncs active rooms/egresses from the server API; clients'
  sockets reconnect and flush queued marks.

## Recording

- **Track Egress per published audio track**, started by the backend on the
  `track_published` webhook — recording needs no client cooperation beyond
  joining. Output: Opus/Ogg 48 kHz, one file per track publication, written
  into the session dir (volume shared with the egress container).
- A reconnect that re-publishes (resume failed, client rejoined) yields a
  new egress file. A participant's recording is therefore an **ordered list
  of track segments**, each with a timeline offset (`trackSegments` table:
  session, participant, file, startS, durationS). Nothing assumes
  one-file-per-participant.
- Timeline: **t0 = earliest egress start**. All marks, gaps and segment
  offsets are seconds relative to t0. Raw epoch-ms events append to
  `events.jsonl` in the session dir for audit.
- Finalize (on call end): wait for outstanding `egress_ended` webhooks,
  verify every egress landed a readable file, derive gap spans, then enter
  the normal pipeline at `transcribing`. A missing or failed egress file
  puts the session in `failed` with a precise error — never silently
  partial.

## Marks: dual-mode spans, multi-participant, merged for harvest

- **One big thumb-height button** (spacebar on desktop), two modes:
  - **Quick tap** (< ~400 ms) toggles: first tap opens a span, next tap
    closes it. The UI shows a loud "marking…" state while open.
  - **Long press** is press-and-hold: release closes. Same span data,
    chosen by grip and situation.
  A span still open at call end auto-closes with the existing `unclosed`
  flag; toggles left open beyond 10 min additionally get flagged for
  review attention (probably a forgotten toggle, still harvested).
- Marks go over socket.io and are **server-stamped** onto the timeline —
  the same key-event pattern as local recording. If the socket is down
  (uplink gap), the client queues edges with local epoch time and flushes
  on reconnect, flagged `client-stamped`; best effort, since a mark during
  a gap is already suspect.
- **Raw marks are per-participant and sacred.** The markers table gains
  `participant` (nullable — local sessions stay null) and `mode`
  (`hold | toggle`). Each participant has at most one open span; their
  button reflects only their own state.
- **Merging is a derivation, stored distinctly.** At harvest, ok-flagged
  spans from all participants union into merged regions (overlapping or
  within a 2 s join gap), persisted as `harvest_spans` rows that record
  their member marker ids. The harvester consumes merged spans — one agent
  turn per region, so both parties marking the same moment yields one
  insight proposal, not a duplicate pair — and the prompt notes when a
  region was marked by both (a strength signal). Insights reference the
  harvest span, which links back to the raw marks; re-deriving spans never
  touches markers. Local sessions derive trivially (one span per marker),
  keeping one code path.
- Post-call marking is the existing review flow (select words → manual
  insight) — the secondary mode costs zero new work.

## Gap spans

- Raw feed: every LiveKit webhook (`participant_joined/left`,
  `track_published/unpublished`, `egress_*`) plus client-reported signals
  over socket.io (SDK `Reconnecting`/`Reconnected`, connection-quality
  changes) appended to `events.jsonl` as they arrive. Client signals are
  additive garnish; webhooks alone must suffice.
- At finalize, events reduce to `gaps` rows `{startS, endS, participant,
  direction: uplink | downlink | both, cause}`. v1 derivation is
  conservative: a participant's track unpublishing is an `uplink` gap for
  them until re-publish; client-reported reconnecting states refine
  `downlink`/`both` when present. The schema carries the full directional
  model; heuristics sharpen with real train calls without schema changes.
- Pipeline semantics: `renderIndexedTranscript` inserts a
  `--- connection gap (<who>, <n>s) ---` line where a span falls, and
  proposals whose word range overlaps a gap are flagged for review
  attention. With zero gap rows, rendering is byte-identical to today —
  the degradation contract from the intent.

## Ingest: per-track transcription, merged transcript

- **Per-track, no diarization**: each track segment → ffmpeg to 16 kHz mono
  WAV (deleted after use) → transcriber CLI **without** `--diarize`.
  Segments are transcribed as recorded — not silence-padded — so Whisper
  never sees long dead air to hallucinate into.
- **Merge step** (new, pure, unit-tested): offset each word by its
  segment's timeline offset, set `speaker` to the participant identity,
  interleave all tracks' words by start time, reindex gap-free, rebuild
  segments, write a standard `transcript.json` — same contract shape — so
  anchoring, harvesting, review, playback and export run **unchanged**
  downstream. Speakers rows are created pre-assigned from identities.
- Playback master `recording.flac`: each track padded to the timeline
  (`adelay`) and `amix`ed to 48 kHz mono FLAC. Review playback and clip
  export work as today.
- The transcriber ASR backend becomes deployment config
  (`HARVESTER_TRANSCRIBER_BACKEND`): `mlx` on the laptop, `ct2` on the
  Linux server — the CLI supports both; only the hardcoded default moves
  to config.

## Solo/table recording (`origin: local`)

The original harvester recorded via `ffmpeg -f avfoundation` directly on the
machine the backend ran on — a design that assumed a laptop at the table. It
broke once the backend moved to the homelab (no mic there), so it was
retired: recording at the table now rides the exact same LiveKit machinery
as calling, just with a roster of one.

- **One publisher, fixed identity `table`** (`SOLO_IDENTITY`), alongside the
  two-party `IDENTITIES = ['jim', 'jesse']`. `startRecording()` and
  `startCall()` both go through a private `createRoom(linkBase, origin,
  roster, title)` — the only difference is the roster and `origin` (`'call'`
  vs `'local'`) written to the session. `links()`/token-minting read the
  roster back via `rosterFor(session)` rather than a hardcoded constant.
- **`origin: 'local'` keeps its old meaning** ("recorded at the table") —
  it's the capture mechanism that changed, not what the field means. A
  session's `origin` decides which finalize/ingest branch it takes; nothing
  else needed a new status value (`local` rooms use `calling` while open,
  same as `call` rooms).
- **Webhook and crash-resync guards accept both origins**: `handleWebhook`,
  `resyncActiveCalls` and `links()` all originally hard-checked
  `origin === 'call'` — those became `'call' | 'local'` checks. Getting this
  wrong silently drops all webhooks for a solo room (it would never start
  recording) or leaves it un-resynced after a backend crash.
- **`finalize()` branches only at the very end**: egress verification,
  `track_segments` bookkeeping, mark-shifting and gap derivation are already
  roster-agnostic (they loop over however many egresses/segments exist), so
  none of that changed. Only the tail branches:
  - `origin: 'call'` → `ingest()` (unchanged: per-track no-diarize
    transcribe, `mergeTrackTranscripts`, pre-assigned speakers,
    `host.enterPipeline`).
  - `origin: 'local'` → `ingestRecording()`: build the normal playback
    master with the same `mixPlaybackMaster` calls uses (works unmodified
    for one identity across however many reconnect segments), then call
    `host.transcribeSession(sessionId)` instead of `ingest`/`enterPipeline`.
- **`CallHost` gained `transcribeSession`**, wired in `backend/src/main.ts`
  to `HarvesterService.transcribeSession` — the same diarize-on
  transcribe → unassigned `storeSpeakers` → status `labeling` path
  `importSession` already used. No transcription/labeling logic was
  duplicated into the call package: `mixPlaybackMaster` writes
  `recording.flac` at exactly the path `transcribeSession` already reads
  from, so the host call is a plain handoff.
- **Labeling stage returns for `local` sessions** (diarized speaker labels
  are anonymous — a human still has to assign them), unlike `call` sessions
  where track identity already is the speaker.
- **Recording now requires `LIVEKIT_URL`** — there is no capture mechanism
  left that doesn't. Reviewing/harvesting/exporting already-recorded
  sessions is unaffected either way.

## Storage & retention

- Call sessions use the normal session dir: `sessions/<id>/` with
  `tracks/<identity>.<n>.ogg`, `events.jsonl`, `transcript.json`,
  `recording.flac`, `clips/`. No manifest — SQLite is the source of truth,
  as everywhere in the harvester.
- **Ogg is the archival master; nothing is auto-deleted in v1** ("a
  conversation is unrepeatable"). Two-track Opus is ~50 MB/hour — disk is
  cheaper than regret. Derived WAVs are temporary; a `prune` command can
  come later if disk pressure ever appears.

## Deployment & verification

- Docker Compose on the homelab: `app` (the harvester backend + built web),
  `livekit`, `egress`, `redis`, behind the existing reverse proxy,
  reachable only on the tailnet. Egress writes into a volume mounted at the
  same path in `app` (`HARVESTER_DATA_DIR`). Webhook target is `app` on the
  compose network; API key/secret via env. Redis exists solely as the
  LiveKit↔egress message bus (a hard requirement of running egress);
  nothing of ours reads or writes it.
- Media ports: LiveKit's UDP range over the tailnet, TCP fallback enabled
  (trains love hostile networks). No TURN in v1 — tailscale provides
  reachability; revisit only if a real call fails without it.
- Server prerequisites the laptop got for free, now explicit: the
  transcriber env (uv, ct2 backend) on the server; Claude Code logged in on
  the server for the Agent SDK; `HARVESTER_VAULT_DIR` pointing at a synced
  vault path. `doctor` grows checks for all three plus: LiveKit/egress/
  redis reachable, token mint round-trip, webhook secret validates,
  egress-volume path writable and shared.
- `e2e --call`: create a room, join two headless bot participants publishing
  the say-synthesized dialogue (one voice each), toggle-mark and hold-mark,
  drop one bot mid-call to produce a gap, end call — assert two-plus track
  files, a merged attributed transcript, the spans and the gap. The whole
  loop minus human ears.
- `e2e --table`: the solo counterpart — one bot, identity `table`, speaking
  *both* voices mixed onto its one track (`mixPcm`) — assert the room
  diarizes them back into 2+ speakers, the session lands in `labeling`
  (never `reviewing` directly), then label → harvest → assert insights.
- Day-1 spike (before building on assumptions): verify egress behavior
  across an SDK resume vs. a full rejoin (one file or two?), and measure
  webhook timing for gap-edge fidelity. The track-segment model absorbs
  either answer.

## Conventions

- New env (all optional; absence disables calling): `LIVEKIT_URL`,
  `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `HARVESTER_PUBLIC_URL` (join-link
  base), `HARVESTER_TRANSCRIBER_BACKEND` (default `mlx`).
- Pre-join lobby: mic picker (`enumerateDevices`) with live level meter;
  output picker via `setSinkId` where supported — iOS Safari doesn't
  support it, so on iPhone output routing stays with the OS (receiver /
  speaker / headset), which is fine. In-call: mute, device switch
  (`switchActiveDevice`), the mark button, connection state, End call.
  Browser defaults for echo cancellation / noise suppression / AGC stay on.
- `/join/<id>` is a standalone route that works without the rest of the
  harvester UI — it's what the shared link opens on a phone.
