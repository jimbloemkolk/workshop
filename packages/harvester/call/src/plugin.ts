import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CallService } from './service.js'

/** Fastify plugin the backend mounts when call config exists. Thin adapter:
 * all logic lives in CallService. */
export function callPlugin(call: CallService) {
  return async function register(app: FastifyInstance): Promise<void> {
    // the receiver validates the JWT over the exact body bytes — keep it raw
    app.addContentTypeParser('application/webhook+json', { parseAs: 'string' },
      (_req, body, done) => done(null, body))

    app.post('/api/call/webhook', async (req, reply) => {
      try {
        await call.handleWebhook(req.body as string, req.headers.authorization)
      } catch (err) {
        // invalid signature or malformed body: reject, do not retry-loop us
        return reply.status(400).send({ error: String(err) })
      }
      return { ok: true }
    })

    app.get('/api/call', async () => ({ enabled: true }))

    app.post('/api/call/sessions', async (req) => call.startCall(requestOrigin(req)))

    app.post('/api/call/sessions/table', async (req) => call.startRecording(requestOrigin(req)))

    app.post('/api/call/sessions/:id/end', async (req) => {
      const { id } = req.params as { id: string }
      await call.endCall(id)
      return { ok: true }
    })

    // retry seam: re-run per-track transcription + merge after a failure
    app.post('/api/call/sessions/:id/ingest', async (req) => {
      const { id } = req.params as { id: string }
      void call.ingest(id)
      return { started: true }
    })

    app.get('/api/call/sessions/:id/links', async (req) => {
      const { id } = req.params as { id: string }
      return { links: await call.links(id, requestOrigin(req)) }
    })

    app.get('/api/call/sessions/:id/join', async (req) => {
      const { id } = req.params as { id: string }
      return call.joinInfo(id)
    })
  }
}

/** Fallback join-link base when HARVESTER_PUBLIC_URL is unset: whatever the
 * creator's browser used to reach us (works for localhost and tailnet IPs). */
function requestOrigin(req: FastifyRequest): string {
  const origin = req.headers.origin ?? req.headers.referer
  if (origin) return new URL(origin).origin
  return `${req.protocol}://${req.headers.host ?? 'localhost'}`
}
