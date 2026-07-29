import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { api, type Insight, type SessionDetail, type Transcript } from '../api'
import {
  COLLAPSED_HEIGHT_PX, type CollapsedGap, createTimeScale, deriveCollapsedGaps, DEFAULT_PX_PER_SEC,
  effectiveWordEnd, GAP_THRESHOLD_S, type LayoutBlock, MIN_BLOCK_GAP_PX, resolveBlockOverlaps, resolveSegmentTimes,
  ReviewView, type SegmentSpan, setIfChanged, sortByAppearance, withEffectiveWordEnds,
} from './ReviewView'

// --- jsdom gaps --------------------------------------------------------------
// jsdom has no ResizeObserver at all; SnippetPlayer's `full` (session-bar)
// variant constructs one to size its waveform canvas. A minimal no-op stub is
// enough — nothing in these tests asserts on canvas pixel output.
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

// --- part 1: the pure sort function ------------------------------------------

function insight(overrides: Partial<Insight> & { startWord?: number; endWord?: number }): Insight {
  const { startWord = 0, endWord = 1, ...rest } = overrides
  return {
    id: 0,
    sessionId: 's',
    origin: 'manual',
    harvestSpanId: null,
    mainSnippetId: 1,
    title: '',
    description: '',
    status: 'proposed',
    main: { id: 1, sessionId: 's', startWord, endWord, quote: '', anchored: true, spokenAt: null, status: 'proposed' },
    supporting: [],
    ...rest,
  }
}

describe('sortByAppearance', () => {
  it('orders by startWord ascending, scrambled ids included', () => {
    // ids deliberately anti-correlated with startWord: creation order here
    // is exactly the reverse of appearance order.
    const a = insight({ id: 30, startWord: 10, endWord: 20 })
    const b = insight({ id: 20, startWord: 150, endWord: 160 })
    const c = insight({ id: 10, startWord: 300, endWord: 310 })
    expect(sortByAppearance([c, b, a]).map((i) => i.id)).toEqual([30, 20, 10])
  })

  it('breaks a startWord tie by endWord', () => {
    const shorter = insight({ id: 1, startWord: 50, endWord: 55 })
    const longer = insight({ id: 2, startWord: 50, endWord: 90 })
    expect(sortByAppearance([longer, shorter]).map((i) => i.id)).toEqual([1, 2])
  })

  it('breaks a startWord+endWord tie by id', () => {
    const later = insight({ id: 9, startWord: 50, endWord: 55 })
    const earlier = insight({ id: 3, startWord: 50, endWord: 55 })
    expect(sortByAppearance([later, earlier]).map((i) => i.id)).toEqual([3, 9])
  })

  it('does not mutate its input array', () => {
    const original = [
      insight({ id: 3, startWord: 300, endWord: 310 }),
      insight({ id: 2, startWord: 150, endWord: 160 }),
      insight({ id: 1, startWord: 10, endWord: 20 }),
    ]
    const originalOrderIds = original.map((i) => i.id)
    const sorted = sortByAppearance(original)
    expect(original.map((i) => i.id)).toEqual(originalOrderIds) // unchanged
    expect(sorted).not.toBe(original) // a different array, not sort()-in-place
    expect(sorted.map((i) => i.id)).toEqual([1, 2, 3])
  })

  it('handles the empty list', () => {
    expect(sortByAppearance([])).toEqual([])
  })

  it('handles a single element', () => {
    const only = insight({ id: 7, startWord: 5, endWord: 6 })
    expect(sortByAppearance([only])).toEqual([only])
  })
})

// --- part 1b: resolveSegmentTimes' deterministic fallback --------------------
// (groupSegmentsIntoRows, the row-grouped "compact" view it fed, and their
// OTHER_SPEAKER sentinel have all been deleted — the mode toggle is
// timeline ↔ Jim's original linear layout now, not timeline ↔ a row-grouped
// grid. This fallback logic survives because deriveCollapsedGaps and the
// timeline's own block placement still need it. Unrelated to the still-live
// OTHER_COLUMN sentinel inside TimelineTranscript, which is a different
// symbol for the same "unmatched speaker" idea, despite the similar name.)

