/** Env-driven config. Every field below is optional in the sense that the
 * collector it feeds treats "unset/unreachable" as a null section rather than
 * a crash — see src/collectors/*.ts. Defaults target the eventual applepie
 * container; override via env for local dev (see README-less fixture notes
 * in the task that produced this file). */

export interface HealthTarget {
  name: string
  url: string
}

export interface StorageDir {
  name: string
  path: string
}

export interface Config {
  port: number
  podmanSock: string
  healthTargets: HealthTarget[]
  dataDir: string
  diskPath: string
  storageDirs: StorageDir[]
  /** unset (null) disables the TLS collector entirely */
  certDir: string | null
  /** unset (null) disables the deploys collector entirely */
  deployLog: string | null
  /** unset (null) disables the harvester-app collector entirely */
  harvesterApi: string | null
}

/** Parses a JSON array env var tolerantly: malformed JSON or a non-array
 * value both fall back to `fallback` (logging why) instead of throwing —
 * a typo in an env var should degrade a dashboard section, not crash boot. */
function parseJsonArray<T>(raw: string | undefined, name: string, fallback: T[]): T[] {
  if (!raw) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed as T[]
  } catch (err) {
    console.warn(`[config] ignoring malformed ${name}: ${(err as Error).message}`)
    return fallback
  }
}

export function loadConfig(): Config {
  const env = process.env
  return {
    port: Number(env.DASH_PORT ?? 5151),
    podmanSock: env.PODMAN_SOCK ?? '/run/podman/podman.sock',
    healthTargets: parseJsonArray<HealthTarget>(env.HEALTH_TARGETS, 'HEALTH_TARGETS', []),
    dataDir: env.DASH_DATA_DIR ?? './data',
    diskPath: env.DISK_PATH ?? '/',
    storageDirs: parseJsonArray<StorageDir>(env.STORAGE_DIRS, 'STORAGE_DIRS', []),
    certDir: env.CERT_DIR ?? null,
    deployLog: env.DEPLOY_LOG ?? null,
    harvesterApi: env.HARVESTER_API ?? null,
  }
}
