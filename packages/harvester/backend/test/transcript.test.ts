import { describe, expect, it } from 'vitest'
import { renderIndexedTranscript, type Transcript } from '@workshop/harvester-core'

const transcript: Transcript = {
  meta: { duration_s: 30, language: 'nl', warnings: [] },
  segments: [
    { id: 0, text: 'Eerste zin hier.', start: 0.5, end: 4.0, speaker: 'jim' },
    { id: 1, text: 'Antwoord daarop.', start: 10.0, end: 13.0, speaker: 'jesse' },
    { id: 2, text: 'Laatste gedachte.', start: 24.0, end: 28.0, speaker: 'jim' },
  ],
  words: [
    { index: 0, text: 'Eerste', start: 0.5, end: 1.0, aligned: true, speaker: 'jim', segment_id: 0, score: 1 },
    { index: 1, text: 'zin', start: 1.1, end: 1.4, aligned: true, speaker: 'jim', segment_id: 0, score: 1 },
    { index: 2, text: 'hier.', start: 1.5, end: 2.0, aligned: true, speaker: 'jim', segment_id: 0, score: 1 },
    { index: 3, text: 'Antwoord', start: 10.0, end: 10.8, aligned: true, speaker: 'jesse', segment_id: 1, score: 1 },
    { index: 4, text: 'daarop.', start: 10.9, end: 11.6, aligned: true, speaker: 'jesse', segment_id: 1, score: 1 },
    { index: 5, text: 'Laatste', start: 24.0, end: 24.8, aligned: true, speaker: 'jim', segment_id: 2, score: 1 },
    { index: 6, text: 'gedachte.', start: 24.9, end: 25.8, aligned: true, speaker: 'jim', segment_id: 2, score: 1 },
  ],
}

const names = new Map([['jim', 'Jim'], ['jesse', 'Jesse']])

describe('renderIndexedTranscript gap lines', () => {
  it('is byte-identical to the gap-less rendering with zero gaps', () => {
    expect(renderIndexedTranscript(transcript, names, []))
      .toBe(renderIndexedTranscript(transcript, names))
  })

  it('inserts a gap line where the span falls', () => {
    const out = renderIndexedTranscript(transcript, names, [
      { participant: 'jesse', startS: 5.0, endS: 9.0 },
    ])
    expect(out.split('\n')).toEqual([
      '[word 0] 00:00.5 Jim: Eerste zin hier.',
      '--- connection gap (Jesse, 4s) ---',
      '[word 3] 00:10.0 Jesse: Antwoord daarop.',
      '[word 5] 00:24.0 Jim: Laatste gedachte.',
    ])
  })

  it('orders multiple gaps and renders trailing gaps at the end', () => {
    const out = renderIndexedTranscript(transcript, names, [
      { participant: 'jim', startS: 29.0, endS: 35.0 },
      { participant: 'jesse', startS: 15.0, endS: 21.0 },
    ])
    const lines = out.split('\n')
    expect(lines[2]).toBe('--- connection gap (Jesse, 6s) ---')
    expect(lines[4]).toBe('--- connection gap (Jim, 6s) ---')
  })

  it('falls back to the raw participant when no name maps', () => {
    const out = renderIndexedTranscript(transcript, new Map(), [
      { participant: 'jesse', startS: 5.0, endS: 9.0 },
    ])
    expect(out).toContain('--- connection gap (jesse, 4s) ---')
  })
})
