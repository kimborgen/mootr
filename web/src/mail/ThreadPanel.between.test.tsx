// @vitest-environment jsdom
// Mail between agents in the human's thread view (S-1458) folds to a labelled row; an agent's inbox shows it plainly.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { doneFocus } from './mailFocus'
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

const render = async (mails: Mail[], humanView: boolean) => { await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={mails} threadKey="t1" humanView={humanView} />) }) }
const thread = [
  mail('m1', { from_id: 'a1', recipients: [{ id: 'human', read_at: null }] }),
  mail('m2', { from_id: 'a1', recipients: [{ id: 'a2', read_at: null }] }),
  mail('m3', { from_id: 'a2', recipients: [{ id: 'a1', read_at: null }] }),
  mail('m4', { from_id: 'a1', recipients: [{ id: 'human', read_at: null }] }),
]

describe('mail between agents', () => {
  it('folds to a labelled row in the human view, and opens on tap', async () => {
    await render(thread, true)
    expect(host.querySelectorAll('.msg-between').length).toBe(2)
    expect(host.querySelector('.msg-between')?.textContent).toContain('Between agents')
    expect(host.querySelector('.msg[data-id="m2"]')).toBeNull()
    await act(async () => { (host.querySelector('.msg-between[data-between="m2"]') as HTMLElement).click() })
    expect(host.querySelector('.msg.between[data-id="m2"] .msg-between-note')).not.toBeNull()
    // A tap on the open card's header folds it back to the row.
    await act(async () => { (host.querySelector('.msg.between[data-id="m2"] header') as HTMLElement).click() })
    expect(host.querySelector('.msg-between[data-between="m2"]')).not.toBeNull()
  })
  it('shows it as ordinary mail in an agent view', async () => {
    await render(thread, false)
    expect(host.querySelector('.msg-between')).toBeNull()
  })
})
