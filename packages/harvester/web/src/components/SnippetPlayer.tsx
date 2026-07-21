import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtTime } from '../api'
import type { RangePlayer } from '../audio'

/** Icon play/pause button + a Spotify-style scrubber for one [start, end]
 * range out of a session's shared audio element. Stateless — everything it
 * shows is derived from `player` for this component's own `playerKey`, so a
 * whole list of these can sit side by side and only the one actually
 * loaded into the element will show a live, moving position; the rest
 * render at 0 until picked. */
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
   * the compact per-snippet default used inline in insight cards / speaker
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

  const rangeInput = (
    <input
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
        ? <Waveform sessionId={sessionId} progress={dur > 0 ? offset / dur : 0}>{rangeInput}</Waveform>
        : rangeInput}
      <span className="time muted">{fmtTime(offset)} / {fmtTime(dur)}</span>
    </div>
  )
}

/** SoundCloud-style loudness bars behind the (fully transparent, full-height)
 * range input passed in as `children` — the input still owns all pointer/
 * keyboard interaction and its thumb still paints on top; the canvas is
 * pure backdrop (pointer-events: none). Peaks are fetched once per mount;
 * while loading or on fetch error, the canvas draws a flat line matching
 * the plain scrubber's look instead of bars — same reserved height either
 * way, so nothing shifts when the real waveform arrives. */
function Waveform({ sessionId, progress, children }: {
  sessionId: string | undefined
  progress: number
  children: React.ReactNode
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [barCount, setBarCount] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dprRef = useRef(1)

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

  useEffect(() => {
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
    for (let i = 0; i < barHeights.length; i++) {
      const barH = Math.max(dpr, barHeights[i]! * h)
      const x = i * step
      ctx.fillStyle = i / barHeights.length <= progress ? accent : rule
      ctx.fillRect(x, mid - barH / 2, barW, barH)
    }
  }, [barHeights, progress])

  return (
    <div className="waveform-wrap">
      <canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />
      {children}
    </div>
  )
}
