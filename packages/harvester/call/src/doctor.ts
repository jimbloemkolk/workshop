import fs from 'node:fs'
import path from 'node:path'
import { AccessToken, RoomServiceClient, TokenVerifier, WebhookReceiver } from 'livekit-server-sdk'
import { sessionDir, type CoreConfig } from '@workshop/harvester-core'
import type { CallConfig } from './config.js'

export interface DoctorCheck {
  label: string
  ok: boolean
  hint?: string
}

/** Call-stack health, run by the backend's doctor when calling is
 * configured. The egress *worker* can only be proven by recording something
 * — that's `e2e --call`'s job; here we prove everything reachable/valid. */
export async function callDoctorChecks(config: CallConfig, core: CoreConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const httpUrl = config.url.replace(/^ws/, 'http')

  // LiveKit reachable + API key accepted (listRooms is authenticated)
  const rooms = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret)
  try {
    await rooms.listRooms()
    checks.push({ label: `livekit reachable (${config.url})`, ok: true })
  } catch (err) {
    checks.push({
      label: `livekit reachable (${config.url})`, ok: false,
      hint: `docker compose up? (${trim(err)})`,
    })
  }

  // token mint round-trip: what we hand to browsers must verify
  try {
    const at = new AccessToken(config.apiKey, config.apiSecret, { identity: 'doctor', ttl: 60 })
    at.addGrant({ room: 'doctor-probe', roomJoin: true })
    const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(await at.toJwt())
    checks.push({ label: 'token mint round-trip', ok: claims.video?.room === 'doctor-probe' })
  } catch (err) {
    checks.push({ label: 'token mint round-trip', ok: false, hint: trim(err) })
  }

  // webhook secret validates (the receiver rides the same key pair)
  try {
    new WebhookReceiver(config.apiKey, config.apiSecret)
    const strong = config.apiKey.length > 0 && config.apiSecret.length >= 16
    checks.push({
      label: 'webhook receiver configured (secret pair present)',
      ok: strong,
      hint: strong ? undefined : 'LIVEKIT_API_SECRET should be a long random string',
    })
  } catch (err) {
    checks.push({ label: 'webhook receiver configured', ok: false, hint: trim(err) })
  }

  // egress volume: the dir egress writes into must exist for us and be
  // writable (same-path mount contract; the container side is proven by e2e)
  const probeDir = sessionDir(core, '.doctor-probe')
  try {
    fs.mkdirSync(path.join(probeDir, 'tracks'), { recursive: true })
    fs.writeFileSync(path.join(probeDir, 'tracks', 'probe'), '')
    fs.rmSync(probeDir, { recursive: true, force: true })
    checks.push({ label: `egress volume path writable (${core.dataDir})`, ok: true })
  } catch (err) {
    checks.push({
      label: `egress volume path writable (${core.dataDir})`, ok: false, hint: trim(err),
    })
  }

  if (!config.publicUrl) {
    checks.push({
      label: 'HARVESTER_PUBLIC_URL unset (join-link base)', ok: true,
      hint: 'links will use the request origin; fine on the tailnet',
    })
  }

  return checks
}

function trim(err: unknown): string {
  return String(err).split('\n')[0] ?? ''
}
