/** Polls each configured HEALTH_TARGETS URL, keeps a rolling in-memory
 * window per target, and mirrors every point to a jsonl history file so
 * uptime/latency survive a restart. The in-memory window IS the retention
 * window (~14d) — small enough to hold entirely (a couple of targets at one
 * point/60s is a few thousand rows), so /api/history/health never has to
 * re-read the file; only boot does, once, to repopulate memory and to
 * compact the file down to the retention window. */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Config, HealthTarget } from '../config.js'
import type { HealthPoint, HealthTargetSnapshot } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 60_000
const TIMEOUT_MS = 10_000
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000

interface HistoryLine extends HealthPoint {
  name: string
}

function historyPath(dataDir: string): string {
  return path.join(dataDir, 'health-history.jsonl')
}

async function checkOnce(url: string): Promise<HealthPoint> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return { ts: started, ok: res.ok, httpStatus: res.status, ms: Date.now() - started }
  } catch {
    return { ts: started, ok: false, httpStatus: null, ms: null }
  } finally {
    clearTimeout(timer)
  }
}

function uptimePct(points: HealthPoint[], since: number): number | null {
  const inWindow = points.filter((p) => p.ts >= since)
  if (inWindow.length === 0) return null
  const ok = inWindow.filter((p) => p.ok).length
  return (ok / inWindow.length) * 100
}

export class HealthCollector {
  private points = new Map<string, HealthPoint[]>()
  private file: string

  constructor(private config: Config) {
    this.file = historyPath(config.dataDir)
    for (const t of config.healthTargets) this.points.set(t.name, [])
  }

  /** Reads existing history, drops anything older than the retention
   * window, rewrites the file with just the kept lines ("compact on
   * boot"), and seeds the in-memory window from it. Safe to call when the
   * file/dir doesn't exist yet (fresh install). */
  async loadHistory(): Promise<void> {
    fs.mkdirSync(this.config.dataDir, { recursive: true })
    if (!fs.existsSync(this.file)) return

    const cutoff = Date.now() - RETENTION_MS
    const kept: HistoryLine[] = []
    const rl = readline.createInterface({ input: fs.createReadStream(this.file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as HistoryLine
        if (typeof rec.ts === 'number' && rec.ts >= cutoff && typeof rec.name === 'string') kept.push(rec)
      } catch {
        // one corrupt line shouldn't lose the rest of the history
      }
    }
    for (const rec of kept) {
      const arr = this.points.get(rec.name) ?? []
      arr.push({ ts: rec.ts, ok: rec.ok, httpStatus: rec.httpStatus, ms: rec.ms })
      this.points.set(rec.name, arr)
    }
    fs.writeFileSync(this.file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''))
  }

  start(): void {
    startPolling('health', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    const cutoff = Date.now() - RETENTION_MS
    for (const target of this.config.healthTargets) {
      const point = await checkOnce(target.url)
      const arr = this.points.get(target.name) ?? []
      arr.push(point)
      // trim to the retention window as we go, so memory never grows
      // unbounded even if the process runs for months
      while (arr.length && arr[0] && arr[0].ts < cutoff) arr.shift()
      this.points.set(target.name, arr)
      this.append({ name: target.name, ...point })
    }
  }

  private append(line: HistoryLine): void {
    fs.appendFile(this.file, JSON.stringify(line) + '\n', () => {
      // best-effort; a dropped history line isn't worth crashing the poller over
    })
  }

  private snapshotFor(target: HealthTarget): HealthTargetSnapshot {
    const arr = this.points.get(target.name) ?? []
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    return {
      name: target.name,
      url: target.url,
      current: arr.length ? (arr[arr.length - 1] ?? null) : null,
      uptimePct: {
        '1h': uptimePct(arr, now - 60 * 60 * 1000),
        '24h': uptimePct(arr, now - day),
        '7d': uptimePct(arr, now - 7 * day),
      },
      series24h: arr.filter((p) => p.ts >= now - day),
    }
  }

  get(): HealthTargetSnapshot[] {
    return this.config.healthTargets.map((t) => this.snapshotFor(t))
  }

  /** Backing store for GET /api/history/health?name=&hours= */
  history(name: string, hours: number): HealthPoint[] {
    const since = Date.now() - hours * 60 * 60 * 1000
    return (this.points.get(name) ?? []).filter((p) => p.ts >= since)
  }
}
