import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtTime } from '../api'
import type { RangePlayer } from '../audio'

/** Icon play/pause button + a Spotify-style scrubber for one [start, end]
 * range out of a session's shared audio element. Stateless — everything it
 * shows is derived from `player` for this component's own `playerKey`, so a
 * whole list of these can sit side by side and only the one actually
 * loaded into the element will show a live, moving position; the rest
 * render at 0 until picked.
 *
 * The scrubber's value and the "m:ss / m:ss" readout have two sources,
 * deliberately: `offset` (below) is derived from `player.position`, the
 * COARSE state RangePlayer only updates on toggle/seek/pause — correct at
 * those rare moments, and what the JSX renders on an actual re-render (so
 * mount, a fresh seek, pausing all show the right place immediately). The
 * live 60fps sweep in between two such re-renders comes from
 * subscribePosition writing straight into the DOM via refs (see below) —
 * not from `offset`/state — so a playing scrubber doesn't force a React
 * render of this component (and everything around it) every single frame. */
export function SnippetPlayer({ player, playerKey, start, end, fallbackDuration, full, sessionId }: {
  player: RangePlayer
  playerKey: string
  start: number
  /** null for open-ended ranges (e.g. a speaker sample with no known end) —
   * playback itself will still run to the file's natural end in that case;
   * `fallbackDuration`/`player.duration` only supply a *visual* bound so
   * the scrubber isn't degenerate. */
  end: number | null
  fallbackDuration?: number | null
  /** Full-width "whole recording" variant (bigger button, more prominent
   * scrubber, a loudness waveform) for a session-level bar, as opposed to
   * the compact per-clip default used inline in snippet cards / speaker
   * samples — those stay plain, too short for a waveform to add anything
   * but visual noise. */
  full?: boolean
  /** Session id to fetch the loudness waveform for. Only read when `full`
   * is set — the compact variant never fetches peaks. */
  sessionId?: string
}) {
  const resolvedEnd = end ?? fallbackDuration ?? player.duration ?? start
  const dur = Math.max(0, resolvedEnd - start)
  const isActive = player.activeKey === playerKey
  const isPlaying = player.playingKey === playerKey
  const offset = isActive ? Math.min(Math.max(player.position - start, 0), dur) : 0

  const rangeRef = useRef<HTMLInputElement | null>(null)
  const timeRef = useRef<HTMLSpanElement | null>(null)

  // Live tracking while this clip is the one loaded into the shared
  // element: subscribe to the 60fps position feed and write the scrubber
  // value + readout straight to the DOM. Unsubscribes (and stops writing)
  // the instant this clip stops being the active one, at which point the
  // JSX's own `value={offset}`/`{fmtTime(offset)}` (both 0 when inactive)
  // take back over on the next real render.
  useEffect(() => {
    if (!isActive) return
    const apply = (t: number) => {
      const o = Math.min(Math.max(t - start, 0), dur)
      if (rangeRef.current) rangeRef.current.value = String(o)
      if (timeRef.current) timeRef.current.textContent = `${fmtTime(o)} / ${fmtTime(dur)}`
    }
    apply(player.getPosition())
    return player.subscribePosition(apply)
  }, [isActive, player, start, dur])

  const rangeInput = (
    <input
      ref={rangeRef}
      type="range"
      className={`scrubber${full ? ' waveform-range' : ''}`}
      aria-label="seek"
      min={0}
      max={dur > 0 ? dur : 1}
      step={0.05}
      value={offset}
      disabled={dur <= 0}
      onChange={(e) => player.seek(playerKey, start, end, Number(e.target.value))}
    />
  )

  return (
    <div className={`snippet-player${full ? ' session-player' : ''}`} onClick={(e) => e.stopPropagation()}>
      <button
        className="icon-btn"
        aria-label={isPlaying ? 'pause' : 'play'}
        onClick={() => player.toggle(playerKey, start, end)}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      {full
        ? (
          <Waveform sessionId={sessionId} player={player} playerKey={playerKey} start={start} dur={dur}>
            {rangeInput}
          </Waveform>
        )
        : rangeInput}
      <span className="time muted" ref={timeRef}>{fmtTime(offset)} / {fmtTime(dur)}</span>
    </div>
  )
}

/** SoundCloud-style loudness bars behind the (fully transparent, full-height)
 * range input passed in as `children` — the input still owns all pointer/
 * keyboard interaction and its thumb still paints on top; the canvas is
 * pure backdrop (pointer-events: none). Peaks are fetched once per mount;
 * while loading or on fetch error, the canvas draws a flat line matching
 * the plain scrubber's look instead of bars — same reserved height either
 * way, so nothing shifts when the real waveform arrives.
 *
 * Takes `player`/`playerKey`/`start`/`dur` rather than a pre-computed
 * `progress` number for the same reason SnippetPlayer's own scrubber does:
 * a `progress` PROP recomputed from 60fps `player.position` state would
 * force a React re-render (and therefore a canvas redraw) every single
 * frame during playback. Instead this subscribes directly and repaints
 * from the callback, independent of whatever rate the component around it
 * happens to re-render at. */
