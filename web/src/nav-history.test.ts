import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as shell from './shell/layout'
import { setData } from './store'
import { setUi } from './ui/state'
import { historyState, init, jumpToEntry } from './nav-history'

const tick = () => new Promise<void>((r) => setTimeout(r, 20))
const keys = () => historyState().entries.map((e) => e.key)

describe('the history on the browser history', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    init()
  })
  it('records each thing shown, once, and nothing for an overlay', async () => {
    shell.showAgentWorld('w:work'); await tick()
    shell.showAgentWorld('a1'); await tick()
    shell.showAgentWorld('a1'); await tick()
    setUi({ searchOpen: true }); await tick()
    expect(keys()).toEqual(['w:work', 'a1'])
    setUi({ searchOpen: false }); await tick()
    expect(keys()).toEqual(['w:work', 'a1'])
  })
  it('back moves the marker, a jump to a row lands there, a new visit prunes above', async () => {
    shell.showAgentWorld('a2'); await tick()
    expect(keys()).toEqual(['w:work', 'a1', 'a2'])
    history.back(); await tick()
    expect(historyState().marker).toBe(1)
    jumpToEntry(0); await tick()
    expect(historyState().marker).toBe(0)
    expect(keys()).toEqual(['w:work', 'a1', 'a2'])
    jumpToEntry(2); await tick()
    expect(historyState().marker).toBe(2)
    jumpToEntry(1); await tick()
    shell.showAgentWorld('a3'); await tick()
    expect(keys()).toEqual(['w:work', 'a1', 'a3'])
  })
  it('an overlay opened after going back drops the forward entries too', async () => {
    jumpToEntry(0); await tick()
    expect(historyState().marker).toBe(0)
    setUi({ searchOpen: true }); await tick()
    expect(keys()).toEqual(['w:work'])
    setUi({ searchOpen: false }); await tick()
  })
  it('back and forward skip a dead agent and leave its entry in the list', async () => {
    const live = { id: 'x1' }, live2 = { id: 'x2' }
    setData({ loaded: { agents: true, mail: true, itsas: true }, agents: [live, live2] } as never)
    shell.showAgentWorld('x1'); await tick()
    shell.showAgentWorld('dead1'); await tick()
    shell.showAgentWorld('x2'); await tick()
    expect(keys()).toEqual(['w:work', 'x1', 'dead1', 'x2'])
    history.back(); await tick(); await tick()
    expect(shell.currentWorld()).toBe('x1')
    expect(historyState().marker).toBe(1)
    expect(keys()).toEqual(['w:work', 'x1', 'dead1', 'x2'])
    history.forward(); await tick(); await tick()
    expect(shell.currentWorld()).toBe('x2')
    expect(historyState().marker).toBe(3)
  })
  it('a browser entry without a position moves nothing in the list', async () => {
    const before = historyState()
    history.pushState({ stam: { ...(history.state as { stam: object }).stam, current: 'x1' } }, '')
    history.back(); await tick()
    history.forward(); await tick()
    expect(shell.currentWorld()).toBe('x1')
    expect(historyState().entries).toEqual(before.entries)
  })
})
