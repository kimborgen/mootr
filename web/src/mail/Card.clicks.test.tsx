// @vitest-environment jsdom
// A Card owns its clicks (S-1769): table sort and "more", a mail link and an agent link work in any host,
// not only under ThreadPanel's root. Each control is clicked with the Card mounted in a bare div.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { doneFocus } from './mailFocus'
import { Card, Folded } from './ThreadPanel'
import { openAgent, selectThread } from '../actions'
import type { Mail } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../actions', () => ({ openAgent: vi.fn(), selectThread: vi.fn() }))

const rows = Array.from({ length: 20 }, (_, i) => `| r${i} | ${20 - i} |`).join('\n')
const mail = (id: string, extra: Partial<Mail> = {}): Mail => ({
  id, from_id: 'a1', body: `| name | n |\n|---|---|\n${rows}`, recipients: [], created_at: '2026-10-13T08:00:00Z', kind: 'comment', thread_id: 't1', ...extra,
})

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})
let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); doneFocus(); vi.clearAllMocks() })
afterEach(() => { act(() => root.unmount()); host.remove(); doneFocus() })

const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
const cell = (n: number) => host.querySelector(`tbody tr:nth-child(${n}) td`)!.textContent
async function mount() {
  const ms = [mail('m1'), mail('m2', { thread_id: 't2' })]
  await act(async () => { root.render(<Card m={ms[0]} first thread={ms} canAnswer={false} ask={null} flash={false} onFlashEnd={() => {}} onFold={() => {}} onMoreItsas={() => {}} />) })
}

describe('Card outside ThreadPanel', () => {
  it('shows all rows of a folded table', async () => {
    await mount()
    expect(host.querySelector('.mb-table.folded')).not.toBeNull()
    await click(host.querySelector('[data-table-more]')!)
    expect(host.querySelector('.mb-table.folded')).toBeNull()
    expect(host.querySelector('[data-table-more]')).toBeNull()
  })
  it('sorts a table once per click', async () => {
    await mount()
    expect(cell(1)).toBe('r0')
    await click(host.querySelector('th[data-sort]')!)
    const first = cell(1)
    await click(host.querySelector('th[data-sort]')!)
    expect(cell(1)).not.toBe(first)
  })
  it('follows a link to a mail in another thread and a link to an agent', async () => {
    await mount()
    const md = host.querySelector('.md')!
    md.insertAdjacentHTML('beforeend', '<a href="#" data-thread-link="m2" data-tid="t2">m2</a><a href="#" data-thread-link="m9" data-tid="t9">m9</a><a href="#" data-open-agent="a7">agent</a>')
    await click(md.querySelector('[data-thread-link="m9"]')!)
    expect(selectThread).toHaveBeenCalledWith('t9')
    await click(md.querySelector('[data-open-agent="a7"]')!)
    expect(openAgent).toHaveBeenCalledWith('a7')
  })
})

describe('Folded outside ThreadPanel', () => {
  it('opens on a click', async () => {
    const onOpen = vi.fn()
    await act(async () => { root.render(<Folded m={mail('m1')} onOpen={onOpen} />) })
    await click(host.querySelector('.msg.folded')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
