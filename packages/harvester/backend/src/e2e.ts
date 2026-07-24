import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { ffprobeDuration, openDb, runFfmpeg, schema } from '@workshop/harvester-core'
import type { Config } from './config.js'
import { OWNED_MARKER } from './export/notes.js'
import { HarvesterService } from './service.js'

const execFileP = promisify(execFile)

/** Same two-speaker dialogue the transcriber's e2e uses: digits, English
 * code-switching, alternating voices. */
const DIALOGUE = [
  'In 1984 begonnen we met het project, en de deadline was echt een moving target.',
  'Klopt, maar we hadden er toen al 42 procent van afgerond.',
  'Daarna kwam die complete rewrite, drie weken werk vanwege de technical debt.',
  'En toch bleef de business case gewoon overeind staan.',
]

/** File-injected e2e: synthesize a dialogue, plant it as an already-recorded
 * session with fake markers, then run the REAL pipeline — transcribe →
 * harvest → export into a temp vault — and assert the contract at each step.
 * The live mic is deliberately not part of this (doctor probes it). */
export async function runE2e(baseConfig: Config, opts: { noLlm: boolean }): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harvester-e2e-'))
  const config: Config = {
    ...baseConfig,
    dataDir: path.join(tmp, 'data'),
    vaultDir: path.join(tmp, 'vault'),
  }
  console.log(`e2e sandbox: ${tmp} (llm: ${opts.noLlm ? 'fixture' : baseConfig.model})`)

  let failed = false
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`[${ok ? 'ok ' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    failed ||= !ok
    return ok
  }

  try {
    // 1. synthesize + inject as a finalized session
    const { wav, turnEnds } = await synthesizeDialogue(tmp)
    const db = openDb(config.dataDir)
    const service = new HarvesterService(config, db)

    const sessionId = '2000-01-01-e2e0'
    const dir = path.join(config.dataDir, 'sessions', sessionId)
    fs.mkdirSync(dir, { recursive: true })
    await runFfmpeg(['-y', '-i', wav, '-ac', '1', '-ar', '48000', '-c:a', 'flac',
      path.join(dir, 'recording.flac')])
    const duration = await ffprobeDuration(path.join(dir, 'recording.flac'))

    db.insert(schema.sessions).values({
      id: sessionId, title: 'e2e', status: 'transcribing',
      createdAt: Date.now(), durationS: duration,
    }).run()
    const p1 = db.insert(schema.participants).values({ sessionId, name: 'Jim' }).returning().get()
    const p2 = db.insert(schema.participants).values({ sessionId, name: 'Jesse' }).returning().get()

    // markers over turns 1 and 3 (0-based), i.e. one per speaker; plus a
    // sub-minimum tap that must be stored but flagged discarded
    const markerSpans = [
      { start: turnEnds[0]! + 0.3, end: turnEnds[1]! - 0.3 },
      { start: turnEnds[2]! + 0.3, end: turnEnds[3]! - 0.3 },
    ]
    for (const m of markerSpans) {
      db.insert(schema.markers).values({
        sessionId, startS: m.start, endS: m.end, flag: 'ok', createdAt: Date.now(),
      }).run()
    }
    db.insert(schema.markers).values({
      sessionId, startS: 1.0, endS: 1.1, flag: 'discarded', createdAt: Date.now(),
    }).run()

    // 2. transcribe (real transcriber, mlx, diarize)
    console.log('transcribing (real pipeline, this takes a minute)…')
    await service.transcribeSession(sessionId)
    const afterTranscribe = db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId)).get()!
    if (!check('transcription reached labeling', afterTranscribe.status === 'labeling',
      afterTranscribe.error ?? afterTranscribe.status)) return finish()

    const speakers = db.select().from(schema.speakers)
      .where(eq(schema.speakers.sessionId, sessionId)).all()
    check(`two speakers detected (${speakers.map((s) => s.label).join(', ')})`,
      speakers.length === 2)

    // 3. label
    speakers.forEach((s, i) =>
      service.assignSpeaker(sessionId, s.label, i === 0 ? p1.id : p2.id))

    // 4. harvest
    await service.harvestSession(sessionId, { fixture: opts.noLlm })
    const snippets = db.select().from(schema.snippets)
      .where(eq(schema.snippets.sessionId, sessionId)).all()
    check(`harvest produced snippets (${snippets.length})`, snippets.length >= markerSpans.length)
    check('all snippets anchored (or explicitly flagged)',
      snippets.every((s) => s.anchored || s.status === 'proposed'))
    const markerSnippets = snippets.filter((s) => s.origin === 'marker')
    check(`marker snippets present (${markerSnippets.length}/${markerSpans.length})`,
      markerSnippets.length >= 1)

    // 5. accept everything anchored, export
    for (const s of snippets.filter((x) => x.anchored)) {
      service.updateSnippet(s.id, { status: 'accepted' })
    }
    const report = await service.export(sessionId)
    check(`export wrote ${report.exported} notes + ${report.clips} clips`,
      report.exported > 0 && report.clips > 0, report.warnings.join('; '))
    const folder = report.folder
    check('session.md exists', fs.existsSync(path.join(folder, 'session.md')))

    // 6. the projection contract: human text below the marker survives re-export
    const noteFile = fs.readdirSync(folder).find((f) => f.endsWith('.md') && f !== 'session.md')
    if (check('snippet note exists', noteFile != null)) {
      const notePath = path.join(folder, noteFile!)
      fs.appendFileSync(notePath, '\nMY PRECIOUS ANNOTATION\n')
      await service.export(sessionId)
      const after = fs.readFileSync(notePath, 'utf8')
      check('re-export preserves human region', after.includes('MY PRECIOUS ANNOTATION'))
      check('re-export regenerates owned region', after.includes(OWNED_MARKER))
    }

    return finish()
  } catch (err) {
    check('e2e run', false, String(err))
    return finish()
  }

  function finish(): number {
    console.log(failed ? 'e2e FAILED' : 'e2e passed')
    return failed ? 1 : 0
  }
}

async function synthesizeDialogue(tmp: string): Promise<{ wav: string; turnEnds: number[] }> {
  const voices = await pickDutchVoices()
  const silence = path.join(tmp, 'silence.wav')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.4', silence])

  const parts: string[] = []
  const turnEnds: number[] = []
  let clock = 0
  for (const [i, text] of DIALOGUE.entries()) {
    const aiff = path.join(tmp, `turn${i}.aiff`)
    const wav = path.join(tmp, `turn${i}.wav`)
    await execFileP('say', ['-v', voices[i % voices.length]!, '-o', aiff, text])
    await runFfmpeg(['-y', '-i', aiff, '-ar', '48000', '-ac', '1', wav])
    if (parts.length > 0) { parts.push(silence); clock += 0.4 }
    parts.push(wav)
    clock += await ffprobeDuration(wav)
    turnEnds.push(clock)
  }
  const list = path.join(tmp, 'concat.txt')
  fs.writeFileSync(list, parts.map((p) => `file '${p}'\n`).join(''))
  const out = path.join(tmp, 'sample.wav')
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out])
  return { wav: out, turnEnds }
}

async function pickDutchVoices(): Promise<string[]> {
  const { stdout } = await execFileP('say', ['-v', '?'])
  const voices: string[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(.+?)\s+nl_(?:NL|BE)\s/.exec(line)
    if (m) voices.push(m[1]!.trim())
  }
  if (voices.length >= 2) return voices.slice(0, 2)
  if (voices.length === 1) return voices
  throw new Error('no Dutch `say` voices installed (System Settings → Spoken Content)')
}
