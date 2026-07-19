import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { ffprobeDuration, openDb, schema } from '@workshop/harvester-core'
import {
  CallService, loadCallConfig, mixPcm, runSpeakingBot, synthesizeDialogue,
} from '@workshop/harvester-call'
import type { Config } from './config.js'
import { HarvesterService } from './service.js'
import { startServer } from './server.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The whole call loop minus human ears: a real room on the real media
 * stack, two headless bots speaking the say-synthesized dialogue (one voice
 * each), a toggle-mark and a hold-mark over the verified socket, one
 * mid-call drop — then assert track files, the merged attributed
 * transcript, the spans and the gap. Run it with the compose stack up and
 * the dev backend stopped (this listens on the webhook port itself). */
export async function runCallE2e(baseConfig: Config, opts: { noLlm: boolean }): Promise<number> {
  const callConfig = loadCallConfig()
  if (!callConfig) {
    console.error('LIVEKIT_URL is not set — start the media stack and export the call env first')
    return 2
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harvester-call-e2e-'))
  // the egress container can only write inside the shared data volume, so
  // the sandboxed data dir must live under the real HARVESTER_DATA_DIR
  const config: Config = {
    ...baseConfig,
    dataDir: fs.mkdtempSync(path.join(baseConfig.dataDir, 'call-e2e-')),
    vaultDir: path.join(tmp, 'vault'),
  }
  console.log(`call e2e sandbox: ${config.dataDir} (llm: ${opts.noLlm ? 'fixture' : baseConfig.model})`)

  let failed = false
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`[${ok ? 'ok ' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    failed ||= !ok
    return ok
  }
  const finish = () => {
    console.log(failed ? 'call e2e FAILED' : 'call e2e passed')
    return failed ? 1 : 0
  }

  const db = openDb(config.dataDir)
  const service = new HarvesterService(config, db)
  const call = new CallService(callConfig, config, db, {
    emit: (e) => service.events.emit('event', e),
    enterPipeline: (id) => service.harvestSession(id, { fixture: opts.noLlm }),
    transcribeSession: (id) => service.transcribeSession(id),
    discardSession: (id) => service.deleteSession(id),
  })

  try {
    // our own server on the webhook port — the dev backend must be stopped
    await startServer(config, service, call).catch((err) => {
      throw new Error(`cannot listen on :${config.port} — stop the dev backend first (${String(err)})`)
    })

    const { sessionId, links } = await call.startCall(`http://127.0.0.1:${config.port}`)
    console.log(`session ${sessionId}; synthesizing dialogue…`)
    const dialogue = await synthesizeDialogue(tmp)
    const tokenOf = (identity: string) =>
      new URL(links.find((l) => l.identity === identity)!.url).hash.slice(1)

    const { io } = await import('socket.io-client')
    const sockets = Object.fromEntries(['jim', 'jesse'].map((who) => [
      who, io(`http://127.0.0.1:${config.port}`, { auth: { token: tokenOf(who) } }),
    ]))

    console.log('bots joining + speaking…')
    const jim = await runSpeakingBot(callConfig.url, tokenOf('jim'), dialogue.pcm.get('jim')!)
    let jesse = await runSpeakingBot(callConfig.url, tokenOf('jesse'), dialogue.pcm.get('jesse')!)

    // jesse toggle-marks his 42%-turn; jim hold-marks his rewrite-turn
    const [, t2, t3] = dialogue.turns
    setTimeout(() => sockets.jesse!.emit('marker:down'), t2!.startS * 1000)
    setTimeout(() => sockets.jesse!.emit('marker:up', { mode: 'toggle' }), (t2!.endS + 0.3) * 1000)
    setTimeout(() => sockets.jim!.emit('marker:down'), (t3!.startS + 0.2) * 1000)
    setTimeout(() => sockets.jim!.emit('marker:up', { mode: 'hold' }), (t3!.endS + 0.2) * 1000)

    await Promise.all([jim.spoken, jesse.spoken])

    // the mid-call drop: jesse vanishes for 4s and rejoins (a gap + an
    // extra track segment), then the call ends
    console.log('dropping jesse (gap)…')
    await jesse.disconnect()
    await sleep(4000)
    jesse = await runSpeakingBot(callConfig.url, tokenOf('jesse'), dialogue.pcm.get('jesse')!)
    await sleep(3000)

    console.log('ending call…')
    await call.endCall(sessionId)
    await jesse.disconnect().catch(() => {})
    await jim.disconnect().catch(() => {})
    Object.values(sockets).forEach((s) => s.disconnect())

    console.log('waiting for finalize → ingest → harvest…')
    const deadline = Date.now() + 15 * 60_000
    let session = service.sessionDetail(sessionId).session
    while (session.status !== 'reviewing' && session.status !== 'failed') {
      if (Date.now() > deadline) throw new Error(`timed out in status ${session.status}`)
      await sleep(3000)
      session = service.sessionDetail(sessionId).session
    }
    if (!check('call flowed unattended to reviewing', session.status === 'reviewing',
      session.error ?? session.status)) return finish()

    const segments = db.select().from(schema.trackSegments)
      .where(eq(schema.trackSegments.sessionId, sessionId)).all()
    check(`two-plus track files (${segments.length})`, segments.length >= 2)
    check('every segment file is real audio', segments.every((s) => {
      const f = path.join(config.dataDir, 'sessions', sessionId, s.file)
      return fs.existsSync(f) && fs.statSync(f).size > 0
    }))
    check('jesse has multiple segments (rejoin after the drop)',
      segments.filter((s) => s.participant === 'jesse').length >= 2)

    const transcriptFile = path.join(config.dataDir, 'sessions', sessionId, 'transcript.json')
    const transcript = JSON.parse(fs.readFileSync(transcriptFile, 'utf8')) as {
      words: { text: string; speaker: string | null }[]
    }
    const spokenBy = (who: string) =>
      transcript.words.filter((w) => w.speaker === who).map((w) => w.text.toLowerCase()).join(' ')
    check('transcript attributes 1984-turn to jim', spokenBy('jim').includes('1984'))
    check('transcript attributes 42%-turn to jesse', /42/.test(spokenBy('jesse')))

    const markers = db.select().from(schema.markers)
      .where(eq(schema.markers.sessionId, sessionId)).all()
    check('hold mark recorded for jim',
      markers.some((m) => m.participant === 'jim' && m.mode === 'hold' && m.flag === 'ok'))
    check('toggle mark recorded for jesse',
      markers.some((m) => m.participant === 'jesse' && m.mode === 'toggle' && m.flag === 'ok'))

    const spans = db.select().from(schema.harvestSpans)
      .where(eq(schema.harvestSpans.sessionId, sessionId)).all()
    check(`harvest spans derived (${spans.length})`, spans.length >= 1)

    const gaps = db.select().from(schema.gaps)
      .where(eq(schema.gaps.sessionId, sessionId)).all()
    check('the drop produced a both/disconnected gap for jesse',
      gaps.some((g) => g.participant === 'jesse' && g.direction === 'both'))

    const master = path.join(config.dataDir, 'sessions', sessionId, 'recording.flac')
    const duration = await ffprobeDuration(master).catch(() => 0)
    check(`playback master playable (${duration.toFixed(1)}s)`, duration > 10)

    const insights = db.select().from(schema.insights)
      .where(eq(schema.insights.sessionId, sessionId)).all()
    check(`harvest produced insights (${insights.length})`, insights.length >= 1)
    check('marker insights link their harvest span',
      insights.filter((i) => i.origin === 'marker').every((i) => i.harvestSpanId != null))

    return finish()
  } catch (err) {
    check('call e2e run', false, String(err))
    return finish()
  }
}

