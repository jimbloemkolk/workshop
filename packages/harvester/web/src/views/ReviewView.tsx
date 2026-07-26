import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api, type Insight, type SessionDetail, type Transcript } from '../api'
import { useRangePlayer, type RangePlayer } from '../audio'
import { SnippetPlayer } from '../components/SnippetPlayer'

/** Insight cards render in conversation order (by their main snippet), not
 * creation/id order — otherwise a just-created selection-insight (see
 * createFromSelection below) would land at the bottom of the pane even when it
 * quotes the very first sentence. Pure and side-effect-free: returns a new
 * array (callers pass `detail.insights` straight from props — mutating that
 * would be a prop-mutation bug), never touches its input. Exported for tests. */
export function sortByAppearance(insights: Insight[]): Insight[] {
  return [...insights].sort((a, b) =>
    (a.main?.startWord ?? 0) - (b.main?.startWord ?? 0) ||
    (a.main?.endWord ?? 0) - (b.main?.endWord ?? 0) || a.id - b.id)
}

/** Review: transcript on the left, proposals on the right. Click a word to
 * move the selected insight's main-snippet start, shift-click to move its end;
 * in new-insight mode the same two clicks create a manual insight. */
export function ReviewView({ detail, refresh, onError }: {
  detail: SessionDetail
  refresh: () => void
  onError: (e: string) => void
}) {
  const id = detail.session.id
  const player = useRangePlayer(id)
  const transcriptRef = useRef<HTMLElement | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  // The selection carries where it came from, because that decides what has
  // to be brought into view: pick a card and you want its words; pick a
  // brace (or make an insight out of a text selection) and the words are
  // already under your eyes — it's the card, possibly scrolled out of its
  // list, that needs to come to you.
  const [selection, setSelection] = useState<{ id: number; focus: 'text' | 'card' } | null>(null)
  const selected = selection?.id ?? null
  const [newMode, setNewMode] = useState<{ start: number | null }>({ start: null })
  const [newModeOn, setNewModeOn] = useState(false)
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
      if (!i.main) continue
      const flags: string[] = []
      const inRange = transcript.words.slice(i.main.startWord, i.main.endWord).filter((w) => w.start != null)
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
      // freely selectable for the selection→insight chip instead (dragging
      // to select while mid-playback still works too, per the guard on the
      // span's own onClick; this only governs the plain-click case here).
      if (player.playingKey == null) return
      const atS = wordPlayTime(index)
      if (atS != null) player.playFrom('session', 0, detail.session.durationS, atS)
      return
    }
    if (current.main) {
      if (shift) {
        if (index >= current.main.startWord) void patch(current.id, { endWord: index + 1 })
      } else if (index < current.main.endWord) {
        void patch(current.id, { startWord: index })
      }
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
      if (created) setSelection({ id: created.id, focus: 'card' })
      refresh()
    } catch (e) { onError(String(e)) } finally { setBusy(false) }
  }

  const reharvest = async () => {
    if (!confirm('Re-harvest replaces all still-proposed insights. Accepted/rejected survive.')) return
    try { await api.harvest(id) } catch (e) { onError(String(e)) }
  }

  // Card order in the pane follows the conversation, not creation/id order —
  // otherwise a just-created selection-insight (see createFromSelection)
  // lands at the bottom even when it quotes the very first sentence.
  const sortedInsights = useMemo(() => sortByAppearance(insights), [insights])

  // Cursor-only signal for TranscriptPane, so the click-vs-select mode isn't
  // invisible: true in exactly the state where onWordClick's own "no
  // selection, not playing" branch does nothing at all (see there) — new-
  // insight mode and editing a selected insight's range keep the normal
  // pointer cursor in both playback states, since clicking still does
  // something in those modes regardless of whether audio is playing.
  const wordsAreSelectable = !newModeOn && !current && player.playingKey == null

  // Bring the far end of a new selection into view — which end depends on
  // where the selection came from (see `selection`). Keyed on the selection
  // object, deliberately: nudging the range with the ⟨− / +⟩ buttons also
  // repaints the highlight, and re-centering on every single-word step would
  // make trimming a boundary feel like the text was fighting back.
  useEffect(() => {
    if (!selection) return
    const target = selection.focus === 'text'
      ? transcriptRef.current?.querySelector('.word.hl')
      : document.querySelector(`.snippet-list [data-insight-id="${selection.id}"]`)
    target?.scrollIntoView({ block: selection.focus === 'text' ? 'center' : 'nearest', behavior: 'smooth' })
  }, [selection])

  // Every word any insight quotes, so the transcript can carry all of their
  // highlights at once instead of only the selected one's — the harvest
  // should be legible in the text itself while you read past it.
  const quotedWords = useMemo(() => {
    const words = new Set<number>()
    for (const i of insights) {
      if (!i.main) continue
      for (let w = i.main.startWord; w < i.main.endWord; w++) words.add(w)
    }
    return words
  }, [insights])

  // One brace per anchored insight, in the same conversation order the cards
  // are in — which is what keeps the braces from crossing: two lists in the
  // same order connect with parallel lines. `lane` staggers them across the
  // margin so neighbours don't share a vertical run and read as one line;
  // it's the position in the whole list, not among the visible ones, so a
  // brace never hops lanes just because another scrolled out of view.
  const links = useMemo(() => sortedInsights.flatMap((i, k) => i.main
    ? [{ id: i.id, title: i.title, startWord: i.main.startWord, endWord: i.main.endWord, lane: k % 4 }]
    : []), [sortedInsights])

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
      {/* What this conversation was about, in full — the overview list shows
          the same sentences clamped to two lines, and this is where you can
          actually read them. Absent until a harvest has written one. */}
      {detail.session.summary && (
        <p className="session-summary">{detail.session.summary}</p>
      )}
      <section className="transcript" ref={transcriptRef}>
        {transcript ? (
          <TranscriptPane
            transcript={transcript}
            speakerName={speakerName}
            highlight={current}
            quotedWords={quotedWords}
            pendingStart={newModeOn ? newMode.start : null}
            onWordClick={onWordClick}
            playheadS={player.activeKey != null ? player.position : null}
            isPlaying={player.playingKey != null}
            selectable={wordsAreSelectable}
            onCreateFromSelection={createFromSelection}
          />
        ) : <p className="muted">loading transcript…</p>}
      </section>
      <aside className="snippets">
        <div className="row toolbar">
          <button
            className={newModeOn ? 'primary' : ''}
            onClick={() => { setNewModeOn(!newModeOn); setNewMode({ start: null }); setSelection(null) }}
          >
            {newModeOn
              ? (newMode.start == null ? 'click first word…' : 'click last word…')
              : '+ new insight'}
          </button>
          <button onClick={reharvest}>↻ re-harvest</button>
        </div>
        {/* The one scrollport that isn't the page: hunting for a card in a
            long list shouldn't mean scrolling the conversation past it. The
            toolbar stays outside it, so it never scrolls away. */}
        <div className="snippet-list">
          {insights.length === 0 && <p className="muted">No proposals yet.</p>}
          {sortedInsights.map((i) => (
            <InsightCard
              key={i.id}
              insight={i}
              attention={attention.get(i.id) ?? []}
              selected={i.id === selected}
              // Click the selected card again to let it go: the highlight,
              // the brace and the word-click editing mode all hang off this
              // selection, and clicking the card you're already on is the
              // obvious way to ask for the plain transcript back.
              onSelect={() => {
                setSelection(i.id === selected ? null : { id: i.id, focus: 'text' })
                setNewModeOn(false)
              }}
              player={player}
              range={wordRangeTimes(i.main?.startWord ?? 0, i.main?.endWord ?? 0)}
              fallbackDuration={detail.session.durationS}
              onPatch={(p) => patch(i.id, p)}
            />
          ))}
        </div>
      </aside>
      <InsightConnector
        paneRef={transcriptRef}
        links={links}
        selectedId={selected}
        ready={transcript != null}
        onPick={(pickedId) => {
          setSelection(pickedId === selected ? null : { id: pickedId, focus: 'card' })
          setNewModeOn(false)
        }}
      />
    </main>
  )
}

