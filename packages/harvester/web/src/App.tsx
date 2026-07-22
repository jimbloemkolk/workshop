import { useCallback, useEffect, useState } from 'react'
import { api, type Session, type SessionDetail } from './api'
import { onServerEvent } from './socket'
import { CallLinksView } from './views/CallLinksView'
import { RecordingOpenView } from './views/RecordingOpenView'
import { LabelView } from './views/LabelView'
import { PipelineView } from './views/PipelineView'
import { ReviewView } from './views/ReviewView'
import { SessionList } from './views/SessionList'
import { SnippetsView } from './views/SnippetsView'

function hashSession(): string | null {
  const m = /^#\/session\/(.+)$/.exec(location.hash)
  return m ? m[1]! : null
}

function isOceanHash(): boolean {
  return location.hash === '#/ocean'
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [current, setCurrent] = useState<string | null>(hashSession())
  const [ocean, setOcean] = useState<boolean>(isOceanHash())
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshSessions = useCallback(() => {
    api.sessions().then(setSessions).catch((e) => setError(String(e)))
  }, [])

  const refreshDetail = useCallback((id: string) => {
    api.detail(id).then(setDetail).catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    const onHash = () => { setCurrent(hashSession()); setOcean(isOceanHash()) }
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
    if (e.type === 'session-deleted') {
      refreshSessions()
      if (e.sessionId === current) location.hash = ''
    }
    if (e.type === 'marker' && e.sessionId === current) refreshDetail(e.sessionId)
  }), [current, refreshSessions, refreshDetail])

  const open = (id: string) => { location.hash = `#/session/${id}` }

  const deleteSession = async (id: string) => {
    try {
      await api.deleteSession(id)
      if (id === current) location.hash = ''
      refreshSessions()
    } catch (e) { setError(String(e)) }
  }

  const [callEnabled, setCallEnabled] = useState(false)
  useEffect(() => { void api.call.enabled().then(setCallEnabled) }, [])
  const startCall = async () => {
    try {
      const { sessionId } = await api.call.start()
      open(sessionId)
    } catch (e) { setError(String(e)) }
  }

  // the browser tab that clicked the button becomes the publisher — same
  // tab, no link to share, so redirect straight into the join page
  const startRecording = async () => {
    try {
      const { links } = await api.call.startRecording()
      location.href = links[0]!.url
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
        <a className="nav-ocean" href="#/ocean">🌊 Ocean</a>
        {detail && <span className="crumb">{detail.session.title} · {detail.session.status}</span>}
      </header>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      {ocean ? (
        <SnippetsView onOpenSession={open} />
      ) : !current || !detail ? (
        <SessionList
          sessions={sessions}
          onOpen={open}
          onStart={callEnabled ? startRecording : null}
          onStartCall={callEnabled ? startCall : null}
          onImport={importFile}
          onDelete={deleteSession}
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
  const { status, origin } = detail.session
  if (status === 'calling') {
    return origin === 'local'
      ? <RecordingOpenView detail={detail} onError={onError} />
      : <CallLinksView detail={detail} onError={onError} />
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
