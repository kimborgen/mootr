// The stories page runs with no daemon: this seeds the store (store.ts) with invented data and
// stubs the network api.ts reaches, so the page makes no /api request at all. Every name here
// is made up (fixture-*, example.com); nothing comes from a live database.
import { resetToolSummaries } from '../mail/tool-summaries'
import { resetOutbox } from '../outbox'
import { resetReq } from '../req/store'
import { getPolled, setData, type Data } from '../store'
import type { Agent, Wait } from '../types'
import { isPending, isRaw, isReply, isSse, type StoryState } from './types'

const T0 = '2026-10-01T09:00:00.000Z'
const inMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString()

export function agent(o: Partial<Agent> & { id: string; name: string }): Agent {
  return { harness: 'claude', model: 'claude-opus-5-5', lifecycle: 'active', activity: 'idle', machine: 'fixture-machine', cwd: '/home/fixture/project', parents: [], created_at: T0, updated_at: T0, ...o }
}
const wait = (kind: string, o: Partial<Wait> = {}): Wait => ({ id: `w-${kind}`, kind, since: T0, source: 'wait_for', ...o })

export const AGENTS: Agent[] = [
  agent({ id: 'fx-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true, activity: 'idle' }),
  agent({ id: 'fx-dev', name: 'fixture-dev', role: 'developer', parents: ['fx-cos'], activity: 'working', context_tokens: 210000, context_level: 1 }),
  agent({ id: 'fx-review', name: 'fixture-review', role: 'reviewer', harness: 'codex', model: 'gpt-6.1-sol', parents: ['fx-cos'], activity: 'waiting', waits: [wait('timer', { until: inMinutes(4) })] }),
  agent({ id: 'fx-ops', name: 'fixture-ops', role: 'developer', harness: 'opencode', model: 'openrouter/fixture/flash', parents: ['fx-cos'], activity: 'blocked', pending_requests: 1, waits: [wait('human', { target: 'perm-1' })] }),
  agent({ id: 'fx-wait', name: 'fixture-waiter', harness: 'claude', parents: ['fx-cos'], activity: 'waiting', waits: [wait('agent', { target: 'fx-cos' })] }),
  agent({ id: 'fx-err', name: 'fixture-broken', harness: 'codex', activity: 'errored' }),
  agent({ id: 'fx-paused', name: 'fixture-paused', harness: 'opencode', lifecycle: 'paused', activity: null }),
  agent({ id: 'fx-old', name: 'fixture-retired', lifecycle: 'shut_down', activity: null }),
]
export const byName = (name: string) => AGENTS.find((a) => a.name === name)!

// What the stub answers, by "METHOD /path" (or "METHOD /path?query", which wins). A state adds
// its own (StoryState.routes); anything else gets a 404 naming the route, so a story that needs
// a new route says so instead of reaching a daemon.
const ROUTES: Record<string, unknown> = {
  'GET /api/health': { machine: 'fixture-machine' },
  'GET /api/agents': AGENTS,
  'GET /api/shells': [],
  // The repos the diff API serves (S-1533): none, unless a state sets them with resetDiffRepos.
  'GET /api/diff/repos': { repos: [] },
  // Showing a thread marks its mail read (ThreadView).
  'POST /api/agents/human/read': { ok: true },
  // Tool-call summaries (S-1481) are off unless a state seeds them.
  'POST /api/tool-summaries': { enabled: false, summaries: {}, pending: [] },
  // The secret store's listing (Settings › Model providers, S-2115): empty unless a state sets it.
  'GET /api/secrets': { secrets: [] },
  // The Needs you list (S-3831): empty unless a state sets its asks (NeedsYouList.stories.tsx has a long one).
  'GET /api/asks': [],
}

export interface StoriesDebug { apiCalls: string[] }
declare global { interface Window { stamStories?: StoriesDebug } }

const isApi = (url: string) => { try { return new URL(url, location.href).pathname.startsWith('/api') } catch { return false } }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let installed = false
export function installFixtures(): void {
  if (installed) return
  installed = true
  const debug: StoriesDebug = { apiCalls: [] }
  window.stamStories = debug
  const real = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isApi(url)) return real(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const u = new URL(url, location.href)
    const key = `${method} ${u.pathname}`, full = key + u.search
    debug.apiCalls.push(full)
    const hit = full in routes ? routes[full] : key in routes ? routes[key] : undefined
    if (hit === undefined) return json(404, { error: `stories: no fixture for ${full}` })
    if (isPending(hit)) return new Promise<Response>(() => {})
    if (isSse(hit)) {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({ start: (c) => { for (const ev of hit.events) c.enqueue(enc.encode(`${hit.event ? `event: ${hit.event}\n` : ''}data: ${JSON.stringify(ev)}\n\n`)) } })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (isRaw(hit)) return new Response(hit.body, { status: 200, headers: { 'content-type': hit.type, ...hit.headers } })
    return isReply(hit) ? json(hit.status, hit.body) : json(200, hit)
  }) as typeof fetch
  // A terminal or a live stream would open a socket to the daemon; on this page it never connects.
  const RealWS = window.WebSocket
  window.WebSocket = class extends EventTarget {
    readonly readyState = 3
    constructor(url: string | URL) { super(); if (!isApi(String(url))) return new RealWS(url) as unknown as this; debug.apiCalls.push(`WS ${url}`) }
    send() {}
    close() {}
  } as unknown as typeof WebSocket
  initial = getPolled()
  applyState()
}

// The store as it was before any fixture, and the routes in force.
let initial: Data
let routes: Record<string, unknown> = ROUTES
const SEED: Partial<Data> = { agents: AGENTS, machine: 'fixture-machine', booted: true, loaded: { agents: true, mail: true, itsas: true } }

// Resets the store and the routes to the shared fixtures, then applies a state's own data,
// routes, and setup. Frames call it before drawing their state; the tests between states.
export function applyState(st: Pick<StoryState, 'data' | 'routes' | 'setup'> = {}): void {
  routes = { ...ROUTES, ...st.routes }
  resetReq()
  resetOutbox()
  resetToolSummaries()
  setData({ ...initial, ...SEED, ...st.data })
  st.setup?.()
}
