// @vitest-environment jsdom
// The Inbox page (S-2054): its counts are `useWaiting`'s, the chips list what the sidebar lists, a row opens its thread.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const open = vi.fn()
const getMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => [])
const keysMock = { open: null as string | null, step: vi.fn(), triage: vi.fn(), toggle: vi.fn(), undo: vi.fn() }
// Where the page is: the Inbox world on a desktop, unless a test changes it.
const env = { world: 'w:inbox' as string | null, phone: false }
vi.mock('../api', () => ({ api: (...a: unknown[]) => getMock(...a), hash: new URLSearchParams() }))
vi.mock('../actions', async (orig) => ({
  ...(await orig<object>()),
  openInboxThread: (t: string) => open(t),
  inboxThread: () => keysMock.open,
  stepInbox: (d: number) => keysMock.step(d),
  triageInboxThread: (t: string, v: string) => keysMock.triage(t, v),
  toggleInboxUnread: (t: string) => keysMock.toggle(t),
  undoInboxTriage: () => keysMock.undo(),
}))
// The desktop, on the Inbox page: the keys act only there.
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<object>()), currentWorld: () => env.world, isPhone: () => env.phone }))

const now = new Date()
const at = (h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() + h * 36e5
const iso = (ms: number) => new Date(ms).toISOString()
const day = 864e5
const to = (read: string | null) => [{ id: 'human', read_at: read }]
const thread = (id: string, subject: string, created: string, extra = {}) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: 'a1', from_name: 'fixture-dev', subject, created_at: created, recipients: to('x'), body: 'The body of ' + subject, ...extra }] })

const roots: Root[] = []
afterEach(() => { for (const r of roots.splice(0)) act(() => r.unmount()) })

async function mount() {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const store = await import('../store')
  const { InboxView } = await import('./InboxView')
  const { useWaiting } = await import('../itsa/WaitingList')
  store.setData({
    loaded: { agents: true, mail: true, itsas: true }, error: null, agents: [], perms: [], itsas: [], itsaStatuses: [], decisions: [],
    attention: [{ id: 'i1', key: 'S-1', title: 'An ask', status: 'needs_input', since: iso(at(1)), ask_thread_id: 'ask', thread_id: 'ask', owner: 'a1' }],
    humanThreads: [
      thread('ask', 'Pick one', iso(at(1))),
      thread('new', 'Unread today', iso(at(2)), { recipients: to(null) }),
      thread('old', 'Read earlier', iso(at(2) - 3 * day)),
      thread('mine', 'I asked', iso(at(3)), { from_id: 'human', recipients: [] }),
    ],
    humanArchived: [thread('arch', 'Archived one', iso(at(2) - 5 * day))],
    humanDeferred: [thread('def', 'Deferred one', iso(at(2) - 4 * day))],
  } as never)
  let waiting = 0
  const Probe = () => { waiting = useWaiting().length; return null }
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(<><InboxView /><Probe /></>) })
  return { el, waiting: () => waiting }
}
const titles = (el: HTMLElement) => [...el.querySelectorAll('.irow .ir-top > .s')].map((s) => s.textContent)
const chip = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`[data-filter="${id}"]`)!