/** The solo/table counterpart: one bot ('table' identity) speaks BOTH voices
 * of the dialogue, mixed onto a single track — simulating one mic picking up
 * two people — then asserts the room diarizes them back apart and the
 * session lands in `labeling` (not straight to `reviewing`, since diarized
 * speaker labels are anonymous until a human assigns them). */
export async function runTableE2e(baseConfig: Config, opts: { noLlm: boolean }): Promise<number> {
  const callConfig = loadCallConfig()
  if (!callConfig) {
    console.error('LIVEKIT_URL is not set — start the media stack and export the call env first')
    return 2
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harvester-table-e2e-'))
  const config: Config = {
    ...baseConfig,
    dataDir: fs.mkdtempSync(path.join(baseConfig.dataDir, 'table-e2e-')),
    vaultDir: path.join(tmp, 'vault'),
  }
  console.log(`table e2e sandbox: ${config.dataDir} (llm: ${opts.noLlm ? 'fixture' : baseConfig.model})`)

  let failed = false
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`[${ok ? 'ok ' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    failed ||= !ok
    return ok
  }
  const finish = () => {
    console.log(failed ? 'table e2e FAILED' : 'table e2e passed')
    return failed ? 1 : 0
  }

  const db = openDb(config.dataDir)
  const service = new HarvesterService(config, db)
  const call = new CallService(callConfig, config, db, {
    emit: (e) => service.events.emit('event', e),
    enterPipeline: (id) => service.harvestSession(id, { fixture: opts.noLlm }),
    transcribeSession: (id) => service.transcribeSession(id),
    discardSession: (id) => service.deleteSession(id),
  })

  try {
    await startServer(config, service, call).catch((err) => {
      throw new Error(`cannot listen on :${config.port} — stop the dev backend first (${String(err)})`)
    })

    const { sessionId, links } = await call.startRecording(`http://127.0.0.1:${config.port}`)
    console.log(`session ${sessionId}; synthesizing + mixing dialogue onto one track…`)
    const dialogue = await synthesizeDialogue(tmp)
    const tablePcm = path.join(tmp, 'table.s16le')
    await mixPcm([dialogue.pcm.get('jim')!, dialogue.pcm.get('jesse')!], tablePcm)
    const token = new URL(links[0]!.url).hash.slice(1)

    const { io } = await import('socket.io-client')
    const socket = io(`http://127.0.0.1:${config.port}`, { auth: { token } })

    console.log('bot joining + speaking (both voices, one track)…')
    const bot = await runSpeakingBot(callConfig.url, token, tablePcm)

    // one toggle-mark over jesse's 42%-turn
    const [, t2] = dialogue.turns
    setTimeout(() => socket.emit('marker:down'), t2!.startS * 1000)
    setTimeout(() => socket.emit('marker:up', { mode: 'toggle' }), (t2!.endS + 0.3) * 1000)

    await bot.spoken
    console.log('ending recording…')
    await call.endCall(sessionId)
    await bot.disconnect().catch(() => {})
    socket.disconnect()

    console.log('waiting for finalize → mix → diarized transcribe…')
    const deadline = Date.now() + 15 * 60_000
    let session = service.sessionDetail(sessionId).session
    while (session.status !== 'labeling' && session.status !== 'failed') {
      if (Date.now() > deadline) throw new Error(`timed out in status ${session.status}`)
      await sleep(3000)
      session = service.sessionDetail(sessionId).session
    }
    if (!check('recording flowed to labeling (diarized, not straight to reviewing)',
      session.status === 'labeling', session.error ?? session.status)) return finish()

    const segments = db.select().from(schema.trackSegments)
      .where(eq(schema.trackSegments.sessionId, sessionId)).all()
    check(`one identity, one track (${segments.length} segment(s))`,
      segments.length >= 1 && segments.every((s) => s.participant === 'table'))

    const speakers = db.select().from(schema.speakers)
      .where(eq(schema.speakers.sessionId, sessionId)).all()
    check(`diarization found 2+ speakers (${speakers.map((s) => s.label).join(', ')})`,
      speakers.length >= 2)

    const master = path.join(config.dataDir, 'sessions', sessionId, 'recording.flac')
    const duration = await ffprobeDuration(master).catch(() => 0)
    check(`playback master playable (${duration.toFixed(1)}s)`, duration > 5)

    // label the diarized speakers against real names, same as the human flow
    const p1 = db.insert(schema.participants).values({ sessionId, name: 'Jim' }).returning().get()
    const p2 = db.insert(schema.participants).values({ sessionId, name: 'Jesse' }).returning().get()
    speakers.forEach((s, i) => service.assignSpeaker(sessionId, s.label, i === 0 ? p1.id : p2.id))

    await service.harvestSession(sessionId, { fixture: opts.noLlm })
    const insights = db.select().from(schema.insights)
      .where(eq(schema.insights.sessionId, sessionId)).all()
    check(`harvest produced insights (${insights.length})`, insights.length >= 1)

    const markers = db.select().from(schema.markers)
      .where(eq(schema.markers.sessionId, sessionId)).all()
    check('toggle mark recorded', markers.some((m) => m.mode === 'toggle' && m.flag === 'ok'))

    return finish()
  } catch (err) {
    check('table e2e run', false, String(err))
    return finish()
  }
}
