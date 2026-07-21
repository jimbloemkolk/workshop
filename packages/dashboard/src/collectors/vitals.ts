/** Host load/memory straight from /proc — only meaningful on the Linux
 * container host this eventually runs on. Reading /proc/loadavg fails
 * cleanly (ENOENT) on macOS, which is exactly the null-on-Mac behavior we
 * want; no special-casing platform by name. */
import fs from 'node:fs/promises'
import os from 'node:os'
import type { VitalsSnapshot } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 30_000

function parseMeminfo(raw: string): { totalBytes: number; freeBytes: number } {
  // Lines look like "MemTotal:       16330000 kB". MemAvailable (falls back
  // to MemFree) better reflects "usable" memory than raw MemFree.
  const get = (key: string): number => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
    if (!match?.[1]) throw new Error(`missing ${key} in /proc/meminfo`)
    return Number(match[1]) * 1024
  }
  let free: number
  try {
    free = get('MemAvailable')
  } catch {
    free = get('MemFree')
  }
  return { totalBytes: get('MemTotal'), freeBytes: free }
}

export class VitalsCollector {
  private snapshot: VitalsSnapshot | null = null

  start(): void {
    startPolling('vitals', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    try {
      const [loadRaw, memRaw] = await Promise.all([
        fs.readFile('/proc/loadavg', 'utf8'),
        fs.readFile('/proc/meminfo', 'utf8'),
      ])
      const parts = loadRaw.trim().split(/\s+/)
      const loadavg: [number, number, number] = [Number(parts[0]), Number(parts[1]), Number(parts[2])]
      const mem = parseMeminfo(memRaw)
      this.snapshot = {
        loadavg,
        memTotalBytes: mem.totalBytes,
        memFreeBytes: mem.freeBytes,
        cpuCount: os.cpus().length,
      }
    } catch {
      // no /proc (macOS, or a sandboxed environment) — n/a in the UI
      this.snapshot = null
    }
  }

  get(): VitalsSnapshot | null {
    return this.snapshot
  }
}
