// @vitest-environment jsdom
// The prompt input's Direct/Mail toggle: where a message goes, and what the Mail path posts
// as mail from the human.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendToAgentByMail } from './actions'
import { ApiError, api } from './api'
import { Composer, handoffDraft, moveDraft, type ComposerHandle, type SendPayload } from './Composer'
import { goTo } from './suggest-pick'
import { addDraft, getRows, resetOutbox } from './outbox'
import { setData } from './store'
import { MenuLayer, hideMenu } from './ui/menu'
import type { Agent, SearchResult, UploadFile } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: { method: string; path: string; body?: any }[]
let root: Root
let host: HTMLElement

beforeEach(() => {
  calls = []
  setData({ promptDefaultMode: 'mail' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom has no matchMedia; coarse() asks it whether the pointer is a finger.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
    return { ok: true, status: 200, json: async () => ({}) }
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); try { localStorage.clear(); sessionStorage.clear() } catch {} })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const mount = async (el: React.ReactElement) => { await act(async () => { root.render(<>{el}<MenuLayer /></>) }); await flush() }
const file = (name: string): UploadFile => ({ name, type: name.endsWith('.png') ? 'image/png' : 'text/plain', size: 3, content_b64: 'AAA' })
const agent = { id: 'a1', name: 'lead' } as Agent

describe('sendToAgentByMail', () => {
  it('mails the human\'s prompt as a new thread, its first line as the subject', async () => {
    await sendToAgentByMail(agent, { text: 'Fix the login\nfor SSO users', files: [file('shot.png')] })
    const post = calls.find((c) => c.path === '/api/mail')!
    expect(post.method).toBe('POST')
    expect(post.body).toMatchObject({ from: 'human', to: ['a1'], subject: 'Fix the login', new_thread: true, body: 'Fix the login\nfor SSO users' })
    expect(post.body.attachments).toEqual([{ name: 'shot.png', content_b64: 'AAA' }])
  })
  it('names the mail after the file when there is no text', async () => {
    await sendToAgentByMail(agent, { text: '', files: [file('notes.txt')] })
    expect(calls.find((c) => c.path === '/api/mail')!.body.subject).toBe('notes.txt')
  })
})

describe('sendToAgentByMail cc', () => {
  it('mails the recipient and the cc, once each', async () => {
    await sendToAgentByMail(agent, { text: 'hi', files: [], cc: ['cos1', 'a1'] })
    expect(calls.find((c) => c.path === '/api/mail')!.body.to).toEqual(['a1', 'cos1'])
  })
})

describe('the prompt input\'s recipient menu', () => {
  const ag = (id: string, name: string, o: Partial<Agent> = {}) => ({ id, name, kind: 'agent', lifecycle: 'active', activity: 'idle', created_at: id, parents: [], ...o }) as unknown as Agent
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const menu = () => document.querySelector<HTMLElement>('.menu.popover')
  const open = async () => { if (menu()) return; await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-to')!.click() }) }
  const rows = (sel: string) => [...document.querySelectorAll<HTMLButtonElement>(`.menu ${sel}`)]
  const writeTo = () => rows('[role=radio]')
  const ccs = () => rows('[role=checkbox]')
  const row = (list: HTMLButtonElement[], name: string) => list.find((b) => b.querySelector('b')?.textContent === name)!
  const ccOn = (name: string) => row(ccs(), name)?.getAttribute('aria-checked') === 'true'
  const toggle = async (name: string) => { await act(async () => { row(ccs(), name).click() }) }
  const sendIt = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush() }
  const sendTo = (a: Agent) => ({ id: a.id, name: a.name, glyph: null, label: a.name, placeholder: `Write to ${a.name}`, send: vi.fn(async (_p: SendPayload) => {}) })
  const sends = new Map<string, ReturnType<typeof sendTo>>()
  const asst = () => ({ send: async () => {}, label: () => 'Assistant', to: (a: Agent) => { if (!sends.has(a.id)) sends.set(a.id, sendTo(a)); return sends.get(a.id)! } })
  beforeEach(() => {
    sends.clear()
    setData({ agents: [ag('cos1', 'boss', { chief_of_staff: true }), ag('in1', 'intake', { role: "cos's intake assistant", parents: ['cos1'] }), ag('as1', 'asst', { kind: 'assistant' }), ag('d1', 'dev-one', { role: 'developer', parents: ['mgr'] }), ag('mgr', 'manager'), ag('t1', 'target', { parents: ['mgr'] })] })
  })
  afterEach(() => { act(() => { hideMenu() }) })
  it('offers the current agent, parent, intake, cos and the assistant, the current one ticked', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open()
    expect(writeTo().map((b) => b.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['target current', 'manager parent', 'intake intake', 'boss chief of staff', 'Assistant executive assistant'])
    expect(writeTo().map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false'])
  })
  it('leaves out recipients that do not exist or repeat another', async () => {
    setData({ agents: [ag('cos1', 'boss', { chief_of_staff: true }), ag('t1', 'target', { parents: ['cos1'] })] })
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} assistant={asst()} />)
    await open()
    // cos is the parent, so it shows once; no intake exists
    expect(writeTo().map((b) => b.querySelector('b')!.textContent)).toEqual(['target', 'boss', 'Assistant'])
  })
  it('sends to the picked recipient, and the icon names who it is', async () => {
    const onSend = vi.fn(async () => {})
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={onSend} assistant={asst()} />)
    expect(host.querySelector('.cmp-to')!.getAttribute('aria-label')).toBe('Recipient: target')
    await open()
    await act(async () => { row(writeTo(), 'manager').click() })
    expect(menu()).toBeNull()
    expect(host.querySelector('.cmp-to')!.getAttribute('aria-label')).toBe('Recipient: manager')
    await type('hi boss')
    await sendIt()
    expect(onSend).not.toHaveBeenCalled()
    expect(sends.get('mgr')!.send).toHaveBeenCalledWith({ text: 'hi boss', files: [], client_id: expect.any(String) })
  })
  it('offers cc in Mail mode, sends the picked ones, and clears them after', async () => {
    const mail = vi.fn(async () => {})
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={mail} assistant={asst()} />)
    await open()
    expect(ccs().map((b) => b.querySelector('b')!.textContent)).toEqual(['boss', 'intake', 'asst'])
    await toggle('boss'); await toggle('intake')
    expect(ccOn('boss')).toBe(true)
    expect(host.querySelector('.cmp-to')!.getAttribute('aria-label')).toBe('Recipient: target, cc 2')
    expect(host.querySelector('.cmp-to-n')!.textContent).toBe('+2')
    await type('hello')
    await sendIt()
    expect(mail).toHaveBeenCalledWith({ text: 'hello', files: [], client_id: expect.any(String), cc: ['cos1', 'in1'] })
    expect(host.querySelector('.cmp-to-n')).toBeNull()
  })
  it('drops the recipient from the cc list, and finds any other agent by search', async () => {
    const mail = vi.fn(async () => {})
    await mount(<Composer target={{ key: 'agent:cos1', enabled: true, name: 'boss', to: 'cos1' }} onSend={async () => {}} mail={mail} assistant={asst()} />)
    await open()
    expect(ccs().map((b) => b.querySelector('b')!.textContent)).toEqual(['intake', 'asst'])
    const input = document.querySelector<HTMLInputElement>('.menu .rm-search')!
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { set.call(input, 'dev'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(ccs().map((b) => b.querySelector('b')!.textContent)).toEqual(['dev-one'])
    await toggle('dev-one')
    // the search clears, and the picked agent stays listed, ticked
    expect(ccs().map((b) => b.querySelector('b')!.textContent)).toEqual(['dev-one', 'intake', 'asst'])
    expect(ccOn('dev-one')).toBe(true)
    await type('hi')
    await sendIt()
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ cc: ['d1'] }))
  })
  it('Enter in the search ticks the first match; Esc closes the menu', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open()
    const input = document.querySelector<HTMLInputElement>('.menu .rm-search')!
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { set.call(input, 'dev'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(host.querySelector('.cmp-to')!.getAttribute('aria-label')).toBe('Recipient: target, cc 1')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()).toBeNull()
  })
  it('a chosen agent gets the cc too, and is removed from it', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open()
    await toggle('boss')
    await act(async () => { row(writeTo(), 'boss').click() })
    expect(host.querySelector('.cmp-to-n')).toBeNull()
    await open()
    expect(ccs().map((b) => b.querySelector('b')!.textContent)).not.toContain('boss')
    await toggle('intake')
    await type('x')
    await sendIt()
    expect(sends.get('cos1')!.send).toHaveBeenCalledWith(expect.objectContaining({ cc: ['in1'] }))
  })
  it('preserves other cc when choosing a recipient', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open()
    await toggle('boss'); await toggle('intake')
    await act(async () => { row(writeTo(), 'boss').click() })
    await open()
    expect(ccOn('intake')).toBe(true)
    expect(ccOn('boss')).toBe(false)
  })
  it('drops the cc when the box moves to another pane', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open(); await toggle('boss')
    expect(host.querySelector('.cmp-to-n')!.textContent).toBe('+1')
    await mount(<Composer target={{ key: 'agent:d1', enabled: true, name: 'dev-one', to: 'd1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    expect(host.querySelector('.cmp-to-n')).toBeNull()
  })
  it('keeps the cc of a failed send: the put-back brings it back and the resend carries it under the old client id', async () => {
    let fail = true
    const mail = vi.fn(async (_p: SendPayload) => { if (fail) throw new ApiError('no', 409) })
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={mail} assistant={asst()} />)
    await open(); await toggle('boss')
    await type('words')
    await sendIt()
    expect(host.querySelector('.cmp-to-n')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-outbox .ob-row.failed')!.click() })
    expect(host.querySelector('.cmp-to-n')!.textContent).toBe('+1')
    fail = false
    await sendIt()
    expect(mail.mock.calls[1][0].cc).toEqual(['cos1'])
    expect(mail.mock.calls[1][0].client_id).toBe(mail.mock.calls[0][0].client_id)
  })
  it('a changed cc after a put-back is a new message', async () => {
    let fail = true
    const mail = vi.fn(async (_p: SendPayload) => { if (fail) throw new ApiError('no', 409) })
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={mail} assistant={asst()} />)
    await open(); await toggle('boss')
    await type('words')
    await sendIt()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-outbox .ob-row.failed')!.click() })
    await open(); await toggle('intake')
    fail = false
    await sendIt()
    expect(mail.mock.calls[1][0].cc).toEqual(['cos1', 'in1'])
    expect(mail.mock.calls[1][0].client_id).not.toBe(mail.mock.calls[0][0].client_id)
  })
  it('a saved draft keeps its cc', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open(); await toggle('asst')
    await type('half')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-draft')!.click() })
    expect(getRows('agent:t1')[0]).toMatchObject({ kind: 'draft', cc: ['as1'] })
    expect(host.querySelector('.cmp-to-n')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-outbox .ob-row.draft')!.click() })
    expect(host.querySelector('.cmp-to-n')!.textContent).toBe('+1')
  })
  it('shows no cc outside Mail mode, and no stam icon where there is nothing to pick', async () => {
    setData({ promptDefaultMode: 'direct' })
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={async () => {}} assistant={asst()} />)
    await open()
    expect(menu()).not.toBeNull()
    expect(document.querySelector('.menu .rm-search')).toBeNull()
    await act(async () => { hideMenu() })
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, to: 't1' }} onSend={async () => {}} mail={async () => {}} />)
    expect(host.querySelector('.cmp-to')).toBeNull()
  })
  it('has no hint text beside the target; a notice still shows there', async () => {
    await mount(<Composer target={{ key: 'agent:t1', enabled: true, to: 't1' }} onSend={async () => 'Sent'} />)
    expect(host.querySelector('.cmp-hint')!.textContent).toBe('')
    await type('x')
    await sendIt()
    expect(host.querySelector('.cmp-hint')!.textContent).toBe('Sent')
  })
})

