import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ffprobeDuration, runFfmpeg } from './util.js'

/** Crash-safe mic capture: ffmpeg (avfoundation) writes numbered FLAC
 * segments; every finished segment is a complete valid file. One Recorder
 * instance per live recording run. */
export class Recorder {
  private child: ChildProcess | null = null
  private runStartMs = 0
  /** audio seconds that exist from previous runs (crash resume) */
  private priorDurationS = 0
  private stopping: Promise<void> | null = null

  constructor(
    private readonly segmentsDir: string,
    private readonly micDevice: string,
    private readonly segmentSeconds: number,
  ) {}

  /** Position on the audio timeline (gaps excluded), in seconds. */
  positionS(): number {
    const live = this.child ? (Date.now() - this.runStartMs) / 1000 : 0
    return this.priorDurationS + live
  }

  get running(): boolean {
    return this.child !== null
  }

  /** Start (or resume) capturing. Returns the index of the first new segment. */
  async start(): Promise<number> {
    if (this.child) throw new Error('recorder already running')
    fs.mkdirSync(this.segmentsDir, { recursive: true })
    const existing = listSegments(this.segmentsDir)
    this.priorDurationS = 0
    for (const seg of existing) {
      this.priorDurationS += await ffprobeDuration(seg).catch(() => 0)
    }
    const firstSegment = existing.length
    this.child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation', '-i', `:${this.micDevice}`,
      '-ac', '1', '-ar', '48000', '-c:a', 'flac',
      '-f', 'segment', '-segment_time', String(this.segmentSeconds),
      '-segment_start_number', String(firstSegment),
      '-reset_timestamps', '1',
      path.join(this.segmentsDir, '%04d.flac'),
    ], { stdio: ['pipe', 'ignore', 'pipe'] })

    let stderr = ''
    this.child.stderr?.on('data', (d) => { stderr += String(d) })
    this.runStartMs = Date.now()

    // Fail fast if ffmpeg can't open the device (permissions, bad index).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500)
      this.child!.once('exit', (code) => {
        clearTimeout(timer)
        this.child = null
        reject(new Error(`ffmpeg exited immediately (${code}): ${stderr.trim() || 'no output'}`))
      })
    })
    this.child?.removeAllListeners('exit')
    this.child?.once('exit', () => { this.child = null })
    return firstSegment
  }

  /** Graceful stop: 'q' on stdin finalizes the current segment; escalate if needed. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping ??= new Promise<void>((resolve) => {
      const done = () => {
        this.priorDurationS = this.positionS()
        this.child = null
        resolve()
      }
      child.once('exit', done)
      try { child.stdin?.write('q') } catch { /* already gone */ }
      setTimeout(() => child.kill('SIGINT'), 3000).unref()
      setTimeout(() => child.kill('SIGKILL'), 6000).unref()
    })
    await this.stopping
  }
}

export function listSegments(segmentsDir: string): string[] {
  if (!fs.existsSync(segmentsDir)) return []
  return fs.readdirSync(segmentsDir)
    .filter((f) => /^\d+\.flac$/.test(f))
    .sort()
    .map((f) => path.join(segmentsDir, f))
}

/** Audio seconds already on disk for an interrupted session. */
export async function segmentsDuration(segmentsDir: string): Promise<number> {
  let total = 0
  for (const seg of listSegments(segmentsDir)) {
    total += await ffprobeDuration(seg).catch(() => 0)
  }
  return total
}

/** Lossless FLAC→FLAC concat of all segments into recording.flac. */
export async function concatSegments(segmentsDir: string, outFile: string): Promise<number> {
  const segments = listSegments(segmentsDir)
  if (segments.length === 0) throw new Error('no segments to concatenate')
  const listFile = path.join(segmentsDir, 'concat.txt')
  fs.writeFileSync(listFile, segments.map((s) => `file '${s}'\n`).join(''))
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'flac', outFile])
  fs.unlinkSync(listFile)
  return ffprobeDuration(outFile)
}

/** Markers below the minimum duration are kept but flagged — auditable,
 * threshold-tweakable, never silently gone. */
export function markerFlag(startS: number, endS: number | null, minMs: number): 'ok' | 'discarded' {
  if (endS == null) return 'ok'
  return (endS - startS) * 1000 < minMs ? 'discarded' : 'ok'
}
