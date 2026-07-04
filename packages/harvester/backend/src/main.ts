import { loadConfig } from './config.js'
import { openDb } from './db/index.js'

const usage = `usage: harvester-backend <command>

commands:
  serve         start the backend (default port 4747)
  doctor        verify the environment
  e2e [--no-llm]  synthesize a dialogue and run the full pipeline against a temp vault
`

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2)
  const config = loadConfig()

  switch (command) {
    case 'serve': {
      const { HarvesterService } = await import('./service.js')
      const { startServer } = await import('./server.js')
      const db = openDb(config.dataDir)
      const service = new HarvesterService(config, db)
      service.markInterruptedSessions()
      await startServer(config, service)
      return
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js')
      process.exit(await runDoctor(config))
      break
    }
    case 'e2e': {
      const { runE2e } = await import('./e2e.js')
      process.exit(await runE2e(config, { noLlm: rest.includes('--no-llm') }))
      break
    }
    default:
      console.error(usage)
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
