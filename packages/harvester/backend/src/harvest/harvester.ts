import { anchorQuote, verbatim, type Range } from '../anchor.js'
import { renderIndexedTranscript, wordsInSpan, type Transcript } from '../transcript.js'
import { extractJson } from '../util.js'
import type { AgentClient } from './agent.js'
import { anchorRetryTurn, manualTurn, markerTurn, sweepTurn, transcriptIntro } from './prompts.js'

export interface MarkerInput {
  id: number
  startS: number
  endS: number
}

export interface ProposedQuote {
  range: Range
  quote: string
  anchored: boolean
  anchorNote?: string
}

export interface ProposedSupport extends ProposedQuote {
  why: string
}

export interface Proposal {
  origin: 'marker' | 'sweep' | 'manual'
  markerId?: number
  title: string
  main: ProposedQuote
  insight: string
  supporting: ProposedSupport[]
}

export interface HarvestProgress {
  step: string
  done: number
  total: number
}

export interface HarvestOutcome {
  proposals: Proposal[]
  skipped: { markerId: number; reason: string }[]
  agentSessionId: string | null
}

interface RawQuote { startWord?: number; endWord?: number; text?: string }
interface RawSupport extends RawQuote { why?: string }
interface RawMarkerReply {
  skip?: boolean
  reason?: string
  title?: string
  quote?: RawQuote
  insight?: string
  supporting?: RawSupport[]
}
interface RawSweepReply { candidates?: (RawMarkerReply & { why?: string })[] }

const SWEEP_MAX = 5

/** One agent session per harvest, one turn per unit of work. The transcript
 * goes in once (turn 0) and stays in context/prompt-cache for every
 * subsequent turn; accumulated answers deduplicate overlapping markers. */
export async function runHarvest(
  agent: AgentClient,
  transcript: Transcript,
  speakerNames: Map<string, string>,
  markers: MarkerInput[],
  onProgress: (p: HarvestProgress) => void,
): Promise<HarvestOutcome> {
  const total = markers.length + 2 // intro + markers + sweep
  onProgress({ step: 'loading transcript into the agent', done: 0, total })
  const intro = await agent.turn(
    transcriptIntro(renderIndexedTranscript(transcript, speakerNames), markers.length))
  let session = intro.sessionId

  const proposals: Proposal[] = []
  const skipped: { markerId: number; reason: string }[] = []

  for (const [i, marker] of markers.entries()) {
    onProgress({ step: `marker ${i + 1}/${markers.length}`, done: i + 1, total })
    const prompt = markerTurn({
      n: i + 1,
      total: markers.length,
      startS: marker.startS,
      endS: marker.endS,
      wordHint: wordsInSpan(transcript, marker.startS, marker.endS),
    })
    const { reply, sessionId } = await jsonTurn<RawMarkerReply>(agent, prompt, session)
    session = sessionId
    if (reply.skip) {
      skipped.push({ markerId: marker.id, reason: reply.reason ?? 'skipped' })
      continue
    }
    const built = await buildProposal(agent, transcript, reply, session, {
      origin: 'marker', markerId: marker.id,
    })
    session = built.sessionId
    if (built.proposal) proposals.push(built.proposal)
    else skipped.push({ markerId: marker.id, reason: built.error ?? 'unusable reply' })
  }

  onProgress({ step: 'sweep for unmarked candidates', done: total - 1, total })
  const { reply: sweep, sessionId } = await jsonTurn<RawSweepReply>(agent, sweepTurn(SWEEP_MAX), session)
  session = sessionId
  for (const candidate of (sweep.candidates ?? []).slice(0, SWEEP_MAX)) {
    const built = await buildProposal(agent, transcript, candidate, session, { origin: 'sweep' })
    session = built.sessionId
    if (built.proposal) proposals.push(built.proposal)
  }

  onProgress({ step: 'done', done: total, total })
  return { proposals, skipped, agentSessionId: session }
}

/** One extra turn in the (resumable) harvest session for a human-selected
 * range. Boundaries are fixed by the human; the LLM only drafts around them. */
