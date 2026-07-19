import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..')

/** Minimal .env loader (same contract as the transcriber's): cwd first, then
 * the given extra dirs (e.g. the host package's root), then this package's
 * root; existing environment variables always win. */
export function loadDotenv(extraDirs: string[] = []): void {
  for (const dir of [process.cwd(), ...extraDirs, packageRoot]) {
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

export interface CoreConfig {
  dataDir: string
  vaultDir: string | null
  transcriberDir: string
  transcriber: { backend: string; model: string; language: string }
}

export function loadCoreConfig(extraEnvDirs: string[] = []): CoreConfig {
  loadDotenv(extraEnvDirs)
  const env = process.env
  return {
    dataDir: env.HARVESTER_DATA_DIR
      ?? path.join(os.homedir(), '.local', 'share', 'harvester'),
    vaultDir: env.HARVESTER_VAULT_DIR ?? null,
    transcriberDir: env.HARVESTER_TRANSCRIBER_DIR
      ?? path.resolve(packageRoot, '../../transcriber'),
    transcriber: {
      backend: env.HARVESTER_TRANSCRIBER_BACKEND ?? 'mlx',
      model: 'large-v3-turbo',
      language: 'nl',
    },
  }
}

export function sessionDir(config: CoreConfig, sessionId: string): string {
  return path.join(config.dataDir, 'sessions', sessionId)
}
