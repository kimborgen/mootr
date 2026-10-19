// @vitest-environment jsdom
// A menu that closes onto the place it opened over takes its history entry back, so one back
// press still closes the overlay under it (S-1910); a menu that was open before an overlay did is
// not taken back, which would close that overlay.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { init } from './nav-history'
import { hideMenu, showPopover } from './ui/menu'
import { setUi } from './ui/state'

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
})
