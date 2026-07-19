# Design — Insight Harvester

Decision record from the design interview (2026-07-04). [INTENT.md](INTENT.md)
says *why*; this says *how*. When the two disagree, intent wins.

## Structure & stack

- Two workspace packages: `packages/harvester/backend`
  (`@workshop/harvester-backend`) and `packages/harvester/web`
  (`@workshop/harvester-web`). The `harvester/` namespace is open for
  extracted library packages later.
- Backend: Node + TypeScript, **Fastify**. Frontend: thin **Vite/React** app.
- **socket.io** for everything bidirectional (marker key events up; recording
  clock, pipeline progress, harvest progress down). Plain HTTP only where it's
  naturally request/response: session/insight CRUD, audio serving with Range
  support, export trigger.
- **Drizzle ORM + better-sqlite3**; generated SQL migrations applied at
  startup.

## Data

- Data home: `~/.local/share/harvester` (override: `HARVESTER_DATA_DIR`).
  Precious data, not cache — hence `share`, not `cache`.
- `harvester.db` + `sessions/<id>/` per session: `segments/NNN.flac`,
  `recording.flac`, `transcript.json`, `clips/`.
- SQLite holds state (sessions, runs, markers, speakers, insights, verdicts);
  bulky artifacts stay on disk as files. Backend state is the source of truth;
  the vault is a projection.

## Recording

Recording — solo/table (`origin: local`) or two-party (`origin: call`) — is a
`@workshop/harvester-call` package concern: both are self-hosted LiveKit
rooms, differing only in roster size and whether ingest diarizes. See
[`call/DESIGN.md`](call/DESIGN.md) for the mechanism (this superseded the
original avfoundation direct-mic-capture design once the backend moved off
the laptop it used to run on). Markers ride the same socket channel
regardless of origin, server-stamped against the room's timeline; sub-**300ms**
taps are stored but flagged `discarded` (auditable; threshold is config).

## Pipeline

- Lifecycle: `recording → transcribing → labeling → harvesting → reviewing →
  exported`, plus `interrupted`/`failed`. Recording is one-way; everything
  after transcription is re-entrant (re-harvest, resume review, re-export).
- Transcriber invocation: `mlx : large-v3-turbo, --diarize, min/max 2, nl` —
  one config constant, shelled out to `packages/transcriber` (`uv run
  transcriber …`). The contract JSON is consumed, never reached into.
- Labeling: session participants (default Jim, Jesse; editable per session).
  One clear sample utterance per diarized speaker, tap to assign. Relabeling
  allowed anytime; only the assignment table changes.

## Harvesting

- **Claude Sonnet via the Agent SDK** (`@anthropic-ai/claude-agent-sdk`),
  riding the machine's Claude Code subscription auth. No API keys.
- **One agent session per harvest, one turn per unit of work**:
  - turn 0: harvesting instructions + the full indexed transcript,
  - one turn per marker (quote boundaries as word indices, insight text,
    supporting quotes from anywhere in the transcript),
  - final turns: sweep for unmarked candidates (ranked second-tier).
  - Prompt caching keeps the transcript at ~10% token cost per turn; the
    accumulating context deduplicates overlapping markers naturally.
  - Manual insights during review run as one extra turn in the same
    (resumable) agent session; the latest agent session id is stored per
    harvest.
- **Anchoring ("never fabricate")**: every returned word range is verified
  verbatim against the transcript's words array. Mismatch → mechanical
  re-anchor (normalized search near the claimed indices) → one retry with the
  error → stored flagged `unanchored`, shown as needs-attention. Never
  silently accepted.

## Review

- Proposals highlight in the scrollable transcript. Click a word to move the
  start, second handle/shift-click for the end, ±1-word nudge buttons.
  Preview plays the range from the master recording via timestamps — nothing
  is cut until export.
- Manual insight: select words → "make insight" → LLM-assisted turn drafts
  insight text + supporting quotes; same anchoring validation; human edits
  before accepting.
- Verdicts: accepted / rejected; everything stays proposed until a human
  decides. Nothing enters the vault unreviewed.

## Export

- Clips: **M4A/AAC**, sliced from the FLAC master with ~200ms padding each
  side (config constant, clamped to bounds). Boundaries snap **outward** to
  the nearest aligned word; `aligned:false` words never contribute timestamps.
- Vault dir: `HARVESTER_VAULT_DIR` (a folder inside the Obsidian vault).
  **Folder per session**: `<date> <participants>/` with `session.md`, one
  note per accepted insight, `clips/`. Cross-session discovery via
  frontmatter (session, date, speaker, origin marker/sweep/manual, tags).
- Re-export: each note has a harvester-**owned region** above an explicit
  marker comment and a human region below it that export never touches.
  Rejected-after-export insights get their notes removed only if the human
  region is empty; otherwise flagged.

## Verification

- `doctor`: ffmpeg present, transcriber callable, Agent SDK authenticated,
  data + vault dirs writable; recording readiness (LiveKit/egress/redis
  reachable, token mint round-trip) is `call`'s `doctor` checks — without
  `LIVEKIT_URL` the harvester still reviews/harvests/exports, it just can't
  start a new recording.
- `doctor --e2e`: reuse the say-synthesized two-speaker dialogue, inject it
  as an already-recorded session with fake markers, then transcribe →
  harvest → export into a temp vault. Real LLM by default; `--no-llm` runs a
  fixture harvester for cheap runs.
- Unit tests for the pure logic: anchoring/re-anchoring, marker filtering,
  owned-region parsing, clip boundary snapping.

## Conventions

- Session ids: `YYYY-MM-DD-<4 char suffix>`.
- Backend port: 4747 (override `HARVESTER_PORT`). Vite dev server proxies
  `/api` and socket.io to it; `pnpm dev` runs both.
- `.env` (gitignored, same pattern as the transcriber):
  `HARVESTER_DATA_DIR`, `HARVESTER_VAULT_DIR`, `HARVESTER_PORT` (plus
  `call`'s `LIVEKIT_*` env — see [`call/DESIGN.md`](call/DESIGN.md#conventions)).
