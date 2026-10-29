import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Field } from '../itsa/fields'
import { agent } from '../stories/fixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import type { Itsa } from '../types'
import { CARD_ONLY, cardItem, cardItems, cardItemsFor, type CardCtx } from './card-items'
import { WORK_COLUMNS } from './columns'
import type { WorkExtras } from './data'

const field: Field = { id: 'f1', key: 'stage', label: 'Stage', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'chip', position: 0 }
const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const cx = { now: Date.parse('2026-10-20T12:00:00Z'), extras }
const itsa = { id: 'i1', key: 'S-911', title: 'Replace the index files', status: 'in_progress', kind: 'issue', parent_id: null, owner: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-20T11:00:00Z', fields: { stage: 'code' }, links: [] } as unknown as Itsa
const dev = agent({ id: 'fx-dev', name: 'fixture-dev' })
const render = (node: ReactNode) => renderToStaticMarkup(<>{node}</>)
const empty: CardCtx = { it: null, agent: null, cx }

describe('card items', () => {
  it('has one card form on every Work column, with a unique id per item', () => {
    for (const c of WORK_COLUMNS) {
      expect(c.card, c.id).toBeDefined()
      expect(c.card.where.length, c.id).toBeGreaterThan(0)
    }
    const ids = cardItems([field]).map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('field:f1')
    expect(ids).toContain('cost')
  })

  it('lists the card-only items beside the columns and no others', () => {
    const colIds = WORK_COLUMNS.map((c) => c.id)
    for (const i of CARD_ONLY) expect(colIds).not.toContain(i.id)
    expect(CARD_ONLY.map((i) => i.id)).toEqual(['kind', 'parent', 'rollup', 'needs', 'owner', 'links', 'issue', 'mark', 'harness', 'name', 'model', 'treecost', 'activity', 'context', 'mail', 'machine', 'state'])
  })

  it('splits the items by where they may go', () => {
    const issue = cardItemsFor('issue', [field]).map((i) => i.id)
    const agentIds = cardItemsFor('agent', [field]).map((i) => i.id)
    expect(issue).toContain('work')
    expect(issue).not.toContain('harness')
    expect(agentIds).toContain('name')
    expect(agentIds).not.toContain('kind')
    expect(issue).toContain('cost')
    expect(agentIds).toContain('cost')
    expect(issue).toContain('field:f1')
    expect(agentIds).toContain('field:f1')
  })

  it('locks the key and title of an issue and an agent name', () => {
    const locked = cardItems([]).filter((i) => i.locked).map((i) => i.id).sort()
    expect(locked).toEqual(['mark', 'name', 'work'])
  })

  it('draws nothing for an empty card, in either form', () => {
    for (const i of cardItems([field])) {
      expect(render(i.inline(empty)), i.id).toBe('')
      expect(render(i.chip?.(empty) ?? null), i.id).toBe('')
    }
  })

  it('declares no chip where a badge would be faked', () => {
    expect(cardItem('work', [])!.chip).toBeUndefined()
    expect(render(cardItem('github', [])!.chip!({ it: itsa, agent: null, cx }))).toBe('')
  })

  it('draws a chip as a badge in its tone', () => {
    const at = { it: { ...itsa, health: 'at_risk' } as Itsa, agent: null, cx }
    expect(render(cardItem('health', [])!.chip!(at))).toMatch(/^<span class="badge warn"/)
    expect(render(cardItem('status', [])!.chip!({ it: itsa, agent: null, cx }))).toMatch(/^<span class="badge[ "]/)
  })

  it('draws a field chip as a badge of plain content, never a table cell inside it', () => {
    const typed = (type: Field['type'], key: string): Field => ({ ...field, id: key, key, label: key, type, options: null })
    const it2 = { ...itsa, fields: { text: 'code', date: '2026-11-20', link: 'https://docs.example.com/x', check: true } } as Itsa
    const chip = (key: string) => {
      const f = typed(key as Field['type'], key)
      return render(cardItem(`field:${f.id}`, [f])!.chip!({ it: it2, agent: null, cx }))
    }
    expect(chip('text')).toBe('<span class="badge" title="text">code</span>')
    for (const t of ['text', 'date', 'link', 'check']) {
      expect(chip(t), t).toMatch(/^<span class="badge" title="[^"]*">.+<\/span>$/)
      expect(chip(t), t).not.toMatch(/w-ftext|w-time|w-flink|w-fcheck|<a /)
    }
  })

  it('draws the issue items from the ITSA, with no "undefined"', () => {
    for (const i of cardItemsFor('issue', [field])) {
      for (const html of [render(i.inline({ it: itsa, agent: null, cx })), render(i.chip?.({ it: itsa, agent: null, cx }) ?? null)]) {
        expect(html, i.id).not.toContain('undefined')
      }
    }
    expect(render(cardItem('status', [])!.inline({ it: itsa, agent: null, cx }))).toMatch(/progress/i)
    expect(render(cardItem('cost', [])!.inline({ it: itsa, agent: null, cx }))).toContain('$')
  })

  it('draws the agent items from the agent and its ITSA', () => {
    const c = { it: itsa, agent: dev, cx }
    for (const i of cardItemsFor('agent', [field])) {
      expect(render(i.inline(c)), i.id).not.toContain('undefined')
    }
    expect(render(cardItem('name', [])!.inline(c))).toContain('fixture-dev')
    expect(render(cardItem('harness', [])!.inline(c))).toContain('claude')
    expect(render(cardItem('field:f1', [field])!.inline(c))).toContain('code')
  })
})
