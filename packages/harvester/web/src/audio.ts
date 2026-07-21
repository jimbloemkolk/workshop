import { useEffect, useRef, useState } from 'react'
import { api } from './api'

export interface RangePlayer {
  /** Key of the snippet currently loaded into the shared audio element —
   * set by toggle()/seek() and sticky across pause or natural finish, so a
   * scrubber can keep showing where that snippet was left. Only changes
   * when a *different* key takes the element over. */
  activeKey: string | null
  /** Subset of activeKey: null whenever the element isn't actually running
   * right now (paused or finished). Driven off the element's own
   * play/pause events, never set imperatively, so it can't drift from what
   * the browser is really doing. */
  playingKey: string | null
  /** Live position within the whole file, in seconds. Updated via
   * requestAnimationFrame while playing (timeupdate only fires ~4x/s,
   * which is choppy for a few-second range) and synchronously on
   * toggle()/seek() so a paused scrubber doesn't wait a frame to catch up.
   * Only meaningful for the snippet matching activeKey — subtract that
   * snippet's own `start` to get an offset into its range. */
  position: number
  /** Whole-file duration once metadata has loaded, else null. A last-resort
   * bound for open-ended ranges (end === null) when the caller has no
   * better duration of its own to fall back to. */
  duration: number | null
  /** Play/pause/resume a [start, end] range under `key`:
   *  - same key, currently playing → pause in place.
   *  - same key, paused mid-range (hasn't finished) → resume from currentTime.
   *  - anything else (different key, or same key that already finished) →
   *    start over from `start`. */
  toggle(key: string, start: number, end: number | null): void
  /** Seek within `key`'s [start, end] range to `start + offsetS`. Scrubbing
   * a key that isn't already active takes the element over (pausing
   * whatever was playing) but never auto-plays; scrubbing the key that's
   * already active just moves currentTime, so playback (if any) continues
   * uninterrupted from the new position. */
  seek(key: string, start: number, end: number | null, offsetS: number): void
  stop(): void
}

/** One audio element per session; play arbitrary [start, end] ranges from
 * the master recording — nothing is sliced until export. */
export function useRangePlayer(sessionId: string): RangePlayer {
  const ref = useRef<HTMLAudioElement | null>(null)
  const stopAt = useRef<number | null>(null)
  // Which key the element is loaded with, and whether that range already
  // played through to its end (stopAt reached, or natural EOF) rather than
  // being paused mid-way. Refs, not state: toggle()/seek() branch on these
  // synchronously and can't afford to read a stale value from a closure
  // captured before the last render.
  const keyRef = useRef<string | null>(null)
  const finishedRef = useRef(false)
  const rafRef = useRef<number | null>(null)

  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)

  useEffect(() => {
    const el = new Audio(api.audioUrl(sessionId))
    el.preload = 'metadata'

    const stopTick = () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    }
    const tick = () => {
      setPosition(el.currentTime)
      rafRef.current = requestAnimationFrame(tick)
    }

    const onTime = () => {
      if (stopAt.current != null && el.currentTime >= stopAt.current) {
        el.pause()
        stopAt.current = null
        finishedRef.current = true
      }
    }
    // 'pause' covers both explicit user pauses and the el.pause() above —
    // it's the single source of truth for playingKey turning off, and also
    // where the rAF loop stops. 'ended' is a backstop for open-ended
    // ranges (end === null) that run off the end of the file without ever
    // hitting the stopAt check in onTime.
    const onPause = () => { setPlayingKey(null); setPosition(el.currentTime); stopTick() }
    const onPlay = () => { setPlayingKey(keyRef.current); tick() }
    const onEnded = () => { finishedRef.current = true }
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : null)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('pause', onPause)
    el.addEventListener('play', onPlay)
    el.addEventListener('ended', onEnded)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    ref.current = el
    keyRef.current = null
    finishedRef.current = false
    stopAt.current = null
    setActiveKey(null)
    setPlayingKey(null)
    setPosition(0)
    setDuration(null)
    return () => {
      stopTick()
      el.pause()
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      ref.current = null
    }
  }, [sessionId])

  return {
    activeKey,
    playingKey,
    position,
    duration,
    toggle(key, start, end) {
      const el = ref.current
      if (!el) return
      if (keyRef.current === key && !el.paused) {
        el.pause()
        return
      }
      if (keyRef.current === key && el.paused && !finishedRef.current) {
        void el.play()
        return
      }
      // Switching keys (or restarting one that already finished): seeking
      // currentTime fires no event, and play() on an already-playing
      // element is a no-op that fires no 'play' either — so playingKey
      // would stay stuck on the old key. Force a real paused→playing
      // transition by pausing first, so the subsequent play() actually
      // fires 'play' and picks up the reassigned keyRef.
      el.pause()
      el.currentTime = Math.max(0, start)
      stopAt.current = end
      keyRef.current = key
      finishedRef.current = false
      setActiveKey(key)
      setPosition(el.currentTime)
      void el.play()
    },
    seek(key, start, end, offsetS) {
      const el = ref.current
      if (!el) return
      // Taking over a different key must not auto-play it — pausing here
      // both enforces that and stops whatever the old key was playing.
      // Scrubbing the already-active key skips this, so playback (if any)
      // rides through the seek uninterrupted.
      if (keyRef.current !== key) el.pause()
      const bound = end ?? Infinity
      el.currentTime = Math.min(Math.max(start, start + Math.max(0, offsetS)), bound)
      stopAt.current = end
      keyRef.current = key
      finishedRef.current = false
      setActiveKey(key)
      setPosition(el.currentTime)
    },
    stop() {
      ref.current?.pause()
      stopAt.current = null
    },
  }
}
