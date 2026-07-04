# @workshop/transcriber

Local transcription spike (WhisperX on Apple Silicon). See [INTENT.md](INTENT.md)
for what this is trying to prove.

Python project managed by [uv](https://docs.astral.sh/uv/); pnpm scripts are the
uniform interface — no JS in here.

## Usage

```sh
pnpm setup                 # idempotent bootstrap: uv, ffmpeg, pinned python env
pnpm doctor                # sanity-check the environment
pnpm doctor -- --e2e       # + synthesize a two-speaker dialogue, run the real
                           #   pipeline on BOTH ASR backends, print a timing +
                           #   quality comparison table (--model tiny = quick smoke)
pnpm transcribe <audio> --out result.json
pnpm transcribe <audio> --out result.json --diarize   # needs HF_TOKEN, see below
pnpm transcribe <audio> --out result.json --backend mlx   # ASR on the Metal GPU

# comparison run on real audio: both models one after the other, then a
# timing table + divergence report with every differing transcript section
pnpm transcribe <audio> --out result.json --backend mlx --model compare

# backends compare too; lists multiply into a run matrix (here: 2 models x 2 backends)
pnpm transcribe <audio> --out result.json --backend compare --model compare
```

`transcribe` flags (defaults in parentheses):

| flag | meaning |
| --- | --- |
| `--language` (`nl`) | pinned language; `auto` enables detection — comparison runs only |
| `--model` (`large-v3-turbo`) | model name, e.g. `large-v3`, `tiny` (mapped to the matching `mlx-community/*` repo for `--backend mlx`). `compare` = run `large-v3` **and** `large-v3-turbo` and diff them; any comma list works, entries may pin a backend: `mlx:large-v3-turbo,ct2:large-v3-turbo` |
| `--backend` (`ct2`) | ASR backend: `ct2` = faster-whisper, CPU-only on Apple Silicon; `mlx` = mlx-whisper on the Metal GPU. `compare` (= `ct2,mlx`) or a comma list multiplies with `--model` into a run matrix |
| `--diarize` (off) | pyannote speaker diarization |
| `--min-speakers` / `--max-speakers` (2/2) | speaker-count hint for diarization |
| `--device` (`auto`) | `cpu`/`mps` for the torch stages (alignment, diarization) |
| `--compute-type` (`int8`) | ctranslate2 quantization, ct2 backend only (mlx uses float16) |
| `--batch-size` (8) | ASR batch size, ct2 backend only |

## Comparison runs

With multiple models and/or backends (`compare` or a comma list on either
flag; they multiply into a matrix, e.g. `--model compare --backend compare`
= 4 runs), the runs execute one after the other on identical audio. Each run
writes its own contract JSON (`result.mlx-large-v3.json`, …), then the CLI
prints:

- a per-stage timing table (devices, wall clock, ×-realtime),
- a divergence summary — how many words differ between the two outputs,
- every differing section: timestamp, speaker, and both readings side by side
  with the disagreeing words marked (`«so»`).

With more than two runs, each is diffed against the **first spec** — order the
list so your reference config comes first.

There's no ground truth on real recordings, so divergence is the honest
metric: where the models agree you get confidence, where they differ you know
exactly which seconds of audio to listen to.

## Output contract

One JSON file: `meta` / `segments` / `words`.

- `words` is the canonical flat array with global, gap-free indices — the seam
  the insight pipeline slices against. Word-level `speaker` is canonical;
  segment-level speaker is a majority-vote convenience.
- Words the aligner can't place (typically digits) get `"start": null,
  "end": null, "aligned": false` — never interpolated (flag, don't repair).
- `meta.stages` records per-stage device placement and wall clock, so every
  output file documents its own performance.
- `meta.warnings` lists anything suspect (backfilled segments, word-count
  mismatches). An empty list means a clean run.

Errors are machine-readable JSON on stderr, no interactive prompts.
Exit codes: `0` ok · `1` doctor findings/generic · `2` bad input ·
`4` missing HF token · `5` pipeline failure.

## One-time manual step (diarization only)

Diarization (pyannote) needs a Hugging Face token and accepted model license:

1. Create a token at https://huggingface.co/settings/tokens
2. Accept the terms at https://huggingface.co/pyannote/speaker-diarization-community-1
3. Put `HF_TOKEN=...` in `.env` here (never committed) or the environment

`pnpm doctor` verifies both the token and the license acceptance.

## Cache

All models download on first run to `~/.cache/transcriber`
(override with `TRANSCRIBER_CACHE_DIR`): whisper weights, the Dutch wav2vec2
alignment model, and the pyannote pipeline. Delete the directory to
reconstruct from scratch.

## Known noise

torchcodec logs a scary-looking warning about ffmpeg dylibs on startup
(homebrew ships ffmpeg 8; torchcodec probes for 4–7). Harmless — the pipeline
feeds raw arrays and never uses torchcodec.
