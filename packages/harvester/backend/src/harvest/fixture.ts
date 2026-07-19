import type { Transcript } from '@workshop/harvester-core'
import { verbatim } from '../anchor.js'
import type { AgentClient } from './agent.js'

/** Deterministic stand-in for the LLM (doctor --e2e --no-llm): answers the
 * harvester's prompts with valid JSON derived from the transcript itself, so
 * the whole pipeline — anchoring included — runs without spending budget. */
export function createFixtureClient(transcript: Transcript): AgentClient {
  let counter = 0
  const claimed: [number, number][] = []

  const quoteFor = (start: number, end: number) => ({
    startWord: start,
    endWord: end,
    text: verbatim(transcript.words, { start, end }),
  })

  return {
    async turn(prompt: string) {
      const sessionId = 'fixture-session'
      counter += 1

      if (prompt.includes('Reply with exactly: READY')) {
        return { text: 'READY', sessionId }
      }

      const markerHint = /roughly \[(\d+), (\d+)\)/.exec(prompt)
      if (prompt.startsWith('Marker ') && markerHint) {
        const start = Number(markerHint[1])
        const end = Math.max(Number(markerHint[2]), start + 1)
        claimed.push([start, end])
        const reply = {
          skip: false,
          title: `Fixture insight ${counter}`,
          quote: quoteFor(start, end),
          insight: 'Fixture: dit gemarkeerde moment is als inzicht opgeslagen.',
          supporting: [],
        }
        return { text: JSON.stringify(reply), sessionId }
      }
      if (prompt.startsWith('Marker ')) {
        return { text: JSON.stringify({ skip: true, reason: 'fixture: no aligned words in span' }), sessionId }
      }

      if (prompt.startsWith('Now the sweep')) {
        const seg = [...transcript.segments]
          .sort((a, b) => b.text.length - a.text.length)
          .find((s) => {
            const words = transcript.words.filter((w) => w.segment_id === s.id)
            const first = words[0]?.index ?? -1
            return first >= 0 && !claimed.some(([a, b]) => first >= a && first < b)
          })
        const words = seg ? transcript.words.filter((w) => w.segment_id === seg.id) : []
        const candidates = words.length > 0
          ? [{
              title: 'Fixture sweep candidate',
              quote: quoteFor(words[0]!.index, words[words.length - 1]!.index + 1),
              insight: 'Fixture: gevonden in de sweep over het hele transcript.',
              why: 'longest unmarked segment',
            }]
          : []
        return { text: JSON.stringify({ candidates }), sessionId }
      }

      const manual = /selected words \[(\d+), (\d+)\)/.exec(prompt)
      if (manual) {
        const reply = {
          title: 'Fixture manual insight',
          insight: 'Fixture: handmatig geselecteerd tijdens review.',
          supporting: [],
        }
        return { text: JSON.stringify(reply), sessionId }
      }

      return { text: JSON.stringify({ skip: true, reason: 'fixture: unrecognized prompt' }), sessionId }
    },
  }
}
