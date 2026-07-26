/** The call's four audible signals — two gongs for the marking gesture, two
 * pings for the room's door — synthesized rather than shipped as files: they
 * are a few oscillators each, and a struck bell is easier to tune in numbers
 * than in a sample library.
 *
 * They are a shared instrument. Marking is a two-person gesture (see
 * JoinView's `remoteMarking`), so both sides hear both gongs: the sound is
 * "a mark just happened", not "you pressed a button".
 *
 * The two gongs are the same bell struck twice, and only the direction
 * differs — G4 rising to its fifth opens a span, G4 falling to the tonic
 * below closes it. That's what makes them tell each other apart without
 * having to be loud about it: you hear an opening or a settling, not two
 * unrelated noises. The door pings are plain sine blips, deliberately a
 * different, lighter voice — nobody should confuse someone arriving with a
 * mark being taken.
 *
 * Everything routes through the same output device the call itself uses
 * (setSinkId, as the remote audio elements do) rather than the system
 * default — with earbuds in, a gong out of the laptop speakers would be
 * both startling and, being in front of the microphone, recorded. */

/** Partials of a struck bell: slightly inharmonic (2.01, 2.99, 4.18 rather
 * than 2, 3, 4 — exact harmonics sound like an organ, not a bell), and the
 * higher ones die away faster, which is what makes a strike read as metal
 * ringing rather than a chord being held. */
const BELL_PARTIALS = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2.01, gain: 0.4, decay: 0.6 },
  { ratio: 2.99, gain: 0.2, decay: 0.38 },
  { ratio: 4.18, gain: 0.1, decay: 0.24 },
]

const G4 = 392
const C4 = 261.63
const D5 = 587.33
const A5 = 880

const SUPPORTS_SINK_ID = typeof HTMLMediaElement !== 'undefined'
  && 'setSinkId' in HTMLMediaElement.prototype
type SinkableElement = HTMLMediaElement & { setSinkId(deviceId: string): Promise<void> }

export interface CallChimes {
  /** A mark span opened — rising. */
  markStart(): void
  /** A mark span closed — settling. */
  markEnd(): void
  /** Someone joined the call. */
  joined(): void
  /** Someone left the call. */
  left(): void
  /** Follow the call's output-device choice. */
  setSink(deviceId: string | null): void
  close(): void
}

export function createCallChimes(): CallChimes {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let stream: MediaStreamAudioDestinationNode | null = null
  let el: HTMLAudioElement | null = null
  let sink: string | null = null
  let closed = false

  /** Build (once) and un-suspend. Browsers hand out a suspended context to a
   * page that hasn't been interacted with; every call site here is either a
   * gesture or downstream of the click that joined the call, so resuming on
   * each play is enough — no separate unlock ceremony. */
  const ensure = (): AudioContext | null => {
    if (closed) return null
    if (!ctx) {
      try {
        ctx = new AudioContext()
      } catch {
        // No Web Audio (or it refused to construct): the call is unaffected,
        // it just runs silent. Never worth throwing into a live call.
        closed = true
        return null
      }
      master = ctx.createGain()
      master.gain.value = 0.9
      stream = ctx.createMediaStreamDestination()
      el = new Audio()
      el.srcObject = stream.stream
      route()
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  }

  /** Straight out of the context when no particular speaker was chosen —
   * the shortest, most reliable path. Only when the call has picked an
   * output device do we detour through a MediaStream and an <audio>
   * element, which is the one way to aim Web Audio at a chosen sink; if
   * that element refuses to play, fall back rather than going silent. */
  const route = (): void => {
    if (!ctx || !master || !stream || !el) return
    master.disconnect()
    if (sink && SUPPORTS_SINK_ID) {
      master.connect(stream)
      void (el as SinkableElement).setSinkId(sink).catch(() => {})
      void el.play().catch(() => {
        master?.disconnect()
        if (ctx) master?.connect(ctx.destination)
      })
    } else {
      el.pause()
      master.connect(ctx.destination)
    }
  }

  /** One struck note: the partials above, each on its own decay, through a
   * lowpass that decides how bright the strike is. `at` is an offset from
   * now, which is how the two-note gongs are written below. */
  const bell = (at: number, freq: number, peak: number, decay: number, tone: number): void => {
    if (!ctx || !master) return
    const t = ctx.currentTime + 0.02 + at
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = tone
    filter.connect(master)
    for (const p of BELL_PARTIALS) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq * p.ratio
      const gain = ctx.createGain()
      const life = decay * p.decay
      gain.gain.setValueAtTime(0, t)
      // 8ms of attack: enough to avoid the click of a hard start, short
      // enough to still be a strike rather than a swell.
      gain.gain.linearRampToValueAtTime(peak * p.gain, t + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + life)
      osc.connect(gain).connect(filter)
      osc.start(t)
      osc.stop(t + life + 0.05)
    }
  }

  /** A plain sine blip — the door's voice, no partials, nothing metallic. */
  const ping = (at: number, freq: number, peak: number, decay: number): void => {
    if (!ctx || !master) return
    const t = ctx.currentTime + 0.02 + at
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(peak, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    osc.connect(gain).connect(master)
    osc.start(t)
    osc.stop(t + decay + 0.05)
  }

  return {
    markStart() {
      if (!ensure()) return
      // G4 answered by its fifth: an opening, held bright and ringing.
      bell(0, G4, 0.16, 1.9, 4200)
      bell(0.09, D5, 0.11, 1.7, 4200)
    },
    markEnd() {
      if (!ensure()) return
      // The same strike falling to the tonic below, darker and longer: the
      // span is closed and kept, not cancelled.
      bell(0, G4, 0.13, 1.6, 2600)
      bell(0.11, C4, 0.16, 2.6, 2200)
    },
    joined() {
      if (!ensure()) return
      ping(0, D5, 0.1, 0.19)
      ping(0.1, A5, 0.1, 0.24)
    },
    left() {
      if (!ensure()) return
      // The same two notes the other way round, quieter and shorter — a
      // door closing should be less of an event than one opening.
      ping(0, A5, 0.075, 0.17)
      ping(0.1, D5, 0.075, 0.22)
    },
    setSink(deviceId) {
      sink = deviceId
      // Only re-route an engine that already exists — building one just to
      // remember a device would start an audio context for nothing.
      if (ctx) route()
    },
    close() {
      closed = true
      el?.pause()
      el = null
      const dying = ctx
      ctx = null
      master = null
      stream = null
      void dying?.close().catch(() => {})
    },
  }
}
