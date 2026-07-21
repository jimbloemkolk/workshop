import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConnectionQuality, ConnectionState, LocalAudioTrack, RemoteParticipant, Room, RoomEvent, Track,
  type LocalTrackPublication, type Participant, type RemoteTrack, type RemoteTrackPublication,
} from 'livekit-client'
import { api } from '../api'
import { MarkButton, type MarkChannel } from '../components/MarkButton'
import { getSettings } from '../settings'
import { createCallSocket, type ServerEvent } from '../socket'
import type { Socket } from 'socket.io-client'

/** The standalone /join/<id>#<token> page — what the shared link opens on a
 * phone. Works without the rest of the harvester UI: lobby (mic picker +
 * waveform) then the in-call screen (mute, device switch, connection
 * state, End call). The token rides the URL fragment so it never hits proxy
 * logs. */
export function JoinView({ sessionId }: { sessionId: string }) {
  const token = location.hash.slice(1)
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [ended, setEnded] = useState(false)
  const [speakerId, setSpeakerId] = useState<string | null>(null)

  useEffect(() => {
    api.call.joinInfo(sessionId)
      .then((info) => { setLivekitUrl(info.livekitUrl); setTitle(info.title) })
      .catch((e) => setError(String(e)))
  }, [sessionId])

  if (!token) return <JoinShell title={title}><p className="error">This link is missing its token fragment.</p></JoinShell>
  if (error) return <JoinShell title={title}><p className="error">{error}</p></JoinShell>
  if (ended) return <JoinShell title={title}><p>Call ended. You can close this page.</p></JoinShell>
  if (!livekitUrl) return <JoinShell title={title}><p className="muted">loading…</p></JoinShell>

  return room ? (
    <InCall
      room={room}
      sessionId={sessionId}
      token={token}
      title={title}
      initialSpeakerId={speakerId}
      onEnded={() => { setRoom(null); setEnded(true) }}
      onError={setError}
    />
  ) : (
    <Lobby
      title={title}
      onJoin={async (deviceId, outputId) => {
        try {
          const r = new Room({
            audioCaptureDefaults: {
              ...(deviceId ? { deviceId } : {}),
              // Rnnoise replaces the browser's own noise suppression; echo
              // cancellation stays on — tested against the interactive demo
              // and confirmed as the better-sounding combination.
              noiseSuppression: false,
              echoCancellation: true,
            },
          })
          r.on(RoomEvent.LocalTrackPublished, (pub) => { void enableRnnoise(pub) })
          await r.connect(livekitUrl, token)
          await r.localParticipant.setMicrophoneEnabled(true)
          setSpeakerId(outputId)
          setRoom(r)
        } catch (e) { setError(String(e)) }
      }}
    />
  )
}

/** `HTMLMediaElement.setSinkId` (output-device routing) isn't in every
 * browser yet — feature-detect once and hide the speaker picker/test where
 * it wouldn't do anything. */
const SUPPORTS_SINK_ID = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
type SinkableElement = HTMLMediaElement & { setSinkId(deviceId: string): Promise<void> }

function applySink(el: HTMLMediaElement, deviceId: string | null): void {
  if (!SUPPORTS_SINK_ID || !deviceId) return
  void (el as SinkableElement).setSinkId(deviceId).catch(() => {})
}

/** RNNoise ML voice isolation on the published mic track — real feedback was
 * "harde geluiden (afwassen etc.) komen te hard over, stemmen moeten beter
 * naar boven komen," which the browser's own noiseSuppression (tuned for
 * steady-state hums) doesn't handle well. Dynamically imported so the WASM
 * model only downloads once a call actually starts. Self-hosted-friendly —
 * LiveKit's own Krisp integration needs a LiveKit Cloud account and 404s
 * against self-hosted livekit-server. */
async function enableRnnoise(pub: LocalTrackPublication): Promise<void> {
  if (pub.source !== Track.Source.Microphone || !(pub.track instanceof LocalAudioTrack)) return
  try {
    const { RnnoiseProcessor } = await import('../rnnoiseProcessor')
    await pub.track.setProcessor(new RnnoiseProcessor())
  } catch (err) {
    console.warn('RNNoise processor failed to start', err)
  }
}

/** A short local beep routed through the chosen output device — "does this
 * headphone actually work" answered without needing the other side on the
 * call yet. */
