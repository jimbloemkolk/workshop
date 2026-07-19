import { describe, expect, it } from 'vitest'
import type { Transcript, Word } from '@workshop/harvester-core'
import { mergeTrackTranscripts } from '../src/merge.js'

function track(words: [text: string, start: number | null, end: number | null][]): Transcript {
  const w: Word[] = words.map(([text, start, end], i) => ({
    index: i, text, start, end,
    aligned: start != null, speaker: null, segment_id: 0, score: 1,
  }))
  return {
    meta: { duration_s: w.at(-1)?.end ?? 0, language: 'nl', warnings: [] },
    segments: [{ id: 0, text: words.map(([t]) => t).join(' '), start: w[0]?.start ?? null, end: w.at(-1)?.end ?? null, speaker: null }],
    words: w,
  }
}

describe('mergeTrackTranscripts', () => {
  it('interleaves overlapping speech by absolute time with identity as speaker', () => {
    const merged = mergeTrackTranscripts([
      { participant: 'jim', offsetS: 0, transcript: track([['Wacht', 4.0, 4.5], ['even.', 4.6, 5.0]]) },
      { participant: 'jesse', offsetS: 0, transcript: track([['Dit', 0.0, 0.4], ['is', 0.5, 0.8], ['belangrijk.', 0.9, 1.6]]) },
    ], 6)
    expect(merged.words.map((w) => w.text)).toEqual(['Dit', 'is', 'belangrijk.', 'Wacht', 'even.'])
    expect(merged.words.map((w) => w.speaker)).toEqual(['jesse', 'jesse', 'jesse', 'jim', 'jim'])
    // reindexed gap-free
    expect(merged.words.map((w) => w.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('offsets words by their segment timeline position (multi-segment participant)', () => {
    const merged = mergeTrackTranscripts([
      { participant: 'jim', offsetS: 0, transcript: track([['eerste', 0.0, 1.0]]) },
      { participant: 'jim', offsetS: 20, transcript: track([['tweede', 0.5, 1.5]]) },
      { participant: 'jesse', offsetS: 0, transcript: track([['tussenin', 8.0, 9.0]]) },
    ], 22)
    expect(merged.words.map((w) => [w.text, w.start])).toEqual([
      ['eerste', 0.0], ['tussenin', 8.0], ['tweede', 20.5],
    ])
  })

  it('splits segments on speaker change and long same-speaker pauses', () => {
    const merged = mergeTrackTranscripts([
      { participant: 'jim', offsetS: 0, transcript: track([['een', 0, 0.5], ['twee', 0.6, 1.0], ['ver', 10, 10.5], ['weg', 10.6, 11]]) },
      { participant: 'jesse', offsetS: 0, transcript: track([['tussen', 5, 5.8]]) },
    ], 12)
    expect(merged.segments.map((s) => [s.speaker, s.text])).toEqual([
      ['jim', 'een twee'],
      ['jesse', 'tussen'],
      ['jim', 'ver weg'],
    ])
    // words point at their rebuilt segment
    expect(merged.words.map((w) => w.segment_id)).toEqual([0, 0, 1, 2, 2])
    // segment times rebuilt from member words
    expect(merged.segments[2]).toMatchObject({ start: 10, end: 11 })
  })

  it('keeps unaligned words adjacent to their neighbors', () => {
    const merged = mergeTrackTranscripts([
      { participant: 'jim', offsetS: 0, transcript: track([['erg', 2.0, 2.4], ['42', null, null], ['procent', 2.9, 3.4]]) },
      { participant: 'jesse', offsetS: 0, transcript: track([['nee', 2.5, 2.7]]) },
    ], 4)
    const jim = merged.words.filter((w) => w.speaker === 'jim').map((w) => w.text)
    expect(jim).toEqual(['erg', '42', 'procent'])
    // the unaligned word rides its predecessor's time: erg, 42, nee, procent
    expect(merged.words.map((w) => w.text)).toEqual(['erg', '42', 'nee', 'procent'])
    expect(merged.words[1]).toMatchObject({ aligned: false, start: null })
  })

  it('prefixes per-track warnings and carries duration/language', () => {
    const a = track([['a', 0, 1]])
    a.meta.warnings = ['low confidence']
    const merged = mergeTrackTranscripts([{ participant: 'jim', offsetS: 0, transcript: a }], 30)
    expect(merged.meta).toEqual({ duration_s: 30, language: 'nl', warnings: ['[jim] low confidence'] })
  })
})