function span(id: number, speaker: string | null, startS: number | null, endS: number | null): SegmentSpan {
  return { id, speaker, startS, endS }
}

describe('resolveSegmentTimes', () => {
  it('passes already-resolved times through unchanged', () => {
    const segs = [span(1, 'jim', 0, 5), span(2, 'jesse', 6, 10)]
    expect(resolveSegmentTimes(segs)).toEqual([
      { id: 1, speaker: 'jim', startS: 0, endS: 5 },
      { id: 2, speaker: 'jesse', startS: 6, endS: 10 },
    ])
  })

  it('pins an unresolved segment to a zero-width span right after the previous resolved end', () => {
    const segs = [span(1, 'jim', 0, 5), span(2, 'jesse', null, null), span(3, 'jim', 20, 25)]
    expect(resolveSegmentTimes(segs)).toEqual([
      { id: 1, speaker: 'jim', startS: 0, endS: 5 },
      { id: 2, speaker: 'jesse', startS: 5, endS: 5 },
      { id: 3, speaker: 'jim', startS: 20, endS: 25 },
    ])
  })

  it('pins a leading unresolved segment to 0 when nothing has resolved yet', () => {
    const segs = [span(1, 'jim', null, null), span(2, 'jesse', 10, 12)]
    expect(resolveSegmentTimes(segs)).toEqual([
      { id: 1, speaker: 'jim', startS: 0, endS: 0 },
      { id: 2, speaker: 'jesse', startS: 10, endS: 12 },
    ])
  })

  it('handles empty input', () => {
    expect(resolveSegmentTimes([])).toEqual([])
  })
})

// --- part 1b2: the word-end clamp (WhisperX forced-alignment padding) -------
// Real case behind this: session 2026-07-18-qffr, segment 55, the word
// "doen?" — WhisperX timestamped it 374.175 → 380.800 (6.6s for one word),
// when jesse actually stopped around 374.7 and jim's reply starts at
// 375.081. Reused as the fixture below rather than an invented example.

describe('effectiveWordEnd', () => {
  it('clamps an inflated final word (the segment-55 "doen?" case)', () => {
    const word = { start: 374.175, end: 380.800, text: 'doen?' }
    // cap = 374.175 + 0.35 + 0.10*5 = 375.025 — comfortably before jim's
    // reply at 375.081, unlike the raw 380.800 which overlapped it by 5.7s.
    expect(effectiveWordEnd(word)).toBeCloseTo(375.025, 5)
    expect(effectiveWordEnd(word)!).toBeLessThan(375.081)
  })

  it('leaves a normal-length word untouched', () => {
    // cap = 0 + 0.35 + 0.10*2 = 0.55, well above this word's real 0.5s.
    const word = { start: 0, end: 0.5, text: 'so' }
    expect(effectiveWordEnd(word)).toBe(0.5)
  })

  it('scales the clamp with character count', () => {
    const short = effectiveWordEnd({ start: 0, end: 100, text: 'Doe' }) // 3 chars
    const long = effectiveWordEnd({ start: 0, end: 100, text: 'uitleggen' }) // 9 chars
    expect(short).toBeCloseTo(0.65, 5) // 0.35 + 0.10*3
    expect(long).toBeCloseTo(1.25, 5) // 0.35 + 0.10*9
    expect(long!).toBeGreaterThan(short!)
  })

  it('never returns a time before start, even with malformed input where raw end < start', () => {
    const word = { start: 10, end: 3, text: 'x' }
    expect(effectiveWordEnd(word)).toBe(10)
  })

  it('never extends a word — an already-short duration passes through exactly', () => {
    const word = { start: 5, end: 5.05, text: 'ja' }
    expect(effectiveWordEnd(word)).toBe(5.05)
  })

  it('passes null start/end through safely without throwing', () => {
    expect(effectiveWordEnd({ start: null, end: 5, text: 'x' })).toBe(5)
    expect(effectiveWordEnd({ start: 1, end: null, text: 'x' })).toBeNull()
    expect(effectiveWordEnd({ start: null, end: null, text: 'x' })).toBeNull()
  })
})

