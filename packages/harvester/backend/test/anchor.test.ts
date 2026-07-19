import { describe, expect, it } from 'vitest'
import type { Word } from '@workshop/harvester-core'
import { anchorQuote, clipBounds, findTokenSequence } from '../src/anchor.js'

function words(texts: string[], opts: { unalignedAt?: number[] } = {}): Word[] {
  return texts.map((text, index) => {
    const unaligned = opts.unalignedAt?.includes(index) ?? false
    return {
      index,
      text,
      start: unaligned ? null : index,
      end: unaligned ? null : index + 0.9,
      aligned: !unaligned,
      speaker: 'SPEAKER_00',
      segment_id: 0,
      score: unaligned ? null : 0.9,
    }
  })
}

const W = words(['De', 'business', 'case', 'bleef', 'gewoon', 'overeind', 'staan,', 'zei', 'hij.'])

describe('anchorQuote', () => {
  it('accepts a verbatim match at the claimed indices', () => {
    const r = anchorQuote(W, { start: 1, end: 6 }, 'business case bleef gewoon overeind')
    expect(r.ok).toBe(true)
    expect(r.range).toEqual({ start: 1, end: 6 })
    expect(r.quote).toBe('business case bleef gewoon overeind')
  })

  it('ignores case and punctuation differences', () => {
    const r = anchorQuote(W, { start: 5, end: 7 }, 'Overeind staan')
    expect(r.ok).toBe(true)
    expect(r.quote).toBe('overeind staan,')
  })

  it('re-anchors when indices are off but the text exists', () => {
    const r = anchorQuote(W, { start: 3, end: 8 }, 'business case bleef gewoon overeind')
    expect(r.ok).toBe(true)
    expect(r.range).toEqual({ start: 1, end: 6 })
    expect(r.reason).toContain('re-anchored')
  })

  it('re-anchors to the occurrence nearest the claimed start', () => {
    const repeated = words(['ja', 'precies', 'nee', 'ja', 'precies'])
    const r = anchorQuote(repeated, { start: 4, end: 6 }, 'ja precies')
    expect(r.ok).toBe(true)
    expect(r.range).toEqual({ start: 3, end: 5 })
  })

  it('fails (never fabricates) when the quote is not in the transcript', () => {
    const r = anchorQuote(W, { start: 0, end: 3 }, 'volledig verzonnen tekst')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('not found')
  })

  it('fails on an empty quote', () => {
    expect(anchorQuote(W, { start: 0, end: 1 }, '  ').ok).toBe(false)
  })

  it('clamps out-of-range claimed indices before checking', () => {
    const r = anchorQuote(W, { start: -5, end: 99 }, 'De business')
    expect(r.ok).toBe(true)
    expect(r.range).toEqual({ start: 0, end: 2 })
  })
})

describe('findTokenSequence', () => {
  it('treats punctuation-only words as transparent', () => {
    const w = words(['dus', '—', 'ja', 'precies'])
    expect(findTokenSequence(w, ['dus', 'ja'])).toEqual([{ start: 0, end: 3 }])
  })
})

describe('clipBounds', () => {
  it('uses aligned boundary words directly', () => {
    expect(clipBounds(W, { start: 1, end: 6 })).toEqual({ start: 1, end: 5.9 })
  })

  it('snaps outward past unaligned boundary words', () => {
    const w = words(['een', 'twee', 'drie', 'vier', 'vijf'], { unalignedAt: [1, 3] })
    // start word 1 is unaligned -> walk left to 0; end word 3 unaligned -> walk right to 4
    expect(clipBounds(w, { start: 1, end: 4 })).toEqual({ start: 0, end: 4.9 })
  })

  it('returns null when nothing aligned exists', () => {
    const w = words(['42', '1984'], { unalignedAt: [0, 1] })
    expect(clipBounds(w, { start: 0, end: 2 })).toBeNull()
  })
})
