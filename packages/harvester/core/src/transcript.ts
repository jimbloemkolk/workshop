import fs from 'node:fs'

/** The transcriber's output contract (see packages/transcriber/README.md).
 * `words` is the canonical flat, gap-free, globally indexed array — the seam
 * everything in the harvester slices against. */
export interface Word {
  index: number
  text: string
  start: number | null
  end: number | null
  aligned: boolean
  speaker: string | null
  segment_id: number
  score: number | null
}

export interface Segment {
  id: number
  text: string
  start: number | null
  end: number | null
  speaker: string | null
}

export interface Transcript {
  meta: { duration_s: number; language: string; warnings: string[] }
  segments: Segment[]
  words: Word[]
}

export function loadTranscript(file: string): Transcript {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Transcript
}

/** Same normalization the transcriber's compare module uses: lowercase,
 * strip everything but word characters and %. */
export function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}_%]/gu, '')
}

/** Render the transcript for the LLM: one line per ~sentence segment,
 * prefixed with the global index of its first word plus speaker + time.
 * Word-precise addressing stays possible while staying token-frugal.
 * Gap spans render as explicit `--- connection gap ---` lines; with zero
 * gaps the output is byte-identical to the gap-less rendering. */
export function renderIndexedTranscript(
  t: Transcript,
  speakerNames: Map<string, string>,
  gaps: GapLine[] = [],
): string {
  const pending = [...gaps].sort((a, b) => a.startS - b.startS)
  const gapLine = (g: GapLine) => {
    const who = speakerNames.get(g.participant) ?? g.participant
    return `--- connection gap (${who}, ${Math.round(g.endS - g.startS)}s) ---`
  }
  const lines: string[] = []
  let cursor = 0
  for (const seg of t.segments) {
    while (pending.length > 0 && seg.start != null && pending[0]!.startS < seg.start) {
      lines.push(gapLine(pending.shift()!))
    }
    const segWords = t.words.filter((w) => w.segment_id === seg.id)
    const first = segWords[0]
    const idx = first ? first.index : cursor
    cursor = idx + segWords.length
    const speaker = seg.speaker ? speakerNames.get(seg.speaker) ?? seg.speaker : '?'
    const time = seg.start != null ? formatTime(seg.start) : '--:--'
    lines.push(`[word ${idx}] ${time} ${speaker}: ${seg.text.trim()}`)
  }
  for (const g of pending) lines.push(gapLine(g))
  return lines.join('\n')
}

/** A connection-gap span for rendering: mutual exchange was broken here. */
export interface GapLine {
  participant: string
  startS: number
  endS: number
}

export function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

/** Longest clearly-attributed segment per speaker — the labeling sample. */
export function sampleUtterances(t: Transcript): Map<string, Segment> {
  const best = new Map<string, Segment>()
  for (const seg of t.segments) {
    if (!seg.speaker || seg.start == null || seg.end == null) continue
    const cur = best.get(seg.speaker)
    const len = seg.end - seg.start
    if (!cur || len > (cur.end! - cur.start!)) best.set(seg.speaker, seg)
  }
  return best
}

/** Word range covering a marker span (seconds on the audio timeline), with a
 * little slack: the words whose aligned midpoint falls inside [start-pre, end+post]. */
export function wordsInSpan(t: Transcript, startS: number, endS: number, slackS = 2): { start: number; end: number } | null {
  let first = -1
  let last = -1
  for (const w of t.words) {
    if (w.start == null || w.end == null) continue
    const mid = (w.start + w.end) / 2
    if (mid >= startS - slackS && mid <= endS + slackS) {
      if (first < 0) first = w.index
      last = w.index
    }
  }
  return first < 0 ? null : { start: first, end: last + 1 }
}