describe('a send kept by the outbox', () => {
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  it('retries after a 503 with the send it was submitted with, not the one published since', async () => {
    // What ItsaView publishes: a send that closes over the staged action. Submitting clears the staged
    // action, so the next render publishes a send without it; the retry must still be the first.
    let first = true
    const withAction = vi.fn(async (_p: SendPayload) => { if (first) { first = false; throw new ApiError('busy', 503) } })
    const plain = vi.fn(async (_p: SendPayload) => {})
    const target = { key: 'itsa:i1', enabled: true, name: 'S-1 thing' }
    await mount(<Composer target={target} onSend={withAction} staged />)
    await type('please change this')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush()
    await mount(<Composer target={target} onSend={plain} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)) })
    await flush()
    expect(withAction).toHaveBeenCalledTimes(2)
    expect(plain).not.toHaveBeenCalled()
  })
})

describe('restoring a draft by target', () => {
  it('puts a draft for another target in that target\'s draft, not in the box now shown', async () => {
    const ref = { current: null as ComposerHandle | null }
    const el = (key: string) => <Composer ref={(h) => { ref.current = h }} target={{ key, enabled: true, name: key }} onSend={async () => {}} />
    const text = () => host.querySelector<HTMLTextAreaElement>('textarea')!.value
    await mount(el('thread:a'))
    await mount(el('agent:b'))
    await act(async () => { ref.current!.restore('a note from the thread', 'thread:a') })
    expect(text()).toBe('')
    await mount(el('thread:a'))
    expect(text()).toBe('a note from the thread')
    // a restore for the target now shown goes in the box, before what is typed
    await act(async () => { ref.current!.restore('again', 'thread:a') })
    expect(text()).toBe('again\n\na note from the thread')
  })
  it('saves the restored text as the draft, so a moveDraft mover carries it', async () => {
    const ref = { current: null as ComposerHandle | null }
    await mount(<Composer ref={(h) => { ref.current = h }} target={{ key: 'view:r1', enabled: true }} onSend={async () => {}} />)
    await act(async () => { ref.current!.restore('a restored note') })
    expect(sessionStorage.getItem('stam/draft/view:r1')).toBe('a restored note')
    moveDraft('view:r1', 'agent:r1')
    expect(sessionStorage.getItem('stam/draft/agent:r1')).toBe('a restored note')
  })
})

