// @vitest-environment jsdom
// A menu that closes onto the place it opened over takes its history entry back, so one back
// press still closes the overlay under it (S-1910); a menu that was open before an overlay did is
// not taken back, which would close that overlay.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as shell from './shell/layout'
import { init } from './nav-history'
import { hideMenu, showPopover } from './ui/menu'
import { getUi, setUi } from './ui/state'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  init()
})
afterEach(async () => { hideMenu(); setUi({ suggestOpen: false }); await tick() })

describe('a menu closing over an overlay', () => {
  it('opened over the prompt: its close takes its entry back', async () => {
    setUi({ suggestOpen: true })
    await tick()
    const back = vi.spyOn(history, 'back')
    showPopover(10, 10, 'Preview', null)
    await tick()
    hideMenu()
    await tick()
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })

  it('opened before the prompt: its close leaves the prompt open', async () => {
    const back = vi.spyOn(history, 'back')
    showPopover(10, 10, 'Menu', null)
    await tick()
    setUi({ suggestOpen: true })
    await tick()
    hideMenu()
    await tick()
    expect(back).not.toHaveBeenCalled()
    back.mockRestore()
  })

  it('opened before the prompt, the prompt over it: one Esc closes the prompt for good (S-2020)', async () => {
    showPopover(10, 10, 'Menu', null)
    await tick()
    setUi({ suggestOpen: true })
    await tick()
    hideMenu()
    await tick()
    setUi({ suggestOpen: false })
    await tick()
    await tick()
    await tick()
    expect(getUi().suggestOpen).toBe(false)
  })

  it('the prompt open before the menu comes back when the skip passes the menu (S-2020)', async () => {
    // Let the previous test's history moves settle, so `start` is the entry shown now.
    for (let i = 0; i < 8; i++) await tick()
    const start = (history.state as { n: number }).n
    setUi({ suggestOpen: true })
    await tick()
    showPopover(10, 10, 'Menu', null)
    await tick()
    setUi({ searchOpen: true })
    await tick()
    setUi({ searchOpen: false, suggestOpen: false })
    hideMenu()
    for (let i = 0; i < 8; i++) await tick()
    // The browser lands on the prompt's entry, one step below the menu-over-prompt entry, not on the page under it.
    expect((history.state as { n: number }).n).toBe(start + 1)
    expect(getUi().suggestOpen).toBe(true)
    setUi({ suggestOpen: false })
    for (let i = 0; i < 8; i++) await tick()
  })

  it('opened over the prompt, closed with it in one go (a scrim click): the prompt stays closed (S-2020)', async () => {
    for (let i = 0; i < 8; i++) await tick()
    const start = (history.state as { n: number }).n
    setUi({ suggestOpen: true })
    await tick()
    showPopover(10, 10, 'Preview', null)
    await tick()
    // The scrim's click, before the preview's outside press closed it: both close in one step.
    hideMenu()
    setUi({ suggestOpen: false })
    for (let i = 0; i < 8; i++) await tick()
    expect((history.state as { n: number }).n).toBe(start)
    expect(getUi().suggestOpen).toBe(false)
  })
})

describe('the phone list select mode (S-3282)', () => {
  // Select mode is a place only on the Agents world, so each test shows it; a back press is delivered after its tick, so each
  // test lets the last one land before the next starts.
  beforeEach(() => shell.showAgentWorld('w:agents'))
  afterEach(async () => { for (let i = 0; i < 8; i++) await tick(); setUi({ agentSelect: false }); shell.showAgentWorld(null) })
  it('entering it pushes an entry that holds the mode, and Done takes that entry back', async () => {
    const back = vi.spyOn(history, 'back')
    setUi({ agentSelect: true })
    await tick()
    expect((history.state as { stam: { select?: boolean } }).stam.select).toBe(true)
    setUi({ agentSelect: false })
    await tick()
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })

  it('a move off the Agents world ends the mode, even when the list stays mounted', async () => {
    setUi({ agentSelect: true })
    await tick()
    shell.showAgentWorld('w:inbox')
    await tick()
    expect(getUi().agentSelect).toBe(false)
  })

  it('the tree or Issues panel over the list ends the mode too, so its bar never floats over that panel', async () => {
    setUi({ agentSelect: true })
    await tick()
    shell.phoneShow('issues')
    await tick()
    expect(getUi().agentSelect).toBe(false)
    setUi({ agentSelect: true })
    await tick()
    shell.phoneShow('left')
    await tick()
    expect(getUi().agentSelect).toBe(false)
    shell.phoneShow(null)
    await tick()
  })

  it('a back press leaves the mode, and the page stays', async () => {
    setUi({ agentSelect: true })
    await tick()
    history.back()
    for (let i = 0; i < 8; i++) await tick()
    expect(getUi().agentSelect).toBe(false)
  })
})