async function playTestTone(deviceId: string | null): Promise<void> {
  const ctx = new AudioContext()
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = 440
  const gain = ctx.createGain()
  gain.gain.value = 0.15
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain).connect(dest)
  const el = new Audio()
  el.srcObject = dest.stream
  applySink(el, deviceId)
  osc.start()
  await el.play().catch(() => {})
  setTimeout(() => { osc.stop(); el.pause(); void ctx.close() }, 600)
}

/** Chrome (and others) label the OS-default input "Default - <name>"; the
 * lobby's own placeholder option calls the same idea "System default". Strip
 * the browser's prefix so both screens use the same words for it. */
function deviceLabel(label: string): string {
  const m = /^default\s*[-–—:]?\s*/i.exec(label)
  if (!m) return label || 'microphone'
  const rest = label.slice(m[0].length)
  return rest ? `System default (${rest})` : 'System default'
}

function JoinShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="join">
      <header><span>🌾 {title || 'Harvester call'}</span></header>
      {children}
    </div>
  )
}

// ---- lobby -----------------------------------------------------------------

function Lobby({ title, onJoin }: {
  title: string
  onJoin: (deviceId: string | null, speakerId: string | null) => Promise<void>
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [speakerId, setSpeakerId] = useState<string | null>(null)
  const [permission, setPermission] = useState<'pending' | 'ok' | 'denied'>('pending')
  const [joining, setJoining] = useState(false)
  const [testing, setTesting] = useState(false)
  const probeTrack = useMicProbe(permission === 'ok' ? deviceId : undefined)

  useEffect(() => {
    let cancelled = false
    // one probe stream: unlocks device labels + proves permission
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(async (stream) => {
        stream.getTracks().forEach((t) => t.stop())
        const all = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setDevices(all.filter((d) => d.kind === 'audioinput'))
        setSpeakers(all.filter((d) => d.kind === 'audiooutput'))
        setPermission('ok')
      })
      .catch(() => { if (!cancelled) setPermission('denied') })
    return () => { cancelled = true }
  }, [])

  return (
    <JoinShell title={title}>
      <main className="lobby">
        <h1>Ready to join?</h1>
        {permission === 'denied' && (
          <p className="error">Microphone access is required — allow it and reload.</p>
        )}
        {permission === 'ok' && (
          <>
            <label className="field">
              Microphone
              <select value={deviceId ?? ''} onChange={(e) => setDeviceId(e.target.value || null)}>
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d.label)}</option>
                ))}
              </select>
            </label>
            <Waveform track={probeTrack} />
            {SUPPORTS_SINK_ID && speakers.length > 0 && (
              <label className="field">
                Headphones / speaker
                <div className="row">
                  <select
                    value={speakerId ?? ''}
                    onChange={(e) => setSpeakerId(e.target.value || null)}
                  >
                    <option value="">System default</option>
                    {speakers.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d.label)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={testing}
                    onClick={async () => {
                      setTesting(true)
                      await playTestTone(speakerId)
                      setTesting(false)
                    }}
                  >
                    {testing ? '♪ playing…' : '▶ test sound'}
                  </button>
                </div>
              </label>
            )}
          </>
        )}
        <button
          className="primary big"
          disabled={permission !== 'ok' || joining}
          onClick={async () => { setJoining(true); await onJoin(deviceId, speakerId); setJoining(false) }}
        >
          {joining ? 'Joining…' : '📞 Join call'}
        </button>
      </main>
    </JoinShell>
  )
}

/** Raw probe-stream track for the lobby mic picker — a fresh getUserMedia
 * per device change, stopped on cleanup. */
function useMicProbe(deviceId: string | null | undefined): MediaStreamTrack | null {
  const [track, setTrack] = useState<MediaStreamTrack | null>(null)
  useEffect(() => {
    if (deviceId === undefined) return
    let stream: MediaStream | null = null
    let stopped = false
    navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      setTrack(s.getAudioTracks()[0] ?? null)
    }).catch(() => {})
    return () => {
      stopped = true
      setTrack(null)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [deviceId])
  return track
}

/** Your own published mic track (not a fresh probe stream) — the
 * "equalizer" that answers "am I actually producing signal right now,"
 * visible for the whole call, not just the lobby: there's otherwise no way
 * to tell whether you're audible to the other side. Reflects whatever is
 * actually being sent, RNNoise-processed audio included. */
