import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Insight, SessionDetail } from '../api'
import { ReviewView, sortByAppearance } from './ReviewView'

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

afterEach(() => {
  vi.clearAllMocks()
})

function makeDetail(insights: Insight[]): SessionDetail {
  return {
    session: {
      id: 'test-session', title: 'Test session', status: 'reviewing',
      origin: 'local', createdAt: 0, durationS: 400, error: null, curated: false,
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
})
