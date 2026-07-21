import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

export const execFileP = promisify(execFile)

export function sessionIdFor(date: Date): string {
  const day = date.toISOString().slice(0, 10)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${day}-${suffix}`
}

export function slugify(text: string, max = 60): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug || 'untitled'
}

export async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ])
  const d = Number(stdout.trim())
  if (!Number.isFinite(d)) throw new Error(`ffprobe returned no duration for ${file}`)
  return d
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)))
  })
}

/** Server-side loudness waveform for the SoundCloud-style full-session
 * scrubber: decode to raw mono PCM at a throwaway-low sample rate (loudness
 * needs no fidelity, just enough samples per bucket to average) via ffmpeg,
 * then per-bucket RMS normalized against the loudest bucket in the file.
 * Fixed bucket count regardless of duration — the caller resamples down to
 * however many bars actually fit on screen. Caching (so this doesn't rerun
 * per request) is the caller's job, not this function's. */
export async function computePeaks(audioFile: string, buckets = 800): Promise<number[]> {
  const tmp = path.join(os.tmpdir(),
    `peaks-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pcm`)
  try {
    // 8kHz mono s16le: plenty of samples per bucket for an RMS average even
    // at ~800 buckets over a multi-hour recording, and a fraction of the
    // decode cost of the original sample rate.
    await runFfmpeg(['-y', '-i', audioFile, '-ac', '1', '-ar', '8000', '-f', 's16le', tmp])
    const buf = fs.readFileSync(tmp)
    const sampleCount = Math.floor(buf.length / 2) // 2 bytes/sample (s16le)
    const raw = new Array<number>(buckets).fill(0)
    for (let b = 0; b < buckets; b++) {
      // Boundaries computed from (b * sampleCount) / buckets rather than a
      // fixed samplesPerBucket stride, so the remainder is spread evenly
      // across buckets instead of piling onto the last one.
      const start = Math.floor((b * sampleCount) / buckets)
      const end = Math.floor(((b + 1) * sampleCount) / buckets)
      let sumSq = 0
      for (let i = start; i < end; i++) {
        const s = buf.readInt16LE(i * 2) / 32768
        sumSq += s * s
      }
      raw[b] = end > start ? Math.sqrt(sumSq / (end - start)) : 0
    }
    const max = Math.max(...raw, 1e-9)
    return raw.map((v) => Math.min(1, v / max))
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Markers below the minimum duration are kept but flagged — auditable,
 * threshold-tweakable, never silently gone. */
export function markerFlag(startS: number, endS: number | null, minMs: number): 'ok' | 'discarded' {
  if (endS == null) return 'ok'
  return (endS - startS) * 1000 < minMs ? 'discarded' : 'ok'
}

/** Parse a JSON object out of an LLM reply that may wrap it in prose/fences. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}
