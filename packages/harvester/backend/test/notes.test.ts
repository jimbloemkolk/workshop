import { describe, expect, it } from 'vitest'
import { mergeWithPreserved, OWNED_MARKER, renderInsightNote } from '../src/export/notes.js'

const rendered = renderInsightNote({
  sessionId: '2026-07-04-a1b2',
  sessionNote: '2026-07-04 Jim × Jesse/session',
  date: '2026-07-04',
  origin: 'marker',
  title: 'Business case bleef overeind',
  main: {
    quote: 'de business case bleef gewoon overeind staan',
    speaker: 'Jesse',
    startS: 2482.1,
    endS: 2489.8,
    anchored: true,
  },
  insight: 'De kern: techniek wankelde, het waarom niet.',
  clipFile: 'clips/business-case.m4a',
  supporting: [{
    quote: 'we hadden er toen al 42 procent van afgerond',
    speaker: 'Jim',
    startS: 700,
    endS: 704,
    anchored: false,
    why: 'eerdere context',
  }],
})

describe('renderInsightNote', () => {
  it('ends with the owned marker so the human region starts empty', () => {
    expect(rendered.trimEnd().endsWith(OWNED_MARKER)).toBe(true)
  })
  it('embeds clip, quote, attribution and frontmatter', () => {
    expect(rendered).toContain('![[clips/business-case.m4a]]')
    expect(rendered).toContain('> — Jesse (41:22.1)')
    expect(rendered).toContain('speaker: Jesse')
    expect(rendered).toContain('origin: marker')
  })
  it('flags unanchored supporting quotes visibly', () => {
    expect(rendered).toContain('unanchored — timestamps unverified')
  })
})

describe('mergeWithPreserved', () => {
  it('creates fresh notes verbatim', () => {
    expect(mergeWithPreserved(null, rendered)).toBe(rendered)
  })

  it('preserves the human region below the marker', () => {
    const existing = rendered + '\nmy precious annotation\n[[my-own-link]]\n'
    const updated = rendered.replace('Business case', 'Business-case')
    const merged = mergeWithPreserved(existing, updated)!
    expect(merged).toContain('Business-case')
    expect(merged).toContain('my precious annotation')
    expect(merged).toContain('[[my-own-link]]')
    expect(merged.indexOf(OWNED_MARKER)).toBeLessThan(merged.indexOf('my precious annotation'))
  })

  it('refuses to touch notes whose marker was removed', () => {
    expect(mergeWithPreserved('a note the human rewrote entirely', rendered)).toBeNull()
  })
})
