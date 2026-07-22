import { openDb } from '@workshop/harvester-core'
import { loadConfig } from './config.js'

const usage = `usage: harvester-backend <command>

commands:
  serve         start the backend (default port 4747)
  doctor        verify the environment (incl. the call stack when configured)
  e2e [--no-llm]  synthesize a dialogue and run the full pipeline against a temp vault
  e2e --call [--no-llm]  the call variant: real room, two speaking bots, marks,
                a mid-call drop — asserts files, transcript, spans and gap
  e2e --table [--no-llm]  the solo/table variant: real room, one bot speaking
                both voices on one track — asserts diarization + labeling
`

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2)
  const config = loadConfig()

  switch (command) {
    case 'serve': {
      const { HarvesterService } = await import('./service.js')
      const { startServer } = await import('./server.js')
      const { CallService, loadCallConfig } = await import('@workshop/harvester-call')
      const db = openDb(config.dataDir)
      const service = new HarvesterService(config, db)
      service.backfillSpokenAt() // migration 0003's disk-reading half — see method

      // no LIVEKIT_URL → no call plugin → the harvester can still review,
      // label, harvest and export existing sessions, but cannot start a new
      // recording (solo or two-party) — both now go through LiveKit.
      const callConfig = loadCallConfig()
      const call = callConfig
        ? new CallService(callConfig, config, db, {
            emit: (e) => service.events.emit('event', e),
            enterPipeline: (id) => service.harvestSession(id),
            transcribeSession: (id) => service.transcribeSession(id),
            discardSession: (id) => service.deleteSession(id),
          })
        : null
      await startServer(config, service, call)
      // boot re-sync for status `calling` is the call package's job: rooms
      // and egresses survived in the LiveKit containers if we crashed
      if (call) void call.resyncActiveCalls()
      return
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js')
      process.exit(await runDoctor(config))
      break
    }
    case 'e2e': {
      if (rest.includes('--call')) {
        const { runCallE2e } = await import('./e2e-call.js')
        process.exit(await runCallE2e(config, { noLlm: rest.includes('--no-llm') }))
      }
      if (rest.includes('--table')) {
        const { runTableE2e } = await import('./e2e-call.js')
        process.exit(await runTableE2e(config, { noLlm: rest.includes('--no-llm') }))
      }
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