describe('Inbox page', () => {
  it('groups the inbox: Needs you, Today, Earlier', async () => {
    const { el } = await mount()
    expect([...el.querySelectorAll('.inbox-group')].map((g) => g.getAttribute('data-group'))).toEqual(['needs', 'today', 'earlier'])
    expect(titles(el)).toEqual(['Pick one', 'I asked', 'Unread today', 'Read earlier'])
  })
  it('counts what waits and what is unread as the waiting list does', async () => {
    const { el, waiting } = await mount()
    expect(waiting()).toBe(1)
    expect(el.querySelector('[data-inbox-count]')?.textContent).toBe(`${waiting()} to answer · 1 unread`)
  })
  it('each chip lists its threads', async () => {
    const { el } = await mount()
    const pick = async (id: string) => { await act(async () => { chip(el, id).click() }); return titles(el) }
    expect(await pick('unread')).toEqual(['Unread today'])
    expect(await pick('awaiting')).toEqual(['I asked'])
    expect(await pick('deferred')).toEqual(['Deferred one'])
    expect(await pick('archived')).toEqual(['Archived one'])
    expect(await pick('toanswer')).toEqual(['Pick one'])
    expect(await pick('all')).toHaveLength(4)
  })
  it('marks unread rows and opens a row\'s thread on click and Enter', async () => {
    const { el } = await mount()
    const row = (id: string) => el.querySelector<HTMLElement>(`[data-inbox-row][data-thread="${id}"]`)!
    expect(row('new').classList.contains('unread')).toBe(true)
    expect(row('old').classList.contains('unread')).toBe(false)
    await act(async () => { row('old').click() })
    expect(open).toHaveBeenLastCalledWith('old')
    await act(async () => { row('new').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(open).toHaveBeenLastCalledWith('new')
  })
  it('searches through the mail search and lists the hits it holds', async () => {
    vi.useFakeTimers()
    const { el } = await mount()
    getMock.mockResolvedValueOnce([{ thread_id: 'arch' }, { thread_id: 'nope', subject: 'Older than the lists', people: ['human', 'fixture-dev'], last: iso(at(2) - 90 * day), excerpt: 'Only the API knows it' }, { thread_id: 'old' }])
    const input = el.querySelector<HTMLInputElement>('[data-inbox-search]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'earlier')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    vi.useRealTimers()
    expect(String(getMock.mock.calls.at(-1)?.[1])).toContain('/api/mail/search?box=human&q=earlier')
    expect(titles(el)).toEqual(['Archived one', 'Older than the lists', 'Read earlier'])
    expect(el.querySelector('.inbox-group')?.getAttribute('data-group')).toBe('results')
  })
  it('says so when there is nothing, with words only', async () => {
    const { el } = await mount()
    const store = await import('../store')
    await act(async () => { store.setData({ humanArchived: [] } as never) })
    await act(async () => { chip(el, 'archived').click() })
    expect(el.querySelector('[data-inbox-state="empty"]')?.textContent).toBe('Threads you archive show here.')
    expect(el.querySelector('.inbox-state svg')).toBeNull()
  })
  it('says it is loading, or that the load failed', async () => {
    const { el } = await mount()
    const store = await import('../store')
    await act(async () => { store.setData({ loaded: { agents: true, mail: false, itsas: true }, humanThreads: [] } as never) })
    expect(el.querySelector('[data-inbox-state="loading"]')?.textContent).toBe('Loading mail…')
    await act(async () => { store.setData({ error: 'fixture: unreachable' } as never) })
    expect(el.querySelector('[data-inbox-state="error"]')?.textContent).toContain('fixture: unreachable')
  })
})

describe('Inbox page keys', () => {
  const press = (key: string, init: KeyboardEventInit = {}, at: EventTarget = window) => act(() => { at.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  const reset = () => { keysMock.open = null; keysMock.step.mockClear(); keysMock.triage.mockClear(); keysMock.toggle.mockClear(); keysMock.undo.mockClear() }
  it('j and k step the rows, e and d triage the open thread, z undoes', async () => {
    reset()
    await mount()
    await press('j'); await press('k')
    expect(keysMock.step.mock.calls).toEqual([[1], [-1]])
    keysMock.open = 'new'
    await press('e'); await press('d')
    expect(keysMock.triage.mock.calls).toEqual([['new', 'archive'], ['new', 'defer']])
    await press('z')
    expect(keysMock.undo).toHaveBeenCalledTimes(1)
  })
  it('u toggles unread on the open thread, and does nothing with none open', async () => {
    reset()
    await mount()
    await press('u')
    expect(keysMock.toggle).not.toHaveBeenCalled()
    keysMock.open = 'new'
    await press('u')
    expect(keysMock.toggle.mock.calls).toEqual([['new']])
    await press('u', { ctrlKey: true })
    await press('u', { shiftKey: true })
    expect(keysMock.toggle).toHaveBeenCalledTimes(1)
  })
  it('e and d do nothing with no thread open, r does nothing either', async () => {
    reset()
    await mount()
    const focus = vi.fn()
    const { setBottomHandle } = await import('../bottom-slot')
    setBottomHandle({ focus, restore: () => {} })
    await press('e'); await press('d'); await press('r')
    expect(keysMock.triage).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    setBottomHandle(null)
  })
  it('r focuses the reply of the open thread, / the search box', async () => {
    reset()
    const { el } = await mount()
    const focus = vi.fn()
    const { setBottomHandle } = await import('../bottom-slot')
    setBottomHandle({ focus, restore: () => {} })
    keysMock.open = 'new'
    await press('r')
    expect(focus).toHaveBeenCalledTimes(1)
    setBottomHandle(null)
    await press('/')
    expect(document.activeElement).toBe(el.querySelector('[data-inbox-search]'))
  })
  it('leaves keys alone in a field, with a modifier held, and with the page not shown', async () => {
    reset()
    const { el } = await mount()
    keysMock.open = 'new'
    const input = el.querySelector<HTMLInputElement>('[data-inbox-search]')!
    await press('j', {}, input)
    await press('e', {}, input)
    await press('j', { ctrlKey: true })
    await press('e', { metaKey: true })
    await press('d', { altKey: true })
    await press('z', { shiftKey: true })
    expect(keysMock.step).not.toHaveBeenCalled()
    expect(keysMock.triage).not.toHaveBeenCalled()
    expect(keysMock.undo).not.toHaveBeenCalled()
  })
  it('Escape clears the focus left on a row, and nothing else', async () => {
    reset()
    const { el } = await mount()
    // The filter is kept across mounts (a pushed thread comes back to it), so an earlier test's chip is set back first.
    await act(async () => { chip(el, 'all').click() })
    const row = el.querySelector<HTMLElement>('[data-inbox-row][data-thread="new"]')!
    row.focus()
    expect(document.activeElement).toBe(row)
    await press('Escape', {}, row)
    expect(document.activeElement).not.toBe(row)
  })
  it('keeps the filter when the page comes back, as a pushed thread returns to the list (on the phone)', async () => {
    env.phone = true
    const { el } = await mount()
    await act(async () => { chip(el, 'unread').click() })
    await act(async () => { roots.pop()!.unmount() })
    const { el: again } = await mount()
    expect(chip(again, 'unread').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { chip(again, 'all').click() })
    env.phone = false
  })
  it('the desktop page starts on All and keeps no filter, with no Swipe, History, or group of its own', async () => {
    const { el } = await mount()
    await act(async () => { chip(el, 'unread').click() })
    await act(async () => { roots.pop()!.unmount() })
    const { el: again } = await mount()
    expect(chip(again, 'all').getAttribute('aria-pressed')).toBe('true')
    expect(again.querySelector('[data-swipe-toggle]')).toBeNull()
    expect(again.querySelector('[data-history-toggle]')).toBeNull()
    expect(again.querySelector('[data-delegated-group]')).toBeNull()
    expect(again.querySelector('[data-group="decide-later"]')).toBeNull()
  })
  it('a deferred ask\'s row offers no Undefer and no defer swipe: its ask is cleared by the human\'s reply', async () => {
    const { el } = await mount()
    const store = await import('../store')
    // The ask's thread ends with the human's deferring reply, and the ask is deferred.
    const answer = { id: 'm-defer', from_id: 'human', from_name: 'human', subject: 'Re: Pick one', created_at: iso(at(1)), recipients: [{ id: 'a1', read_at: null }], body: 'Deferring this one' }
    const threads = store.getData().humanThreads.map((t) => (t.thread_id === 'ask' ? { ...t, mails: [...t.mails, answer] } : t))
    await act(async () => { store.setData({ humanThreads: threads, attention: [{ id: 'i1', key: 'S-1', title: 'An ask', status: 'needs_input', since: iso(at(1)), ask_thread_id: 'ask', thread_id: 'ask', owner: 'a1', deferred: true }] } as never) })
    await act(async () => { chip(el, 'deferred').click() })
    const wrap = el.querySelector('[data-thread="ask"]')?.closest('.mrow-wrap')
    expect(wrap).toBeTruthy()
    expect(wrap!.querySelector('.mrow-act.defer')).toBeNull()
    await act(async () => { chip(el, 'all').click() })
  })
  it('lists the dialogs with the parent or the chief of staff under All, as the Mail list did (on the phone)', async () => {
    env.phone = true
    const { el } = await mount()
    const store = await import('../store')
    await act(async () => { store.setData({ delegateDialogs: [{ id: 'dlg1', agent_id: 'a1', agent_name: 'fixture-dev', action: 'Claude Code asks to allow Bash', created_at: iso(at(1)) }] } as never) })
    expect(el.querySelector('[data-delegated-group] [data-delegated="dlg1"]')).not.toBeNull()
    await act(async () => { chip(el, 'unread').click() })
    expect(el.querySelector('[data-delegated-group]')).toBeNull()
    await act(async () => { chip(el, 'all').click() })
    env.phone = false
  })
  it('the digest card\'s Needs line brings the list back from History, and shows the Needs group (on the phone)', async () => {
    env.phone = true
    const digest = { window: { since: iso(at(-9)), until: iso(at(0)) }, dismissedAt: null, happened: { merged: [], closed: [], spawned: [], archived: [], spend: { usd: 0 } }, needs: [{ kind: 'decision', ref: 'S-9', title: 'Pick', since: iso(at(1)), new: true }], next: { itsas: [], working: [] } }
    getMock.mockImplementation(async (...a: unknown[]) => (a[1] === '/api/digest' ? digest : []))
    const { el } = await mount()
    const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    await settle()
    const list = el.querySelector<HTMLElement>('[data-inbox-list]')!
    const toggle = el.querySelector<HTMLButtonElement>('[data-history-toggle]')!
    await act(async () => { toggle.click() })
    expect(list.hidden).toBe(true)
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-digest-needs]')!.click() })
    await settle()
    expect(list.hidden).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    getMock.mockImplementation(async () => [])
    env.phone = false
  })
  it('switches the list for the history, and back (on the phone)', async () => {
    env.phone = true
    const { el } = await mount()
    const list = el.querySelector<HTMLElement>('[data-inbox-list]')!
    const toggle = el.querySelector<HTMLButtonElement>('[data-history-toggle]')!
    expect(toggle.textContent).toBe('History')
    await act(async () => { toggle.click() })
    expect(list.hidden).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { toggle.click() })
    expect(list.hidden).toBe(false)
    expect(toggle.textContent).toBe('History')
    env.phone = false
  })
})

describe('Inbox page keys: where they apply', () => {
  const press = (key: string, at: EventTarget = window) => act(() => { at.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  const reset = () => {
    keysMock.open = 'new'; keysMock.step.mockClear(); keysMock.triage.mockClear(); keysMock.undo.mockClear()
    env.world = 'w:inbox'; env.phone = false
    document.querySelectorAll('.fixture-target, .menu').forEach((n) => n.remove())
  }
  const fixture = (html: string) => { const d = document.createElement('div'); d.className = 'fixture-target'; d.innerHTML = html; document.body.append(d); return d }
  const fired = () => keysMock.step.mock.calls.length + keysMock.triage.mock.calls.length + keysMock.undo.mock.calls.length
  it('ignores the keys in a textarea and in a contenteditable, nested or not', async () => {
    reset()
    const d = fixture('<textarea></textarea><div contenteditable="true"><p><span id="deep">x</span></p></div><div contenteditable="false"><b id="plain">y</b></div>')
    await mount()
    await press('j', d.querySelector('textarea')!)
    await press('e', d.querySelector('#deep')!)
    expect(fired()).toBe(0)
    await press('j', d.querySelector('#plain')!)
    expect(keysMock.step).toHaveBeenCalledWith(1)
  })
  it('does nothing while a menu is open', async () => {
    reset()
    await mount()
    const menu = document.createElement('div')
    menu.className = 'menu'
    document.body.append(menu)
    await press('j')
    await press('z')
    expect(fired()).toBe(0)
  })
  it('does nothing on a phone', async () => {
    reset()
    await mount()
    env.phone = true
    await press('j')
    await press('e')
    expect(fired()).toBe(0)
  })
  it('does nothing when another world shows', async () => {
    reset()
    await mount()
    env.world = 't:new'
    await press('j')
    await press('d')
    expect(fired()).toBe(0)
  })
})
