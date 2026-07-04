"""Comparison of multiple pipeline runs over the same audio.

Used two ways:
- doctor --e2e: two backends vs a known script (ground truth available)
- transcribe --model compare: real recordings, no ground truth — so we measure
  how much the outputs diverge from each other and show every place they do.
"""

import difflib
import re

COMPARE_ALIAS = ["large-v3", "large-v3-turbo"]
BACKENDS = ("ct2", "mlx")


def parse_specs(model_arg: str, backend_arg: str) -> list[tuple[str, str]]:
    """Build the run matrix: models × backends.

    Both flags accept a comma list; both accept 'compare' ('large-v3,
    large-v3-turbo' / 'ct2,mlx'). A model entry with an explicit 'backend:'
    prefix is pinned and doesn't multiply over the backend list.
    """
    backends = BACKENDS if backend_arg == "compare" \
        else tuple(b.strip() for b in backend_arg.split(","))
    models = COMPARE_ALIAS if model_arg == "compare" else model_arg.split(",")

    specs: list[tuple[str, str]] = []
    for part in models:
        pinned, _, model = part.strip().rpartition(":")
        if pinned:
            specs.append((pinned, model))
        else:
            specs.extend((backend, model) for backend in backends)
    for backend, _ in specs:
        if backend not in BACKENDS:
            raise ValueError(f"unknown backend: {backend} (expected one of {'/'.join(BACKENDS)})")
    return list(dict.fromkeys(specs))  # dedupe, keep order


def normalize_token(text: str) -> str:
    return re.sub(r"[^\w%]", "", text.lower())


def totals(meta: dict) -> tuple[float, float]:
    """(total_s, work_s) for a run. Prefers the recorded true elapsed time
    (stages overlap since diarization runs concurrently with ASR); falls back
    to summing stages for result files that predate total_wall_clock_s.
    work_s excludes the model loads on the critical path (diarize_load
    overlaps ASR, so it never counts)."""
    stages = meta["stages"]
    total = meta.get("total_wall_clock_s")
    if total is None:
        return (
            sum(s["wall_clock_s"] for s in stages.values()),
            sum(s["wall_clock_s"] for n, s in stages.items() if not n.endswith("_load")),
        )
    loads = sum(stages[n]["wall_clock_s"] for n in ("asr_load", "align_load") if n in stages)
    return total, total - loads


def print_stage_table(results: dict[str, dict], pad: str = "  ",
                      extra_rows: list[tuple[str, list[str]]] | None = None) -> None:
    labels = list(results)
    col = max(22, max(len(l) for l in labels) + 14)

    def row(label: str, cells: list[str]) -> None:
        print(pad + label.ljust(20) + "".join(str(c).ljust(col) for c in cells))

    row("stage", [f"{l} (asr: {results[l]['meta']['stages']['asr']['device']})"
                  for l in labels])
    stage_names: list[str] = []
    for result in results.values():
        for name in result["meta"]["stages"]:
            if name not in stage_names:
                stage_names.append(name)
    for name in stage_names:
        row(name, [
            f"{results[l]['meta']['stages'][name]['wall_clock_s']}s"
            if name in results[l]["meta"]["stages"] else "-"
            for l in labels
        ])
    perf = {l: totals(results[l]["meta"]) for l in labels}
    row("total", [f"{perf[l][0]:.1f}s" for l in labels])
    row("speed (excl. load)", [
        f"{results[l]['meta']['duration_s'] / perf[l][1]:.1f}x realtime" if perf[l][1] else "-"
        for l in labels
    ])
    for extra in extra_rows or []:
        row(*extra)


def _fmt_time(t: float | None) -> str:
    return f"{int(t) // 60:02d}:{t % 60:04.1f}" if t is not None else "?"


def _region_time(words: list[dict], i1: int, i2: int) -> tuple[float | None, float | None]:
    starts = [w["start"] for w in words[i1:i2] if w["start"] is not None]
    ends = [w["end"] for w in words[i1:i2] if w["end"] is not None]
    return (min(starts) if starts else None, max(ends) if ends else None)


def _snippet(words: list[dict], i1: int, i2: int, context: int) -> str:
    """Region text with `context` words around it; differing words marked «so»."""
    lo, hi = max(0, i1 - context), min(len(words), i2 + context)
    parts = [f"«{w['text']}»" if i1 <= k < i2 else w["text"]
             for k, w in enumerate(words[lo:hi], start=lo)]
    return (("… " if lo > 0 else "") + " ".join(parts) + (" …" if hi < len(words) else "")) or "∅"


def print_diffs(results: dict[str, dict], pad: str = "  ",
                context: int = 4, gap: int = 3) -> None:
    """Divergence report. With two results: one pairwise diff. With a larger
    matrix: every other run diffed against the first spec (the reference)."""
    labels = list(results)
    for other in labels[1:]:
        if len(labels) > 2:
            print(f"\n{pad}━━ {labels[0]}  vs  {other} ━━")
        _print_pair_diff(labels[0], results[labels[0]], other, results[other],
                         pad=pad, context=context, gap=gap)


def _print_pair_diff(label_a: str, a: dict, label_b: str, b: dict,
                     pad: str, context: int, gap: int) -> None:
    words_a, words_b = a["words"], b["words"]
    tokens_a = [normalize_token(w["text"]) for w in words_a]
    tokens_b = [normalize_token(w["text"]) for w in words_b]

    matcher = difflib.SequenceMatcher(a=tokens_a, b=tokens_b, autojunk=False)
    ops = [op for op in matcher.get_opcodes() if op[0] != "equal"]
    diff_words = sum(max(i2 - i1, j2 - j1) for _, i1, i2, j1, j2 in ops)
    base = max(len(tokens_a), len(tokens_b)) or 1

    print()
    if not ops:
        print(f"{pad}outputs are word-identical (after case/punctuation normalization)")
        return
    # merge diff spans separated by fewer than `gap` agreeing words
    regions = [list(ops[0][1:])]
    for _, i1, i2, j1, j2 in ops[1:]:
        if i1 - regions[-1][1] <= gap:
            regions[-1][1], regions[-1][3] = max(regions[-1][1], i2), max(regions[-1][3], j2)
        else:
            regions.append([i1, i2, j1, j2])
    print(f"{pad}difference: {diff_words}/{base} words ({100 * diff_words / base:.1f}%), "
          f"{len(regions)} differing section(s):")

    width = max(len(label_a), len(label_b))
    for i1, i2, j1, j2 in regions:
        start, end = _region_time(words_a, i1, i2)
        if start is None:
            start, end = _region_time(words_b, j1, j2)
        speakers = [w["speaker"] for w in words_a[i1:i2] if w["speaker"]] \
            or [w["speaker"] for w in words_b[j1:j2] if w["speaker"]]
        speaker = max(set(speakers), key=speakers.count) if speakers else "?"
        print(f"\n{pad}[{_fmt_time(start)}–{_fmt_time(end)}] {speaker}")
        print(f"{pad}  {label_a.ljust(width)}: {_snippet(words_a, i1, i2, context)}")
        print(f"{pad}  {label_b.ljust(width)}: {_snippet(words_b, j1, j2, context)}")
