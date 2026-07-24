import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fuse from 'fuse.js'
import { and, eq, isNull } from 'drizzle-orm'
import {
  computePeaks, ffprobeDuration, loadTranscript, runFfmpeg, runTranscriber,
  sampleUtterances, schema, sessionDir, sessionIdFor, type Db, type Transcript,
} from '@workshop/harvester-core'
import { type Config } from './config.js'
import { exportSession, exportOcean, type ExportReport, type OceanExport } from './export/exporter.js'
import { createAgentClient, type AgentClient } from './harvest/agent.js'
import { createFixtureClient } from './harvest/fixture.js'
import { runHarvest, runManualTurn, type Proposal, type SpanInput } from './harvest/harvester.js'
import { mergeMarkRegions } from './harvest/spans.js'
import { verbatim } from './anchor.js'

export interface ServerEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

/** All the real logic lives here; Fastify/socket.io are thin adapters. */
export class HarvesterService {
  readonly events = new EventEmitter()

  constructor(readonly config: Config, readonly db: Db) {}

  private emit(event: ServerEvent): void {
    this.events.emit('event', event)
  }

  listSessions() {
    const sessions = this.db.select().from(schema.sessions).all()
    // "curated" = fully reviewed: a post-harvest session with no insight still
    // `proposed` (every one accepted or rejected). Derived, not stored — it
    // flips the moment the last verdict lands, and flips back if a re-harvest
    // proposes more. The list dims these; a curated conversation is no longer
    // something to look at directly (its accepted ideas live in the ocean now).
    const stillProposed = new Set(
      this.db.select({ sessionId: schema.insights.sessionId }).from(schema.insights)
        .where(eq(schema.insights.status, 'proposed')).all().map((r) => r.sessionId),
    )
    return sessions
      .map((s) => ({
        ...s,
        curated: (s.status === 'reviewing' || s.status === 'exported') && !stillProposed.has(s.id),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  sessionDetail(id: string) {
    const session = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, id)).get()
    if (!session) throw new Error(`unknown session: ${id}`)
    const insights = this.db.select().from(schema.insights)
      .where(eq(schema.insights.sessionId, id)).all()
      .map((ins) => this.enrichInsight(ins))
    const harvestSpans = this.db.select().from(schema.harvestSpans)
      .where(eq(schema.harvestSpans.sessionId, id)).all()
    return {
      session,
      participants: this.db.select().from(schema.participants)
        .where(eq(schema.participants.sessionId, id)).all(),
      speakers: this.db.select().from(schema.speakers)
        .where(eq(schema.speakers.sessionId, id)).all(),
      markers: this.db.select().from(schema.markers)
        .where(eq(schema.markers.sessionId, id)).all(),
      gaps: this.db.select().from(schema.gaps)
        .where(eq(schema.gaps.sessionId, id)).all(),
      harvestSpans: harvestSpans.map((s) => ({
        ...s,
        memberIds: this.db.select().from(schema.harvestSpanMembers)
          .where(eq(schema.harvestSpanMembers.harvestSpanId, s.id)).all()
          .map((m) => m.markerId),
      })),
      insights,
      hasTranscript: fs.existsSync(this.transcriptPath(id)),
    }
  }

  /** Load an insight's evidence: its main snippet, and its supporting snippets
   * (each carrying the link's `why`). Shared by the review screen and the ocean. */
  private enrichInsight(ins: typeof schema.insights.$inferSelect) {
    const main = this.db.select().from(schema.snippets)
      .where(eq(schema.snippets.id, ins.mainSnippetId)).get() ?? null
    const supporting = this.db.select().from(schema.insightSnippets)
      .where(eq(schema.insightSnippets.insightId, ins.id)).all()
      .map((l) => {
        const s = this.db.select().from(schema.snippets)
          .where(eq(schema.snippets.id, l.snippetId)).get()
        return s ? { ...s, why: l.why } : null
      })
      .filter((s): s is NonNullable<typeof s> => s != null)
    return { ...ins, main, supporting }
  }

  transcriptPath(id: string): string {
    return path.join(sessionDir(this.config, id), 'transcript.json')
  }

  recordingPath(id: string): string {
    return path.join(sessionDir(this.config, id), 'recording.flac')
  }

  peaksPath(id: string): string {
    return path.join(sessionDir(this.config, id), 'peaks.json')
  }

  /** Recordings are immutable post-finalize, so peaks.json is a
   * write-once cache next to recording.flac — computed on first request,
   * served straight off disk on every one after. */
  async getPeaks(id: string): Promise<{ buckets: number[] }> {
    const cachePath = this.peaksPath(id)
    if (fs.existsSync(cachePath)) {
      console.log(`peaks: cache hit for ${id}`)
      return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { buckets: number[] }
    }
    console.log(`peaks: computing for ${id} (ffmpeg decode)`)
    const buckets = await computePeaks(this.recordingPath(id))
    const payload = { buckets }
    fs.writeFileSync(cachePath, JSON.stringify(payload))
    return payload
  }

  // ---- recording -----------------------------------------------------------

  /** Testing/backfill path: an existing recording file dropped into the web
   * app. The original is copied into the session's folder in the data dir
   * (source of truth), converted to the canonical FLAC, and sent through the
   * same pipeline. No markers exist, so harvesting is sweep-only. */
  async importSession(originalName: string, source: NodeJS.ReadableStream): Promise<string> {
    const id = sessionIdFor(new Date())
    const base = path.basename(originalName)
    const dir = sessionDir(this.config, id)
    fs.mkdirSync(dir, { recursive: true })
    const imported = path.join(dir, `import-${base}`)
    await pipeline(source, fs.createWriteStream(imported))

    this.db.insert(schema.sessions).values({
      id,
      title: `import: ${base}`,
      status: 'transcribing',
      origin: 'import',
      createdAt: Date.now(),
    }).run()
    for (const name of ['Jim', 'Jesse']) {
      this.db.insert(schema.participants).values({ sessionId: id, name }).run()
    }
    this.emit({ type: 'session', sessionId: id })

    try {
      await runFfmpeg(['-y', '-i', imported, '-ac', '1', '-ar', '48000', '-c:a', 'flac',
        this.recordingPath(id)])
      const duration = await ffprobeDuration(this.recordingPath(id))
      this.db.update(schema.sessions).set({ durationS: duration })
        .where(eq(schema.sessions.id, id)).run()
    } catch (err) {
      this.fail(id, `import failed (not an audio file?): ${String(err)}`)
      throw err
    }
    void this.transcribeSession(id)
    return id
  }

  async transcribeSession(id: string): Promise<void> {
    this.setStatus(id, 'transcribing')
    try {
      await runTranscriber(this.config, this.recordingPath(id), this.transcriptPath(id),
        (line) => this.emit({ type: 'pipeline', sessionId: id, line }))
      const transcript = loadTranscript(this.transcriptPath(id))
      this.storeSpeakers(id, transcript)
      this.setStatus(id, 'labeling')
    } catch (err) {
      this.fail(id, String(err))
    }
  }

  private storeSpeakers(id: string, transcript: Transcript): void {
    this.db.delete(schema.speakers).where(eq(schema.speakers.sessionId, id)).run()
    for (const [label, seg] of sampleUtterances(transcript)) {
      this.db.insert(schema.speakers).values({
        sessionId: id,
        label,
        sampleStartS: seg.start,
        sampleEndS: seg.end,
        sampleText: seg.text.trim(),
      }).run()
    }
  }

  assignSpeaker(id: string, label: string, participantId: number): void {
    this.db.update(schema.speakers).set({ participantId })
      .where(and(eq(schema.speakers.sessionId, id), eq(schema.speakers.label, label))).run()
    this.emit({ type: 'session', sessionId: id })
  }

  // ---- harvest -------------------------------------------------------------

  async harvestSession(id: string, opts: { fixture?: boolean } = {}): Promise<void> {
    this.mustGet(id)
    if (!fs.existsSync(this.transcriptPath(id))) throw new Error('no transcript yet')
    const transcript = loadTranscript(this.transcriptPath(id))
    const fixture = opts.fixture ?? false
    const agent = fixture ? createFixtureClient(transcript) : this.agentClient()

    const spans = this.deriveHarvestSpans(id)
    const gaps = this.db.select().from(schema.gaps)
      .where(eq(schema.gaps.sessionId, id)).all()

    const harvest = this.db.insert(schema.harvests).values({
      sessionId: id,
      model: fixture ? 'fixture' : this.config.model,
      fixture,
      status: 'running',
      startedAt: Date.now(),
    }).returning().get()

    this.setStatus(id, 'harvesting')
    try {
      const outcome = await runHarvest(agent, transcript, this.speakerNames(id), spans, gaps,
        (p) => this.emit({ type: 'harvest', sessionId: id, ...p }))
      // Re-harvest replaces prior *proposed* insights; human verdicts survive.
      // Each stale insight takes its own snippets (main + supporting) and links.
      const stale = this.db.select().from(schema.insights)
        .where(and(eq(schema.insights.sessionId, id), eq(schema.insights.status, 'proposed'))).all()
      for (const ins of stale) {
        const links = this.db.select().from(schema.insightSnippets)
          .where(eq(schema.insightSnippets.insightId, ins.id)).all()
        const snippetIds = [ins.mainSnippetId, ...links.map((l) => l.snippetId)]
        this.db.delete(schema.insightSnippets).where(eq(schema.insightSnippets.insightId, ins.id)).run()
        for (const sid of snippetIds) {
          this.db.delete(schema.snippets).where(eq(schema.snippets.id, sid)).run()
        }
        this.db.delete(schema.insights).where(eq(schema.insights.id, ins.id)).run()
      }
      for (const proposal of outcome.proposals) this.storeProposal(id, harvest.id, proposal)
      this.db.update(schema.harvests).set({
        status: 'done',
        finishedAt: Date.now(),
        agentSessionId: outcome.agentSessionId,
      }).where(eq(schema.harvests.id, harvest.id)).run()
      this.setStatus(id, 'reviewing')
    } catch (err) {
      this.db.update(schema.harvests).set({
        status: 'failed', finishedAt: Date.now(), error: String(err),
      }).where(eq(schema.harvests.id, harvest.id)).run()
      this.fail(id, `harvest failed: ${String(err)}`)
      throw err
    }
  }

  async manualInsight(id: string, startWord: number, endWord: number): Promise<void> {
    const transcript = loadTranscript(this.transcriptPath(id))
    if (startWord < 0 || endWord > transcript.words.length || endWord <= startWord) {
      throw new Error('invalid word range')
    }
    const lastHarvest = this.db.select().from(schema.harvests)
      .where(eq(schema.harvests.sessionId, id)).all().at(-1)
    const fixture = lastHarvest?.fixture ?? false
    const agent = fixture ? createFixtureClient(transcript) : this.agentClient()
    const markerCount = this.db.select().from(schema.markers)
      .where(and(eq(schema.markers.sessionId, id), eq(schema.markers.flag, 'ok'))).all().length

    const { proposal, agentSessionId } = await runManualTurn(
      agent, transcript, { start: startWord, end: endWord },
      lastHarvest?.agentSessionId ?? null, this.speakerNames(id), markerCount)
    if (lastHarvest) {
      this.db.update(schema.harvests).set({ agentSessionId })
        .where(eq(schema.harvests.id, lastHarvest.id)).run()
    }
    this.storeProposal(id, lastHarvest?.id ?? null, proposal)
    this.emit({ type: 'session', sessionId: id })
  }

  /** Merged mark regions: wiped and re-derived on each harvest (never
   * touching raw markers), persisted so snippets can link back through
   * harvest_span_members. One code path — local sessions derive trivially. */
  private deriveHarvestSpans(id: string): SpanInput[] {
    const markerRows = this.db.select().from(schema.markers)
      .where(eq(schema.markers.sessionId, id)).all()
      .filter((m) => (m.flag === 'ok' || m.flag === 'unclosed') && m.endS != null)
    const regions = mergeMarkRegions(markerRows
      .map((m) => ({ id: m.id, startS: m.startS, endS: m.endS!, participant: m.participant })))

    const stale = this.db.select().from(schema.harvestSpans)
      .where(eq(schema.harvestSpans.sessionId, id)).all()
    for (const s of stale) {
      this.db.delete(schema.harvestSpanMembers)
        .where(eq(schema.harvestSpanMembers.harvestSpanId, s.id)).run()
    }
    this.db.delete(schema.harvestSpans).where(eq(schema.harvestSpans.sessionId, id)).run()

    return regions.map((r) => {
      const row = this.db.insert(schema.harvestSpans).values({
        sessionId: id,
        startS: r.startS,
        endS: r.endS,
        participantCount: r.participantCount,
      }).returning().get()
      for (const markerId of r.memberIds) {
        this.db.insert(schema.harvestSpanMembers).values({
          harvestSpanId: row.id, markerId,
        }).run()
      }
      return { id: row.id, startS: r.startS, endS: r.endS, multiMarked: r.participantCount > 1 }
    })
  }

  private agentClient(): AgentClient {
    return createAgentClient(this.config.model)
  }

  private speakerNames(id: string): Map<string, string> {
    const participantRows = this.db.select().from(schema.participants)
      .where(eq(schema.participants.sessionId, id)).all()
    const names = new Map(participantRows.map((p) => [p.id, p.name]))
    const speakerRows = this.db.select().from(schema.speakers)
      .where(eq(schema.speakers.sessionId, id)).all()
    return new Map(speakerRows.map((s) => [
      s.label,
      (s.participantId != null ? names.get(s.participantId) : null) ?? s.label,
    ]))
  }

  /** Persist one harvester proposal as an insight over its snippets: a main
   * evidence snippet, the insight itself (title + description from `note`),
   * and a supporting snippet + link per supporting quote. All `proposed`. */
  private storeProposal(sessionId: string, harvestId: number | null, p: Proposal): void {
    const mkSnippet = (range: { start: number; end: number }, quote: string, anchored: boolean) =>
      this.db.insert(schema.snippets).values({
        sessionId,
        startWord: range.start,
        endWord: range.end,
        quote,
        anchored,
        spokenAt: this.spokenAtOf(sessionId, range.start),
        status: 'proposed',
      }).returning().get()

    const main = mkSnippet(p.main.range, p.main.quote, p.main.anchored)
    const insight = this.db.insert(schema.insights).values({
      sessionId,
      harvestId,
      origin: p.origin,
      harvestSpanId: p.harvestSpanId ?? null,
      mainSnippetId: main.id,
      title: p.title,
      description: p.note,
      status: 'proposed',
      createdAt: Date.now(),
    }).returning().get()
    for (const s of p.supporting) {
      const snip = mkSnippet(s.range, s.quote, s.anchored)
      this.db.insert(schema.insightSnippets).values({
        insightId: insight.id, snippetId: snip.id, why: s.why,
      }).run()
    }
  }

  // ---- review --------------------------------------------------------------

  /** Review an insight in place. Editing title/description mutates the insight;
   * a word-range edit re-anchors its *main* snippet (and its spoken moment). A
   * status change is the whole review verdict — it cascades to every snippet
   * the insight owns (main + supporting), so accepting an insight accepts its
   * evidence and drops it into the ocean. No copy, no birth. */
  updateInsight(insightId: number, patch: {
    status?: 'proposed' | 'accepted' | 'rejected'
    startWord?: number
    endWord?: number
    title?: string
    description?: string
  }): void {
    const insight = this.db.select().from(schema.insights)
      .where(eq(schema.insights.id, insightId)).get()
    if (!insight) throw new Error(`unknown insight: ${insightId}`)

    const values: Partial<typeof schema.insights.$inferInsert> = {}
    if (patch.status) values.status = patch.status
    if (patch.title != null) values.title = patch.title.trim()
    if (patch.description != null) values.description = patch.description.trim()
    if (Object.keys(values).length > 0) {
      this.db.update(schema.insights).set(values)
        .where(eq(schema.insights.id, insightId)).run()
    }

    // A word-range edit re-anchors the main snippet.
    if (patch.startWord != null || patch.endWord != null) {
      const main = this.db.select().from(schema.snippets)
        .where(eq(schema.snippets.id, insight.mainSnippetId)).get()
      if (main) {
        const transcript = loadTranscript(this.transcriptPath(main.sessionId))
        const start = patch.startWord ?? main.startWord
        const end = patch.endWord ?? main.endWord
        if (start < 0 || end > transcript.words.length || end <= start) {
          throw new Error('invalid word range')
        }
        this.db.update(schema.snippets).set({
          startWord: start,
          endWord: end,
          // Boundaries set by a human against the words array are anchored by construction.
          quote: verbatim(transcript.words, { start, end }),
          anchored: true,
          spokenAt: this.spokenAtOf(main.sessionId, start),
        }).where(eq(schema.snippets.id, main.id)).run()
      }
    }

    // The verdict cascades to the insight's snippets (main + supporting).
    if (patch.status) {
      const linkIds = this.db.select({ id: schema.insightSnippets.snippetId })
        .from(schema.insightSnippets).where(eq(schema.insightSnippets.insightId, insightId))
        .all().map((r) => r.id)
      for (const sid of [insight.mainSnippetId, ...linkIds]) {
        this.db.update(schema.snippets).set({ status: patch.status })
          .where(eq(schema.snippets.id, sid)).run()
      }
    }

    this.emit({ type: 'session', sessionId: insight.sessionId })
  }

  // ---- the ocean -----------------------------------------------------------

  /** The backfill pass for migration 0003. The column it adds can be filled
   * by SQL, but the *value* can't: the word offset lives in transcript.json on
   * disk, out of a `.sql` migration's reach. So it runs here in code, once at
   * boot right after migrations. Only null rows are touched — a no-op on every
   * boot after the first, and self-healing if a transcript arrives later. */
  backfillSpokenAt(): void {
    const pending = this.db.select().from(schema.snippets)
      .where(isNull(schema.snippets.spokenAt)).all()
    if (pending.length === 0) return
    let filled = 0
    for (const s of pending) {
      const at = this.spokenAtOf(s.sessionId, s.startWord)
      if (at == null) continue
      this.db.update(schema.snippets).set({ spokenAt: at })
        .where(eq(schema.snippets.id, s.id)).run()
      filled++
    }
    if (filled > 0) console.log(`backfilled spoken_at for ${filled}/${pending.length} snippet(s)`)
  }

  /** The spoken moment for a snippet, absolute epoch ms = session start +
   * the word's offset into the recording. Stored on the snippet (the atom).
   * Returns null when the transcript or word timing can't be resolved —
   * callers leave the column null and the ocean falls back to accept time. */
  private spokenAtOf(sessionId: string, startWord: number): number | null {
    const session = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId)).get()
    if (!session) return null
    try {
      const transcript = loadTranscript(this.transcriptPath(sessionId))
      for (let i = Math.max(0, startWord); i < transcript.words.length; i++) {
        const start = transcript.words[i]?.start
        if (start != null) return session.createdAt + Math.round(start * 1000)
      }
    } catch { /* no transcript on disk */ }
    return null
  }

