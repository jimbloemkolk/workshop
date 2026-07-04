import { describe, expect, it } from 'vitest'
import { markerFlag } from '../src/recorder.js'
import { extractJson, slugify } from '../src/util.js'

describe('markerFlag', () => {
  it('flags sub-minimum taps as discarded (still stored, auditable)', () => {
    expect(markerFlag(10.0, 10.1, 300)).toBe('discarded')
  })
  it('keeps holds at or above the minimum', () => {
    expect(markerFlag(10.0, 10.3, 300)).toBe('ok')
    expect(markerFlag(10.0, 14.0, 300)).toBe('ok')
  })
  it('leaves unclosed markers alone', () => {
    expect(markerFlag(10.0, null, 300)).toBe('ok')
  })
})

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('parses fenced JSON with prose around it', () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```\ndone')).toEqual({ a: 1 })
  })
  it('parses an object embedded in prose', () => {
    expect(extractJson('here you go {"a": {"b": 2}} hope that helps')).toEqual({ a: { b: 2 } })
  })
  it('throws when there is no object', () => {
    expect(() => extractJson('READY')).toThrow()
  })
})

describe('slugify', () => {
  it('handles Dutch titles with punctuation', () => {
    expect(slugify('De business case bleef óvereind!')).toBe('de-business-case-bleef-overeind')
  })
  it('never returns an empty name', () => {
    expect(slugify('???')).toBe('untitled')
  })
})
