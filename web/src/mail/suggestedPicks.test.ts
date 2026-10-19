// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as mb from './mailblocks'
import { suggestedPicks } from './suggestedPicks'

const panel = (body: string, cls = 'open') => {
  const el = document.createElement('div')
  el.innerHTML = `<article class="msg ${cls}" data-id="m1"><div class="md">${mb.renderMail(body)}</div></article>`
  return el
}
const PICK = '```pick\nWhich parts?\n- Alpha: first (recommended)\n- Beta: second\n- Gamma: third (recommended)\n```'

describe('pick blocks left untouched', () => {
  it('lists the recommended options of an open, unanswered pick block', () => {
    expect(suggestedPicks(panel(PICK), () => false)).toEqual([{ mailId: 'm1', key: 'm1:0', q: 'Which parts?', labels: ['Alpha', 'Gamma'] }])
  })
  it('skips a block that already has a staged answer, an answered one, and a folded message', () => {
    expect(suggestedPicks(panel(PICK), (k) => k === 'm1:0')).toEqual([])
    const done = panel(PICK)
    done.querySelector('.mb-decision')!.classList.add('answered')
    expect(suggestedPicks(done, () => false)).toEqual([])
    expect(suggestedPicks(panel(PICK, 'folded'), () => false)).toEqual([])
  })
  it('skips a deferred block, mail between agents and a superseded mail', () => {
    const el = panel(PICK)
    mb.markDecisions(el, { created_at: '2026-10-18T00:00:00Z' }, [{ from_id: 'human', created_at: '2026-10-18T00:01:00Z', body: `> Which parts?\n\n${mb.deferText()}` }], true)
    expect(el.querySelector('.mb-decision')!.classList.contains('deferred')).toBe(true)
    expect(suggestedPicks(el, () => false)).toEqual([])
    expect(suggestedPicks(panel(PICK, 'open between'), () => false)).toEqual([])
    expect(suggestedPicks(panel(PICK, 'open superseded'), () => false)).toEqual([])
  })
  it('skips a pick block with nothing recommended, and a single-choice decision', () => {
    expect(suggestedPicks(panel('```pick\nWhich?\n- A: x\n- B: y\n```'), () => false)).toEqual([])
    expect(suggestedPicks(panel('```decision\nWhich?\n- A: x (recommended)\n- B: y\n```'), () => false)).toEqual([])
  })
  it('words the reply so the block still reads as answered', () => {
    const text = mb.pickText(['Alpha', 'Gamma'], true)
    expect(text).toBe('Picked **Alpha**, **Gamma** (as suggested).')
    expect(mb.pickText(['Alpha'])).toBe('Picked **Alpha**.')
    const el = document.createElement('div')
    el.innerHTML = mb.renderMail(PICK)
    mb.markDecisions(el, { created_at: '2026-10-18T00:00:00Z' }, [{ from_id: 'human', created_at: '2026-10-18T00:01:00Z', body: `> Which parts?\n\n${text}` }], true)
    expect(el.querySelector('.mb-decision')!.classList.contains('answered')).toBe(true)
  })
})
