"""The transcription pipeline: ASR -> forced alignment -> diarization -> contract JSON.

Honesty rules (see INTENT.md):
- Words the aligner cannot place get null timestamps + aligned:false. Never interpolated.
- `words` is a flat, gap-free, globally indexed array — the seam the insight
  pipeline slices against.
- Per-stage device placement and wall clock go into meta; every output file
  documents its own performance.
"""

import datetime
import math
import time
from dataclasses import dataclass, field
from importlib.metadata import version as pkg_version
from pathlib import Path

from . import env

SAMPLE_RATE = 16000
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"

# ASR backends: "ct2" = faster-whisper/ctranslate2 via whisperx (CPU-only on
# Apple Silicon — no Metal backend); "mlx" = mlx-whisper on the Metal GPU.
MLX_MODELS = {
    "tiny": "mlx-community/whisper-tiny",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


class PipelineError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 5):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


@dataclass
class Options:
    audio_file: str
    out: str
    language: str = "nl"  # "auto" enables detection (comparison runs only)
    model: str = "large-v3-turbo"
    backend: str = "ct2"  # "ct2" (CPU) or "mlx" (Metal GPU)
    diarize: bool = False
    min_speakers: int = 2
    max_speakers: int = 2
    device: str = "auto"  # torch stages; ASR is always cpu (ctranslate2)
    compute_type: str = "int8"
    batch_size: int = 8
    stages: dict = field(default_factory=dict)

    def timed(self, name: str, device: str):
        opts = self

        class _Timer:
            def __enter__(self):
                self.t0 = time.monotonic()

            def __exit__(self, *exc):
                if exc[0] is None:
                    opts.stages[name] = {
                        "device": device,
                        "wall_clock_s": round(time.monotonic() - self.t0, 2),
                    }

        return _Timer()