export async function runManualTurn(
  agent: AgentClient,
  transcript: Transcript,
  range: Range,
  resume: string | null,
  speakerNames: Map<string, string>,
  markerCount: number,
): Promise<{ proposal: Proposal; agentSessionId: string }> {
  let session = resume
  if (!session) {
    const intro = await agent.turn(
      transcriptIntro(renderIndexedTranscript(transcript, speakerNames), markerCount))
    session = intro.sessionId
  }
  const quote = verbatim(transcript.words, range)
  const { reply, sessionId } = await jsonTurn<RawMarkerReply>(
    agent, manualTurn(range.start, range.end, quote), session)
  const supporting = anchorSupports(transcript, reply.supporting ?? [])
  return {
    agentSessionId: sessionId,
    proposal: {
      origin: 'manual',
      title: reply.title?.trim() || quote.split(/\s+/).slice(0, 6).join(' '),
      main: { range, quote, anchored: true },
      insight: reply.insight?.trim() || '',
      supporting,
    },
  }
}

async function jsonTurn<T>(agent: AgentClient, prompt: string, resume: string | null):
  Promise<{ reply: T; sessionId: string }> {
  const first = await agent.turn(prompt, resume ?? undefined)
  try {
    return { reply: extractJson(first.text) as T, sessionId: first.sessionId }
  } catch (err) {
    const retry = await agent.turn(
      anchorRetryTurn(`reply was not parseable JSON (${String(err)})`), first.sessionId)
    return { reply: extractJson(retry.text) as T, sessionId: retry.sessionId }
  }
}

async function buildProposal(
  agent: AgentClient,
  transcript: Transcript,
  reply: RawMarkerReply,
  session: string,
  base: { origin: 'marker' | 'sweep'; markerId?: number },
): Promise<{ proposal: Proposal | null; sessionId: string; error?: string }> {
  let current = reply
  let sessionId = session

  for (let attempt = 0; attempt < 2; attempt++) {
    const q = current.quote
    if (!q || q.startWord == null || q.endWord == null || !q.text) {
      return { proposal: null, sessionId, error: 'reply missing quote fields' }
    }
    const anchor = anchorQuote(transcript.words, { start: q.startWord, end: q.endWord }, q.text)
    if (anchor.ok) {
      return {
        sessionId,
        proposal: {
          ...base,
          title: current.title?.trim() || anchor.quote.split(/\s+/).slice(0, 6).join(' '),
          main: { range: anchor.range, quote: anchor.quote, anchored: true, anchorNote: anchor.reason },
          insight: current.insight?.trim() || '',
          supporting: anchorSupports(transcript, current.supporting ?? []),
        },
      }
    }
    if (attempt === 0) {
      // One corrective turn ("never fabricate": tell it exactly what failed).
      const retried = await jsonTurn<RawMarkerReply>(
        agent, anchorRetryTurn(anchor.reason ?? 'quote/index mismatch'), sessionId)
      current = retried.reply
      sessionId = retried.sessionId
    } else {
      // Store flagged, never silently accepted.
      return {
        sessionId,
        proposal: {
          ...base,
          title: current.title?.trim() || 'unanchored proposal',
          main: {
            range: anchor.range,
            quote: q.text,
            anchored: false,
            anchorNote: anchor.reason,
          },
          insight: current.insight?.trim() || '',
          supporting: anchorSupports(transcript, current.supporting ?? []),
        },
      }
    }
  }
  return { proposal: null, sessionId, error: 'unreachable' }
}

function anchorSupports(transcript: Transcript, raw: RawSupport[]): ProposedSupport[] {
  const out: ProposedSupport[] = []
  for (const s of raw.slice(0, 3)) {
    if (s.startWord == null || s.endWord == null || !s.text) continue
    const anchor = anchorQuote(transcript.words, { start: s.startWord, end: s.endWord }, s.text)
    out.push({
      range: anchor.range,
      quote: anchor.ok ? anchor.quote : s.text,
      anchored: anchor.ok,
      anchorNote: anchor.reason,
      why: s.why?.trim() ?? '',
    })
  }
  return out
}
