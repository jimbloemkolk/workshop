import { useState, type DragEvent } from 'react'
import { fmtTime, type Session } from '../api'

export function SessionList({ sessions, onOpen, onStart, onImport, importing }: {
  sessions: Session[]
  onOpen: (id: string) => void
  onStart: () => void
  onImport: (file: File) => void
  importing: boolean
}) {
  const [dragging, setDragging] = useState(false)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onImport(file)
  }

  return (
    <main
      className={`list ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false) }}
      onDrop={onDrop}
    >
      <div className="row">
        <button className="primary big" onClick={onStart}>● Start recording</button>
        <span className="dropzone">
          {importing ? 'uploading…' : 'or drop a recording file anywhere to import it'}
        </span>
      </div>
      {sessions.length === 0 && <p className="muted">No sessions yet.</p>}
      <ul>
        {sessions.map((s) => (
          <li key={s.id} onClick={() => onOpen(s.id)}>
            <span className="title">{s.title}</span>
            <span className={`status status-${s.status}`}>{s.status}</span>
            <span className="muted">
              {new Date(s.createdAt).toLocaleString()} · {fmtTime(s.durationS)}
            </span>
          </li>
        ))}
      </ul>
    </main>
  )
}
