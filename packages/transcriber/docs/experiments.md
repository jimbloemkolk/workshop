# Model & backend experiments

How we picked the default pipeline configuration (`ct2:large-v3-turbo`) and
why diarization now runs concurrently with ASR. All experiments ran on
2026-07-04 on Apple Silicon, against a real recording: a 16.5-minute
(992s) two-person Dutch conversation in which an English blog text is read
aloud and discussed — deliberately hard code-switching material.

Backends under test:

- **ct2** — faster-whisper/CTranslate2 via whisperX, int8, CPU (no Metal
  backend exists for CTranslate2). Segmentation comes from VAD (silence
  boundaries), transcription is batched.
- **mlx** — mlx-whisper on the Metal GPU, float16. The original sequential
  OpenAI decoding loop; segmentation comes from decoder-predicted timestamp
  tokens.

In all runs: alignment = `wav2vec2-large-xlsr-53-dutch` on MPS, diarization =
`pyannote/speaker-diarization-community-1` on MPS, 2 speakers pinned.

## Experiment 1: backend × model matrix (2×2)

`large-v3` vs `large-v3-turbo` on both backends, `language=nl`.

| stage | ct2:large-v3 | mlx:large-v3 | ct2:turbo | mlx:turbo |
|---|---|---|---|---|
| asr_load | 70.1s ¹ | 64.0s ¹ | 3.3s | 1.4s |
| asr | 285.7s | 215.2s | 177.7s | 76.5s |
| align | 26.0s | 42.0s | 27.1s | 47.0s |
| diarize | 53.4s | 54.0s | 53.6s | 54.5s |
| total | 440.0s | 381.1s | 267.2s | 185.9s |
| speed (excl. load) | 2.7x | 3.2x | 3.8x | 5.5x |

¹ cold cache (first download); warm reruns load large-v3 in ~7s.

**Speed findings**

- Metal helps turbo far more (2.3x) than large-v3 (1.3x): large-v3's 32
  autoregressive decoder layers are memory-bandwidth-bound where the GPU
  can't stretch; turbo (4 decoder layers) shifts work to the
  GPU-friendly encoder.
- Diarization is constant (~54s) — it never sees the ASR output.
- Alignment is *slower* on mlx runs (42–47s vs 26–27s). Same aligner, same
  device: the cost scales with segment count, and mlx fragments the output.

**Quality findings (output structure)**

| | ct2:large-v3 | mlx:large-v3 | ct2:turbo | mlx:turbo |
|---|---|---|---|---|
| segments | 243 | 380 | 259 | 609 |
| median segment length | 2.7s | 1.0s | 2.5s | 0.9s |
| segments < 1.5s | 30% | 61% | 32% | 85% |
| segments ending in `...` | 15 | 75 | 20 | 294 |
| segments with no speaker | 0 | 40 | 0 | 5 |

mlx:turbo shreds sentences mid-clause (`"The goal of a community... | Is the
result... | Of the complex negotiation..."`) — nearly unreadable. mlx:large-v3
produces correct sentences but cut fine-grained at every pause; its many
sub-second segments often overlap no diarization turn, leaving 40 segments
with `speaker: null`. Fragmentation is an **mlx-backend trait** (timestamp-token
segmentation), not a turbo trait — turbo just amplifies it. Both ct2 runs
(VAD segmentation) are clean.

**Conclusion:** both mlx configs are disqualified on output structure despite
the speed win. The contest is ct2:large-v3 vs ct2:large-v3-turbo.

## Experiment 2: ct2:large-v3 vs ct2:large-v3-turbo, full transcript diff

Warm-cache rerun with the word-level divergence report: 575/2189 words
(26.3%) differ across 83 sections. Reading every section:

- **The 26.3% overstates the gap.** Most sections are noise-level variation
  in messy conversational Dutch (`dat`/`dus`, `kun je`/`kunnen we`,
  `ofzo`/`of zo`), with errors in both directions.
