# Implementation — Remote Calling

Boundary object from the planning session (2026-07-05). Read order:
[INTENT.md](INTENT.md) (why) → [DESIGN.md](DESIGN.md) (architecture) → this
(build order, implementation-level decisions, and codebase orientation).
When this disagrees with DESIGN, DESIGN wins; when DESIGN disagrees with
INTENT, INTENT wins. Nothing here re-states the other two documents —
if a subsystem seems underspecified, its spec is in DESIGN.md.

## Decisions taken at implementation level

These were resolved in the planning interview and are settled — do not
re-open them:

1. **Dev environment.** Docker runs on the dev Mac. One compose file at
   `packages/harvester/docker-compose.yml` with `livekit`, `egress`,
   `redis`; the homelab `app` service is added behind a compose profile so
   the same file serves both shapes. During dev the backend runs natively
   (`tsx`), containers provide only the media stack.
2. **Sequencing.** Core-package extraction happens *first*, as a pure
   refactor commit verified by the existing tests and `e2e` before any call
   code lands. The DESIGN day-1 spike runs *after* that, before feature
   phases. (This deliberately reorders DESIGN's "day-1" framing.)
3. **Config is layered, not unified.** Core owns `CoreConfig` and the
   dotenv loader: `dataDir`, `vaultDir`, `transcriberDir`,
   `transcriber {backend, model, language}` (backend now read from
   `HARVESTER_TRANSCRIBER_BACKEND`, default `mlx`), and the `sessionDir`
   helper. Backend extends it with `port`, `micDevice`, `model` (agent),
   `markerMinMs`, `clipPaddingMs`, `segmentSeconds`. Call defines its own
   `CallConfig | null` from `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, `HARVESTER_PUBLIC_URL` — `null` (no
   `LIVEKIT_URL`) means the call plugin is never mounted.
4. **`insights.markerId` is replaced by `insights.harvestSpanId`.** No
   data migration: the dev DB is purged — there is no data worth keeping.
5. **Fresh migration chain.** Delete the existing `drizzle/` migration and
   journal; generate a single `0000` from the final schema in core. While
   the project is pre-v1, further schema changes *regenerate* that single
   migration rather than appending — dev DBs are disposable.
6. **The dual-mode mark button is unified.** One `MarkButton` component
   (tap-toggle / press-hold, per DESIGN) used by both the call UI and the
   existing `RecordView` — local recording adopts toggle behavior too.
   `markers.mode` is recorded for local sessions; `markers.participant`
   stays null there.
7. **Socket mark auth = LiveKit token verification.** The join page passes
   its LiveKit token in the socket.io handshake `auth` payload; the backend
   verifies it with `TokenVerifier` from `livekit-server-sdk` and derives
   `{sessionId (= room name), identity}` server-side. Mark events carry
   **no** claimed identity or sessionId — attribution comes only from the
   verified handshake. Local-recording sockets (the existing UI) connect
   without a token and keep today's behavior.
8. **Frontend uses plain `livekit-client`.** No
   `@livekit/components-react`. Custom UI in the app's existing hand-rolled
   React style.

## Settled assumptions

Confirmed in the interview; implement as stated:

- **Auto-harvest for calls.** Call finalize → ingest → harvest runs
  automatically with the configured agent → session lands in `reviewing`.
  This is what `enterPipeline` in DESIGN's injected interface means: the
  call package calls it *after* ingest has written `transcript.json`,
  `recording.flac`, and pre-assigned `speakers` rows; the backend
  implements it as "run harvest now" (reuse `harvestSession`). Local
  sessions keep the manual harvest trigger after labeling — unchanged.
- **`sessions.origin`**: `local | import | call` (text, default `local`).
  `importSession` sets `import`.
- **Span membership** is a join table `harvest_span_members`
  `(harvestSpanId, markerId)`, not a JSON column. Spans and members are
  wiped and re-derived on each harvest; the derivation never touches
  `markers` rows.
- **No stored "attention" flags.** The >10-min-forgotten-toggle and
  proposal-overlaps-gap review flags are *derived* at review/harvest time
  (from `endS − startS` and the `gaps` table respectively). No new columns
  for them.
- **`markers.stampedBy`**: `server | client` (default `server`), set to
  `client` for offline-queued edges flushed on reconnect.
- **`runTranscriber` gains a `diarize` option.** Today it hardcodes
  `--diarize --min-speakers 2 --max-speakers 2`
  (`backend/src/transcribe.ts`); local/import sessions keep that, call
  tracks pass no diarize flags. Per-track transcription runs
  **sequentially** in v1 — the transcriber saturates the machine.
- **Backend serves the built web app** (static + SPA fallback) so `/join`
  links open on phones in production. Today `@fastify/static` is
  registered only for session audio with `serve: false`
  (`backend/src/server.ts`); add a second registration for `web/dist`.
  The vite dev-server flow stays as-is.
- **Secure context**: `getUserMedia` requires HTTPS off-localhost. Phone
  testing waits for the reverse-proxy/tailscale-cert deploy phase; local
  dev uses desktop `localhost`.

## Codebase orientation

Current layout (all under `packages/harvester/`):

- `backend/src/` — `config.ts` (env → `Config`, `sessionDir`),
  `db/{schema,index}.ts` (Drizzle + better-sqlite3, migrations at
  `backend/drizzle/`), `transcript.ts` (contract types,
  `renderIndexedTranscript`, `wordsInSpan`), `transcribe.ts` (uv shell-out
  seam), `util.ts` (`runFfmpeg`, `ffprobeDuration`, `sessionIdFor`),
  `recorder.ts` (ffmpeg/avfoundation local recording), `service.ts`
  (`HarvesterService` — all logic; emits `ServerEvent`s on an
  `EventEmitter`), `server.ts` (Fastify + socket.io adapters, thin),
  `anchor.ts` (verbatim verification), `harvest/` (Agent SDK client,
  harvester, prompts, fixture), `export/`, `doctor.ts`, `e2e.ts`,
  `main.ts` (subcommands `serve | doctor | e2e`).
- `web/src/` — React 19 + vite; `views/{RecordView,PipelineView,
  SessionList,LabelView,ReviewView}.tsx`, `socket.ts`, `api.ts`,
  `audio.ts`. Marks go over socket.io as `marker:down` / `marker:up`.
- Workspace globs already include `packages/harvester/*` — new `core/`
  and a `call/` package.json need no pnpm-workspace change.

**Moves to `core`** (`@workshop/harvester-core`, new): `db/` (schema +
open/migrate), the drizzle config + fresh migration, `transcript.ts`,
`transcribe.ts`, `util.ts`, and the core slice of `config.ts` (decision 3).
`anchor.ts`, `recorder.ts`, harvest, export stay in backend. Note
`db/index.ts` resolves the migrations folder via `packageRoot` from
`config.ts` — that coupling moves to core's own package root.

**Patterns to follow:** logic in a service class, Fastify/socket.io as thin
adapters; long-running work kicked off `void` with progress over
socket.io events; failures land the session in `failed` with a precise
error via `fail()`; re-entrant statuses after `transcribing`. The call
package should mirror this: a `CallService` owning state, a Fastify
plugin the backend mounts, socket handlers registered alongside the
existing `marker:*` ones.

## Schema delta (final state, one regenerated migration)

- `sessions` + `origin` (text, default `local`).
- `markers` + `participant` (text, null), `mode` (`hold | toggle`),
  `stampedBy` (`server | client`, default `server`). Existing `flag`
  semantics unchanged.
- `insights`: `markerId` → `harvestSpanId` (integer, null).
- New `track_segments`: `id, sessionId, participant, file` (session-dir
  relative), `startS` (timeline offset from t0), `durationS`, plus the
  egress id for webhook correlation.
- New `gaps`: `id, sessionId, participant, startS, endS, direction
  (uplink | downlink | both), cause` (per DESIGN).
- New `harvest_spans`: `id, sessionId, startS, endS` + derived metadata
  (e.g. participant count for the both-marked prompt signal).
- New `harvest_span_members`: `harvestSpanId, markerId`.

## Phases

Each phase is a coherent commit (or few) with its named verification.
Do them in order; later phases assume earlier ones.

**0 — Core extraction.** Create `core`, move the files above, split config,
regenerate the migration, purge dev DBs, update backend imports.
*Verify:* `pnpm test` in backend, `tsc --noEmit` everywhere, and
`e2e --no-llm` behave exactly as before.

**1 — Compose + spike.** Media stack up locally; throwaway scripts under
`call/spike/` (kept in-tree) answering DESIGN's two spike questions:
egress file behavior across SDK resume vs. full rejoin, and webhook timing
fidelity for gap edges. *Verify:* written findings in `call/spike/NOTES.md`
— phases 3–4 build on these answers.

**2 — Call skeleton.** `call` package (`@workshop/harvester-call`) with
`CallService` + Fastify plugin mounted only when `CallConfig` exists;
schema additions land; room/token endpoints (12 h TTL, identities
`jim`/`jesse`, links per DESIGN); web `/join/<id>#<token>` standalone
route with lobby (mic picker, level meter) and in-call UI (mute, device
switch, connection state, End call); socket handshake verification
(decision 7); backend serves `web/dist`. *Verify (milestone):* a real
two-device call over the tailnet — no recording yet.

**3 — Recording.** Webhook receiver (validate with the SDK's
`WebhookReceiver`), `events.jsonl` append, track egress per publication
into the shared volume, `track_segments` bookkeeping, t0 anchoring,
end-call (button + 30-min `room_finished` timer), boot-time re-sync of
active rooms/egresses, finalize with hard file verification (DESIGN's
never-silently-partial rule). *Verify:* end a two-party call → two-plus
`.ogg` track files + correct `track_segments` rows; kill the backend
mid-call → restart → recording survived and finalize succeeds.

**4 — Marks + gaps.** `MarkButton` component, adopted by RecordView and
the call UI; server-stamped per-participant spans over the verified
socket; offline queue → `client`-stamped flush; gap derivation at
finalize from `events.jsonl`; `renderIndexedTranscript` gap lines
(byte-identical output with zero gaps). *Verify:* unit tests for gap
derivation + transcript rendering; a call with a deliberate airplane-mode
drop produces a sensible `gaps` row.

**5 — Ingest.** Per-track WAV extraction + transcription (no diarize,
sequential), the merge step (pure, unit-tested — DESIGN specifies the
algorithm), pre-assigned speakers, `recording.flac` playback master,
harvest-span derivation (backend-side, one code path incl. local),
harvester consumes spans, prompt notes both-marked regions, auto-harvest
via `enterPipeline`. *Verify:* merge-step unit tests with overlapping
speech and multi-segment participants; a real call flows unattended to
`reviewing` with correctly attributed transcript and playable audio.

**6 — Doctor, e2e, deploy.** New doctor checks (DESIGN lists them);
`doctor --e2e` call variant with two `@livekit/rtc-node` bots publishing
`say`-synthesized voices, marking, one mid-call drop; app Dockerfile
(node, ffmpeg, uv + transcriber env, Claude Code) + homelab compose
profile + reverse-proxy/HTTPS notes. *Verify:* `doctor` green against the
local stack; `doctor --e2e` asserts DESIGN's full checklist; a phone
joins over HTTPS on the tailnet.

## Non-obvious integration points

- `HarvesterService.harvestSession` currently reads ok/unclosed markers
  directly and passes `{id, startS, endS}` to `runHarvest`; phase 5
  replaces that with harvest-span derivation, and `storeProposal` writes
  `harvestSpanId`. The `Proposal.markerId` plumbing in
  `harvest/harvester.ts` follows the same rename.
- The labeling stage is skipped for calls: `sampleUtterances`/`speakers`
  rows are still created (review UI reads them) but arrive pre-assigned
  from track identities — check `LabelView`/status routing in the web app
  so `origin: call` sessions never surface a labeling step.
- `markInterruptedSessions` only handles status `recording`; boot re-sync
  for status `calling` is the call package's job (DESIGN's crash story) —
  wire it in `main.ts` `serve` alongside the existing call.
- socket.io is created inside `startServer` after `app.listen`; the call
  plugin needs the `io` instance (or a registration callback) for its
  handshake middleware — plan the adapter seam accordingly.
- The egress container writes files as its own uid; ensure the shared
  volume/session dirs are created with permissions the backend can read
  and the container can write (spike should confirm).
- LiveKit room name = session id (`YYYY-MM-DD-xxxx`) — fine for LiveKit
  naming rules, but token/webhook code should treat "room" and "session"
  as the same string, no mapping table.
