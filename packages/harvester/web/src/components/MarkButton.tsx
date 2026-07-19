import { useCallback, useEffect, useRef, useState } from 'react'

const TAP_MAX_MS = 400

export interface MarkChannel {
  down(): void
  up(mode: 'hold' | 'toggle'): void
}

/** One big thumb-height button (spacebar on desktop), two modes on one
 * gesture: a quick tap (<~400 ms) toggles a span open/closed; a long press
 * is press-and-hold — release closes. Used by the call UI and local
 * recording alike; the server stamps the times, this only sends edges. */
export function MarkButton({ channel, disabled = false, onChange }: {
  channel: MarkChannel
  disabled?: boolean
  onChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [pressing, setPressing] = useState(false)
  const pressAtRef = useRef(0)
  const openRef = useRef(false)

  const setSpan = useCallback((next: boolean) => {
    openRef.current = next
    setOpen(next)
    onChange?.(next)
  }, [onChange])

  const press = useCallback(() => {
    if (disabled) return
    if (openRef.current) {
      // second tap of a toggle: close
      channel.up('toggle')
      setSpan(false)
      return
    }
    pressAtRef.current = Date.now()
    setPressing(true)
    channel.down()
    setSpan(true)
  }, [disabled, channel, setSpan])

  const release = useCallback(() => {
    if (!pressing) return
    setPressing(false)
    if (Date.now() - pressAtRef.current >= TAP_MAX_MS) {
      // it was a hold: release closes
      channel.up('hold')
      setSpan(false)
    }
    // else: it was a tap — the span stays open until the next tap
  }, [pressing, channel, setSpan])

  useEffect(() => {
    if (disabled) return
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault()
      press()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      e.preventDefault()
      release()
    }
    // blur mid-hold: treat as release; an open toggle span survives a blur
    const blur = () => release()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [disabled, press, release])

  return (
    <button
      className={`hold big mark-button ${open ? 'active' : ''}`}
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); press() }}
      onPointerUp={release}
      onPointerLeave={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {open ? (
        <>
          <span className="mark-action">◉ MARKING…</span>
          <span className="mark-detail">tap to stop</span>
        </>
      ) : (
        <>
          <span className="mark-action">tap or hold</span>
          <span className="mark-detail">to start marking</span>
        </>
      )}
    </button>
  )
}
