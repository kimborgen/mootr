// @vitest-environment jsdom
// The ITSA thread shows its mail as conversation turns (S-1508): every mail in full, a rail and chip for mail from and to you, events and stam notices as lines.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openFile } from '../files/open'
import { setData } from '../store'
import { doneFocus } from '../mail/mailFocus'
import { ThreadItems } from '../views/ItsaView'
import type { ItsaThreadItem, Mail } from '../types'

vi.mock('../files/open', () => ({ openFile: vi.fn() }));

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

const render = async (items: ItsaThreadItem[]) => { await act(async () => { root.render(<ThreadItems items={items} />) }) }
const item = (m: Mail): ItsaThreadItem => ({ type: 'mail', ts: m.created_at, mail: m })
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'

describe('the ITSA thread', () => {
  it('renders every mail in full as a conversation card, with no Open thread button', async () => {
    await render([item(mail('m1', { body: TABLE + '\n\n' + 'long '.repeat(100), recipients: [{ id: 'human', read_at: null }] }))])
    expect(host.querySelector('article.conv-mail[data-mail="m1"]')).not.toBeNull()
    expect(host.querySelector('.conv-mail .md .mb-table table')).not.toBeNull()
    expect(host.querySelector('.ov-mail-snip')).toBeNull()
    expect(host.querySelector('.ov-mail-foot button')).toBeNull()
  })
  it('keeps every mail open, events as lines, and mail between agents in full', async () => {
    const to = [{ id: 'human', read_at: null }]
    const ev: ItsaThreadItem = { type: 'event', ts: '2026-10-13T08:00:00Z', id: 1, actor: 'a1', event: 'status', text: 'set the status to blocked' }
    await render([item(mail('m1', { recipients: to })), ev, item(mail('m2', { recipients: [{ id: 'a2', read_at: null }] })), item(mail('m3', { recipients: to })), item(mail('m4', { recipients: to }))])
    expect(host.querySelectorAll('article.conv-mail').length).toBe(4)
    expect(host.querySelector('.itsa-event')?.textContent).toContain('Set the status to blocked')
    expect(host.querySelector('.msg-between, .msg.folded')).toBeNull()
  })
  it('marks mail from you and to you apart, and mail between agents not at all', async () => {
    await render([
      item(mail('m1', { from_id: 'human', recipients: [{ id: 'a1', read_at: null }] })),
      item(mail('m2', { recipients: [{ id: 'human', read_at: null }] })),
      item(mail('m3', { recipients: [{ id: 'a2', read_at: null }] })),
    ])
    expect(host.querySelector('.conv-mail.from-you .you-chip')?.textContent).toBe('From you')
    expect(host.querySelector('.conv-mail.to-you .you-chip')?.textContent).toBe('To you')
    expect(host.querySelectorAll('.you-chip').length).toBe(2)
    expect(host.querySelector('.ov-mail-head .to .you-chip, .you-chip.to')).toBeNull() // the recipients span is .to
  })
  it('draws stam system mail as a notice line', async () => {
    await render([item(mail('m1', { from_id: 'stam', subject: 'Agent stopped', body: 'a1 stopped.' }))])
    expect(host.querySelector('.ov-turn.notice')).not.toBeNull()
    expect(host.querySelector('article.conv-mail')).toBeNull()
  })
  it('handles clicks inside its cards like the mail view: show all rows, and mail links', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| r${i} | ${i} |`).join('\n')
    await render([item(mail('m1', { body: '| a | b |\n|---|---|\n' + rows + '\n\nSee m1234abc.', recipients: [{ id: 'human', read_at: null }] }))])
    const more = host.querySelector('[data-table-more]') as HTMLElement
    expect(more).not.toBeNull()
    await act(async () => { more.click() })
    expect(host.querySelector('[data-table-more]')).toBeNull()
    const link = host.querySelector('[data-thread-link]') as HTMLElement
    expect(link).not.toBeNull()
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
  })
  it('shows a mail\'s attachments', async () => {
    await render([item(mail('m1', { attachments: [{ name: 'notes.md', size: 10 }, { name: 'shot.png', size: 10 }] as never }))])
    expect(host.querySelector('.conv-mail .files a.att-file')?.textContent).toContain('notes.md')
    expect(host.querySelector('.conv-mail .att-imgs')).not.toBeNull()
  })
  it('shows an embedded image attachment as an img', async () => {
    await render([item(mail('m1', { body: '```embed\nattachment: shot.png\n```', attachments: [{ name: 'shot.png', size: 10 }] as never }))])
    expect(host.querySelector('.conv-mail .mb-eslot img')?.getAttribute('src')).toContain('/api/mail/m1/attachments/shot.png')
  })
  it('opens an embedded PDF in the file view from its card', async () => {
    setData({ machine: 'host1' })
    const spy = vi.mocked(openFile)
    spy.mockClear()
    const att = [{ name: 'report.pdf', size: 10, path: '/home/u/.stam/attachments/m1/report.pdf' }] as never
    await render([item(mail('m1', { body: '```embed\nattachment: report.pdf\n```', attachments: att }))])
    await act(async () => { host.querySelector<HTMLAnchorElement>('[data-att-open]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(spy).toHaveBeenCalledWith('host1', '/home/u/.stam/attachments/m1/report.pdf')
  })
  it('shows a superseded mail dimmed with the line that points at its replacement', async () => {
    await render([item(mail('m1', { superseded_by: 'm2' })), item(mail('m2'))])
    expect(host.querySelector('.conv-mail.superseded .msg-superseded[data-superseded-by="m2"] a[data-superseded-link="m2"]')).not.toBeNull()
  })
  it('draws a mail with a permission as the mail view\'s card, with its outcome', async () => {
    const permission = { id: 'p1', kind: 'tool', status: 'approved', decided_by: 'human', decided_at: '2026-10-13T08:05:00Z' } as never
    await render([item(mail('m1', { permission, recipients: [{ id: 'human', read_at: null }] }))])
    expect(host.querySelector('article.msg[data-id="m1"] .perm.approved')?.textContent).toContain('Approved')
    expect(host.querySelector('.you-chip.you-to')?.textContent).toBe('To you')
    expect(host.querySelector('article.conv-mail')).toBeNull()
  })
  it('marks an ask', async () => {
    await render([item(mail('m1', { kind: 'ask', recipients: [{ id: 'human', read_at: null }] }))])
    expect(host.querySelector('.itsa-health .badge.warn')?.textContent).toBe('Asks you')
  })
  it('scrolls its last row into view once when it opens at the end', async () => {
    const calls: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) { calls.push((this as HTMLElement).dataset.id ?? this.className) }
    const to = [{ id: 'human', read_at: null }]
    const a = [item(mail('m1', { recipients: to })), item(mail('m2', { recipients: to }))]
    await act(async () => { root.render(<ThreadItems items={a} atEnd />) })
    await act(async () => { root.render(<ThreadItems items={[...a, item(mail('m3', { recipients: to }))]} atEnd />) })
    expect(calls.length).toBe(1)
  })
})
