import { formatTime } from '../transcript.js'

/** Everything above this marker is regenerated on re-export; everything
 * below it belongs to the human and is never touched. */
export const OWNED_MARKER =
  '%% harvester — regenerated above this line on re-export; your notes below are safe %%'

export interface NoteQuote {
  quote: string
  speaker: string
  startS: number | null
  endS: number | null
  anchored: boolean
}

export interface InsightNoteInput {
  sessionId: string
  sessionNote: string // wikilink target of the session note
  date: string
  origin: string
  /** rendered as the H1; the filename carries its slug */
  title: string
  main: NoteQuote
  insight: string
  clipFile: string | null // vault-folder-relative path of the clip
  supporting: (NoteQuote & { why: string })[]
}

function yamlEscape(v: string): string {
  return /[:#\[\]{}"'\n-]|^\s|\s$/.test(v) ? JSON.stringify(v) : v
}

function quoteBlock(q: NoteQuote): string {
  const time = q.startS != null ? ` (${formatTime(q.startS)})` : ''
  const warn = q.anchored ? '' : '\n> [!warning] unanchored — timestamps unverified'
  const lines = q.quote.split('\n').map((l) => `> ${l}`).join('\n')
  return `${lines}\n> — ${q.speaker}${time}${warn}`
}

export function renderInsightNote(input: InsightNoteInput): string {
  const fm = [
    '---',
    `session: ${yamlEscape(input.sessionId)}`,
    `date: ${input.date}`,
    `speaker: ${yamlEscape(input.main.speaker)}`,
    `origin: ${input.origin}`,
    input.main.startS != null ? `start: "${formatTime(input.main.startS)}"` : null,
    input.main.endS != null ? `end: "${formatTime(input.main.endS)}"` : null,
    'tags:',
    '  - harvester/insight',
    '---',
  ].filter((l): l is string => l !== null)

  const body: string[] = [
    ...fm,
    '',
    `# ${input.title}`,
    '',
    quoteBlock(input.main),
    '',
  ]
  if (input.clipFile) body.push(`![[${input.clipFile}]]`, '')
  if (input.insight) body.push(`**Insight:** ${input.insight}`, '')
  if (input.supporting.length > 0) {
    body.push('## Supporting')
    for (const s of input.supporting) {
      body.push('', quoteBlock(s))
      if (s.why) body.push('', `*${s.why}*`)
    }
    body.push('')
  }
  body.push(`Session: [[${input.sessionNote}]]`, '', OWNED_MARKER, '')
  return body.join('\n')
}

export interface SessionNoteInput {
  sessionId: string
  date: string
  participants: string[]
  durationS: number | null
  insightLinks: string[]
  markerCount: number
}

export function renderSessionNote(input: SessionNoteInput): string {
  const lines = [
    '---',
    `session: ${yamlEscape(input.sessionId)}`,
    `date: ${input.date}`,
    'participants:',
    ...input.participants.map((p) => `  - ${yamlEscape(p)}`),
    input.durationS != null ? `duration: "${formatTime(input.durationS)}"` : null,
    'tags:',
    '  - harvester/session',
    '---',
    '',
    `${input.participants.join(' × ')} — ${input.markerCount} markers, ` +
      `${input.insightLinks.length} insights.`,
    '',
    '## Insights',
    '',
    ...input.insightLinks.map((l) => `- [[${l}]]`),
    '',
    OWNED_MARKER,
    '',
  ].filter((l): l is string => l !== null)
  return lines.join('\n')
}

/** Merge freshly rendered owned content with an existing note, preserving
 * everything the human wrote below the marker. Returns null when the
 * existing file has no marker (human took the note over) — caller warns and
 * leaves the file alone. */
export function mergeWithPreserved(existing: string | null, rendered: string): string | null {
  if (existing == null) return rendered
  const idx = existing.indexOf(OWNED_MARKER)
  if (idx < 0) return null
  const preserved = existing.slice(idx + OWNED_MARKER.length)
  const renderedIdx = rendered.indexOf(OWNED_MARKER)
  const owned = rendered.slice(0, renderedIdx + OWNED_MARKER.length)
  return owned + preserved
}