describe('withEffectiveWordEnds', () => {
  function transcriptFixture(): Transcript {
    return {
      meta: { duration_s: 400 },
      segments: [
        { id: 55, text: '… doen?', speaker: 'jesse' },
        { id: 56, text: 'Ja, dat snap ik.', speaker: 'jim' },
      ],
      words: [
        { index: 0, text: 'dan', start: 373.995, end: 374.135, aligned: true, speaker: 'jesse', segment_id: 55 },
        { index: 1, text: 'doen?', start: 374.175, end: 380.800, aligned: true, speaker: 'jesse', segment_id: 55 },
        { index: 2, text: 'Ja,', start: 375.081, end: 375.242, aligned: true, speaker: 'jim', segment_id: 56 },
        { index: 3, text: 'bedoelt.', start: 375.782, end: 376.042, aligned: true, speaker: 'jim', segment_id: 56 },
      ],
    }
  }

  it('clamps the inflated word and leaves everything else — and the input transcript — untouched', () => {
    const original = transcriptFixture()
    const corrected = withEffectiveWordEnds(original)

    expect(corrected.words[1]!.end).toBeCloseTo(375.025, 5)
    expect(corrected.words[0]!.end).toBe(374.135) // untouched: already reasonable
    expect(corrected.words[2]!.end).toBe(375.242) // untouched
    expect(corrected.words[3]!.end).toBe(376.042) // untouched

    // Pure: the original object (fetched from the API) is never mutated.
    expect(original.words[1]!.end).toBe(380.800)
    expect(corrected).not.toBe(original)
    expect(corrected.words).not.toBe(original.words)
  })

  it('regression: a segment whose last word is inflated by ~6s no longer overlaps the following speaker\'s segment', () => {
    // Segment bounds the way TranscriptPane derives them: min word start,
    // max word end, per segment.
    const boundsOf = (t: Transcript, segId: number) => {
      const ws = t.words.filter((w) => w.segment_id === segId)
      return { startS: Math.min(...ws.map((w) => w.start!)), endS: Math.max(...ws.map((w) => w.end!)) }
    }

    const raw = transcriptFixture()
    const seg55Raw = boundsOf(raw, 55)
    const seg56Raw = boundsOf(raw, 56)
    // Before the fix: jesse's segment (ending 380.8) overlaps jim's
    // (starting 375.081) by 5.7 seconds — the phantom overlap the user saw.
    expect(seg55Raw.endS).toBeGreaterThan(seg56Raw.startS)

    const corrected = withEffectiveWordEnds(raw)
    const seg55Fixed = boundsOf(corrected, 55)
    const seg56Fixed = boundsOf(corrected, 56)
    // After: jesse's corrected end (375.025) lands before jim's start
    // (375.081) — no overlap, a clean handoff.
    expect(seg55Fixed.endS).toBeLessThanOrEqual(seg56Fixed.startS)
  })
})

describe('effectiveWordEnd + deriveCollapsedGaps', () => {
  it('reveals a genuine silence that an inflated word end previously masked', () => {
    // jim's last word really ends around 10.2s; he then falls genuinely
    // silent until jesse speaks again at 55s — a ~45s silence, well over
    // GAP_THRESHOLD_S. But the aligner padded that word's raw `end` to
    // 50.0, papering over all but the last 5 seconds of it.
    const jimLastWord = { start: 9.8, end: 50.0, text: 'oké.' }

    const rawBounds = [{ startS: 9.8, endS: jimLastWord.end }, { startS: 55, endS: 56 }]
    expect(deriveCollapsedGaps(rawBounds, GAP_THRESHOLD_S)).toEqual([]) // masked: looked like only a 5s gap

    const clampedEnd = effectiveWordEnd(jimLastWord)!
    const clampedBounds = [{ startS: 9.8, endS: clampedEnd }, { startS: 55, endS: 56 }]
    const gaps = deriveCollapsedGaps(clampedBounds, GAP_THRESHOLD_S)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.startS).toBeCloseTo(clampedEnd, 5)
    expect(gaps[0]!.endS).toBe(55)
  })
})

