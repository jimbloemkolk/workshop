import {
  Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject,
} from 'react'
import { api, type Insight, type SessionDetail, type Transcript, type Word } from '../api'
import { useRangePlayer, type RangePlayer } from '../audio'
import { PlayPauseFab } from '../components/PlayPauseFab'
import { SnippetPlayer } from '../components/SnippetPlayer'

// --- timeline-mode tuning constants ------------------------------------------
// Exported so tests can compute exact expected pixel positions instead of
// duplicating these numbers as separate magic constants.
/** A silence at least this long collapses to COLLAPSED_HEIGHT_PX (see
 * deriveCollapsedGaps/createTimeScale) — long enough to be "the conversation
 * paused," not just a breath between sentences. */
export const GAP_THRESHOLD_S = 30
/** Fixed height a collapsed gap occupies, regardless of how long it really
 * ran — a 20-minute lull and a 31-second one both cost this many pixels. */
export const COLLAPSED_HEIGHT_PX = 28
/** Default zoom: readable density for a normal back-and-forth without
 * turning a long call into a mile of scrolling.
 *
 * Measured against a real two-speaker transcript (the July-18 call): 132
 * genuine cross-speaker overlaps (not duplicate/bleed text — near-zero
 * token similarity between the overlapping runs), median overlap 1.34s,
 * median segment 4.8s / 27 characters. At the old default of 6px/sec a
 * typical overlap was ~8px tall — visually indistinguishable from "these
 * two just happen to be on the same row," which defeated the entire point
 * of a time-proportional view. 14px/sec puts that same overlap at ~19px
 * (legible) while a typical single-line, 27-character utterance (well
 * under one line at this column width) still gets noticeably more vertical
 * room (4.8s × 14 ≈ 67px) than its own text needs — so most blocks clear
 * the collision-push pass without ever being touched by it, rather than
 * fighting their neighbours by default. */
export const DEFAULT_PX_PER_SEC = 14
export const MIN_PX_PER_SEC = 1.5
export const MAX_PX_PER_SEC = 30
/** Minimum vertical breathing room the collision-push pass leaves between
 * two blocks that would otherwise touch in the same column. */
export const MIN_BLOCK_GAP_PX = 4

// --- word-end clamp: compensating for a forced-alignment artifact -----------
// WhisperX's forced alignment pads a word's `end` with trailing silence —
// see effectiveWordEnd's doc comment for the measured scale of it. These two
// constants are that clamp's only tunable knobs, validated against a real
// transcript (2026-07-18-qffr, 201 segments, 2176 aligned words): a fixed
// "a word takes at least this long to say" floor, plus a per-character
// allowance for longer words. Exported so tests can compute exact expected
// clamped durations instead of duplicating these numbers.
export const WORD_END_CLAMP_BASE_S = 0.35
export const WORD_END_CLAMP_PER_CHAR_S = 0.10

/** A word's likely REAL end time, clamping WhisperX's forced-alignment
 * padding — the aligner stretches a word's `end` to absorb trailing silence
 * before the next word starts, sometimes by tens of seconds. Measured on a
 * real transcript (2026-07-18-qffr, 201 segments): median word duration
 * 0.18s, but 158 of 2176 aligned words exceeded 1.5s and the worst ("Doe")
 * was timestamped as 25.9 seconds long. 86 of 201 segments had an inflated
 * final word.
 *
 * Left uncorrected, this single artifact defeats the timeline view's entire
 * premise: blocks draw far too tall, a padded word from one speaker phantom-
 * overlaps whatever the other speaker says next (measured: 130 raw cross-
 * speaker segment overlaps collapse to 76 once every word end in the
 * transcript is clamped by this function, median overlap 1.34s → 0.20s, and
 * every overlap over 2s — 53 of them — vanishes), and real silences get
 * swallowed entirely (33 genuine gaps over 2s, one of them 55.9s, currently
 * never collapse or read as a lull, because the padded word's `end` papers
 * right over them). The concrete case that surfaced this in the UI: session
 * 2026-07-18-qffr segment 55 (jesse) ends with "doen?" timestamped
 * 374.18→380.80 (6.6s for one word) — jesse actually stops talking around
 * 374.7, jim's reply starts at 375.08, and the UI drew a 6-second phantom
 * overlap where there's really a clean, sub-second handoff.
 *
 * Clamp: `start + WORD_END_CLAMP_BASE_S + WORD_END_CLAMP_PER_CHAR_S ×
 * text.length` — a fixed floor plus a per-character allowance. Against the
 * numbers above: "Doe" (3 chars, raw 25.9s) clamps to 0.65s; "doen?" (5
 * chars, the segment-55 case above) clamps to 0.85s; a hypothetical 9-char
 * word inflated past 1.25s would clamp there. All comfortably longer than
 * the 0.18s median for an ordinary word, so a genuinely long word (someone
 * drawing out a syllable) still has room before this clamp would touch it
 * at all — it only ever bites the extreme outliers forced alignment
 * produces. (A further refinement — also bounding by the next same-speaker
 * word's start where that's tighter — was tried against the same transcript
 * and changed not a single overlap or gap count; the character-length clamp
 * alone already resolves every measured case, so it wasn't adopted, to keep
 * this a pure per-word function with no sequence context to reason about.)
 *
 * Never returns less than `start` (a word can't end before it begins) and
 * never EXTENDS a word — only ever tightens `end` toward `start`, so a
 * word whose raw duration was already reasonable passes through unchanged.
 * Null in, null out: an unaligned word has no time to correct.
 *
 * This is a workaround, not a fix. The real problem is upstream, in
 * whatever produced these timestamps (the transcriber/merge step), and
 * belongs fixed there eventually — this only keeps the timeline view (and
 * everything else in this file that reads a word's end time) honest in the
 * meantime. Applied exactly once, to a copy, right after the transcript is
 * fetched (see withEffectiveWordEnds and its call site in ReviewView) —
 * every downstream derivation (segment bounds, resolveSegmentTimes,
 * deriveCollapsedGaps, findSegmentAt, the karaoke activeWordIndex, and
 * wordRangeTimes' snippet playback ranges) then sees the corrected time for
 * free, without each one having to remember to clamp it itself. Never
 * mutates its input, and never touches stored data — the server's own
 * transcript record is untouched; only this view's in-memory copy of it
 * is corrected. */
