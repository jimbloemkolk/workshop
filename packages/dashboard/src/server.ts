/** Fastify entrypoint: serves the no-build-step static UI from public/ and
 * a handful of read-only JSON endpoints backed by the in-memory collector
 * cache. Every route here is a thin read of already-polled state — nothing
 * blocks on a live network call, so the UI is always snappy even when a
 * downstream source is slow or down. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { Collectors } from './collectors/index.js'
import { loadConfig } from './config.js'

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..')

async function main(): Promise<void> {
  const config = loadConfig()
  const collectors = new Collectors(config)
  await collectors.init()
  collectors.start()

  const app = Fastify({ logger: false })

  await app.register(fastifyStatic, {
    root: path.join(packageRoot, 'public'),
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/api/overview', async () => collectors.getOverview())

  app.get('/api/history/health', async (req, reply) => {
    const query = req.query as { name?: string; hours?: string }
    if (!query.name) return reply.status(400).send({ error: 'name is required' })
    const hours = Number(query.hours ?? 24)
    return collectors.healthHistory(query.name, Number.isFinite(hours) && hours > 0 ? hours : 24)
  })

  app.get('/api/history/deploys', async () => collectors.deployHistory())

  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`dashboard on http://0.0.0.0:${config.port}`)

  const shutdown = async () => {
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