describe('the prompt input\'s Direct/Mail toggle', () => {
  const mode = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.cmp-mode button')].find((b) => b.textContent === label)!
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    // React tracks the node's value; set it through the prototype so the input looks changed.
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const send = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush() }

  it('starts in the setting\'s mode; the toggle switches this box only', async () => {
    setData({ promptDefaultMode: 'direct' })
    const onSend = vi.fn(async () => {})
    const mail = vi.fn(async () => 'Mailed lead; the answer comes to your mail')
    await mount(<Composer target={{ key: 'agent:a1', enabled: true }} onSend={onSend} mail={mail} />)
    expect(mode('Direct').getAttribute('aria-pressed')).toBe('true')
    await type('hello there')
    await send()
    expect(onSend).toHaveBeenCalledWith({ text: 'hello there', files: [], client_id: expect.any(String) })
    expect(mail).not.toHaveBeenCalled()

    await act(async () => { mode('Mail').click() })
    expect(mode('Mail').getAttribute('aria-pressed')).toBe('true')
    await type('mail this instead')
    await send()
    expect(mail).toHaveBeenCalledWith({ text: 'mail this instead', files: [], client_id: expect.any(String) })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('stam/prompt-mode')).toBeNull()
  })

  it('starts in Mail by default, and follows the setting when it loads later', async () => {
    await mount(<Composer target={{ key: 'agent:a1', enabled: true }} onSend={async () => {}} mail={async () => {}} />)
    expect(mode('Mail').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { setData({ promptDefaultMode: 'direct' }) })
    expect(mode('Direct').getAttribute('aria-pressed')).toBe('true')
  })

  it('shows no toggle where mail has no meaning', async () => {
    await mount(<Composer target={{ key: 'thread:t1', enabled: true }} onSend={async () => {}} />)
    expect(host.querySelector('.cmp-mode')).toBeNull()
  })

  it('with noDirect, Mail is the only way to send, and Direct says why', async () => {
    setData({ promptDefaultMode: 'direct' })
    const onSend = vi.fn(async () => {})
    const mail = vi.fn(async () => 'Mailed lead; the answer comes to your mail')
    await mount(<Composer target={{ key: 'top:a1', enabled: true }} onSend={onSend} mail={mail} noDirect="lead isn't running" />)
    expect(mode('Direct').disabled).toBe(true)
    expect(mode('Direct').title).toBe("lead isn't running")
    expect(mode('Mail').getAttribute('aria-pressed')).toBe('true')
    await type('to the stopped one')
    await send()
    expect(mail).toHaveBeenCalledWith({ text: 'to the stopped one', files: [], client_id: expect.any(String) })
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('the prompt input\'s draft per target', () => {
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const value = () => host.querySelector<HTMLTextAreaElement>('textarea')!.value
  const x = () => host.querySelector<HTMLButtonElement>('.cmp-clear')
  const send = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush() }
  const remount = async (el: React.ReactElement) => { await act(async () => { root.unmount() }); root = createRoot(host); await mount(el) }
  const agentA = <Composer target={{ key: 'agent:a1', enabled: true }} onSend={async () => {}} />

  it('saves the text under the target key, and restores it when the box comes back', async () => {
    await mount(agentA)
    await type('half a thought')
    expect(sessionStorage.getItem('stam/draft/agent:a1')).toBe('half a thought')
    await remount(agentA)
    expect(value()).toBe('half a thought')
  })
  it('keeps each target\'s draft apart', async () => {
    await mount(agentA)
    await type('for a1')
    await act(async () => { root.render(<Composer target={{ key: 'agent:b2', enabled: true }} onSend={async () => {}} />) })
    expect(value()).toBe('')
    await type('for b2')
    expect(sessionStorage.getItem('stam/draft/agent:a1')).toBe('for a1')
    expect(sessionStorage.getItem('stam/draft/agent:b2')).toBe('for b2')
  })
  it('shows the x only with text, and it clears the text and the key', async () => {
    await mount(agentA)
    expect(x()).toBeNull()
    await type('clear me')
    expect(x()!.getAttribute('aria-label')).toBe('Clear the text')
    await act(async () => { x()!.click() })
    expect(value()).toBe('')
    expect(sessionStorage.getItem('stam/draft/agent:a1')).toBeNull()
    expect(x()).toBeNull()
  })
  it('clears the key when the message is sent', async () => {
    await mount(agentA)
    await type('send me')
    await send()
    expect(sessionStorage.getItem('stam/draft/agent:a1')).toBeNull()
    await remount(agentA)
    expect(value()).toBe('')
  })
  it('keeps working when sessionStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    try {
      await mount(agentA)
      await type('still typed')
      expect(value()).toBe('still typed')
    } finally { vi.restoreAllMocks() }
  })
})

