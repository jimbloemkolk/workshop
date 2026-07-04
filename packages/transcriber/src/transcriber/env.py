"""Environment setup: .env loading, cache locations, device selection.

Must be configured BEFORE whisperx / huggingface imports so HF_HOME sticks.
"""

import os
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def load_dotenv() -> None:
    """Minimal .env loader (KEY=VALUE lines); no dependency needed."""
    for candidate in (Path.cwd() / ".env", PACKAGE_ROOT / ".env"):
        if not candidate.is_file():
            continue
        for line in candidate.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value
        break


def cache_dir() -> Path:
    return Path(
        os.environ.get("TRANSCRIBER_CACHE_DIR", os.path.expanduser("~/.cache/transcriber"))
    )


def setup() -> None:
    """Load .env and route all model caches under the transcriber cache dir."""
    load_dotenv()
    cache = cache_dir()
    # All HF-hub downloads (alignment, diarization, VAD) land under our cache
    # unless the user has explicitly routed HF elsewhere.
    os.environ.setdefault("HF_HOME", str(cache / "huggingface"))
    # MPS kernels are incomplete for some ops used by pyannote/wav2vec2;
    # let torch fall back to CPU per-op instead of crashing.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")


def pick_device(preference: str = "auto") -> str:
    """Device for the torch stages (alignment, diarization).

    The ASR stage is always CPU: ctranslate2 has no Metal backend.
    """
    if preference in ("cpu", "mps"):
        return preference
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"
