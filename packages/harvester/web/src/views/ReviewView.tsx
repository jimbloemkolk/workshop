import { useEffect, useMemo, useState } from 'react'
import { api, type Insight, type SessionDetail, type Transcript } from '../api'
import { useRangePlayer } from '../audio'

/** Review: transcript on the left, proposals on the right. Click a word to
 * move the selected insight's start, shift-click to move its end; in
 * new-insight mode the same two clicks create a manual insight. */
export function ReviewView({ detail, refresh, onError }: {
  detail: SessionDetail
  refresh: () => void
  onError: (e: string) => void
}) {
  const id = detail.session.id
  const player = useRangePlayer(id)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [newMode, setNewMode] = useState<{ start: number | null }>({ start: null })
  const [newModeOn, setNewModeOn] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.transcript(id).then(setTranscript).catch((e) => onError(String(e)))
  }, [id, onError])

  const insights = detail.insights
  const current = insights.find((i) => i.id === selected) ?? null

  // review-attention flags are derived, never stored (IMPLEMENTATION):
  // a proposal overlapping a connection gap, or a probably-forgotten toggle
  const attention = useMemo(() => {
    const map = new Map<number, string[]>()
    if (!transcript) return map
    const markerById = new Map(detail.markers.map((m) => [m.id, m]))
    const spanById = new Map(detail.harvestSpans.map((s) => [s.id, s]))
    for (const i of detail.insights) {
      const flags: string[] = []
      const inRange = transcript.words.slice(i.startWord, i.endWord).filter((w) => w.start != null)
      const startS = inRange[0]?.start
      const endS = inRange.at(-1)?.end
      if (startS != null && endS != null && detail.gaps.some((g) => g.startS < endS && startS < g.endS)) {
        flags.push('overlaps gap')
      }
      const span = i.harvestSpanId != null ? spanById.get(i.harvestSpanId) : null
      if (span?.memberIds.some((id) => {
        const m = markerById.get(id)
        return m?.mode === 'toggle' && m.endS != null && m.endS - m.startS > 600
      })) {
        flags.push('long toggle — forgotten?')
      }
      if (flags.length > 0) map.set(i.id, flags)
    }
    return map
  }, [detail, transcript])

  const speakerName = useMemo(() => {
    const names = new Map(detail.participants.map((p) => [p.id, p.name]))
    return new Map(detail.speakers.map((s) => [
      s.label,
      (s.participantId != null ? names.get(s.participantId) : null) ?? s.label,
    ]))
  }, [detail.participants, detail.speakers])

  const wordRangeTimes = (startWord: number, endWord: number): [number, number | null] => {
    if (!transcript) return [0, null]
    const inRange = transcript.words.slice(startWord, endWord).filter((w) => w.start != null)
    const start = inRange[0]?.start ?? 0
    const end = inRange.at(-1)?.end ?? null
    return [Math.max(0, start - 0.2), end != null ? end + 0.2 : null]
  }

  const patch = async (insightId: number, p: Parameters<typeof api.updateInsight>[1]) => {
    try {
      await api.updateInsight(insightId, p)
      refresh()
    } catch (e) { onError(String(e)) }
  }

  const onWordClick = async (index: number, shift: boolean) => {
    if (newModeOn) {
      if (newMode.start == null) {
        setNewMode({ start: index })
      } else {
        const [a, b] = [Math.min(newMode.start, index), Math.max(newMode.start, index) + 1]
        setNewModeOn(false)
        setNewMode({ start: null })
        setBusy(true)
        try {
          await api.manualInsight(id, a, b)
          refresh()
        } catch (e) { onError(String(e)) } finally { setBusy(false) }
      }
      return
    }
    if (!current) return
    if (shift) {
      if (index >= current.startWord) void patch(current.id, { endWord: index + 1 })
    } else if (index < current.endWord) {
      void patch(current.id, { startWord: index })
    }
  }

  const doExport = async () => {
    setBusy(true)
    try {
      const r = await api.export(id)
      setReport(`exported ${r.exported} notes + ${r.clips} clips → ${r.folder}` +
        (r.warnings.length ? ` · warnings: ${r.warnings.join('; ')}` : ''))
      refresh()
    } catch (e) { onError(String(e)) } finally { setBusy(false) }
  }

  const reharvest = async () => {
    if (!confirm('Re-harvest replaces all still-proposed insights. Accepted/rejected survive.')) return
    try { await api.harvest(id) } catch (e) { onError(String(e)) }
  }

  const acceptedCount = insights.filter((i) => i.status === 'accepted').length

  return (
    <main className="review">
      <section className="transcript">
        {transcript ? (
          <TranscriptPane
            transcript={transcript}
            speakerName={speakerName}
            highlight={current}
            pendingStart={newModeOn ? newMode.start : null}
            onWordClick={onWordClick}
          />
        ) : <p className="muted">loading transcript…</p>}
      </section>
      <aside className="insights">
        <div className="row toolbar">
          <button
            className={newModeOn ? 'primary' : ''}
            onClick={() => { setNewModeOn(!newModeOn); setNewMode({ start: null }); setSelected(null) }}
          >
            {newModeOn
              ? (newMode.start == null ? 'click first word…' : 'click last word…')
              : '+ new insight'}
          </button>
          <button onClick={reharvest}>↻ re-harvest</button>
          <button className="primary" disabled={busy || acceptedCount === 0} onClick={doExport}>
            ⇪ export {acceptedCount} to vault
          </button>
        </div>
        {report && <p className="report">{report}</p>}
        {insights.length === 0 && <p className="muted">No proposals yet.</p>}
        {insights.map((i) => (
          <InsightCard
            key={i.id}
            insight={i}
            attention={attention.get(i.id) ?? []}
            selected={i.id === selected}
            onSelect={() => { setSelected(i.id); setNewModeOn(false) }}
            onPlay={() => player.playRange(...wordRangeTimes(i.startWord, i.endWord))}
            onPatch={(p) => patch(i.id, p)}
          />
        ))}
      </aside>
    </main>
  )
}