/** One insight's line: which words it quotes, and which lane of the margin
 * its vertical run uses. */
type ConnectorLink = { id: number; title: string; startWord: number; endWord: number; lane: number }

/** One drawn brace, in viewport pixels. */
type LinkGeometry = {
  id: number; title: string; selected: boolean
  /** The margin bracket beside the quoted words — null when the passage
   * itself is scrolled off the window and there is nothing to bracket. */
  bracket: string | null
  line: string
  /** Where the line lands on its card — null when the card is scrolled out
   * of the list and the line runs off the window instead. */
  dot: { x: number; y: number } | null
}

/** The braces: a hairline from every card, across the margin, to a bracket
 * beside the words it quotes — faint for all of them, drawn in and solid for
 * the selected one. Standing links, not just a selection indicator: at a
 * glance the transcript shows which of it has been harvested and by which
 * card, without anything having to be clicked.
 *
 * Measured from the live DOM rather than derived from word indexes, because
 * the one thing that decides where a run of words *is* on screen is line
 * wrapping, and only layout knows that. Everything is in viewport
 * coordinates (getBoundingClientRect ↔ a position:fixed SVG), so both
 * scrollports — the page and the card list — are handled by the same thing:
 * on any scroll, measure again.
 *
 * Anything on screen at either end has a line, always — that's the point of
 * them, and the rule is symmetric. Scroll a card out of its list and its
 * line stays with the passage, running off the window in its lane instead
 * of stopping at the card. Scroll the passage out of the page and its line
 * stays with the card, leaving the window on the side the words went. A
 * link goes dark only when neither end is on screen. What a line never does
 * is stop at the edge it fell out of: that lands it exactly where some
 * other card or paragraph has scrolled into, and reads as pointing there.
 *
 * The lines are clickable (that's what the invisible fat `link-hit` stroke
 * is for): picking one selects its insight and fetches the card. */
