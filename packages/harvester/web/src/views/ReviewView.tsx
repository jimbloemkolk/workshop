import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Insight, type SessionDetail, type Transcript } from '../api'
import { useRangePlayer, type RangePlayer } from '../audio'
import { SnippetPlayer } from '../components/SnippetPlayer'

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

  // Unaligned words (w.start == null) have no time of their own — walk
  // outward by index until an aligned neighbor turns up. null only when the
  // transcript has no aligned words at all, in which case the caller no-ops.
  const wordPlayTime = (index: number): number | null => {
    if (!transcript) return null
    const words = transcript.words
    const direct = words[index]?.start
    if (direct != null) return direct
    for (let d = 1; d < words.length; d++) {
      const left = words[index - d]?.start
      if (left != null) return left
      const right = words[index + d]?.start
      if (right != null) return right
    }
    return null
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
    if (!current) {
      // No insight selected and not building a new one: a plain click is
      // free to mean "play from here" instead — jump the full-session
      // player to this word and start it, taking over from whatever
      // (session bar or an insight snippet) was playing before.
      const atS = wordPlayTime(index)
      if (atS != null) player.playFrom('session', 0, detail.session.durationS, atS)
      return
    }
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
      <div className="session-bar">
        <SnippetPlayer
          player={player}
          playerKey="session"
          start={0}
          end={detail.session.durationS}
          full
        />
      </div>
      <section className="transcript">
        {transcript ? (
          <TranscriptPane
            transcript={transcript}
            speakerName={speakerName}
            highlight={current}
            pendingStart={newModeOn ? newMode.start : null}
            onWordClick={onWordClick}
            playheadS={player.activeKey != null ? player.position : null}
            isPlaying={player.playingKey != null}
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
            player={player}
            range={wordRangeTimes(i.startWord, i.endWord)}
            fallbackDuration={detail.session.durationS}
            onPatch={(p) => patch(i.id, p)}
          />
        ))}
      </aside>
    </main>
  )
}

/** Sorted, non-overlapping [startS, endS) bounds per segment — the sort key
 * is a separate array from render order (transcript.segments is left
 * untouched) purely so `findSegmentAt` can binary-search it.
 *
 * Returns the segment containing `t`, or — in a gap between sentences —
 * the upcoming one (smallest startS > t), so the highlight anticipates the
 * next line during silence instead of going dark. Before the first segment,
 * that's the first segment; after the last segment's end, there's nothing
 * upcoming and this returns null. */
function findSegmentAt(bounds: { id: number; startS: number; endS: number }[], t: number): number | null {
  let lo = 0
  let hi = bounds.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = bounds[mid]
    if (t < b.startS) hi = mid - 1
    else if (t >= b.endS) lo = mid + 1
    else return b.id
  }
  // Not inside any segment: the loop's invariant leaves lo at the
  // insertion point — the first index whose startS > t — which is exactly
  // the upcoming segment. lo === bounds.length past the last segment.
  return bounds[lo]?.id ?? null
}

