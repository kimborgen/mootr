import { describe, expect, it } from 'vitest'
import { parseSummary, sameLine } from './cardSummary'

describe('parseSummary', () => {
  it('parses a decision: question, options, the recommended one marked', () => {
    const s = parseSummary('decision', 'Pick a token lifetime?\n- 1h: safest, users re-login daily (recommended)\n- 12h: one login per workday\n- Neither')
    expect(s).toEqual({ type: 'decision', question: 'Pick a token lifetime?', options: [
      { label: '1h', why: 'safest, users re-login daily', recommended: true },
      { label: '12h', why: 'one login per workday', recommended: false },
      { label: 'Neither', why: '', recommended: false },
    ] })
  })
  it('falls back for a decision without options, or with prose after them', () => {
    expect(parseSummary('decision', 'Just a question?')).toBeNull()
    expect(parseSummary('decision', 'Q?\n- A: a\nThen more prose.')).toBeNull()
    expect(parseSummary('decision', '- A: a\n- B: b')).toBeNull()
  })
  it('parses a blocker into labelled sections', () => {
    const s = parseSummary('blocker', 'Problem: CI is red.\nSolution: Rerun after the cache fix.')
    expect(s).toEqual({ type: 'sections', sections: [
      { key: 'problem', label: 'Problem', text: 'CI is red.' },
      { key: 'solution', label: 'Solution', text: 'Rerun after the cache fix.' },
    ] })
  })
  it('parses a done card with deferred and note, and joins continuation lines', () => {
    const s = parseSummary('done', 'Problem: Login failed.\nSolution: Fixed in PR #356,\nreviewed.\nDeferred: Token refresh.\nNote: Redeploy needed.')
    expect(s).toMatchObject({ type: 'sections' })
    if (s?.type !== 'sections') throw new Error()
    expect(s.sections.map((x) => x.key)).toEqual(['problem', 'solution', 'deferred', 'note'])
    expect(s.sections[1].text).toBe('Fixed in PR #356, reviewed.')
  })
  it('falls back when the contract is broken', () => {
    expect(parseSummary('blocker', 'Problem: only a problem')).toBeNull()
    expect(parseSummary('blocker', 'Plain old summary text.')).toBeNull()
    expect(parseSummary('blocker', 'Intro\nProblem: a\nSolution: b')).toBeNull()
    expect(parseSummary('blocker', 'Problem: a\nSolution: b\nNote: c')).toBeNull()
    expect(parseSummary('done', 'Problem: a\nProblem: b\nSolution: c')).toBeNull()
    expect(parseSummary('general', 'Problem: a\nSolution: b')).toBeNull()
    expect(parseSummary('done', '')).toBeNull()
  })
})

describe('option labels', () => {
  const opt = (line: string) => { const s = parseSummary('decision', 'Q?\n- ' + line); if (s?.type !== 'decision') throw new Error('no parse'); return s.options[0] }
  it('splits at a colon followed by a space, not inside a time', () => {
    expect(opt('12:30 UTC: after lunch')).toMatchObject({ label: '12:30 UTC', why: 'after lunch' })
    expect(opt('12:30 UTC')).toMatchObject({ label: '12:30 UTC', why: '' })
  })
  it('keeps a code or link label whole', () => {
    expect(opt('`a: b`: the first')).toMatchObject({ label: '`a: b`', why: 'the first' })
    expect(opt('[docs: intro](https://example.com/a:b): read it')).toMatchObject({ label: '[docs: intro](https://example.com/a:b)', why: 'read it' })
  })
  it('takes a trailing colon as a label alone', () => {
    expect(opt('Wait:')).toMatchObject({ label: 'Wait', why: '' })
  })
})

describe('sameLine', () => {
  it('ignores case, spacing, marks and trailing punctuation', () => {
    expect(sameLine('Which token lifetime?', 'which  token `lifetime`')).toBe(true)
    expect(sameLine('Pick one.', 'Pick one?')).toBe(true)
    expect(sameLine('Pick one', 'Pick two')).toBe(false)
    expect(sameLine('', '')).toBe(false)
  })
})
