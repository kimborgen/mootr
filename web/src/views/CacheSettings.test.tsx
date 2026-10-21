// @vitest-environment jsdom
// Settings › Prompt caching (S-2239): the timers read the live settings, the agents table lists the
// Claude Code agents with their detected window, and a subscription agent on 5-minute caches warns.
// S-2240: with Settings' controls, the timers and the harness settings passed on at launch are edited by path.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CacheSettings, spilled, type CacheAgent, type CacheEdit } from './CacheSettings'
import { CACHE_FACTS, HARNESS_SETTINGS, cacheTimers, harnessValue } from '../cache-facts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = (name: string, o: Partial<CacheAgent> = {}): CacheAgent => ({ id: name, name, machine: 'm1', harness: 'claude', model: null, lifecycle: 'active', account: 'max', paid: false, ttl: '1h', ttl_at: new Date().toISOString(), ...o })
const SETTINGS = { rest: { enabled: true, afterMinutes: 20, graceMinutes: 2 }, idleCompaction: { enabled: true, idleMinutes: 50 } }

let host: HTMLDivElement
let root: Root
let reply: { agents: CacheAgent[]; offline: string[] }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  reply = { agents: [], offline: [] }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) })))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

async function show(s: Record<string, unknown> = SETTINGS, edit?: CacheEdit) {
  await act(async () => { root.render(<CacheSettings s={s} edit={edit} />) })
}
// Stand-ins for Settings' controls: each marks the path it would save and what it was given.
const EDIT: CacheEdit = {
  choice: (path, options) => <span data-edit={path} data-kind="choice">{options.map((o) => o.label).join('|')}</span>,
  num: (path, o) => <span data-edit={path} data-kind="num">{`${o.unit} ${o.min}-${o.max ?? ''} ${o.dflt ?? ''} ${o.nullable ? 'nullable' : ''}`}</span>,
}
const edits = () => Object.fromEntries([...host.querySelectorAll('[data-edit]')].map((e) => [e.getAttribute('data-edit'), `${e.getAttribute('data-kind')}: ${e.textContent}`]))
const rowText = (name: string) => host.querySelector(`[data-cache-agent="${name}"]`)?.textContent ?? null

describe('cacheTimers', () => {
  it('reads each timer from its settings path', () => {
    expect(cacheTimers(SETTINGS).map((t) => [t.path, t.value])).toEqual([
      ['rest.afterMinutes', '20 minutes'],
      ['rest.graceMinutes', '2 minutes'],
      ['idleCompaction.idleMinutes', '50 minutes'],
    ])
    expect(cacheTimers({ rest: { enabled: true, afterMinutes: 30, graceMinutes: 1 }, idleCompaction: { enabled: true, idleMinutes: 45 } }).map((t) => t.value)).toEqual(['30 minutes', '1 minute', '45 minutes'])
  })
  it('takes the daemon defaults for what settings.json leaves out', () => {
    expect(cacheTimers({}).map((t) => t.value)).toEqual(['20 minutes', '2 minutes', '50 minutes'])
    expect(cacheTimers({ rest: { afterMinutes: 30 } }).map((t) => t.value)).toEqual(['30 minutes', '2 minutes', '50 minutes'])
  })
  it('says Off when the feature is off', () => {
    expect(cacheTimers({ rest: { enabled: false, afterMinutes: 20 }, idleCompaction: { enabled: false, idleMinutes: 50 } }).map((t) => t.value)).toEqual(['Off', 'Off', 'Off'])
  })
})

describe('harnessValue', () => {
  const at = (path: string) => HARNESS_SETTINGS.find((h) => h.path === path)!
  it('reads a cleared or missing key as the harness default', () => {
    expect(harnessValue({}, at('harness.claude.promptCacheTtl'))).toBe('Default')
    expect(harnessValue({ harness: { claude: { promptCacheTtl: null } } }, at('harness.claude.promptCacheTtl'))).toBe('Default')
    expect(harnessValue({}, at('harness.claude.idleCompaction'))).toBe('Off')
    expect(harnessValue({}, at('harness.codex.model_auto_compact_token_limit'))).toBe('Default')
  })
  it('names a set value', () => {
    const s = { harness: { claude: { promptCacheTtl: '5m', idleCompaction: true, autoCompactWindow: 400000 }, codex: { model_auto_compact_token_limit: 200000 } } }
    expect(harnessValue(s, at('harness.claude.promptCacheTtl'))).toBe('5 minutes')
    expect(harnessValue(s, at('harness.claude.idleCompaction'))).toBe('On')
    expect(harnessValue(s, at('harness.claude.autoCompactWindow'))).toBe('400,000 tokens')
    expect(harnessValue(s, at('harness.codex.model_auto_compact_token_limit'))).toBe('200,000 tokens')
  })
})

describe('CACHE_FACTS', () => {
  it('covers each harness once, each with a source', () => {
    expect(CACHE_FACTS.map((f) => f.harness)).toEqual(['claude', 'codex', 'opencode'])
    for (const f of CACHE_FACTS) expect(f.sources.length).toBeGreaterThan(0)
  })
})