function InsightConnector({ paneRef, links, selectedId, ready, onPick }: {
  paneRef: RefObject<HTMLElement | null>
  links: ConnectorLink[]
  selectedId: number | null
  /** Whether the transcript has rendered — word spans to measure against
   * don't exist before it has, and no scroll or resize event announces
   * their arrival. */
  ready: boolean
  onPick: (id: number) => void
}) {
  const [geoms, setGeoms] = useState<LinkGeometry[]>([])

  useLayoutEffect(() => {
    if (!ready || links.length === 0) { setGeoms([]); return }
    let frame = 0
    // Word spans are keyed and long-lived; React reconciles their classes in
    // place rather than replacing them, so indexing them once per transcript
    // beats a querySelector per link per frame (which, on a long transcript,
    // is a subtree scan per link — the difference between smooth scrolling
    // and not). Anything that does get detached measures 0×0 and is skipped.
    const wordEls = new Map<number, HTMLElement>()
    for (const el of paneRef.current?.querySelectorAll<HTMLElement>('[data-word-index]') ?? []) {
      wordEls.set(Number(el.dataset.wordIndex), el)
    }

    const measure = () => {
      frame = 0
      const pane = paneRef.current
      if (!pane) { setGeoms([]); return }
      const paneR = pane.getBoundingClientRect()
      const list = document.querySelector<HTMLElement>('.snippet-list')
      if (!list) { setGeoms([]); return }
      // Narrower than this and there's no margin to run through, only text to
      // draw over — that's the stacked layout, where the braces stay away.
      const listR = list.getBoundingClientRect()
      if (listR.left - paneR.right < 36) { setGeoms([]); return }

      const cardEls = new Map<number, HTMLElement>()
      for (const el of list.querySelectorAll<HTMLElement>('[data-insight-id]')) {
        cardEls.set(Number(el.dataset.insightId), el)
      }

      const out: LinkGeometry[] = []
      for (const link of links) {
        const card = cardEls.get(link.id)
        // endWord is exclusive; the run is contiguous in document order, so
        // its first and last words bound it vertically however many lines it
        // wraps across — no need to measure the ones in between.
        const first = wordEls.get(link.startWord)
        const last = wordEls.get(link.endWord - 1) ?? first
        if (!card || !first || !last) continue
        const firstR = first.getBoundingClientRect()
        const lastR = last.getBoundingClientRect()
        if (firstR.height === 0) continue
        const top = firstR.top
        const bottom = Math.max(lastR.bottom, firstR.bottom)
        const cardR = card.getBoundingClientRect()
        // Half-pixel offsets put the hairline strokes on a device pixel
        // boundary instead of straddling two — the difference between a
        // hairline and a smudge.
        const x = Math.round(paneR.right + 5 + link.lane * 2) + 0.5    // bracket, by the text
        const channel = Math.round(paneR.right + 16 + link.lane * 6) + 0.5 // the vertical run
        const cardX = Math.round(cardR.left) - 0.5                     // dot on the card's edge
        // Meet the card at its title, not its centre — cards grow downward as
        // they expand, and an anchor that slides around while you work the
        // accept/reject row looks unmoored.
        const anchorY = Math.min(Math.max(cardR.top + 26, cardR.top + 12), cardR.bottom - 12)
        // Leave from the middle of the *visible* part of the passage: a long
        // quote can run off the top of the window, and its true midpoint
        // would take the line off screen with it.
        const midY = Math.round(
          (Math.max(top, 0) + Math.min(bottom, window.innerHeight)) / 2,
        ) + 0.5

        // Both ends can wander off, and the rule is the same at either end:
        // a line NEVER gets pulled back to the edge of the thing it fell out
        // of, because it would land exactly where some other card (or
        // paragraph) happens to sit and read as though it pointed there. It
        // runs off the window instead, in its own lane — "this one is
        // further down, keep scrolling" — claiming nothing about whatever
        // has scrolled into that spot. -1 means off the top, 1 off the
        // bottom, 0 attached.
        const textAway = bottom < 0 ? -1 : top > window.innerHeight ? 1 : 0
        const cardAway = anchorY < listR.top + 4 ? -1 : anchorY > listR.bottom - 4 ? 1 : 0
        // Only when *neither* end is on screen is there nothing worth drawing.
        if (textAway !== 0 && cardAway !== 0) continue

        // An elbow, not a diagonal: the margin is a few dozen pixels wide
        // while the card and the passage can be several hundred apart
        // vertically, and a bezier across that aspect ratio reads as a
        // wobbling near-vertical line. Leaving one end horizontally, running
        // the gutter, then entering the other horizontally keeps both ends
        // tangent to what they connect, and keeps parallel links parallel.
        // Corners are quarter-round, radius shrinking to fit whatever room
        // is left; under a pixel of room, square it off (a degenerate arc is
        // a smudge, an unrounded corner is just a corner).
        const edgeY = (away: number) => away > 0 ? window.innerHeight : 0
        const corner = (fromX: number, fromY: number, toY: number, room: number) => {
          const dir = toY >= fromY ? 1 : -1
          const r = Math.min(9, Math.abs(toY - fromY) / 2, room)
          const lead = fromX < channel ? channel - r : channel + r
          return r < 1
            ? `M${fromX} ${fromY} H${channel} V${toY}`
            : `M${fromX} ${fromY} H${lead} Q${channel} ${fromY} ${channel} ${fromY + dir * r} V${toY}`
        }

        let line: string
        if (textAway !== 0) {
          // The passage is off screen: draw from the card outward instead,
          // and let it leave the window on the side the words are on.
          line = corner(cardX, Math.round(anchorY) + 0.5, edgeY(textAway), cardX - channel)
        } else if (cardAway !== 0) {
          line = corner(x, midY, edgeY(cardAway), channel - x)
        } else {
          // Both ends attached — the full brace, with a second corner
          // turning into the card.
          const cardY = Math.round(anchorY) + 0.5
          const dir = cardY >= midY ? 1 : -1
          const r = Math.min(9, Math.abs(cardY - midY) / 2, channel - x, cardX - channel)
          line = r < 1
            ? `M${x} ${midY} H${channel} V${cardY} H${cardX}`
            : `M${x} ${midY} H${channel - r} Q${channel} ${midY} ${channel} ${midY + dir * r}` +
              ` V${cardY - dir * r} Q${channel} ${cardY} ${channel + r} ${cardY} H${cardX}`
        }

        const tick = link.id === selectedId ? 7 : 4
        out.push({
          id: link.id,
          title: link.title,
          selected: link.id === selectedId,
          // No words on screen, nothing to bracket.
          bracket: textAway !== 0
            ? null
            : `M${x - tick} ${Math.round(top)} H${x} V${Math.round(bottom)} H${x - tick}`,
          line,
          dot: cardAway === 0 ? { x: cardX, y: Math.round(anchorY) + 0.5 } : null,
        })
      }
      // Selected last = painted on top of the faint ones it crosses.
      out.sort((a, b) => Number(a.selected) - Number(b.selected))
      setGeoms(out)
    }

    // rAF-coalesced: scroll fires far more often than the frame it would
    // paint into, and each pass reads layout for every link.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    // Reflow the transcript (window width, a card expanding under the cursor)
    // and everything moves with no scroll or resize event to say so.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (paneRef.current) ro?.observe(paneRef.current)
    ro?.observe(document.body)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
    }
  }, [paneRef, links, selectedId, ready])

  if (geoms.length === 0) return null
  // The key carries the selected state so selecting remounts that link's
  // paths and replays the draw-in; a plain remeasure (scrolling) only
  // updates `d` on the same elements, and must not replay anything. Links
  // entering view mount fresh, which is what fades them in.
  return (
    <svg className="connector">
      {geoms.map((g) => (
        <g key={`${g.id}${g.selected ? '·on' : ''}`} className={`link${g.selected ? ' selected' : ''}`}>
          {g.bracket && <path className="link-bracket" d={g.bracket} pathLength={1} />}
          <path className="link-line" d={g.line} pathLength={1} />
          {g.dot && <circle className="link-dot" cx={g.dot.x} cy={g.dot.y} r={g.selected ? 3 : 2} />}
          {/* The hit target — one fat invisible stroke over both subpaths,
              because a 1px hairline is not something anyone can click. The
              <title> gives it a hover tooltip; role/aria-label make it a
              real control rather than decoration. */}
          <path
            className="link-hit"
            d={g.bracket ? `${g.bracket} ${g.line}` : g.line}
            role="button"
            aria-label={`insight: ${g.title}`}
            onClick={() => onPick(g.id)}
          >
            <title>{g.title}</title>
          </path>
        </g>
      ))}
    </svg>
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
  transcript, speakerName, highlight, quotedWords, pendingStart, onWordClick, playheadS, isPlaying,
  selectable, onCreateFromSelection,
}: {
  transcript: Transcript
  speakerName: Map<string, string>
  highlight: Insight | null
  /** Every word quoted by *any* insight. The selected one is drawn stronger
   * on top of this (see `.word.hl`), but the standing wash is what makes the
   * harvest visible while you're just reading. */
  quotedWords: Set<number>
  pendingStart: number | null
  onWordClick: (index: number, shift: boolean) => void
  /** Absolute recording time of whatever's loaded into the shared player
   * (session bar or a snippet's clip — both live in this view), or null
   * when nothing has ever played. Drives the "now speaking" highlight. */
  playheadS: number | null
  isPlaying: boolean
  /** Cursor-only: true exactly when a plain word click does nothing (no
   * snippet selected, not building one, nothing playing) — swaps the
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
              const inHighlight = highlight?.main != null &&
                w.index >= highlight.main.startWord && w.index < highlight.main.endWord
              const isQuoted = !inHighlight && quotedWords.has(w.index)
              const isPending = pendingStart === w.index
              const isNowWord = w.index === activeWordIndex
              return (
                <span
                  key={w.index}
                  data-word-index={w.index}
                  className={`word${inHighlight ? ' hl' : ''}${isQuoted ? ' quoted' : ''}${isPending ? ' pending' : ''}${w.aligned ? '' : ' unaligned'}${isNowWord ? ' now-word' : ''}`}
                  onClick={(e) => {
                    // A drag-selection's terminating mouseup can also fire a
                    // click on that same word — with an active (non-collapsed)
                    // selection, word-click's own effects (seeking playback,
                    // moving an snippet's boundary) must be suppressed, or
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
          ✚ insight
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
  const m = i.main
  return (
    // data-insight-id is how InsightConnector finds this card's end of its
    // brace — DOM-measured, so the card has to be findable by insight.
    <div
      className={`card ${i.status}${selected ? ' selected' : ''}`}
      data-insight-id={i.id}
      onClick={onSelect}
    >
      <div className="row">
        <span className={`origin origin-${i.origin}`}>{i.origin}</span>
        {m && !m.anchored && <span className="badge warn">unanchored</span>}
        {attention.map((a) => <span key={a} className="badge warn">{a}</span>)}
        <span className={`badge ${i.status}`}>{i.status}</span>
      </div>
      <strong>{i.title}</strong>
      {m && <blockquote>{m.quote}</blockquote>}
      {i.description && <p className="note-text">{i.description}</p>}
      {i.supporting.length > 0 && (
        // Expanding the supporting snippets is not a click on the card:
        // without this, opening them on the selected card would toggle the
        // selection off (see onSelect) and collapse what you just opened.
        <details onClick={(e) => e.stopPropagation()}>
          <summary>{i.supporting.length} supporting snippet(s)</summary>
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
            {m && <>
              <button onClick={() => onPatch({ startWord: m.startWord - 1 })} title="start 1 word earlier">⟨−</button>
              <button onClick={() => onPatch({ startWord: m.startWord + 1 })} title="start 1 word later">⟨+</button>
              <button onClick={() => onPatch({ endWord: m.endWord - 1 })} title="end 1 word earlier">−⟩</button>
              <button onClick={() => onPatch({ endWord: m.endWord + 1 })} title="end 1 word later">+⟩</button>
            </>}
            <button className="primary" onClick={() => onPatch({ status: 'accepted' })}>✓ accept</button>
            <button className="danger" onClick={() => onPatch({ status: 'rejected' })}>✕ reject</button>
          </div>
        </>
      )}
      {selected && m && (
        <p className="muted hint">click a word = move start · shift-click = move end</p>
      )}
    </div>
  )
}
