// @vitest-environment jsdom
// The Inventory view (S-879): layers with sizes, flags, summaries in words, a card that opens its
// text, and the refetch that runs while a summary is pending and stops when none is.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryView, POLL_MAX_MS, POLL_MS, TypeInventoryView, type Inv } from './InventoryView'
import { block, composed, layer, small } from './inventory-fixture'
import { getData, setData } from '../store'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const calls: string[] = []
let answers: Record<string, unknown[]> = {}
beforeEach(() => {
  calls.length = 0
  setData({ ...getData(), agents: [{ id: 'fx-dev', name: 'fixture-dev', harness: 'claude', lifecycle: 'active', machine: 'm', cwd: '/', parents: [], created_at: '', updated_at: '' } as never] })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://x').pathname + new URL(url, 'http://x').search
    calls.push(path)
    const list = answers[path] ?? answers[new URL(url, 'http://x').pathname]
    const body = list && list.length > 1 ? list.shift() : list?.[0]
    return new Response(JSON.stringify(body ?? { error: 'none' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }))
  vi.useFakeTimers()
})
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
const withState = (state: 'pending' | 'auto'): Inv => ({
  ...small,
  layers: [layer('system-prompt', 'System prompt', 'stam-generated', [block('system-prompt', 'Rules', state === 'pending' ? { summaryState: 'pending', summary: undefined } : { summary: 'Written by the model.' })])],
})

describe('InventoryView', () => {
  it('shows totals, layers, flags and a card that opens its full text', async () => {
    answers = { '/api/agents/fx-dev/inventory': [small] }
    await act(async () => { root.render(<InventoryView id="fx-dev" />) })
    await flush()
    expect(host.querySelector('.inv-total')?.textContent).toContain(small.totalTokens.toLocaleString('en-US'))
    expect(host.querySelectorAll('.inv-sizes li').length).toBe(small.layers.length)
    expect(host.querySelector('.inv-sizes li.mcp')).not.toBeNull()
    expect(host.querySelectorAll('.inv-flags li').length).toBe(2)
    // A summary off and one pending are stated in words.
    expect(host.textContent).toContain('summaries are off')
    expect(host.textContent).toContain('Summary pending')
    const card = host.querySelector<HTMLDetailsElement>('.inv-card')!
    expect(card.querySelector('.md')).toBeNull()
    await act(async () => { card.open = true; card.dispatchEvent(new Event('toggle')) })
    expect(card.querySelector('.md')?.textContent).toContain('rule0')
    // Tool schemas are JSON in monospace.
    const tool = host.querySelector<HTMLDetailsElement>('.inv-layer:not([open]) .inv-card')!
    await act(async () => { tool.open = true; tool.dispatchEvent(new Event('toggle')) })
    expect(tool.querySelector('pre.code.mono')?.textContent).toContain('"name": "fixture_tool_1"')
    expect(tool.textContent).toContain('tool description')
  })

  it('strikes through a block its type switched off and labels the replacement', async () => {
    answers = { '/api/agents/fx-dev/inventory': [composed] }
    await act(async () => { root.render(<InventoryView id="fx-dev" />) })
    await flush()
    const cards = [...host.querySelectorAll('.inv-card')]
    const off = cards.find((c) => c.textContent?.includes('Waiting for a reply'))!
    expect(off.textContent).toContain('Switched off by developer')
    expect(off.querySelector('.inv-title')!.classList.contains('inv-struck')).toBe(true)
    expect(cards.find((c) => c.textContent?.includes('Replaced by developer'))).toBeTruthy()
    const rep = cards.find((c) => c.textContent?.includes('Mail to your user, short'))!
    expect(rep.textContent).toContain('Replaces global (developer)')
    expect(rep.querySelector('.inv-title')!.classList.contains('inv-struck')).toBe(false)
  })

  it('refetches while a summary is pending, shows the auto chip, and stops', async () => {
    answers = { '/api/agents/fx-dev/inventory': [withState('pending'), withState('auto')] }
    await act(async () => { root.render(<InventoryView id="fx-dev" />) })
    await flush()
    expect(host.textContent).toContain('Summary pending')
    expect(calls.length).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    expect(calls.length).toBe(2)
    expect(host.textContent).toContain('Written by the model.')
    expect(host.querySelector('.inv-chips')?.textContent).toContain('auto')
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3) })
    expect(calls.length).toBe(2)
  })

  it('stops asking when only failed or off summaries remain', async () => {
    const failed: Inv = { ...small, layers: [layer('system-prompt', 'System prompt', 'stam-generated', [block('system-prompt', 'Rules', { summaryState: 'failed', summary: undefined }), block('system-prompt', 'More', { summaryState: 'off', summary: undefined })])] }
    answers = { '/api/agents/fx-dev/inventory': [failed] }
    await act(async () => { root.render(<InventoryView id="fx-dev" />) })
    await flush()
    expect(host.textContent).toContain('Summary failed')
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 5) })
    expect(calls.length).toBe(1)
  })

  it('stops asking on unmount', async () => {
    answers = { '/api/agents/fx-dev/inventory': [withState('pending')] }
    await act(async () => { root.render(<InventoryView id="fx-dev" />) })
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    const n = calls.length
    expect(n).toBeGreaterThan(1)
    await act(async () => { root.render(<div />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 5) })
    expect(calls.length).toBe(n)
  })

  it('gives up after a bounded time while a summary stays pending', async () => {
    answers = { '/api/agents/fx-dev/inventory': [withState('pending')] }
    await act(async () => { root.render(<InventoryView id="fx-dev" />) })
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MAX_MS + POLL_MS * 2) })
    const n = calls.length
    expect(n).toBeLessThan(POLL_MAX_MS / POLL_MS + 3)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 10) })
    expect(calls.length).toBe(n)
    // Once it has given up it says so, and Refresh asks again.
    expect(host.textContent).toContain('Summary not ready yet')
    expect(host.textContent).not.toContain('Summary pending')
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh'))!
    await act(async () => { btn.click() })
    await flush()
    expect(calls.length).toBe(n + 1)
  })

  it('asks for the picked type and harness', async () => {
    answers = {
      '/api/registry': [{ harnesses: { claude: {}, codex: {} }, types: { developer: { harness: 'claude' } } }],
      '/api/types/developer/inventory': [small],
      '/api/types/developer/inventory?harness=codex': [{ ...small, harness: 'codex' }],
    }
    await act(async () => { root.render(<TypeInventoryView />) })
    await flush()
    await flush()
    expect(calls).toContain('/api/types/developer/inventory')
    const [, h] = host.querySelectorAll<HTMLSelectElement>('select')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      set.call(h, 'codex')
      h.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(calls).toContain('/api/types/developer/inventory?harness=codex')
  })
})
