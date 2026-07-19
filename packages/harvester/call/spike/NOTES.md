# Spike findings (2026-07-05, LiveKit 1.8.4 / egress v1.9 via docker compose on the dev Mac)

Scripts: `webhook-timing.ts` (delta between webhook `createdAt` and arrival),
`egress-behavior.ts` (`republish` and `rejoin` scenarios: publish a tone,
start track egress, break the publication two ways, inspect egresses + files).
Phases 3–4 build on the answers below.

## 1. Egress file behavior across publication changes

- **One file per track publication, always.** Track egress follows a track
  SID. On `track_unpublished` (same connection) *and* on a full
  disconnect, the egress ends **by itself** — `egress_ended`
  (status `EGRESS_COMPLETE`) arrives ~0.5 s after the unpublish, and the
  file is complete and playable (verified via ffprobe + the SDK's
  `fileResults`). No zombie egresses to reap in the common case.
- A re-publication (same connection or full rejoin) gets a **new track SID**
  and therefore needs a **new egress**, started from the `track_published`
  webhook — exactly the ordered-track-segments model in DESIGN. Recorder
  logic is uniform: `track_published` → start egress; `egress_ended` →
  segment row.
- **SDK resume** (network flap, same track SID) is the one case not
  scriptable from rtc-node — it needs a real browser losing its network.
  Either outcome is absorbed: if the egress survives resume it's one longer
  segment (the flap becomes a `gaps` row, not a file boundary); if the
  client falls back to a full rejoin we get the new-SID path above. To be
  observed on a real train call; no code depends on the answer.
- `{track_id}` in the egress `filepath` template works; egress also drops an
  `EG_<id>.json` manifest next to the file (see 3).

## 2. Webhook timing fidelity

Deltas measured `arrivalMs − createdAt*1000` over room create / join /
publish / unpublish / egress lifecycle / leave / room finish:

- **48–992 ms, typically < 1 s.** Fine for gap edges — gaps we care about
  are multi-second.
- `createdAt` is **second-granularity** (proto int64 seconds). Gap-edge
  resolution is therefore ~1 s regardless of delivery speed. Acceptable:
  derivation is deliberately conservative (DESIGN).
- Event order was sane throughout (`track_unpublished` before
  `egress_ended`, `participant_left` before `room_finished`).

## 3. Timeline anchoring (t0)

- The egress manifest and `egress_ended`'s `EgressInfo` carry
  **nanosecond** `started_at` / `ended_at`. But `started_at` is egress
  startup, ~1 s *before* audio actually flows (files measured ~1.1 s shorter
  than `ended_at − started_at`).
- **Anchor each segment as `endedAt − ffprobe(file).duration`** (both ends
  of that subtraction are precise), with `started_at` as a sanity check.
  t0 = earliest segment start across the session.

## 4. Shared volume & permissions

- Mount contract: the host dir is mounted at the **same absolute path** in
  the egress container (`${HARVESTER_DATA_DIR}:${HARVESTER_DATA_DIR}`, set
  in `packages/harvester/.env`), so backend-side paths are valid egress-side
  filepaths verbatim. Works.
- On the dev Mac (Docker Desktop) files arrive `uid=501` (the host user),
  mode 644 — backend reads them fine. **Homelab caveat:** on native Linux
  the egress process uid is preserved; verify at deploy that the session
  dirs are group-writable for the egress uid or run the containers with a
  matching uid. (Deploy-phase checklist item, not a design problem.)

## 5. Incidental but load-bearing observations

- **The egress worker joins the room as a participant** (identity =
  `EG_<egress id>`, participant kind `egress`). `participant_joined/left`
  consumers (gap derivation, presence UI) must filter these out or every
  recording start/stop looks like a person coming and going.
- `egress_started` arrives with status `STARTING`; `ACTIVE` follows as
  `egress_updated` ~1 s later. Treat a session's recording as live on
  STARTING already — audio loss at the head is < 1 s and unavoidable either
  way.
- Stopping an egress takes a few seconds to settle; `listEgress` right after
  `stopEgress` shows `ENDING` with a 0-byte file entry. The file appears
  complete on disk shortly after — **finalize must wait for `egress_ended`
  webhooks (or poll status), never trust an immediate list.**
