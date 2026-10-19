// @vitest-environment jsdom
// The mail gate marks in a message header (S-983): an override shows its reason on tap,
// and a mail without one shows no gate mark.
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

const render = async (mails: Mail[]) => { await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={mails} threadKey="t1" />) }) }

describe('the mail gate marks', () => {
  it('shows the override reason on tap', async () => {
    await render([mail('m1', { override: 'You asked to hear about restarts.' })])
    const mark = host.querySelector('.msg[data-id="m1"] .verdict.warn') as HTMLElement
    expect(mark).not.toBeNull()
    expect(mark.getAttribute('title')).toBe('The sender overrode the mail check: You asked to hear about restarts.')
    await act(async () => { mark.click() })
    expect(mark.querySelector('.verdict-note')?.textContent).toContain('You asked to hear about restarts.')
  })
  it('shows no mark on a plain mail', async () => {
    await render([mail('m3')])
    expect(host.querySelector('.verdict')).toBeNull()
  })
})
