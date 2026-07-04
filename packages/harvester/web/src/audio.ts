import { useEffect, useRef } from 'react'
import { api } from './api'

/** One audio element per session; play arbitrary [start, end] ranges from
 * the master recording — nothing is sliced until export. */
export function useRangePlayer(sessionId: string) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const stopAt = useRef<number | null>(null)

  useEffect(() => {
    const el = new Audio(api.audioUrl(sessionId))
    el.preload = 'metadata'
    const onTime = () => {
      if (stopAt.current != null && el.currentTime >= stopAt.current) {
        el.pause()
        stopAt.current = null
      }
    }
    el.addEventListener('timeupdate', onTime)
    ref.current = el
    return () => {
      el.pause()
      el.removeEventListener('timeupdate', onTime)
      ref.current = null
    }
  }, [sessionId])

  return {
    playRange(start: number, end: number | null) {
      const el = ref.current
      if (!el) return
      el.currentTime = Math.max(0, start)
      stopAt.current = end
      void el.play()
    },
    stop() {
      ref.current?.pause()
      stopAt.current = null
    },
  }
}
