import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRangePlayer } from './audio'

// --- the position-subscription contract --------------------------------------
// seek()/toggle()/playFrom() all notify subscribers SYNCHRONOUSLY (see
// audio.ts's `notify`) — the same code path the 60fps rAF tick loop uses
// while actually playing, just triggered here without needing to fake a
// real 'play' event + animation-frame loop through jsdom's inert
// HTMLMediaElement (play()/pause() are stubbed no-ops there, and jsdom
// never fires 'play' on its own). seek() in particular has no other side
// effects worth mocking around, which is why these tests drive it directly
// rather than toggle()/playFrom() (both of which also call el.play()).
describe('useRangePlayer position subscription', () => {
  it('notifies a subscriber synchronously on seek, updates getPosition, and stops after unsubscribing', () => {
    const { result } = renderHook(() => useRangePlayer('test-session'))
    const seen: number[] = []
    let unsubscribe = () => {}

    act(() => {
      unsubscribe = result.current.subscribePosition((t) => seen.push(t))
    })

    act(() => {
      result.current.seek('clip', 10, 20, 2) // clamps to start + offset = 12
    })
    expect(seen).toEqual([12])
    expect(result.current.getPosition()).toBe(12)

    act(() => { unsubscribe() })
    act(() => {
      result.current.seek('clip', 10, 20, 5) // -> 15, but nobody's listening anymore
    })
    expect(seen).toEqual([12]) // unchanged: the unsubscribed callback never fires again
    expect(result.current.getPosition()).toBe(15) // the live value itself still tracks, subscriber or not
  })

  it('supports multiple independent subscribers, each unsubscribing on its own', () => {
    const { result } = renderHook(() => useRangePlayer('test-session'))
    const a: number[] = []
    const b: number[] = []
    let unsubA = () => {}

    act(() => {
      unsubA = result.current.subscribePosition((t) => a.push(t))
      result.current.subscribePosition((t) => b.push(t))
    })

    act(() => { result.current.seek('clip', 0, 10, 3) })
    expect(a).toEqual([3])
    expect(b).toEqual([3])

    act(() => { unsubA() })
    act(() => { result.current.seek('clip', 0, 10, 4) })
    expect(a).toEqual([3]) // a stopped listening
    expect(b).toEqual([3, 4]) // b is still subscribed
  })

  it('leaves `position` (the coarse state) and getPosition() in sync after a seek', () => {
    // `position` is the deliberately-coarse React-state field (see
    // RangePlayer's doc comment) — seek() still updates it synchronously,
    // same as before this change, so a component reading it on a normal
    // render sees the right place immediately after a seek/toggle/pause.
    const { result } = renderHook(() => useRangePlayer('test-session'))
    act(() => { result.current.seek('clip', 5, 15, 1) })
    expect(result.current.position).toBe(6)
    expect(result.current.getPosition()).toBe(6)
  })
})

// --- togglePlayPause ----------------------------------------------------------
// jsdom's HTMLMediaElement.play()/pause() are pure no-op stubs — `.paused`
// never actually flips to `false` no matter how many times play() is
// called (verified directly; see the PR discussion) — so the "currently
// playing → pause in place" branch can't be exercised through real jsdom
// state the way "resume" and "restart after finished" can. These tests
// subclass the global `Audio` constructor to capture the underlying
// element, which is what makes "finished" reachable at all: `finishedRef`
// is only ever set by audio.ts's own 'timeupdate' listener, so faking
// "finished" means actually dispatching that event, not just calling a
// public method.
describe('useRangePlayer togglePlayPause', () => {
  let created: HTMLAudioElement[]

  beforeEach(() => {
    created = []
    const OriginalAudio = window.Audio
    class TrackedAudio extends OriginalAudio {
      constructor(src?: string) {
        super(src)
        created.push(this)
      }
    }
    vi.stubGlobal('Audio', TrackedAudio)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is a no-op when nothing is loaded', () => {
    const { result } = renderHook(() => useRangePlayer('test-session'))
    expect(() => act(() => result.current.togglePlayPause())).not.toThrow()
    expect(result.current.activeKey).toBeNull()
    expect(result.current.playingKey).toBeNull()
  })

  it('resumes (calls play() again) when something is loaded and has not finished, without touching currentTime', () => {
    const { result } = renderHook(() => useRangePlayer('test-session'))
    act(() => { result.current.playFrom('clip', 0, 10, 0) })
    const el = created[0]!
    const playSpy = vi.spyOn(el, 'play')

    act(() => { result.current.togglePlayPause() })

    expect(playSpy).toHaveBeenCalled()
    // The resume path never touches currentTime — only a finished range's
    // restart does (see the next test).
    expect(result.current.getPosition()).toBe(0)
  })

  it("restarts from the active range's own start, correctly restoring its own end as the new stop point, once it has finished", () => {
    const { result } = renderHook(() => useRangePlayer('test-session'))
    act(() => { result.current.playFrom('clip', 5, 10, 0) })
    const el = created[0]!

    // Drive the range to its own end the same way real playback would:
    // audio.ts's 'timeupdate' listener is what actually sets finishedRef
    // (and, critically, clears `stopAt` back to null) — there's no public
    // way to fake "finished" other than triggering the real event it
    // listens for.
    el.currentTime = 10
    act(() => { el.dispatchEvent(new Event('timeupdate')) })

    const playSpy = vi.spyOn(el, 'play')
    act(() => { result.current.togglePlayPause() })

    expect(el.currentTime).toBe(5) // restarted from the range's own start
    expect(result.current.getPosition()).toBe(5)
    expect(playSpy).toHaveBeenCalled()

    // Prove the restart actually restored the range's END as the new stop
    // point too, not just its start: `stopAt` was nulled out by onTime
    // above, so if togglePlayPause's restart hadn't restored it from
    // rangeEndRef, this second timeupdate at currentTime 10 would never
    // re-trigger a finish, and the NEXT togglePlayPause would wrongly take
    // the "resume" branch (leaving currentTime at 10) instead of
    // restarting again (back to 5).
    el.currentTime = 10
    act(() => { el.dispatchEvent(new Event('timeupdate')) })
    act(() => { result.current.togglePlayPause() })
    expect(el.currentTime).toBe(5)
  })
})
