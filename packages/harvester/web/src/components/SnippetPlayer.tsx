import { fmtTime } from '../api'
import type { RangePlayer } from '../audio'

/** Icon play/pause button + a Spotify-style scrubber for one [start, end]
 * range out of a session's shared audio element. Stateless — everything it
 * shows is derived from `player` for this component's own `playerKey`, so a
 * whole list of these can sit side by side and only the one actually
 * loaded into the element will show a live, moving position; the rest
 * render at 0 until picked. */
export function SnippetPlayer({ player, playerKey, start, end, fallbackDuration }: {
  player: RangePlayer
  playerKey: string
  start: number
  /** null for open-ended ranges (e.g. a speaker sample with no known end) —
   * playback itself will still run to the file's natural end in that case;
   * `fallbackDuration`/`player.duration` only supply a *visual* bound so
   * the scrubber isn't degenerate. */
  end: number | null
  fallbackDuration?: number | null
}) {
  const resolvedEnd = end ?? fallbackDuration ?? player.duration ?? start
  const dur = Math.max(0, resolvedEnd - start)
  const isActive = player.activeKey === playerKey
  const isPlaying = player.playingKey === playerKey
  const offset = isActive ? Math.min(Math.max(player.position - start, 0), dur) : 0

  return (
    <div className="snippet-player" onClick={(e) => e.stopPropagation()}>
      <button
        className="icon-btn"
        aria-label={isPlaying ? 'pause' : 'play'}
        onClick={() => player.toggle(playerKey, start, end)}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      <input
        type="range"
        className="scrubber"
        aria-label="seek"
        min={0}
        max={dur > 0 ? dur : 1}
        step={0.05}
        value={offset}
        disabled={dur <= 0}
        onChange={(e) => player.seek(playerKey, start, end, Number(e.target.value))}
      />
      <span className="time muted">{fmtTime(offset)} / {fmtTime(dur)}</span>
    </div>
  )
}