function TranscriptPane({ transcript, speakerName, highlight, pendingStart, onWordClick, playheadS, isPlaying }: {
  transcript: Transcript
  speakerName: Map<string, string>
  highlight: Insight | null
  pendingStart: number | null
  onWordClick: (index: number, shift: boolean) => void
  /** Absolute recording time of whatever's loaded into the shared player
   * (session bar or an insight snippet — both live in this view), or null
   * when nothing has ever played. Drives the "now speaking" highlight. */
  playheadS: number | null
  isPlaying: boolean
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

  // Precomputed once per transcript (not per position tick): min/max timed
  // word per segment, sorted by start so findSegmentAt can binary-search
  // instead of scanning every word on every rAF-driven position update.
  const segmentBounds = useMemo(() => {
    const bounds: { id: number; startS: number; endS: number }[] = []
    for (const seg of transcript.segments) {
      let startS: number | null = null
      let endS: number | null = null
      for (const w of bySegment.get(seg.id) ?? []) {
        if (w.start != null) startS = startS == null ? w.start : Math.min(startS, w.start)
        if (w.end != null) endS = endS == null ? w.end : Math.max(endS, w.end)
      }
      if (startS != null && endS != null) bounds.push({ id: seg.id, startS, endS })
    }
    bounds.sort((a, b) => a.startS - b.startS)
    return bounds
  }, [transcript, bySegment])

  const activeSegmentId = playheadS != null ? findSegmentAt(segmentBounds, playheadS) : null
  // Karaoke word within the active segment — a handful of words, so a plain
  // scan (no memoization) is cheap enough to just do inline. Needs no gap
  // handling of its own: when activeSegmentId is the *upcoming* segment
  // during a silence, playheadS is still before all of its words' starts,
  // so this naturally comes up empty — only the segment wash shows, no
  // word is underlined until it's actually being spoken.
  const activeWordIndex = (() => {
    if (activeSegmentId == null || playheadS == null) return null
    for (const w of bySegment.get(activeSegmentId) ?? []) {
      if (w.start != null && w.end != null && playheadS >= w.start && playheadS < w.end) return w.index
    }
    return null
  })()

  // Auto-scroll fires at most once per (segment, "started playing")
  // transition, tracked via lastScrolledRef rather than relying solely on
  // the effect's dependency array — activeKey/position update synchronously
  // from playFrom()/seek(), but playingKey only flips once the element's
  // native 'play' event lands a task later, so a click-to-play into a new
  // segment can commit two separate renders: one where activeSegmentId has
  // already changed but isPlaying is still stale-false, then another where
  // isPlaying turns true but activeSegmentId is unchanged. Depending on
  // both and gating on "have we already scrolled *for this segment* while
  // playing" (not "did activeSegmentId change on *this* render") catches
  // whichever render actually has both pieces true, so a click on a
  // far/offscreen word still scrolls once playback starts. It also still
  // suppresses re-scrolling on a plain pause/resume of the same segment
  // (lastScrolledRef already matches), and still never scrolls for a scrub
  // while paused (isPlaying false skips before lastScrolledRef is touched) —
  // until play starts, at which point it scrolls once, which is desirable.
  const lastScrolledRef = useRef<number | null>(null)
  useEffect(() => {
    if (activeSegmentId == null || !isPlaying) return
    if (lastScrolledRef.current === activeSegmentId) return
    lastScrolledRef.current = activeSegmentId
    document.getElementById(`segment-${activeSegmentId}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeSegmentId, isPlaying])

  return (
    <>
      {transcript.segments.map((seg) => (
        <p
          key={seg.id}
          id={`segment-${seg.id}`}
          className={`segment${seg.id === activeSegmentId ? ' now-playing' : ''}`}
        >
          <span className="speaker-tag">
            {seg.speaker ? speakerName.get(seg.speaker) ?? seg.speaker : '?'}
          </span>{' '}
          {(bySegment.get(seg.id) ?? []).map((w) => {
            const inHighlight = highlight != null &&
              w.index >= highlight.startWord && w.index < highlight.endWord
            const isPending = pendingStart === w.index
            const isNowWord = w.index === activeWordIndex
            return (
              <span
                key={w.index}
                className={`word${inHighlight ? ' hl' : ''}${isPending ? ' pending' : ''}${w.aligned ? '' : ' unaligned'}${isNowWord ? ' now-word' : ''}`}
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

function InsightCard({ insight, attention, selected, onSelect, player, range, fallbackDuration, onPatch }: {
  insight: Insight
  attention: string[]
  selected: boolean
  onSelect: () => void
  player: RangePlayer
  range: [number, number | null]
  fallbackDuration: number | null
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
        <>
          <div className="row actions" onClick={(e) => e.stopPropagation()}>
            <SnippetPlayer
              player={player}
              playerKey={String(i.id)}
              start={range[0]}
              end={range[1]}
              fallbackDuration={fallbackDuration}
            />
          </div>
          <div className="row actions" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => onPatch({ startWord: i.startWord - 1 })} title="start 1 word earlier">⟨−</button>
            <button onClick={() => onPatch({ startWord: i.startWord + 1 })} title="start 1 word later">⟨+</button>
            <button onClick={() => onPatch({ endWord: i.endWord - 1 })} title="end 1 word earlier">−⟩</button>
            <button onClick={() => onPatch({ endWord: i.endWord + 1 })} title="end 1 word later">+⟩</button>
            <button className="primary" onClick={() => onPatch({ status: 'accepted' })}>✓ accept</button>
            <button className="danger" onClick={() => onPatch({ status: 'rejected' })}>✕ reject</button>
          </div>
        </>
      )}
      {selected && (
        <p className="muted hint">click a word = move start · shift-click = move end</p>
      )}
    </div>
  )
}
