import { useEffect, useState } from 'react'
import { api, fmtTime, type SessionDetail } from '../api'
import { onServerEvent, sendMarker } from '../socket'

/** Recording remote control: hold SPACE (or the big button) to mark a span.
 * The backend stamps times against its own recording clock — this view only
 * sends key-down / key-up. */
export function RecordView({ detail, onError }: {
  detail: SessionDetail
  onError: (e: string) => void
}) {
  const id = detail.session.id
  const interrupted = detail.session.status === 'interrupted'
  const [clock, setClock] = useState(detail.recordingPosition ?? 0)
  const [marking, setMarking] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => onServerEvent((e) => {
    if (e.type === 'clock' && e.sessionId === id && e.positionS != null) setClock(e.positionS)
  }), [id])

  useEffect(() => {
    if (interrupted) return
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      e.preventDefault()
      setMarking(true)
      sendMarker('down', id)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      e.preventDefault()
      setMarking(false)
      sendMarker('up', id)
    }
    // window blur mid-hold: close the marker rather than leaving it dangling
    const blur = () => {
      setMarking(false)
      sendMarker('up', id)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [id, interrupted])

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try { await fn() } catch (e) { onError(String(e)) } finally { setBusy(false) }
  }

  const okMarkers = detail.markers.filter((m) => m.flag !== 'discarded')

  if (interrupted) {
    return (
      <main className="record interrupted">
        <h1>Recording was interrupted</h1>
        <p className="muted">
          The backend went down mid-recording. Everything captured so far is safe
          ({okMarkers.length} markers). The downtime will show as a flagged gap.
        </p>
        <div className="row">
          <button className="primary big" disabled={busy} onClick={act(() => api.resume(id))}>
            ● Resume recording
          </button>
          <button className="big" disabled={busy} onClick={act(() => api.finalize(id))}>
            ■ Finalize what exists
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className={`record ${marking ? 'marking' : ''}`}>
      <div className="clock">{fmtTime(clock)}</div>
      <div className="marker-count">{okMarkers.length} markers</div>
      <button
        className={`hold big ${marking ? 'active' : ''}`}
        onPointerDown={() => { setMarking(true); sendMarker('down', id) }}
        onPointerUp={() => { setMarking(false); sendMarker('up', id) }}
        onPointerLeave={() => { if (marking) { setMarking(false); sendMarker('up', id) } }}
      >
        {marking ? '◉ MARKING…' : 'hold SPACE (or this button) to mark'}
      </button>
      <button className="danger" disabled={busy} onClick={act(() => api.stop(id))}>
        ■ Stop &amp; transcribe
      </button>
    </main>
  )
}
