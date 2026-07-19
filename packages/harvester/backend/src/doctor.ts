import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { callDoctorChecks, loadCallConfig } from '@workshop/harvester-call'
import type { Config } from './config.js'

const execFileP = promisify(execFile)

class Doc {
  failed = false
  check(label: string, passed: boolean, hint = ''): boolean {
    console.log(`[${passed ? 'ok ' : 'FAIL'}] ${label}${!passed && hint ? ` — ${hint}` : ''}`)
    this.failed ||= !passed
    return passed
  }
  warn(label: string, hint: string): void {
    console.log(`[warn] ${label} — ${hint}`)
  }
}

export async function runDoctor(config: Config): Promise<number> {
  const doc = new Doc()

  const ffmpeg = await execFileP('ffmpeg', ['-version']).then(() => true, () => false)
  doc.check('ffmpeg on PATH', ffmpeg, 'brew install ffmpeg')

  const transcriber = await execFileP('uv', ['run', '--no-sync', 'transcriber', '--help'], {
    cwd: config.transcriberDir,
  }).then(() => true, (e) => (String(e), false))
  doc.check(`transcriber callable (${config.transcriberDir})`, transcriber,
    'run pnpm --filter @workshop/transcriber setup')

  const claude = await execFileP('claude', ['--version']).then(() => true, () => false)
  if (claude) {
    doc.check('claude CLI on PATH (Agent SDK auth rides its login)', true)
  } else {
    doc.warn('claude CLI not found on PATH',
      'harvesting uses your Claude subscription via the Agent SDK; log in with Claude Code first')
  }

  doc.check(`data dir writable (${config.dataDir})`, isWritable(config.dataDir))
  if (config.vaultDir) {
    doc.check(`vault dir writable (${config.vaultDir})`, isWritable(config.vaultDir))
  } else {
    doc.warn('HARVESTER_VAULT_DIR not set', 'needed for export; point it at a folder inside your vault')
  }

  const callConfig = loadCallConfig()
  if (callConfig) {
    for (const c of await callDoctorChecks(callConfig, config)) {
      if (c.ok && c.hint) doc.warn(c.label, c.hint)
      else doc.check(c.label, c.ok, c.hint ?? '')
    }
  } else {
    doc.warn('recording disabled',
      'set LIVEKIT_URL (+key/secret) to enable the call stack — reviewing/harvesting/exporting ' +
      'existing sessions still works, but no new recording (solo or two-party) can start without it')
  }

  return doc.failed ? 1 : 0
}

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.harvester-write-probe')
    fs.writeFileSync(probe, '')
    fs.rmSync(probe)
    return true
  } catch {
    return false
  }
}