function TranscriptPane({ transcript, speakerName, highlight, pendingStart, onWordClick }: {
  transcript: Transcript
  speakerName: Map<string, string>
  highlight: Insight | null
  pendingStart: number | null
  onWordClick: (index: number, shift: boolean) => void
}) {
  const bySegment = useMemo(() => {
    const map = new Map<number, typeof transcript.words>()
    for (const w of transcript.words) {
      const list = map.get(w.segment_id) ?? []
      list.push(w)
      map.set(w.segment_id, list)
    }
    return map
  }, [transcript])

  return (
    <>
      {transcript.segments.map((seg) => (
        <p key={seg.id} className="segment">
          <span className="speaker-tag">
            {seg.speaker ? speakerName.get(seg.speaker) ?? seg.speaker : '?'}
          </span>{' '}
          {(bySegment.get(seg.id) ?? []).map((w) => {
            const inHighlight = highlight != null &&
              w.index >= highlight.startWord && w.index < highlight.endWord
            const isPending = pendingStart === w.index
            return (
              <span
                key={w.index}
                className={`word${inHighlight ? ' hl' : ''}${isPending ? ' pending' : ''}${w.aligned ? '' : ' unaligned'}`}
                onClick={(e) => onWordClick(w.index, e.shiftKey)}
              >
                {w.text}{' '}
              </span>
            )
          })}
        </p>
      ))}
    </>
  )
}

function InsightCard({ insight, attention, selected, onSelect, onPlay, onPatch }: {
  insight: Insight
  attention: string[]
  selected: boolean
  onSelect: () => void
  onPlay: () => void
  onPatch: (p: Parameters<typeof api.updateInsight>[1]) => void
}) {
  const i = insight
  return (
    <div className={`card ${i.status}${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="row">
        <span className={`origin origin-${i.origin}`}>{i.origin}</span>
        {!i.anchored && <span className="badge warn">unanchored</span>}
        {attention.map((a) => <span key={a} className="badge warn">{a}</span>)}
        <span className={`badge ${i.status}`}>{i.status}</span>
      </div>
      <strong>{i.title}</strong>
      <blockquote>{i.quote}</blockquote>
      {i.insight && <p className="insight-text">{i.insight}</p>}
      {i.supporting.length > 0 && (
        <details>
          <summary>{i.supporting.length} supporting quote(s)</summary>
          {i.supporting.map((s) => (
            <blockquote key={s.id} className="support">
              {s.quote}
              {s.why && <em> — {s.why}</em>}
            </blockquote>
          ))}
        </details>
      )}
      {selected && (
        <div className="row actions" onClick={(e) => e.stopPropagation()}>
          <button onClick={onPlay}>▶ play</button>
          <button onClick={() => onPatch({ startWord: i.startWord - 1 })} title="start 1 word earlier">⟨−</button>
          <button onClick={() => onPatch({ startWord: i.startWord + 1 })} title="start 1 word later">⟨+</button>
          <button onClick={() => onPatch({ endWord: i.endWord - 1 })} title="end 1 word earlier">−⟩</button>
          <button onClick={() => onPatch({ endWord: i.endWord + 1 })} title="end 1 word later">+⟩</button>
          <button className="primary" onClick={() => onPatch({ status: 'accepted' })}>✓ accept</button>
          <button className="danger" onClick={() => onPatch({ status: 'rejected' })}>✕ reject</button>
        </div>
      )}
      {selected && (
        <p className="muted hint">click a word = move start · shift-click = move end</p>
      )}
    </div>
  )
}
