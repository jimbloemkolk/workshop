"""Environment sanity checks, plus an optional end-to-end run on a generated sample."""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import env

# Two-speaker dialogue so diarization has something real to separate.
# Turns alternate speaker A / speaker B.
E2E_DIALOGUE_NL = [
    "In 1984 begonnen we met het project, en de deadline was echt een moving target.",
    "Klopt, maar we hadden er toen al 42 procent van afgerond.",
    "Daarna kwam die complete rewrite, drie weken werk vanwege de technical debt.",
    "En toch bleef de business case gewoon overeind staan.",
]
E2E_DIALOGUE_EN = [
    "In 1984 we started the project, and the deadline was a moving target.",
    "Right, but by then we had already finished 42 percent of it.",
    "Then came the complete rewrite, three weeks of work.",
    "And still the business case held up.",
]


class Doctor:
    def __init__(self):
        self.failed = False

    def check(self, label: str, passed: bool, hint: str = "") -> bool:
        mark = "ok " if passed else "FAIL"
        print(f"[{mark}] {label}" + (f" — {hint}" if not passed and hint else ""))
        self.failed = self.failed or not passed
        return passed

    def warn(self, label: str, hint: str) -> None:
        print(f"[warn] {label} — {hint}")


def _check_token(doc: Doctor) -> None:
    token = env.hf_token()
    if not token:
        doc.warn(
            "HF_TOKEN not set",
            "only needed for --diarize; put HF_TOKEN=... in .env (see README)",
        )
        return

    from huggingface_hub import HfApi
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError

    api = HfApi(token=token)
    try:
        user = api.whoami()
        doc.check(f"HF_TOKEN valid (user: {user.get('name', '?')})", True)
    except Exception as exc:
        doc.check("HF_TOKEN valid", False, f"token rejected by hub: {exc}")
        return

    from .pipeline import DIARIZATION_MODEL

    try:
        api.model_info(DIARIZATION_MODEL)
        doc.check(f"pyannote license accepted ({DIARIZATION_MODEL})", True)
    except GatedRepoError:
        doc.check(
            f"pyannote license accepted ({DIARIZATION_MODEL})",
            False,
            f"accept the terms at https://huggingface.co/{DIARIZATION_MODEL}",
        )
    except HfHubHTTPError as exc:
        doc.warn("pyannote license check skipped", f"hub unreachable: {exc}")


def _check_cache(doc: Doctor) -> None:
    cache = env.cache_dir()
    if not cache.is_dir():
        doc.warn(f"model cache empty ({cache})", "models download on first run")
        return
    cached = sorted(p.name for p in cache.iterdir() if p.is_dir())
    doc.check(f"model cache present ({cache}): {', '.join(cached) or 'empty'}", True)


def _list_say_voices() -> list[tuple[str, str]]:
    """Parse `say -v ?` into (voice_name, locale) pairs (names may contain spaces)."""
    if not shutil.which("say"):
        return []
    listing = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = []
    for line in listing.splitlines():
        m = re.match(r"^(.+?)\s+([a-z]{2,3}_[A-Z]{2})\s", line)
        if m:
            voices.append((m.group(1).strip(), m.group(2)))
    return voices


def _pick_dialogue() -> tuple[list[str], str, list[str]] | None:
    """Two distinct voices in the same language, Dutch preferred.

    Returns (voices, language, turns); voices has 2 entries when a two-speaker
    dialogue is possible, else 1 (diarization can't be meaningfully tested then).
    """
    voices = _list_say_voices()
    if not voices:
        return None
    for prefix, language, turns in (("nl", "nl", E2E_DIALOGUE_NL),
                                    ("en", "en", E2E_DIALOGUE_EN)):
        matches = [name for name, locale in voices if locale.startswith(prefix)]
        if len(matches) >= 2:
            return (matches[:2], language, turns)
        if matches:
            return (matches[:1], language, turns)
    return ([voices[0][0]], "en", E2E_DIALOGUE_EN)


def _synthesize_dialogue(tmp: Path, voices: list[str], turns: list[str]) -> Path:
    """Render alternating turns with alternating voices, joined by short silences."""
    silence = tmp / "silence.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", "anullsrc=r=16000:cl=mono", "-t", "0.4", str(silence)],
        check=True,
    )
    parts = []
    for i, text in enumerate(turns):
        aiff = tmp / f"turn{i}.aiff"
        wav = tmp / f"turn{i}.wav"
        subprocess.run(["say", "-v", voices[i % len(voices)], "-o", str(aiff), text],
                       check=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff),
             "-ar", "16000", "-ac", "1", str(wav)],
            check=True,
        )
        if parts:
            parts.append(silence)
        parts.append(wav)

    concat_list = tmp / "concat.txt"
    concat_list.write_text("".join(f"file '{p}'\n" for p in parts))
    sample = tmp / "sample.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(concat_list), "-c", "copy", str(sample)],
        check=True,
    )
    return sample


