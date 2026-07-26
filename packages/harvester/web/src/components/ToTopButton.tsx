import { useEffect, useState } from 'react'

/** How far down the page has to be before the button is worth offering —
 * roughly a screenful, so it never appears while you're still near the top
 * where it would do nothing. */
const APPEAR_AFTER_PX = 400

/** Back to the top of the session. Bottom-left on purpose: the right margin
 * of the review screen is where the braces run and where the snippet cards
 * sit, and the left gutter is the one part of the page with nothing in it.
 *
 * No label — the arrow is the whole message — but it still carries an
 * accessible name, since a button with no text is nameless to a screen
 * reader otherwise. */
export function ToTopButton() {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      setShown(window.scrollY > APPEAR_AFTER_PX)
    }
    // rAF-coalesced, like everything else that listens to this page's scroll:
    // the event fires far more often than the frame it would paint into.
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  // Kept mounted and faded rather than unmounted, so it eases in and out
  // instead of blinking into existence mid-scroll; `hidden` also takes it
  // out of the tab order and off the pointer.
  return (
    <button
      className={`to-top${shown ? '' : ' away'}`}
      type="button"
      aria-label="Back to top"
      title="Back to top"
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
      onClick={() => {
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })
      }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path d="M12 19.5V5.4M5.6 11.8 12 5l6.4 6.8" />
      </svg>
    </button>
  )
}
