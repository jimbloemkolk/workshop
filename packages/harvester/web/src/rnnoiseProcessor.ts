import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'

/** RNNoise (xiph/rnnoise, via sapphi-red/web-noise-suppressor's WASM +
 * AudioWorklet build) as a LiveKit TrackProcessor. Self-hosted-friendly
 * alternative to LiveKit's own Krisp integration, which turned out to
 * require a LiveKit Cloud account — its setEnabled() 404s against a
 * self-hosted livekit-server, confirmed against the docker-compose stack.
 *
 * Runs its own AudioContext pinned to 48kHz rather than the ambient one
 * LiveKit hands to init() (which just follows the OS/browser default and
 * isn't guaranteed to be 48kHz) — RnnoiseWorkletNode assumes 48kHz. */
export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'rnnoise'
  processedTrack?: MediaStreamTrack
  private ctx?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private node?: RnnoiseWorkletNode
  private destination?: MediaStreamAudioDestinationNode

  init = async (opts: AudioProcessorOptions): Promise<void> => {
    const ctx = new AudioContext({ sampleRate: 48000 })
    const wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath })
    await ctx.audioWorklet.addModule(rnnoiseWorkletPath)
    const source = ctx.createMediaStreamSource(new MediaStream([opts.track]))
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 })
    const destination = ctx.createMediaStreamDestination()
    source.connect(node).connect(destination)
    this.ctx = ctx
    this.source = source
    this.node = node
    this.destination = destination
    this.processedTrack = destination.stream.getAudioTracks()[0]
  }

  restart = async (opts: AudioProcessorOptions): Promise<void> => {
    await this.destroy()
    await this.init(opts)
  }

  destroy = async (): Promise<void> => {
    this.node?.destroy()
    this.source?.disconnect()
    this.node?.disconnect()
    this.destination?.disconnect()
    await this.ctx?.close()
    this.ctx = this.source = this.node = this.destination = undefined
    this.processedTrack = undefined
  }
}
