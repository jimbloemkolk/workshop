import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..')

/** Minimal .env loader (same contract as the transcriber's): cwd first, then
 * package root; existing environment variables always win. */
function loadDotenv(): void {
  for (const dir of [process.cwd(), packageRoot]) {
    const file = path.join(dir, '.env')
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      const [, key, raw] = m
      if (key! in process.env) continue
      process.env[key!] = raw!.replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

export interface Config {
  dataDir: string
  vaultDir: string | null
  port: number
  /** avfoundation audio device index (the part after ':' in ffmpeg -i) */
  micDevice: string
  /** model passed to the Agent SDK */
  model: string
  /** markers shorter than this are stored but flagged discarded */
  markerMinMs: number
  /** breathing room around sliced clips */
  clipPaddingMs: number
  /** segment length for crash-safe recording */
  segmentSeconds: number
  transcriberDir: string
  transcriber: { backend: string; model: string; language: string }
}

export function loadConfig(): Config {
  loadDotenv()
  const env = process.env
  return {
    dataDir: env.HARVESTER_DATA_DIR
      ?? path.join(os.homedir(), '.local', 'share', 'harvester'),
    vaultDir: env.HARVESTER_VAULT_DIR ?? null,
    port: Number(env.HARVESTER_PORT ?? 4747),
    micDevice: env.HARVESTER_MIC ?? '0',
    model: env.HARVESTER_MODEL ?? 'sonnet',
    markerMinMs: Number(env.HARVESTER_MARKER_MIN_MS ?? 300),
    clipPaddingMs: Number(env.HARVESTER_CLIP_PADDING_MS ?? 200),
    segmentSeconds: Number(env.HARVESTER_SEGMENT_SECONDS ?? 60),
    transcriberDir: env.HARVESTER_TRANSCRIBER_DIR
      ?? path.resolve(packageRoot, '../../transcriber'),
    transcriber: { backend: 'mlx', model: 'large-v3-turbo', language: 'nl' },
  }
}

export function sessionDir(config: Config, sessionId: string): string {
  return path.join(config.dataDir, 'sessions', sessionId)
}
