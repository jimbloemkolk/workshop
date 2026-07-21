/** Disk free/total via fs.statfs, plus recursive directory sizes for the
 * configured STORAGE_DIRS (e.g. harvester session data, the vault). Each
 * dir walk is capped at ~50k files so a runaway directory can't turn a
 * 10-minute poll into a multi-hour one; hitting the cap is reported via
 * `truncated` rather than silently under-reporting. */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Config, StorageDir } from '../config.js'
import type { StorageDirSnapshot, StorageSnapshot } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 10 * 60_000
const FILE_CAP = 50_000

interface WalkResult {
  bytes: number
  fileCount: number
  truncated: boolean
  /** bytes attributed to each immediate child directory of the walk root */
  childBytes: Map<string, number>
}

async function walk(root: string): Promise<WalkResult> {
  const result: WalkResult = { bytes: 0, fileCount: 0, truncated: false, childBytes: new Map() }
  // stack of [dir, topLevelChildName] — topLevelChildName is the immediate
  // child of `root` this subtree belongs to (root itself for depth-0 files),
  // so we can attribute sizes to "top 5 subdirs" without a second walk.
  const stack: [string, string | null][] = [[root, null]]

  while (stack.length) {
    if (result.fileCount >= FILE_CAP) {
      result.truncated = true
      break
    }
    const next = stack.pop()
    if (!next) break
    const [dir, topChild] = next
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // permission denied / disappeared mid-walk — skip, don't fail the whole dir
    }
    for (const entry of entries) {
      if (result.fileCount >= FILE_CAP) {
        result.truncated = true
        break
      }
      const full = path.join(dir, entry.name)
      const childKey = topChild ?? entry.name
      if (entry.isDirectory()) {
        stack.push([full, childKey])
        continue
      }
      // lstat, not stat: a symlink's own size, and never follow it into
      // more of the filesystem (avoids symlink loops entirely)
      try {
        const st = await fs.lstat(full)
        result.bytes += st.size
        result.fileCount += 1
        if (topChild !== null) {
          result.childBytes.set(childKey, (result.childBytes.get(childKey) ?? 0) + st.size)
        }
      } catch {
        // file vanished between readdir and lstat — ignore
      }
    }
  }
  return result
}

async function snapshotDir(dir: StorageDir): Promise<StorageDirSnapshot> {
  try {
    const { bytes, fileCount, truncated, childBytes } = await walk(dir.path)
    const topSubdirs = [...childBytes.entries()]
      .map(([name, b]) => ({ name, bytes: b }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
    return { name: dir.name, path: dir.path, bytes, fileCount, truncated, topSubdirs, error: null }
  } catch (err) {
    return {
      name: dir.name,
      path: dir.path,
      bytes: 0,
      fileCount: 0,
      truncated: false,
      topSubdirs: [],
      error: (err as Error).message,
    }
  }
}

export class StorageCollector {
  private snapshot: StorageSnapshot = { disk: null, dirs: [] }

  constructor(private config: Config) {}

  start(): void {
    startPolling('storage', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    const disk = await this.diskUsage()
    const dirs = await Promise.all(this.config.storageDirs.map((d) => snapshotDir(d)))
    this.snapshot = { disk, dirs }
  }

  private async diskUsage(): Promise<StorageSnapshot['disk']> {
    try {
      const st = await fs.statfs(this.config.diskPath)
      return {
        path: this.config.diskPath,
        totalBytes: st.blocks * st.bsize,
        // bavail (available to unprivileged users), not bfree, is the
        // honest answer to "how much can I actually still write"
        freeBytes: st.bavail * st.bsize,
      }
    } catch {
      return null
    }
  }

  get(): StorageSnapshot {
    return this.snapshot
  }
}