function Waveform({ sessionId, player, playerKey, start, dur, children }: {
  sessionId: string | undefined
  player: RangePlayer
  playerKey: string
  start: number
  dur: number
  children: React.ReactNode
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [barCount, setBarCount] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dprRef = useRef(1)
  // Read by `paint` on every position tick — a ref, not state, so a moving
  // progress tint doesn't have to re-render anything (see the position-
  // subscription effect below).
  const progressRef = useRef(0)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api.peaks(sessionId)
      .then((r) => { if (!cancelled) setPeaks(r.buckets) })
      .catch(() => { if (!cancelled) setPeaks(null) })
    return () => { cancelled = true }
  }, [sessionId])

  // Backing-store resolution tracks the container's actual CSS size (times
  // devicePixelRatio) so bars stay crisp; only recomputed on real resizes,
  // not on every position tick.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const dpr = window.devicePixelRatio || 1
      dprRef.current = dpr
      const w = Math.max(1, Math.round(entry.contentRect.width * dpr))
      const h = Math.max(1, Math.round(entry.contentRect.height * dpr))
      el.width = w
      el.height = h
      // ~2px bar + 1px gap, measured in the canvas's own (dpr-scaled) pixels.
      setBarCount(Math.max(1, Math.floor(w / (3 * dpr))))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Resampling the ~800 server buckets down to on-screen bar count is the
  // only non-trivial work here — cached so it only reruns when the peaks
  // data or the bar count (i.e. a real resize) changes, not on every
  // position-driven repaint (~60fps while playing).
  const barHeights = useMemo(() => {
    if (!peaks || barCount <= 0) return null
    const heights = new Array<number>(barCount)
    for (let i = 0; i < barCount; i++) {
      const srcStart = Math.floor((i * peaks.length) / barCount)
      const srcEnd = Math.max(srcStart + 1, Math.floor(((i + 1) * peaks.length) / barCount))
      let v = 0
      for (let j = srcStart; j < srcEnd; j++) v = Math.max(v, peaks[j] ?? 0)
      heights[i] = v
    }
    return heights
  }, [peaks, barCount])

  // The actual paint, factored out of both triggers below so "new bar
  // data / a real resize" and "a live position tick" run the exact same
  // drawing code instead of two copies that could drift apart. Reads
  // `progressRef` fresh each call rather than taking progress as an
  // argument, so the position-subscription effect further down can call it
  // with zero per-frame allocation.
  const paint = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    const style = getComputedStyle(canvas)
    const rule = style.getPropertyValue('--rule').trim() || '#c8c0ac'
    const accent = style.getPropertyValue('--accent').trim() || '#a0522d'
    ctx.clearRect(0, 0, w, h)
    if (!barHeights) {
      // Loading/error fallback: exactly the plain scrubber's look — a
      // thin flat line, no bars, no progress tint.
      const dpr = dprRef.current
      const lineH = Math.max(1, Math.round(5 * dpr))
      ctx.fillStyle = rule
      ctx.fillRect(0, (h - lineH) / 2, w, lineH)
      return
    }
    const dpr = dprRef.current
    const barW = 2 * dpr
    const gap = 1 * dpr
    const step = barW + gap
    const mid = h / 2
    const progress = progressRef.current
    for (let i = 0; i < barHeights.length; i++) {
      const barH = Math.max(dpr, barHeights[i]! * h)
      const x = i * step
      ctx.fillStyle = i / barHeights.length <= progress ? accent : rule
      ctx.fillRect(x, mid - barH / 2, barW, barH)
    }
  }

  // Redraw whenever the DATA changes (new peaks, a real resize) — with
  // whatever progress the ref currently holds (0 if this clip has never
  // been active).
  useEffect(paint, [barHeights])

  // Live tracking: while this clip is the active one, subscribe to the
  // 60fps position feed and repaint straight from the callback (see the
  // component doc comment for why this isn't a `progress` prop instead).
  const isActive = player.activeKey === playerKey
  useEffect(() => {
    if (!isActive) { progressRef.current = 0; paint(); return }
    const apply = (t: number) => {
      progressRef.current = dur > 0 ? Math.min(Math.max((t - start) / dur, 0), 1) : 0
      paint()
    }
    apply(player.getPosition())
    return player.subscribePosition(apply)
    // `paint` (and the `barHeights` it closes over) is deliberately not in
    // this dependency list: it's recreated fresh every render regardless,
    // this effect always calls whichever version is current by the time it
    // (re-)runs, and a `barHeights` change already gets its own repaint
    // from the effect above — this one only needs to react to identity
    // changes in isActive/player/start/dur, which decide whether/what to
    // subscribe to, not what to draw with.
  }, [isActive, player, start, dur])

  return (
    <div className="waveform-wrap">
      <canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />
      {children}
    </div>
  )
}
