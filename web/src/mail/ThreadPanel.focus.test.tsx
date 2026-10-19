// @vitest-environment jsdom
// A link to a comment that a later ask repeats opens that comment, and it stays open once shown
// (S-415): the repeat row never takes it back.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { askFocus, doneFocus } from './mailFocus'
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

describe('a link to a comment a later ask repeats', () => {
  it('opens the comment and keeps it open', async () => {
    const mails = [mail('c1', { body: 'Pick Redis.' }), mail('ask1', { kind: 'ask', reply_to: 'c1', body: 'Header\n\nPick Redis.' })]
    askFocus('c1', 't1')
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={mails} threadKey="t1" />) })
    expect(host.querySelector('.msg.open[data-id="c1"]')).not.toBeNull()
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={mails} threadKey="t1" />) })
    expect(host.querySelector('.msg.open[data-id="c1"]')).not.toBeNull()
    expect(host.querySelector('[data-repeat="c1"]')).toBeNull()
  })
})
