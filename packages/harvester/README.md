# @workshop/harvester

Record a conversation, mark the good moments with the spacebar, get
reviewable insight proposals, export accepted ones to the Obsidian vault.
[INTENT.md](INTENT.md) says why; [DESIGN.md](DESIGN.md) records the decisions.

Two packages: `backend/` (Fastify + socket.io + SQLite, owns everything real)
and `web/` (thin Vite/React remote control).

## Usage

```sh
pnpm install
pnpm --filter @workshop/harvester-backend doctor   # verify environment
pnpm harvester                                     # backend :4747 + web :4748

# end-to-end proof against a temp vault (synthesized dialogue, real pipeline)
pnpm --filter @workshop/harvester-backend e2e -- --no-llm   # fixture harvester
pnpm --filter @workshop/harvester-backend e2e               # real LLM
```

Configuration via `.env` in `backend/` (all optional):

| var | default | meaning |
| --- | --- | --- |
| `HARVESTER_DATA_DIR` | `~/.local/share/harvester` | SQLite + per-session recordings/transcripts/clips |
| `HARVESTER_VAULT_DIR` | *(unset)* | folder inside your Obsidian vault; required for export |
| `HARVESTER_PORT` | `4747` | backend port |
| `HARVESTER_MIC` | `0` | avfoundation audio device index (`doctor` lists them) |
| `HARVESTER_MODEL` | `sonnet` | Agent SDK model for harvesting |

Harvesting rides your Claude subscription via the Agent SDK — no API key;
the machine just needs to be logged in to Claude Code. Transcription shells
out to `packages/transcriber` (run its `pnpm setup` once).

## Flow

record (hold SPACE to mark) → stop → transcribe (mlx, diarized) → name the
speakers → harvest (one agent session, one turn per marker + sweep) → review
(click words to fix boundaries, accept/reject, add manual insights) → export.

For testing/backfill you can also **drop an existing recording file** onto the
session list: the original is copied into the data dir, converted to the
canonical FLAC, and run through the same pipeline. No markers exist for
imported audio, so harvesting is sweep-only (plus manual insights in review).

Export writes one folder per session into the vault: `session.md`, one note
per insight, clips as M4A. Notes have a harvester-owned region above the
`%% harvester … %%` marker; anything you write below it survives re-export.