describe('spilled', () => {
  it('is a subscription Claude agent writing 5-minute caches', () => {
    expect(spilled(agent('a', { ttl: '5m' }))).toBe(true)
    expect(spilled(agent('a', { ttl: '5m', paid: true }))).toBe(false)
    expect(spilled(agent('a', { ttl: '1h' }))).toBe(false)
    expect(spilled(agent('a', { ttl: '5m', harness: 'codex' }))).toBe(false)
  })
})

describe('CacheSettings', () => {
  it('shows the live timers', async () => {
    await show({ ...SETTINGS, idleCompaction: { enabled: true, idleMinutes: 42 } })
    expect(host.querySelector('[data-cache-timers]')!.textContent).toContain('42 minutes')
  })
  it('lists Claude Code agents with their window, spilled ones first, and warns', async () => {
    reply = { agents: [agent('a-fine'), agent('b-spilled', { ttl: '5m' }), agent('c-api', { ttl: '5m', paid: true }), agent('d-new', { ttl: null, ttl_at: null }), agent('e-codex', { harness: 'codex', ttl: null })], offline: ['far'] }
    await show()
    const names = [...host.querySelectorAll('[data-cache-agent]')].map((r) => r.getAttribute('data-cache-agent'))
    expect(names).toEqual(['b-spilled', 'a-fine', 'c-api', 'd-new'])
    expect(rowText('b-spilled')).toContain('5 minutes, credits')
    expect(rowText('c-api')).toContain('5 minutes')
    expect(rowText('c-api')).not.toContain('credits')
    expect(rowText('d-new')).toContain('Not measured yet')
    expect(host.querySelector('[data-cache-spilled]')!.textContent).toContain('b-spilled writes 5-minute caches on a subscription')
    expect(host.textContent).toContain('Not reachable: far.')
    expect([...host.querySelectorAll('.cache-agents th')].map((th) => th.textContent)).toEqual(['Agent', 'Cache window', 'Since'])
  })
  it('says a peer on an older release does not report yet, apart from one out of reach', async () => {
    reply = { agents: [agent('a-fine')], offline: ['far'], outdated: ['old'] } as typeof reply
    await show()
    expect(host.textContent).toContain("old doesn't report cache windows yet")
    expect(host.textContent).toContain('Not reachable: far.')
    expect(host.textContent).not.toContain('Not reachable: far, old')
  })
  it('shows no warning when no agent has spilled', async () => {
    reply = { agents: [agent('a-fine'), agent('c-api', { ttl: '5m', paid: true })], offline: [] }
    await show()
    expect(host.querySelector('[data-cache-spilled]')).toBeNull()
  })
  it('says so when there are no Claude Code agents', async () => {
    await show()
    expect(host.textContent).toContain('No Claude Code agents are running.')
  })
  it('shows the harness settings read-only, and says they apply at the next launch', async () => {
    await show({ ...SETTINGS, harness: { claude: { promptCacheTtl: '1h' }, codex: {} } })
    expect(host.querySelector('[data-edit]')).toBeNull()
    expect(host.querySelector('[data-harness-setting="harness.claude.promptCacheTtl"]')!.textContent).toContain('1 hour')
    expect(host.querySelector('[data-harness-setting="harness.codex.model_auto_compact_token_limit"]')!.textContent).toContain('Default')
    expect([...host.querySelectorAll('[data-harness-settings]')].map((e) => e.getAttribute('data-harness-settings'))).toEqual(['claude', 'codex'])
    expect(host.querySelector('[data-harness-next-launch]')!.textContent).toContain("next launch")
  })
  it('edits each timer and harness setting by its path', async () => {
    await show(SETTINGS, EDIT)
    expect(edits()).toEqual({
      'rest.afterMinutes': 'num: minutes 1- 20 ',
      'rest.graceMinutes': 'num: minutes 1- 2 ',
      'idleCompaction.idleMinutes': 'num: minutes 1- 50 ',
      'harness.claude.promptCacheTtl': 'choice: Default|5 minutes|1 hour',
      'harness.claude.subagentPromptCacheTtl': 'choice: Default|5 minutes|1 hour',
      'harness.claude.idleCompaction': 'choice: Off|On',
      'harness.claude.autoCompactWindow': 'num: tokens 100000-1000000  nullable',
      'harness.codex.model_auto_compact_token_limit': 'num: tokens 1-  nullable',
    })
  })
  it('keeps a timer whose feature is off read-only', async () => {
    await show({ rest: { enabled: false }, idleCompaction: { enabled: true, idleMinutes: 45 } }, EDIT)
    expect(Object.keys(edits()).filter((p) => !p.startsWith('harness.'))).toEqual(['idleCompaction.idleMinutes'])
    expect(host.querySelector('[data-cache-timers]')!.textContent).toContain('Off')
  })
})