export function effectiveWordEnd(word: Pick<Word, 'start' | 'end' | 'text'>): number | null {
  if (word.start == null || word.end == null) return word.end
  const cap = word.start + WORD_END_CLAMP_BASE_S + WORD_END_CLAMP_PER_CHAR_S * word.text.length
  return Math.max(word.start, Math.min(word.end, cap))
}

/** Applies effectiveWordEnd to every word in a transcript, once — see that
 * function's doc comment for why and the numbers behind it. Pure: returns a
 * new Transcript (a new `words` array of new word objects); the one passed
 * in — and everything reachable from it — is never mutated, so a caller
 * that already has a reference to the original (e.g. a cached response) is
 * unaffected. */
export function withEffectiveWordEnds(transcript: Transcript): Transcript {
  return { ...transcript, words: transcript.words.map((w) => ({ ...w, end: effectiveWordEnd(w) })) }
}

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
    // withEffectiveWordEnds clamps WhisperX's forced-alignment padding
    // (see its own doc comment) exactly once, right here — every
    // downstream read of `transcript` in this file then sees the
    // corrected word-end times for free.
    api.transcript(id).then((t) => setTranscript(withEffectiveWordEnds(t))).catch((e) => onError(String(e)))
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
            player={player}
            selectable={wordsAreSelectable}
            onCreateFromSelection={createFromSelection}
            onSeek={(atS) => player.playFrom('session', 0, detail.session.durationS, atS)}
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
      {/* position: fixed, bottom-left beside App.tsx's <ToTopButton> — see
          PlayPauseFab's own doc comment for why it renders from here
          instead of alongside that one. */}
      <PlayPauseFab player={player} />
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

/** Calls `setter(value)` only if `value` differs (Object.is) from whatever
 * was last passed for this same `ref` — the "setState only when the
 * derived value actually changes" primitive behind every position-
 * subscription callback in this file (see TranscriptPane's
 * activeSegmentId/activeWordIndex effect and TimelineTranscript's
 * auto-scroll). The caller owns the ref and reuses it across every
 * invocation from a single subscription, so this is what collapses a
 * 60fps stream of raw positions down to however often the DERIVED value
 * it's fed actually changes — most ticks call `setter` zero times.
 *
 * Returns whether it actually called `setter`, purely so this can be unit
 * tested directly without mounting a component or driving a real rAF/audio
 * loop (both impractical to fake convincingly in jsdom). */
export function setIfChanged<T>(ref: { current: T }, value: T, setter: (v: T) => void): boolean {
  if (Object.is(ref.current, value)) return false
  ref.current = value
  setter(value)
  return true
}

/** A segment's speaker and time span, as resolveSegmentTimes needs it.
 * startS/endS mirror segmentBounds' min/max-over-timed-words idea, but —
 * unlike that array — cover every segment, including ones with no aligned
 * words at all; resolveSegmentTimes resolves those internally (see its own
 * doc comment for the fallback rule) rather than requiring the caller to. */
export interface SegmentSpan {
  id: number
  speaker: string | null
  startS: number | null
  endS: number | null
}

/** A segment's speaker + [startS, endS), with every unresolved time already
 * replaced by resolveSegmentTimes' deterministic fallback — a concrete
 * number, never null. What deriveCollapsedGaps and the timeline layout
 * (which positions each span directly on the time axis) both consume, so
 * neither has to reimplement — or risk disagreeing about — the fallback. */
export interface ResolvedSpan {
  id: number
  speaker: string | null
  startS: number
  endS: number
}

/** Resolves every segment's [startS, endS) to concrete numbers, in the
 * order given — the fallback rule behind deriveCollapsedGaps and the
 * timeline layout (see ResolvedSpan). A segment with no aligned words at
 * all (startS/endS both null) gets a deterministic zero-width span pinned to
 * the running "latest resolved end so far, in THIS order" (0 if nothing has
 * resolved yet): an unknown time is treated as "immediately after whatever
 * precedes it here," never "everywhere" or "nowhere." This is also what
 * "nulls keeping their relative position" means downstream — an unresolved
 * segment's synthetic time is anchored to its neighbours in the order given
 * here, so a caller that then sorts by startS still lands it right where
 * that context implies, rather than yanking it to whatever `0` or
 * `Infinity` would sort it to. */
export function resolveSegmentTimes(segments: SegmentSpan[]): ResolvedSpan[] {
  let lastResolvedEnd = 0
  return segments.map((seg) => {
    const isResolved = seg.startS != null && seg.endS != null
    const startS = isResolved ? seg.startS! : lastResolvedEnd
    const endS = isResolved ? seg.endS! : lastResolvedEnd
    lastResolvedEnd = Math.max(lastResolvedEnd, endS)
    return { id: seg.id, speaker: seg.speaker, startS, endS }
  })
}

/** A closed-open interval of silence — nobody speaking across ANY column —
 * long enough to collapse in the timeline view. */
export interface CollapsedGap {
  startS: number
  endS: number
}

/** Finds gaps in speech longer than `thresholdS` (default 30s) across ALL
 * speakers combined — a lull only counts when NOBODY is talking, so
 * overlapping speech from different speakers never produces a gap between
 * them (the later one starts before the running "latest end so far"
 * catches up). Segments need not be pre-sorted — sorted by startS
 * internally before the scan.
 *
 * Boundary: a gap of EXACTLY thresholdS collapses (the comparison is
 * `>=`) — the threshold is "this long is long enough," not "strictly
 * longer than." */
export function deriveCollapsedGaps(
  segments: { startS: number; endS: number }[],
  thresholdS = 30,
): CollapsedGap[] {
  const sorted = [...segments].sort((a, b) => a.startS - b.startS)
  const gaps: CollapsedGap[] = []
  let latestEnd: number | null = null
  for (const seg of sorted) {
    if (latestEnd != null && seg.startS - latestEnd >= thresholdS) {
      gaps.push({ startS: latestEnd, endS: seg.startS })
    }
    latestEnd = latestEnd == null ? seg.endS : Math.max(latestEnd, seg.endS)
  }
  return gaps
}

