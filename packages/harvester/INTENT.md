# Intent — Insight Harvester

## Why this exists

Long conversations between Jim & Jesse contain our best thinking, and it
evaporates. I want to turn a two-hour recording into a handful of precise,
attributable, replayable insights that live in my Obsidian vault — without
anyone relistening to two hours of audio.

The transcription layer is already proven (see
[`../transcriber/INTENT.md`](../transcriber/INTENT.md)). This is the product
around it.

## The flow

1. **Record.** A local web app runs on the laptop at the table. While
   something good is being said, I press and hold the spacebar: press marks a
   start, release an end. A marker is a *span*, not a point — and it is
   understood to be sloppy, because attention lags speech.
2. **Transcribe.** The recording goes through the transcriber and comes back
   as one JSON file with word-level timestamps and speakers. That file is the
   addressing scheme everything below slices against.
3. **Name the speakers.** I get one sample utterance per detected speaker and
   type the real names. Ten seconds, once per session.
4. **Harvest.** For each marker span, an LLM reads the transcript *around* the
   span — the span is a hint, not a boundary — and proposes: the exact quote,
   the insight it carries, and supporting quotes searched from the *whole*
   transcript (an insight marked at minute 90 may lean on something said at
   minute 12). A separate full-transcript sweep proposes unmarked candidates
   as a second-tier list I can skim and promote.
5. **Review.** Same app: transcript with synced playback, each proposed quote
   with nudge-able boundaries. Accept, trim, or reject. Nothing enters the
   archive unreviewed.
6. **Keep.** Accepted insights are *exported* to the Obsidian vault as plain
   files: one markdown note per insight (quote, speaker, the insight itself,
   timestamps, source session, links to supporting quotes) plus the sliced
   audio clip embedded in it. The vault is a projection of backend state —
   re-runnable at any time — and it's where search and backlinks come free.

## Ground rules

- **Audio never leaves the machine.** Recordings and clips stay local, always.
  Transcript *text* may go to a cloud LLM for harvesting — that is the privacy
  boundary, and it is deliberate.
- **Never fabricate.** Quote boundaries snap to words the aligner actually
  placed; a quote is always verbatim transcript, never an LLM paraphrase. The
  LLM proposes, a human decides.
- **A conversation is unrepeatable — never lose one.** Recording streams to
  disk as it happens; markers are persisted the moment they occur; every
  pipeline stage leaves its result on disk. A crash, at any point, costs
  nothing that was already captured.
- **The backend owns everything real.** Recording, marker log, pipeline,
  LLM calls, slicing, vault export, session state. The browser is a remote
  control and a viewer: if the frontend dies mid-session, the session doesn't.
- **Backend state is the source of truth; the vault is a projection.** All
  session state — markers, transcripts, proposals, review verdicts — lives in
  the backend, persisted as it changes. Export to the vault is a projection of
  that state: repeatable, and safe to regenerate. Still, what lands in the
  vault must make sense without this tool — if the harvester disappears
  tomorrow, the vault keeps working.
- **The transcriber stays a boring seam.** Shell out to it, consume its JSON,
  nothing more intimate.

## Decisions already taken

- Recording — solo or two-party — happens over a self-hosted LiveKit room;
  marks ride the same socket channel and are server-stamped against the
  room's timeline, never a client-claimed time. (See
  [`call/DESIGN.md`](call/DESIGN.md) for the mechanism; a solo/table session
  is just a room with one publisher.)
- Markers are the primary harvest signal; the full-transcript sweep is a
  safety net that produces *suggestions*, ranked below the marked ones.
- Speaker naming is manual per session — no voice enrollment machinery.
- Frontend is a simple Vite/React app and stays thin on purpose.
- A SQLite database is allowed from the first iteration for backend state —
  no need to contort everything into files for purity's sake. Bulky artifacts
  (audio, transcript JSON) stay on disk; SQLite holds the state around them.
- Harvesting runs on my Claude subscription through the local agent tooling —
  no API keys to manage at all. Consequence: harvesting needs this laptop to
  be logged in to Claude Code, which is fine for a personal tool.
- Insights are exported one folder per session in the vault; each note keeps
  a harvester-owned part and a part that is mine — re-export never touches
  what I wrote in Obsidian.

## Done means

- One session, end to end: record a real conversation with markers, transcribe,
  name speakers, review the proposed insights, and find the accepted ones as
  working notes with playable clips in the Obsidian vault.
- A refresh or frontend crash mid-recording provably loses nothing.

## Explicitly not doing

No realtime
transcription or harvesting during the conversation. No custom search UI —
Obsidian is where insights are found and read. No editing of audio beyond
slicing. No multi-user anything, no sync, no cloud storage.

## Still open

- How the harvesting prompt earns trust (probably: start strict, loosen with
  experience) — needs real sessions.
- A marker fallback for when the laptop doesn't have keyboard focus
  mid-conversation.

Implementation decisions live in [DESIGN.md](DESIGN.md).