function useLocalMicTrack(room: Room): MediaStreamTrack | null {
  const [track, setTrack] = useState<MediaStreamTrack | null>(null)
  useEffect(() => {
    const refresh = () => {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
      setTrack(!pub || pub.isMuted ? null : pub.track?.mediaStreamTrack ?? null)
    }
    refresh()
    room
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.ActiveDeviceChanged, refresh)
    return () => {
      room
        .off(RoomEvent.LocalTrackPublished, refresh)
        .off(RoomEvent.LocalTrackUnpublished, refresh)
        .off(RoomEvent.TrackMuted, refresh)
        .off(RoomEvent.TrackUnmuted, refresh)
        .off(RoomEvent.ActiveDeviceChanged, refresh)
    }
  }, [room])
  return track
}

/** Only touch-capable devices actually auto-lock their screen on idle in a
 * way that matters here — used to gate the wake-lock-failed warning so it
 * never shows on desktop, where there's no screen-lock/mic-death failure
 * mode to explain in the first place. Computed once; input capability
 * doesn't change mid-session. */
const IS_TOUCH_DEVICE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

type WakeLockStatus = 'idle' | 'active' | 'unsupported' | 'failed'

/** Screen Wake Lock: keeps the phone from auto-locking mid-call, which
 * otherwise kills the microphone the instant the screen sleeps. Only ever
 * prevents the *idle-timeout* lock — it's released the moment the tab is
 * hidden and can't survive a manual power-button press, but that's exactly
 * the failure mode this exists to fix, not a limitation to work around.
 * Requested inside the Join click (a user gesture) via `active` flipping
 * true; re-requested on visibilitychange→visible since backgrounding always
 * releases it. iOS intermittently throws NotAllowedError on re-acquire for
 * reasons outside app control, so each attempt gets one retry before giving
 * up — `status` only ever settles into 'failed' once both attempts are
 * spent, so callers can distinguish "still trying" from "truly can't" and
 * avoid flashing a warning during the first, usually-successful attempt. */
function useWakeLock(active: boolean): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>('idle')
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active) { setStatus('idle'); return }
    if (!navigator.wakeLock) { setStatus('unsupported'); return }
    let cancelled = false

    const acquire = async (retriesLeft: number): Promise<void> => {
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (cancelled) { void sentinel.release(); return }
        sentinelRef.current = sentinel
        setStatus('active')
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null
        })
      } catch {
        if (cancelled) return
        if (retriesLeft > 0) await acquire(retriesLeft - 1)
        else setStatus('failed')
      }
    }
    void acquire(1)

    const onVisible = () => {
      // The lock auto-releases (clearing sentinelRef via the 'release'
      // listener above) the moment the tab hides, so re-acquiring
      // unconditionally on every visible transition can't double-acquire.
      if (document.visibilityState === 'visible') void acquire(1)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      const s = sentinelRef.current
      sentinelRef.current = null
      if (s) void s.release()
    }
  }, [active])

  return status
}

/** WebKit-only, feature-detected, no ambient lib changes — a plain local
 * cast rather than augmenting the global Navigator type. Pure routing
 * polish (correct earpiece/speaker + ducking on iOS); does nothing for
 * background survival, so it's set-and-forget once per call, unlike the
 * wake lock which needs the full re-acquire dance above. */
function setPlayAndRecordAudioSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } }
  try { if (nav.audioSession) nav.audioSession.type = 'play-and-record' } catch { /* ignore */ }
}

const WAVEFORM_FFT_SIZE = 2048

/** Oscilloscope-style waveform, the technique borrowed from the
 * web-noise-suppressor demo (github.com/sapphi-red/web-noise-suppressor) but
 * skinned in the app's own palette — surface fill, sienna trace — rather
 * than the demo's raw black/green, so it reads as part of the parchment/ink
 * theme instead of a foreign widget. */
function Waveform({ track }: { track: MediaStreamTrack | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !track) return
    const canvasCtx = canvas.getContext('2d')
    if (!canvasCtx) return
    const style = getComputedStyle(canvas)
    const bg = style.getPropertyValue('--surface').trim()
    const line = style.getPropertyValue('--accent').trim()
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = WAVEFORM_FFT_SIZE
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    const { width, height } = canvas
    const gap = width / data.length
    let raf = 0
    const draw = () => {
      analyser.getByteTimeDomainData(data)
      canvasCtx.fillStyle = bg
      canvasCtx.fillRect(0, 0, width, height)
      canvasCtx.beginPath()
      canvasCtx.strokeStyle = line
      canvasCtx.lineWidth = 1.5
      for (const [i, v] of data.entries()) {
        const x = gap * i
        const y = height * (v / 256)
        if (i === 0) canvasCtx.moveTo(x, y)
        else canvasCtx.lineTo(x, y)
      }
      canvasCtx.lineTo(width, height / 2)
      canvasCtx.stroke()
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(raf); void ctx.close() }
  }, [track])
  return <canvas ref={canvasRef} className="waveform" width={480} height={64} />
}

