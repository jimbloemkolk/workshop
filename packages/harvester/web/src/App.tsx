import { useCallback, useEffect, useState } from 'react'
import { api, type Session, type SessionDetail } from './api'
import { onServerEvent } from './socket'
import { RecordView } from './views/RecordView'
import { LabelView } from './views/LabelView'
import { PipelineView } from './views/PipelineView'
import { ReviewView } from './views/ReviewView'
import { SessionList } from './views/SessionList'

function hashSession(): string | null {
  const m = /^#\/session\/(.+)$/.exec(location.hash)
  return m ? m[1]! : null
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [current, setCurrent] = useState<string | null>(hashSession())
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshSessions = useCallback(() => {
    api.sessions().then(setSessions).catch((e) => setError(String(e)))
  }, [])

  const refreshDetail = useCallback((id: string) => {
    api.detail(id).then(setDetail).catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    const onHash = () => setCurrent(hashSession())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(refreshSessions, [refreshSessions])
  useEffect(() => {
    if (current) refreshDetail(current)
    else setDetail(null)
  }, [current, refreshDetail])

  useEffect(() => onServerEvent((e) => {
    if (e.type === 'session') {
      refreshSessions()
      if (e.sessionId === current) refreshDetail(e.sessionId)
    }
    if (e.type === 'marker' && e.sessionId === current) refreshDetail(e.sessionId)
  }), [current, refreshSessions, refreshDetail])

  const open = (id: string) => { location.hash = `#/session/${id}` }

  const startSession = async () => {
    try {
      const d = await api.start([])
      open(d.session.id)
    } catch (e) { setError(String(e)) }
  }

  const [importing, setImporting] = useState(false)
  const importFile = async (file: File) => {
    setImporting(true)
    try {
      const d = await api.import(file)
      open(d.session.id)
    } catch (e) { setError(String(e)) } finally { setImporting(false) }
  }

  return (
    <div className="app">
      <header>
        <a href="#" onClick={(e) => { e.preventDefault(); location.hash = '' }}>
          🌾 Insight Harvester
        </a>
        {detail && <span className="crumb">{detail.session.title} · {detail.session.status}</span>}
      </header>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      {!current || !detail ? (
        <SessionList
          sessions={sessions}
          onOpen={open}
          onStart={startSession}
          onImport={importFile}
          importing={importing}
        />
      ) : (
        <SessionScreen detail={detail} refresh={() => refreshDetail(current)} onError={setError} />
      )}
    </div>
  )
}

function SessionScreen({ detail, refresh, onError }: {
  detail: SessionDetail
  refresh: () => void
  onError: (e: string) => void
}) {
  const { status } = detail.session
  if (status === 'recording' || status === 'interrupted') {
    return <RecordView detail={detail} onError={onError} />
  }
  if (status === 'transcribing' || status === 'harvesting') {
    return <PipelineView detail={detail} />
  }
  if (status === 'labeling') {
    return <LabelView detail={detail} onError={onError} />
  }
  // reviewing | exported | failed → review is the home screen (re-entrant)
  return <ReviewView detail={detail} refresh={refresh} onError={onError} />
}
