import { normalizeToken, type Word } from './transcript.js'

export interface Range {
  start: number
  end: number // exclusive
}

export interface AnchorResult {
  ok: boolean
  /** possibly corrected range (re-anchored); equals input when ok as-is */
  range: Range
  /** verbatim text from the words array for the final range */
  quote: string
  reason?: string
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export function verbatim(words: Word[], range: Range): string {
  return words.slice(range.start, range.end).map((w) => w.text).join(' ')
}

/** Enforce "never fabricate": the quote the LLM cited must match the words
 * array at the indices it claimed. On mismatch, try mechanical re-anchoring —
 * find the quote's token sequence elsewhere, nearest to the claimed start.
 * Empty/whitespace quotes and unfindable text come back ok:false. */
export function anchorQuote(words: Word[], claimed: Range, quoteText: string): AnchorResult {
  const quoteTokens = quoteText.split(/\s+/).map(normalizeToken).filter(Boolean)
  if (quoteTokens.length === 0) {
    return { ok: false, range: claimed, quote: '', reason: 'empty quote' }
  }

  const start = clamp(claimed.start, 0, Math.max(words.length - 1, 0))
  const end = clamp(claimed.end, start + 1, words.length)
  const claimedTokens = words.slice(start, end).map((w) => normalizeToken(w.text)).filter(Boolean)
  if (tokensEqual(claimedTokens, quoteTokens)) {
    const range = { start, end }
    return { ok: true, range, quote: verbatim(words, range) }
  }

  const matches = findTokenSequence(words, quoteTokens)
  if (matches.length > 0) {
    const nearest = matches.reduce((a, b) =>
      Math.abs(a.start - claimed.start) <= Math.abs(b.start - claimed.start) ? a : b)
    return {
      ok: true,
      range: nearest,
      quote: verbatim(words, nearest),
      reason: `re-anchored from [${claimed.start},${claimed.end}) to [${nearest.start},${nearest.end})`,
    }
  }

  return {
    ok: false,
    range: { start, end },
    quote: verbatim(words, { start, end }),
    reason: 'quote text not found in transcript',
  }
}

function tokensEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

/** All occurrences of the normalized token sequence in the words array.
 * Empty-normalizing words (bare punctuation) are transparent. */
export function findTokenSequence(words: Word[], tokens: string[]): Range[] {
  const indexed = words
    .map((w) => ({ index: w.index, token: normalizeToken(w.text) }))
    .filter((w) => w.token.length > 0)
  const out: Range[] = []
  outer: for (let i = 0; i + tokens.length <= indexed.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (indexed[i + j]!.token !== tokens[j]) continue outer
    }
    out.push({ start: indexed[i]!.index, end: indexed[i + tokens.length - 1]!.index + 1 })
  }
  return out
}

/** Clip cutting: snap boundaries outward to the nearest aligned word so
 * aligned:false words never contribute (invented) timestamps. Returns
 * seconds on the audio timeline, before padding. */
export function clipBounds(words: Word[], range: Range): { start: number; end: number } | null {
  let start: number | null = null
  for (let i = range.start; i >= 0; i--) {
    const w = words[i]
    if (w?.aligned && w.start != null) { start = w.start; break }
  }
  let end: number | null = null
  for (let i = range.end - 1; i < words.length; i++) {
    const w = words[i]
    if (w?.aligned && w.end != null) { end = w.end; break }
  }
  if (start == null || end == null || end <= start) return null
  return { start, end }
}