describe('the prompt input\'s Save as draft', () => {
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const value = () => host.querySelector<HTMLTextAreaElement>('textarea')!.value
  const draftBtn = () => host.querySelector<HTMLButtonElement>('.cmp-draft')
  const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); await flush() }
  const rows = () => [...host.querySelectorAll<HTMLElement>('.ob-row[data-kind="draft"]')]
  // Picks a file the way the attach button does; the box reads it as a data URL.
  const pick = async (f: File) => {
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { value: [f], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(); await flush()
  }
  const box = <Composer target={{ key: 'agent:a1', enabled: true }} onSend={async () => {}} />
  beforeEach(() => resetOutbox())

  it('shows the button only with text or files in the box, and not in note mode', async () => {
    await mount(box)
    expect(draftBtn()).toBeNull()
    await type('one thought')
    expect(draftBtn()!.getAttribute('aria-label')).toBe('Save as draft (restore it from the strip)')
  })

  it('moves the text and files into a draft for the target, and clears the box', async () => {
    await mount(box)
    await type('keep this')
    await pick(new File(['x'], 'shot.png', { type: 'image/png' }))
    expect(host.querySelectorAll('.cmp-file')).toHaveLength(1)
    await press(draftBtn()!)
    expect(value()).toBe('')
    expect(host.querySelectorAll('.cmp-file')).toHaveLength(0)
    expect(draftBtn()).toBeNull()
    expect(sessionStorage.getItem('stam/draft/agent:a1')).toBeNull()
    expect(getRows('agent:a1')).toMatchObject([{ kind: 'draft', text: 'keep this', mode: 'direct', files: [{ name: 'shot.png', type: 'image/png' }] }])
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('keep this')])
  })

  it('a click restores the draft into the box and deletes it; it can be drafted again', async () => {
    await mount(box)
    await type('first')
    await press(draftBtn()!)
    await press(rows()[0])
    expect(value()).toBe('first')
    expect(rows()).toEqual([])
    expect(getRows()).toEqual([])
    await press(draftBtn()!)
    expect(getRows('agent:a1')).toMatchObject([{ kind: 'draft', text: 'first' }])
    expect(value()).toBe('')
  })

  it('a restore goes before anything typed since', async () => {
    await mount(box)
    await type('saved')
    await press(draftBtn()!)
    await type('typed since')
    await press(rows()[0])
    expect(value()).toBe('saved\n\ntyped since')
  })

  it('a draft from Mail restores in Mail', async () => {
    await mount(<Composer target={{ key: 'agent:a1', enabled: true }} onSend={async () => {}} mail={async () => ''} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-mode button:last-child')!.click() })
    await type('as mail')
    await press(draftBtn()!)
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-mode button:first-child')!.click() })
    await press(rows()[0])
    expect(host.querySelector('.cmp-mode button:last-child')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('a draft shows in its target\'s strip only', async () => {
    addDraft('agent:b2', 'elsewhere')
    await mount(box)
    expect(rows()).toEqual([])
  })
})

describe('the prompt input\'s outbox strip', () => {
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const value = () => host.querySelector<HTMLTextAreaElement>('textarea')!.value
  const send = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush() }
  const rows = () => [...host.querySelectorAll<HTMLElement>('.ob-row')]
  const post = async (p: SendPayload) => { await api('POST', '/api/agents/a1/prompt', p) }
  const box = <Composer target={{ key: 'agent:a1', enabled: true }} onSend={post} />
  beforeEach(() => resetOutbox())
  afterEach(() => { vi.useRealTimers() })

  it('clears the box at once, and the row leaves when the request has succeeded', async () => {
    let answer: (r: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => { calls.push({ method: 'POST', path, body: JSON.parse(init!.body as string) }); return new Promise((r) => { answer = r }) }))
    await mount(box)
    await type('first line\nsecond')
    await send()
    expect(value()).toBe('')
    expect(sessionStorage.getItem('stam/draft/agent:a1')).toBeNull()
    expect(rows().map((r) => [r.dataset.kind, r.textContent])).toEqual([['pending', 'first line']])
    await act(async () => { answer({ ok: true, status: 200, json: async () => ({}) }) })
    await flush()
    expect(rows()).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('shows a refused message as failed, and a click puts it back before what was typed since', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'lead isn\'t running' }) })))
    await mount(box)
    await type('lost words')
    await send()
    const [r] = rows()
    expect(r.dataset.kind).toBe('failed')
    expect(r.getAttribute('title')).toBe('Failed: lead isn\'t running. Click to put it back in the box')
    await type('typed since')
    await act(async () => { r.click() })
    expect(value()).toBe('lost words\n\ntyped since')
    expect(rows()).toEqual([])
    expect(getRows()).toEqual([])
  })

  it('sends a message put back unchanged under its old client id, and an edited one under a new id', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ method: 'POST', path, body: JSON.parse(init!.body as string) })
      return fail ? { ok: false, status: 409, json: async () => ({ error: 'no' }) } : { ok: true, status: 200, json: async () => ({}) }
    }))
    await mount(box)
    await type('same words')
    await send()
    await act(async () => { rows()[0].click() })
    fail = false
    await send()
    expect(calls.map((c) => c.body.client_id)[1]).toBe(calls[0].body.client_id)
    fail = true
    await type('another')
    await send()
    await act(async () => { rows()[0].click() })
    await type('another, edited')
    fail = false
    await send()
    expect(calls[3].body.client_id).not.toBe(calls[2].body.client_id)
  })

  it('offers Save as draft only when the target takes a message', async () => {
    await mount(<Composer target={{ key: 'none', enabled: false }} onSend={async () => {}} />)
    await type('words')
    expect(host.querySelector('.cmp-draft')).toBeNull()
    await act(async () => { root.render(box) })
    await type('words')
    expect(host.querySelector('.cmp-draft')).not.toBeNull()
  })

  it('keeps a message pending while the daemon is down, and sends it once when it is back', async () => {
    let up = false
    const okCalls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      calls.push({ method: 'POST', path, body })
      if (!up) throw new TypeError('Failed to fetch')
      okCalls.push(body)
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    await mount(box)
    await type('hello')
    vi.useFakeTimers()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    for (const ms of [1000, 2000, 4000]) await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    expect(rows().map((r) => r.dataset.kind)).toEqual(['pending'])
    expect(calls.length).toBeGreaterThanOrEqual(3)
    up = true
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(rows()).toEqual([])
    expect(okCalls).toHaveLength(1)
    // Every attempt carried the same client id, so the daemon types it once.
    expect(new Set(calls.map((c) => c.body.client_id)).size).toBe(1)
  })

  it('sends to the target it was submitted for, after the box moves to another', async () => {
    let answer: (r: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => { calls.push({ method: 'POST', path, body: JSON.parse(init!.body as string) }); return new Promise((r) => { answer = r }) }))
    const to = (id: string) => <Composer target={{ key: 'agent:' + id, enabled: true }} onSend={async (p) => { await api('POST', `/api/agents/${id}/prompt`, p) }} />
    await mount(to('a1'))
    await type('for a1')
    await send()
    await act(async () => { root.render(to('b2')) })
    expect(rows()).toEqual([])
    await act(async () => { root.render(to('a1')) })
    expect(rows().map((r) => r.dataset.kind)).toEqual(['pending'])
    expect(calls.map((c) => c.path)).toEqual(['/api/agents/a1/prompt'])
    await act(async () => { answer({ ok: true, status: 200, json: async () => ({}) }) })
  })
})

