import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  AccessToken, DirectFileOutput, EgressClient, EgressStatus, RoomServiceClient,
  TrackType, WebhookReceiver, type EgressInfo, type WebhookEvent,
} from 'livekit-server-sdk'
import {
  ffprobeDuration, loadTranscript, markerFlag, runFfmpeg, runTranscriber,
  sampleUtterances, schema, sessionDir, sessionIdFor, type CoreConfig, type Db,
} from '@workshop/harvester-core'
import type { CallConfig } from './config.js'
import { appendEvent, readEvents, type CallEvent } from './events.js'
import { deriveGapSpans } from './gaps.js'
import { mergeTrackTranscripts, type TrackTranscript } from './merge.js'

/** What the call package needs from its host (the harvester backend),
 * inverted so the dependency graph stays acyclic: backend → call → core. */
export interface CallHost {
  emit(event: { type: string; sessionId: string; [key: string]: unknown }): void
  /** Run the generic pipeline (harvest → reviewing) — called after ingest
   * has written transcript.json, recording.flac and pre-assigned speakers. */
  enterPipeline(sessionId: string): Promise<void>
  /** Diarized transcribe of recording.flac (already written by
   * mixPlaybackMaster) → unassigned speakers → status `labeling`. Used by
   * solo/table sessions instead of `enterPipeline`, since a single mic track
   * needs a human to label diarized speakers before harvesting. */
  transcribeSession(sessionId: string): Promise<void>
  /** Wipes a session's rows and files. Used when a call ends without anyone
   * ever having published audio — nothing was recorded, so there's nothing
   * worth leaving behind as a "failed" entry. */
  discardSession(sessionId: string): void
}

/** Two known users, no accounts: the link you were sent IS your identity. */
export const IDENTITIES = ['jim', 'jesse'] as const
/** A solo/table recording: one publisher, one mic, possibly several people
 * near it — diarized on ingest instead of per-track split. */
const SOLO_IDENTITY = 'table'
const DISPLAY_NAMES: Record<string, string> = { jim: 'Jim', jesse: 'Jesse', table: 'Recording' }
const TOKEN_TTL_S = 12 * 3600 // covers "shall we call tonight?"
/** a room that finished and saw no rejoin for this long ends the call */
const ROOM_FINISHED_GRACE_MS = 30 * 60_000
/** finalize waits this long for outstanding egresses to settle */
const EGRESS_SETTLE_TIMEOUT_MS = 90_000

export interface JoinLink {
  identity: string
  name: string
  url: string
}

interface EgressState {
  egressId: string
  trackSid: string
  participant: string
  /** absolute path of the ogg this egress writes */
  file: string
  /** provisional audio start (egress startedAt); refined at finalize */
  startedAtMs: number | null
  endedAtMs: number | null
  status: 'starting' | 'active' | 'ended' | 'failed'
  error?: string
}

interface ActiveCall {
  egresses: Map<string, EgressState>
  /** trackSid → participant identity, from track_published webhooks */
  trackOwner: Map<string, string>
  /** per-participant file counter (tracks/<identity>.<n>.ogg) */
  seq: Map<string, number>
  /** earliest egress start — the provisional t0 marks are stamped against */
  provisionalT0Ms: number | null
  endTimer: NodeJS.Timeout | null
  finalizing: boolean
}

/** All call-shaped logic lives here; the Fastify plugin and socket handlers
 * are thin adapters — the same pattern as HarvesterService. */
export class CallService {
  private readonly rooms: RoomServiceClient
  private readonly egress: EgressClient
  private readonly receiver: WebhookReceiver
  private readonly calls = new Map<string, ActiveCall>()
  /** `${sessionId}:${identity}` → open marker row id (one open span each) */
  private readonly openMarkers = new Map<string, number>()

