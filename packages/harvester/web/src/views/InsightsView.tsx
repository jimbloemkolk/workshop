import { useEffect, useRef, useState } from 'react'
import { api, type OceanInsight } from '../api'
import { onServerEvent } from '../socket'

/** The ocean: every accepted insight, newest-spoken first, with a search box
 * that fuzzy-matches title, description and the source quote (ranking happens
 * on the backend). Export projects exactly the filtered set into a zip. The
 * source link on each card (bottom-right) travels back to the conversation the
 * insight originated from — the card itself is not clickable. */
export function InsightsView({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [insights, setInsights] = useState<OceanInsight[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [report, setReport] = useState<string | null>(null)

  // Latest-wins: a slow response for an old query must not overwrite a newer
  // one. Bump a token per request and ignore anything but the most recent.
  const reqToken = useRef(0)
  const load = (q: string) => {
    const token = ++reqToken.current
    api.insights(q).then((rows) => {
      if (token !== reqToken.current) return
      setInsights(rows)
      setError(null)
    }).catch((e) => {
      if (token !== reqToken.current) return
      setError(String(e))
    }).finally(() => {
      if (token === reqToken.current) setLoading(false)
    })
  }

  // Debounce keystrokes so search hits the endpoint on a settle, not per key.
  useEffect(() => {
    const t = setTimeout(() => load(query), 200)
    return () => clearTimeout(t)
  }, [query])

  // A newly accepted snippet (or a deleted session) changes the ocean — refetch
  // for the current query when the server says something moved.
  useEffect(() => onServerEvent((e) => {
    if (e.type === 'session' || e.type === 'session-deleted') load(query)
  }), [query])

  // Export exactly what's on screen — the same query drives the download.
  const doExport = async () => {
    setExporting(true)
    setReport(null)
    try {
      const r = await api.exportOcean(query)
      setReport(`downloaded ${r.filename} — ${r.exported} note${r.exported === 1 ? '' : 's'} + ${r.clips} clip${r.clips === 1 ? '' : 's'}` +
        (r.warnings.length ? ` · warnings: ${r.warnings.join('; ')}` : ''))
    } catch (e) { setError(String(e)) } finally { setExporting(false) }
  }

  return (
    <main className="list ocean">
      <div className="ocean-search">
        <input
          type="search"
          className="ocean-input"
          placeholder="Search the ocean — titles, descriptions, quotes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button
          className="primary ocean-export"
          disabled={exporting || insights.length === 0}
          onClick={doExport}
          title={query ? 'download the filtered insights as a zip' : 'download the whole ocean as a zip'}
        >
          ⇪ download {insights.length} as zip
        </button>
      </div>

      {report && <p className="ocean-report" onClick={() => setReport(null)}>{report}</p>}
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      {!loading && insights.length === 0 && (
        <p className="muted">
          {query
            ? `Nothing in the ocean matches “${query}”.`
            : 'The ocean is empty. Accept a snippet in a review to drop the first insight in.'}
        </p>
      )}

      <ul className="insights">
        {insights.map((i) => (
          <InsightCard key={i.id} insight={i} onOpenSession={onOpenSession} />
        ))}
      </ul>
    </main>
  )
}

function InsightCard({ insight, onOpenSession }: {
  insight: OceanInsight
  onOpenSession: (id: string) => void
}) {
  const { sessionId, sessionTitle, quote, snippets } = insight

  return (
    <li className="insight-card">
      <h3 className="insight-title">{insight.title}</h3>
      <p className="insight-desc">{insight.description}</p>
      {quote && <blockquote className="insight-quote">“{quote}”</blockquote>}
      {snippets.length > 1 && (
        <details className="insight-snippets">
          <summary>{snippets.length} snippets</summary>
          {snippets.map((s) => (
            <blockquote key={s.id} className="insight-quote">“{s.quote}”</blockquote>
          ))}
        </details>
      )}
      <div className="insight-meta">
        <span className="spoken">{new Date(insight.spokenAt).toLocaleString()}</span>
        {sessionId ? (
          <button
            className="insight-source"
            onClick={() => onOpenSession(sessionId)}
            title="back to the conversation this came from"
          >
            ↩ {sessionTitle ?? 'conversation'}
          </button>
        ) : (
          <span className="muted">source removed</span>
        )}
      </div>
    </li>
  )
}
