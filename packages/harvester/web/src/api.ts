export interface Session {
  id: string
  title: string
  status: string
  origin: 'local' | 'import' | 'call'
  createdAt: number
  durationS: number | null
  error: string | null
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

export interface Insight {
  id: number
  origin: 'marker' | 'sweep' | 'manual'
  harvestSpanId: number | null
  title: string
  startWord: number
  endWord: number
  quote: string
  insight: string
  anchored: boolean
  status: 'proposed' | 'accepted' | 'rejected'
  exportedPath: string | null
  supporting: SupportingQuote[]
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
  updateInsight: (insightId: number, patch: Partial<Pick<Insight, 'status' | 'startWord' | 'endWord' | 'title' | 'insight'>>) =>
    request<{ ok: boolean }>('PATCH', `/api/insights/${insightId}`, patch),
  export: (id: string) =>
    request<{ folder: string; exported: number; clips: number; warnings: string[] }>(
      'POST', `/api/sessions/${id}/export`),
  audioUrl: (id: string) => `/api/sessions/${id}/audio`,
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