// --- part 1c: timeline mode's pure math --------------------------------------

describe('deriveCollapsedGaps', () => {
  it('finds a gap only when no speaker is talking', () => {
    const segs = [{ startS: 0, endS: 5 }, { startS: 45, endS: 50 }]
    expect(deriveCollapsedGaps(segs, GAP_THRESHOLD_S)).toEqual([{ startS: 5, endS: 45 }])
  })

  it('never yields a gap for overlapping speech, even when a later segment out-runs an earlier one', () => {
    // B starts inside A and runs well past it; C starts inside B. The
    // running "latest end so far" has to track the MAX across all of them,
    // not just whichever segment came last — a naive "gap since the
    // previous segment's own end" check would wrongly see silence after A.
    const segs = [{ startS: 0, endS: 10 }, { startS: 5, endS: 100 }, { startS: 20, endS: 40 }]
    expect(deriveCollapsedGaps(segs, GAP_THRESHOLD_S)).toEqual([])
  })

  it('treats a gap of exactly the threshold as collapsible (inclusive boundary)', () => {
    const segs = [{ startS: 0, endS: 10 }, { startS: 10 + GAP_THRESHOLD_S, endS: 10 + GAP_THRESHOLD_S + 5 }]
    expect(deriveCollapsedGaps(segs, GAP_THRESHOLD_S)).toEqual([{ startS: 10, endS: 10 + GAP_THRESHOLD_S }])
  })

  it('does not collapse a gap just under the threshold', () => {
    const segs = [{ startS: 0, endS: 10 }, { startS: 10 + GAP_THRESHOLD_S - 0.1, endS: 45 }]
    expect(deriveCollapsedGaps(segs, GAP_THRESHOLD_S)).toEqual([])
  })
})

describe('createTimeScale', () => {
  it('maps time to pixels linearly at the given pxPerSec with no gaps', () => {
    const scale = createTimeScale({ durationS: 100, collapsedGaps: [], pxPerSec: 5, collapsedHeightPx: 28 })
    expect(scale.toY(0)).toBe(0)
    expect(scale.toY(10)).toBe(50)
    expect(scale.toY(100)).toBe(500)
    expect(scale.totalHeight).toBe(500)
  })

  it('collapses a gap to a fixed height and shifts everything after it up by that height', () => {
    // A 240s real silence [10, 250) collapses to a flat 28px, however long
    // it actually ran.
    const gaps: CollapsedGap[] = [{ startS: 10, endS: 250 }]
    const scale = createTimeScale({ durationS: 300, collapsedGaps: gaps, pxPerSec: 5, collapsedHeightPx: 28 })
    expect(scale.toY(10)).toBe(50) // 10s * 5px/s, right at the gap's start
    expect(scale.toY(250)).toBe(78) // +28 fixed, not +1200 (240s * 5px/s)
    expect(scale.toY(300)).toBe(328) // +50s of ordinary speech after the gap
    expect(scale.totalHeight).toBe(328)
  })

  it('round-trips toTime(toY(t)) ≈ t, including for a time inside a collapsed gap', () => {
    const gaps: CollapsedGap[] = [{ startS: 10, endS: 250 }]
    const scale = createTimeScale({ durationS: 300, collapsedGaps: gaps, pxPerSec: 5, collapsedHeightPx: 28 })
    for (const t of [0, 5, 10, 130, 249.9, 250, 275, 300]) {
      expect(scale.toTime(scale.toY(t))).toBeCloseTo(t, 5)
    }
  })

  it('scales non-collapsed positions proportionally with zoom, leaving the collapsed height fixed', () => {
    const gaps: CollapsedGap[] = [{ startS: 10, endS: 250 }]
    const narrow = createTimeScale({ durationS: 300, collapsedGaps: gaps, pxPerSec: 5, collapsedHeightPx: 28 })
    const wide = createTimeScale({ durationS: 300, collapsedGaps: gaps, pxPerSec: 10, collapsedHeightPx: 28 })
    expect(wide.toY(10)).toBe(narrow.toY(10) * 2) // before the gap: purely proportional to pxPerSec
    expect(wide.toY(250) - wide.toY(10)).toBe(28) // the gap itself: untouched by zoom
    expect(wide.toY(250) - wide.toY(10)).toBe(narrow.toY(250) - narrow.toY(10))
  })
})