  constructor(
    readonly config: CallConfig,
    readonly core: CoreConfig,
    readonly db: Db,
    readonly host: CallHost,
  ) {
    const httpUrl = config.url.replace(/^ws/, 'http')
    this.rooms = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret)
    this.egress = new EgressClient(httpUrl, config.apiKey, config.apiSecret)
    this.receiver = new WebhookReceiver(config.apiKey, config.apiSecret)
  }

  // ---- sessions & tokens ---------------------------------------------------

  /** One button: create the session and mint two labeled join links.
   * LiveKit room name = session id; rooms auto-create on first join. */
  async startCall(linkBase: string): Promise<{ sessionId: string; links: JoinLink[] }> {
    return this.createRoom(linkBase, 'call', IDENTITIES, 'Jim × Jesse (call)')
  }

  /** Same shape as `startCall`, one publisher: a mic at the table that may
   * pick up several people talking, diarized on ingest instead of split by
   * track. `origin` stays `local` — same meaning as the old avfoundation
   * path ("recorded at the table"), just a different capture mechanism. */
  async startRecording(linkBase: string): Promise<{ sessionId: string; links: JoinLink[] }> {
    return this.createRoom(linkBase, 'local', [SOLO_IDENTITY], 'Recording')
  }

  private async createRoom(
    linkBase: string, origin: 'call' | 'local', roster: readonly string[], title: string,
  ): Promise<{ sessionId: string; links: JoinLink[] }> {
    const id = sessionIdFor(new Date())
    this.db.insert(schema.sessions).values({
      id, title, status: 'calling', origin, createdAt: Date.now(),
    }).run()
    for (const identity of roster) {
      this.db.insert(schema.participants).values({
        sessionId: id, name: DISPLAY_NAMES[identity]!,
      }).run()
    }
    this.host.emit({ type: 'session', sessionId: id })
    return { sessionId: id, links: await this.links(id, linkBase) }
  }

  private rosterFor(session: { origin: string }): readonly string[] {
    return session.origin === 'call' ? IDENTITIES : [SOLO_IDENTITY]
  }

  /** Links can be re-requested while a call is open (fresh 12 h tokens —
   * they are minted, not stored). */
  async links(sessionId: string, linkBase: string): Promise<JoinLink[]> {
    const session = this.mustGet(sessionId)
    if (session.origin !== 'call' && session.origin !== 'local') {
      throw new Error('not a call or recording session')
    }
    const base = (this.config.publicUrl ?? linkBase).replace(/\/$/, '')
    return Promise.all(this.rosterFor(session).map(async (identity) => ({
      identity,
      name: DISPLAY_NAMES[identity]!,
      // token in the fragment: it never hits proxy logs
      url: `${base}/join/${sessionId}#${await this.mintToken(sessionId, identity)}`,
    })))
  }

  /** What the standalone /join page needs before connecting. */
  joinInfo(sessionId: string): { sessionId: string; title: string; status: string; livekitUrl: string } {
    const session = this.mustGet(sessionId)
    return {
      sessionId,
      title: session.title,
      status: session.status,
      livekitUrl: this.config.livekitPublicUrl,
    }
  }

  private async mintToken(sessionId: string, identity: string): Promise<string> {
    const at = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity,
      name: DISPLAY_NAMES[identity],
      ttl: TOKEN_TTL_S,
    })
    at.addGrant({
      room: sessionId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    })
    return at.toJwt()
  }

  // ---- webhooks → recording ------------------------------------------------

  /** Every LiveKit webhook lands here (validated with the SDK's receiver),
   * is appended raw to the session's events.jsonl, then drives egress
   * bookkeeping. Recording needs no client cooperation beyond joining. */
  async handleWebhook(rawBody: string, authHeader: string | undefined): Promise<void> {
    const event = await this.receiver.receive(rawBody, authHeader)
    const sessionId = event.room?.name ?? event.egressInfo?.roomName
    if (!sessionId) return
    const session = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId)).get()
    // rooms that aren't call/recording sessions (spikes, strays) are none of our business
    if (!session || (session.origin !== 'call' && session.origin !== 'local')) return

    this.logEvent(sessionId, webhookToEvent(event))
    if (session.status !== 'calling') return // late/duplicate deliveries after finalize

    switch (event.event) {
      case 'room_started': {
        const call = this.callState(sessionId)
        if (call.endTimer) { // rejoin within the grace period: call continues
          clearTimeout(call.endTimer)
          call.endTimer = null
        }
        break
      }
      case 'participant_joined':
      case 'participant_left': {
        if (!isEgressIdentity(event.participant?.identity)) {
          this.host.emit({
            type: 'call', sessionId,
            event: event.event, participant: event.participant?.identity,
          })
        }
        break
      }
      case 'track_published': {
        const identity = event.participant?.identity
        const track = event.track
        if (!identity || !track || isEgressIdentity(identity)) break
        if (track.type !== TrackType.AUDIO) break
        this.callState(sessionId).trackOwner.set(track.sid, identity)
        await this.startTrackEgress(sessionId, identity, track.sid)
        break
      }
      case 'egress_started':
      case 'egress_updated':
      case 'egress_ended': {
        if (event.egressInfo) this.updateEgress(sessionId, event.egressInfo)
        break
      }
      case 'room_finished': {
        // no one pressed End: give reconnects 30 min, then finalize
        const call = this.callState(sessionId)
        call.endTimer ??= setTimeout(() => {
          this.logEvent(sessionId, { atMs: Date.now(), type: 'auto_end' })
          void this.finalize(sessionId)
        }, ROOM_FINISHED_GRACE_MS)
        break
      }
    }
  }

  private async startTrackEgress(sessionId: string, identity: string, trackSid: string): Promise<void> {
    const call = this.callState(sessionId)
    const already = [...call.egresses.values()]
      .some((e) => e.trackSid === trackSid && e.status !== 'failed')
    if (already) return // duplicate webhook / resync overlap
    const n = (call.seq.get(identity) ?? 0) + 1
    call.seq.set(identity, n)
    const rel = `tracks/${identity}.${n}.ogg`
    const abs = path.join(this.dir(sessionId), rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    try {
      const info = await this.egress.startTrackEgress(
        sessionId, new DirectFileOutput({ filepath: abs }), trackSid)
      call.egresses.set(info.egressId, {
        egressId: info.egressId, trackSid, participant: identity,
        file: abs, startedAtMs: null, endedAtMs: null, status: 'starting',
      })
      this.logEvent(sessionId, {
        atMs: Date.now(), type: 'egress_requested',
        egressId: info.egressId, participant: identity, trackSid, file: rel,
      })
    } catch (err) {
      // recording is the point — a track we cannot record fails the session
      this.logEvent(sessionId, {
        atMs: Date.now(), type: 'egress_request_failed',
        participant: identity, trackSid, error: String(err),
      })
      this.fail(sessionId, `could not start egress for ${identity}: ${String(err)}`)
    }
  }

  private updateEgress(sessionId: string, info: EgressInfo): void {
    const call = this.callState(sessionId)
    let st = call.egresses.get(info.egressId)
    if (!st) {
      // state lost (crash between request and webhook): rebuild what we can
      const trackSid = trackSidOf(info)
      st = {
        egressId: info.egressId,
        trackSid,
        participant: call.trackOwner.get(trackSid) ?? 'unknown',
        file: fileOf(info) ?? '',
        startedAtMs: null, endedAtMs: null, status: 'starting',
      }
      call.egresses.set(info.egressId, st)
    }
    if (info.startedAt && Number(info.startedAt) > 0) {
      st.startedAtMs = Number(info.startedAt) / 1e6
      call.provisionalT0Ms = Math.min(call.provisionalT0Ms ?? Infinity, st.startedAtMs)
    }
    st.file ||= fileOf(info) ?? ''
    switch (info.status) {
      case EgressStatus.EGRESS_ACTIVE:
        st.status = 'active'
        break
      case EgressStatus.EGRESS_COMPLETE:
        st.status = 'ended'
        st.endedAtMs = Number(info.endedAt) / 1e6
        break
      case EgressStatus.EGRESS_FAILED:
      case EgressStatus.EGRESS_ABORTED:
      case EgressStatus.EGRESS_LIMIT_REACHED:
        st.status = 'failed'
        st.error = info.error || `egress status ${info.status}`
        break
    }
  }

  // ---- marks ---------------------------------------------------------------

  /** Server-stamped mark edges. Attribution comes only from the verified
   * socket handshake — these methods are never fed claimed identities. */
  markDown(sessionId: string, participant: string): void {
    const session = this.mustGet(sessionId)
    if (session.status !== 'calling') return
    const key = `${sessionId}:${participant}`
    if (this.openMarkers.has(key)) return // at most one open span each
    const row = this.db.insert(schema.markers).values({
      sessionId,
      participant,
      startS: this.positionS(sessionId),
      createdAt: Date.now(),
    }).returning().get()
    this.openMarkers.set(key, row.id)
    this.host.emit({ type: 'marker', sessionId, marker: row })
  }

  markUp(sessionId: string, participant: string, mode: 'hold' | 'toggle' | null): void {
    const key = `${sessionId}:${participant}`
    const markerId = this.openMarkers.get(key)
    if (markerId == null) return
    this.openMarkers.delete(key)
    const marker = this.db.select().from(schema.markers)
      .where(eq(schema.markers.id, markerId)).get()
    if (!marker) return
    const endS = this.positionS(sessionId)
    const row = this.db.update(schema.markers).set({
      endS,
      mode,
      flag: markerFlag(marker.startS, endS, this.config.markerMinMs),
    }).where(eq(schema.markers.id, markerId)).returning().get()
    this.host.emit({ type: 'marker', sessionId, marker: row })
  }

  /** Offline-queued edges flushed on reconnect: client epoch times, flagged
   * client-stamped — best effort, since a mark during a gap is already
   * suspect. */
  flushQueuedMarks(
    sessionId: string,
    participant: string,
    edges: { kind: 'down' | 'up'; atMs: number; mode?: 'hold' | 'toggle' | null }[],
  ): void {
    const session = this.mustGet(sessionId)
    if (session.status !== 'calling') return
    const t0 = this.calls.get(sessionId)?.provisionalT0Ms
    if (t0 == null) return
    const key = `${sessionId}:${participant}`
    for (const edge of edges.slice(0, 200)) {
      const atS = Math.max(0, (Number(edge.atMs) - t0) / 1000)
      if (edge.kind === 'down') {
        if (this.openMarkers.has(key)) continue
        const row = this.db.insert(schema.markers).values({
          sessionId, participant, startS: atS, stampedBy: 'client', createdAt: Date.now(),
        }).returning().get()
        this.openMarkers.set(key, row.id)
      } else {
        const markerId = this.openMarkers.get(key)
        if (markerId == null) continue
        this.openMarkers.delete(key)
        const marker = this.db.select().from(schema.markers)
          .where(eq(schema.markers.id, markerId)).get()
        if (!marker) continue
        this.db.update(schema.markers).set({
          endS: atS,
          mode: edge.mode ?? null,
          stampedBy: 'client',
          flag: markerFlag(marker.startS, atS, this.config.markerMinMs),
        }).where(eq(schema.markers.id, markerId)).run()
      }
    }
    this.host.emit({ type: 'session', sessionId })
  }

  /** Spans still open at call end auto-close with the existing `unclosed`
   * flag (forgotten toggles stay harvestable; review derives the attention
   * flag from the length). */
  private closeOpenMarkers(sessionId: string, endS: number): void {
    for (const [key, markerId] of this.openMarkers) {
      if (!key.startsWith(`${sessionId}:`)) continue
      this.openMarkers.delete(key)
      this.db.update(schema.markers).set({ endS, flag: 'unclosed' })
        .where(eq(schema.markers.id, markerId)).run()
    }
  }

  // ---- ending & finalize -----------------------------------------------------

  /** End call (the button): delete the room — clients disconnect, egresses
   * self-terminate — then finalize. */
  async endCall(sessionId: string): Promise<void> {
    const session = this.mustGet(sessionId)
    if (session.status !== 'calling') throw new Error('call is not open')
    this.logEvent(sessionId, { atMs: Date.now(), type: 'end_call' })
    await this.rooms.deleteRoom(sessionId).catch(() => {}) // room may already be gone
    void this.finalize(sessionId)
  }

  /** Wait for outstanding egresses, verify every one landed a readable
   * file, write track_segments anchored to t0, then hand over to ingest.
   * A missing or failed egress fails the session — never silently partial. */
  async finalize(sessionId: string): Promise<void> {
    const call = this.callState(sessionId)
    if (call.finalizing) return
    call.finalizing = true
    if (call.endTimer) { clearTimeout(call.endTimer); call.endTimer = null }
    this.setStatus(sessionId, 'transcribing')

    try {
      await this.awaitEgressesSettled(sessionId, call)

      if (call.egresses.size === 0) {
        // no participant ever published audio — no one was actually in the
        // room, so this call leaves no trace rather than a "failed" entry
        this.logEvent(sessionId, { atMs: Date.now(), type: 'discarded_empty' })
        this.calls.delete(sessionId)
        this.host.discardSession(sessionId)
        return
      }

      const failed = [...call.egresses.values()].filter((e) => e.status === 'failed')
      const dangling = [...call.egresses.values()]
        .filter((e) => e.status === 'starting' || e.status === 'active')
      if (failed.length > 0 || dangling.length > 0) {
        const parts = [
          ...failed.map((e) => `egress ${e.egressId} (${e.participant}) failed: ${e.error}`),
          ...dangling.map((e) => `egress ${e.egressId} (${e.participant}) never ended`),
        ]
        throw new Error(parts.join('; '))
      }

      const ended = [...call.egresses.values()].filter((e) => e.status === 'ended')
      if (ended.length === 0) throw new Error('call produced no recordings')

      // verify + measure every file, then anchor: audio starts at
      // endedAt − duration (spike NOTES §3); t0 = earliest start
      const measured: { e: EgressState; durationS: number; startMs: number }[] = []
      for (const e of ended) {
        if (!e.file || !fs.existsSync(e.file)) {
          throw new Error(`egress ${e.egressId} (${e.participant}) left no file at ${e.file || '<unknown>'}`)
        }
        const durationS = await ffprobeDuration(e.file).catch((err) => {
          throw new Error(`egress file unreadable: ${e.file} (${String(err)})`)
        })
        if (!(durationS > 0)) throw new Error(`egress file has no audio: ${e.file}`)
        const endedAtMs = e.endedAtMs ?? fs.statSync(e.file).mtimeMs // resync fallback
        measured.push({ e, durationS, startMs: endedAtMs - durationS * 1000 })
      }
      const t0Ms = Math.min(...measured.map((m) => m.startMs))

      this.db.delete(schema.trackSegments)
        .where(eq(schema.trackSegments.sessionId, sessionId)).run() // idempotent
      for (const m of measured) {
        this.db.insert(schema.trackSegments).values({
          sessionId,
          participant: m.e.participant,
          file: path.relative(this.dir(sessionId), m.e.file),
          startS: (m.startMs - t0Ms) / 1000,
          durationS: m.durationS,
          egressId: m.e.egressId,
        }).run()
      }

      const durationS = Math.max(...measured.map((m) => (m.startMs - t0Ms) / 1000 + m.durationS))

      // marks were stamped against the provisional t0 (egress startedAt);
      // shift them onto the refined timeline, then close forgotten spans
      this.shiftMarkers(sessionId, ((call.provisionalT0Ms ?? t0Ms) - t0Ms) / 1000)
      this.closeOpenMarkers(sessionId, durationS)

      this.deriveGaps(sessionId, t0Ms, t0Ms + durationS * 1000)

      this.db.update(schema.sessions).set({ durationS })
        .where(eq(schema.sessions.id, sessionId)).run()

      this.logEvent(sessionId, { atMs: Date.now(), type: 'finalized', t0Ms, segments: measured.length })
      this.calls.delete(sessionId)
      this.host.emit({ type: 'session', sessionId })
      const session = this.mustGet(sessionId)
      if (session.origin === 'call') void this.ingest(sessionId)
      else void this.ingestRecording(sessionId)
    } catch (err) {
      this.fail(sessionId, `call finalize failed: ${String(err)}`)
    }
  }

  /** Solo/table counterpart to `ingest`: one mic track (possibly several
   * segments across reconnects) mixed into the normal playback master, then
   * handed to the host's diarized-transcribe path — no per-track merge,
   * since there is only one track and it may hold several speakers. */
  private async ingestRecording(sessionId: string): Promise<void> {
    try {
      const segments = this.db.select().from(schema.trackSegments)
        .where(eq(schema.trackSegments.sessionId, sessionId)).all()
        .sort((a, b) => a.startS - b.startS)
      if (segments.length === 0) throw new Error('no track segments to ingest')
      this.emitPipeline(sessionId, 'mixing playback master…')
      await this.mixPlaybackMaster(sessionId, segments)
      await this.host.transcribeSession(sessionId)
    } catch (err) {
      this.fail(sessionId, `recording ingest failed: ${String(err)}`)
    }
  }

  /** Egresses settle on their own (the spike confirmed self-termination on
   * unpublish/disconnect) — but never trust an immediate list; poll until
   * nothing is starting/active, merging server state into ours. */
  private async awaitEgressesSettled(sessionId: string, call: ActiveCall): Promise<void> {
    const deadline = Date.now() + EGRESS_SETTLE_TIMEOUT_MS
    for (;;) {
      const infos = await this.egress.listEgress({ roomName: sessionId }).catch(() => [])
      for (const info of infos) this.updateEgress(sessionId, info)
      const busy = [...call.egresses.values()]
        .filter((e) => e.status === 'starting' || e.status === 'active')
      if (busy.length === 0) return
      if (Date.now() > deadline) return // dangling ones are reported by finalize
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  /** Marks are stamped live against the provisional t0; the refined t0 is
   * only known at finalize. deltaS = provisional − refined. */
  private shiftMarkers(sessionId: string, deltaS: number): void {
    if (Math.abs(deltaS) < 0.001) return
    const rows = this.db.select().from(schema.markers)
      .where(eq(schema.markers.sessionId, sessionId)).all()
    for (const m of rows) {
      this.db.update(schema.markers).set({
        startS: Math.max(0, m.startS + deltaS),
        endS: m.endS != null ? Math.max(0, m.endS + deltaS) : null,
      }).where(eq(schema.markers.id, m.id)).run()
    }
  }

  /** Reduce events.jsonl to gaps rows. Purely additive: with no events the
   * pipeline degrades to today's behavior. */
  private deriveGaps(sessionId: string, t0Ms: number, endMs: number): void {
    const spans = deriveGapSpans(readEvents(this.dir(sessionId)), t0Ms, endMs)
    this.db.delete(schema.gaps).where(eq(schema.gaps.sessionId, sessionId)).run() // idempotent
    for (const s of spans) {
      this.db.insert(schema.gaps).values({ sessionId, ...s }).run()
    }
  }

  // ---- ingest ----------------------------------------------------------------

  /** Per-track transcription (no diarization — track identity IS the
   * speaker), the pure merge into one attributed transcript.json, the
   * mixed playback master, pre-assigned speakers, then hand the session to
   * the generic pipeline (auto-harvest → reviewing). Re-runnable. */
  async ingest(sessionId: string): Promise<void> {
    const session = this.mustGet(sessionId)
    if (session.origin !== 'call') throw new Error('not a call session')
    this.setStatus(sessionId, 'transcribing')
    const dir = this.dir(sessionId)
    try {
      const segments = this.db.select().from(schema.trackSegments)
        .where(eq(schema.trackSegments.sessionId, sessionId)).all()
        .sort((a, b) => a.startS - b.startS)
      if (segments.length === 0) throw new Error('no track segments to ingest')

      // sequential on purpose: the transcriber saturates the machine
      const tracks: TrackTranscript[] = []
      for (const seg of segments) {
        const ogg = path.join(dir, seg.file)
        const wav = `${ogg}.16k.wav`
        const out = `${ogg}.transcript.json`
        this.emitPipeline(sessionId, `transcribing ${seg.file}…`)
        try {
          // segments are transcribed as recorded — never silence-padded, so
          // Whisper gets no dead air to hallucinate into
          await runFfmpeg(['-y', '-i', ogg, '-ac', '1', '-ar', '16000', wav])
          await runTranscriber(this.core, wav, out,
            (line) => this.emitPipeline(sessionId, line), { diarize: false })
        } finally {
          fs.rmSync(wav, { force: true }) // derived WAVs are temporary
        }
        tracks.push({
          participant: seg.participant,
          offsetS: seg.startS,
          transcript: loadTranscript(out),
        })
      }

      const durationS = session.durationS
        ?? Math.max(...segments.map((s) => s.startS + s.durationS))
      const transcript = mergeTrackTranscripts(tracks, durationS)
      fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript))

      this.emitPipeline(sessionId, 'mixing playback master…')
      await this.mixPlaybackMaster(sessionId, segments)

      this.storeSpeakers(sessionId, transcript)

      // auto-harvest: the session flows unattended into reviewing
      await this.host.enterPipeline(sessionId)
    } catch (err) {
      this.fail(sessionId, `call ingest failed: ${String(err)}`)
    }
  }

  /** recording.flac: each track padded to the timeline and mixed to 48 kHz
   * mono — review playback and clip export work exactly as today. */
  private async mixPlaybackMaster(
    sessionId: string,
    segments: { file: string; startS: number }[],
  ): Promise<void> {
    const dir = this.dir(sessionId)
    const inputs = segments.flatMap((s) => ['-i', path.join(dir, s.file)])
    const delays = segments
      .map((s, i) => `[${i}:a]adelay=${Math.round(s.startS * 1000)}:all=1[a${i}]`)
      .join(';')
    const mix = segments.map((_, i) => `[a${i}]`).join('')
      + `amix=inputs=${segments.length}:duration=longest:normalize=0[out]`
    await runFfmpeg([
      '-y', ...inputs,
      '-filter_complex', `${delays};${mix}`,
      '-map', '[out]', '-ac', '1', '-ar', '48000', '-c:a', 'flac',
      path.join(dir, 'recording.flac'),
    ])
  }

  /** Speakers arrive pre-assigned from track identities — the labeling
   * stage never surfaces for calls; review still reads these rows. */
  private storeSpeakers(sessionId: string, transcript: ReturnType<typeof mergeTrackTranscripts>): void {
    const participants = this.db.select().from(schema.participants)
      .where(eq(schema.participants.sessionId, sessionId)).all()
    const byName = new Map(participants.map((p) => [p.name.toLowerCase(), p.id]))
    this.db.delete(schema.speakers).where(eq(schema.speakers.sessionId, sessionId)).run()
    const samples = sampleUtterances(transcript)
    const identities = [...new Set(transcript.words.map((w) => w.speaker).filter((s): s is string => !!s))]
    for (const identity of identities) {
      const sample = samples.get(identity)
      this.db.insert(schema.speakers).values({
        sessionId,
        label: identity,
        participantId: byName.get(identity.toLowerCase()) ?? null,
        sampleStartS: sample?.start ?? null,
        sampleEndS: sample?.end ?? null,
        sampleText: sample?.text.trim() ?? null,
      }).run()
    }
  }

  private emitPipeline(sessionId: string, line: string): void {
    this.host.emit({ type: 'pipeline', sessionId, line })
  }

  // ---- crash recovery --------------------------------------------------------

  /** Backend crash mid-call (or mid solo-recording) is survivable by
   * construction: rooms and egresses live in the LiveKit containers. On
   * boot, rebuild in-memory state for every `calling` session from
   * events.jsonl + the server API; finalize sessions whose room died while
   * we were down. */
  async resyncActiveCalls(): Promise<void> {
    const calling = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.status, 'calling')).all()
      .filter((s) => s.origin === 'call' || s.origin === 'local')
    for (const session of calling) {
      try {
        await this.resyncCall(session.id)
      } catch (err) {
        this.fail(session.id, `call re-sync failed: ${String(err)}`)
      }
    }
  }

  private async resyncCall(sessionId: string): Promise<void> {
    const call = this.callState(sessionId)
    // events.jsonl is the crash-safe record of who owned which track and
    // which egresses we requested
    for (const ev of readEvents(this.dir(sessionId))) {
      if (ev.type === 'track_published' && ev.trackSid && ev.participant) {
        call.trackOwner.set(ev.trackSid, ev.participant)
      }
      if (ev.type === 'egress_requested' && ev.egressId && ev.trackSid && ev.participant) {
        call.egresses.set(ev.egressId, {
          egressId: ev.egressId,
          trackSid: ev.trackSid,
          participant: ev.participant,
          file: path.join(this.dir(sessionId), String(ev.file ?? '')),
          startedAtMs: null, endedAtMs: null, status: 'starting',
        })
        const n = Number(/\.(\d+)\.ogg$/.exec(String(ev.file ?? ''))?.[1] ?? 0)
        call.seq.set(ev.participant, Math.max(call.seq.get(ev.participant) ?? 0, n))
      }
      if (ev.type === 'egress_started' && ev.startedAtMs) {
        call.provisionalT0Ms = Math.min(call.provisionalT0Ms ?? Infinity, Number(ev.startedAtMs))
      }
    }
    const infos = await this.egress.listEgress({ roomName: sessionId }).catch(() => [])
    for (const info of infos) this.updateEgress(sessionId, info)

    const rooms = await this.rooms.listRooms([sessionId]).catch(() => [])
    if (rooms.length === 0) {
      // the room died while we were down — the missed room_finished means
      // the call is over; finalize with what was recorded
      this.logEvent(sessionId, { atMs: Date.now(), type: 'resync_finalize' })
      void this.finalize(sessionId)
      return
    }

    // room is alive: catch up on tracks published while we were down
    this.logEvent(sessionId, { atMs: Date.now(), type: 'resync_attached' })
    const participants = await this.rooms.listParticipants(sessionId).catch(() => [])
    for (const p of participants) {
      if (isEgressIdentity(p.identity)) continue
      for (const track of p.tracks) {
        if (track.type !== TrackType.AUDIO) continue
        call.trackOwner.set(track.sid, p.identity)
        await this.startTrackEgress(sessionId, p.identity, track.sid)
      }
    }
  }

  // ---- helpers -----------------------------------------------------------------

  /** Timeline position (seconds since provisional t0) for live mark
   * stamping; 0 until the first egress is running. */
  positionS(sessionId: string): number {
    const t0 = this.calls.get(sessionId)?.provisionalT0Ms
    return t0 == null ? 0 : Math.max(0, (Date.now() - t0) / 1000)
  }

  logEvent(sessionId: string, event: CallEvent): void {
    appendEvent(this.dir(sessionId), event)
  }

  private dir(sessionId: string): string {
    return sessionDir(this.core, sessionId)
  }

  private callState(sessionId: string): ActiveCall {
    let call = this.calls.get(sessionId)
    if (!call) {
      call = {
        egresses: new Map(), trackOwner: new Map(), seq: new Map(),
        provisionalT0Ms: null, endTimer: null, finalizing: false,
      }
      this.calls.set(sessionId, call)
    }
    return call
  }

  protected mustGet(id: string) {
    const session = this.db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, id)).get()
    if (!session) throw new Error(`unknown session: ${id}`)
    return session
  }

  protected setStatus(id: string, status: string): void {
    this.db.update(schema.sessions).set({ status, error: null })
      .where(eq(schema.sessions.id, id)).run()
    this.host.emit({ type: 'session', sessionId: id })
  }

  protected fail(id: string, error: string): void {
    this.db.update(schema.sessions).set({ status: 'failed', error })
      .where(eq(schema.sessions.id, id)).run()
    this.host.emit({ type: 'session', sessionId: id })
  }
}

