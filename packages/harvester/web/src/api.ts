export interface Session {
  id: string
  title: string
  status: string
  origin: 'local' | 'import' | 'call'
  createdAt: number
  durationS: number | null
  error: string | null
  /** fully reviewed (no proposals left) — the list dims these (derived server-side) */
  curated: boolean
}

export interface JoinLink {
  identity: string
  name: string
  url: string
}

export interface Participant { id: number; sessionId: string; name: string }

export interface Speaker {
  id: number
  label: string
  participantId: number | null
  sampleStartS: number | null
  sampleEndS: number | null
  sampleText: string | null
}

export interface Marker {
  id: number
  startS: number
  endS: number | null
  flag: 'ok' | 'discarded' | 'unclosed'
  participant: string | null
  mode: 'hold' | 'toggle' | null
  stampedBy: 'server' | 'client'
}

export interface Gap {
  id: number
  participant: string
  startS: number
  endS: number
  direction: 'uplink' | 'downlink' | 'both'
  cause: string | null
}

export interface HarvestSpan {
  id: number
  startS: number
  endS: number
  participantCount: number
  memberIds: number[]
}

/** A snippet: the evidence atom — a verbatim slice of the transcript (word
 * range + quote), anchored in time. Carries no meaning of its own. */
export interface Snippet {
  id: number
  sessionId: string
  startWord: number
  endWord: number
  quote: string
  anchored: boolean
  spokenAt: number | null
  status: 'proposed' | 'accepted' | 'rejected'
}

export interface SupportingSnippet extends Snippet {
  /** why this supporting snippet matters (from the insight link) */
  why: string | null
}

/** An insight as reviewed: the proposed unit over its evidence — a main
 * snippet plus supporting snippets. Accepting flips `status` in place (which
 * cascades to the snippets); no copy. */
export interface Insight {
  id: number
  sessionId: string
  origin: 'marker' | 'sweep' | 'manual'
  harvestSpanId: number | null
  mainSnippetId: number
  title: string
  description: string
  status: 'proposed' | 'accepted' | 'rejected'
  main: Snippet | null
  supporting: SupportingSnippet[]
}

/** An ocean entry — an accepted insight, with the snippets it's built from (so
 * the UI can expand it). `quote`/`sessionId`/`sessionTitle` are resolved from
 * the main snippet and are null once that source has been removed. */
export interface OceanInsight {
  id: number
  title: string
  description: string
  spokenAt: number
  createdAt: number
  sessionId: string | null
  sessionTitle: string | null
  quote: string | null
  snippets: { id: number; quote: string; spokenAt: number | null }[]
}

/** Metadata for an ocean export download (the zip itself is saved by the
 * browser; this rides an out-of-band header for the toast). */
export interface OceanExportReport {
  filename: string
  exported: number
  clips: number
  warnings: string[]
}

export interface SessionDetail {
  session: Session
  participants: Participant[]
  speakers: Speaker[]
  markers: Marker[]
  gaps: Gap[]
  harvestSpans: HarvestSpan[]
  insights: Insight[]
  hasTranscript: boolean
}

export interface Word {
  index: number
  text: string
  start: number | null
  end: number | null
  aligned: boolean
  speaker: string | null
  segment_id: number
}

export interface Transcript {
  meta: { duration_s: number }
  segments: { id: number; text: string; speaker: string | null }[]
  words: Word[]
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(detail.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export const api = {
  sessions: () => request<Session[]>('GET', '/api/sessions'),
  detail: (id: string) => request<SessionDetail>('GET', `/api/sessions/${id}`),
  deleteSession: (id: string) => request<{ ok: boolean }>('DELETE', `/api/sessions/${id}`),
  import: async (file: File): Promise<SessionDetail> => {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await fetch('/api/sessions/import', { method: 'POST', body: form })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      throw new Error(detail.error ?? res.statusText)
    }
    return res.json() as Promise<SessionDetail>
  },
  transcript: (id: string) => request<Transcript>('GET', `/api/sessions/${id}/transcript`),
  assignSpeaker: (id: string, label: string, participantId: number) =>
    request<SessionDetail>('POST', `/api/sessions/${id}/speakers`, { label, participantId }),
  harvest: (id: string, fixture = false) =>
    request<{ started: boolean }>('POST', `/api/sessions/${id}/harvest`, { fixture }),
  manualInsight: (id: string, startWord: number, endWord: number) =>
    request<SessionDetail>('POST', `/api/sessions/${id}/insights`, { startWord, endWord }),
  updateInsight: (insightId: number, patch: Partial<Pick<Insight, 'status' | 'title' | 'description'>> & { startWord?: number; endWord?: number }) =>
    request<{ ok: boolean }>('PATCH', `/api/insights/${insightId}`, patch),
  export: (id: string) =>
    request<{ folder: string; exported: number; clips: number; warnings: string[] }>(
      'POST', `/api/sessions/${id}/export`),
  insights: (q?: string) =>
    request<OceanInsight[]>('GET', `/api/insights${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  // The ocean export is a file download, not JSON: POST, save the returned
  // zip via a transient object URL, and read the counts/warnings off the
  // out-of-band header for the caller's toast.
  exportOcean: async (q?: string): Promise<OceanExportReport> => {
    const res = await fetch(`/api/ocean/export${q ? `?q=${encodeURIComponent(q)}` : ''}`, { method: 'POST' })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      throw new Error(detail.error ?? res.statusText)
    }
    const header = res.headers.get('X-Export-Report')
    const report = (header ? JSON.parse(decodeURIComponent(header)) : {}) as OceanExportReport
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = report.filename ?? 'ocean-export.zip'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return report
  },
  audioUrl: (id: string) => `/api/sessions/${id}/audio`,
  peaks: (id: string) => request<{ buckets: number[] }>('GET', `/api/sessions/${id}/peaks`),
  call: {
    // the call plugin is only mounted when the backend has LiveKit config
    enabled: () => fetch('/api/call').then((r) => r.ok, () => false),
    start: () => request<{ sessionId: string; links: JoinLink[] }>('POST', '/api/call/sessions'),
    startRecording: () =>
      request<{ sessionId: string; links: JoinLink[] }>('POST', '/api/call/sessions/table'),
    links: (id: string) => request<{ links: JoinLink[] }>('GET', `/api/call/sessions/${id}/links`),
    joinInfo: (id: string) =>
      request<{ sessionId: string; title: string; status: string; livekitUrl: string }>(
        'GET', `/api/call/sessions/${id}/join`),
    end: (id: string) => request<{ ok: boolean }>('POST', `/api/call/sessions/${id}/end`),
  },
}

export function fmtTime(s: number | null | undefined): string {
  if (s == null) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