describe('resolveBlockOverlaps', () => {
  function block(id: number, column: string, y: number, height: number): LayoutBlock {
    return { id, column, y, height }
  }

  it('leaves already-spaced blocks at their natural y (no-collision passthrough)', () => {
    const blocks = [block(1, 'jim', 0, 20), block(2, 'jim', 100, 20)]
    const ys = resolveBlockOverlaps(blocks, MIN_BLOCK_GAP_PX)
    expect(ys.get(1)).toBe(0)
    expect(ys.get(2)).toBe(100)
  })

  it('pushes an overlapping block down by exactly the deficit', () => {
    // Block 1 occupies [0, 50); block 2 naturally starts at 30 (inside
    // that), so it must move to exactly 50 + minGapPx — no further.
    const blocks = [block(1, 'jim', 0, 50), block(2, 'jim', 30, 20)]
    const ys = resolveBlockOverlaps(blocks, MIN_BLOCK_GAP_PX)
    expect(ys.get(1)).toBe(0)
    expect(ys.get(2)).toBe(54)
  })

  it('chains a push through three overlapping blocks', () => {
    const blocks = [block(1, 'jim', 0, 50), block(2, 'jim', 10, 50), block(3, 'jim', 20, 50)]
    const ys = resolveBlockOverlaps(blocks, MIN_BLOCK_GAP_PX)
    expect(ys.get(1)).toBe(0) // natural, bottom 50
    expect(ys.get(2)).toBe(54) // 50 + 4, bottom 104
    expect(ys.get(3)).toBe(108) // 104 + 4, bottom 158
  })

  it('keeps columns independent — an overlap in one column never affects another', () => {
    const blocks = [
      block(1, 'jim', 0, 50), block(2, 'jim', 10, 50), // overlaps: jim gets pushed
      block(3, 'jesse', 0, 10), block(4, 'jesse', 20, 10), // plenty of room: no push
    ]
    const ys = resolveBlockOverlaps(blocks, MIN_BLOCK_GAP_PX)
    expect(ys.get(1)).toBe(0)
    expect(ys.get(2)).toBe(54)
    expect(ys.get(3)).toBe(0)
    expect(ys.get(4)).toBe(20)
  })
})

describe('setIfChanged', () => {
  it('calls the setter on the first value and on every real change, never on a repeat', () => {
    // This is the exact shape a 60fps position-subscription callback drives
    // it with: the same derived value (e.g. "still segment 5") arriving
    // many times in a row must collapse to zero setter calls, which is
    // what keeps TranscriptPane from re-rendering on every animation frame.
    const ref = { current: null as number | null }
    const seen: (number | null)[] = []
    const setter = (v: number | null) => seen.push(v)

    expect(setIfChanged(ref, 5, setter)).toBe(true)
    expect(setIfChanged(ref, 5, setter)).toBe(false)
    expect(setIfChanged(ref, 5, setter)).toBe(false)
    expect(setIfChanged(ref, 6, setter)).toBe(true)
    expect(setIfChanged(ref, 6, setter)).toBe(false)
    expect(setIfChanged(ref, null, setter)).toBe(true)
    expect(setIfChanged(ref, null, setter)).toBe(false)

    expect(seen).toEqual([5, 6, null])
  })

  it('treats independent refs independently', () => {
    const segRef = { current: null as number | null }
    const wordRef = { current: null as number | null }
    const segSeen: (number | null)[] = []
    const wordSeen: (number | null)[] = []

    setIfChanged(segRef, 1, (v) => segSeen.push(v))
    setIfChanged(wordRef, 1, (v) => wordSeen.push(v))
    setIfChanged(segRef, 1, (v) => segSeen.push(v)) // segment unchanged
    setIfChanged(wordRef, 2, (v) => wordSeen.push(v)) // word advanced

    expect(segSeen).toEqual([1])
    expect(wordSeen).toEqual([1, 2])
  })
})

