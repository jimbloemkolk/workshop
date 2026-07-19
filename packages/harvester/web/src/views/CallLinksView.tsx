import { useEffect, useState } from 'react'
import { api, type JoinLink, type SessionDetail } from '../api'

/** The creator's view of a `calling` session: two labeled join links.
 * Tap your own, copy the other into any messenger. Links are re-minted on
 * each load (12 h tokens), so a refresh always works. */
export function CallLinksView({ detail, onError }: {
  detail: SessionDetail
  onError: (e: string) => void
}) {
  const id = detail.session.id
  const [links, setLinks] = useState<JoinLink[]>([])
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    api.call.links(id).then((r) => setLinks(r.links)).catch((e) => onError(String(e)))
  }, [id, onError])

  const copy = async (link: JoinLink) => {
    await navigator.clipboard.writeText(link.url)
    setCopied(link.identity)
    setTimeout(() => setCopied(null), 1500)
  }

  const endCall = async () => {
    if (!confirm('End the call for everyone and start processing?')) return
    try { await api.call.end(id) } catch (e) { onError(String(e)) }
  }

  return (
    <main className="call-links">
      <h1>Call is open</h1>
      <p className="muted">
        Join as yourself, send the other link. Recording starts when a
        participant joins; the call ends from the in-call screen.
      </p>
      {links.map((l) => (
        <div className="card" key={l.identity}>
          <strong>{l.name}</strong>
          <div className="row">
            <button className="primary" onClick={() => window.open(l.url, '_blank')}>
              ▶ join as {l.name}
            </button>
            <button onClick={() => copy(l)}>
              {copied === l.identity ? '✓ copied' : '⧉ copy link'}
            </button>
          </div>
        </div>
      ))}
      <div className="row">
        <button className="danger" onClick={endCall}>✕ End call &amp; process</button>
      </div>
    </main>
  )
}
