/** Spike (throwaway, kept in-tree): what do egress files look like across a
 * publication's lifecycle?
 *
 * DESIGN's two open questions for the recording model:
 *   1. Does a track egress survive an SDK reconnect-with-resume (same track
 *      SID), and what does it produce across a full rejoin (new track SID)?
 *   2. Do egress files land where we expect in the shared volume, readable
 *      by the backend user?
 *
 * A full SDK "resume" needs a real network flap (browser + airplane mode) —
 * not scriptable here. What IS scriptable and spans the same egress-side
 * space: unpublish→republish on one connection, and disconnect→reconnect
 * (full rejoin). Both give the recorder a *new* track SID, which is the case
 * the track-segment model exists for; resume keeps the SID, i.e. the
 * do-nothing case.
 *
 * Usage (media stack up via docker compose, HARVESTER_DATA_DIR exported the
 * same way compose saw it):
 *   pnpm --filter @workshop/harvester-call spike:egress [rejoin|republish]
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource,
} from '@livekit/rtc-node'
import { AccessToken, EgressClient, RoomServiceClient, TrackEgressRequest } from 'livekit-server-sdk'

const URL_HTTP = process.env.LIVEKIT_HTTP_URL ?? 'http://127.0.0.1:7880'
const URL_WS = process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880'
const KEY = process.env.LIVEKIT_API_KEY ?? 'devkey'
const SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret_devsecret_devsecret_dev'
const DATA_DIR = process.env.HARVESTER_DATA_DIR
if (!DATA_DIR) throw new Error('set HARVESTER_DATA_DIR (must match the compose volume mount)')

const scenario = (process.argv[2] ?? 'rejoin') as 'rejoin' | 'republish'
const roomName = `spike-${scenario}-${Math.random().toString(36).slice(2, 6)}`
const outDir = path.join(DATA_DIR, 'spike', roomName)
fs.mkdirSync(outDir, { recursive: true })

const rooms = new RoomServiceClient(URL_HTTP, KEY, SECRET)
const egress = new EgressClient(URL_HTTP, KEY, SECRET)

async function mintToken(identity: string): Promise<string> {
  const at = new AccessToken(KEY, SECRET, { identity, ttl: '1h' })
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true })
  return at.toJwt()
}

/** Publish a 440 Hz tone; returns a stop function and the track SID. */
async function publishTone(room: Room): Promise<{ sid: string; stop: () => void }> {
  const sampleRate = 48000
  const source = new AudioSource(sampleRate, 1)
  const track = LocalAudioTrack.createAudioTrack('tone', source)
  const publication = await room.localParticipant!.publishTrack(
    track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
  let running = true
  let t = 0
  void (async () => {
    const frameSamples = sampleRate / 100 // 10ms frames
    while (running) {
      const data = new Int16Array(frameSamples)
      for (let i = 0; i < frameSamples; i++, t++) {
        data[i] = Math.round(Math.sin((2 * Math.PI * 440 * t) / sampleRate) * 12000)
      }
      await source.captureFrame(new AudioFrame(data, sampleRate, 1, frameSamples))
    }
  })()
  return { sid: publication.sid!, stop: () => { running = false } }
}

async function startTrackEgress(trackSid: string, label: string): Promise<string> {
  const info = await egress.startTrackEgress(roomName, {
    filepath: path.join(outDir, `${label}-{track_id}.ogg`),
  } as unknown as Parameters<EgressClient['startTrackEgress']>[1], trackSid)
  console.log(`egress ${info.egressId} started for ${trackSid} (${label})`)
  return info.egressId
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function listEgresses(): Promise<void> {
  const infos = await egress.listEgress({ roomName })
  for (const i of infos) {
    const files = (i.fileResults ?? []).map((f) => `${f.filename} (${f.size ?? '?'} bytes, ${Number(f.duration) / 1e9}s)`)
    console.log(`  ${i.egressId}: status=${i.status} files=[${files.join(', ')}]`)
  }
}

async function main(): Promise<void> {
  console.log(`scenario=${scenario} room=${roomName} out=${outDir}`)
  await rooms.createRoom({ name: roomName, emptyTimeout: 300 })

  const room = new Room()
  await room.connect(URL_WS, await mintToken('bot'), { autoSubscribe: false, dynacast: false })
  const first = await publishTone(room)
  console.log(`published first track ${first.sid}`)
  await startTrackEgress(first.sid, 'seg1')
  await sleep(8000)

  if (scenario === 'republish') {
    // same connection, new publication — the "resume failed, client
    // recovered by republishing" shape
    first.stop()
    await room.localParticipant!.unpublishTrack(first.sid)
    console.log('unpublished; waiting 3s (uplink gap)…')
    await sleep(3000)
    const second = await publishTone(room)
    console.log(`republished as ${second.sid}`)
    await startTrackEgress(second.sid, 'seg2')
    await sleep(8000)
    second.stop()
  } else {
    // full rejoin: disconnect entirely, come back as the same identity
    first.stop()
    await room.disconnect()
    console.log('disconnected; waiting 3s (participant gone)…')
    await sleep(3000)
    const room2 = new Room()
    await room2.connect(URL_WS, await mintToken('bot'), { autoSubscribe: false, dynacast: false })
    const second = await publishTone(room2)
    console.log(`rejoined, published ${second.sid}`)
    await startTrackEgress(second.sid, 'seg2')
    await sleep(8000)
    second.stop()
    await room2.disconnect()
  }

  console.log('stopping egresses…')
  const active = await egress.listEgress({ roomName, active: true })
  for (const i of active) await egress.stopEgress(i.egressId).catch((e) => console.log(String(e)))
  await sleep(3000)
  console.log('final egress state:')
  await listEgresses()

  console.log('files on disk (backend view):')
  for (const f of fs.readdirSync(outDir)) {
    const st = fs.statSync(path.join(outDir, f))
    console.log(`  ${f}: ${st.size} bytes, mode=${(st.mode & 0o777).toString(8)}, uid=${st.uid}`)
  }
  await rooms.deleteRoom(roomName).catch(() => {})
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