// --- part 2: mocking so ReviewView can actually mount ------------------------
// Real `api` module throughout EXCEPT the two async calls that fire on mount:
// api.transcript (ReviewView's own effect) and api.peaks (the session-bar
// SnippetPlayer's `full` variant, fetching its loudness waveform). Everything
// else — fmtTime, audioUrl, manualSnippet, etc. — stays the real
// implementation; nothing else is called during a plain mount+read.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      transcript: vi.fn().mockResolvedValue({ meta: { duration_s: 0 }, segments: [], words: [] }),
      peaks: vi.fn().mockResolvedValue({ buckets: [] }),
    },
  }
})

// testing-library's own auto-cleanup only self-registers when it finds a
// GLOBAL `afterEach` (globalThis.afterEach) — true under Jest, but this
// project's vitest.config.ts doesn't set `test.globals: true`, so importing
// `afterEach` from 'vitest' (as this file does) never satisfies that check.
// Explicit `cleanup()` here is what actually unmounts a render() between
// tests; without it, a second `describe` block that mounts ReviewView (as
// the timeline-mode tests below do) would find the PREVIOUS test's tree
// still attached to `document.body` and every `document.getElementById`/
// `screen.getByText` lookup would see both at once.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeDetail(insights: Insight[]): SessionDetail {
  return {
    session: {
      id: 'test-session', title: 'Test session', status: 'reviewing',
      origin: 'local', createdAt: 0, durationS: 400, summary: null, error: null, curated: false,
    },
    participants: [],
    speakers: [],
    markers: [],
    gaps: [],
    harvestSpans: [],
    insights,
    hasTranscript: true,
  }
}

