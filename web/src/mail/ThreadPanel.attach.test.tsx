// @vitest-environment jsdom
// A file attachment is a link (S-1512): text and Markdown open in a new tab, anything else downloads. The click
// fetches it with the Bearer header and opens a blob: URL, so the token is never in a URL (S-1534).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { doneFocus } from './mailFocus'
import { ThreadPanel, openAttachment } from './ThreadPanel'
import type { Mail } from '../types'
import { openFile } from '../files/open'
import { setData } from '../store'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../files/open', () => ({ openFile: vi.fn() }))

const mail = (id: string, extra: Partial<Mail> = {}): Mail => ({
  id, from_id: 'a1', body: id, recipients: [], created_at: '2026-10-13T08:00:00Z', kind: 'comment', thread_id: 't1', ...extra,
})

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})
let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); doneFocus() })
afterEach(() => { act(() => root.unmount()); host.remove(); doneFocus() })

describe('file attachments', () => {
  it('links each one: text opens in a tab, other files download', async () => {
    const m = mail('m1', { attachments: [{ name: 'design notes.md', size: 10 }, { name: 'report.xlsx', size: 10 }, { name: 'shot.png', size: 10 }] as never })
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={[m]} threadKey="t1" />) })
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.files a.att-file')]
    expect(links.map((a) => a.textContent)).toEqual(['design notes.md', 'report.xlsx'])
    expect(links[0].getAttribute('href')).toBe('/api/mail/m1/attachments/design%20notes.md')
    expect(links[0].target).toBe('_blank')
    expect(links[0].hasAttribute('download')).toBe(false)
    expect(links[1].getAttribute('href')).not.toContain('token')
  })

  const blobResponse = () => ({ ok: true, blob: async () => new Blob(['hi']) }) as Response
  it('opens text in a tab from a blob URL fetched with the Bearer header', async () => {
    const tab = { location: { href: '' }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(tab as never)
    URL.createObjectURL = vi.fn(() => 'blob:abc')
    URL.revokeObjectURL = vi.fn()
    const f = vi.fn(async () => blobResponse())
    await openAttachment(mail('m1'), 'notes.md', f as never)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/mail/m1/attachments/notes.md')
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer /)
    expect(tab.location.href).toBe('blob:abc')
  })
  it('saves other files from a blob URL, and closes the tab when the fetch fails', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:xyz')
    URL.revokeObjectURL = vi.fn()
    await openAttachment(mail('m1'), 'report.xlsx', (async () => blobResponse()) as never)
    expect(click).toHaveBeenCalledTimes(1)
    const tab = { location: { href: '' }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(tab as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openAttachment(mail('m1'), 'notes.md', (async () => ({ ok: false }) as Response) as never)
    expect(tab.close).toHaveBeenCalled()
  })

  const stubFetch = () => {
    const f = vi.fn(async () => blobResponse())
    vi.stubGlobal('fetch', f)
    URL.createObjectURL = vi.fn(() => 'blob:abc')
    URL.revokeObjectURL = vi.fn()
    return f
  }
  const bearer = (f: ReturnType<typeof vi.fn>) => ((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization
  it('opens a file when its link is clicked, with the Bearer header', async () => {
    const f = stubFetch()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const m = mail('m1', { attachments: [{ name: 'report.xlsx', size: 10 }] as never })
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={[m]} threadKey="t1" />) })
    const a = host.querySelector<HTMLAnchorElement>('.files a.att-file')!
    await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(f).toHaveBeenCalledTimes(1)
    expect(bearer(f)).toMatch(/^Bearer /)
    // A middle click does the same instead of loading the plain URL, which has no token.
    await act(async () => { a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })) })
    expect(f).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
  it('saves an embedded file from its Download link without the token in the URL', async () => {
    const f = stubFetch()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const m = mail('m1', { body: '```embed\nattachment: data.zip\n```', attachments: [{ name: 'data.zip', size: 10 }] as never })
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={[m]} threadKey="t1" />) })
    const a = host.querySelector<HTMLAnchorElement>('.mb-efile a')!
    expect(a.getAttribute('href')).toBe('/api/mail/m1/attachments/data.zip')
    await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(bearer(f)).toMatch(/^Bearer /)
    expect(click).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('attachments in the file view (S-1529)', () => {
  const withPath = (extra: Partial<Mail> = {}) => mail('m1', { attachments: [{ name: 'report.pdf', size: 10, path: '/home/u/.stam/attachments/m1/report.pdf' }] as never, ...extra })
  it('opens the file view on the daemon machine, with a Download action beside the link', async () => {
    setData({ machine: 'host1' })
    const spy = vi.mocked(openFile)
    spy.mockClear()
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={[withPath()]} threadKey="t1" />) })
    const a = host.querySelector<HTMLAnchorElement>('.files a.att-file')!
    expect(a.getAttribute('href')).toBe('#file=host1:/home/u/.stam/attachments/m1/report.pdf')
    expect(host.querySelector('.files .att-dl')).not.toBeNull()
    await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(spy).toHaveBeenCalledWith('host1', '/home/u/.stam/attachments/m1/report.pdf')
  })
  it('shows an attached PDF as a card that opens the file view, never an iframe', async () => {
    setData({ machine: 'host1' })
    const spy = vi.mocked(openFile)
    spy.mockClear()
    const m = withPath({ body: '```embed\nattachment: report.pdf\n```' })
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={[m]} threadKey="t1" />) })
    expect(host.querySelector('iframe')).toBeNull()
    await act(async () => { host.querySelector<HTMLAnchorElement>('[data-att-open]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(spy).toHaveBeenCalledWith('host1', '/home/u/.stam/attachments/m1/report.pdf')
  })
  it('links a path in the body at its line, resolved in the sender\'s cwd', async () => {
    setData({ machine: 'host1', agents: [{ id: 'a1', machine: 'host1', cwd: '/w/repo' } as never] })
    const spy = vi.mocked(openFile)
    spy.mockClear()
    await act(async () => { root.render(<ThreadPanel className="thread-scroll" mails={[mail('m2', { body: 'see `src/daemon.ts:3613`' })]} threadKey="t1" />) })
    const a = host.querySelector<HTMLAnchorElement>('.md a.file-link')!
    await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(spy).toHaveBeenCalledWith('host1', '/w/repo/src/daemon.ts', 3613)
  })
})