// ---- in call -----------------------------------------------------------------

function InCall({ room, sessionId, token, title, initialSpeakerId, onEnded, onError }: {
  room: Room
  sessionId: string
  token: string
  title: string
  initialSpeakerId: string | null
  onEnded: () => void
  onError: (e: string) => void
}) {
  const [muted, setMuted] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>(room.state)
  const [others, setOthers] = useState<string[]>(() => remoteNames(room))
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [speakerId, setSpeakerId] = useState(initialSpeakerId)
  const [micId, setMicId] = useState('')
  const micTrack = useLocalMicTrack(room)
  const connected = connection === ConnectionState.Connected
  // No settings UI edits this yet, so it's static for the life of the call —
  // read once rather than subscribing to storage changes.
  const [keepScreenOn] = useState(() => getSettings().keepScreenOn)
  const wakeLockStatus = useWakeLock(connected && keepScreenOn)
  // Routing polish only (earpiece/speaker + ducking on iOS) — set once, not
  // worth re-running on every reconnect blip the way the wake lock is.
  useEffect(() => { setPlayAndRecordAudioSession() }, [])
  const audioDiv = useRef<HTMLDivElement>(null)
  const socketRef = useRef<Socket | null>(null)
  // marks made while the socket is down: queued with local epoch time and
  // flushed on reconnect (the server flags them client-stamped)
  const queueRef = useRef<{ kind: 'down' | 'up'; atMs: number; mode?: 'hold' | 'toggle' }[]>([])

  // your own identity, straight from the token payload (display-only — the
  // server never trusts a client-claimed identity)
  const identity = useMemo(() => {
    try { return (JSON.parse(atob(token.split('.')[1]!)) as { sub?: string }).sub ?? null }
    catch { return null }
  }, [token])

  // participants (not you) with an open span right now — the multiplayer
  // half of marking: their press shows here as a quiet halo
  const [remoteMarking, setRemoteMarking] = useState<string[]>([])

  useEffect(() => {
    // verified socket to the harvester backend — marks ride this
    const socket = createCallSocket(token)
    socketRef.current = socket
    socket.on('connect', () => {
      if (queueRef.current.length > 0) {
        socket.emit('marker:flush', queueRef.current)
        queueRef.current = []
      }
    })
    // the backend broadcasts every stamped marker edge; mirror the other
    // side's open/closed state (endS is null while their span is open)
    socket.on('server:event', (e: ServerEvent) => {
      if (e.type !== 'marker' || e.sessionId !== sessionId) return
      const m = e.marker
      if (!m?.participant || m.participant === identity) return
      const who = m.participant
      setRemoteMarking((prev) => m.endS == null
        ? (prev.includes(who) ? prev : [...prev, who])
        : prev.filter((p) => p !== who))
    })
    // seed for a mid-span (re)join: any already-open marks by the others
    api.detail(sessionId)
      .then((d) => setRemoteMarking(d.markers
        .filter((m) => m.participant && m.participant !== identity && m.endS == null)
        .map((m) => m.participant!)))
      .catch(() => {})
    return () => { socket.disconnect() }
  }, [token, sessionId, identity])

  const markChannel = useMemo<MarkChannel>(() => ({
    down: () => {
      const s = socketRef.current
      if (s?.connected) s.emit('marker:down')
      else queueRef.current.push({ kind: 'down', atMs: Date.now() })
    },
    up: (mode) => {
      const s = socketRef.current
      if (s?.connected) s.emit('marker:up', { mode })
      else queueRef.current.push({ kind: 'up', atMs: Date.now(), mode })
    },
  }), [])

  // client-reported connection signals refine gap direction server-side
  useEffect(() => {
    const report = (signal: 'reconnecting' | 'reconnected') => () =>
      socketRef.current?.emit(`call:${signal}`)
    const onReconnecting = report('reconnecting')
    const onReconnected = report('reconnected')
    room.on(RoomEvent.Reconnecting, onReconnecting)
    room.on(RoomEvent.Reconnected, onReconnected)
    return () => {
      room.off(RoomEvent.Reconnecting, onReconnecting)
      room.off(RoomEvent.Reconnected, onReconnected)
    }
  }, [room])

  // the mic select should reflect whichever device is actually active, not
  // reset to a blank placeholder the moment you pick one
  useEffect(() => {
    const known = room.getActiveDevice('audioinput')
    if (known && known !== 'default') setMicId(known)
    const onActiveDevice = (kind: MediaDeviceKind, deviceId: string) => {
      if (kind === 'audioinput' && deviceId !== 'default') setMicId(deviceId)
    }
    room.on(RoomEvent.ActiveDeviceChanged, onActiveDevice)
    return () => { room.off(RoomEvent.ActiveDeviceChanged, onActiveDevice) }
  }, [room])

  // per-participant connection quality (server-computed from uplink/downlink
  // stats) — a "vertraging ondanks zelfde netwerk" report has nothing to
  // point at today; this gives the next one something measurable
  const [qualities, setQualities] = useState<Record<string, ConnectionQuality>>({})
  useEffect(() => {
    const onQuality = (quality: ConnectionQuality, participant: Participant) => {
      if (isEgress(participant)) return
      setQualities((prev) => ({ ...prev, [participant.identity]: quality }))
    }
    room.on(RoomEvent.ConnectionQualityChanged, onQuality)
    return () => { room.off(RoomEvent.ConnectionQualityChanged, onQuality) }
  }, [room])

  // read inside the track-subscription effect below without making it a
  // dependency (that would tear down and re-seed every listener on switch)
  const speakerIdRef = useRef(speakerId)
  useEffect(() => {
    speakerIdRef.current = speakerId
    for (const el of audioDiv.current?.querySelectorAll('audio') ?? []) applySink(el, speakerId)
  }, [speakerId])

  useEffect(() => {
    const refreshOthers = () => setOthers(remoteNames(room))
    const attach = (track: RemoteTrack) => {
      const el = track.attach()
      applySink(el, speakerIdRef.current)
      audioDiv.current?.appendChild(el)
    }
    const onTrack = (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio || isEgress(participant)) return
      attach(track)
    }
    const onTrackOff = (track: RemoteTrack) => { track.detach().forEach((el) => el.remove()) }
    const onState = (state: ConnectionState) => setConnection(state)
    const onDisconnect = () => onEnded()
    room
      .on(RoomEvent.TrackSubscribed, onTrack)
      .on(RoomEvent.TrackUnsubscribed, onTrackOff)
      .on(RoomEvent.ParticipantConnected, refreshOthers)
      .on(RoomEvent.ParticipantDisconnected, refreshOthers)
      .on(RoomEvent.ConnectionStateChanged, onState)
      .on(RoomEvent.Disconnected, onDisconnect)
    // whoever was already in the room published (and got auto-subscribed)
    // before this listener existed — TrackSubscribed never re-fires for an
    // already-subscribed publication, so seed those tracks by hand. This is
    // the "only the last joiner is audible" bug: the earlier side's audio
    // silently never attached for anyone who joined after them.
    const seeded: RemoteTrack[] = []
    for (const participant of room.remoteParticipants.values()) {
      if (isEgress(participant)) continue
      for (const pub of participant.trackPublications.values()) {
        if (pub.kind === Track.Kind.Audio && pub.track) {
          attach(pub.track)
          seeded.push(pub.track)
        }
      }
    }
    navigator.mediaDevices.enumerateDevices()
      .then((all) => {
        setDevices(all.filter((d) => d.kind === 'audioinput'))
        setSpeakers(all.filter((d) => d.kind === 'audiooutput'))
      })
      .catch(() => {})
    return () => {
      // undo the manual seed above — unlike event-driven attaches, nothing
      // else will ever detach these (no TrackUnsubscribed fires for a track
      // that's still subscribed), which double-attached under StrictMode's
      // dev-only mount/cleanup/remount cycle until this was added
      for (const t of seeded) t.detach().forEach((el) => el.remove())
      room
        .off(RoomEvent.TrackSubscribed, onTrack)
        .off(RoomEvent.TrackUnsubscribed, onTrackOff)
        .off(RoomEvent.ParticipantConnected, refreshOthers)
        .off(RoomEvent.ParticipantDisconnected, refreshOthers)
        .off(RoomEvent.ConnectionStateChanged, onState)
        .off(RoomEvent.Disconnected, onDisconnect)
    }
  }, [room, onEnded])

  const toggleMute = useCallback(async () => {
    try {
      await room.localParticipant.setMicrophoneEnabled(muted)
      setMuted(!muted)
    } catch (e) { onError(String(e)) }
  }, [room, muted, onError])

  // two-step end: first tap arms the button for a few seconds, second tap
  // ends. A native confirm() would block the page (and jar the calm).
  const [confirmEnd, setConfirmEnd] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])
  const endCall = useCallback(async () => {
    if (!confirmEnd) {
      setConfirmEnd(true)
      confirmTimer.current = setTimeout(() => setConfirmEnd(false), 4000)
      return
    }
    try {
      await api.call.end(sessionId) // server deletes the room → everyone disconnects
    } catch (e) {
      onError(String(e))
      await room.disconnect() // at least leave locally
    }
  }, [confirmEnd, room, sessionId, onError])

  // identities → display names for the marking line ("Jesse is marking…")
  const markingNames = remoteMarking.map((id) => {
    const p = [...room.remoteParticipants.values()].find((x) => x.identity === id)
    return p?.name || id
  })

  const stateLabel = !connected ? connection
    : markingNames.length > 0 ? `${markingNames.join(' & ')} is marking…`
    : others.length > 0 ? `in call with ${others.join(', ')}`
    : 'waiting for the other person to join…'

  // Only worth mentioning when it actually matters: the setting is on, the
  // device looks like one that auto-locks its screen, and acquisition has
  // definitively failed (not merely still in flight) — see useWakeLock.
  const showWakeLockWarning = keepScreenOn && IS_TOUCH_DEVICE &&
    (wakeLockStatus === 'unsupported' || wakeLockStatus === 'failed')

  return (
    <JoinShell title={title}>
      <main className="incall">
        <div ref={audioDiv} style={{ display: 'none' }} />
        <p className={`call-state ${!connected ? 'warn' : markingNames.length > 0 ? 'marking' : ''}`}>
          {stateLabel}
        </p>
        {connected && (
          <div className="row quality-row">
            <span className={`quality quality-${qualities[identity ?? ''] ?? 'unknown'}`}>you</span>
            {[...room.remoteParticipants.values()].filter((p) => !isEgress(p)).map((p) => (
              <span key={p.identity} className={`quality quality-${qualities[p.identity] ?? 'unknown'}`}>
                {p.name || p.identity}
              </span>
            ))}
          </div>
        )}
        <div className={`mark-area ${remoteMarking.length > 0 ? 'remote' : ''}`}>
          <MarkButton channel={markChannel} />
        </div>
        {/* your own mic waveform — the only way to tell you're audible to
            the other side without asking them */}
        <Waveform track={muted ? null : micTrack} />
        {showWakeLockWarning && (
          <p className="muted hint">keep your screen on — locking it will cut your microphone</p>
        )}
        <div className="row call-controls">
          <button className={muted ? 'danger' : ''} onClick={toggleMute}>
            {muted ? '🔇 Unmute' : '🎙 Mute'}
          </button>
          <select
            value={micId}
            onChange={async (e) => {
              if (!e.target.value) return
              try { await room.switchActiveDevice('audioinput', e.target.value) }
              catch (err) { onError(String(err)) }
            }}
          >
            <option value="" disabled>switch mic…</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d.label)}</option>
            ))}
          </select>
          {SUPPORTS_SINK_ID && speakers.length > 0 && (
            <select
              value={speakerId ?? ''}
              onChange={(e) => setSpeakerId(e.target.value || null)}
            >
              <option value="">system default speaker</option>
              {speakers.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d.label)}</option>
              ))}
            </select>
          )}
          <button className="danger" onClick={endCall}>
            {confirmEnd ? 'end for everyone?' : '✕ End call'}
          </button>
        </div>
      </main>
    </JoinShell>
  )
}

/** The egress recorder joins as a (hidden) participant — never show it. */
function isEgress(p: { identity: string }): boolean {
  return p.identity.startsWith('EG_')
}

function remoteNames(room: Room): string[] {
  return [...room.remoteParticipants.values()]
    .filter((p) => !isEgress(p))
    .map((p) => p.name || p.identity)
}
