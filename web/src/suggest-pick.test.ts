// @vitest-environment jsdom
// The Alt+A prompt's routing (S-1461): when it asks for suggestions, and where a pick, or no
// pick, sends the message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setData } from './store'
import { topTarget } from './actions'
import { asksNow, goTo, queryOf, routeFor, routeName, sendOn, suggestPath, type Route } from './suggest-pick'
import { setUi } from './ui/state'
import type { Agent, Itsa, Mail, SearchResult } from './types'

const agent = (id: string, name: string, over: Partial<Agent> = {}) => ({ id, name, role: '', lifecycle: 'active', state: 'idle', created_at: '2026-10-01T00:00:00Z', kind: null, parents: [], ...over }) as unknown as Agent
const dev = agent('d1', 'fixture-dev')
const cos = agent('c1', 'cos', { chief_of_staff: true })
const exec = agent('e1', 'assistant', { kind: 'assistant' })
const itsa = (over: Partial<Itsa>) => ({ id: 'i1', key: 'F-1', title: 'Fixture issue', status: 'in_progress', owner: 'd1', ...over }) as Itsa
const R = (kind: SearchResult['kind'], id: string, title: string): SearchResult => ({ kind, id, title, score: 1 })

let calls: { method: string; path: string; body?: any }[]
let threadMails: Mail[]
beforeEach(() => {
  calls = []
  threadMails = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
    const json = path.startsWith('/api/threads/') ? threadMails : {}
    return { ok: true, status: 200, json: async () => json }
  }))
})
afterEach(() => { vi.unstubAllGlobals(); setData({ agents: [], itsas: [], assistantDefault: 'assistant' }); setUi({ topTarget: null }); try { localStorage.clear(); sessionStorage.clear() } catch {} })

const payload = { text: 'Look at the fixture build\nit fails', files: [], client_id: 'c-1' }
const mails = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/mail')

describe('asking for suggestions', () => {
  it('asks at once after a space, and waits for a pause otherwise', () => {
    expect(asksNow('fix the ')).toBe(true)
    expect(asksNow('fix the\n')).toBe(true)
    expect(asksNow('fix the')).toBe(false)
    expect(asksNow('   ')).toBe(false)
  })
  it('asks about the words, trimmed and single-spaced', () => {
    expect(queryOf('  fix   the build \n')).toBe('fix the build')
    expect(queryOf('   ')).toBe('')
  })
  it('sends the recently visited ids and a limit', () => {
    const u = new URL(suggestPath('fix it', ['d1', 't9']), 'http://x')
    expect(u.pathname).toBe('/api/suggest')
    expect(u.searchParams.get('q')).toBe('fix it')
    expect(u.searchParams.get('recent')).toBe('d1,t9')
    expect(Number(u.searchParams.get('limit'))).toBeGreaterThan(0)
  })
})

describe('where a pick sends it', () => {
  it('mails a picked agent in a new thread', async () => {
    setData({ agents: [dev] })
    const r = routeFor(R('agent', 'd1', 'fixture-dev')) as Route
    expect(routeName(r)).toBe('fixture-dev')
    expect(await sendOn(r, payload)).toMatch(/Mailed fixture-dev/)
    const [m] = mails()
    expect(m.body).toMatchObject({ from: 'human', to: ['d1'], new_thread: true, subject: 'Look at the fixture build', client_id: 'c-1' })
    expect(m.body.routing_uncertain).toBeUndefined()
  })

  it('replies in a picked thread to the agents who wrote in it', async () => {
    threadMails = [
      { id: 'm1', from_id: 'human', body: 'a', recipients: [{ id: 'd1' }], created_at: '2026-10-17T00:00:00Z' } as Mail,
      { id: 'm2', from_id: 'd1', body: 'b', recipients: [{ id: 'human' }], created_at: '2026-10-17T00:01:00Z' } as Mail,
    ]
    const r = routeFor(R('thread', 't1', 'Fixture thread')) as Route
    expect(await sendOn(r, payload)).toBe('Replied in Fixture thread')
    const [m] = mails()
    expect(m.body).toMatchObject({ from: 'human', to: ['d1'], reply_to: 'm2', body: payload.text })
    expect(m.body.new_thread).toBeUndefined()
  })

  it('mails a picked ITSA\'s owner with the ITSA set', async () => {
    setData({ agents: [dev], itsas: [itsa({})] })
    const r = routeFor(R('itsa', 'i1', 'Fixture issue')) as Route
    expect(routeName(r)).toBe('fixture-dev, about F-1')
    await sendOn(r, payload)
    expect(mails()[0].body).toMatchObject({ to: ['d1'], itsa: 'F-1' })
  })

  it('refuses an ITSA with no agent owner, saying why', () => {
    setData({ itsas: [itsa({ owner: null }), itsa({ id: 'i2', key: 'F-2', owner: 'human' })] })
    expect(routeFor(R('itsa', 'i1', 'x'))).toBe('F-1 has no agent owner to mail')
    expect(routeFor(R('itsa', 'i2', 'x'))).toBe('F-2 has no agent owner to mail')
  })
})

