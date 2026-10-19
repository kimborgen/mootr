// @vitest-environment jsdom
// Linked ITSA chips (S-986): the thread header lists every ITSA the thread's mail links to, once, with
// title; a message with links shows key chips under its header, and one without shows none.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { doneFocus } from './mailFocus'
import { setData } from '../store'
import { ThreadPanel } from './ThreadPanel'
import type { Mail } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mail = (id: string, extra: Partial<Mail> = {}): Mail => ({
  id, from_id: 'a1', body: id, recipients: [], created_at: '2026-10-13T08:00:00Z', kind: 'comment', thread_id: 't1', ...extra,
})

// jsdom has no layout: the charts observe their size, and the mail's colours follow the scheme.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})

let host: HTMLElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  doneFocus()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  doneFocus()
})

const render = async (mails: Mail[]) => { await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={mails} threadKey="t1" />) }) }

const L1 = { id: 'i1', key: 'S-1', title: 'First', status: 'in_progress', source: 'named' as const }
const L2 = { id: 'i2', key: 'S-2', title: 'Second', status: 'done', source: 'thread' as const }
const L3 = { id: 'i3', key: 'S-3', title: 'Third', status: 'todo', source: 'itsa' as const }

describe('linked ITSA chips', () => {
  it('lists each linked ITSA once in the header, and on a message only those it names, inline on the sender line', async () => {
    await render([mail('m1', { itsas: [L1, L2] }), mail('m2', { itsas: [L3] }), mail('m3')])
    const head = [...host.querySelectorAll('.th-itsas [data-about-itsa]')].map((b) => b.textContent)
    expect(head).toEqual(['S-1First', 'S-2Second', 'S-3Third'])
    const own = [...host.querySelectorAll('.msg header .msg-itsas [data-about-itsa]')].map((b) => b.textContent)
    expect(own.sort()).toEqual(['S-1', 'S-3'])
  })

  it('leaves the ITSA of its own thread off every comment, and one every mail links', async () => {
    // t1 is S-1's own thread: each comment there carries it as its itsa_id, and a comment that names another key adds that one.
    setData({ itsas: [{ ...L1, thread_id: 't1' } as never] })
    try {
      await render([mail('m1', { itsas: [{ ...L1, source: 'itsa' }, L3] }), mail('m2', { itsas: [{ ...L1, source: 'itsa' }] }), mail('m3', { itsas: [{ ...L1, source: 'itsa' }, L3] })])
      const own = [...host.querySelectorAll('.msg header .msg-itsas [data-about-itsa]')].map((b) => b.textContent)
      expect(own).toEqual(['S-3', 'S-3'])
    } finally { setData({ itsas: [] }) }
  })

  it('shows at most two keys on a message and folds the rest into +N, which brings the header chips into view', async () => {
    const L4 = { id: 'i4', key: 'S-4', title: 'Fourth', status: 'todo', source: 'named' as const }
    const L5 = { id: 'i5', key: 'S-5', title: 'Fifth', status: 'todo', source: 'named' as const }
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    await render([mail('m1', { itsas: [L1, L3, L4, L5] }), mail('m2')])
    const keys = [...host.querySelectorAll('.msg header .msg-itsas .ichip-mail')].map((b) => b.textContent)
    expect(keys).toEqual(['S-1', 'S-3', '+2'])
    act(() => { (host.querySelector('[data-more-itsas]') as HTMLElement).click() })
    expect(scrolled.map((e) => e.className)).toEqual(['th-itsas'])
  })

  it('shows no per-message chip when the thread links a single ITSA', async () => {
    await render([mail('m1', { itsas: [L1] }), mail('m2', { itsas: [L1] })])
    expect(host.querySelectorAll('.th-itsas [data-about-itsa]').length).toBe(1)
    expect(host.querySelector('.msg-itsas')).toBeNull()
  })

  it('shows no chip row for a thread with no links', async () => {
    await render([mail('m1')])
    expect(host.querySelector('.th-itsas')).toBeNull()
    expect(host.querySelector('.msg-itsas')).toBeNull()
  })
})
