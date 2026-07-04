import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { and, eq, isNull } from 'drizzle-orm'
import { sessionDir, type Config } from './config.js'
import { schema, type Db } from './db/index.js'
import { exportSession, type ExportReport } from './export/exporter.js'
import { createAgentClient, type AgentClient } from './harvest/agent.js'
import { createFixtureClient } from './harvest/fixture.js'
import { runHarvest, runManualTurn, type Proposal } from './harvest/harvester.js'
import { concatSegments, markerFlag, Recorder, segmentsDuration } from './recorder.js'
import { runTranscriber } from './transcribe.js'
import { loadTranscript, sampleUtterances, type Transcript } from './transcript.js'
import { verbatim } from './anchor.js'
import { ffprobeDuration, runFfmpeg, sessionIdFor } from './util.js'

export interface ServerEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

/** All the real logic lives here; Fastify/socket.io are thin adapters. */
export class HarvesterService {
  readonly events = new EventEmitter()
  private recorders = new Map<string, Recorder>()
  private openMarkers = new Map<string, number>() // sessionId -> marker row id
  private clockTimer: NodeJS.Timeout | null = null

  constructor(readonly config: Config, readonly db: Db) {}

  private emit(event: ServerEvent): void {
    this.events.emit('event', event)
  }

  /** Sessions that were mid-recording when the backend died surface as
   * interrupted; the UI offers resume-or-finalize. */
  markInterruptedSessions(): void {
    const stuck = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.status, 'recording')).all()
    for (const s of stuck) {
      this.db.update(schema.sessions).set({ status: 'interrupted' })
        .where(eq(schema.sessions.id, s.id)).run()
    }
  }

  listSessions() {
    return this.db.select().from(schema.sessions).all()
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
    return {
      session,
      participants: this.db.select().from(schema.participants)
        .where(eq(schema.participants.sessionId, id)).all(),
      speakers: this.db.select().from(schema.speakers)
        .where(eq(schema.speakers.sessionId, id)).all(),
      markers: this.db.select().from(schema.markers)
        .where(eq(schema.markers.sessionId, id)).all(),
      insights: insights.map((i) => ({ ...i, supporting: supports.get(i.id) ?? [] })),
      recordingPosition: this.recorders.get(id)?.positionS() ?? null,
      hasTranscript: fs.existsSync(this.transcriptPath(id)),
    }
  }

  transcriptPath(id: string): string {
    return path.join(sessionDir(this.config, id), 'transcript.json')
  }

  recordingPath(id: string): string {
    return path.join(sessionDir(this.config, id), 'recording.flac')
  }

  // ---- recording -----------------------------------------------------------

  async startSession(title: string | null, participantNames: string[]): Promise<string> {
    const id = sessionIdFor(new Date())
    const names = participantNames.length > 0 ? participantNames : ['Jim', 'Jesse']
    this.db.insert(schema.sessions).values({
      id,
      title: title?.trim() || names.join(' × '),
      status: 'recording',
      createdAt: Date.now(),
    }).run()
    for (const name of names) {
      this.db.insert(schema.participants).values({ sessionId: id, name }).run()
    }
    await this.startRecorder(id, 0)
    this.emit({ type: 'session', sessionId: id })
    return id
  }

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

  async resumeSession(id: string): Promise<void> {
    const session = this.mustGet(id)
    if (session.status !== 'interrupted') throw new Error('session is not interrupted')
    const segsDir = path.join(sessionDir(this.config, id), 'segments')
    const lastRun = this.db.select().from(schema.recordingRuns)
      .where(eq(schema.recordingRuns.sessionId, id)).all().at(-1)
    const lastActivity = latestMtime(segsDir) ?? lastRun?.startedAt ?? Date.now()
    const gapS = Math.max(0, (Date.now() - lastActivity) / 1000)
    await this.startRecorder(id, gapS)
    this.db.update(schema.sessions).set({ status: 'recording' })
      .where(eq(schema.sessions.id, id)).run()
    this.emit({ type: 'session', sessionId: id })
  }

  private async startRecorder(id: string, gapBeforeS: number): Promise<void> {
    const segsDir = path.join(sessionDir(this.config, id), 'segments')
    const recorder = new Recorder(segsDir, this.config.micDevice, this.config.segmentSeconds)
    const firstSegment = await recorder.start()
    this.recorders.set(id, recorder)
    this.db.insert(schema.recordingRuns).values({
      sessionId: id, startedAt: Date.now(), gapBeforeS, firstSegment,
    }).run()
    this.ensureClock()
  }

  private ensureClock(): void {
    this.clockTimer ??= setInterval(() => {
      let live = 0
      for (const [id, rec] of this.recorders) {
        if (!rec.running) continue
        live += 1
        this.emit({ type: 'clock', sessionId: id, positionS: rec.positionS() })
      }
      if (live === 0 && this.clockTimer) {
        clearInterval(this.clockTimer)
        this.clockTimer = null
      }
    }, 500)
  }

  markerDown(id: string): void {
    const rec = this.recorders.get(id)
    if (!rec?.running || this.openMarkers.has(id)) return
    const row = this.db.insert(schema.markers).values({
      sessionId: id, startS: rec.positionS(), createdAt: Date.now(),
    }).returning().get()
    this.openMarkers.set(id, row.id)
    this.emit({ type: 'marker', sessionId: id, marker: row })
  }

  markerUp(id: string): void {
    const rec = this.recorders.get(id)
    const markerId = this.openMarkers.get(id)
    if (!rec?.running || markerId == null) return
    this.openMarkers.delete(id)
    const marker = this.db.select().from(schema.markers)
      .where(eq(schema.markers.id, markerId)).get()
    if (!marker) return
    const endS = rec.positionS()
    const flag = markerFlag(marker.startS, endS, this.config.markerMinMs)
    const row = this.db.update(schema.markers).set({ endS, flag })
      .where(eq(schema.markers.id, markerId)).returning().get()
    this.emit({ type: 'marker', sessionId: id, marker: row })
  }

  async stopSession(id: string): Promise<void> {
    const rec = this.recorders.get(id)
    if (!rec) throw new Error('session is not recording')
    const position = rec.positionS()
    await rec.stop()
    this.recorders.delete(id)
    const openId = this.openMarkers.get(id)
    if (openId != null) {
      this.openMarkers.delete(id)
      this.db.update(schema.markers).set({ endS: position, flag: 'unclosed' })
        .where(eq(schema.markers.id, openId)).run()
    }
    this.db.update(schema.recordingRuns).set({ endedAt: Date.now() })
      .where(and(eq(schema.recordingRuns.sessionId, id), isNull(schema.recordingRuns.endedAt))).run()
    await this.finalizeSession(id)
  }

  /** Concat what exists and continue the pipeline — the stop path and the
   * interrupted-session "Finalize" button share this. */
  async finalizeSession(id: string): Promise<void> {
    this.setStatus(id, 'transcribing')
    const dir = sessionDir(this.config, id)
    try {
      const duration = await concatSegments(path.join(dir, 'segments'), this.recordingPath(id))
      this.db.update(schema.sessions).set({ durationS: duration })
        .where(eq(schema.sessions.id, id)).run()
    } catch (err) {
      this.fail(id, `concat failed: ${String(err)}`)
      throw err
    }
    void this.transcribeSession(id)
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

    const markerRows = this.db.select().from(schema.markers)
      .where(and(eq(schema.markers.sessionId, id), eq(schema.markers.flag, 'ok'))).all()
    const markers = markerRows
      .filter((m) => m.endS != null)
      .map((m) => ({ id: m.id, startS: m.startS, endS: m.endS! }))
    const unclosed = this.db.select().from(schema.markers)
      .where(and(eq(schema.markers.sessionId, id), eq(schema.markers.flag, 'unclosed'))).all()
    markers.push(...unclosed.filter((m) => m.endS != null)
      .map((m) => ({ id: m.id, startS: m.startS, endS: m.endS! })))
    markers.sort((a, b) => a.startS - b.startS)

    const harvest = this.db.insert(schema.harvests).values({
      sessionId: id,
      model: fixture ? 'fixture' : this.config.model,
      fixture,
      status: 'running',
      startedAt: Date.now(),
    }).returning().get()

    this.setStatus(id, 'harvesting')
    try {
      const outcome = await runHarvest(agent, transcript, this.speakerNames(id), markers,
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
      markerId: p.markerId,
      title: p.title,
      startWord: p.main.range.start,
      endWord: p.main.range.end,
      quote: p.main.quote,
      insight: p.insight,
      anchored: p.main.anchored,
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
    }
    this.db.update(schema.insights).set(values)
      .where(eq(schema.insights.id, insightId)).run()
    this.emit({ type: 'session', sessionId: insight.sessionId })
  }

  async export(id: string): Promise<ExportReport> {
    const report = await exportSession(this.config, this.db, id)
    this.emit({ type: 'session', sessionId: id })
    return report
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

  async shutdown(): Promise<void> {
    for (const [id, rec] of this.recorders) {
      await rec.stop().catch(() => {})
      this.db.update(schema.sessions).set({ status: 'interrupted' })
        .where(eq(schema.sessions.id, id)).run()
    }
    this.recorders.clear()
  }
}

function latestMtime(dir: string): number | null {
  if (!fs.existsSync(dir)) return null
  let latest: number | null = null
  for (const f of fs.readdirSync(dir)) {
    const m = fs.statSync(path.join(dir, f)).mtimeMs
    if (latest == null || m > latest) latest = m
  }
  return latest
}
