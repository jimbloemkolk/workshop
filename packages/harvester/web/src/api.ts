export interface Session {
  id: string
  title: string
  status: string
  createdAt: number
  durationS: number | null
  error: string | null
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
  insights: Insight[]
  recordingPosition: number | null
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
  start: (participants: string[]) => request<SessionDetail>('POST', '/api/sessions', { participants }),
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
  stop: (id: string) => request<SessionDetail>('POST', `/api/sessions/${id}/stop`),
  resume: (id: string) => request<SessionDetail>('POST', `/api/sessions/${id}/resume`),
  finalize: (id: string) => request<SessionDetail>('POST', `/api/sessions/${id}/finalize`),
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
}

export function fmtTime(s: number | null | undefined): string {
  if (s == null) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
