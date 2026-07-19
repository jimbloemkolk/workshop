import type { Range } from '../anchor.js'

export interface RawMark {
  id: number
  startS: number
  endS: number
  participant: string | null
}

export interface SpanRegion {
  startS: number
  endS: number
  /** distinct participants whose marks merged in (>1 = strength signal) */
  participantCount: number
  memberIds: number[]
}

/** the pause below which adjacent marks are one region */
const JOIN_GAP_S = 2

/** Merging is a derivation, stored distinctly: ok-flagged spans from all
 * participants union into merged regions (overlapping or within a 2 s join
 * gap). Raw marks are never touched; re-deriving is always safe. Local
 * sessions derive trivially (participant null) — one code path. */
export function mergeMarkRegions(marks: RawMark[], joinGapS = JOIN_GAP_S): SpanRegion[] {
  const sorted = [...marks].sort((a, b) => a.startS - b.startS)
  const regions: SpanRegion[] = []
  let current: { startS: number; endS: number; members: RawMark[] } | null = null

  const flush = () => {
    if (!current) return
    regions.push({
      startS: current.startS,
      endS: current.endS,
      participantCount: new Set(current.members.map((m) => m.participant ?? '')).size,
      memberIds: current.members.map((m) => m.id),
    })
    current = null
  }

  for (const mark of sorted) {
    if (current && mark.startS <= current.endS + joinGapS) {
      current.endS = Math.max(current.endS, mark.endS)
      current.members.push(mark)
    } else {
      flush()
      current = { startS: mark.startS, endS: mark.endS, members: [mark] }
    }
  }
  flush()
  return regions
}

export type { Range }
