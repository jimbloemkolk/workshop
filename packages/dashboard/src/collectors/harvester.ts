/** Polls the harvester backend's /api/sessions. Unlike most collectors,
 * "endpoint unreachable" is itself a signal worth surfacing (reachable:
 * false) rather than a reason to go fully null — the whole point of this
 * collector is knowing whether the harvester app is up. Fully null only
 * when HARVESTER_API isn't configured at all. */
import type { Config } from '../config.js'
import type { HarvesterSnapshot } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 60_000
const TIMEOUT_MS = 5_000

interface RawSession {
  status?: string
  durationS?: number
}

export class HarvesterCollector {
  private snapshot: HarvesterSnapshot | null = null

  constructor(private config: Config) {}

  start(): void {
    if (!this.config.harvesterApi) return // get() stays null
    startPolling('harvester', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    const base = this.config.harvesterApi
    if (!base) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(new URL('/api/sessions', base), { signal: controller.signal })
      if (!res.ok) throw new Error(`harvester API ${res.status}`)
      const sessions = (await res.json()) as RawSession[]
      const countsByStatus: Record<string, number> = {}
      let totalDurationS = 0
      for (const s of sessions) {
        const status = s.status ?? 'unknown'
        countsByStatus[status] = (countsByStatus[status] ?? 0) + 1
        totalDurationS += typeof s.durationS === 'number' ? s.durationS : 0
      }
      this.snapshot = { reachable: true, countsByStatus, totalDurationS }
    } catch {
      this.snapshot = { reachable: false, countsByStatus: null, totalDurationS: null }
    } finally {
      clearTimeout(timer)
    }
  }

  get(): HarvesterSnapshot | null {
    return this.snapshot
  }
}
