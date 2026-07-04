import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Config } from './config.js'
import { ffprobeDuration } from './util.js'

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

  if (ffmpeg) {
    const devices = await listAudioDevices()
    doc.check(
      `avfoundation audio devices: ${devices.map((d) => `[${d.index}] ${d.name}`).join(', ') || 'none'}`,
      devices.length > 0,
      'no audio input devices found',
    )
    const micIndex = config.micDevice
    if (devices.length > 0 && !devices.some((d) => d.index === micIndex)) {
      doc.warn(`HARVESTER_MIC=${micIndex} not in device list`, 'check the indices above')
    }
  }

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

  if (ffmpeg) {
    const probe = await micProbe(config.micDevice)
    doc.check('mic probe (2s recording produces audio)', probe.ok, probe.hint)
  }

  return doc.failed ? 1 : 0
}

export async function listAudioDevices(): Promise<{ index: string; name: string }[]> {
  // ffmpeg exits non-zero for -list_devices; the list is on stderr either way.
  const stderr: string = await execFileP('ffmpeg', [
    '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '',
  ]).then((r) => r.stderr, (e: { stderr?: string }) => e.stderr ?? '')
  const devices: { index: string; name: string }[] = []
  let inAudio = false
  for (const line of stderr.split('\n')) {
    if (line.includes('audio devices:')) { inAudio = true; continue }
    if (line.includes('video devices:')) { inAudio = false; continue }
    const m = /\[(\d+)\]\s+(.+)$/.exec(line)
    if (inAudio && m) devices.push({ index: m[1]!, name: m[2]!.trim() })
  }
  return devices
}

async function micProbe(device: string): Promise<{ ok: boolean; hint: string }> {
  const out = path.join(os.tmpdir(), `harvester-probe-${process.pid}.flac`)
  try {
    await execFileP('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'avfoundation', '-i', `:${device}`,
      '-t', '2', '-ac', '1', '-ar', '48000', '-c:a', 'flac', out,
    ], { timeout: 15_000 })
    const duration = await ffprobeDuration(out)
    return duration > 1
      ? { ok: true, hint: '' }
      : { ok: false, hint: `probe file only ${duration.toFixed(2)}s` }
  } catch (err) {
    return {
      ok: false,
      hint: `could not record from device :${device} — mic permission for your terminal? (${trim(err)})`,
    }
  } finally {
    fs.rmSync(out, { force: true })
  }
}

function trim(err: unknown): string {
  return String((err as { stderr?: string }).stderr ?? err).trim().split('\n').at(-1) ?? ''
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
