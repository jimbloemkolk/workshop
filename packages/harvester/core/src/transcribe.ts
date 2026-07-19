import { spawn } from 'node:child_process'
import type { CoreConfig } from './config.js'

/** Shell out to the transcriber package (the boring seam): we pass a file,
 * we get the contract JSON, we never reach into its internals.
 * Diarization is for single-file recordings of two people; per-track call
 * audio passes `diarize: false` — track identity IS the speaker. */
export function runTranscriber(
  config: CoreConfig,
  audioFile: string,
  outFile: string,
  onOutput?: (line: string) => void,
  opts: { diarize?: boolean } = {},
): Promise<void> {
  const { backend, model, language } = config.transcriber
  // --no-sync: never mutate the transcriber's venv from here — concurrent
  // syncs corrupt imports mid-run. Its setup owns the environment.
  const args = [
    'run', '--no-sync', 'transcriber', 'transcribe', audioFile,
    '--out', outFile,
    '--backend', backend,
    '--model', model,
    '--language', language,
    ...(opts.diarize ?? true
      ? ['--diarize', '--min-speakers', '2', '--max-speakers', '2']
      : []),
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('uv', args, {
      cwd: config.transcriberDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (line.trim()) onOutput?.(line.trim())
      }
    })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) return resolve()
      // The transcriber emits machine-readable JSON errors on stderr.
      const jsonLine = stderr.split('\n').find((l) => l.trim().startsWith('{'))
      reject(new Error(jsonLine?.trim() ?? `transcriber exited ${code}: ${stderr.trim()}`))
    })
  })
}