def _clean(value):
    """NaN-safe float for JSON (whisperx leaves NaN where alignment failed)."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), 3)


def run(opts: Options) -> dict:
    import whisperx  # heavy import; keep `doctor` and `--help` fast

    if not Path(opts.audio_file).is_file():
        raise PipelineError("audio_not_found", f"no such file: {opts.audio_file}", 2)

    language = None if opts.language == "auto" else opts.language
    cache = env.cache_dir()
    torch_device = env.pick_device(opts.device)

    print(f"[1/4] loading audio: {opts.audio_file}")
    with opts.timed("load_audio", "cpu"):
        audio = whisperx.load_audio(opts.audio_file)
    duration_s = round(len(audio) / SAMPLE_RATE, 2)

    if opts.backend == "mlx":
        model_id = MLX_MODELS.get(opts.model, opts.model)
        print(f"[2/4] asr: {model_id} (mlx, metal, language={opts.language})")
        import mlx.core as mx
        import mlx_whisper
        from mlx_whisper.transcribe import ModelHolder

        with opts.timed("asr_load", "metal"):
            ModelHolder.get_model(model_id, mx.float16)
        with opts.timed("asr", "metal"):
            result = mlx_whisper.transcribe(
                audio, path_or_hf_repo=model_id, language=language, verbose=None
            )
    else:
        model_id = opts.model
        print(f"[2/4] asr: {model_id} ({opts.compute_type}, cpu, language={opts.language})")
        with opts.timed("asr_load", "cpu"):
            asr = whisperx.load_model(
                opts.model,
                device="cpu",
                compute_type=opts.compute_type,
                language=language,
                download_root=str(cache / "whisper"),
            )
        with opts.timed("asr", "cpu"):
            result = asr.transcribe(audio, batch_size=opts.batch_size, language=language)
        del asr
    detected_language = result["language"]

    from whisperx.alignment import DEFAULT_ALIGN_MODELS_HF, DEFAULT_ALIGN_MODELS_TORCH

    align_model_name = (
        DEFAULT_ALIGN_MODELS_TORCH.get(detected_language)
        or DEFAULT_ALIGN_MODELS_HF.get(detected_language)
    )
    if align_model_name is None:
        raise PipelineError(
            "no_align_model", f"no default alignment model for language: {detected_language}"
        )

    print(f"[3/4] alignment: {align_model_name} ({torch_device})")
    with opts.timed("align_load", torch_device):
        align_model, align_meta = whisperx.load_align_model(
            language_code=detected_language, device=torch_device
        )
    with opts.timed("align", torch_device):
        # interpolate_method="ignore": unalignable words keep NO timestamps
        # instead of getting fabricated ones (flag, don't repair).
        result = whisperx.align(
            result["segments"], align_model, align_meta, audio, torch_device,
            interpolate_method="ignore",
        )
    del align_model

    if opts.diarize:
        token = env.hf_token()
        if not token:
            raise PipelineError(
                "token_missing",
                "diarization needs HF_TOKEN (see README: one-time manual step)",
                4,
            )
        print(f"[4/4] diarization: {DIARIZATION_MODEL} ({torch_device})")
        try:
            result = _diarize(opts, result, audio, token, torch_device)
        except Exception as exc:  # MPS kernel gaps are a known hazard; retry on CPU
            if torch_device != "mps":
                raise
            print(f"      diarization failed on mps ({exc}); retrying on cpu")
            result = _diarize(opts, result, audio, token, "cpu")
    else:
        print("[4/4] diarization: skipped (no --diarize)")

    return _build_contract(opts, result, duration_s, detected_language, align_model_name, model_id)


def _diarize(opts: Options, result: dict, audio, token: str, device: str) -> dict:
    from whisperx.diarize import DiarizationPipeline, assign_word_speakers

    with opts.timed("diarize_load", device):
        pipeline = DiarizationPipeline(
            model_name=DIARIZATION_MODEL,
            token=token,
            device=device,
            cache_dir=str(env.cache_dir() / "diarization"),
        )
    with opts.timed("diarize", device):
        diarize_df = pipeline(
            audio, min_speakers=opts.min_speakers, max_speakers=opts.max_speakers
        )
        return assign_word_speakers(diarize_df, result)


def _build_contract(
    opts: Options, result: dict, duration_s: float, detected_language: str,
    align_model_name: str, model_id: str,
) -> dict:
    segments, words, warnings = [], [], []

    for sid, seg in enumerate(result["segments"]):
        text = seg.get("text", "").strip()
        seg_words = seg.get("words") or []
        if not seg_words and text:
            # whisperx falls back to an empty word list when a whole segment is
            # unalignable; backfill tokens so the global word index stays gap-free.
            seg_words = [{"word": token} for token in text.split()]
            warnings.append(f"segment {sid} fully unaligned; words backfilled without timestamps")

        for w in seg_words:
            aligned = _clean(w.get("start")) is not None and _clean(w.get("end")) is not None
            words.append({
                "index": len(words),
                "text": w.get("word", "").strip(),
                "start": _clean(w.get("start")) if aligned else None,
                "end": _clean(w.get("end")) if aligned else None,
                "aligned": aligned,
                "speaker": w.get("speaker"),  # word-level speaker is canonical
                "segment_id": sid,
                "score": _clean(w.get("score")),
            })

        segments.append({
            "id": sid,
            "start": _clean(seg.get("start")),
            "end": _clean(seg.get("end")),
            "speaker": seg.get("speaker"),  # majority-vote convenience only
            "text": text,
        })

    # Continuity self-check: whisperx can silently drop a fully-unalignable
    # sentence *inside* an otherwise aligned segment. Detect, never hide.
    token_count = sum(len(s["text"].split()) for s in segments)
    if token_count != len(words):
        warnings.append(
            f"word/token count mismatch: {len(words)} words vs {token_count} segment tokens"
        )

    return {
        "meta": {
            "audio_file": str(Path(opts.audio_file).resolve()),
            "duration_s": duration_s,
            "model": model_id,
            "backend": opts.backend,
            "compute_type": opts.compute_type if opts.backend == "ct2" else "float16",
            "language": opts.language,
            "detected_language": detected_language,
            "alignment_model": align_model_name,
            "diarization_model": DIARIZATION_MODEL if opts.diarize else None,
            "whisperx_version": pkg_version("whisperx"),
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "stages": opts.stages,
            "warnings": warnings,
        },
        "segments": segments,
        "words": words,
    }