- **The decisive finding: large-v3 silently *translates* the English
  read-aloud passages into Dutch.** With the language token pinned to `nl`,
  large-v3 rendered ~50s of English reading as hallucinated machine-Dutch —
  "certain **patterns** worked" became "bepaalde **patiënten** werken",
  "by trial and error" became "door uitdaging en erger". Turbo transcribed
  the same passages as faithful English. Translation is fabrication: the
  original words are unrecoverable, and nothing in the output flags it.
- **Omissions are roughly balanced.** Turbo dropped one read passage
  (~17s, the "mutual engagement of participants" quote); large-v3 dropped
  at least as much (the entire first 8.5s of the recording, the "communally
  negotiated" passage, several asides).
- **Hard-word accuracy is a split decision.** large-v3 wins some Dutch
  vocabulary ("mondjesmaat", "bureaucracy"); turbo wins terminology that
  matters for this material ("**Mutual** engagement" vs "Future engagement",
  "**reified**" vs "verified" — reified is the actual Wenger term).

**Conclusion:** turbo is not a quality compromise on this audio. Its failure
mode (occasionally skipping a passage) is detectable; large-v3's failure mode
(fluent-looking wrong-language fabrication) is not. And turbo is 125s faster
with a ~5x faster model load.

## Experiment 3: `language=auto`

Hypothesis: auto-detection might handle the Dutch/English code-switching
better than pinning `nl`. Result: the transcripts were **byte-for-byte
identical** to the pinned-`nl` runs, for both models.

- whisperX detects language **once**, from the first ~30s of audio, then
  locks that token for the whole file. Our recording opens in Dutch, so
  `auto` resolves to `nl` and the decode is exactly the same.
  (mlx-whisper behaves the same way.) `auto` only helps when the dominant
  language is unknown up front; it can never help with code-switching.
- Byproduct: the pipeline is **fully deterministic** — two runs 40 minutes
  apart produced identical output (greedy decoding). Any diff between two
  configs is pure signal, never run-to-run noise; rerunning a config to
  "double-check" tells you nothing new.
- large-v3's translate-mode failure is therefore not fixable with the
  language flag. Fixing it would need per-chunk language detection —
  engineering that turbo makes unnecessary.

## Where we landed

1. **Default = `ct2:large-v3-turbo`** (`int8`, CPU, VAD segmentation).
   Fastest of the structurally clean options (~3.9x realtime), no
   speaker-assignment gaps, faithful to code-switched speech.
2. **Diarization runs concurrently with ASR + alignment** (worker thread;
   it needs only the raw audio, and the streams join in
   `assign_word_speakers`). This removes the constant ~54s pyannote cost
   from the critical path entirely — verified in the e2e run (ct2 stage sum
   16.5s, true elapsed 10.9s). Expected on the benchmark file: ~258s →
   ~204s (~4.9x realtime). Because stages now overlap,
   `meta.total_wall_clock_s` (true elapsed) is the number to compare runs
   by, not the stage sum.
3. **Remaining speed levers are architectural, not model choice.** After
   parallelization the critical path is ASR (174s) + alignment (25s);
   the only big lever left is the ASR model/backend trade-off already
   settled above.
4. **If mlx speed is ever needed** (5.5x realtime), it requires a
   segment-normalization pass first (merge sub-1.5s neighbors from the same
   speaker, or re-segment via VAD) to fix readability, alignment cost, and
   the `speaker: null` gaps.

## Open questions

- Turbo's dropped passage (exp. 2) was detectable only because we had a
  second model to diff against. A cheap self-check for production runs
  (e.g. flagging long silent gaps in the word timeline that VAD marked as
  speech) would catch skips without a second run.
- Diarization and alignment both sit on MPS; today they never overlap in
  practice (diarization finishes inside the ASR window), but a much faster
  ASR would change that.
