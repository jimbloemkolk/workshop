# @workshop/harvester

Record a conversation, mark the good moments with the spacebar, get
reviewable insight proposals, export accepted ones to the Obsidian vault.
[INTENT.md](INTENT.md) says why; [DESIGN.md](DESIGN.md) records the decisions.

Four packages: `core/` (schema, DB, transcript contract, transcriber seam —
the dependency floor), `backend/` (Fastify + socket.io, owns the generic
pipeline), `call/` (recording itself — solo/table and two-party, both
self-hosted LiveKit rooms — see [call/INTENT.md](call/INTENT.md) and
[call/DESIGN.md](call/DESIGN.md)), and `web/` (thin Vite/React remote
control, including the standalone `/join` page). Dependencies point one way:
backend → call → core.

## Usage

```sh
pnpm install
pnpm --filter @workshop/harvester-backend doctor   # verify environment

# the media stack + LiveKit env — recording (solo or two-party) needs it;
# reviewing/harvesting/exporting existing sessions works without it
cd packages/harvester && docker compose up -d
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey \
  LIVEKIT_API_SECRET=devsecret_devsecret_devsecret_dev pnpm harvester

# end-to-end proof against a temp vault (synthesized dialogue, real pipeline)
pnpm --filter @workshop/harvester-backend e2e -- --no-llm    # fixture harvester
pnpm --filter @workshop/harvester-backend e2e                # real LLM
pnpm --filter @workshop/harvester-backend e2e -- --call --no-llm   # two-party call loop
pnpm --filter @workshop/harvester-backend e2e -- --table --no-llm  # solo/table recording loop
```

Both `--call` and `--table` need the media stack up and the dev backend
stopped first (they listen on the webhook port themselves) — see
[call/E2E.md](call/E2E.md) for the full runbook, including the parallel-worktree
gotchas on this machine.

Configuration via `.env` in `backend/` (all optional):

| var | default | meaning |
| --- | --- | --- |
| `HARVESTER_DATA_DIR` | `~/.local/share/harvester` | SQLite + per-session recordings/transcripts/clips |
| `HARVESTER_VAULT_DIR` | *(unset)* | folder inside your Obsidian vault; required for export |
| `HARVESTER_PORT` | `4747` | backend port |
| `HARVESTER_MODEL` | `sonnet` | Agent SDK model for harvesting |

Harvesting rides your Claude subscription via the Agent SDK — no API key;
the machine just needs to be logged in to Claude Code. Transcription shells
out to `packages/transcriber` (run its `pnpm setup` once).

## Flow

Both recording modes are self-hosted LiveKit rooms (`call/`); they differ in
roster size and whether ingest diarizes:

- **Solo/table**: start recording → the browser tab that started it joins as
  the one publisher, tap SPACE (or the on-screen button) to mark → stop →
  the track transcribes diarized → **name the speakers** → harvest (one
  agent session, one turn per merged mark region + sweep) → review → export.
- **Two-party call**: start a call → both join via tokened links → per-track
  recording + live marking → end call → per-track transcription (no
  diarization needed — track identity already is the speaker), merged
  attributed transcript, auto-harvest straight to review (labeling is
  skipped). Connection dropouts land as explicit gap spans.

Deployment notes: [call/DEPLOY.md](call/DEPLOY.md). Running the e2e suite
against the real stack: [call/E2E.md](call/E2E.md).

For testing/backfill you can also **drop an existing recording file** onto the
session list: the original is copied into the data dir, converted to the
canonical FLAC, and run through the same pipeline. No markers exist for
imported audio, so harvesting is sweep-only (plus manual insights in review).

Export writes one folder per session into the vault: `session.md`, one note
per insight, clips as M4A. Notes have a harvester-owned region above the
`%% harvester … %%` marker; anything you write below it survives re-export.