  /** The ocean: every *accepted* insight, newest-spoken first, each carrying
   * its evidence — the main snippet plus supporting snippets (so the UI can
   * expand an insight to the snippets it's built from). Ordered by the main
   * snippet's spokenAt (falling back to the insight's accept time). With `q`,
   * fuzzy-ranked over title, description and the resolved quote text (backend
   * Fuse — one search seam, the client never holds the corpus). */
  listInsights(q?: string) {
    const enriched = this.db.select().from(schema.insights)
      .where(eq(schema.insights.status, 'accepted')).all()
      .map((ins) => {
        const { main, supporting } = this.enrichInsight(ins)
        const session = main
          ? this.db.select().from(schema.sessions)
            .where(eq(schema.sessions.id, main.sessionId)).get()
          : undefined
        const quoteText = [main?.quote, ...supporting.map((s) => s.quote)]
          .filter(Boolean).join('  ')
        const spokenAt = main?.spokenAt ?? ins.createdAt
        return {
          id: ins.id,
          title: ins.title,
          description: ins.description,
          spokenAt,
          createdAt: ins.createdAt,
          sessionId: main?.sessionId ?? null,
          sessionTitle: session?.title ?? null,
          quote: main?.quote ?? null,
          quoteText,
          // the snippets this insight is built from, for the expandable view
          snippets: [main, ...supporting].filter((s): s is NonNullable<typeof s> => s != null)
            .map((s) => ({ id: s.id, quote: s.quote, spokenAt: s.spokenAt })),
        }
      }).sort((a, b) => b.spokenAt - a.spokenAt)

    const query = q?.trim()
    if (!query) return enriched
    const fuse = new Fuse(enriched, {
      keys: [
        { name: 'title', weight: 2 },
        { name: 'description', weight: 1.5 },
        { name: 'quoteText', weight: 1 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
    })
    return fuse.search(query).map((r) => r.item)
  }

  async export(id: string): Promise<ExportReport> {
    const report = await exportSession(this.config, this.db, id)
    this.emit({ type: 'session', sessionId: id })
    return report
  }

  /** Export the currently-filtered ocean as a downloadable zip. `q` is the
   * same fuzzy query the ocean list uses, so the archive holds exactly the
   * insights on screen — one flat note each, insight text for the note,
   * evidence resolved through the source snippet (see exportOcean in the
   * exporter). */
  async exportOcean(q?: string): Promise<OceanExport> {
    const items = this.listInsights(q).map((ins) => ({
      insightId: ins.id,
      title: ins.title,
      description: ins.description,
    }))
    return exportOcean(this.config, this.db, items)
  }

  /** Wipes every row and file belonging to a session. Used both by the
   * delete button and by the call package when a call ends having recorded
   * nothing worth keeping. */
  deleteSession(id: string): void {
    this.mustGet(id)
    const insightIds = this.db.select({ id: schema.insights.id }).from(schema.insights)
      .where(eq(schema.insights.sessionId, id)).all().map((r) => r.id)
    for (const insightId of insightIds) {
      this.db.delete(schema.insightSnippets).where(eq(schema.insightSnippets.insightId, insightId)).run()
    }
    this.db.delete(schema.insights).where(eq(schema.insights.sessionId, id)).run()
    const spanIds = this.db.select({ id: schema.harvestSpans.id }).from(schema.harvestSpans)
      .where(eq(schema.harvestSpans.sessionId, id)).all().map((r) => r.id)
    for (const spanId of spanIds) {
      this.db.delete(schema.harvestSpanMembers).where(eq(schema.harvestSpanMembers.harvestSpanId, spanId)).run()
    }
    this.db.delete(schema.snippets).where(eq(schema.snippets.sessionId, id)).run()
    this.db.delete(schema.harvestSpans).where(eq(schema.harvestSpans.sessionId, id)).run()
    this.db.delete(schema.harvests).where(eq(schema.harvests.sessionId, id)).run()
    this.db.delete(schema.markers).where(eq(schema.markers.sessionId, id)).run()
    this.db.delete(schema.gaps).where(eq(schema.gaps.sessionId, id)).run()
    this.db.delete(schema.trackSegments).where(eq(schema.trackSegments.sessionId, id)).run()
    this.db.delete(schema.speakers).where(eq(schema.speakers.sessionId, id)).run()
    this.db.delete(schema.participants).where(eq(schema.participants.sessionId, id)).run()
    this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run()
    fs.rmSync(sessionDir(this.config, id), { recursive: true, force: true })
    this.emit({ type: 'session-deleted', sessionId: id })
  }

  // ---- helpers -------------------------------------------------------------

  private mustGet(id: string) {
    const session = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, id)).get()
    if (!session) throw new Error(`unknown session: ${id}`)
    return session
  }

  private setStatus(id: string, status: string): void {
    this.db.update(schema.sessions).set({ status, error: null })
      .where(eq(schema.sessions.id, id)).run()
    this.emit({ type: 'session', sessionId: id })
  }

  private fail(id: string, error: string): void {
    this.db.update(schema.sessions).set({ status: 'failed', error })
      .where(eq(schema.sessions.id, id)).run()
    this.emit({ type: 'session', sessionId: id })
  }

}