describe('ReviewView (render)', () => {
  it('renders snippet cards in conversation order, not the id order the API returned them in', async () => {
    // id order is the REVERSE of startWord (appearance) order — exactly the
    // "just-created snippet quoting the first sentence lands at the bottom"
    // scenario the sort exists to fix.
    const detail = makeDetail([
      insight({ id: 10, title: 'Third topic', startWord: 300, endWord: 310 }),
      insight({ id: 20, title: 'Second topic', startWord: 150, endWord: 160 }),
      insight({ id: 30, title: 'First topic', startWord: 10, endWord: 20 }),
    ])

    render(<ReviewView detail={detail} refresh={vi.fn()} onError={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('First topic')).toBeTruthy()
    })

    const titles = screen.getAllByText(/topic$/).map((el) => el.textContent)
    expect(titles).toEqual(['First topic', 'Second topic', 'Third topic'])
  })

  it('switches a two-speaker session to linear mode and renders Jim\'s original single-column layout', async () => {
    // Same shape of fixture as the timeline-mode test below (jim, jesse
    // interjecting, jim again) — but this asserts that flipping the toggle
    // to `linear` renders Jim's ORIGINAL layout verbatim: one
    // <p class="segment"> per segment, in document order, each with its own
    // .speaker-tag cell — no grid, no columns, none of the timeline's own
    // classes. A two-speaker session now defaults to the timeline view, so
    // this clicks over to linear first.
    const transcript: Transcript = {
      meta: { duration_s: 20 },
      segments: [
        { id: 1, text: 'so I was thinking', speaker: 'jim' },
        { id: 2, text: 'right right', speaker: 'jesse' },
        { id: 3, text: 'anyway', speaker: 'jim' },
      ],
      words: [
        { index: 0, text: 'so', start: 0, end: 0.5, aligned: true, speaker: 'jim', segment_id: 1 },
        { index: 1, text: 'thinking', start: 2.5, end: 3, aligned: true, speaker: 'jim', segment_id: 1 },
        { index: 2, text: 'right', start: 1, end: 1.5, aligned: true, speaker: 'jesse', segment_id: 2 },
        { index: 3, text: 'right', start: 1.5, end: 2, aligned: true, speaker: 'jesse', segment_id: 2 },
        { index: 4, text: 'anyway', start: 10, end: 12, aligned: true, speaker: 'jim', segment_id: 3 },
      ],
    }
    vi.mocked(api.transcript).mockResolvedValueOnce(transcript)

    const detail = makeDetail([])
    detail.speakers = [
      { id: 1, label: 'jim', participantId: null, sampleStartS: null, sampleEndS: null, sampleText: null },
      { id: 2, label: 'jesse', participantId: null, sampleStartS: null, sampleEndS: null, sampleText: null },
    ]

    render(<ReviewView detail={detail} refresh={vi.fn()} onError={vi.fn()} />)

    await waitFor(() => {
      expect(document.getElementById('segment-1')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('linear'))

    // Jim's original markup: one <p class="segment"> per segment, each with
    // its own .speaker-tag — no timeline remnants of any kind.
    const segs = document.querySelectorAll('p.segment')
    expect(segs).toHaveLength(3)
    expect(document.querySelectorAll('.speaker-tag')).toHaveLength(3)
    expect(document.querySelector('.timeline-track')).toBeNull()
    expect(document.querySelector('.timeline-header')).toBeNull()

    // Document order matches transcript order (not grouped or reordered).
    const ids = [...segs].map((el) => el.id)
    expect(ids).toEqual(['segment-1', 'segment-2', 'segment-3'])

    // Speaker names attach to the right segment.
    expect(segs[0]!.querySelector('.speaker-tag')!.textContent).toBe('jim')
    expect(segs[1]!.querySelector('.speaker-tag')!.textContent).toBe('jesse')
    expect(segs[2]!.querySelector('.speaker-tag')!.textContent).toBe('jim')
  })
})

describe('ReviewView (timeline mode, render)', () => {
  it('defaults a two-speaker session to the timeline view, places segments proportionally to elapsed time, and collapses the long silence between them', async () => {
    // jim [0,5] then, after a 240s silence nobody fills, jesse [245,248].
    // Different speakers/columns, so the collision-push pass can't move
    // either one — the `top` each gets is purely scale.toY(startS), making
    // the pixel delta a direct, computable function of GAP_THRESHOLD_S/
    // COLLAPSED_HEIGHT_PX/DEFAULT_PX_PER_SEC (no click needed: this is the
    // default mode for an untouched two-speaker session).
    const transcript: Transcript = {
      meta: { duration_s: 248 },
      segments: [
        { id: 1, text: 'so I was thinking', speaker: 'jim' },
        { id: 2, text: 'sorry, go on', speaker: 'jesse' },
      ],
      words: [
        { index: 0, text: 'so', start: 0, end: 0.5, aligned: true, speaker: 'jim', segment_id: 1 },
        { index: 1, text: 'thinking', start: 4.5, end: 5, aligned: true, speaker: 'jim', segment_id: 1 },
        { index: 2, text: 'sorry', start: 245, end: 245.5, aligned: true, speaker: 'jesse', segment_id: 2 },
        { index: 3, text: 'on', start: 247.5, end: 248, aligned: true, speaker: 'jesse', segment_id: 2 },
      ],
    }
    vi.mocked(api.transcript).mockResolvedValueOnce(transcript)

    const detail = makeDetail([])
    detail.speakers = [
      { id: 1, label: 'jim', participantId: null, sampleStartS: null, sampleEndS: null, sampleText: null },
      { id: 2, label: 'jesse', participantId: null, sampleStartS: null, sampleEndS: null, sampleText: null },
    ]

    render(<ReviewView detail={detail} refresh={vi.fn()} onError={vi.fn()} />)

    await waitFor(() => {
      expect(document.getElementById('segment-1')).toBeTruthy()
    })

    // Default mode, no click: the toggle exists (proving the two-speaker
    // switch fired) and reads "timeline" as the active one.
    expect(screen.getByText('timeline').className).toContain('active')

    const seg1 = document.getElementById('segment-1') as HTMLElement
    const seg2 = document.getElementById('segment-2') as HTMLElement
    const top1 = parseFloat(seg1.style.top)
    const top2 = parseFloat(seg2.style.top)
    // 5s of ordinary speech before the gap, plus the gap's fixed collapsed
    // height, plus zero (jesse starts exactly when the gap ends) — NOT
    // 245 * DEFAULT_PX_PER_SEC, which is what an uncollapsed, purely
    // time-proportional layout would have produced.
    expect(top2 - top1).toBeCloseTo(5 * DEFAULT_PX_PER_SEC + COLLAPSED_HEIGHT_PX, 5)

    // The collapsed gap itself renders as a labelled marker (240s = 4m 0s).
    const marker = document.querySelector('.timeline-gap')
    expect(marker).toBeTruthy()
    expect(marker!.textContent).toContain('4m 0s')
    expect(marker!.textContent).toContain('silence')
  })
})

describe('ReviewView (play/pause FAB)', () => {
  // jsdom's HTMLMediaElement.play()/pause() are pure no-op stubs (see
  // audio.test.ts's own note) — `playingKey` only ever flips via a REAL
  // 'play'/'pause' event, which jsdom never fires on its own. Subclassing
  // the global `Audio` constructor captures the underlying element so this
  // test can dispatch those events itself, the same way audio.test.ts does.
  let created: HTMLAudioElement[]

  const stubAudio = () => {
    created = []
    const OriginalAudio = window.Audio
    class TrackedAudio extends OriginalAudio {
      constructor(src?: string) {
        super(src)
        created.push(this)
      }
    }
    vi.stubGlobal('Audio', TrackedAudio)
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appears only once the player has an active range, and reflects play/pause state', async () => {
    stubAudio()
    const detail = makeDetail([])

    render(<ReviewView detail={detail} refresh={vi.fn()} onError={vi.fn()} />)

    await waitFor(() => {
      expect(document.querySelector('.play-pause-fab')).toBeTruthy()
    })
    const fab = document.querySelector('.play-pause-fab') as HTMLElement

    // Nothing loaded yet: kept mounted (same fade pattern as ToTopButton)
    // but faded out and out of the tab order/AT tree.
    expect(fab.className).toContain('away')
    expect(fab.getAttribute('aria-hidden')).toBe('true')
    expect(fab.tabIndex).toBe(-1)

    // Start the session-bar player (the whole-recording SnippetPlayer's own
    // play button) — this is what gives the player an active range.
    const sessionPlayButton = document.querySelector('.session-player .icon-btn') as HTMLElement
    fireEvent.click(sessionPlayButton)

    await waitFor(() => {
      expect(fab.className).not.toContain('away')
    })
    expect(fab.getAttribute('aria-hidden')).toBe('false')
    // toggle() called the underlying play(), but jsdom's play() is a no-op
    // stub that never fires a real 'play' event, so playingKey is still
    // null at this point — same caveat as audio.test.ts.
    expect(fab.textContent).toBe('▶')
    expect(fab.getAttribute('aria-label')).toBe('Play')

    // Simulate the browser actually starting playback.
    const el = created[0]!
    fireEvent(el, new Event('play'))
    await waitFor(() => {
      expect(fab.textContent).toBe('⏸')
    })
    expect(fab.getAttribute('aria-label')).toBe('Pause')

    // Clicking the FAB calls togglePlayPause() (verified directly and more
    // thoroughly in audio.test.ts); here, drive the resulting native
    // 'pause' event and confirm the FAB's own icon/label follow it back.
    fireEvent.click(fab)
    fireEvent(el, new Event('pause'))
    await waitFor(() => {
      expect(fab.textContent).toBe('▶')
    })
    expect(fab.getAttribute('aria-label')).toBe('Play')
  })
})
