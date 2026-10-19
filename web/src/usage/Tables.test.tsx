// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { modelName } from './shared'
import { AgentsTab, ModelsTab, MODEL_HELP } from './Tables'
import { measureText } from './measure'
import { BY_AGENT, BY_MODEL, USAGE } from './story-data'
import { DEFAULT_STATE, setUsageState } from './state'
import type { Usage } from './types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { setUsageState({ ...DEFAULT_STATE }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = (u: Usage, days: 0 | 1 | 7 | 30 = 7) => act(() => root.render(<div className="usage"><ModelsTab u={u} days={days} /></div>))
const rowOf = (id: string) => [...host.querySelectorAll('tr')].find((r) => r.textContent?.includes(modelName(id)))!

describe('Agents on an older daemon (S-1845)', () => {
  it('keeps only the chosen types, sums the header over them, and says the daemon did not filter', () => {
    setUsageState({ ...DEFAULT_STATE, agents: ['developer'] })
    // No `filtered_agents` echo: the page filters the rows itself.
    const rows = BY_AGENT.filter((r) => r.type === 'developer' || r.type === 'manager').slice(0, 10)
    const devs = rows.filter((r) => r.type === 'developer')
    expect(devs.length).toBeGreaterThan(0)
    expect(devs.length).toBeLessThan(rows.length)
    act(() => root.render(<div className="usage"><AgentsTab u={{ ...USAGE, filtered_agents: undefined, by_agent: rows } as Usage} days={7} /></div>))
    const names = [...host.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td')).map((r) => r.querySelector('td')!.textContent ?? '')
    expect(names).toHaveLength(devs.length)
    expect(names.every((n) => devs.some((d) => n.includes(d.agent)))).toBe(true)
    const sum = devs.reduce((n, r) => n + (r.cost_usd ?? 0), 0)
    expect(host.querySelector('.usage-sub')!.textContent).toContain(measureText(sum, 'api'))
    expect(host.querySelector('.usage-filter-note')!.textContent).toContain('This daemon does not filter usage by agent type')
  })
})

describe('Models costs (S-1440)', () => {
  it('shows the cost beside each token count and a total', () => {
    render(USAGE)
    const long = rowOf('claude-opus-5-5[1m]')
    // 412M cache-read tokens at $0.2 per million is $82; the count and its cost share a cell.
    expect(long.textContent).toContain('412.0M · $82')
  })

  it('reads a dash for every cost of a model without a price', () => {
    render(USAGE)
    const cells = [...rowOf('fixture-unpriced-model').querySelectorAll('td')].map((c) => c.textContent)
    expect(cells.filter((c) => c?.includes('· —')).length).toBeGreaterThanOrEqual(2)
    expect(cells).toContain('—')
  })

  it('fills the week share only for a model on a subscription', () => {
    render(USAGE)
    const weekIdx = [...host.querySelectorAll('th')].findIndex((t) => t.textContent?.includes('% of week'))
    const week = (name: string) => rowOf(name).querySelectorAll('td')[weekIdx].textContent
    expect(week('claude-opus-5-5[1m]')).not.toBe('')
    expect(week('fixture-unpriced-model')).toBe('')
  })

  it('extends the phone line with costs and the week share', () => {
    render(USAGE)
    expect(rowOf('claude-opus-5-5[1m]').querySelector('.phone-only')!.textContent).toMatch(/210k in \(\$0\.84\) · 640k out \(\$13\) · 421\.8M cache \(\$131\) · est\. \$145 · 41% of week/)
  })

  it('opens the column help from the ? button', () => {
    render(USAGE)
    const btn = host.querySelector<HTMLButtonElement>('.help-btn')!
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.usage-help')).toBeNull()
    act(() => btn.click())
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const help = host.querySelector('.usage-help')!
    for (const [term] of MODEL_HELP) expect(help.textContent).toContain(term)
    expect(help.textContent).toContain('Fresh input, not cached')
    expect(help.textContent).toContain('re-reads the whole conversation')
  })

  it('drops the costs from the phone line of a model without prices', () => {
    render(USAGE)
    const line = rowOf('fixture-unpriced-model').querySelector('.phone-only')!.textContent!
    expect(line).not.toMatch(/—\)|in —|\(\$|est\./)
    expect(line).not.toContain('of week')
  })

  it('never shows a null cache cost as $0 on the phone line', () => {
    const rows = BY_MODEL.map((r) => (r.model === 'claude-opus-5-5[1m]' ? { ...r, cost_cache_write: null, cost_api_total: null } : r))
    render({ ...USAGE, by_model: rows } as Usage)
    expect(rowOf('claude-opus-5-5[1m]').querySelector('.phone-only')!.textContent).toMatch(/421\.8M cache(?! \()/)
  })

  it('hides the % of week column when the measure is % of week', () => {
    setUsageState({ ...DEFAULT_STATE, measure: 'week' })
    render(USAGE)
    const heads = [...host.querySelectorAll('th')].map((t) => t.textContent)
    expect(heads.some((t) => t?.includes('% of week'))).toBe(false)
    expect(heads.some((t) => t?.includes('Token est.'))).toBe(true)
    expect(rowOf('claude-opus-5-5[1m]').querySelector('.phone-only')!.textContent).not.toContain('of week')
  })

  it('keeps working against an older daemon that sends no costs', () => {
    const strip = <T extends object>(o: T) => { const c = { ...o } as Record<string, unknown>; for (const k of ['cost_in', 'cost_out', 'cost_cache_read', 'cost_cache_write', 'cost_api_total']) delete c[k]; return c }
    const old = { ...USAGE, by_model: BY_MODEL.map((r) => ({ ...strip(r), today: strip(r.today), lifetime: strip(r.lifetime) })) } as unknown as Usage
    render(old)
    expect(host.querySelectorAll('tbody tr').length).toBeGreaterThan(1)
    expect(host.querySelectorAll('td:not(:first-child) .muted').length).toBe(0)
  })
})
