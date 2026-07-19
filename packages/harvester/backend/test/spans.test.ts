import { describe, expect, it } from 'vitest'
import { mergeMarkRegions } from '../src/harvest/spans.js'

describe('mergeMarkRegions', () => {
  it('merges overlapping marks from different participants into one region', () => {
    const regions = mergeMarkRegions([
      { id: 1, startS: 10, endS: 20, participant: 'jim' },
      { id: 2, startS: 15, endS: 25, participant: 'jesse' },
    ])
    expect(regions).toEqual([
      { startS: 10, endS: 25, participantCount: 2, memberIds: [1, 2] },
    ])
  })

  it('joins marks within the 2s gap, keeps distant ones separate', () => {
    const regions = mergeMarkRegions([
      { id: 1, startS: 10, endS: 20, participant: null },
      { id: 2, startS: 21.5, endS: 30, participant: null },
      { id: 3, startS: 40, endS: 45, participant: null },
    ])
    expect(regions.map((r) => [r.startS, r.endS, r.memberIds])).toEqual([
      [10, 30, [1, 2]],
      [40, 45, [3]],
    ])
  })

  it('counts one participant once (double mark ≠ both-marked)', () => {
    const regions = mergeMarkRegions([
      { id: 1, startS: 10, endS: 20, participant: 'jim' },
      { id: 2, startS: 19, endS: 24, participant: 'jim' },
    ])
    expect(regions[0]!.participantCount).toBe(1)
  })

  it('local marks (participant null) derive trivially — one span per mark', () => {
    const regions = mergeMarkRegions([
      { id: 1, startS: 5, endS: 8, participant: null },
      { id: 2, startS: 30, endS: 32, participant: null },
    ])
    expect(regions).toHaveLength(2)
    expect(regions.every((r) => r.participantCount === 1)).toBe(true)
  })

  it('a mark contained in another does not extend the region', () => {
    const regions = mergeMarkRegions([
      { id: 1, startS: 10, endS: 30, participant: 'jim' },
      { id: 2, startS: 12, endS: 15, participant: 'jesse' },
    ])
    expect(regions).toEqual([
      { startS: 10, endS: 30, participantCount: 2, memberIds: [1, 2] },
    ])
  })
})
