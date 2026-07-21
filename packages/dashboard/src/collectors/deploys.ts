/** Read-only tail of DEPLOY_LOG, a jsonl file this dashboard never writes to
 * — deploy.sh appends one record per run. Parsed tolerantly: a line that
 * doesn't match the expected shape is dropped rather than blowing up the
 * whole section (a deploy script tweak shouldn't take the dashboard down).
 * Exposes only the last 50. */
import fs from 'node:fs'
import readline from 'node:readline'
import type { Config } from '../config.js'
import type { DeployRecord } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 60_000
const KEEP = 50

function isDeployRecord(rec: unknown): rec is DeployRecord {
  if (!rec || typeof rec !== 'object') return false
  const r = rec as Record<string, unknown>
  const d = r.durations as Record<string, unknown> | undefined
  return (
    typeof r.ts === 'string' &&
    Array.isArray(r.stacks) &&
    typeof r.gitSha === 'string' &&
    typeof r.branch === 'string' &&
    !!d &&
    typeof d.sync_s === 'number' &&
    typeof d.build_s === 'number' &&
    typeof d.apply_s === 'number' &&
    typeof d.total_s === 'number' &&
    (r.imageId === null || typeof r.imageId === 'string') && // deploy.sh writes null today

    Array.isArray(r.restarted)
  )
}

export class DeploysCollector {
  private records: DeployRecord[] = []

  constructor(private config: Config) {}

  start(): void {
    if (!this.config.deployLog) return // no DEPLOY_LOG configured; get() stays []
    startPolling('deploys', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    const logPath = this.config.deployLog
    if (!logPath || !fs.existsSync(logPath)) {
      this.records = []
      return
    }
    const kept: DeployRecord[] = []
    const rl = readline.createInterface({ input: fs.createReadStream(logPath), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const rec: unknown = JSON.parse(line)
        if (isDeployRecord(rec)) kept.push(rec)
      } catch {
        // malformed line — skip
      }
    }
    this.records = kept.slice(-KEEP)
  }

  /** null (section disabled) vs [] (configured, no records yet) is the
   * distinction the API contract promises — hence the ternary on the
   * source config rather than just returning the cached array. */
  get(): DeployRecord[] | null {
    return this.config.deployLog ? this.records : null
  }
}