describe('with no pick', () => {
  it('mails the top target, marked routing_uncertain', async () => {
    setData({ agents: [cos, exec] })
    setUi({ topTarget: 'c1' })
    const r = routeFor(null) as Route
    expect(r.kind).toBe('fallback')
    expect(routeName(r)).toBe('cos')
    await sendOn(r, payload)
    expect(mails()[0].body).toMatchObject({ to: ['c1'], routing_uncertain: true, new_thread: true })
  })

  it('mails the running assistant the same way', async () => {
    setData({ agents: [exec] })
    await sendOn({ kind: 'fallback' }, payload)
    expect(mails()[0].body).toMatchObject({ to: ['e1'], routing_uncertain: true })
  })

  it('starts the assistant with the message when it is not running yet', async () => {
    setData({ agents: [] })
    await sendOn({ kind: 'fallback' }, payload)
    expect(mails()).toHaveLength(0)
    expect(calls.find((c) => c.path === '/api/assistant/message')?.body).toMatchObject({ text: payload.text, routing_uncertain: true })
  })

  it('the not-started assistant also gets looking_at, and then no separate context', async () => {
    setData({ agents: [] })
    await sendOn({ kind: 'fallback' }, payload, { looking_at: 'Usage · tokens' })
    const b = calls.find((c) => c.path === '/api/assistant/message')?.body
    expect(b).toMatchObject({ text: payload.text, routing_uncertain: true, looking_at: 'Usage · tokens' })
    expect(b.context).toBeUndefined()
  })

  it('mails the target fixed at the press, even when the top target changes before a retry', async () => {
    setData({ agents: [cos, exec] })
    setUi({ topTarget: 'c1' })
    const r = { kind: 'fallback', target: topTarget() } as Route
    setUi({ topTarget: 'e1' })
    expect(routeName(r)).toBe('cos')
    await sendOn(r, payload)
    expect(mails()[0].body).toMatchObject({ to: ['c1'], routing_uncertain: true })
  })
})

describe('Go to', () => {
  beforeEach(() => { vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) })
  it('opens an ITSA and hands the text to its box, after the draft it holds', () => {
    sessionStorage.setItem('stam/draft/itsa:i1', 'earlier thought')
    expect(goTo(R('itsa', 'i1', 'Fixture issue'), 'moved text', [])).toBe('itsa:i1')
    expect(sessionStorage.getItem('stam/draft/itsa:i1')).toBe('earlier thought\n\nmoved text')
  })
  it('keys a thread by its id, and does nothing for a kind it cannot write to', () => {
    expect(goTo(R('thread', 't1', 'Fixture thread'), 'hello', [])).toBe('thread:t1')
    expect(sessionStorage.getItem('stam/draft/thread:t1')).toBe('hello')
    expect(goTo(R('setting', 'x', 'Setting'), 'hello', [])).toBeNull()
  })
})
