/** Shared shapes returned by collectors and served over /api/overview.
 * Every top-level section is `| null` — a missing/unreachable source is a
 * normal, expected state (e.g. developing on a Mac has no podman socket, no
 * /proc), never an error. */

export interface PodmanContainer {
  name: string
  state: string
  image: string
  /** ms epoch; null if not running or unparsable */
  startedAt: number | null
  uptimeS: number | null
}

export interface PodmanSnapshot {
  containers: PodmanContainer[]
}

export interface HealthPoint {
  ts: number
  ok: boolean
  httpStatus: number | null
  ms: number | null
}

export interface HealthTargetSnapshot {
  name: string
  url: string
  current: HealthPoint | null
  /** uptime % (0-100) over each window; null if no data yet in that window */
  uptimePct: { '1h': number | null; '24h': number | null; '7d': number | null }
  /** last 24h of points, for the sparkline/latency chart */
  series24h: HealthPoint[]
}

export interface StorageDirSnapshot {
  name: string
  path: string
  bytes: number
  fileCount: number
  /** true if the ~50k file walk cap was hit (size/count are a lower bound) */
  truncated: boolean
  /** immediate subdirectories, largest first, top 5 — populated whenever the
   * dir has subdirectories (e.g. a harvester sessions-style layout) */
  topSubdirs: { name: string; bytes: number }[]
  /** null if the path doesn't exist / isn't readable */
  error: string | null
}

export interface StorageSnapshot {
  disk: { path: string; totalBytes: number; freeBytes: number } | null
  dirs: StorageDirSnapshot[]
}

export interface TlsSnapshot {
  path: string
  notAfter: string
  daysRemaining: number
}

export interface DeployRecord {
  ts: string
  stacks: string[]
  gitSha: string
  branch: string
  durations: { sync_s: number; build_s: number; apply_s: number; total_s: number }
  imageId: string | null
  restarted: string[]
}

export interface HarvesterSnapshot {
  reachable: boolean
  countsByStatus: Record<string, number> | null
  totalDurationS: number | null
}

export interface VitalsSnapshot {
  loadavg: [number, number, number]
  memTotalBytes: number
  memFreeBytes: number
  cpuCount: number
}

export interface Overview {
  ts: number
  podman: PodmanSnapshot | null
  health: HealthTargetSnapshot[]
  storage: StorageSnapshot
  tls: TlsSnapshot | null
  deploys: DeployRecord[] | null
  harvester: HarvesterSnapshot | null
  vitals: VitalsSnapshot | null
  /** small, cheap-to-derive rollups the UI's stat tile row wants directly,
   * so it doesn't need to re-implement "which health target is the main
   * site" (the first configured HEALTH_TARGETS entry, by convention) */
  aggregates: {
    allServicesRunning: boolean | null
    mainSiteUptimePct24h: number | null
    lastDeploy: DeployRecord | null
  }
}
