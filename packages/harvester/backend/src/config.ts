import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCoreConfig, type CoreConfig } from '@workshop/harvester-core'

export const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..')

export interface Config extends CoreConfig {
  port: number
  /** model passed to the Agent SDK */
  model: string
  /** markers shorter than this are stored but flagged discarded */
  markerMinMs: number
  /** breathing room around sliced clips */
  clipPaddingMs: number
}

export function loadConfig(): Config {
  const core = loadCoreConfig([packageRoot])
  const env = process.env
  return {
    ...core,
    port: Number(env.HARVESTER_PORT ?? 4747),
    model: env.HARVESTER_MODEL ?? 'sonnet',
    markerMinMs: Number(env.HARVESTER_MARKER_MIN_MS ?? 300),
    clipPaddingMs: Number(env.HARVESTER_CLIP_PADDING_MS ?? 200),
  }
}
