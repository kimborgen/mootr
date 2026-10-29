// The phone Glance draws the issue card from its layout (S-3560): the layout, not `Field.card`, decides where a field
// shows, a field the layout dropped is gone, and a layout saved in the editor redraws open cards.
// @vitest-environment jsdom
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock, sendAsHuman: vi.fn() }))

import type { Field } from '../itsa/fields'
import type { Itsa } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// `card: 'meta'` is the old per-field knob; the layouts below put the field elsewhere or nowhere.
const stage: Field = { id: 'f1', key: 'stage', label: 'Stage', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', position: 0 } as Field
const task = { id: 'i1', key: 'S-1', title: 'Gamma', summary: null, status: 'in_progress', kind: 'issue', parent_id: null, updated_at: '2026-10-12T00:00:00Z', created_at: '2026-10-12T00:00:00Z', links: [], participants: [], fields: { stage: 'dev' } } as unknown as Itsa
const noValue = { ...task, id: 'i2', key: 'S-2', title: 'Alpha', fields: {} } as Itsa

let host: HTMLDivElement
let root: Root
type Act = (fn: () => void | Promise<void>) => Promise<void>
let act: Act
let settings: Record<string, unknown>
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve() })
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)

const layoutOf = (slots: Record<string, string[]>) => ({ slots: { TOP: [], META: [], BADGES: [], FOOT: [], ...slots }, titleLines: 3, seen: ['field:f1'], chosen: true })

async function setup(issue: ReturnType<typeof layoutOf>) {
  vi.resetModules()
  localStorage.clear()
  apiMock.mockReset()
  settings = { cardLayouts: { issue } }
  apiMock.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    if (method === 'PATCH' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  const react = await import('react')
  act = react.act as unknown as Act
  root = (await import('react-dom/client')).createRoot(host)
  const { setData } = await import('../store')
  setData({ itsas: [task, noValue], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }] as never, itsaError: null })
  const { Glance } = await import('./Glance')
  const extras = { costs: null, activity: {}, watch: {}, fields: [stage], fieldsFailed: false, fieldsStart: 0 }
  await act(async () => { root.render(<Glance itsas={[task, noValue]} needs={[]} extras={extras as never} now={Date.parse('2026-10-12T01:00:00Z')} />) })
  await flush()
}
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('Glance draws the issue layout', () => {
  it('shows a field the layout puts in BADGES even though its Field.card is meta, and nothing for an issue without a value', async () => {
    await setup(layoutOf({ META: ['status'], BADGES: ['field:f1'] }))
    expect(q('.wg-card[data-itsa=i1] .bc-badges')?.textContent).toContain('dev')
    expect(q('.wg-card[data-itsa=i1] .bc-meta')?.textContent).not.toContain('dev')
    expect(q('.wg-card[data-itsa=i2] .bc-badges')).toBeNull()
  })

  it('hides a field the layout removed', async () => {
    await setup(layoutOf({ META: ['status'] }))
    expect(q('.wg-card[data-itsa=i1]')?.textContent).not.toContain('dev')
  })

  it('redraws an open card when the layout is saved', async () => {
    await setup(layoutOf({ META: ['status'] }))
    expect(q('.wg-card[data-itsa=i1]')?.textContent).not.toContain('dev')
    const { saveCardLayout } = await import('../card-layout')
    await act(async () => { saveCardLayout('issue', layoutOf({ FOOT: ['field:f1'] }) as never) })
    expect(q('.wg-card[data-itsa=i1] .bc-foot')?.textContent).toContain('dev')
  })

  it('draws no move menu on the card, and wraps each value in a cell for the long-press menu', async () => {
    await setup(layoutOf({ META: ['status'] }))
    expect(q('.wg-card[data-itsa=i1] .bc-menu')).toBeNull()
    expect(q('.wg-card[data-itsa=i1] [data-cell=status]')).not.toBeNull()
  })
})
