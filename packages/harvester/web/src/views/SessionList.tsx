import { useState, type DragEvent, type MouseEvent } from 'react'
import { fmtTime, type Session } from '../api'

export function SessionList({ sessions, onOpen, onStart, onStartCall, onImport, onDelete, importing }: {
  sessions: Session[]
  onOpen: (id: string) => void
  onStart: (() => void) | null
  onStartCall: (() => void) | null
  onImport: (file: File) => void
  onDelete: (id: string) => void
  importing: boolean
}) {
  const [dragging, setDragging] = useState(false)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onImport(file)
  }

  const remove = (e: MouseEvent, s: Session) => {
    e.stopPropagation()
    if (!confirm(`Delete "${s.title}"? This cannot be undone.`)) return
    onDelete(s.id)
  }

  const ongoing = sessions.filter((s) => s.status === 'calling')
  const rest = sessions.filter((s) => s.status !== 'calling')

  return (
    <main
      className={`list ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false) }}
      onDrop={onDrop}
    >
      <div className="row">
        {onStart && (
          <button className="primary big" onClick={onStart}>● Start recording</button>
        )}
        {onStartCall && (
          <button className="primary big" onClick={onStartCall}>📞 Start a call</button>
        )}
        {!onStart && !onStartCall && (
          <span className="muted">
            set LIVEKIT_URL to enable recording — import a file below to work with past sessions
          </span>
        )}
        <span className="dropzone">
          {importing ? 'uploading…' : 'or drop a recording file anywhere to import it'}
        </span>
      </div>
      {ongoing.length > 0 && (
        <section className="ongoing">
          <h2 className="section-label caps">Ongoing calls</h2>
          <ul>
            {ongoing.map((s) => (
              <li key={s.id} onClick={() => onOpen(s.id)}>
                <span className="title">{s.title}</span>
                <span className={`status status-${s.status}`}>{s.status}</span>
                <span className="muted">{new Date(s.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sessions.length === 0 && <p className="muted">No sessions yet.</p>}
      <ul>
        {rest.map((s) => (
          <li key={s.id} onClick={() => onOpen(s.id)}>
            <span className="title">{s.title}</span>
            <span className={`status status-${s.status}`}>{s.status}</span>
            <span className="muted">
              {new Date(s.createdAt).toLocaleString()} · {fmtTime(s.durationS)}
            </span>
            <button className="danger small" onClick={(e) => remove(e, s)}>✕ delete</button>
          </li>
        ))}
      </ul>
    </main>
  )
}