/** Maps recording time (seconds) to vertical pixels and back, for the
 * timeline transcript view. Piecewise linear: normal stretches run at
 * `pxPerSec`, and every interval in `collapsedGaps` is squashed to a fixed
 * `collapsedHeightPx` regardless of its real duration (so a 20-minute lull
 * costs the same handful of pixels as a 31-second one) — everything else
 * (the ruler, segment placement, the playhead) MUST go through this scale
 * rather than compute pixels itself, or they will disagree about where a
 * given moment lands whenever a gap is in play.
 *
 * `toTime` is `toY`'s exact inverse (see the breakpoint construction below
 * — both walk the same monotonic list, one by time, one by pixel), which is
 * what makes click-the-gutter-to-seek possible and keeps the ruler honest:
 * a tick drawn at `toY(t)` and then read back via `toTime` on that same
 * pixel returns `t`. */
export function createTimeScale({
  durationS,
  collapsedGaps,
  pxPerSec,
  collapsedHeightPx,
}: {
  durationS: number
  collapsedGaps: CollapsedGap[]
  pxPerSec: number
  collapsedHeightPx: number
}): { toY: (seconds: number) => number; toTime: (y: number) => number; totalHeight: number } {
  // Breakpoints: {t, y, rate} triples, strictly increasing in both t and y,
  // where `rate` (px per second) applies from this breakpoint up to the
  // next one. Built by walking the timeline once, alternating "normal"
  // stretches (rate = pxPerSec) with "collapsed" ones (rate =
  // collapsedHeightPx / gapDuration — a heavily compressed but still-linear
  // rate, which is what keeps the collapsed stretch invertible instead of a
  // single dead zone `toTime` can't map back out of).
  const gaps = [...collapsedGaps].sort((a, b) => a.startS - b.startS)
  const breakpoints: { t: number; y: number; rate: number }[] = []
  let t = 0
  let y = 0
  for (const gap of gaps) {
    // Defensive against out-of-order/overlapping input: never walk time
    // backwards.
    const gapStart = Math.max(gap.startS, t)
    if (gapStart > t) {
      breakpoints.push({ t, y, rate: pxPerSec })
      y += (gapStart - t) * pxPerSec
      t = gapStart
    }
    const gapEnd = Math.max(gap.endS, t)
    const dur = gapEnd - t
    if (dur <= 0) continue
    breakpoints.push({ t, y, rate: collapsedHeightPx / dur })
    y += collapsedHeightPx
    t = gapEnd
  }
  if (durationS > t) {
    breakpoints.push({ t, y, rate: pxPerSec })
    y += (durationS - t) * pxPerSec
    t = durationS
  }
  if (breakpoints.length === 0) breakpoints.push({ t: 0, y: 0, rate: pxPerSec })
  const totalHeight = y

  const toY = (seconds: number): number => {
    let bp = breakpoints[0]
    for (const b of breakpoints) {
      if (b.t <= seconds) bp = b
      else break
    }
    return bp.y + (seconds - bp.t) * bp.rate
  }
  const toTime = (yPos: number): number => {
    let bp = breakpoints[0]
    for (const b of breakpoints) {
      if (b.y <= yPos) bp = b
      else break
    }
    return bp.t + (yPos - bp.y) / bp.rate
  }

  return { toY, toTime, totalHeight }
}

/** One block's natural, pre-collision position — its own column (blocks
 * only ever push against others in the SAME column; columns are laid out
 * independently), the top a TimeScale gave it, and its measured rendered
 * height. */
export interface LayoutBlock {
  id: number
  column: string
  y: number
  height: number
}

/** Pushes overlapping blocks down within their own column so that no two
 * blocks in the same column overlap, without ever changing their relative
 * order or touching another column. Per column, walked in `y` order:
 * a block keeps its natural `y` if that's already at or past
 * `prevBottom + minGapPx`; otherwise it's pushed down to exactly that sum
 * (the minimum shift that clears the collision, no more). `prevBottom`
 * then advances to this block's own (possibly-pushed) bottom, so a chain of
 * several overlapping blocks pushes each one down in turn.
 *
 * Pure and side-effect-free — this is the whole "measure, then adjust"
 * pass's actual math, deliberately factored out of the component so it can
 * be tested without mounting anything or touching a ref. */
