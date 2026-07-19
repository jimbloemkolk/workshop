/** Call config is layered on top of core/backend config, defined here (the
 * dependency floor stays one-way: backend → call → core). `null` — no
 * LIVEKIT_URL — means the call plugin is never mounted and the harvester
 * behaves exactly as before. Relies on the host having run the core dotenv
 * loader first. */
export interface CallConfig {
  /** LiveKit URL as reachable from the backend (SDK + egress control) */
  url: string
  apiKey: string
  apiSecret: string
  /** join-link base, e.g. https://harvester.tail1234.ts.net; when null the
   * links fall back to the origin the start-call request came in on */
  publicUrl: string | null
  /** LiveKit URL as reachable from browsers; defaults to `url` (they only
   * diverge when the backend runs inside the compose network) */
  livekitPublicUrl: string
  /** marks shorter than this are stored but flagged discarded — same env
   * knob the backend reads, so local and call marking agree */
  markerMinMs: number
}

export function loadCallConfig(): CallConfig | null {
  const env = process.env
  const url = env.LIVEKIT_URL
  if (!url) return null
  const apiKey = env.LIVEKIT_API_KEY
  const apiSecret = env.LIVEKIT_API_SECRET
  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_URL is set but LIVEKIT_API_KEY/LIVEKIT_API_SECRET are missing')
  }
  return {
    url,
    apiKey,
    apiSecret,
    publicUrl: env.HARVESTER_PUBLIC_URL ?? null,
    livekitPublicUrl: env.LIVEKIT_PUBLIC_URL ?? url,
    markerMinMs: Number(env.HARVESTER_MARKER_MIN_MS ?? 300),
  }
}
