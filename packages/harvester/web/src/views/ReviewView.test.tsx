import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Snippet, SessionDetail } from '../api'
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

function snippet(overrides: Partial<Snippet>): Snippet {
  return {
    id: 0,
    origin: 'manual',
    harvestSpanId: null,
    title: '',
    startWord: 0,
    endWord: 1,
    quote: '',
    note: '',
    anchored: true,
    status: 'proposed',
    supporting: [],
    ...overrides,
  }
}

describe('sortByAppearance', () => {
  it('orders by startWord ascending, scrambled ids included', () => {
    // ids deliberately anti-correlated with startWord: creation order here
    // is exactly the reverse of appearance order.
    const a = snippet({ id: 30, startWord: 10, endWord: 20 })
    const b = snippet({ id: 20, startWord: 150, endWord: 160 })
    const c = snippet({ id: 10, startWord: 300, endWord: 310 })
    expect(sortByAppearance([c, b, a]).map((i) => i.id)).toEqual([30, 20, 10])
  })

  it('breaks a startWord tie by endWord', () => {
    const shorter = snippet({ id: 1, startWord: 50, endWord: 55 })
    const longer = snippet({ id: 2, startWord: 50, endWord: 90 })
    expect(sortByAppearance([longer, shorter]).map((i) => i.id)).toEqual([1, 2])
  })

  it('breaks a startWord+endWord tie by id', () => {
    const later = snippet({ id: 9, startWord: 50, endWord: 55 })
    const earlier = snippet({ id: 3, startWord: 50, endWord: 55 })
    expect(sortByAppearance([later, earlier]).map((i) => i.id)).toEqual([3, 9])
  })

  it('does not mutate its input array', () => {
    const original = [
      snippet({ id: 3, startWord: 300, endWord: 310 }),
      snippet({ id: 2, startWord: 150, endWord: 160 }),
      snippet({ id: 1, startWord: 10, endWord: 20 }),
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
    const only = snippet({ id: 7, startWord: 5, endWord: 6 })
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

function makeDetail(snippets: Snippet[]): SessionDetail {
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
    snippets,
    hasTranscript: true,
  }
}

describe('ReviewView (render)', () => {
  it('renders snippet cards in conversation order, not the id order the API returned them in', async () => {
    // id order is the REVERSE of startWord (appearance) order — exactly the
    // "just-created snippet quoting the first sentence lands at the bottom"
    // scenario the sort exists to fix.
    const detail = makeDetail([
      snippet({ id: 10, title: 'Third topic', startWord: 300, endWord: 310 }),
      snippet({ id: 20, title: 'Second topic', startWord: 150, endWord: 160 }),
      snippet({ id: 30, title: 'First topic', startWord: 10, endWord: 20 }),
    ])

    render(<ReviewView detail={detail} refresh={vi.fn()} onError={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('First topic')).toBeTruthy()
    })

    const titles = screen.getAllByText(/topic$/).map((el) => el.textContent)
    expect(titles).toEqual(['First topic', 'Second topic', 'Third topic'])
  })
})
