import { formatTime } from '@workshop/harvester-core'

export const SYSTEM_PROMPT = `You are the harvesting step of a personal "Insight Harvester".
Two people recorded a long, mostly-Dutch conversation (English mixed in) and
pressed a key while something insightful was being said. You receive the full
transcript with word indices, then one task per message.

Rules you must never break:
- Quotes are VERBATIM spans of the transcript, identified by word indices.
  Never paraphrase inside a quote, never stitch non-adjacent words.
- The marked span is a hint, not a boundary: the speaker pressed the key
  while (or just after) the insight was being said. Look around it — usually
  earlier — for where the actual thought starts and ends. Prefer complete
  thoughts over sentence fragments; quotes are typically 1-6 sentences.
- Supporting quotes may come from ANYWHERE in the transcript: earlier setup,
  later callbacks, the other speaker's counterpoint.
- Write insight text and titles in the language of the quote (Dutch stays
  Dutch). An "insight" states why this moment matters, in 1-3 sentences —
  it is commentary, clearly distinct from the quote itself.
- Reply with ONLY a JSON object matching the requested shape. No prose.
- Word ranges use [startWord, endWord) — endWord is exclusive.`

export function transcriptIntro(indexedTranscript: string, markerCount: number, hasGaps = false): string {
  const gapNote = hasGaps
    ? `
Lines like "--- connection gap (…) ---" mark periods where the connection
broke down: utterances around them are not reliable responses to each other,
and a post-gap repetition ("you cut out — what I was saying was…") is the
canonical version of the thought.
`
    : ''
  return `Here is the full transcript. Each line starts with the global word index of
its first word, so you can address any span by word index.

<transcript>
${indexedTranscript}
</transcript>
${gapNote}
There are ${markerCount} marked spans; I will send them one at a time, then ask
for a sweep of unmarked candidates. Reply with exactly: READY`
}

export interface MarkerTurnInput {
  n: number
  total: number
  startS: number
  endS: number
  multiMarked?: boolean
  wordHint: { start: number; end: number } | null
}

export function markerTurn(m: MarkerTurnInput): string {
  const hint = m.wordHint
    ? `The words spoken during the span are roughly [${m.wordHint.start}, ${m.wordHint.end}).`
    : 'No aligned words fall inside the span; look at what was said just before it.'
  const strength = m.multiMarked
    ? ' BOTH participants marked this moment independently — a strong signal that something is here.'
    : ''
  return `Marker ${m.n}/${m.total}: span ${formatTime(m.startS)}–${formatTime(m.endS)}. ${hint}${strength}

Identify the insight this marker points at. If a previous marker already
covered the same moment, or there is genuinely nothing there, use "skip".

Reply with JSON:
{
  "skip": false,                 // or true, with "reason"
  "reason": "",
  "title": "short title, max ~8 words, language of the quote",
  "quote": { "startWord": 0, "endWord": 0, "text": "verbatim words" },
  "insight": "1-3 sentences on why this matters",
  "supporting": [                // 0-3 items, from anywhere in the transcript
    { "startWord": 0, "endWord": 0, "text": "verbatim words", "why": "how it supports" }
  ]
}`
}

export function sweepTurn(maxCandidates: number): string {
  return `Now the sweep: scan the WHOLE transcript for up to ${maxCandidates} insightful
moments that no marker (and none of your previous answers) covered. These are
second-tier suggestions — only genuinely worthwhile ones, fewer is fine, an
empty list is fine.

Reply with JSON:
{
  "candidates": [
    {
      "title": "short title",
      "quote": { "startWord": 0, "endWord": 0, "text": "verbatim words" },
      "insight": "1-3 sentences",
      "why": "why this deserved a marker"
    }
  ]
}`
}

export function manualTurn(startWord: number, endWord: number, quoteText: string): string {
  return `During review a human selected words [${startWord}, ${endWord}) as an insight:

"${quoteText}"

Keep the quote boundaries EXACTLY as given. Draft the metadata around them.

Reply with JSON:
{
  "title": "short title, language of the quote",
  "insight": "1-3 sentences on why this matters",
  "supporting": [
    { "startWord": 0, "endWord": 0, "text": "verbatim words", "why": "how it supports" }
  ]
}`
}

/** The one line the sessions overview shows per conversation. Deliberately
 * fed the harvested insights rather than pointed back at the transcript in
 * context: a summary of everything said drifts toward "we talked about a lot
 * of things", while a summary of what was *marked* says what the
 * conversation actually yielded — and it stays honest to the evidence,
 * which is the same rule the quotes live under. */
export function summaryTurn(insights: { title: string; note: string; quote: string }[]): string {
  const list = insights
    .map((i, n) => `${n + 1}. ${i.title}\n   quote: "${clip(i.quote, 240)}"\n   why it matters: ${clip(i.note, 240)}`)
    .join('\n')
  return `Last task: the session summary, shown in the sessions overview as the one
line that tells us what this conversation was about.

Base it ONLY on the insights harvested above — listed again here. Do not
summarize the rest of the transcript, and do not introduce topics that none
of these insights touch.

<insights>
${list}
</insights>

At most two sentences, roughly 40 words. Say what the conversation was
about, concretely — name the actual subjects, not the fact that subjects
were discussed ("Waarom het lab een eigen deploy nodig heeft", not "Een
gesprek over verschillende onderwerpen"). Language of the conversation.
No title, no preamble, no quotes.

Reply with JSON:
{ "summary": "..." }`
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

export function anchorRetryTurn(problem: string): string {
  return `Your previous answer failed verification: ${problem}
The quote text must match the transcript words at the indices you give,
verbatim. Re-check the word indices against the transcript and reply with the
same JSON shape again.`
}
