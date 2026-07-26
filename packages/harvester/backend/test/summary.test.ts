import type { Transcript } from '@workshop/harvester-core'
import { describe, expect, it } from 'vitest'
import { createFixtureClient } from '../src/harvest/fixture.js'
import { runHarvest, type HarvestProgress } from '../src/harvest/harvester.js'
import { summaryTurn } from '../src/harvest/prompts.js'

const transcript: Transcript = {
  meta: { duration_s: 30, language: 'nl', warnings: [] },
  segments: [
    { id: 0, text: 'Het lab heeft een eigen deploy nodig.', start: 0.5, end: 4.0, speaker: 'jim' },
    { id: 1, text: 'Anders blijft het handwerk.', start: 10.0, end: 13.0, speaker: 'jesse' },
    { id: 2, text: 'Precies, en dat schaalt niet.', start: 24.0, end: 28.0, speaker: 'jim' },
  ],
  words: [
    'Het', 'lab', 'heeft', 'een', 'deploy', 'nodig.',
    'Anders', 'blijft', 'het', 'handwerk.',
    'Precies,', 'en', 'dat', 'schaalt', 'niet.',
  ].map((text, index) => ({
    index,
    text,
    start: index * 2,
    end: index * 2 + 1.5,
    aligned: true,
    speaker: index < 6 ? 'jim' : index < 10 ? 'jesse' : 'jim',
    segment_id: index < 6 ? 0 : index < 10 ? 1 : 2,
    score: 1,
  })),
}

const names = new Map([['jim', 'Jim'], ['jesse', 'Jesse']])

/** The fixture agent stands in for the LLM, so this exercises the real
 * control flow — prompt built, turn taken, reply parsed, outcome shaped —
 * without spending anything. */
function harvest(spans: { id: number; startS: number; endS: number; multiMarked: boolean }[]) {
  const steps: HarvestProgress[] = []
  return runHarvest(
    createFixtureClient(transcript), transcript, names, spans, [],
    (p) => steps.push(p),
  ).then((outcome) => ({ outcome, steps }))
}

describe('session summary turn', () => {
  it('writes a summary once a harvest has proposals', async () => {
    const { outcome } = await harvest([{ id: 1, startS: 0, endS: 6, multiMarked: false }])
    expect(outcome.proposals.length).toBeGreaterThan(0)
    expect(outcome.summary).toBeTruthy()
  })

  it('skips the turn entirely when nothing was harvested', async () => {
    // No spans and a transcript the sweep finds nothing quotable in (the
    // fixture sweep needs segment words it hasn't already claimed).
    const empty: Transcript = { ...transcript, segments: [], words: [] }
    const outcome = await runHarvest(
      createFixtureClient(empty), empty, names, [], [], () => {},
    )
    expect(outcome.proposals).toHaveLength(0)
    // Null, not an empty string: there are no snippets to base one on, and
    // the service reads null as "clear the overview line".
    expect(outcome.summary).toBeNull()
  })

  it('reports the summary step, and the progress total accounts for it', async () => {
    const { steps } = await harvest([
      { id: 1, startS: 0, endS: 6, multiMarked: false },
      { id: 2, startS: 20, endS: 30, multiMarked: true },
    ])
    const last = steps.at(-1)!
    expect(last).toEqual({ step: 'done', done: 5, total: 5 }) // intro + 2 spans + sweep + summary
    expect(steps.map((s) => s.step)).toContain('writing the session summary')
    // Every step lands inside its own total — an off-by-one here shows up in
    // the UI as a progress bar that finishes early or never arrives.
    for (const s of steps) expect(s.done).toBeLessThanOrEqual(s.total)
  })
})

describe('summaryTurn prompt', () => {
  it('carries the harvested insights, and only those', () => {
    const prompt = summaryTurn([
      { title: 'Eigen deploy voor het lab', note: 'Handwerk schaalt niet.', quote: 'Het lab heeft een eigen deploy nodig.' },
    ])
    expect(prompt).toContain('Eigen deploy voor het lab')
    expect(prompt).toContain('Het lab heeft een eigen deploy nodig.')
    expect(prompt).toMatch(/Base it ONLY on the insights/)
  })

  it('clips long quotes and notes so a fat harvest stays a cheap turn', () => {
    const prompt = summaryTurn([
      { title: 'Lang', note: 'n'.repeat(500), quote: 'q'.repeat(500) },
    ])
    expect(prompt).not.toContain('q'.repeat(300))
    expect(prompt).toContain('…')
  })
})
