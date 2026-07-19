import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Headless test participants for `e2e --call` and manual poking: speak a
 * say-synthesized dialogue into a LiveKit room, one voice per identity.
 * `@livekit/rtc-node` is a devDependency — this module is only ever loaded
 * by test/e2e code paths, never by `serve`. */

export interface DialogueTurn {
  who: string
  text: string
  startS: number
  endS: number
}

export interface SynthesizedDialogue {
  /** identity → raw 48 kHz mono s16le PCM file covering the full timeline */
  pcm: Map<string, string>
  turns: DialogueTurn[]
  totalS: number
}

/** Same two-speaker dialogue the local e2e uses: digits, English
 * code-switching, alternating voices. */
const DIALOGUE: [who: string, text: string][] = [
  ['jim', 'In 1984 begonnen we met het project, en de deadline was echt een moving target.'],
  ['jesse', 'Klopt, maar we hadden er toen al 42 procent van afgerond.'],
  ['jim', 'Daarna kwam die complete rewrite, drie weken werk vanwege de technical debt.'],
  ['jesse', 'En toch bleef de business case gewoon overeind staan.'],
]

const TURN_GAP_S = 0.4
const LEAD_IN_S = 1.0

export async function synthesizeDialogue(tmpDir: string): Promise<SynthesizedDialogue> {
  const voices = await pickDutchVoices()
  const voiceOf = new Map([['jim', voices[0]!], ['jesse', voices[1] ?? voices[0]!]])

  let clock = LEAD_IN_S
  const turns: (DialogueTurn & { wav: string })[] = []
  for (const [i, [who, text]] of DIALOGUE.entries()) {
    const aiff = path.join(tmpDir, `turn${i}.aiff`)
    const wav = path.join(tmpDir, `turn${i}.wav`)
    await execFileP('say', ['-v', voiceOf.get(who)!, '-o', aiff, text])
    await ff(['-y', '-i', aiff, '-ar', '48000', '-ac', '1', wav])
    const d = await ffprobeDur(wav)
    turns.push({ who, text, wav, startS: clock, endS: clock + d })
    clock += d + TURN_GAP_S
  }
  const totalS = clock + 1.0

  const pcm = new Map<string, string>()
  for (const who of new Set(turns.map((t) => t.who))) {
    const own = turns.filter((t) => t.who === who)
    const out = path.join(tmpDir, `${who}.s16le`)
    const inputs = own.flatMap((t) => ['-i', t.wav])
    const delays = own.map((t, i) => `[${i}:a]adelay=${Math.round(t.startS * 1000)}:all=1[a${i}]`).join(';')
    const mix = own.map((_, i) => `[a${i}]`).join('')
      + `amix=inputs=${own.length}:duration=longest:normalize=0[m]`
    await ff(['-y', ...inputs, '-filter_complex', `${delays};${mix}`,
      '-map', '[m]', '-ar', '48000', '-ac', '1', '-f', 's16le', out])
    pcm.set(who, out)
  }
  return { pcm, turns, totalS }
}

/** Mix several raw s16le 48 kHz mono PCM timelines into one — used by the
 * table e2e to simulate one mic picking up several people (the per-identity
 * tracks from `synthesizeDialogue` don't overlap in time, so this is a clean
 * combine, not a lossy one). */
export async function mixPcm(pcmFiles: string[], outFile: string): Promise<void> {
  const inputs = pcmFiles.flatMap((f) => ['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', f])
  await ff([...inputs, '-filter_complex',
    `amix=inputs=${pcmFiles.length}:duration=longest:normalize=0`,
    '-ar', '48000', '-ac', '1', '-f', 's16le', outFile])
}

export interface SpeakingBot {
  /** resolves when the PCM file has been fully streamed */
  spoken: Promise<void>
  disconnect(): Promise<void>
}

/** Join and stream a PCM timeline file as the bot's microphone. */
export async function runSpeakingBot(wsUrl: string, token: string, pcmFile: string): Promise<SpeakingBot> {
  const { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } =
    await import('@livekit/rtc-node')
  const room = new Room()
  await room.connect(wsUrl, token, { autoSubscribe: true, dynacast: false })
  const source = new AudioSource(48000, 1)
  const track = LocalAudioTrack.createAudioTrack('mic', source)
  await room.localParticipant!.publishTrack(
    track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
  const raw = fs.readFileSync(pcmFile)
  const frameSamples = 480 // 10 ms
  const spoken = (async () => {
    for (let off = 0; off + frameSamples * 2 <= raw.length; off += frameSamples * 2) {
      // .slice(): AudioFrame reads the backing buffer from offset 0, so
      // a plain subarray view would send the first frame forever
      const data = new Int16Array(raw.buffer, raw.byteOffset + off, frameSamples).slice()
      await source.captureFrame(new AudioFrame(data, 48000, 1, frameSamples))
    }
  })()
  return { spoken, disconnect: () => room.disconnect() }
}

async function ff(args: string[]): Promise<void> {
  await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args])
}

async function ffprobeDur(file: string): Promise<number> {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file])
  return Number(stdout.trim())
}

async function pickDutchVoices(): Promise<string[]> {
  const { stdout } = await execFileP('say', ['-v', '?'])
  const voices: string[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(.+?)\s+nl_(?:NL|BE)\s/.exec(line)
    if (m) voices.push(m[1]!.trim())
  }
  if (voices.length === 0) throw new Error('no Dutch `say` voices installed (System Settings → Spoken Content)')
  return voices
}
