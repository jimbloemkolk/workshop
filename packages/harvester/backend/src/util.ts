import { execFile, spawn } from 'node:child_process'
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

/** Parse a JSON object out of an LLM reply that may wrap it in prose/fences. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}