def _normalize(text: str, language: str) -> list[str]:
    """Tokenize for scoring: lowercase, punctuation-free, % spelled out."""
    text = text.lower().replace("%", " procent" if language == "nl" else " percent")
    return re.sub(r"[^\w\s]", " ", text).split()


def _score(ref: list[str], hyp: list[str]) -> tuple[int, list[str]]:
    """Word errors vs the known script, with human-readable diffs."""
    import difflib

    errors, diffs = 0, []
    matcher = difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        errors += max(i2 - i1, j2 - j1)
        diffs.append(f"'{' '.join(ref[i1:i2]) or '∅'}' → '{' '.join(hyp[j1:j2]) or '∅'}'")
    return errors, diffs


def _print_comparison(results: dict[str, dict], turns: list[str], language: str) -> None:
    from .compare import print_stage_table

    ref = _normalize(" ".join(turns), language)
    backends = list(results)
    pad = "       "

    scores = {b: _score(ref, _normalize(
        " ".join(w["text"] for w in results[b]["words"]), language))
        for b in backends}

    print()
    print_stage_table(results, pad=pad, extra_rows=[(
        "errors vs script",
        [f"{errs}/{len(ref)} words ({100 * errs / len(ref):.0f}%)"
         for errs, _ in scores.values()],
    )])
    print()
    for b in backends:
        errs, diffs = scores[b]
        shown = "; ".join(diffs[:8]) + (" …" if len(diffs) > 8 else "")
        print(f"{pad}{b} mistakes: {shown if diffs else 'none'}")
    print()
    for b in backends:
        print(f"{pad}{b} transcript:")
        for seg in results[b]["segments"]:
            print(f"{pad}  {seg['speaker'] or '?'}: {seg['text']}")


def _run_e2e(doc: Doctor, model: str) -> None:
    """Generate a two-speaker spoken dialogue (with digits + code-switching),
    run the real pipeline once per ASR backend, verify the output contract,
    and print a timing/quality comparison against the known script."""
    picked = _pick_dialogue()
    if picked is None:
        doc.warn("e2e skipped", "no `say` command available to generate sample audio")
        return
    voices, language, turns = picked

    from .pipeline import Options, run

    with tempfile.TemporaryDirectory() as tmp:
        wav = _synthesize_dialogue(Path(tmp), voices, turns)
        print(f"       sample: {len(turns)} turns, voices: {', '.join(voices)} "
              f"({language}), model: {model}")

        diarize = env.hf_token() is not None
        results = {}
        for backend in ("ct2", "mlx"):
            results[backend] = run(Options(
                audio_file=str(wav), out=str(Path(tmp) / f"result-{backend}.json"),
                language=language, model=model, backend=backend, diarize=diarize,
            ))

        for backend, result in results.items():
            words = result["words"]
            doc.check(f"e2e[{backend}]: pipeline produced words", len(words) > 0)
            doc.check(
                f"e2e[{backend}]: word indices gap-free",
                [w["index"] for w in words] == list(range(len(words))),
            )
            doc.check(
                f"e2e[{backend}]: aligned words have timestamps, unaligned have nulls",
                all(
                    (w["start"] is not None and w["end"] is not None)
                    if w["aligned"] else (w["start"] is None and w["end"] is None)
                    for w in words
                ),
            )
            if diarize and len(voices) >= 2:
                speakers = {w["speaker"] for w in words if w["speaker"]}
                doc.check(
                    f"e2e[{backend}]: two speakers separated (found: {sorted(speakers)})",
                    len(speakers) == 2,
                )
        if not diarize:
            doc.warn("e2e: diarization not exercised", "set HF_TOKEN to include it")
        elif len(voices) < 2:
            doc.warn("e2e: speaker separation untestable",
                     "only one system voice available for dialogue synthesis")

        _print_comparison(results, turns, language)


def run_doctor(e2e: bool = False, model: str = "large-v3-turbo") -> int:
    doc = Doctor()
    doc.check("ffmpeg on PATH", shutil.which("ffmpeg") is not None, "brew install ffmpeg")
    _check_token(doc)
    _check_cache(doc)
    if e2e:
        try:
            _run_e2e(doc, model)
        except Exception as exc:
            doc.check("e2e run", False, f"{type(exc).__name__}: {exc}")
    return 1 if doc.failed else 0
