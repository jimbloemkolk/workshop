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

export interface SupportingQuote {
  id: number
  startWord: number
  endWord: number
  quote: string
  why: string | null
  anchored: boolean
}

/** A snippet: the verbatim atom you review — a literal quote plus its
 * anchoring. `note` is the harvester's interpretive gloss (seeds an insight's
 * description at accept). */
export interface Snippet {
  id: number
  origin: 'marker' | 'sweep' | 'manual'
  harvestSpanId: number | null
  title: string
  startWord: number
  endWord: number
  quote: string
  note: string
  anchored: boolean
  status: 'proposed' | 'accepted' | 'rejected'
  supporting: SupportingQuote[]
}

/** An ocean entry — an insight: the refined idea. `title`/`description` are
 * its own (diverge-able) copy; `quote`/`sessionId`/`sessionTitle` are resolved
 * live from the source snippet and are null once that source has been removed. */
export interface Insight {
  id: number
  title: string
  description: string
  spokenAt: number
  createdAt: number
  sourceSnippetId: number
  sessionId: string | null
  sessionTitle: string | null
  quote: string | null
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
  snippets: Snippet[]
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
  manualSnippet: (id: string, startWord: number, endWord: number) =>
    request<SessionDetail>('POST', `/api/sessions/${id}/snippets`, { startWord, endWord }),
  updateSnippet: (snippetId: number, patch: Partial<Pick<Snippet, 'status' | 'startWord' | 'endWord' | 'title' | 'note'>>) =>
    request<{ ok: boolean }>('PATCH', `/api/snippets/${snippetId}`, patch),
  export: (id: string) =>
    request<{ folder: string; exported: number; clips: number; warnings: string[] }>(
      'POST', `/api/sessions/${id}/export`),
  insights: (q?: string) =>
    request<Insight[]>('GET', `/api/insights${q ? `?q=${encodeURIComponent(q)}` : ''}`),
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
