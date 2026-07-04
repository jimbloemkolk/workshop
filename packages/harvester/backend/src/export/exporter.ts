import fs from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { clipBounds, type Range } from '../anchor.js'
import { sessionDir, type Config } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { loadTranscript, type Word } from '../transcript.js'
import { runFfmpeg, slugify } from '../util.js'
import { mergeWithPreserved, renderInsightNote, renderSessionNote, type NoteQuote } from './notes.js'

export interface ExportReport {
  folder: string
  exported: number
  clips: number
  warnings: string[]
}

/** Project accepted insights into the Obsidian vault: one folder per
 * session, one note per insight, clips alongside. Re-runnable — the vault is
 * a projection, and human regions below the marker survive. */
export async function exportSession(config: Config, db: Db, sessionId: string): Promise<ExportReport> {
  if (!config.vaultDir) {
    throw new Error('HARVESTER_VAULT_DIR is not configured (point it at a folder inside your vault)')
  }
  const session = db.select().from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId)).get()
  if (!session) throw new Error(`unknown session: ${sessionId}`)

  const participantRows = db.select().from(schema.participants)
    .where(eq(schema.participants.sessionId, sessionId)).all()
  const speakerRows = db.select().from(schema.speakers)
    .where(eq(schema.speakers.sessionId, sessionId)).all()
  const markerRows = db.select().from(schema.markers)
    .where(and(eq(schema.markers.sessionId, sessionId), eq(schema.markers.flag, 'ok'))).all()
  const accepted = db.select().from(schema.insights)
    .where(and(eq(schema.insights.sessionId, sessionId), eq(schema.insights.status, 'accepted'))).all()

  const names = new Map(participantRows.map((p) => [p.id, p.name]))
  const speakerName = new Map(speakerRows.map((s) => [
    s.label,
    (s.participantId != null ? names.get(s.participantId) : null) ?? s.label,
  ]))
  const participantNames = participantRows.map((p) => p.name)

  const transcript = loadTranscript(path.join(sessionDir(config, sessionId), 'transcript.json'))
  const recording = path.join(sessionDir(config, sessionId), 'recording.flac')

  const date = session.id.slice(0, 10)
  const folderName = `${date} ${participantNames.join(' × ') || session.title}`
  const folder = path.join(config.vaultDir, folderName)
  fs.mkdirSync(path.join(folder, 'clips'), { recursive: true })

  const warnings: string[] = []
  const usedNames = new Set<string>()
  const insightLinks: string[] = []
  let clips = 0

  for (const insight of accepted) {
    const range: Range = { start: insight.startWord, end: insight.endWord }
    const bounds = insight.anchored ? clipBounds(transcript.words, range) : null
    const baseName = noteBaseName(insight.exportedPath, insight.title, usedNames)
    usedNames.add(baseName.toLowerCase())

    let clipFile: string | null = null
    if (bounds) {
      const padS = config.clipPaddingMs / 1000
      const start = Math.max(0, bounds.start - padS)
      const end = Math.min(session.durationS ?? Infinity, bounds.end + padS)
      clipFile = `clips/${baseName}.m4a`
      await runFfmpeg([
        '-y', '-ss', start.toFixed(3), '-to', end.toFixed(3),
        '-i', recording, '-c:a', 'aac', '-b:a', '160k',
        path.join(folder, clipFile),
      ])
      clips += 1
    } else if (insight.anchored) {
      warnings.push(`no aligned timestamps for "${insight.title}" — note exported without clip`)
    } else {
      warnings.push(`"${insight.title}" is unanchored — note exported without clip`)
    }

    const supports = db.select().from(schema.supportingQuotes)
      .where(eq(schema.supportingQuotes.insightId, insight.id)).all()

    const rendered = renderInsightNote({
      sessionId: session.id,
      sessionNote: folderName + '/session',
      date,
      origin: insight.origin,
      title: insight.title,
      main: noteQuote(transcript.words, range, insight.quote, insight.anchored, speakerName),
      insight: insight.insight,
      clipFile,
      supporting: supports.map((s) => ({
        ...noteQuote(transcript.words, { start: s.startWord, end: s.endWord }, s.quote, s.anchored, speakerName),
        why: s.why ?? '',
      })),
    })

    const notePath = path.join(folder, `${baseName}.md`)
    const merged = mergeWithPreserved(readIfExists(notePath), rendered)
    if (merged == null) {
      warnings.push(`${baseName}.md has no harvester marker (taken over by hand?) — left untouched`)
    } else {
      fs.writeFileSync(notePath, merged)
    }
    insightLinks.push(`${folderName}/${baseName}`)
    db.update(schema.insights)
      .set({ exportedPath: `${folderName}/${baseName}.md` })
      .where(eq(schema.insights.id, insight.id)).run()
  }

  const sessionNotePath = path.join(folder, 'session.md')
  const renderedSession = renderSessionNote({
    sessionId: session.id,
    date,
    participants: participantNames,
    durationS: session.durationS,
    insightLinks,
    markerCount: markerRows.length,
  })
  const mergedSession = mergeWithPreserved(readIfExists(sessionNotePath), renderedSession)
  if (mergedSession == null) {
    warnings.push('session.md has no harvester marker — left untouched')
  } else {
    fs.writeFileSync(sessionNotePath, mergedSession)
  }

  db.update(schema.sessions)
    .set({ status: 'exported', exportedAt: Date.now() })
    .where(eq(schema.sessions.id, sessionId)).run()

  return { folder, exported: accepted.length, clips, warnings }
}

function noteQuote(
  words: Word[],
  range: Range,
  quote: string,
  anchored: boolean,
  speakerName: Map<string, string>,
): NoteQuote {
  const inRange = words.slice(range.start, range.end)
  const counts = new Map<string, number>()
  for (const w of inRange) {
    if (w.speaker) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1)
  }
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const bounds = anchored ? clipBounds(words, range) : null
  return {
    quote,
    speaker: majority ? speakerName.get(majority) ?? majority : '?',
    startS: bounds?.start ?? null,
    endS: bounds?.end ?? null,
    anchored,
  }
}

/** Stable filenames across re-exports: reuse the previously exported name,
 * otherwise slug the title and dedupe within this export run. */
function noteBaseName(exportedPath: string | null, title: string, used: Set<string>): string {
  if (exportedPath) {
    const prev = path.basename(exportedPath, '.md')
    if (!used.has(prev.toLowerCase())) return prev
  }
  const base = slugify(title)
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`
  return name
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}
