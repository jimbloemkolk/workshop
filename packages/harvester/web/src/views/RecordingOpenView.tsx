import { useEffect, useState } from 'react'
import { api, type SessionDetail } from '../api'

/** A solo/table recording that's live — reached only if you navigate back to
 * the main app while it's running (the tab that started it already redirected
 * into /join). One re-mintable link to rejoin, plus the stop button. */
export function RecordingOpenView({ detail, onError }: {
  detail: SessionDetail
  onError: (e: string) => void
}) {
  const id = detail.session.id
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    api.call.links(id).then((r) => setUrl(r.links[0]?.url ?? null)).catch((e) => onError(String(e)))
  }, [id, onError])

  const stop = async () => {
    if (!confirm('Stop recording and start processing?')) return
    try { await api.call.end(id) } catch (e) { onError(String(e)) }
  }

  return (
    <main className="call-links">
      <h1>Recording in progress</h1>
      <p className="muted">
        Rejoin on this device, or stop and send it to transcription.
      </p>
      {url && (
        <div className="card">
          <div className="row">
            <button className="primary" onClick={() => window.open(url, '_blank')}>
              ▶ rejoin
            </button>
          </div>
        </div>
      )}
      <div className="row">
        <button className="danger" onClick={stop}>■ Stop &amp; transcribe</button>
      </div>
    </main>
  )
}
