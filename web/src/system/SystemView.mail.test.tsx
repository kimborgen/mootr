// @vitest-environment jsdom
// The system view's slow round on the human's mail (S-4690): a mail event to or from the human runs
// refreshSlow only while the view is on screen. The flying mail (onMail) runs either way.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shownChanged, viewElement } from '../shell/layout'
import type { MailEvent } from '../store'
import { useHumanMailRefresh } from './SystemView'

const h = vi.hoisted(() => ({ refreshSlow: vi.fn(), subs: new Set<(e: MailEvent) => void>() }))
vi.mock('../store', async (orig) => ({
  ...(await orig<typeof import('../store')>()),
  refreshSlow: h.refreshSlow,
  onMailEvent: (cb: (e: MailEvent) => void) => { h.subs.add(cb); return () => { h.subs.delete(cb) } },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'w:system'
let main: HTMLElement
let roots: Root[]
let onMail: ReturnType<typeof vi.fn<(e: MailEvent) => void>>

beforeEach(() => {
  roots = []
  h.refreshSlow.mockClear()
  h.subs.clear()
  onMail = vi.fn()
  main = document.createElement('section')
  main.id = 'w-main'
  document.body.append(main)
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  main.remove()
})

// The view's element, in the main world's pane when shown and hidden when not, with the probe in it.
function mount(shown: boolean) {
  const el = viewElement(KEY)
  el.hidden = !shown
  main.append(el)
  shownChanged()
  const host = document.createElement('div')
  el.append(host)
  const root = createRoot(host)
  roots.push(root)
  const Probe = () => { useHumanMailRefresh(KEY, onMail); return null }
  act(() => root.render(<Probe />))
  return el
}
const setShown = (el: HTMLElement, shown: boolean) => act(() => { el.hidden = !shown; shownChanged() })
const emit = (e: MailEvent) => act(() => { for (const cb of h.subs) cb(e) })

const toHuman: MailEvent = { type: 'sent', id: 'm1', from: 'a1', to: ['human'], thread: null, itsa: null, ask: false, subject: 's', at: null }
const toAgent: MailEvent = { ...toHuman, id: 'm2', to: ['a2'] }
const readByHuman: MailEvent = { type: 'read', id: 'm1', by: 'human', at: null }
const readByAgent: MailEvent = { type: 'read', id: 'm1', by: 'a2', at: null }

describe('the system view on the human\'s mail', () => {
  it('a mail event to the human while the view is hidden calls no refreshSlow', () => {
    const el = mount(false)
    emit(toHuman)
    emit(readByHuman)
    expect(h.refreshSlow).not.toHaveBeenCalled()
    setShown(el, false)
  })

  it('a mail event to the human while the view is shown calls refreshSlow once', () => {
    mount(true)
    emit(toHuman)
    expect(h.refreshSlow).toHaveBeenCalledTimes(1)
  })

  it('a read by the human while the view is shown calls refreshSlow once', () => {
    mount(true)
    emit(readByHuman)
    expect(h.refreshSlow).toHaveBeenCalledTimes(1)
  })

  it('mail that is not the human\'s calls no refreshSlow, shown or not', () => {
    const el = mount(true)
    emit(toAgent)
    emit(readByAgent)
    expect(h.refreshSlow).not.toHaveBeenCalled()
    setShown(el, false)
    emit(toAgent)
    expect(h.refreshSlow).not.toHaveBeenCalled()
  })

  it('a view that shows again runs the slow round on the next mail, not for the mail it missed', () => {
    const el = mount(false)
    emit(toHuman)
    setShown(el, true)
    expect(h.refreshSlow).not.toHaveBeenCalled()
    emit(toHuman)
    expect(h.refreshSlow).toHaveBeenCalledTimes(1)
  })

  it('onMail runs for every event, hidden or shown', () => {
    const el = mount(false)
    emit(toHuman)
    setShown(el, true)
    emit(toAgent)
    expect(onMail.mock.calls.map(([e]) => e.id)).toEqual(['m1', 'm2'])
  })
})
