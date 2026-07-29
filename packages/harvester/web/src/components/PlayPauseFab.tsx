import type { RangePlayer } from '../audio'

/** Pause/resume whatever's currently loaded into the shared player, without
 * scrolling back up to the session bar (or whichever snippet card started
 * it) just to reach a play/pause button. Bottom-left, right beside
 * ToTopButton — the two are positioned and styled as a single pair via the
 * shared `.fab` class and --fab-* custom properties in styles.css, even
 * though they're rendered from entirely different components: this one
 * from ReviewView (since the player — `useRangePlayer` — lives there),
 * ToTopButton from App.tsx. See ToTopButton's own doc comment for the other
 * half of that split.
 *
 * Visible exactly when something is loaded (`player.activeKey != null`),
 * mirroring ToTopButton's "only show it when it has something to do" — and
 * kept mounted-but-faded rather than conditionally rendered, for the same
 * reason: an eased fade in/out reads as considered, not a blink. Since both
 * buttons are independently `position: fixed`, ToTopButton fading in/out on
 * scroll never shifts this one's position (verified: `left` here is
 * computed purely from the --fab-* constants, never from ToTopButton's own
 * layout box). */
export function PlayPauseFab({ player }: { player: RangePlayer }) {
  const shown = player.activeKey != null
  const isPlaying = player.playingKey != null
  const label = isPlaying ? 'Pause' : 'Play'

  return (
    <button
      className={`fab play-pause-fab${shown ? '' : ' away'}`}
      type="button"
      aria-label={label}
      title={label}
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
      onClick={() => player.togglePlayPause()}
    >
      {isPlaying ? '⏸' : '▶'}
    </button>
  )
}
