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
    const supports = new Map<number, unknown[]>()
    for (const i of insights) {
      supports.set(i.id, this.db.select().from(schema.supportingQuotes)
        .where(eq(schema.supportingQuotes.insightId, i.id)).all())
    }
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
      insights: insights.map((i) => ({ ...i, supporting: supports.get(i.id) ?? [] })),
      hasTranscript: fs.existsSync(this.transcriptPath(id)),
    }
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
      const stale = this.db.select().from(schema.insights)
        .where(and(eq(schema.insights.sessionId, id), eq(schema.insights.status, 'proposed'))).all()
      for (const s of stale) {
        this.db.delete(schema.supportingQuotes).where(eq(schema.supportingQuotes.insightId, s.id)).run()
        this.db.delete(schema.insights).where(eq(schema.insights.id, s.id)).run()
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
   * touching raw markers), persisted so insights can link back through
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

  private storeProposal(sessionId: string, harvestId: number | null, p: Proposal): void {
    const row = this.db.insert(schema.insights).values({
      sessionId,
      harvestId,
      origin: p.origin,
      harvestSpanId: p.harvestSpanId ?? null,
      title: p.title,
      startWord: p.main.range.start,
      endWord: p.main.range.end,
      quote: p.main.quote,
      insight: p.insight,
      anchored: p.main.anchored,
      spokenAt: this.spokenAtOf(sessionId, p.main.range.start),
      status: 'proposed',
      createdAt: Date.now(),
    }).returning().get()
    for (const s of p.supporting) {
      this.db.insert(schema.supportingQuotes).values({
        insightId: row.id,
        startWord: s.range.start,
        endWord: s.range.end,
        quote: s.quote,
        why: s.why,
        anchored: s.anchored,
      }).run()
    }
  }

  // ---- review --------------------------------------------------------------

  updateInsight(insightId: number, patch: {
    status?: 'proposed' | 'accepted' | 'rejected'
    startWord?: number
    endWord?: number
    title?: string
    insight?: string
  }): void {
    const insight = this.db.select().from(schema.insights)
      .where(eq(schema.insights.id, insightId)).get()
    if (!insight) throw new Error(`unknown insight: ${insightId}`)

    const values: Partial<typeof schema.insights.$inferInsert> = {}
    if (patch.status) values.status = patch.status
    if (patch.title != null) values.title = patch.title.trim()
    if (patch.insight != null) values.insight = patch.insight.trim()

    if (patch.startWord != null || patch.endWord != null) {
      const transcript = loadTranscript(this.transcriptPath(insight.sessionId))
      const start = patch.startWord ?? insight.startWord
      const end = patch.endWord ?? insight.endWord
      if (start < 0 || end > transcript.words.length || end <= start) {
        throw new Error('invalid word range')
      }
      values.startWord = start
      values.endWord = end
      // Boundaries set by a human against the words array are anchored by construction.
      values.quote = verbatim(transcript.words, { start, end })
      values.anchored = true
      // Moving the range moves the spoken moment — recompute the birthday.
      values.spokenAt = this.spokenAtOf(insight.sessionId, start)
    }

    // Backfill lazily: rows created before this column (or seeded without a
    // transcript on hand) get their spoken moment the first time they're
    // touched, so the ocean can sort them by when the words were said.
    if (values.spokenAt == null && insight.spokenAt == null) {
      const at = this.spokenAtOf(insight.sessionId, insight.startWord)
      if (at != null) values.spokenAt = at
    }

    this.db.update(schema.insights).set(values)
      .where(eq(schema.insights.id, insightId)).run()

    // Accepting an insight is what "moves it into the ocean": a snippet is
    // born, once, on the transition to accepted. Copy title/description from
    // the insight's final state (this same patch may have edited them); from
    // then on the snippet is free to diverge and the insight stays the source.
    if (patch.status === 'accepted' && insight.status !== 'accepted') {
      this.ensureSnippet(
        { id: insight.id },
        values.title ?? insight.title,
        values.insight ?? insight.insight,
      )
    }

    this.emit({ type: 'session', sessionId: insight.sessionId })
  }

  // ---- snippets (the ocean) ------------------------------------------------

  /** Born once per source insight. Idempotent: re-accepting (or accepting an
   * insight that already spawned a snippet, e.g. after an un-accept round
   * trip) never clobbers an edited snippet. */
  private ensureSnippet(
    insight: { id: number },
    title: string,
    description: string,
  ): void {
    const existing = this.db.select().from(schema.snippets)
      .where(eq(schema.snippets.sourceInsightId, insight.id)).get()
    if (existing) return
    this.db.insert(schema.snippets).values({
      sourceInsightId: insight.id,
      title,
      description,
      createdAt: Date.now(),
    }).run()
  }

  /** The backfill pass for migration 0003. The column it adds can be filled
   * by SQL, but the *value* can't: the word offset lives in transcript.json on
   * disk, out of a `.sql` migration's reach. So it runs here in code, once at
   * boot right after migrations. Only null rows are touched — a no-op on every
   * boot after the first, and self-healing if a transcript arrives later. */
  backfillSpokenAt(): void {
    const pending = this.db.select().from(schema.insights)
      .where(isNull(schema.insights.spokenAt)).all()
    if (pending.length === 0) return
    let filled = 0
    for (const i of pending) {
      const at = this.spokenAtOf(i.sessionId, i.startWord)
      if (at == null) continue
      this.db.update(schema.insights).set({ spokenAt: at })
        .where(eq(schema.insights.id, i.id)).run()
      filled++
    }
    if (filled > 0) console.log(`backfilled spoken_at for ${filled}/${pending.length} insight(s)`)
  }

  /** The spoken moment for an insight, absolute epoch ms = session start +
   * the word's offset into the recording. Stored on the insight (evidence
   * layer). Returns null when the transcript or word timing can't be resolved
   * — callers leave the column null and the ocean falls back to accept time. */
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

  /** The ocean: every snippet, newest-spoken first. Each is enriched with its
   * source insight's live evidence (quote + supporting quotes) and a link
   * back to the conversation. With `q`, results are fuzzy-ranked over title,
   * description, and the resolved quote text (backend Fuse — one search seam,
   * the client never holds the corpus). A snippet whose source insight has
   * since been removed still lists, with a null link (it's independent once
   * born); only a full session delete takes its snippets with it. */
  listSnippets(q?: string) {
    const enriched = this.db.select().from(schema.snippets).all().map((s) => {
      const insight = this.db.select().from(schema.insights)
        .where(eq(schema.insights.id, s.sourceInsightId)).get()
      const supports = insight
        ? this.db.select().from(schema.supportingQuotes)
          .where(eq(schema.supportingQuotes.insightId, insight.id)).all()
        : []
      const session = insight
        ? this.db.select().from(schema.sessions)
          .where(eq(schema.sessions.id, insight.sessionId)).get()
        : undefined
      const quoteText = [insight?.quote, ...supports.map((x) => x.quote)]
        .filter(Boolean).join('  ')
      // The birthday lives on the source insight; a snippet whose source is
      // gone falls back to when it was accepted into the ocean.
      const spokenAt = insight?.spokenAt ?? s.createdAt
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        spokenAt,
        createdAt: s.createdAt,
        sourceInsightId: s.sourceInsightId,
        sessionId: insight?.sessionId ?? null,
        sessionTitle: session?.title ?? null,
        quote: insight?.quote ?? null,
        quoteText,
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
   * snippets on screen — one flat note each, snippet text for the note,
   * evidence resolved through the source insight (see exportOcean in the
   * exporter). */
  async exportOcean(q?: string): Promise<OceanExport> {
    const items = this.listSnippets(q).map((s) => ({
      snippetId: s.id,
      sourceInsightId: s.sourceInsightId,
      title: s.title,
      description: s.description,
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
      this.db.delete(schema.supportingQuotes).where(eq(schema.supportingQuotes.insightId, insightId)).run()
      // A full session wipe takes the snippets it sourced with it — otherwise
      // they'd dangle with no conversation to travel back to.
      this.db.delete(schema.snippets).where(eq(schema.snippets.sourceInsightId, insightId)).run()
    }
    const spanIds = this.db.select({ id: schema.harvestSpans.id }).from(schema.harvestSpans)
      .where(eq(schema.harvestSpans.sessionId, id)).all().map((r) => r.id)
    for (const spanId of spanIds) {
      this.db.delete(schema.harvestSpanMembers).where(eq(schema.harvestSpanMembers.harvestSpanId, spanId)).run()
    }
    this.db.delete(schema.insights).where(eq(schema.insights.sessionId, id)).run()
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
