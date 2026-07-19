# Refactor candidates — implementation session 2026-07-05/06

Code touched this session that works and is verified, but that I'd point a
future cleanup pass at. Nothing here is a bug; it's where the seams will
chafe first as the code grows.

## call/src/service.ts is the next thing to split

CallService (~650 lines) deliberately mirrors the HarvesterService
pattern — one class, thin adapters — but it now owns five concerns:
sessions/tokens, webhook dispatch + egress orchestration, marks, finalize +
crash re-sync, and ingest. The seams are already visible as section
comments; `recording.ts` (webhooks/egress/finalize/resync), `marks.ts` and
`ingest.ts` modules with CallService as the facade would be a mechanical
split. Do it the next time a phase-sized feature lands here.

## Duplication between HarvesterService and CallService

- `mustGet` / `setStatus` / `fail` are copy-pasted (same table, same
  emit-shape). They belong in core (or a tiny shared session-store helper)
  the day a third writer appears.
- `storeSpeakers` exists in both services with slightly different shapes
  (diarized labels vs. identities). The speaker-name mapping
  (`label → participant name`) is *also* re-implemented in
  `export/exporter.ts` and `web/ReviewView.tsx` — four copies of a five-line
  fold; one core helper would do.

## The `EG_` prefix rule has three copies

`isEgressIdentity` (call/service.ts), an inline `p.startsWith('EG_')` in
`gaps.ts`, and `isEgress` in `web/JoinView.tsx`. It's a LiveKit-behavior
fact, not a per-module choice — a single exported constant/predicate (core
or call) should own it.

## events.jsonl typing is loose

`CallEvent` is `{ atMs, type, ...unknown }`; `webhookToEvent` flattens
whatever arrives. Gap derivation and resync both pattern-match on `type`
strings against this soup. A discriminated union (webhook events, client
signals, recorder bookkeeping) would let the compiler check resync/gap
logic instead of tests alone.

## Session status strings are untyped everywhere

`'calling' | 'recording' | 'transcribing' | …` live as bare text in two
services, the schema comment, App.tsx routing and the e2e assertions. One
exported union type in core would catch typos at compile time; today a
misspelled status silently routes to ReviewView.

## Three say-synthesis implementations

`backend/src/e2e.ts` (original), `call/src/bots.ts` (dialogue + PCM
timelines), and the throwaway spike scripts each synthesize speech their
own way. `e2e.ts` could consume `synthesizeDialogue` from the call package
(backend → call is the allowed direction); the spike scripts are
throwaway-by-charter and can stay.

## web/src/views/JoinView.tsx is a small app in one file

Shell, lobby, mic-level hook, in-call screen, mark channel, offline queue
and reconnect reporting all live together (~300 lines). The `useMicLevel`
hook belongs in `audio.ts`; the mark-channel + queue could be a
`useMarkChannel(socket)` hook reusable by future surfaces.

## Smaller items

- `openMarkers` keys are `` `${sessionId}:${participant}` `` strings and
  `closeOpenMarkers` scans all keys with `startsWith` — a
  `Map<sessionId, Map<participant, id>>` says what it means.
- `awaitEgressesSettled` polls `listEgress` every 2 s even though the same
  information arrives as webhooks it already merges — fine as
  belt-and-braces, but the state merge now has two writers; if it ever
  misbehaves, make the webhook path the only writer and poll purely as a
  timeout check.
- `mixPlaybackMaster` builds a degenerate 1-input `amix` for single-segment
  calls; works, but a copy codec path would be cheaper and clearer.
- `server.ts` re-declares `sendFile(filename, rootPath?)` and `req.file()`
  by hand because the plugin type augmentations don't merge under the
  hoist=false layout — brittle against @fastify/static upgrades; worth
  revisiting after a pnpm/ts config change.
- Core `transcriber.model` / `language` are still hardcoded (`'large-v3-turbo'`,
  `'nl'`) while `backend` became env-configurable — inconsistent config
  surface, intentional today per decision 3, but the next transcriber knob
  should probably move all three to env together.
- The spike scripts cast `startTrackEgress` options
  (`as unknown as …`) — fine for throwaway code, but don't copy that
  pattern; `service.ts` shows the typed `DirectFileOutput` way.
