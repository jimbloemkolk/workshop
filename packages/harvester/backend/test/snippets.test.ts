import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { eq } from 'drizzle-orm'
import { openDb, schema, sessionDir, type Db, type Transcript } from '@workshop/harvester-core'
import { HarvesterService } from '../src/service.js'
import type { Config } from '../src/config.js'

/** The ocean's logic is DB- and disk-coupled (a transcript on disk supplies the
 * spoken time), so this is a small integration test around a real sqlite file
 * and a temp data dir. Model: the harvester proposes insights over snippets
 * (evidence); reviewing accepts/rejects an insight in place, which cascades to
 * its snippets; accepted insights populate the ocean. */
describe('insights (the ocean)', () => {
  let dir: string
  let db: Db
  let service: HarvesterService

  const SESSION = 'sess-1'
  const SESSION_CREATED = 1_700_000_000_000

  const config = (dataDir: string): Config => ({
    dataDir,
    vaultDir: null,
    transcriberDir: dataDir,
    transcriber: { backend: 'test', model: 'test', language: 'nl' },
    port: 0,
    model: 'fixture',
    markerMinMs: 300,
    clipPaddingMs: 200,
  })

  const transcript = (): Transcript => ({
    meta: { duration_s: 30, language: 'nl', warnings: [] },
    segments: [],
    words: [
      { index: 0, text: 'the', start: 0, end: 1, aligned: true, speaker: 'A', segment_id: 0, score: 1 },
      { index: 1, text: 'ocean', start: 10, end: 11, aligned: true, speaker: 'A', segment_id: 0, score: 1 },
      { index: 2, text: 'remembers', start: 11, end: 12, aligned: true, speaker: 'A', segment_id: 0, score: 1 },
    ],
  })

  const ensureSession = (id: string, createdAt: number) => {
    if (db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()) return
    db.insert(schema.sessions).values({
      id, title: id === SESSION ? 'A chat with Jesse' : 'Later chat',
      status: 'reviewing', origin: 'call', language: 'nl', createdAt,
    }).run()
    const sdir = sessionDir(config(dir), id)
    fs.mkdirSync(sdir, { recursive: true })
    fs.writeFileSync(path.join(sdir, 'transcript.json'), JSON.stringify(transcript()))
  }

  /** Seed a proposed insight over a main snippet (+ optional supporting), with a
   * session and transcript on disk. Returns the insight id. */
  const seedInsight = (opts: {
    sessionId?: string
    createdAt?: number
    main?: Partial<typeof schema.snippets.$inferInsert>
    insight?: Partial<typeof schema.insights.$inferInsert>
    supporting?: { startWord: number; endWord: number; quote: string; why?: string }[]
  } = {}): number => {
    const sessionId = opts.sessionId ?? SESSION
    const createdAt = opts.createdAt ?? SESSION_CREATED
    ensureSession(sessionId, createdAt)
    const startWord = opts.main?.startWord ?? 1
    const spokenAt = createdAt + Math.round((transcript().words[startWord]?.start ?? 0) * 1000)
    const main = db.insert(schema.snippets).values({
      sessionId, startWord, endWord: 3, quote: 'ocean remembers', anchored: true,
      spokenAt, status: 'proposed', ...opts.main,
    }).returning().get()
    const ins = db.insert(schema.insights).values({
      sessionId, harvestId: null, origin: 'marker', harvestSpanId: null, mainSnippetId: main.id,
      title: 'Snippets are their own thing', description: 'An insight is refined from a snippet.',
      status: 'proposed', createdAt, ...opts.insight,
    }).returning().get()
    for (const s of opts.supporting ?? []) {
      const sn = db.insert(schema.snippets).values({
        sessionId, startWord: s.startWord, endWord: s.endWord, quote: s.quote,
        anchored: true, spokenAt: null, status: 'proposed',
      }).returning().get()
      db.insert(schema.insightSnippets).values({ insightId: ins.id, snippetId: sn.id, why: s.why ?? null }).run()
    }
    return ins.id
  }

  const snippetStatus = (id: number) =>
    db.select().from(schema.snippets).where(eq(schema.snippets.id, id)).get()?.status

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-'))
    db = openDb(dir)
    service = new HarvesterService(config(dir), db)
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('is absent until accepted, then in the ocean at its main snippet spoken moment', () => {
    const id = seedInsight()
    expect(service.listInsights()).toHaveLength(0) // proposed, not yet in the ocean

    service.updateInsight(id, { status: 'accepted' })

    const [insight] = service.listInsights()
    expect(insight).toMatchObject({
      title: 'Snippets are their own thing',
      description: 'An insight is refined from a snippet.',
      sessionId: SESSION,
      sessionTitle: 'A chat with Jesse',
      quote: 'ocean remembers',
    })
    expect(insight!.spokenAt).toBe(SESSION_CREATED + 10_000) // word[1].start = 10s
  })

  it('accepting cascades to the insight’s snippets (main + supporting)', () => {
    const id = seedInsight({ supporting: [{ startWord: 1, endWord: 2, quote: 'ocean', why: 'context' }] })
    const before = db.select().from(schema.snippets).all()
    expect(before.every((s) => s.status === 'proposed')).toBe(true)

    service.updateInsight(id, { status: 'accepted' })

    const after = db.select().from(schema.snippets).all()
    expect(after).toHaveLength(2)
    expect(after.every((s) => s.status === 'accepted')).toBe(true) // main and supporting both flipped
  })

  it('edits title/description in place — no copy', () => {
    const id = seedInsight()
    service.updateInsight(id, { status: 'accepted', title: 'Reworded', description: 'Sharpened.' })
    expect(service.listInsights()[0]).toMatchObject({ title: 'Reworded', description: 'Sharpened.' })
  })

  it('leaves the ocean when rejected, returns when re-accepted', () => {
    const id = seedInsight()
    service.updateInsight(id, { status: 'accepted' })
    expect(service.listInsights()).toHaveLength(1)
    service.updateInsight(id, { status: 'rejected' })
    expect(service.listInsights()).toHaveLength(0)
    expect(snippetStatus(db.select().from(schema.insights).where(eq(schema.insights.id, id)).get()!.mainSnippetId))
      .toBe('rejected') // verdict cascaded
    service.updateInsight(id, { status: 'accepted' })
    expect(service.listInsights()).toHaveLength(1)
  })

  it('re-anchoring the main snippet moves the spoken moment', () => {
    const id = seedInsight() // startWord 1 → 10s
    service.updateInsight(id, { status: 'accepted' })
    expect(service.listInsights()[0]!.spokenAt).toBe(SESSION_CREATED + 10_000)

    service.updateInsight(id, { startWord: 0, endWord: 1 }) // word[0].start = 0s
    expect(service.listInsights()[0]!.spokenAt).toBe(SESSION_CREATED)
  })

  it('orders newest-spoken first', () => {
    const first = seedInsight()
    const second = seedInsight({
      sessionId: 'sess-2', createdAt: SESSION_CREATED + 1_000_000, insight: { title: 'Later idea' },
    })
    service.updateInsight(first, { status: 'accepted' })
    service.updateInsight(second, { status: 'accepted' })
    expect(service.listInsights().map((i) => i.title)).toEqual(['Later idea', 'Snippets are their own thing'])
  })

  it('fuzzy-searches title, description and the (main + supporting) quotes', () => {
    service.updateInsight(
      seedInsight({ supporting: [{ startWord: 1, endWord: 2, quote: 'benchmark evidence' }] }),
      { status: 'accepted' })
    expect(service.listInsights('remembr').map((i) => i.title)).toEqual(['Snippets are their own thing']) // main quote typo
    expect(service.listInsights('refnied').map((i) => i.title)).toEqual(['Snippets are their own thing'])  // description typo
    expect(service.listInsights('benchmrk').map((i) => i.title)).toEqual(['Snippets are their own thing'])  // supporting quote typo
    expect(service.listInsights('zzz nothing')).toHaveLength(0)
  })

  it('backfills spoken_at for snippets that predate the column', () => {
    const id = seedInsight({ main: { spokenAt: null } })
    const mainId = db.select().from(schema.insights).where(eq(schema.insights.id, id)).get()!.mainSnippetId
    expect(snippetStatus(mainId) && db.select().from(schema.snippets).where(eq(schema.snippets.id, mainId)).get()!.spokenAt).toBeNull()

    service.backfillSpokenAt()

    expect(db.select().from(schema.snippets).where(eq(schema.snippets.id, mainId)).get()!.spokenAt)
      .toBe(SESSION_CREATED + 10_000)
  })

  it('exports the filtered ocean as a zip, titled by the insight, evidence from the snippet', async () => {
    service.updateInsight(seedInsight({ main: { anchored: false } }), { status: 'accepted' }) // unanchored → no ffmpeg

    const { archive, filename, exported, clips } = await service.exportOcean()
    expect(exported).toBe(1)
    expect(clips).toBe(0)
    expect(filename).toMatch(/^ocean-\d{4}-\d{2}-\d{2}\.zip$/)

    const zip = await JSZip.loadAsync(archive)
    const notes = Object.keys(zip.files).filter((f) => f.endsWith('.md'))
    expect(notes).toEqual(['Ocean/snippets-are-their-own-thing.md'])
    const note = await zip.file(notes[0]!)!.async('string')
    expect(note).toContain('# Snippets are their own thing')        // insight title → H1
    expect(note).toContain('An insight is refined from a snippet')  // insight description
    expect(note).toContain('ocean remembers')                       // evidence via main snippet
  })

  it('respects the search filter on export', async () => {
    service.updateInsight(seedInsight({ main: { anchored: false } }), { status: 'accepted' })
    expect((await service.exportOcean('zzz-nothing')).exported).toBe(0)
    expect((await service.exportOcean('snippets')).exported).toBe(1)
  })

  it('marks a session curated once no insight is left proposed', () => {
    const a = seedInsight()
    const b = seedInsight({ insight: { title: 'Second' } })
    expect(service.listSessions()[0]!.curated).toBe(false) // two proposed
    service.updateInsight(a, { status: 'accepted' })
    expect(service.listSessions()[0]!.curated).toBe(false) // b still proposed
    service.updateInsight(b, { status: 'rejected' })
    expect(service.listSessions()[0]!.curated).toBe(true)  // every verdict in
  })

  it('a full session delete takes its insights and snippets', () => {
    service.updateInsight(seedInsight({ supporting: [{ startWord: 1, endWord: 2, quote: 'ocean' }] }), { status: 'accepted' })
    expect(service.listInsights()).toHaveLength(1)

    service.deleteSession(SESSION)

    expect(service.listInsights()).toHaveLength(0)
    expect(db.select().from(schema.snippets).all()).toHaveLength(0)
    expect(db.select().from(schema.insightSnippets).all()).toHaveLength(0)
  })
})
