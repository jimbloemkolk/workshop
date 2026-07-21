/** Walks CERT_DIR for *.crt/*.pem and reports the soonest expiry via node's
 * built-in X509Certificate parser (no extra TLS lib needed). Null whenever
 * CERT_DIR is unset, missing, or contains nothing parseable — caddy may not
 * even be co-located with this dashboard yet. */
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Config } from '../config.js'
import type { TlsSnapshot } from '../types.js'
import { startPolling } from './poll.js'

const INTERVAL_MS = 60 * 60_000
const CERT_EXT = /\.(crt|pem)$/i

async function findCertFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) break
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (CERT_EXT.test(entry.name)) found.push(full)
    }
  }
  return found
}

export class TlsCollector {
  private snapshot: TlsSnapshot | null = null

  constructor(private config: Config) {}

  start(): void {
    if (!this.config.certDir) return // collector fully disabled; get() stays null
    startPolling('tls', INTERVAL_MS, () => this.poll())
  }

  private async poll(): Promise<void> {
    const certDir = this.config.certDir
    if (!certDir) return
    const files = await findCertFiles(certDir)
    let soonest: { path: string; notAfter: Date } | null = null
    for (const file of files) {
      try {
        const pem = await fs.readFile(file)
        const cert = new X509Certificate(pem)
        const notAfter = new Date(cert.validTo)
        if (!soonest || notAfter < soonest.notAfter) soonest = { path: file, notAfter }
      } catch {
        // not a valid cert (bad PEM, private key mistakenly matching the
        // glob, etc.) — skip it rather than aborting the whole scan
      }
    }
    if (!soonest) {
      this.snapshot = null
      return
    }
    const daysRemaining = Math.floor((soonest.notAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    this.snapshot = { path: soonest.path, notAfter: soonest.notAfter.toISOString(), daysRemaining }
  }

  get(): TlsSnapshot | null {
    return this.snapshot
  }
}
