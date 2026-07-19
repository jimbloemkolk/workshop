import fs from 'node:fs'
import path from 'node:path'

/** Raw epoch-ms event log in the session dir: every LiveKit webhook plus
 * client-reported signals, appended as they arrive. Audit trail, crash-safe
 * recorder state, and the input to gap derivation at finalize. */
export interface CallEvent {
  atMs: number
  type: string
  participant?: string
  trackSid?: string
  egressId?: string
  [key: string]: unknown
}

const FILE = 'events.jsonl'

export function appendEvent(sessionDir: string, event: CallEvent): void {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.appendFileSync(path.join(sessionDir, FILE), JSON.stringify(event) + '\n')
}

export function readEvents(sessionDir: string): CallEvent[] {
  const file = path.join(sessionDir, FILE)
  if (!fs.existsSync(file)) return []
  const out: CallEvent[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as CallEvent)
    } catch {
      // a torn write from a crash mid-append: skip the line, keep the log
    }
  }
  return out
}