export function resolveBlockOverlaps(blocks: LayoutBlock[], minGapPx: number): Map<number, number> {
  const byColumn = new Map<string, LayoutBlock[]>()
  for (const b of blocks) {
    const list = byColumn.get(b.column) ?? []
    list.push(b)
    byColumn.set(b.column, list)
  }
  const adjusted = new Map<number, number>()
  for (const list of byColumn.values()) {
    const sorted = [...list].sort((a, b) => a.y - b.y)
    let prevBottom: number | null = null
    for (const block of sorted) {
      const top: number = prevBottom == null ? block.y : Math.max(block.y, prevBottom + minGapPx)
      adjusted.set(block.id, top)
      prevBottom = top + block.height
    }
  }
  return adjusted
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
 * the only case that returns null.
 *
 * In the timeline's two-speaker columns — the one layout in this file
 * that's ever more than one column wide, `linear` mode being exactly Jim's
 * original single-column reading order — this is exactly what keeps a drag
 * that crosses both columns turning into one contiguous index range
 * instead of two — intentional, not a gap: a snippet is a contiguous
 * word-index range, full stop, even when it spans speakers (see the
 * insight/snippet data model, which never learned about columns or
 * pixels). The one thing that changes is what that range *means* to a
 * reader: visual adjacency on screen no longer implies index adjacency, so
 * a cross-column drag's min..max span walks the time-interleaved words
 * between its two endpoints, including whatever the *other* column said in
 * between — the same seam every other consumer of a word range already
 * slices against. Timeline mode raises the same fact one more notch: two
 * words that are visually adjacent there can be arbitrarily far apart in
 * elapsed time (that's the point of the view), yet still just as
 * arbitrarily far apart — or close — in word-index terms; the index range
 * this returns has never claimed anything about vertical pixels either. */
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
  transcript, speakerName, highlight, quotedWords, pendingStart, onWordClick, player,
  selectable, onCreateFromSelection, onSeek,
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
  /** The shared player, taken whole (rather than a `playheadS`/`isPlaying`
   * pair drip-fed from ReviewView) so this component and TimelineTranscript
   * below it can subscribe to the live 60fps position feed directly —
   * `player.position` itself is deliberately COARSE now (see RangePlayer's
   * doc comment) and re-renders far less often than playback actually
   * moves; anything that needs to track it in real time reads
   * player.getPosition()/player.subscribePosition() instead. */
  player: RangePlayer
  /** Cursor-only: true exactly when a plain word click does nothing (no
   * snippet selected, not building one, nothing playing) — swaps the
   * pointer cursor for a text cursor so "clicking does nothing here, but
   * you can select" isn't invisible. Doesn't gate any actual behavior;
   * onWordClick's own logic (in ReviewView) already decides that. */
  selectable: boolean
  onCreateFromSelection: (startWord: number, endWord: number) => void
  /** Timeline mode only: click-the-gutter-to-seek, and (later) the ruler's
   * own affordances. Jumps the shared player to an absolute recording time. */
  onSeek: (atS: number) => void
}) {
  const isPlaying = player.playingKey != null
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

  // activeSegmentId/activeWordIndex used to be derived inline from a
  // `playheadS` PROP that was really just `player.position` — 60fps React
  // state, so this component (and everything under it: every column, every
  // block, every one of potentially thousands of word spans) re-rendered
  // every single animation frame during playback. That blew the frame
  // budget badly enough that the timeline playhead's own transform-based
  // move (cheap in isolation) landed late and visibly caught up in bursts.
  //
  // `player.position` is now a COARSE value (see RangePlayer's doc
  // comment); the live number lives in player.subscribePosition instead.
  // This is the "coarse derived value" half of that split: subscribe to
  // the 60fps feed, recompute which segment/word it falls in on every
  // tick (cheap — a binary search plus a short scan), but only ever
  // setState when that DERIVED value actually changed. A word changes a
  // couple of times a second at most and a segment far less than that, so
  // the component now re-renders at roughly that rate instead of 60/sec —
  // setIfChanged (see there) is what enforces the "only on change" part,
  // and is exercised directly by its own unit tests since driving a real
  // rAF/audio loop in a test is impractical.
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null)
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null)
  const activeSegmentRef = useRef<number | null>(null)
  const activeWordRef = useRef<number | null>(null)
  useEffect(() => {
    const apply = (t: number | null) => {
      const segId = t != null ? findSegmentAt(segmentBounds, t) : null
      // Karaoke word within the active segment — a handful of words, so a
      // plain scan (no memoization) is cheap enough to just do inline.
      // Needs no gap handling of its own: when segId is the *upcoming*
      // segment during a silence, `t` is still before all of its words'
      // starts, so this naturally comes up empty — only the segment wash
      // shows, no word underlines until it's actually being spoken.
      let wordIdx: number | null = null
      if (segId != null && t != null) {
        for (const w of bySegment.get(segId) ?? []) {
          if (w.start != null && w.end != null && t >= w.start && t < w.end) { wordIdx = w.index; break }
        }
      }
      setIfChanged(activeSegmentRef, segId, setActiveSegmentId)
      setIfChanged(activeWordRef, wordIdx, setActiveWordIndex)
    }
    if (player.activeKey == null) { apply(null); return }
    apply(player.getPosition())
    return player.subscribePosition(apply)
  }, [player, segmentBounds, bySegment])

  // Distinct non-null speakers, in first-appearance order (deterministic —
  // never re-sorted by frequency or label) — a two-speaker call switches the
  // whole pane into the parallel columns layout; anything else (a solo
  // recording, or 3+ speakers from a diarized table session) keeps today's
  // single-column reading order untouched, which is also what every session
  // used before this mode existed.
  const speakers = useMemo(() => {
    const seen: string[] = []
    for (const seg of transcript.segments) {
      if (seg.speaker != null && !seen.includes(seg.speaker)) seen.push(seg.speaker)
    }
    return seen
  }, [transcript])
  const isParallel = speakers.length === 2

  // Every segment's speaker + time span, in transcript (array) order — the
  // input resolveSegmentTimes needs downstream (deriveCollapsedGaps, the
  // timeline's own block placement). Unlike segmentBounds above, this keeps
  // every segment (even ones with no aligned words), because both of those
  // need a slot for each one; resolveSegmentTimes applies its own
  // deterministic fallback for the unresolved ones. Only computed when
  // it'll actually be used.
  const segmentSpans = useMemo<SegmentSpan[]>(() => {
    if (!isParallel) return []
    return transcript.segments.map((seg) => {
      let startS: number | null = null
      let endS: number | null = null
      for (const w of bySegment.get(seg.id) ?? []) {
        if (w.start != null) startS = startS == null ? w.start : Math.min(startS, w.start)
        if (w.end != null) endS = endS == null ? w.end : Math.max(endS, w.end)
      }
      return { id: seg.id, speaker: seg.speaker, startS, endS }
    })
  }, [transcript, bySegment, isParallel])

  // Two ways to read a two-speaker transcript: `timeline` (the vertical axis
  // IS time — lulls read as lulls) is the default, since that's the whole
  // point of this phase; `linear` is Jim's ORIGINAL single-column layout —
  // the exact same rendering non-2-speaker sessions already use below,
  // reused rather than reimplemented (see the render branch further down).
  // An earlier row-grouped "compact" grid briefly stood in for `linear`
  // here; the user asked for Jim's original back instead, so that grid is
  // gone now, along with groupSegmentsIntoRows and its OTHER_SPEAKER
  // sentinel — both deleted, since they existed only to build that grid.
  // (TimelineTranscript has its own, still-current OTHER_COLUMN sentinel
  // for the same "unmatched speaker" idea — a different, unrelated symbol,
  // despite the similar name.) Meaningless (and its toggle hidden) outside
  // the two-speaker case —
  // see the `isParallel` render branch below. Zoom is timeline-only, plain
  // component state: nothing here needs to survive a remount, and there's
  // no existing settings/localStorage module on this branch to hang it off
  // of.
  const [mode, setMode] = useState<'timeline' | 'linear'>('timeline')
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC)
  const isTimeline = isParallel && mode === 'timeline'

  // Every segment's span with its fallback already resolved to a concrete
  // number (see resolveSegmentTimes) — what both the gap derivation and the
  // timeline's own block placement position against. Built from
  // `segmentSpans` (computed above), so an unresolved segment lands at the
  // exact same synthetic instant in both the gap derivation and the block
  // placement that positions it.
  const resolvedSpans = useMemo(
    () => (isParallel ? resolveSegmentTimes(segmentSpans) : []),
    [isParallel, segmentSpans],
  )
  const collapsedGaps = useMemo(
    () => (isParallel ? deriveCollapsedGaps(resolvedSpans, GAP_THRESHOLD_S) : []),
    [isParallel, resolvedSpans],
  )
  // The transcript's own duration_s is the usual bound, but a transcript
  // whose last segment runs past it (clock drift, a slightly-off duration
  // from the recorder) shouldn't clip that segment off the bottom of the
  // timeline — the later of the two wins.
  const timelineDurationS = useMemo(() => {
    const maxEnd = resolvedSpans.reduce((m, s) => Math.max(m, s.endS), 0)
    return Math.max(transcript.meta.duration_s ?? 0, maxEnd)
  }, [resolvedSpans, transcript])
  const scale = useMemo(
    () => createTimeScale({
      durationS: timelineDurationS, collapsedGaps, pxPerSec, collapsedHeightPx: COLLAPSED_HEIGHT_PX,
    }),
    [timelineDurationS, collapsedGaps, pxPerSec],
  )

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
  //
  // Timeline mode replaces this with its own playhead-follows-the-comfort-
  // -band auto-scroll (see TimelineTranscript) — snapping to a segment's top
  // edge would fight a scroll that's supposed to track a continuously
  // advancing position instead.
  const lastScrolledRef = useRef<number | null>(null)
  useEffect(() => {
    if (isTimeline) return
    if (activeSegmentId == null || !isPlaying) return
    if (lastScrolledRef.current === activeSegmentId) return
    lastScrolledRef.current = activeSegmentId
    document.getElementById(`segment-${activeSegmentId}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeSegmentId, isPlaying, isTimeline])

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

  // The word-level machinery — highlight, quoted wash, pending outline,
  // karaoke underline, click/shift-click editing, the selectable-text-cursor
  // affordance — is identical whether a segment renders inside the linear
  // <p> layout or a parallel-columns grid cell; only the surrounding markup
  // differs. Shared here so the two layouts can never quietly drift apart.
  const renderWords = (words: Word[]) => words.map((w) => {
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
          // A drag-selection's terminating mouseup can also fire a click on
          // that same word — with an active (non-collapsed) selection,
          // word-click's own effects (seeking playback, moving a snippet's
          // boundary) must be suppressed, or just trying to select text
          // would also jump playback.
          if (window.getSelection()?.isCollapsed === false) return
          onWordClick(w.index, e.shiftKey)
        }}
      >
        {w.text}{' '}
      </span>
    )
  })

  // One parallel-grid cell for a row's segment in a given column — null
  // (renders nothing) when this row has no segment for that column, which is
  // the normal case for a turn-taking row. Both gridColumn AND gridRow are
  // explicit (not left to auto-placement): a lone cell in a half-empty row
  // has nothing next to it to anchor a "next available row" auto-placement
  // scan against, and CSS Grid's sparse auto-flow will happily backfill a
  return (
    <>
      {isParallel && (
        // Mode toggle only exists for the two-speaker case — anything else
        // keeps the single linear layout below with no choice to make. Zoom
        // is timeline-only; hidden (not merely disabled) in linear mode,
        // since it controls a scale linear mode doesn't have.
        <div className="mode-toggle">
          <button
            className={mode === 'timeline' ? 'active' : ''}
            aria-pressed={mode === 'timeline'}
            onClick={() => setMode('timeline')}
          >
            timeline
          </button>
          <button
            className={mode === 'linear' ? 'active' : ''}
            aria-pressed={mode === 'linear'}
            onClick={() => setMode('linear')}
          >
            linear
          </button>
          {isTimeline && (
            <span className="zoom-control">
              <button
                aria-label="zoom out"
                onClick={() => setPxPerSec((z) => Math.max(MIN_PX_PER_SEC, Math.round(z / 1.4 * 10) / 10))}
              >
                −
              </button>
              <input
                type="range"
                min={MIN_PX_PER_SEC}
                max={MAX_PX_PER_SEC}
                step={0.5}
                value={pxPerSec}
                onChange={(e) => setPxPerSec(Number(e.target.value))}
                aria-label="zoom"
              />
              <button
                aria-label="zoom in"
                onClick={() => setPxPerSec((z) => Math.min(MAX_PX_PER_SEC, Math.round(z * 1.4 * 10) / 10))}
              >
                +
              </button>
            </span>
          )}
        </div>
      )}
      {isTimeline ? (
        <TimelineTranscript
          spans={resolvedSpans}
          speakers={speakers}
          speakerName={speakerName}
          scale={scale}
          durationS={timelineDurationS}
          pxPerSec={pxPerSec}
          collapsedGaps={collapsedGaps}
          activeSegmentId={activeSegmentId}
          player={player}
          selectable={selectable}
          bySegment={bySegment}
          renderWords={renderWords}
          onSeek={onSeek}
        />
      ) : (
        // Jim's original linear layout — used verbatim (not a parallel
        // reimplementation) both here, for a two-speaker session in
        // `linear` mode, and below the `isParallel` check entirely, for
        // any session that isn't exactly two speakers. One rendering path,
        // reached two ways, so there's nothing here that can drift out of
        // sync with "the way this always looked."
        transcript.segments.map((seg) => (
          <p
            key={seg.id}
            id={`segment-${seg.id}`}
            className={`segment${seg.id === activeSegmentId ? ' now-playing' : ''}`}
          >
            <span className="speaker-tag">
              {seg.speaker ? speakerName.get(seg.speaker) ?? seg.speaker : '?'}
            </span>
            <span className={`segment-words${selectable ? ' selectable' : ''}`}>
              {renderWords(bySegment.get(seg.id) ?? [])}
            </span>
          </p>
        ))
      )}
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

/** mm:ss (h:mm:ss past an hour) — the gutter's tick labels. */
function formatClock(s: number): string {
  const total = Math.max(0, Math.round(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** "4m 12s" / "45s" — a collapsed gap marker's label. */
function formatDuration(s: number): string {
  const total = Math.max(0, Math.round(s))
  const m = Math.floor(total / 60)
  const sec = total % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

/** Minute markers the whole way down, plus 30s ticks once zoomed in enough
 * to space them legibly (below this, a 30s tick and the minute mark either
 * side of it would nearly overlap). Ticks never fall inside a collapsed
 * gap — the gap already carries its own "N silence" label; a grid of
 * minute marks stacked on top of a 28px band would just be clutter. */
function buildTimelineTicks(
  durationS: number, collapsedGaps: CollapsedGap[], pxPerSec: number,
): { s: number; minor: boolean }[] {
  const inGap = (t: number) => collapsedGaps.some((g) => t > g.startS && t < g.endS)
  const showMinor = pxPerSec >= 3
  const step = showMinor ? 30 : 60
  const ticks: { s: number; minor: boolean }[] = []
  for (let t = 0; t <= durationS; t += step) {
    if (inGap(t)) continue
    ticks.push({ s: t, minor: showMinor && t % 60 !== 0 })
  }
  return ticks
}

/** The time-proportional two-speaker view: a left time gutter plus one
 * absolutely-positioned column of blocks per speaker, sharing a single
 * TimeScale — "when there's a lull, there's a lull," rather than linear
 * mode's strict reading order. See createTimeScale/deriveCollapsedGaps/
 * resolveBlockOverlaps for the pure math; this is just their wiring:
 * measure real block heights, push away any collision the natural
 * (time-proportional) positions created, and follow the playhead down the
 * page while it plays. */
// Auto-scroll tuning (see the effect below). Kept as named constants rather
// than inline numbers so the reasoning in the comments has something to
// point at.
/** Once suspended by a manual scroll, auto-follow only re-arms after the
 * playhead has been continuously OUT of the comfort band for this long —
 * not as soon as it drifts out. A grace window, not an instant re-snap, is
 * what keeps a deliberate look-around from being immediately overridden by
 * the very next frame. */
const AUTO_SCROLL_REARM_MS = 1200
/** Floor between one corrective scroll finishing and the next one being
 * considered at all — independent of (and in addition to) the "is a scroll
 * WE issued still animating" check below, since a `smooth` scroll's actual
 * duration is the browser's call, not ours. */
const AUTO_SCROLL_COOLDOWN_MS = 700

/** Collision-grouping key for a block whose speaker matches neither of the
 * two columns (a null/third speaker slipping into an otherwise two-speaker
 * transcript — timeline mode is only ever chosen when there are exactly
 * two *distinct* speakers, but that doesn't rule out the odd segment with
 * no speaker at all). Not a real speaker label, so it can never collide
 * with one. Purely internal to resolveBlockOverlaps' column grouping —
 * unrelated to (and NOT the same concept as) the `data-col` value used for
 * rendering, which is computed independently from `speakers.indexOf`. */
const OTHER_COLUMN = '__other__'

function TimelineTranscript({
  spans, speakers, speakerName, scale, durationS, pxPerSec, collapsedGaps, activeSegmentId, player,
  selectable, bySegment, renderWords, onSeek,
}: {
  spans: ResolvedSpan[]
  speakers: string[]
  speakerName: Map<string, string>
  scale: { toY: (s: number) => number; toTime: (y: number) => number; totalHeight: number }
  /** Same value the scale was built from — passed alongside it (rather than
   * recovered via `scale.toTime(scale.totalHeight)`) so the tick ruler
   * doesn't depend on round-tripping through the scale to know its own
   * range. */
  durationS: number
  /** Only used to decide whether 30s ticks are legible yet (see
   * buildTimelineTicks) — everything about where things actually land goes
   * through `scale`, never this directly. */
  pxPerSec: number
  collapsedGaps: CollapsedGap[]
  activeSegmentId: number | null
  /** The live position (playhead line + auto-scroll) comes from
   * player.subscribePosition/getPosition directly, NOT from a `playheadS`
   * prop recomputed from `player.position` on every render — that was the
   * 60fps-re-render bug. Both the sweeping line and the auto-scroll write
   * straight to the DOM/window from the subscription callback instead. */
  player: RangePlayer
  selectable: boolean
  bySegment: Map<number, Word[]>
  renderWords: (words: Word[]) => ReactNode
  onSeek: (atS: number) => void
}) {
  const blockRefs = useRef(new Map<number, HTMLDivElement>())
  const trackRef = useRef<HTMLDivElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  // Adjusted `top`s from the collision-push pass, plus the container height
  // that pass settles on — both land in one state update so a block's
  // position and the container's height that has to fit it never disagree
  // for a single render.
  const [layout, setLayout] = useState<{ ys: Map<number, number>; height: number }>({
    ys: new Map(), height: scale.totalHeight,
  })

  // Only the width of the track matters for measurement — it's what decides
  // how a block's text wraps, and therefore its natural height. A
  // ResizeObserver (not the window 'resize' event) so a sidebar
  // opening/closing or a card expanding elsewhere on the page — anything
  // that changes this column's own width without the *window* resizing —
  // is caught too.
  useEffect(() => {
    const el = trackRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setTrackWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Natural (pre-collision) position of every block: which column, and
  // where the scale alone would put it. Deliberately excludes height (that
  // comes from measuring the actual rendered DOM below) and never reads
  // `layout` — this is the "if nothing pushed anything, where would it
  // go" input, computed fresh from spans/scale alone.
  const naturalBlocks = useMemo(
    () => spans.map((s) => ({
      id: s.id,
      column: s.speaker != null && speakers.includes(s.speaker) ? s.speaker : OTHER_COLUMN,
      y: scale.toY(s.startS),
    })),
    [spans, scale, speakers],
  )

  // The measure-then-adjust pass. Runs once per real layout input — spans/
  // scale changing (both baked into naturalBlocks) or the track's own width
  // changing — and NOTHING else: it deliberately does not depend on
  // `layout` itself, which is what keeps this from looping. That's safe
  // because repositioning a block via `top` can't change its rendered
  // height — height comes from text content and column width, and this
  // pass only ever touches the vertical offset, never the width those
  // widths wrap against — so the state write below can never feed back
  // into a reason to measure again.
  useLayoutEffect(() => {
    const withHeights = naturalBlocks.map((b) => ({
      ...b,
      height: blockRefs.current.get(b.id)?.getBoundingClientRect().height ?? 0,
    }))
    const ys = resolveBlockOverlaps(withHeights, MIN_BLOCK_GAP_PX)
    let lowestBottom = 0
    for (const b of withHeights) {
      const top = ys.get(b.id) ?? b.y
      lowestBottom = Math.max(lowestBottom, top + b.height)
    }
    setLayout({ ys, height: Math.max(scale.totalHeight, lowestBottom) })
  }, [naturalBlocks, trackWidth, scale])

  // Honesty cue (see deriveCollapsedGaps/resolveBlockOverlaps): whenever the
  // collision pass actually moved a block off the time-proportional
  // position the scale gave it, the axis is quietly lying about that one
  // block. Collected here — cheaply, from data already computed above —
  // and drawn in the gutter as a small mark at the block's TRUE time (see
  // .timeline-displacement-mark), not on the block itself, so the
  // reading experience stays clean and only the ruler (which is what the
  // lie is *about*) carries the tell.
  const displacementMarks = useMemo(() => {
    const marks: { id: number; trueY: number }[] = []
    for (const b of naturalBlocks) {
      const adjusted = layout.ys.get(b.id)
      if (adjusted != null && Math.abs(adjusted - b.y) > 0.5) marks.push({ id: b.id, trueY: b.y })
    }
    return marks
  }, [naturalBlocks, layout])

  const hasPosition = player.activeKey != null
  const isPlayingNow = player.playingKey != null

  // "Latest" refs, read from the two effects below instead of listing
  // `player`/`scale` themselves as dependencies. useRangePlayer returns a
  // brand-new object every time ReviewView renders (see audio.ts), and
  // `scale` is a useMemo result — in practice both stay referentially
  // stable across TranscriptPane's own activeSegmentId/activeWordIndex
  // re-renders (a child's setState never re-runs its parent, so
  // ReviewView's `player` and TranscriptPane's `scale` memo don't change
  // just because TranscriptPane re-rendered), but that's an incidental
  // fact about today's component tree, not a guarantee this file makes
  // anywhere. If it ever stopped holding, an effect that depended on
  // `player` directly would tear down and rebuild every time it fired —
  // harmless for the stateless playhead transform, but it would silently
  // wipe the auto-scroll effect's persistent suspended/cooldown state
  // (plain closure variables) right along with it, defeating "never fight
  // the user." Reading through a ref sidesteps needing that stability
  // promise at all: both effects below depend only on the few PRIMITIVE,
  // rarely-changing signals that actually warrant restarting them
  // (hasPosition, isPlayingNow), while always seeing the current
  // player/scale whenever a callback actually fires.
  const playerRef = useRef(player)
  playerRef.current = player
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  // The sweeping playhead: a single element moved via `transform`, written
  // directly from the subscription callback — never React state, never a
  // style prop recomputed on a render. This is the fix for "the playhead
  // lags then catches up": that used to be `style={{transform:
  // translateY(scale.toY(playheadS))}}` with `playheadS` a 60fps state
  // value, which meant every single frame re-rendered this component (and
  // every block and word span under it) just to move one line — the render
  // work routinely missed the frame, so the transform landed late and then
  // jumped when the backlog cleared. `scale` (unlike `player`) IS a direct
  // dependency here — it has no persistent state to lose, and depending on
  // it means a mid-playback (or mid-pause) zoom repaints the line at the
  // right spot immediately instead of waiting for the next tick, which
  // matters most exactly when paused (no tick is coming at all).
  useEffect(() => {
    if (!hasPosition) return
    const el = playheadRef.current
    if (!el) return
    const apply = (t: number) => { el.style.transform = `translateY(${scale.toY(t)}px)` }
    apply(playerRef.current.getPosition())
    return playerRef.current.subscribePosition(apply)
  }, [hasPosition, scale])

  // Playhead auto-scroll: keep it inside a comfort band (25%–70% of the
  // viewport) while playing, rather than linear mode's per-segment
  // scrollIntoView — that would snap to a block's top edge
  // every time activeSegmentId changed, fighting a scroll that's supposed
  // to track a continuously advancing position instead.
  //
  // Three things this has to get right, all fixed here at once:
  //  1. Driven by the position SUBSCRIPTION, not a `playheadS` prop — the
  //     old version re-ran this effect on every 60fps render, which is
  //     also what caused bug #1 above.
  //  2. Never pile up smooth scrolls: `correcting` tracks whether a scroll
  //     WE issued is still (probably) animating, and a cooldown on top of
  //     that means a new correction is only even considered every
  //     AUTO_SCROLL_COOLDOWN_MS — without both, a playhead that's been out
  //     of band for several consecutive ticks would queue a fresh smooth
  //     scroll on every one of them, and the page visibly fights itself.
  //  3. Never fight the user: any 'scroll' event that isn't one of our own
  //     corrections (the `correcting` flag distinguishes the two) suspends
  //     auto-follow immediately. It only re-arms once the playhead has
  //     since spent AUTO_SCROLL_REARM_MS continuously outside the band —
  //     not the instant it drifts out again — so a deliberate look-around
  //     gets a real window before the view gets pulled back.
  //
  // Deliberately depends on [hasPosition, isPlayingNow] only — NOT `scale`
  // (read via scaleRef instead) — so a mid-playback zoom doesn't reset
  // this effect's persistent suspended/cooldown state; the user's "leave
  // me alone, I'm looking at something" should survive a zoom tweak just
  // as much as it should survive a karaoke word tick.
  //
  // Scrolls `window` rather than some inner container because there IS no
  // inner scrollport for this pane (see the .transcript/.timeline-wrap
  // CSS and the comment on .snippet-list, which is the one part of this
  // screen that DOES have its own — the transcript intentionally doesn't;
  // the whole page scrolls). window is genuinely what "the transcript
  // pane's own scroll surface" resolves to here, not a fallback.
  useEffect(() => {
    if (!hasPosition || !isPlayingNow) return
    let correcting = false
    let correctingTimer: ReturnType<typeof setTimeout> | null = null
    let suspended = false
    let outOfBandSinceMs: number | null = null
    let lastCorrectionAtMs = 0

    const stopCorrecting = () => {
      correcting = false
      if (correctingTimer) { clearTimeout(correctingTimer); correctingTimer = null }
    }
    const onManualScroll = () => {
      if (correcting) return // our own in-flight correction, not the user
      suspended = true
      outOfBandSinceMs = null
    }
    // capture: scroll doesn't bubble, but it does fire on ancestors in the
    // capture phase (same pattern the selection-chip dismissal uses
    // elsewhere in this file).
    document.addEventListener('scroll', onManualScroll, true)
    document.addEventListener('scrollend', stopCorrecting)

    const unsubscribe = playerRef.current.subscribePosition((t) => {
      const track = trackRef.current
      if (!track) return
      const viewportY = track.getBoundingClientRect().top + scaleRef.current.toY(t)
      const bandTop = window.innerHeight * 0.25
      const bandBottom = window.innerHeight * 0.7
      if (viewportY >= bandTop && viewportY <= bandBottom) { outOfBandSinceMs = null; return }
      const now = performance.now()
      if (outOfBandSinceMs == null) outOfBandSinceMs = now
      if (suspended) {
        if (now - outOfBandSinceMs < AUTO_SCROLL_REARM_MS) return
        suspended = false
      }
      if (now - lastCorrectionAtMs < AUTO_SCROLL_COOLDOWN_MS) return
      lastCorrectionAtMs = now
      correcting = true
      // 'scrollend' clears `correcting` as soon as the browser reports the
      // animation actually finished; this timeout is only the fallback for
      // engines/environments where that event never fires (jsdom in tests,
      // notably), so a missed event can't wedge auto-follow off forever.
      if (correctingTimer) clearTimeout(correctingTimer)
      correctingTimer = setTimeout(stopCorrecting, AUTO_SCROLL_COOLDOWN_MS)
      window.scrollBy({ top: viewportY - window.innerHeight * 0.35, behavior: 'smooth' })
    })

    return () => {
      unsubscribe()
      document.removeEventListener('scroll', onManualScroll, true)
      document.removeEventListener('scrollend', stopCorrecting)
      if (correctingTimer) clearTimeout(correctingTimer)
    }
  }, [hasPosition, isPlayingNow])

  const ticks = useMemo(
    () => buildTimelineTicks(durationS, collapsedGaps, pxPerSec),
    [durationS, collapsedGaps, pxPerSec],
  )

  const seekFromGutterClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    onSeek(Math.max(0, scale.toTime(e.clientY - rect.top)))
  }

  return (
    <div className="timeline-wrap">
      <div
        className="timeline-gutter"
        style={{ height: layout.height }}
        onClick={seekFromGutterClick}
        role="slider"
        aria-label="seek"
        aria-valuenow={player.position}
        tabIndex={0}
      >
        {ticks.map((tick) => (
          <div
            key={tick.s}
            className={`timeline-tick${tick.minor ? ' minor' : ''}`}
            style={{ top: scale.toY(tick.s) }}
          >
            {formatClock(tick.s)}
          </div>
        ))}
        {displacementMarks.map((m) => (
          <div
            key={`disp-${m.id}`}
            className="timeline-displacement-mark"
            style={{ top: m.trueY }}
            title="This segment's true time — nudged down here to avoid overlapping the block above it"
          />
        ))}
      </div>
      <div className="timeline-columns">
        <div className="timeline-header-row">
          {speakers.map((sp) => (
            <div key={sp} className="timeline-header">{speakerName.get(sp) ?? sp}</div>
          ))}
        </div>
        <div className="timeline-track" ref={trackRef} style={{ height: layout.height }}>
          {spans.map((s) => {
            const ci = speakers.indexOf(s.speaker ?? '')
            const col = ci === 0 ? '0' : ci === 1 ? '1' : 'both'
            const top = layout.ys.get(s.id) ?? scale.toY(s.startS)
            return (
              <div
                key={s.id}
                ref={(el) => {
                  if (el) blockRefs.current.set(s.id, el)
                  else blockRefs.current.delete(s.id)
                }}
                id={`segment-${s.id}`}
                data-col={col}
                className={`timeline-block${col === 'both' ? ' timeline-block-wide' : ''}${s.id === activeSegmentId ? ' now-playing' : ''}`}
                style={{ top }}
              >
                <span className={`segment-words${selectable ? ' selectable' : ''}`}>
                  {renderWords(bySegment.get(s.id) ?? [])}
                </span>
              </div>
            )
          })}
          {collapsedGaps.map((gap) => (
            <div
              key={`gap-${gap.startS}`}
              className="timeline-gap"
              style={{ top: scale.toY(gap.startS), height: scale.toY(gap.endS) - scale.toY(gap.startS) }}
            >
              ⋯ {formatDuration(gap.endS - gap.startS)} silence ⋯
            </div>
          ))}
          {/* transform-only, updated imperatively (see the effect above) —
              never a style prop recomputed from a `playheadS` render, which
              is what used to make this lag and then jump. */}
          {hasPosition && <div ref={playheadRef} className="timeline-playhead" />}
        </div>
      </div>
    </div>
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
