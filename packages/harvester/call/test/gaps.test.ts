import { describe, expect, it } from 'vitest'
import type { CallEvent } from '../src/events.js'
import { deriveGapSpans } from '../src/gaps.js'

const T0 = 1_000_000
const at = (s: number) => T0 + s * 1000
const ev = (s: number, type: string, participant: string, extra: Partial<CallEvent> = {}): CallEvent =>
  ({ atMs: at(s), type, participant, ...extra })

describe('deriveGapSpans', () => {
  it('turns unpublish → republish into an uplink gap', () => {
    const spans = deriveGapSpans([
      ev(0, 'track_published', 'jim'),
      ev(10, 'track_unpublished', 'jim'),
      ev(18, 'track_published', 'jim'),
    ], T0, at(60))
    expect(spans).toEqual([{
      participant: 'jim', startS: 10, endS: 18, direction: 'uplink', cause: 'track unpublished',
    }])
  })

  it('a full disconnect (leave fires unpublish too) yields one `both` span', () => {
    const spans = deriveGapSpans([
      ev(0, 'track_published', 'jim'),
      ev(10, 'track_unpublished', 'jim'),
      ev(10.1, 'participant_left', 'jim'),
      ev(20, 'participant_joined', 'jim'),
      ev(20.2, 'track_published', 'jim'),
    ], T0, at(60))
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ participant: 'jim', direction: 'both', cause: 'disconnected' })
    expect(spans[0]!.startS).toBeCloseTo(10.1, 5)
    expect(spans[0]!.endS).toBeCloseTo(20, 5)
  })

  it('client-reported reconnecting refines with a downlink span', () => {
    const spans = deriveGapSpans([
      ev(5, 'client:reconnecting', 'jesse'),
      ev(12, 'client:reconnected', 'jesse'),
    ], T0, at(60))
    expect(spans).toEqual([{
      participant: 'jesse', startS: 5, endS: 12, direction: 'downlink', cause: 'client reconnecting',
    }])
  })

  it('a gap still open at call end runs to the end', () => {
    const spans = deriveGapSpans([
      ev(0, 'track_published', 'jim'),
      ev(40, 'track_unpublished', 'jim'),
    ], T0, at(60))
    expect(spans).toEqual([{
      participant: 'jim', startS: 40, endS: 60, direction: 'uplink', cause: 'track unpublished',
    }])
  })

  it('drops sub-fidelity blips and the end-of-call leave wave', () => {
    const spans = deriveGapSpans([
      ev(10, 'track_unpublished', 'jim'),
      ev(10.8, 'track_published', 'jim'), // 0.8s blip: below webhook fidelity
      ev(59.9, 'track_unpublished', 'jim'), // everyone leaves as the call ends
      ev(59.95, 'participant_left', 'jim'),
    ], T0, at(60))
    expect(spans).toEqual([])
  })

  it('ignores the egress worker and keeps participants independent', () => {
    const spans = deriveGapSpans([
      ev(5, 'participant_left', 'EG_abc123'),
      ev(10, 'track_unpublished', 'jim'),
      ev(20, 'track_published', 'jim'),
      ev(15, 'track_unpublished', 'jesse'),
      ev(30, 'track_published', 'jesse'),
    ], T0, at(60))
    expect(spans.map((s) => [s.participant, s.startS, s.endS])).toEqual([
      ['jim', 10, 20],
      ['jesse', 15, 30],
    ])
  })

  it('with zero events derives zero gaps (degradation contract)', () => {
    expect(deriveGapSpans([], T0, at(60))).toEqual([])
  })
})
