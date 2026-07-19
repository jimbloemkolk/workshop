/** Spike (throwaway, kept in-tree): measure LiveKit webhook timing fidelity.
 *
 * Runs a bare receiver on the port the dev livekit.yaml points its webhooks
 * at, validates each delivery with the SDK's WebhookReceiver, and logs
 * `arrivalMs - event.createdAt` per event — the number phase 4's gap-edge
 * derivation rides on. Leave it running while poking a room (join/leave a
 * browser tab, kill a tab, run egress-behavior.ts) and read the deltas.
 *
 *   pnpm --filter @workshop/harvester-call spike:webhook
 */
import Fastify from 'fastify'
import { WebhookReceiver } from 'livekit-server-sdk'

const PORT = Number(process.env.SPIKE_WEBHOOK_PORT ?? 4747)
const receiver = new WebhookReceiver(
  process.env.LIVEKIT_API_KEY ?? 'devkey',
  process.env.LIVEKIT_API_SECRET ?? 'devsecret_devsecret_devsecret_dev',
)

const app = Fastify({ logger: false })
// raw body needed: WebhookReceiver validates the JWT over the exact bytes
app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body)
})

app.post('/api/call/webhook', async (req, reply) => {
  const arrivalMs = Date.now()
  try {
    const event = await receiver.receive(req.body as string, req.headers.authorization)
    // event.createdAt is seconds since epoch (proto int64)
    const createdMs = Number(event.createdAt) * 1000
    const deltaMs = arrivalMs - createdMs
    console.log(JSON.stringify({
      event: event.event,
      room: event.room?.name,
      participant: event.participant?.identity,
      trackSid: event.track?.sid,
      egressId: event.egressInfo?.egressId,
      egressStatus: event.egressInfo?.status,
      createdMs,
      arrivalMs,
      deltaMs,
    }))
  } catch (err) {
    console.error(`invalid webhook: ${String(err)}`)
  }
  return reply.send({ ok: true })
})

await app.listen({ port: PORT, host: '0.0.0.0' })
console.error(`webhook spike listening on :${PORT} (deltas in ms, one JSON line per event)`)
