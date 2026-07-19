import fs from 'node:fs'
import path from 'node:path'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { Server as SocketServer } from 'socket.io'
import { callPlugin, registerCallSocket, type CallService } from '@workshop/harvester-call'
import { packageRoot, type Config } from './config.js'
import type { HarvesterService } from './service.js'

// The @fastify/static and @fastify/multipart augmentations don't merge under
// this repo's hoist=false layout; declare the members we use ourselves.
declare module 'fastify' {
  interface FastifyReply {
    sendFile(filename: string, rootPath?: string): FastifyReply
  }
  interface FastifyRequest {
    file(): Promise<{ filename: string; file: NodeJS.ReadableStream } | undefined>
  }
}

/** Thin adapter: socket.io for everything bidirectional (markers up, state
 * down); plain HTTP where it's naturally request/response (CRUD, Range-served
 * audio, export). All logic lives in HarvesterService / CallService. */
export async function startServer(
  config: Config,
  service: HarvesterService,
  call: CallService | null = null,
): Promise<void> {
  const app = Fastify({ logger: false })
  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyMultipart, {
    limits: { fileSize: 4 * 1024 ** 3 }, // a 2h WAV is ~700MB; leave headroom
  })
  await app.register(fastifyStatic, {
    root: path.join(config.dataDir, 'sessions'),
    serve: false, // only via reply.sendFile below — Range support included
  })

  // Serve the built web app (if present) so /join links open on phones in
  // production; the vite dev-server flow is unaffected.
  const webDist = path.resolve(packageRoot, '../web/dist')
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, decorateReply: false })
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? ''
      if (url.startsWith('/api/') || url.startsWith('/socket.io')) {
        return reply.status(404).send({ error: 'not found' })
      }
      return reply.type('text/html').sendFile('index.html', webDist) // SPA fallback
    })
  }

  if (call) await app.register(callPlugin(call))

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({ error: err.message })
  })

  app.get('/api/sessions', async () => service.listSessions())

  app.post('/api/sessions/import', async (req, reply) => {
    const file = await req.file()
    if (!file) {
      return reply.status(400).send({ error: 'multipart file field required' })
    }
    const id = await service.importSession(file.filename, file.file)
    return service.sessionDetail(id)
  })

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string }
    return service.sessionDetail(id)
  })

  app.post('/api/sessions/:id/retranscribe', async (req) => {
    const { id } = req.params as { id: string }
    void service.transcribeSession(id)
    return { ok: true }
  })

  app.get('/api/sessions/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply
      .type('audio/flac')
      .sendFile(path.join(id, 'recording.flac'))
  })

  app.get('/api/sessions/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply.type('application/json').sendFile(path.join(id, 'transcript.json'))
  })

  app.post('/api/sessions/:id/speakers', async (req) => {
    const { id } = req.params as { id: string }
    const body = req.body as { label: string; participantId: number }
    service.assignSpeaker(id, body.label, body.participantId)
    return service.sessionDetail(id)
  })

  app.post('/api/sessions/:id/harvest', async (req) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { fixture?: boolean }
    // long-running: kicked off async, progress arrives over socket.io
    void service.harvestSession(id, { fixture: body.fixture }).catch(() => {})
    return { started: true }
  })

  app.post('/api/sessions/:id/insights', async (req) => {
    const { id } = req.params as { id: string }
    const body = req.body as { startWord: number; endWord: number }
    await service.manualInsight(id, body.startWord, body.endWord)
    return service.sessionDetail(id)
  })

  app.patch('/api/insights/:insightId', async (req) => {
    const { insightId } = req.params as { insightId: string }
    service.updateInsight(Number(insightId), req.body as Parameters<HarvesterService['updateInsight']>[1])
    return { ok: true }
  })

  app.post('/api/sessions/:id/export', async (req) => {
    const { id } = req.params as { id: string }
    return service.export(id)
  })

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string }
    service.deleteSession(id)
    return { ok: true }
  })

  // With calling enabled the backend must be reachable by the LiveKit
  // containers (webhooks) and by phones on the tailnet; local-only otherwise.
  await app.listen({ port: config.port, host: call ? '0.0.0.0' : '127.0.0.1' })

  const io = new SocketServer(app.server, {
    cors: { origin: true },
  })
  if (call) registerCallSocket(io, call)
  service.events.on('event', (event) => io.emit('server:event', event))

  console.log(`harvester backend on http://127.0.0.1:${config.port}${call ? ' (calling enabled)' : ''}`)

  const shutdown = async () => {
    io.close()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
