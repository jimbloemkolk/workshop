import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { eq } from 'drizzle-orm'
import { openDb, schema, sessionDir, type Db, type Transcript } from '@workshop/harvester-core'
import { HarvesterService } from '../src/service.js'
import type { Config } from '../src/config.js'

/** The ocean's birth logic is DB- and disk-coupled (a transcript on disk
 * supplies the spoken time), so this is a small integration test around a
 * real sqlite file and a temp data dir rather than a pure-function unit. */
describe('snippets (the ocean)', () => {
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

  /** Seed a session + one proposed insight, with a transcript on disk. */
  const seedInsight = (overrides: Partial<typeof schema.insights.$inferInsert> = {}): number => {
    db.insert(schema.sessions).values({
      id: SESSION, title: 'A chat with Jesse', status: 'reviewing', origin: 'call',
      language: 'nl', createdAt: SESSION_CREATED,
    }).run()
    const sdir = sessionDir(config(dir), SESSION)
    fs.mkdirSync(sdir, { recursive: true })
    fs.writeFileSync(path.join(sdir, 'transcript.json'), JSON.stringify(transcript()))
    const row = db.insert(schema.insights).values({
      sessionId: SESSION, harvestId: null, origin: 'marker', harvestSpanId: null,
      title: 'Snippets are their own thing', startWord: 1, endWord: 3,
      quote: 'ocean remembers', insight: 'A snippet originates from an insight but lives apart.',
      anchored: true, status: 'proposed', createdAt: SESSION_CREATED, ...overrides,
    }).returning().get()
    return row.id
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-'))
    db = openDb(dir)
    service = new HarvesterService(config(dir), db)
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('is born on accept, at the spoken moment, copying the insight', () => {
    const id = seedInsight()
    expect(service.listSnippets()).toHaveLength(0)

    service.updateInsight(id, { status: 'accepted' })

    const [snippet] = service.listSnippets()
    expect(snippet).toMatchObject({
      title: 'Snippets are their own thing',
      description: 'A snippet originates from an insight but lives apart.',
      sourceInsightId: id,
      sessionId: SESSION,
      sessionTitle: 'A chat with Jesse',
    })
    // spokenAt = session start + the first word's offset (10s) into the recording
    expect(snippet!.spokenAt).toBe(SESSION_CREATED + 10_000)
  })

  it('copies title/description edited in the same accept patch, not the stale ones', () => {
    const id = seedInsight()
    service.updateInsight(id, { status: 'accepted', title: 'Reworded', insight: 'Sharpened.' })
    const [snippet] = service.listSnippets()
    expect(snippet).toMatchObject({ title: 'Reworded', description: 'Sharpened.' })
  })

  it('is born once — re-accepting never clobbers an edited snippet', () => {
    const id = seedInsight()
    service.updateInsight(id, { status: 'accepted' })
    service.updateInsight(id, { status: 'rejected' })
    service.updateInsight(id, { status: 'accepted' })
    expect(service.listSnippets()).toHaveLength(1)
  })

  it('re-anchoring the source insight moves the spoken moment', () => {
    // Now that the birthday lives on the insight, editing its word range
    // recomputes it — the frozen-at-birth copy never could.
    const id = seedInsight() // startWord 1 → word[1].start = 10s
    service.updateInsight(id, { status: 'accepted' })
    expect(service.listSnippets()[0]!.spokenAt).toBe(SESSION_CREATED + 10_000)

    service.updateInsight(id, { startWord: 0, endWord: 1 }) // word[0].start = 0s
    expect(service.listSnippets()[0]!.spokenAt).toBe(SESSION_CREATED)
  })

  it('orders newest-spoken first', () => {
    // second session, spoken later in wall-clock and later in its own recording
    const first = seedInsight()
    db.insert(schema.sessions).values({
      id: 'sess-2', title: 'Later chat', status: 'reviewing', origin: 'call',
      language: 'nl', createdAt: SESSION_CREATED + 1_000_000,
    }).run()
    const sdir = sessionDir(config(dir), 'sess-2')
    fs.mkdirSync(sdir, { recursive: true })
    fs.writeFileSync(path.join(sdir, 'transcript.json'), JSON.stringify(transcript()))
    const second = db.insert(schema.insights).values({
      sessionId: 'sess-2', harvestId: null, origin: 'marker', harvestSpanId: null,
      title: 'Later idea', startWord: 1, endWord: 2, quote: 'ocean', insight: 'Later.',
      anchored: true, status: 'proposed', createdAt: SESSION_CREATED,
    }).returning().get()

    service.updateInsight(first, { status: 'accepted' })
    service.updateInsight(second.id, { status: 'accepted' })

    expect(service.listSnippets().map((s) => s.title)).toEqual(['Later idea', 'Snippets are their own thing'])
  })

  it('fuzzy-searches title, description and the source quote', () => {
    service.updateInsight(seedInsight(), { status: 'accepted' })
    expect(service.listSnippets('remembr').map((s) => s.title)).toEqual(['Snippets are their own thing']) // quote typo
    expect(service.listSnippets('aprt').map((s) => s.title)).toEqual(['Snippets are their own thing'])     // description typo
    expect(service.listSnippets('zzz nothing')).toHaveLength(0)
  })

  it('backfills spoken_at for rows that predate the column', () => {
    const id = seedInsight() // seeded straight in, so spoken_at starts null
    expect(db.select().from(schema.insights).where(eq(schema.insights.id, id)).get()!.spokenAt).toBeNull()

    service.backfillSpokenAt()

    expect(db.select().from(schema.insights).where(eq(schema.insights.id, id)).get()!.spokenAt)
      .toBe(SESSION_CREATED + 10_000) // word[1].start = 10s
  })

  it('exports the filtered ocean as a zip, titled by the snippet, evidence from the insight', async () => {
    // unanchored → note is written but no clip, so the test needs no ffmpeg/recording
    service.updateInsight(seedInsight({ anchored: false }), { status: 'accepted' })

    const { archive, filename, exported, clips } = await service.exportOcean()
    expect(exported).toBe(1)
    expect(clips).toBe(0)
    expect(filename).toMatch(/^ocean-\d{4}-\d{2}-\d{2}\.zip$/)

    const zip = await JSZip.loadAsync(archive)
    const notes = Object.keys(zip.files).filter((f) => f.endsWith('.md'))
    expect(notes).toEqual(['Ocean/snippets-are-their-own-thing.md']) // flat Ocean/ folder, slugged title
    const note = await zip.file(notes[0]!)!.async('string')
    expect(note).toContain('# Snippets are their own thing')          // snippet title → H1
    expect(note).toContain('A snippet originates from an insight')    // snippet description
    expect(note).toContain('harvester/snippet')                       // idea-layer tag
    expect(note).toContain('ocean remembers')                         // evidence via source insight
  })

  it('respects the search filter on export', async () => {
    service.updateInsight(seedInsight({ anchored: false }), { status: 'accepted' })
    expect((await service.exportOcean('zzz-nothing')).exported).toBe(0)
    expect((await service.exportOcean('snippets')).exported).toBe(1)
  })

  it('marks a session curated once no insight is left proposed', () => {
    const a = seedInsight() // creates the session + one proposed insight
    const b = db.insert(schema.insights).values({
      sessionId: SESSION, harvestId: null, origin: 'marker', harvestSpanId: null,
      title: 'Second', startWord: 1, endWord: 2, quote: 'ocean', insight: 'More.',
      anchored: true, status: 'proposed', createdAt: SESSION_CREATED,
    }).returning().get()

    expect(service.listSessions()[0]!.curated).toBe(false) // two still proposed
    service.updateInsight(a, { status: 'accepted' })
    expect(service.listSessions()[0]!.curated).toBe(false) // b still proposed
    service.updateInsight(b.id, { status: 'rejected' })
    expect(service.listSessions()[0]!.curated).toBe(true)  // every verdict in
  })

  it('is taken with its source on a full session delete', () => {
    service.updateInsight(seedInsight(), { status: 'accepted' })
    expect(service.listSnippets()).toHaveLength(1)
    service.deleteSession(SESSION)
    expect(service.listSnippets()).toHaveLength(0)
  })
})
