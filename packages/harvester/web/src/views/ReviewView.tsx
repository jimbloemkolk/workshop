import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Insight, type SessionDetail, type Transcript } from '../api'
import { useRangePlayer, type RangePlayer } from '../audio'
import { SnippetPlayer } from '../components/SnippetPlayer'

/** Insight cards render in conversation order, not creation/id order —
 * otherwise a just-created selection-snippet (see createFromSelection below)
 * would land at the bottom of the pane even when it quotes the very first
 * sentence. Pure and side-effect-free: returns a new array (Array.prototype.
 * sort mutates in place, and callers pass `detail.insights` straight from
 * props — mutating that would be a prop-mutation bug), never touches its
 * input. Exported directly for unit testing. */
export function sortByAppearance(insights: Insight[]): Insight[] {
  return [...insights].sort((a, b) =>
    a.startWord - b.startWord || a.endWord - b.endWord || a.id - b.id)
}

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
      // No insight selected and not building a new one: click-to-jump is
      // only the primary interaction WHILE something is actually playing —
      // paused/idle, a plain click does nothing at all, so the text stays
      // freely selectable for the selection→snippet chip instead (dragging
      // to select while mid-playback still works too, per the guard on the
      // span's own onClick; this only governs the plain-click case here).
      if (player.playingKey == null) return
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

  // Second path to the exact same result as the two-click "+ new insight"
  // flow above — reuses api.manualInsight, not a parallel implementation.
  // manualInsight's response already carries the freshly-created insight, so
  // there's no need to wait for a second round-trip just to find its id:
  // diff against the insight ids we already knew about to select the new
  // card immediately (the two-click flow never bothered to auto-select,
  // this one does, per spec).
  const createFromSelection = async (startWord: number, endWord: number) => {
    setBusy(true)
    try {
      const existingIds = new Set(insights.map((i) => i.id))
      const newDetail = await api.manualInsight(id, startWord, endWord)
      const created = newDetail.insights.find((i) => !existingIds.has(i.id))
      setNewModeOn(false)
      if (created) setSelected(created.id)
      refresh()
    } catch (e) { onError(String(e)) } finally { setBusy(false) }
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

  // Card order in the pane follows the conversation, not creation/id order —
  // otherwise a just-created selection-snippet (see createFromSelection)
  // lands at the bottom even when it quotes the very first sentence.
  const sortedInsights = useMemo(() => sortByAppearance(insights), [insights])

  // Cursor-only signal for TranscriptPane, so the click-vs-select mode isn't
  // invisible: true in exactly the state where onWordClick's own "no
  // selection, not playing" branch does nothing at all (see there) — new-
  // insight mode and editing a selected insight's range keep the normal
  // pointer cursor in both playback states, since clicking still does
  // something in those modes regardless of whether audio is playing.
  const wordsAreSelectable = !newModeOn && !current && player.playingKey == null

  return (
    <main className="review">
      <div className="session-bar">
        <SnippetPlayer
          player={player}
          playerKey="session"
          start={0}
          end={detail.session.durationS}
          full
          sessionId={id}
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
            selectable={wordsAreSelectable}
            onCreateFromSelection={createFromSelection}
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
        {sortedInsights.map((i) => (
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

/** Word range (in transcript word indexes) a text selection touches, or null
 * if the selection doesn't overlap any word span at all. Deliberately NOT
 * "walk up from anchorNode/focusNode to the nearest [data-word-index]" —
 * that fails whenever either endpoint lands outside a word span (dragging
 * from the now-unselectable speaker column, from inter-segment whitespace,
 * or past the last word), which is exactly one of the edge cases this needs
 * to handle. Instead: ask the Range itself (which normalizes start/end to
 * document order regardless of drag direction, so backwards selections need
 * no special-casing) which indexed word spans it actually intersects, across
 * every segment at once (so multi-segment selections fall out for free) —
 * min/max of whatever's touched is the range, and touching nothing at all is
 * the only case that returns null. */
function wordRangeFromSelection(sel: Selection): { start: number; end: number; rect: DOMRect } | null {
  if (sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  let start = Infinity
  let end = -Infinity
  for (const el of document.querySelectorAll<HTMLElement>('[data-word-index]')) {
    if (!range.intersectsNode(el)) continue
    const idx = Number(el.dataset.wordIndex)
    if (idx < start) start = idx
    if (idx + 1 > end) end = idx + 1
  }
  if (start > end) return null
  const rects = range.getClientRects()
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect()
  return { start, end, rect }
}

function TranscriptPane({
  transcript, speakerName, highlight, pendingStart, onWordClick, playheadS, isPlaying, selectable,
  onCreateFromSelection,
}: {
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
  /** Cursor-only: true exactly when a plain word click does nothing (no
   * insight selected, not building one, nothing playing) — swaps the
   * pointer cursor for a text cursor so "clicking does nothing here, but
   * you can select" isn't invisible. Doesn't gate any actual behavior;
   * onWordClick's own logic (in ReviewView) already decides that. */
  selectable: boolean
  onCreateFromSelection: (startWord: number, endWord: number) => void
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

  // "Select spoken text → create a snippet" chip. One settle-debounced
  // selectionchange listener drives both the drag-selection path and (via
  // Escape/scroll/click-elsewhere) dismissal — deliberately not a separate
  // mouseup listener too: mouseup's own selectionchange has already fired by
  // the time it's dispatched, so the debounce timer set by that last event
  // already covers "drag just ended," with no double-handling needed. The
  // 150ms debounce is what keeps this from flickering on every intermediate
  // selectionchange while the user is still dragging.
  const [chip, setChip] = useState<{ start: number; end: number; x: number; y: number } | null>(null)
  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const settle = () => {
      const sel = window.getSelection()
      const found = sel ? wordRangeFromSelection(sel) : null
      setChip(found ? { start: found.start, end: found.end, x: found.rect.right, y: found.rect.bottom } : null)
    }
    const onSelectionChange = () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, 150)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setChip(null) }
    const onScroll = () => setChip(null)
    // Dismiss on any click outside the chip itself (the chip's own mousedown
    // handler stops propagation before this ever sees it) — including the
    // mousedown that STARTS a new drag, which is correct: that selection's
    // own settle() will show a fresh, correctly-positioned chip afterward.
    const onMouseDown = () => setChip(null)
    // Right-click with an active selection shows the same chip instead of
    // the browser menu; without one, the native menu is left alone.
    const onContextMenu = (e: MouseEvent) => {
      const sel = window.getSelection()
      const found = sel ? wordRangeFromSelection(sel) : null
      if (!found) return
      e.preventDefault()
      setChip({ start: found.start, end: found.end, x: found.rect.right, y: found.rect.bottom })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    // capture: scroll doesn't bubble, but it does fire on ancestors in the
    // capture phase — this catches the transcript pane's own scroll without
    // needing a ref to that element (owned by ReviewView, not this component).
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('contextmenu', onContextMenu)
    return () => {
      if (settleTimer) clearTimeout(settleTimer)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

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
          </span>
          <span className={`segment-words${selectable ? ' selectable' : ''}`}>
            {(bySegment.get(seg.id) ?? []).map((w) => {
              const inHighlight = highlight != null &&
                w.index >= highlight.startWord && w.index < highlight.endWord
              const isPending = pendingStart === w.index
              const isNowWord = w.index === activeWordIndex
              return (
                <span
                  key={w.index}
                  data-word-index={w.index}
                  className={`word${inHighlight ? ' hl' : ''}${isPending ? ' pending' : ''}${w.aligned ? '' : ' unaligned'}${isNowWord ? ' now-word' : ''}`}
                  onClick={(e) => {
                    // A drag-selection's terminating mouseup can also fire a
                    // click on that same word — with an active (non-collapsed)
                    // selection, word-click's own effects (seeking playback,
                    // moving an insight's boundary) must be suppressed, or
                    // just trying to select text would also jump playback.
                    if (window.getSelection()?.isCollapsed === false) return
                    onWordClick(w.index, e.shiftKey)
                  }}
                >
                  {w.text}{' '}
                </span>
              )
            })}
          </span>
        </p>
      ))}
      {chip && (
        <div
          className="selection-chip"
          style={{ left: chip.x, top: chip.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            const { start, end } = chip
            setChip(null)
            window.getSelection()?.removeAllRanges()
            onCreateFromSelection(start, end)
          }}
        >
          ✚ snippet
        </div>
      )}
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
