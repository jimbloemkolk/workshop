import { useEffect, useState } from 'react'
import type { SessionDetail } from '../api'
import { onServerEvent } from '../socket'

export function PipelineView({ detail }: { detail: SessionDetail }) {
  const id = detail.session.id
  const [lines, setLines] = useState<string[]>([])
  const [harvest, setHarvest] = useState<{ step: string; done: number; total: number } | null>(null)

  useEffect(() => onServerEvent((e) => {
    if (e.sessionId !== id) return
    if (e.type === 'pipeline' && e.line) setLines((prev) => [...prev.slice(-14), e.line!])
    if (e.type === 'harvest' && e.step) {
      setHarvest({ step: e.step, done: e.done ?? 0, total: e.total ?? 1 })
    }
  }), [id])

  const harvesting = detail.session.status === 'harvesting'
  return (
    <main className="pipeline">
      <h1>{harvesting ? 'Harvesting insights…' : 'Transcribing…'}</h1>
      {harvesting && harvest && (
        <>
          <progress value={harvest.done} max={harvest.total} />
          <p>{harvest.step}</p>
        </>
      )}
      {!harvesting && (
        <pre className="log">{lines.join('\n') || 'waiting for the transcriber…'}</pre>
      )}
      <p className="muted">Safe to close this page — everything runs in the backend.</p>
    </main>
  )
}
