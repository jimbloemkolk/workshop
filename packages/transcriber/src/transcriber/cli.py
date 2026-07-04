"""CLI entry point for the transcriber spike.

Commands:
    doctor      sanity-check the environment; --e2e runs a generated 10s sample
                through the real pipeline
    transcribe  audio file -> result JSON (the contract the future app consumes)

Errors are machine-readable JSON on stderr; exit code is non-zero on failure.
No interactive prompts, ever.

Exit codes: 0 ok · 1 doctor findings / generic · 2 bad input ·
            4 missing HF token · 5 pipeline failure
"""

import argparse
import json
import sys

from . import env


def _fail(code: str, message: str, exit_code: int) -> int:
    json.dump({"error": code, "message": message}, sys.stderr)
    sys.stderr.write("\n")
    return exit_code


def cmd_doctor(args: argparse.Namespace) -> int:
    from .doctor import run_doctor

    return run_doctor(e2e=args.e2e, model=args.model)


def _out_path(out: str, tag: str, multi: bool) -> str:
    if not multi:
        return out
    from pathlib import Path

    p = Path(out)
    return str(p.with_name(f"{p.stem}.{tag}{p.suffix or '.json'}"))


def cmd_transcribe(args: argparse.Namespace) -> int:
    from .compare import parse_specs, print_diffs, print_stage_table, totals
    from .pipeline import Options, PipelineError, run

    try:
        specs = parse_specs(args.model, args.backend)
    except ValueError as exc:
        return _fail("invalid_arguments", str(exc), 2)
    results: dict[str, dict] = {}
    try:
        for backend, model in specs:
            opts = Options(
                audio_file=args.audio_file,
                out=args.out,
                language=args.language,
                model=model,
                backend=backend,
                diarize=args.diarize,
                min_speakers=args.min_speakers,
                max_speakers=args.max_speakers,
                device=args.device,
                compute_type=args.compute_type,
                batch_size=args.batch_size,
            )
            result = run(opts)
            tag = f"{backend}-{model.replace('/', '-')}"
            out = _out_path(args.out, tag, multi=len(specs) > 1)
            with open(out, "w") as fh:
                json.dump(result, fh, ensure_ascii=False, indent=1)
            total, work = totals(result["meta"])
            total = round(total, 1)
            speed = round(result["meta"]["duration_s"] / work, 1) if work else 0
            print(f"done: {len(result['words'])} words, "
                  f"{result['meta']['duration_s']}s audio in {total}s "
                  f"({speed}x realtime excl. model load) -> {out}")
            for warning in result["meta"]["warnings"]:
                print(f"warning: {warning}", file=sys.stderr)
            results[f"{backend}:{model}"] = result
    except PipelineError as exc:
        return _fail(exc.code, str(exc), exc.exit_code)
    except Exception as exc:
        return _fail("pipeline_failure", f"{type(exc).__name__}: {exc}", 5)

    if len(results) > 1:
        print()
        print_stage_table(results)
        print_diffs(results)
    return 0


def main() -> None:
    env.setup()  # .env + cache routing, before any heavy import

    parser = argparse.ArgumentParser(prog="transcriber")
    sub = parser.add_subparsers(dest="command", required=True)

    p_doc = sub.add_parser("doctor", help="verify the environment")
    p_doc.add_argument("--e2e", action="store_true",
                       help="also run a generated two-speaker dialogue through the "
                            "pipeline on both ASR backends and compare them")
    p_doc.add_argument("--model", default="large-v3-turbo",
                       help="model for the e2e comparison (use tiny for a quick smoke)")

    p_tr = sub.add_parser("transcribe", help="transcribe an audio file to JSON")
    p_tr.add_argument("audio_file")
    p_tr.add_argument("--out", required=True)
    p_tr.add_argument("--language", default="nl",
                      help='language code, or "auto" (comparison runs only)')
    p_tr.add_argument("--model", default="large-v3-turbo",
                      help='model name; "compare" runs large-v3 AND large-v3-turbo '
                           "and diffs the outputs; any comma list works, entries "
                           'may pin a backend ("mlx:large-v3-turbo,ct2:large-v3-turbo")')
    p_tr.add_argument("--backend", default="ct2",
                      help="ASR backend: ct2 = faster-whisper (CPU), mlx = Metal GPU; "
                           'a comma list or "compare" (= ct2,mlx) multiplies with '
                           "--model into a run matrix")
    p_tr.add_argument("--diarize", action="store_true")
    p_tr.add_argument("--min-speakers", type=int, default=2)
    p_tr.add_argument("--max-speakers", type=int, default=2)
    p_tr.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"],
                      help="torch stages only; ASR is always cpu (ctranslate2)")
    p_tr.add_argument("--compute-type", default="int8")
    p_tr.add_argument("--batch-size", type=int, default=8)

    args = parser.parse_args()
    handler = {"doctor": cmd_doctor, "transcribe": cmd_transcribe}[args.command]
    sys.exit(handler(args))
