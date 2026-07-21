/** Polls the podman REST API over its unix socket (no podman binary/shell-out
 * involved — just node:http against a unix socket path). Returns null
 * whenever the socket is missing/refusing connections, which is the normal
 * state on a dev Mac. */
import http from 'node:http'
import type { Config } from '../config.js'
import type { PodmanContainer, PodmanSnapshot } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 30_000
const TIMEOUT_MS = 2_000

/** Raw shape of one entry from GET /v4.0.0/libpod/containers/json — only
 * the fields we use, and defensively optional since libpod's JSON isn't
 * contractually stable across versions. */
interface RawContainer {
  Names?: string[]
  State?: string
  Image?: string
  StartedAt?: number | string
}

function requestJson(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method: 'GET', timeout: TIMEOUT_MS, headers: { accept: 'application/json' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`podman API ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('podman API timeout')))
    req.on('error', reject)
    req.end()
  })
}

function toContainer(raw: RawContainer): PodmanContainer {
  const name = raw.Names?.[0]?.replace(/^\//, '') ?? 'unknown'
  const state = raw.State ?? 'unknown'
  const image = raw.Image ?? 'unknown'
  // libpod reports StartedAt as a unix-seconds number; tolerate an ISO
  // string too in case that ever changes upstream.
  const startedAt =
    typeof raw.StartedAt === 'number'
      ? raw.StartedAt * 1000
      : raw.StartedAt
        ? Date.parse(raw.StartedAt)
        : null
  const uptimeS =
    state === 'running' && startedAt && Number.isFinite(startedAt)
      ? (Date.now() - startedAt) / 1000
      : null
  return { name, state, image, startedAt: startedAt && Number.isFinite(startedAt) ? startedAt : null, uptimeS }
}

export class PodmanCollector {
  private snapshot: PodmanSnapshot | null = null

  constructor(private config: Config) {}

  start(): void {
    startPolling('podman', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    try {
      const raw = await requestJson(this.config.podmanSock, '/v4.0.0/libpod/containers/json?all=true')
      if (!Array.isArray(raw)) throw new Error('unexpected podman response shape')
      this.snapshot = { containers: raw.map((r) => toContainer(r as RawContainer)) }
    } catch {
      // Socket absent (ENOENT), refused, or malformed reply — all equally
      // "podman isn't available here," which the UI renders as n/a.
      this.snapshot = null
    }
  }

  get(): PodmanSnapshot | null {
    return this.snapshot
  }
}
