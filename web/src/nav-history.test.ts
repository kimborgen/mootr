import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as shell from './shell/layout'
import { setData } from './store'
import { setUi } from './ui/state'
import { historyState, init, jumpToEntry } from './nav-history'

const tick = () => new Promise<void>((r) => setTimeout(r, 20))
// Runs a browser history step and waits for the `count` popstate events it brings: jsdom fires each as a task of its
// own, late on a loaded machine, so a fixed wait can end before it (S-4660). nav-history's handler, added in init,
// has run by then. A step onto a dead agent's entry brings two: the handler steps past it.
const step = (go: () => void, count = 1) => new Promise<void>((r) => {
  let n = 0
  const on = () => { if (++n === count) { removeEventListener('popstate', on); r() } }
  addEventListener('popstate', on)
  go()
})
const keys = () => historyState().entries.map((e) => e.key)

describe('the history on the browser history', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    init()
    // Every history step runs 30 ms late, as on a loaded machine, so a test that waits a fixed time fails here and not
    // only on a busy gate.
    // Plain replacements, not spies: two tests below spy on history.go themselves.
    for (const k of ['back', 'forward', 'go'] as const) {
      const real = history[k].bind(history) as (...a: unknown[]) => void
      Object.defineProperty(history, k, { configurable: true, writable: true, value: (...a: unknown[]) => { setTimeout(() => real(...a), 30) } })
    }
  })
  it('records each thing shown, once, and nothing for an overlay', async () => {
    shell.showAgentWorld('w:work'); await tick()
    shell.showAgentWorld('a1'); await tick()
    shell.showAgentWorld('a1'); await tick()
    setUi({ searchOpen: true }); await tick()
    expect(keys()).toEqual(['w:work', 'a1'])
    // Closing the overlay takes its entry back off: a back.
    await step(() => setUi({ searchOpen: false }))
    expect(keys()).toEqual(['w:work', 'a1'])
  })
  it('back moves the marker, a jump to a row lands there, a new visit prunes above', async () => {
    shell.showAgentWorld('a2'); await tick()
    expect(keys()).toEqual(['w:work', 'a1', 'a2'])
    await step(() => history.back())
    expect(historyState().marker).toBe(1)
    await step(() => jumpToEntry(0))
    expect(historyState().marker).toBe(0)
    expect(keys()).toEqual(['w:work', 'a1', 'a2'])
    await step(() => jumpToEntry(2))
    expect(historyState().marker).toBe(2)
    await step(() => jumpToEntry(1))
    shell.showAgentWorld('a3'); await tick()
    expect(keys()).toEqual(['w:work', 'a1', 'a3'])
  })
  it('an overlay opened after going back drops the forward entries too', async () => {
    await step(() => jumpToEntry(0))
    expect(historyState().marker).toBe(0)
    setUi({ searchOpen: true }); await tick()
    expect(keys()).toEqual(['w:work'])
    // Closing the overlay takes its entry back off: a back.
    await step(() => setUi({ searchOpen: false }))
  })
  it('back and forward skip a dead agent and leave its entry in the list', async () => {
    const live = { id: 'x1' }, live2 = { id: 'x2' }
    setData({ loaded: { agents: true, mail: true, itsas: true }, agents: [live, live2] } as never)
    shell.showAgentWorld('x1'); await tick()
    shell.showAgentWorld('dead1'); await tick()
    shell.showAgentWorld('x2'); await tick()
    expect(keys()).toEqual(['w:work', 'x1', 'dead1', 'x2'])
    await step(() => history.back(), 2)
    expect(shell.currentWorld()).toBe('x1')
    expect(historyState().marker).toBe(1)
    expect(keys()).toEqual(['w:work', 'x1', 'dead1', 'x2'])
    await step(() => history.forward(), 2)
    expect(shell.currentWorld()).toBe('x2')
    expect(historyState().marker).toBe(3)
  })
  it('a browser entry without a position moves nothing in the list', async () => {
    const before = historyState()
    history.pushState({ stam: { ...(history.state as { stam: object }).stam, current: 'x1' } }, '')
    await step(() => history.back())
    await step(() => history.forward())
    expect(shell.currentWorld()).toBe('x1')
    expect(historyState().entries).toEqual(before.entries)
  })
  it('a jump to the shown row calls no history.go, since go(0) reloads the page', () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {})
    jumpToEntry(historyState().marker)
    expect(go).not.toHaveBeenCalled()
    go.mockRestore()
  })
  it('back onto a dead entry with a live one at the same position calls no history.go(0)', async () => {
    shell.showAgentWorld('x1'); await tick()
    shell.showAgentWorld('dead1'); await tick()
    const go = vi.spyOn(history, 'go').mockImplementation(() => {})
    // Back onto the dead entry's position from above lands on x1's position, a live entry there.
    const n = historyState().entries.find((e) => e.key === 'x1')!.pos
    const stam = { ...(history.state as { stam: object }).stam, current: 'dead1' }
    window.dispatchEvent(new PopStateEvent('popstate', { state: { stam, n } }))
    await tick()
    expect(go).not.toHaveBeenCalled()
    go.mockRestore()
  })
})
