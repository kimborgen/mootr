// @vitest-environment jsdom
// stam's own view of an agent (S-79): the state model's merges, and the view drawn from a
// stubbed view stream: mail components inside an assistant message, thinking and tool calls
// folded, a permission answered, Stop, and older pages read; the working indicator, and the
// view with no bar under it: the state on the tab icon, Stop on the prompt input (Composer.tsx).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Glyph } from '../Glyph'
import { currentWorld } from '../shell/layout'
import { setData } from '../store'
import type { Agent } from '../types'
import { getLive } from './ownview-live'
import { activity, applyEvent, elapsed, layout, loosePermissions, mailNoticeSplit, prependOlder, readingOrder, toolLine, toolRuns, turnKind, turns, type ViewMessage, type ViewPart, type ViewState } from './ownview-model'
import { OwnView } from './OwnView'

// Counts how often each text is drawn, to prove a stream event leaves unchanged turns alone (S-1566).
const drawn = vi.hoisted(() => new Map<string, number>())
vi.mock('../mail/Rendered', async (orig) => {
  const m = await orig<typeof import('../mail/Rendered')>()
  return { ...m, Rendered: (p: Parameters<typeof m.Rendered>[0]) => { drawn.set(p.text, (drawn.get(p.text) ?? 0) + 1); return m.Rendered(p) } }
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const F = '```'
const msg = (id: string, at: number, over: Partial<ViewMessage> = {}): ViewMessage => ({ id, role: 'assistant', at, parts: [{ type: 'text', text: id }], ...over })
const CAPS = { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }
const state = (over: Partial<ViewState> = {}): ViewState => ({ agent: 'oc', harness: 'opencode', capabilities: CAPS, running: false, messages: [], permissions: [], older: null, ...over })

describe('the view state model', () => {
  it('says what a running turn does: waiting, a tool, thinking, writing, or just working', () => {
    const tool = (status: 'running' | 'done'): ViewPart => ({ type: 'tool', id: 't', name: 'shell', input: { command: 'npm test' }, status })
    const run = (parts: ViewPart[], over: Partial<ViewState> = {}) => activity(state({ running: true, messages: [msg('u', 1, { role: 'user' }), msg('a', 5, { running: true, parts })], ...over }))
    expect(run([tool('running')])).toEqual({ kind: 'tool', label: 'Running shell', detail: 'npm test', since: 5 })
    expect(run([tool('done'), { type: 'reasoning', text: 'hm' }])?.kind).toBe('thinking')
    expect(run([{ type: 'text', text: 'Here' }])?.label).toBe('Writing')
    expect(run([tool('done')])?.label).toBe('Working')
    // Before the reply starts, after the prompt: working, with no time to count from.
    expect(activity(state({ running: true, messages: [msg('u', 1, { role: 'user' })] }))).toEqual({ kind: 'working', label: 'Working', since: null })
    // A waiting permission comes first; an ended turn shows nothing.
    expect(run([tool('running')], { permissions: [{ id: 'p', action: 'shell', resources: [] }] })?.kind).toBe('asking')
    expect(activity(state({ messages: [msg('a', 5)] }))).toBeNull()
    // A mail that lands mid-turn leaves the reply where it was.
    expect(run([tool('running')], { messages: [msg('u', 1, { role: 'user' }), msg('a', 5, { running: true, parts: [tool('running')] }), msg('mail:m', 6, { role: 'user', kind: 'mail', parts: [] })] })?.kind).toBe('tool')
    expect([elapsed(8_400), elapsed(65_000), elapsed(3_720_000), elapsed(-5)]).toEqual(['8s', '1m 05s', '1h 02m', '0s'])
  })

  it('finds the stam mail notice in a combined text, and leaves other notices whole (S-296)', () => {
    const mail = '[stam] You have 1 unread mail. Read it with the stam `read_mail` tool and act on it. Latest unread:\n- m1 from cos: tests'
    const child = 'Child kid finished.\n\nThe build passed.'
    // Each wording is a mail notice on its own, and nothing else is.
    expect(mailNoticeSplit(mail)).toEqual([{ text: mail, mail: true }])
    expect(mailNoticeSplit('[stam] You have 3 unread mail. Unless stopping now would leave something broken or unsafe, stop')).toEqual([{ text: '[stam] You have 3 unread mail. Unless stopping now would leave something broken or unsafe, stop', mail: true }])
    expect(mailNoticeSplit('[stam] You have no unread mail')).toBeNull()
    expect(mailNoticeSplit('The mail says [stam] You have 2 unread mail.')).toBeNull()
    expect(mailNoticeSplit('[stam] Your spawn request was refused.')).toBeNull()
    // A child's notice joined before the mail prompt: the child's text stays one segment.
    expect(mailNoticeSplit(`${child}\n\n${mail}`)).toEqual([
      { text: child, mail: false },
      { text: mail, mail: true },
    ])
    // A code block with a blank line in the notice before the mail stays whole, fences and all.
    const code = 'Ran the check:\n\n```\nline one\n\nline two\n```'
    expect(mailNoticeSplit(`${code}\n\n${mail}`)).toEqual([
      { text: code, mail: false },
      { text: mail, mail: true },
    ])
    // Only the mail notice's own start splits: a mail wording inside the notice before it stays put.
    expect(mailNoticeSplit(`${mail.replace('1 unread', '2 unread')}\n\n${child}`)).toEqual([{ text: `${mail.replace('1 unread', '2 unread')}\n\n${child}`, mail: true }])
  })

  it('replaces a changed message in place and inserts a new one by time', () => {
    let s = applyEvent(null, { type: 'state', state: state({ messages: [msg('a', 1), msg('c', 3)] }) })!
    s = applyEvent(s, { type: 'message', message: msg('b', 2) })!
    s = applyEvent(s, { type: 'message', message: msg('a', 1, { parts: [{ type: 'text', text: 'A2' }] }) })!
    s = applyEvent(s, { type: 'message', message: msg('d', 4) })!
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(s.messages[0].parts[0]).toEqual({ type: 'text', text: 'A2' })
  })

  it('moves a message whose time changes, keeping equal times in arrival order', () => {
    // Streamed with the daemon's clock (5), then re-read with the harness's own time (2).
    let s = applyEvent(state({ messages: [msg('u1', 1), msg('a', 5)] }), { type: 'message', message: msg('u2', 4, { role: 'user' }) })!
    s = applyEvent(s, { type: 'message', message: msg('a', 2) })!
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a', 'u2'])
    s = applyEvent(s, { type: 'message', message: msg('b', 2) })!
    s = applyEvent(s, { type: 'message', message: msg('a', 2, { parts: [{ type: 'text', text: 'same time' }] }) })!
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a', 'b', 'u2'])
  })

  it('keeps mail where it came in: a turn splits there, and its newer parts go below it (S-255)', () => {
    // A Claude Code turn is one message that can run for hours. Mail that came in during it
    // first showed below it, then jumped above its start once the turn wrote on: out of sight.
    const mail = (id: string, at: number): ViewMessage => ({ id, role: 'user', kind: 'mail', at, parts: [] })
    const turn = (n: number): ViewMessage => msg('turn', 11, { parts: Array.from({ length: n }, (_, k): ViewPart => ({ type: 'text', text: `t${k}` })), marks: Array.from({ length: n }, (_, k) => 11 + k * 10) })
    const ids = (s: ViewState) => layout(s.messages).map((m) => m.id)
    let s = applyEvent(null, { type: 'state', state: state({ messages: [msg('p', 10, { role: 'user' }), turn(2)], older: 'p' }) })!
    s = applyEvent(s, { type: 'message', message: mail('m15', 15) })!
    s = applyEvent(s, { type: 'message', message: mail('m25', 25) })!
    expect(ids(s)).toEqual(['p', 'turn', 'm15', 'turn#1', 'm25'])
    s = applyEvent(s, { type: 'message', message: turn(4) })!
    expect(ids(s)).toEqual(['p', 'turn', 'm15', 'turn#1', 'm25', 'turn#2'])
    expect(layout(s.messages).at(-1)!.parts).toEqual([{ type: 'text', text: 't2' }, { type: 'text', text: 't3' }])
    s = applyEvent(s, { type: 'message', message: mail('m35', 35) })!
    s = prependOlder(s, { messages: [msg('o', 1, { role: 'user' }), mail('m5', 5), msg('oa', 2)], older: null }, 'p')
    expect(ids(s)).toEqual(['o', 'oa', 'm5', 'p', 'turn', 'm15', 'turn#1', 'm25', 'turn#2', 'm35', 'turn#3'])
    // A fresh state lays out the same, wherever the daemon put the mail.
    expect(ids({ ...s, messages: [...s.messages.filter((m) => m.kind === 'mail'), ...s.messages.filter((m) => m.kind !== 'mail')] })).toEqual(ids(s))
    // A message without part times (OpenCode, Codex) is one step: mail goes by time, running or not.
    s = applyEvent(state(), { type: 'state', state: state({ messages: [msg('r', 50, { running: true })] }) })!
    s = applyEvent(s, { type: 'message', message: mail('m55', 55) })!
    s = applyEvent(s, { type: 'message', message: msg('r', 50) })!
    s = applyEvent(s, { type: 'message', message: msg('r2', 60) })!
    expect(ids(s)).toEqual(['r', 'm55', 'r2'])
  })

  it('groups the conversation into turns, each opened by an input and running to the next (S-1483)', () => {
    const mail = (id: string, at: number, out = false): ViewMessage => ({ id, role: 'user', kind: 'mail', at, parts: [{ type: 'mail', id, from_id: 'x', from: 'x', subject: id, body: id, thread: id, read_at: null, ...(out ? { to: [{ id: 'cos', name: 'cos', read_at: null }] } : {}) }] })
    const notice = (id: string, at: number): ViewMessage => msg(id, at, { role: 'system', kind: 'notice', parts: [{ type: 'text', text: '[stam] You have 1 unread mail.' }] })
    const shape = (ms: ViewMessage[]) => turns(ms).map((t) => `${t.id}:${t.input?.id ?? '-'}>${t.items.map((m) => m.id).join(',')}`)
    // Before the first input, a turn with no input; Kim's message and a mail in each open one
    // (the mail notice after it joins the mail's turn); mail the agent sent, reasoning and tools, and other system rows are items.
    expect(shape([
      msg('a0', 1), msg('u', 2, { role: 'user' }), msg('a1', 3), mail('out', 4, true), msg('c', 5, { role: 'system', kind: 'compaction' }),
      mail('in', 6), notice('n', 7), msg('a2', 8, { parts: [{ type: 'reasoning', text: 'hm' }, { type: 'tool', id: 't', name: 'shell', status: 'done' }] }),
    ])).toEqual(['a0:->a0', 'u:u>a1,out,c', 'in:in>n,a2'])
    // A long turn split at a mail that came in during it (layout): its newer parts open under the mail.
    const long = msg('t', 11, { parts: [{ type: 'text', text: 't0' }, { type: 'text', text: 't1' }], marks: [11, 21] })
    expect(shape([msg('p', 10, { role: 'user' }), long, mail('m15', 15), mail('m18', 18, true)])).toEqual(['p:p>t', 'm15:m15>m18,t#1'])
    expect(turns([])).toEqual([])
    // The notice that only says mail came joins the mail's turn, before the agent answers; a
    // notice with more in it, or one after the agent answered, opens its own.
    const child = msg('cn', 9, { role: 'system', kind: 'notice', parts: [{ type: 'text', text: 'Child kid finished.\n\n[stam] You have 1 unread mail.' }] })
    expect(shape([mail('in', 6), notice('n', 7), msg('a', 8), notice('n2', 9)])).toEqual(['in:in>n,a', 'n2:n2>'])
    expect(shape([mail('in', 6), child, msg('a', 10)])).toEqual(['in:in>', 'cn:cn>a'])
    expect(shape([msg('u', 1, { role: 'user' }), notice('n', 2)])).toEqual(['u:u>', 'n:n>'])
    // What opened each turn, for its card.
    const fromKim: ViewMessage = { ...mail('k', 1), parts: [{ type: 'mail', id: 'k', from_id: 'human', from: 'human', subject: 'k', body: 'k', thread: 'k', read_at: null }] }
    expect(turns([msg('a0', 0), fromKim, mail('in', 2), notice('n', 3), msg('u', 4, { role: 'user' })]).map(turnKind)).toEqual(['start', 'human-mail', 'mail', 'human'])
    expect(turnKind({ id: 'n', input: notice('n', 1), items: [] })).toBe('notice')
  })

  it('keeps unchanged turns referentially equal when a stream event changes one (S-1566)', () => {
    const s0 = state({ messages: [msg('u1', 1, { role: 'user' }), msg('a1', 2), msg('u2', 3, { role: 'user' }), msg('a2', 4)] })
    const t0 = turns(s0.messages)
    const s1 = applyEvent(s0, { type: 'message', message: msg('a2', 4, { parts: [{ type: 'text', text: 'more' }] }) })!
    expect(turns(s1.messages)[0]).not.toBe(t0[0])
    const t1 = turns(s1.messages, t0)
    expect(t1[0]).toBe(t0[0])
    expect(t1[1]).not.toBe(t0[1])
    expect(t1[1].items[0].parts[0]).toEqual({ type: 'text', text: 'more' })
    // a new message after the last turn leaves the earlier ones alone too
    const s2 = applyEvent(s1, { type: 'message', message: msg('a3', 5) })!
    const t2 = turns(s2.messages, t1)
    expect(t2[0]).toBe(t0[0])
    expect(t2[1]).not.toBe(t1[1])
  })

  it('drops an older page read for a window a reconnect replaced', () => {
    const old = state({ messages: [msg('c', 3)], older: 'c' })
    const fresh = applyEvent(old, { type: 'state', state: state({ messages: [msg('x', 9)], older: 'x' }) })!
    const after = prependOlder(fresh, { messages: [msg('a', 1), msg('b', 2)], older: null }, 'c')
    expect(after).toBe(fresh)
    expect(after.older).toBe('x')
  })

  it('takes status events whole', () => {
    const s = applyEvent(state(), { type: 'status', running: true, permissions: [{ id: 'p1', action: 'shell', resources: ['ls'] }] })!
    expect(s.running).toBe(true)
    expect(s.permissions.map((p) => p.id)).toEqual(['p1'])
  })

  it('prepends older pages without duplicates and keeps them across a fresh state that joins up', () => {
    let s = state({ messages: [msg('c', 3), msg('d', 4)], older: 'c' })
    s = prependOlder(s, { messages: [msg('a', 1), msg('b', 2), msg('c', 3)], older: null }, 'c')
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(s.older).toBeNull()
    const again = applyEvent(s, { type: 'state', state: state({ messages: [msg('c', 3), msg('d', 4), msg('e', 5)], older: 'c' }) })!
    expect(again.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(again.older).toBeNull()
    // A fresh state that doesn't join up replaces everything.
    const gap = applyEvent(s, { type: 'state', state: state({ messages: [msg('x', 9)], older: 'x' }) })!
    expect(gap.messages.map((m) => m.id)).toEqual(['x'])
  })

  it('puts a permission right after the tool call that asked', () => {
    const parts = readingOrder([
      { type: 'tool', id: 't1', name: 'shell', status: 'done' }, { type: 'text', text: 'after' },
      { type: 'permission', id: 'p1', action: 'shell', resources: [], tool: 't1', status: 'once' },
      { type: 'permission', id: 'p2', action: 'edit', resources: [], status: 'asked' },
    ])
    expect(parts.map((p) => (p.type === 'text' || p.type === 'reasoning' ? p.text : p.id))).toEqual(['t1', 'p1', 'after', 'p2'])
  })

  it('folds each run of tool calls into one drawer, broken by text and by a permission', () => {
    const t = (id: string, status: 'done' | 'running' = 'done'): ViewPart => ({ type: 'tool', id, name: 'shell', input: { command: id }, status })
    const items = toolRuns([
      t('t1'), t('t2'), t('t3', 'running'), { type: 'text', text: 'between' }, t('t4'),
      { type: 'permission', id: 'p1', action: 'shell', resources: [], tool: 't5', status: 'asked' }, t('t5'),
    ])
    const shape = items.map((i) => (i.type === 'tools' ? i.tools.map((x) => x.id).join(',') : i.part.type))
    expect(shape).toEqual(['t1,t2,t3', 'text', 't4', 'permission', 't5'])
    // The drawer's latest call is the last one in its run; a drawer of one is still a drawer.
    const first = items[0]
    expect(first.type === 'tools' && first.tools[first.tools.length - 1].status).toBe('running')
    expect(items[4]).toEqual({ type: 'tools', tools: [t('t5')] })
  })

  it('finds waiting permissions no message holds, and summarises tool input', () => {
    const s = state({
      messages: [msg('a', 1, { parts: [{ type: 'permission', id: 'p1', action: 'shell', resources: [], status: 'asked' }] })],
      permissions: [{ id: 'p1', action: 'shell', resources: [] }, { id: 'p2', action: 'edit', resources: ['x'] }],
    })
    expect(loosePermissions(s).map((p) => p.id)).toEqual(['p2'])
    expect(toolLine({ command: 'ls -la', description: 'list' })).toBe('ls -la')
    expect(toolLine({ n: 3 })).toBe('{"n":3}')
    expect(toolLine(undefined)).toBe('')
  })
})

// --- The view, from a stubbed stream ----------------------------------------------------
const AGENT: Agent = { id: 'oc', name: 'builder', harness: 'opencode', lifecycle: 'active', activity: 'working', machine: 'alpha', cwd: '/w', created_at: '', updated_at: '', view: CAPS }
const MIXED: ViewMessage[] = [
  msg('u1', 1, { role: 'user', parts: [{ type: 'text', text: 'Summarise the **tests**.' }] }),
  msg('a1', 2, {
    parts: [
      { type: 'reasoning', text: 'Read the log first.' },
      { type: 'tool', id: 't1', name: 'shell', input: { command: 'npm test' }, output: '212 passed', status: 'done' },
      { type: 'text', text: `Done.\n\n> [!DONE]\n> All green.\n\n${F}metrics\nTests: 212/212 [success]\nSpent: $0.10\n${F}\n\n${F}checklist\n- [x] unit\n- [ ] e2e\n${F}` },
    ],
  }),
  msg('a2', 3, { running: true, parts: [{ type: 'tool', id: 't2', name: 'shell', input: { command: 'rm -rf build' }, status: 'running' }, { type: 'permission', id: 'p1', action: 'shell', resources: ['rm -rf build'], tool: 't2', status: 'asked' }] }),
]

let root: Root
let host: HTMLElement
let calls: { method: string; path: string; body?: unknown }[]
let push: (ev: unknown) => void
// The daemon refuses the interrupt when set (409), for the failed-stop test.
let refuseStop = false

function stub(initial: ViewState, older: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
    if (refuseStop && path === '/api/agents/oc/view/interrupt') return new Response(JSON.stringify({ error: 'the harness refused the stop' }), { status: 409 })
    if (path === '/api/agents/oc/view') {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder()
          push = (ev) => c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
          push({ type: 'state', state: initial })
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const page = path.startsWith('/api/agents/oc/view/history') ? older[new URL(path, 'http://x').searchParams.get('before') ?? ''] : undefined
    return new Response(JSON.stringify(page ?? {}), { status: 200 })
  }))
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

beforeEach(() => {
  calls = []
  refuseStop = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setData({ agents: [AGENT], machine: 'alpha' })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // jsdom has no layout: the mail renderer watches the theme (scrollTo is stubbed in test-setup.ts).
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('OwnView', () => {
  it('does not redraw the parts of unchanged turns on a stream event (S-1566)', async () => {
    const msgs = [msg('u1', 1, { role: 'user' }), msg('a1', 2, { parts: [{ type: 'text', text: 'first answer' }] }), msg('u2', 3, { role: 'user' }), msg('a2', 4, { parts: [{ type: 'text', text: 'second' }] })]
    stub(state({ messages: msgs }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    expect(host.textContent).toContain('first answer')
    const before = drawn.get('first answer')!
    await act(async () => { push({ type: 'message', message: msg('a2', 4, { parts: [{ type: 'text', text: 'second, more' }] }) }) })
    await flush()
    expect(host.textContent).toContain('second, more')
    expect(drawn.get('first answer')).toBe(before)
  })

  it('draws a mixed conversation with mail components, folded thinking and tools, and a permission card', async () => {
    stub(state({ running: true, messages: MIXED, permissions: [{ id: 'p1', action: 'shell', resources: ['rm -rf build'], message: 'a2', tool: 't2' }] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    const a1 = host.querySelector('[data-id="a1"]')!
    // Mail components render inside the assistant's message, through the mail renderer.
    expect(a1.querySelector('.mb-callout')).not.toBeNull()
    expect(a1.querySelector('.mb-metrics')).not.toBeNull()
    expect(a1.querySelector('.mb-checklist, .mb-check')).not.toBeNull()
    expect(host.querySelector('[data-id="u1"] strong')?.textContent).toBe('tests')
    // Thinking and tool calls start folded.
    const think = a1.querySelector<HTMLDetailsElement>('details.ov-reasoning')!
    expect(think.open).toBe(false)
    const tool = a1.querySelector<HTMLDetailsElement>('details.ov-tool')!
    expect(tool.open).toBe(false)
    expect(tool.querySelector('summary code')?.textContent).toBe('npm test')
    expect(tool.querySelector('.ov-tool-out')?.textContent).toBe('212 passed')
    // The permission card answers through the view.
    const allow = [...host.querySelectorAll<HTMLButtonElement>('.ov-perm button')].find((b) => b.textContent === 'Allow once')!
    await act(async () => { allow.click() })
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/agents/oc/view/permission', body: { request: 'p1', decision: 'once' } })
    // Stop interrupts the turn; the prompt input's send button calls it (Composer.tsx).
    await act(async () => { getLive('oc')!.stop!() })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/agents/oc/view/interrupt' })
    // The answer arrives on the stream: the card shows the decision and loses its buttons.
    await act(async () => {
      push({ type: 'message', message: { ...MIXED[2], running: false, parts: [MIXED[2].parts[0], { ...MIXED[2].parts[1], status: 'once' }] } })
      push({ type: 'status', running: false, permissions: [] })
    })
    await flush()
    expect(host.querySelector('[data-id="a2"] .ov-perm-status')?.textContent).toBe('Allowed once')
    expect(host.querySelector('[data-id="a2"] .ov-perm button')).toBeNull()
    expect(getLive('oc')?.running).toBe(false)
  })

  it('stays read-only where the harness takes nothing from the view', async () => {
    stub(state({ harness: 'claude', capabilities: { can_stream: false, can_send: false, can_interrupt: false, can_approve: false }, running: true, messages: MIXED, permissions: [{ id: 'p1', action: 'shell', resources: [], message: 'a2' }] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    expect(host.querySelector('.ov-perm button')).toBeNull()
    expect(host.querySelector('.ov-perm-status')?.textContent).toBe('Answer it in the terminal.')
    // Nothing to stop with: the live state has no Stop, so the prompt input's send button stays.
    expect(getLive('oc')?.stop).toBeNull()
  })

  it('clears a failed stop when the turn ends, so the next turn starts clean', async () => {
    refuseStop = true
    stub(RUNNING([{ type: 'text', text: 'x' }]))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    await act(async () => { getLive('oc')!.stop!() })
    await flush()
    expect(getLive('oc')?.stopError).toBe('the harness refused the stop')
    await act(async () => { push({ type: 'status', running: false, permissions: [] }) })
    await flush()
    expect(getLive('oc')?.stopError).toBe('')
    await act(async () => { push({ type: 'status', running: true, permissions: [] }) })
    await flush()
    expect(getLive('oc')?.stopError).toBe('')
  })

  it('shows a message that arrives after a later one, in time order', async () => {
    stub(state({ messages: [msg('a', 1)] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    await act(async () => { push({ type: 'message', message: msg('c', 3) }) })
    await flush()
    await act(async () => { push({ type: 'message', message: msg('b', 2, { role: 'user' }) }) })
    await flush()
    expect([...host.querySelectorAll('.ov-msg')].map((m) => (m as HTMLElement).dataset.id)).toEqual(['a', 'b', 'c'])
  })

  it('reads older messages and puts them first', async () => {
    stub(state({ messages: [msg('c', 3)], older: 'c' }), { c: { messages: [msg('a', 1), msg('b', 2)], older: null } })
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('.ov-older')!.click() })
    await flush()
    expect(calls.some((c) => c.path === '/api/agents/oc/view/history?before=c&limit=50')).toBe(true)
    expect([...host.querySelectorAll('.ov-msg')].map((m) => (m as HTMLElement).dataset.id)).toEqual(['a', 'b', 'c'])
    expect(host.querySelector('.ov-older')).toBeNull()
    expect(host.querySelector('.ov-start')?.textContent).toBe('Start of the conversation')
  })

  it('shows mail to the agent as a mail sheet with its read state, folded when long, opening its thread', async () => {
    const body = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the brief.`).join('\n')
    const mail = (read_at: number | null): ViewMessage => ({ id: 'mail:m1', role: 'user', kind: 'mail', at: Date.parse('2026-10-12T09:05:00'), parts: [{ type: 'mail', id: 'm1', from_id: 'human', from: 'human', subject: 'Fix the login', body, thread: 'th1', read_at }] })
    stub(state({ messages: [msg('a', 1), mail(null)] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    const card = () => host.querySelector('[data-id="mail:m1"]')!
    expect(card().classList.contains('ov-mail')).toBe(true)
    expect(card().querySelector('.who')?.textContent).toBe('you')
    expect(card().querySelector('.ov-mail-subj')?.textContent).toBe('Fix the login')
    expect(card().querySelector('.ov-mail-read')?.textContent).toBe('Unread')
    expect(card().querySelector('time')?.textContent).toBe('09:05')
    // A long body starts folded; Show all opens it.
    expect(card().querySelector('.ov-mail-snip')?.textContent).toMatch(/^Line 1 of the brief\. Line 2/)
    expect(card().querySelector('.ov-mail-body')).toBeNull()
    const showAll = [...card().querySelectorAll<HTMLButtonElement>('.ov-mail-foot button')].find((b) => b.textContent === 'Show all')!
    await act(async () => { showAll.click() })
    expect(card().querySelector('.ov-mail-snip')).toBeNull()
    expect(card().querySelector('.ov-mail-body')?.textContent).toContain('Line 8 of the brief.')
    // The agent reads it: the daemon sends the message again with its read time.
    await act(async () => { push({ type: 'message', message: mail(Date.parse('2026-10-12T09:07:00')) }) })
    await flush()
    expect(card().querySelector('.ov-mail-read')?.textContent).toBe('Read 09:07')
    expect(card().querySelector('.ov-mail-read.unread')).toBeNull()
    // Open thread shows the thread.
    const openThread = [...card().querySelectorAll<HTMLButtonElement>('.ov-mail-foot button')].find((b) => b.textContent === 'Open thread')!
    await act(async () => { openThread.click() })
    expect(currentWorld()).toBe('t:th1')
  })

  it('marks mail from you and to you with a rail and chip, mail between agents not at all, and shows the mail type (S-1482)', async () => {
    const part = (id: string, from_id: string, to: string, extra: object = {}) => ({ id: `mail:${id}`, role: 'user' as const, kind: 'mail', at: Date.parse('2026-10-12T09:05:00'), parts: [{ type: 'mail' as const, id, from_id, from: from_id, subject: id, body: id, thread: id, read_at: null, to: [{ id: to, name: to, read_at: null }], ...extra }] })
    stub(state({ messages: [msg('a', 1), part('m1', 'human', 'oc'), part('m2', 'oc', 'human', { kind: 'update', health: 'on_track' }), part('m3', 'cos', 'oc', { kind: 'ask' }), part('m4', 'cos', 'oc')] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    const card = (id: string) => host.querySelector(`[data-id="mail:${id}"] .conv-mail`)!
    expect(card('m1').classList.contains('from-you')).toBe(true)
    expect(card('m1').querySelector('.you-chip')?.textContent).toBe('From you')
    expect(card('m2').classList.contains('to-you')).toBe(true)
    expect(card('m2').querySelector('.who')?.textContent).toBe('To you')
    expect(card('m2').querySelector('.you-chip')).toBeNull() // the header already says it
    expect(card('m1').querySelector('.you-chip.you-from')?.textContent).toBe('From you')
    expect(card('m2').querySelector('.itsa-health .badge')?.textContent).toBe('Update')
    expect(card('m3').querySelector('.itsa-health .badge.warn')?.textContent).toBe('Asks you')
    expect(card('m4').querySelector('.you-chip')).toBeNull()
    expect(card('m4').className).not.toMatch(/-you/)
  })

  it('shows mail the agent sent on its side, where it was sent in a split turn, with whether its recipients read it (S-255)', async () => {
    const at = Date.parse('2026-10-12T09:05:00')
    const to = (a: number | null, b: number | null) => [{ id: 'human', name: 'human', read_at: a }, { id: 'cos', name: 'cos', read_at: b }]
    const sent = (a: number | null, b: number | null): ViewMessage => ({ id: 'mail:m2', role: 'user', kind: 'mail', at, parts: [{ type: 'mail', id: 'm2', from_id: 'oc', from: 'oc', subject: 'Branch ready', body: 'Two commits.', thread: 'th2', read_at: null, to: to(a, b) }] })
    const tool = (id: string): ViewPart => ({ type: 'tool', id, name: id, input: {}, status: 'done' })
    const turn = msg('t', at - 60_000, { parts: [tool('send_mail'), tool('Bash')], marks: [at - 1000, at + 1000] })
    stub(state({ messages: [turn, sent(null, null)] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    expect([...host.querySelectorAll<HTMLElement>('.ov-msg')].map((m) => m.dataset.id)).toEqual(['t', 'mail:m2', 't#1'])
    const card = () => host.querySelector('[data-id="mail:m2"]')!
    expect(card().classList.contains('out')).toBe(true)
    expect(card().querySelector('.who')?.textContent).toBe('To you, cos')
    expect(card().querySelector('.ov-mail-read')?.textContent).toBe('Unread')
    await act(async () => { push({ type: 'message', message: sent(at + 60_000, null) }) })
    await flush()
    expect(card().querySelector('.ov-mail-read')?.textContent).toBe('Read by 1 of 2')
    await act(async () => { push({ type: 'message', message: sent(at + 60_000, at + 120_000) }) })
    await flush()
    expect(card().querySelector('.ov-mail-read')?.textContent).toBe('Read 09:07')
  })

  // S-278: a running Claude turn, as alpha's live view sends it: the turn grows by message
  // events, and mail in and out arrives between them; each mail stays where it came.
  it('keeps mail where it came in a running turn that grows by live events (S-278)', async () => {
    const T = Date.parse('2026-10-13T00:06:33Z')
    const text = (k: number): ViewPart => ({ type: 'text', text: `p${k}` })
    const turn = (n: number): ViewMessage => msg('t', T, { running: true, parts: Array.from({ length: n }, (_, k) => text(k)), marks: Array.from({ length: n }, (_, k) => T + k * 60_000) })
    const mail = (id: string, at: number, out = false): ViewMessage => ({ id: `mail:${id}`, role: 'user', kind: 'mail', at, parts: [{ type: 'mail', id, from_id: out ? 'oc' : 'cos', from: out ? 'oc' : 'cos', subject: id, body: id, thread: id, read_at: null, ...(out ? { to: [{ id: 'cos', name: 'cos', read_at: null }] } : {}) }] })
    stub(state({ harness: 'claude', running: true, messages: [msg('u', T - 1000, { role: 'user' }), turn(2), mail('a', T + 30_000)] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    const order = () => [...host.querySelectorAll<HTMLElement>('.ov-msg')].map((m) => m.dataset.id)
    expect(order()).toEqual(['u', 't', 'mail:a', 't#1'])
    await act(async () => { push({ type: 'message', message: turn(3) }) })
    await act(async () => { push({ type: 'message', message: mail('b', T + 150_000, true) }) })
    await act(async () => { push({ type: 'message', message: turn(5) }) })
    await flush()
    expect(order()).toEqual(['u', 't', 'mail:a', 't#1', 'mail:b', 't#2'])
    // Each row names its turn: the mail in opens one, the agent's own mail stays in it (S-1483).
    expect([...host.querySelectorAll<HTMLElement>('.ov-msg')].map((m) => m.dataset.turn)).toEqual(['u', 'u', 'mail:a', 'mail:a', 'mail:a', 'mail:a'])
    expect(host.querySelector('[data-id="t#2"]')?.textContent).toContain('p4')
    // Each turn is one section: its input a card on top, the agent's rows below (S-1483).
    const sections = [...host.querySelectorAll<HTMLElement>('section.ov-turn')]
    expect(sections.map((x) => `${x.dataset.turn}:${x.className}`)).toEqual(['u:ov-turn human', 'mail:a:ov-turn mail'])
    expect([...sections[1].querySelectorAll<HTMLElement>('.ov-turn-in > .ov-msg')].map((m) => m.dataset.id)).toEqual(['mail:a'])
    expect(sections[1].querySelector('.conv-mail .to')).toBeNull() // only to this agent: no "to self" (S-1566)
    expect(sections[1].querySelector('[data-id="mail:b"] .conv-mail.out .who')?.textContent).toBe('To cos')
    expect(sections[0].querySelector('.ov-user .who')?.textContent).toBe('You')
  })

  it('folds a stam mail notice to one line, with the full text opening on a click (S-296)', async () => {
    const T = Date.parse('2026-10-13T07:13:00Z')
    const full = '[stam] You have 2 unread mail. Unless stopping now would leave something broken or unsafe, stop what you are doing, read your inbox with the stam `read_mail` tool, and then continue your work. Latest unread:\n- m1 from cos: tests'
    const other = '[stam] Your spawn request was refused.'
    const child = 'Child kid finished the build.'
    stub(state({ harness: 'claude', messages: [msg('n', T, { role: 'system', kind: 'notice', parts: [{ type: 'text', text: full }] }), msg('o', T + 1, { role: 'system', kind: 'notice', parts: [{ type: 'text', text: other }] }), msg('c', T + 2, { role: 'system', kind: 'notice', parts: [{ type: 'text', text: `${child}\n\n${full}` }] }), msg('f', T + 3, { role: 'system', kind: 'notice', parts: [{ type: 'text', text: `Ran:\n\n\`\`\`\nline one\n\nline two\n\`\`\`\n\n${full}` }] })] }))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    const row = host.querySelector<HTMLElement>('[data-id="n"]')!
    const toggle = row.querySelector<HTMLButtonElement>('.ov-mail-notice button')!
    expect(toggle.textContent).toBe('[stam] You have mail')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(row.textContent).not.toContain('Unless stopping')
    // Other notices keep their full text.
    expect(host.querySelector('[data-id="o"]')?.textContent).toContain(other)
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('.ov-text')?.textContent).toContain('Unless stopping now')
    // A combined notice: the child's text shows as it is, and only the mail folds.
    const combined = host.querySelector<HTMLElement>('[data-id="c"]')!
    expect(combined.textContent).toContain(child)
    expect(combined.querySelector('.ov-mail-notice')).not.toBeNull()
    expect(combined.querySelectorAll('.ov-mail-notice button')).toHaveLength(1)
    expect(combined.querySelector('.ov-mail-notice button')?.textContent).toBe('[stam] You have mail')
    expect(combined.querySelector('.ov-mail-notice .ov-text')).toBeNull()
    // A code block with a blank line before the mail stays one block, so its second line renders as code.
    // A notice of several lines is compact too (S-1483): its first line, the rest on a click.
    const fenced = host.querySelector<HTMLElement>('[data-id="f"]')!
    const more = fenced.querySelector<HTMLButtonElement>('.ov-notice button')!
    expect(more.textContent).toBe('Ran:')
    expect(fenced.querySelector('pre')).toBeNull()
    await act(async () => { more.click() })
    expect(fenced.querySelector('pre')?.textContent).toContain('line two')
    expect(fenced.querySelectorAll('.ov-mail-notice button')).toHaveLength(1)
  })

  const RUNNING = (parts: ViewPart[]) => state({ running: true, messages: [msg('u1', 1, { role: 'user' }), msg('a1', Date.now() - 12_000, { running: true, parts })] })
  const media = (on: string[]) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on.some((x) => q.includes(x)), addEventListener() {}, removeEventListener() {} }))

  it('shows a working indicator while the turn runs, saying what it does, and drops it when the turn ends', async () => {
    stub(RUNNING([{ type: 'tool', id: 't1', name: 'shell', input: { command: 'npm test' }, status: 'running' }]))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    const work = () => host.querySelector<HTMLElement>('.ov-work')
    expect(work()?.dataset.kind).toBe('tool')
    expect(work()?.querySelector('[role=status]')?.textContent).toBe('Running shell: npm test')
    expect(work()?.querySelector('.ov-work-time')?.textContent).toMatch(/^1[2-3]s$/)
    expect(work()?.querySelectorAll('.ov-work-dots i').length).toBe(3)
    expect(work()?.classList.contains('still')).toBe(false)
    // The indicator sits after the conversation, where the next output will appear.
    expect(host.querySelector('.ov-col')!.lastElementChild).toBe(work())
    // Thinking, then the turn ends.
    await act(async () => { push({ type: 'message', message: msg('a1', Date.now() - 12_000, { running: true, parts: [{ type: 'reasoning', text: 'Hmm.' }] }) }) })
    await flush()
    expect(work()?.dataset.kind).toBe('thinking')
    expect(work()?.textContent).toMatch(/^Thinking/)
    await act(async () => { push({ type: 'status', running: false, permissions: [] }) })
    await flush()
    expect(work()).toBeNull()
  })

  it('holds the indicator still under reduced motion', async () => {
    media(['prefers-reduced-motion'])
    stub(RUNNING([{ type: 'text', text: 'Writing it up' }]))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    expect(host.querySelector('.ov-work.still')?.textContent).toMatch(/^Writing/)
  })

  it('drops the bar on a phone: the state goes to the tab icon, and Stop to the prompt input', async () => {
    media(['max-width'])
    // The agent list still says idle; the view knows better while it's open.
    setData({ agents: [{ ...AGENT, activity: 'idle' }], machine: 'alpha' })
    stub(RUNNING([{ type: 'tool', id: 't1', name: 'shell', input: { command: 'npm test' }, status: 'running' }]))
    const head = document.createElement('div')
    document.body.append(head)
    const headRoot = createRoot(head)
    await act(async () => { root.render(<OwnView id="oc" />); headRoot.render(<Glyph agent={{ ...AGENT, activity: 'idle' }} />) })
    await flush()
    expect(host.querySelector<HTMLElement>('.ov-work')?.dataset.kind).toBe('tool')
    expect(head.querySelector<HTMLElement>('.glyph')?.dataset.state).toBe('working')
    expect(getLive('oc')?.running).toBe(true)
    await act(async () => { getLive('oc')!.stop!() })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/agents/oc/view/interrupt' })
    // A permission: the tab icon says blocked, and the indicator turns into a still warning.
    await act(async () => { push({ type: 'status', running: true, permissions: [{ id: 'p1', action: 'shell', resources: ['ls'] }] }) })
    await flush()
    expect(head.querySelector<HTMLElement>('.glyph')?.dataset.state).toBe('blocked')
    expect(host.querySelector('.ov-work.asking')?.textContent).toBe('Waiting for your answer')
    expect(host.querySelector('.ov-perm button')?.textContent).toBe('Allow once')
    // The turn ends: the icon goes back to the agent list's word.
    await act(async () => { push({ type: 'status', running: false, permissions: [] }) })
    await flush()
    expect(getLive('oc')?.running).toBe(false)
    expect(head.querySelector<HTMLElement>('.glyph')?.dataset.state).toBe('idle')
    // Closing the view takes its word away.
    act(() => root.unmount())
    expect(getLive('oc')).toBeUndefined()
    root = createRoot(host)
    act(() => headRoot.unmount())
    head.remove()
  })

  it('offers no Stop where the harness can\'t interrupt', async () => {
    stub({ ...RUNNING([{ type: 'text', text: 'x' }]), capabilities: { ...CAPS, can_interrupt: false } })
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    expect(host.querySelector('.ov-work')).not.toBeNull()
    expect(getLive('oc')?.running).toBe(true)
    expect(getLive('oc')?.stop).toBeNull()
  })

  it('says why when the agent has no view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: "stam's own view doesn't support codex yet; use the terminal" }), { status: 409 })))
    await act(async () => { root.render(<OwnView id="oc" />) })
    await flush()
    expect(host.querySelector('.ov-empty')?.textContent).toMatch(/doesn't support codex yet/)
  })
})
