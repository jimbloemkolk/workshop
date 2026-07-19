import type { Segment, Transcript, Word } from '@workshop/harvester-core'

/** One transcribed track segment, positioned on the call timeline. */
export interface TrackTranscript {
  participant: string
  /** timeline offset of this segment's audio (track_segments.startS) */
  offsetS: number
  transcript: Transcript
}

/** how long a same-speaker pause may be before we cut a new segment */
const SEGMENT_SPLIT_S = 2

/** The merge step (pure): offset each word by its segment's timeline
 * offset, set `speaker` to the participant identity, interleave all
 * tracks' words by start time, reindex gap-free, rebuild segments — a
 * standard `transcript.json`, so anchoring, harvesting, review, playback
 * and export run unchanged downstream. */
export function mergeTrackTranscripts(tracks: TrackTranscript[], durationS: number): Transcript {
  interface Positioned {
    word: Word
    participant: string
    /** absolute time used for interleaving; unaligned words inherit their
     * predecessor's so they never drift from their neighbors */
    orderS: number
    startS: number | null
    endS: number | null
  }

  const positioned: Positioned[] = []
  for (const track of tracks) {
    let carry = track.offsetS
    for (const word of track.transcript.words) {
      const startS = word.start != null ? word.start + track.offsetS : null
      const endS = word.end != null ? word.end + track.offsetS : null
      if (startS != null) carry = startS
      positioned.push({ word, participant: track.participant, orderS: carry, startS, endS })
      if (endS != null) carry = endS
    }
  }
  // stable sort: ties keep within-track order
  const merged = positioned
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.orderS - b.p.orderS || a.i - b.i)
    .map((x) => x.p)

  const words: Word[] = []
  const segments: Segment[] = []
  let current: { segment: Segment; lastEndS: number } | null = null
  for (const m of merged) {
    const needsNew = current == null
      || current.segment.speaker !== m.participant
      || (m.startS != null && m.startS - current.lastEndS > SEGMENT_SPLIT_S)
    if (needsNew) {
      current = {
        segment: {
          id: segments.length,
          text: '',
          start: m.startS,
          end: m.endS,
          speaker: m.participant,
        },
        lastEndS: m.endS ?? m.orderS,
      }
      segments.push(current.segment)
    }
    const seg = current!.segment
    seg.text += (seg.text ? ' ' : '') + m.word.text
    seg.start ??= m.startS
    if (m.endS != null) {
      seg.end = m.endS
      current!.lastEndS = m.endS
    }
    words.push({
      index: words.length,
      text: m.word.text,
      start: m.startS,
      end: m.endS,
      aligned: m.word.aligned && m.startS != null,
      speaker: m.participant,
      segment_id: seg.id,
      score: m.word.score,
    })
  }

  return {
    meta: {
      duration_s: durationS,
      language: tracks[0]?.transcript.meta.language ?? 'nl',
      warnings: tracks.flatMap((t) =>
        t.transcript.meta.warnings.map((w) => `[${t.participant}] ${w}`)),
    },
    segments,
    words,
  }
}
