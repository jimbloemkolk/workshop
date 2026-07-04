# Intent — Transcriber Spike

## Why this exists

I want to build an Insight Harvester: record long conversations (Jim & Jesse),
and later slice precise, attributable quotes out of them. Everything downstream
depends on one unproven assumption — that **local transcription on my M1 Pro is
good enough**. This spike exists to prove or disprove that, *before* any app
gets built.

This is an evaluation harness, not the product.

## What I want to learn

Four questions, each with a real pass/fail answer in an evaluation report:

1. **Can I slice by word?** Word-level timestamps accurate enough to cut a
   quote out of the audio by index.
2. **Can I tell us apart?** We record with one shared mic, so speaker
   separation must be solved in software — this is a hard gate, not a
   nice-to-have.
3. **Does Dutch-with-embedded-English survive?** We code-switch constantly;
   that's the known weak spot of speech models.
4. **Is the wait bearable?** Roughly: an hour of conversation transcribed in
   ten minutes or less, on this laptop.

## Ground rules

- **Nothing leaves the machine.** No cloud transcription, not even as a
  comparison run.
- **Never fabricate data.** If the pipeline isn't sure about a timestamp, it
  says so instead of inventing one. Flag, don't repair.
- **Reconstructible from scratch.** One command from clean checkout to working
  setup, on any machine. The only permitted manual step is the one-time
  Hugging Face token/license dance, and it must be documented.
- **A boring seam.** The output is one stable JSON file behind a plain CLI, so
  the future app can swallow this whole module as a sidecar without a rewrite.
  But don't gold-plate for that future — just avoid decisions that would force
  one.

## Decisions already taken

- One shared mic for v1 recordings → diarization quality decides the spike.
- Fast model first: the smaller/faster variant is the expected production
  config; the big model serves as the quality ceiling to compare against.
- Words the aligner can't place get honest nulls plus a flag — never
  interpolated guesses.
- An Apple-native (MLX) backbone comparison happens *after* the baseline
  numbers exist, as a clean A/B on the same recording.

## Done means

- `pnpm setup` → `pnpm transcribe <recording>` works on a clean machine.
- An evaluation report answering the four questions above, based on at least
  one real Jim–Jesse recording.

## Explicitly not doing

No recording UI. No insight extraction. No realtime transcription. No storage
beyond the JSON file. No cloud anything.

## Still open

- Where exactly the quality bar sits for code-switched passages, and what to
  do when a passage falls below it — needs real data first.
- Whether the fast model's Dutch quality actually holds up. That *is* the
  experiment.
