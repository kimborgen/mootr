// @vitest-environment jsdom
// A reload over an open overlay (S-4107): the entry the browser keeps says the overlay was open,
// but the UI state starts with every overlay closed. init records the place as shown, so the first
// change after the reload doesn't read as a dismiss, step back, and close an overlay opened since.
import { beforeAll, expect, it, vi } from 'vitest'
import { init } from './nav-history'
import { getUi, setUi } from './ui/state'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  // The entry from before the reload: the assistant overlay was open.
  history.replaceState({ stam: { current: null, mobile: null, search: false, suggest: false, top: true, menu: false, viewer: null, section: null }, n: 3 }, '')
  init()
})

it('the reloaded entry records the overlays closed, as the UI starts', () => {
  expect(getUi().topOpen).toBe(false)
  expect((history.state as { stam: { top: boolean } }).stam.top).toBe(false)
})

it('the first change after a reload steps nowhere, and an overlay opened then stays open', async () => {
  const back = vi.spyOn(history, 'back')
  const go = vi.spyOn(history, 'go')
  // Any change the page makes as it loads (the tree filling in, a world settling), then Alt+C.
  setUi({ filter: 'x' })
  await tick()
  setUi({ filter: '', topOpen: true })
  await tick()
  await tick()
  expect(back).not.toHaveBeenCalled()
  expect(go).not.toHaveBeenCalled()
  expect(getUi().topOpen).toBe(true)
  back.mockRestore()
  go.mockRestore()
})