describe('Composer attach button long-press', () => {
  const box = <Composer target={{ key: 'agent:a1', enabled: true }} onSend={async () => {}} />
  const fire = (el: Element, type: string, pointerType: string) => act(async () => {
    const e = new Event(type, { bubbles: true }); Object.defineProperty(e, 'pointerType', { value: pointerType }); el.dispatchEvent(e)
  })

  it('opens the image-only picker after a 400 ms touch hold, and not the general one', async () => {
    await mount(box)
    vi.useFakeTimers()
    try {
      const btn = host.querySelector('.cmp-attach')!
      const [general, images] = [...host.querySelectorAll<HTMLInputElement>('input[type=file]')]
      expect(images.accept).toBe('image/*')
      const g = vi.spyOn(general, 'click'), i = vi.spyOn(images, 'click')
      await fire(btn, 'pointerdown', 'touch')
      await act(async () => { vi.advanceTimersByTime(450) })
      expect(i).not.toHaveBeenCalled() // the hold only marks; the picker opens when the finger lifts
      expect(btn.classList.contains('holding')).toBe(true)
      // S-703: Android sends no click after a hold, so the pointerup alone opens the picker.
      await fire(btn, 'pointerup', 'touch')
      expect(i).toHaveBeenCalledTimes(1)
      // A click that does follow the hold (iOS) is swallowed, not a second picker.
      await act(async () => { (btn as HTMLElement).click() })
      expect(i).toHaveBeenCalledTimes(1)
      expect(g).not.toHaveBeenCalled()
      await act(async () => { (btn as HTMLElement).click() })
      expect(g).toHaveBeenCalledTimes(1) // a plain tap still opens the general picker
    } finally { vi.useRealTimers() }
  })

  it('ignores a short touch and a mouse hold', async () => {
    await mount(box)
    vi.useFakeTimers()
    try {
      const btn = host.querySelector('.cmp-attach')!
      const images = host.querySelector<HTMLInputElement>('input[data-images]')!
      const i = vi.spyOn(images, 'click')
      await fire(btn, 'pointerdown', 'touch'); await act(async () => { vi.advanceTimersByTime(200) }); await fire(btn, 'pointerup', 'touch')
      await act(async () => { vi.advanceTimersByTime(500) })
      await fire(btn, 'pointerdown', 'mouse'); await act(async () => { vi.advanceTimersByTime(500) })
      expect(i).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('drops the hold when the finger slides away', async () => {
    await mount(box)
    vi.useFakeTimers()
    try {
      const btn = host.querySelector('.cmp-attach')!
      const ev = (type: string, x: number, y: number) => act(async () => {
        const e = new Event(type, { bubbles: true }); Object.defineProperty(e, 'pointerType', { value: 'touch' })
        Object.defineProperty(e, 'clientX', { value: x }); Object.defineProperty(e, 'clientY', { value: y }); btn.dispatchEvent(e)
      })
      await ev('pointerdown', 10, 10); await ev('pointermove', 10, 40)
      await act(async () => { vi.advanceTimersByTime(450) })
      expect(btn.classList.contains('holding')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('drops the hold when the page scrolls, but a scroll with no hold does nothing', async () => {
    await mount(box)
    vi.useFakeTimers()
    try {
      const btn = host.querySelector('.cmp-attach')!
      await act(async () => { window.dispatchEvent(new Event('scroll')) })
      await fire(btn, 'pointerdown', 'touch')
      await act(async () => { vi.advanceTimersByTime(450) })
      expect(btn.classList.contains('holding')).toBe(true)
      await act(async () => { window.dispatchEvent(new Event('scroll')) })
      expect(btn.classList.contains('holding')).toBe(false)
      // After the hold ended, a scroll has no listener left to run.
      const spy = vi.spyOn(window, 'removeEventListener')
      await act(async () => { window.dispatchEvent(new Event('scroll')) })
      expect(spy).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('cancels the native context menu while a hold is on', async () => {
    await mount(box)
    vi.useFakeTimers()
    try {
      const btn = host.querySelector('.cmp-attach')!
      await fire(btn, 'pointerdown', 'touch')
      await act(async () => { vi.advanceTimersByTime(450) })
      const menu = new Event('contextmenu', { bubbles: true, cancelable: true })
      await act(async () => { btn.dispatchEvent(menu) })
      expect(menu.defaultPrevented).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('drops the hold when the finger leaves the button', async () => {
    await mount(box)
    vi.useFakeTimers()
    try {
      const btn = host.querySelector('.cmp-attach')!
      const g = vi.spyOn(host.querySelector<HTMLInputElement>('input[type=file]')!, 'click')
      await fire(btn, 'pointerdown', 'touch'); await act(async () => { vi.advanceTimersByTime(450) })
      await fire(btn, 'pointercancel', 'touch')
      expect(btn.classList.contains('holding')).toBe(false)
      await act(async () => { (btn as HTMLElement).click() })
      expect(g).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  // S-776: the threshold buzzes once, with the armed cue, so the finger knows to lift.
  it('buzzes once at the hold threshold, and not for a tap, a mouse hold, or the lift', async () => {
    await mount(box)
    vi.useFakeTimers()
    const buzz = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: buzz, configurable: true, writable: true })
    try {
      const btn = host.querySelector('.cmp-attach')!
      const i = vi.spyOn(host.querySelector<HTMLInputElement>('input[data-images]')!, 'click')
      await fire(btn, 'pointerdown', 'touch')
      await act(async () => { vi.advanceTimersByTime(450) })
      expect(buzz).toHaveBeenCalledTimes(1)
      expect(btn.classList.contains('holding')).toBe(true)
      await fire(btn, 'pointerup', 'touch')
      expect(i).toHaveBeenCalledTimes(1)
      expect(btn.classList.contains('holding')).toBe(false)
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(buzz).toHaveBeenCalledTimes(1)
      // A short touch is a tap; a mouse never holds on this control (desktop is unchanged).
      await fire(btn, 'pointerdown', 'touch'); await act(async () => { vi.advanceTimersByTime(150) }); await fire(btn, 'pointerup', 'touch')
      await fire(btn, 'pointerdown', 'mouse'); await act(async () => { vi.advanceTimersByTime(600) }); await fire(btn, 'pointerup', 'mouse')
      expect(buzz).toHaveBeenCalledTimes(1)
      expect(btn.classList.contains('holding')).toBe(false)
    } finally {
      delete (navigator as { vibrate?: unknown }).vibrate
      vi.useRealTimers()
    }
  })
})

describe('a draft handed to a box that is not mounted', () => {
  const item = (name: string) => ({ ...file(name), url: 'blob:x' })
  const R = (kind: SearchResult['kind'], id: string): SearchResult => ({ kind, id, title: id, score: 1 })
  const chips = () => [...host.querySelectorAll('.cmp-file .nm')].map((e) => e.textContent)
  const box = (key: string) => mount(<Composer target={{ key, enabled: true }} onSend={async () => {}} />)
  it('shows a file sent by Go to when a box next mounts with that key', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    expect(goTo(R('itsa', 'i9'), 'see this', [item('notes.txt')])).toBe('itsa:i9')
    await box('itsa:i9')
    expect(chips()).toEqual(['notes.txt'])
    expect(host.querySelector('textarea')!.value).toBe('see this')
  })
  it('moves a draft\'s text and files to the new key when a view falls back to the terminal', async () => {
    handoffDraft('view:v1', 'draft', [item('a.txt')])
    moveDraft('view:v1', 'agent:v1')
    await box('view:v1')
    expect(chips()).toEqual([])
    await box('agent:v1')
    expect(chips()).toEqual(['a.txt'])
    expect(host.querySelector('textarea')!.value).toBe('draft')
  })
  it('carries a mounted box\'s files and text along, with no copy left under the old key', async () => {
    const ui = (key: string) => <Composer target={{ key, enabled: true }} onSend={async () => {}} />
    await mount(ui('view:v2'))
    handoffDraft('view:v2', 'sent along', [item('b.txt')])
    await flush()
    expect(chips()).toEqual(['b.txt'])
    await act(async () => { moveDraft('view:v2', 'agent:v2'); root.render(ui('agent:v2')) })
    expect(chips()).toEqual(['b.txt'])
    expect(host.querySelector('textarea')!.value).toBe('sent along')
    await mount(ui('view:v2'))
    expect(chips()).toEqual([])
    expect(host.querySelector('textarea')!.value).toBe('')
  })
})

describe('the prompt input while an agent\'s turn runs', () => {
  const target = { key: 'view:a1', enabled: true, name: 'lead', label: <b>lead</b>, placeholder: 'Message lead' }
  it('makes the send button Stop, named Stop, and calls it', async () => {
    const onStop = vi.fn()
    await mount(<Composer target={target} onSend={async () => {}} onStop={onStop} />)
    const stop = host.querySelector<HTMLButtonElement>('.cmp-send')!
    expect(stop.getAttribute('aria-label')).toBe('Stop')
    await act(async () => { stop.click() })
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[aria-label="Send"]')).toBeNull()
  })
  it('sends as usual when no turn can be stopped', async () => {
    await mount(<Composer target={target} onSend={async () => {}} />)
    expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Send')
  })
  it('shows a stop error under the box, in the error ink', async () => {
    await mount(<Composer target={target} onSend={async () => {}} onStop={() => {}} stopError="The daemon refused the stop: 409" />)
    const err = host.querySelector<HTMLElement>('.composer > .cmp-stop-err')!
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toBe('The daemon refused the stop: 409')
    expect(host.querySelector('.cmp-box .cmp-stop-err')).toBeNull()
  })
})

describe('the prompt input where the view takes no prompts', () => {
  const target = { key: 'view:a1', enabled: true, name: 'lead', label: <b>lead</b>, placeholder: 'Mail lead' }
  const typeText = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  it('keeps the box enabled and mails, even when it would open in Direct', async () => {
    setData({ promptDefaultMode: 'direct' })
    const mail = vi.fn(async () => {})
    await mount(<Composer target={target} onSend={async () => {}} mail={mail} noDirect="Prompts are typed into its terminal" />)
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
    const direct = host.querySelector<HTMLButtonElement>('.cmp-mode button')!
    expect(direct.disabled).toBe(true)
    expect(direct.title).toBe('Prompts are typed into its terminal')
    await typeText('Check the build')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush()
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ text: 'Check the build' }))
  })
  it('shows Stop while the box is empty and Send once it has text, in Mail and in prompt mode', async () => {
    const onStop = vi.fn()
    const mail = vi.fn(async () => {})
    await mount(<Composer target={target} onSend={async () => {}} mail={mail} onStop={onStop} />)
    // Mail mode (the default here): empty shows Stop, and text turns it into Mail.
    expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Stop')
    await typeText('Also check the phone.')
    expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Mail')
    expect(host.querySelector('[aria-label="Stop"]')).toBeNull()
    // The draft is kept per target, so empty the box before the remount.
    await typeText('')
    await act(async () => { root.unmount() })
    root = createRoot(host)
    setData({ promptDefaultMode: 'direct' })
    await mount(<Composer target={target} onSend={async () => {}} mail={mail} onStop={onStop} />)
    // Prompt mode: the same rule.
    expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Stop')
    await typeText('Also check the phone.')
    expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Send')
  })
  it('keeps Send, disabled, for a double-click after a send, so a second click does not Stop', async () => {
    const onStop = vi.fn()
    await mount(<Composer target={target} onSend={async () => {}} onStop={onStop} />)
    await typeText('Check the build')
    vi.useFakeTimers()
    try {
      await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
      // The box is empty now; the button stays Send, disabled, for the guard, so the second click does nothing.
      const btn = host.querySelector<HTMLButtonElement>('.cmp-send')!
      expect(btn.getAttribute('aria-label')).toBe('Send')
      expect(btn.disabled).toBe(true)
      await act(async () => { btn.click() })
      expect(onStop).not.toHaveBeenCalled()
      // Still Send past the old 400 ms guard: the window is the 500 ms OS double-click interval.
      await act(async () => { vi.advanceTimersByTime(450) })
      expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Send')
      // After the guard's interval the empty box's button is Stop.
      await act(async () => { vi.advanceTimersByTime(50) })
      expect(host.querySelector('.cmp-send')!.getAttribute('aria-label')).toBe('Stop')
    } finally { vi.useRealTimers() }
  })
})