function isEgressIdentity(identity: string | undefined): boolean {
  return identity != null && identity.startsWith('EG_')
}

/** Flatten a webhook into an events.jsonl line (raw epoch-ms audit). */
function webhookToEvent(event: WebhookEvent): CallEvent {
  return {
    atMs: Date.now(),
    createdAtMs: Number(event.createdAt) * 1000,
    type: event.event,
    participant: event.participant?.identity,
    participantKind: event.participant ? String(event.participant.kind) : undefined,
    trackSid: event.track?.sid,
    egressId: event.egressInfo?.egressId,
    egressStatus: event.egressInfo ? String(event.egressInfo.status) : undefined,
    startedAtMs: event.egressInfo?.startedAt && Number(event.egressInfo.startedAt) > 0
      ? Number(event.egressInfo.startedAt) / 1e6 : undefined,
    endedAtMs: event.egressInfo?.endedAt && Number(event.egressInfo.endedAt) > 0
      ? Number(event.egressInfo.endedAt) / 1e6 : undefined,
  }
}

function trackSidOf(info: EgressInfo): string {
  return info.request.case === 'track' ? info.request.value.trackId : ''
}

function fileOf(info: EgressInfo): string | null {
  const first = info.fileResults?.[0]?.filename
  if (first) return first
  if (info.request.case === 'track' && info.request.value.output.case === 'file') {
    return info.request.value.output.value.filepath
  }
  return null
}
