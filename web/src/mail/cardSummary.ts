// A card summary's structure (S-1312): the summarizer writes one contract per card kind (S-1308).
//   decision: the question, then one "- Option: why" line per option; the recommended one ends in " (recommended)".
//   blocker:  "Problem: ..." then "Solution: ...".
//   done:     "Problem: ...", "Solution: ...", then optional "Deferred: ..." and "Note: ...".
// Pure: parse returns null when the text doesn't match its kind's contract (an older mail, a general card),
// and the card then renders the text as Markdown, as before.
import type { CardKind } from './cardKind'

export interface SummaryOption { label: string; why: string; recommended: boolean }
export interface SummarySection { key: 'problem' | 'solution' | 'deferred' | 'note'; label: string; text: string }
export type CardSummary =
  | { type: 'decision'; question: string; options: SummaryOption[] }
  | { type: 'sections'; sections: SummarySection[] }

const LABELS = { problem: 'Problem', solution: 'Solution', deferred: 'Deferred', note: 'Note' } as const
const SECTION_RE = /^(problem|solution|deferred|note)\s*:\s*(.*)$/i
const BULLET_RE = /^[-*+]\s+(.*)$/
const RECOMMENDED_RE = /\s*\(recommended\)\s*[.!]?$/i

// Where an option's label ends: its first colon followed by a space or the line's end, outside code
// and links, so a time ("12:30 UTC: after lunch") or a `a:b` label doesn't split. -1: no such colon.
function labelEnd(text: string): number {
  const masked = text.replace(/`[^`]*`|\[[^\]]*\]\([^)]*\)/g, (m) => 'x'.repeat(m.length))
  return masked.search(/:(\s|$)/)
}

function parseDecision(lines: string[]): CardSummary | null {
  const question: string[] = []
  const options: SummaryOption[] = []
  for (const l of lines) {
    const b = BULLET_RE.exec(l)
    if (b) {
      let text = b[1].trim()
      const recommended = RECOMMENDED_RE.test(text)
      if (recommended) text = text.replace(RECOMMENDED_RE, '')
      const i = labelEnd(text)
      options.push(i > 0 ? { label: text.slice(0, i).trim(), why: text.slice(i + 1).trim(), recommended } : { label: text.replace(/:$/, ''), why: '', recommended })
    } else if (options.length) return null // prose after the options: not the contract
    else question.push(l)
  }
  return question.length && options.length ? { type: 'decision', question: question.join(' '), options } : null
}

function parseSections(lines: string[], kind: 'blocker' | 'done'): CardSummary | null {
  const sections: SummarySection[] = []
  for (const l of lines) {
    const m = SECTION_RE.exec(l)
    if (m) {
      const key = m[1].toLowerCase() as SummarySection['key']
      if (sections.some((s) => s.key === key)) return null
      sections.push({ key, label: LABELS[key], text: m[2].trim() })
    } else if (sections.length) { const s = sections[sections.length - 1]; s.text = (s.text + ' ' + l).trim() }
    else return null // text before the first label: not the contract
  }
  const has = (k: SummarySection['key']) => sections.some((s) => s.key === k && s.text)
  if (!has('problem') || !has('solution')) return null
  if (kind === 'blocker' && sections.some((s) => s.key === 'deferred' || s.key === 'note')) return null
  return { type: 'sections', sections }
}

export function parseSummary(kind: CardKind, text: string): CardSummary | null {
  if (kind === 'general') return null
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  return kind === 'decision' ? parseDecision(lines) : parseSections(lines, kind)
}

// Whether two lines say the same, ignoring case, spacing, Markdown marks and trailing punctuation:
// a decision whose question is its thread title shows it once.
const norm = (t: string) => t.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').replace(/[\s.?!:;,]+$/, '').trim()
export const sameLine = (a: string, b: string): boolean => !!norm(a) && norm(a) === norm(b)
