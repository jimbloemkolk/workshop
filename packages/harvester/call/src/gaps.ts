import type { CallEvent } from './events.js'

/** A period where mutual exchange broke down for one participant.
 * Directional: an uplink dying does not imply they stopped hearing. */
export interface GapSpan {
  participant: string
  startS: number
  endS: number
  direction: 'uplink' | 'downlink' | 'both'
  cause: string
}

/** Ignore blips below webhook timing fidelity (~1 s, spike NOTES §2) —
 * derivation is deliberately conservative: no invented micro-gaps. */
const MIN_GAP_S = 1.5

/** Reduce the raw events.jsonl feed to gap spans, v1 heuristics (DESIGN):
 * - participant_left → rejoin: they neither sent nor heard → `both`
 * - track_unpublished → republish (still connected): `uplink`
 * - client-reported reconnecting → reconnected: additive `downlink` garnish
 * Unpublish intervals inside a disconnect are absorbed by it (LiveKit fires
 * both for one disconnect). Intervals still open at call end run to endMs.
 * Pure — unit-tested without a media stack. */
export function deriveGapSpans(events: CallEvent[], t0Ms: number, endMs: number): GapSpan[] {
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs)
  const spans: GapSpan[] = []

  interface Open { sinceMs: number }
  const disconnected = new Map<string, Open>()
  const unpublished = new Map<string, Open>()
  const reconnecting = new Map<string, Open>()

  const close = (
    map: Map<string, Open>, participant: string, atMs: number,
    direction: GapSpan['direction'], cause: string,
  ) => {
    const open = map.get(participant)
    if (!open) return
    map.delete(participant)
    spans.push({
      participant,
      startS: (open.sinceMs - t0Ms) / 1000,
      endS: (atMs - t0Ms) / 1000,
      direction,
      cause,
    })
  }

  for (const ev of sorted) {
    const p = ev.participant
    if (!p || p.startsWith('EG_')) continue // the egress worker is not a person
    // best-effort precision: webhooks carry second-granular createdAt; our
    // arrival stamp is finer and typically <1s behind (spike NOTES §2)
    const atMs = ev.atMs
    switch (ev.type) {
      case 'participant_left':
        disconnected.set(p, { sinceMs: atMs })
        break
      case 'participant_joined':
        close(disconnected, p, atMs, 'both', 'disconnected')
        break
      case 'track_unpublished':
        unpublished.set(p, { sinceMs: atMs })
        break
      case 'track_published':
        close(unpublished, p, atMs, 'uplink', 'track unpublished')
        break
      case 'client:reconnecting':
        reconnecting.set(p, { sinceMs: atMs })
        break
      case 'client:reconnected':
        close(reconnecting, p, atMs, 'downlink', 'client reconnecting')
        break
    }
  }
  // still open at call end (including the final everyone-leaves wave, which
  // collapses to ~0-length spans and gets dropped below)
  for (const [p] of disconnected) close(disconnected, p, endMs, 'both', 'disconnected')
  for (const [p] of unpublished) close(unpublished, p, endMs, 'uplink', 'track unpublished')
  for (const [p] of reconnecting) close(reconnecting, p, endMs, 'downlink', 'client reconnecting')

  const disconnects = spans.filter((s) => s.cause === 'disconnected')
  return spans
    .filter((s) => s.endS - s.startS >= MIN_GAP_S)
    // one physical disconnect fires unpublish AND leave: keep the `both` span
    .filter((s) => s.cause === 'disconnected' || !disconnects.some((d) =>
      d.participant === s.participant && d.startS - 2 <= s.startS && s.endS <= d.endS + 2))
    .map((s) => ({ ...s, startS: Math.max(0, s.startS), endS: Math.max(0, s.endS) }))
    .sort((a, b) => a.startS - b.startS)
}
