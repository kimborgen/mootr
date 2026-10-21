// The daemon's token and API. `stam web` links carry the token in the URL's hash; it is
// kept per browser. Through `tailscale serve`, the owner's login authenticates instead.

import { dropToken, offerLogin, onLoopback } from './local-login'

export const hash = new URLSearchParams(location.hash.slice(1))

function readToken(): string {
  let t = hash.get('token')
  if (t) {
    try { localStorage.setItem('stamToken', t) } catch {}
    history.replaceState(null, '', location.pathname)
  }
  try { t = t || localStorage.getItem('stamToken') } catch {}
  return t || __DEV_TOKEN__ || ''
}
export const token = readToken()

// A refusal from the daemon. `status` tells a hard refusal (4xx) from one worth retrying (5xx).
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

// A human write for another machine's agent, permission request, or ITSA is refused here with a 409 naming
// the machine and its serve origin (S-544): the page sends it there itself, so that machine's tailscale
// serve proves the human made it. The daemon never relays it, so an unreachable machine fails the write
// (a 503, which the outbox retries) rather than falling back to anything else.
//
// The page sends to an origin only if its own daemon listed that machine with that origin (GET /api/machines,
// kept here by the store), and only over https unless the page itself is plain http (a dev or test daemon).
// A peer's answer can't name one: the daemon drops an origin from a relayed refusal.
export type MachineRefusal = { machine: string; origin: string }
const knownOrigins = new Map<string, string>()
export function setKnownOrigins(machines: { name: string; origin?: string }[]): void {
  knownOrigins.clear()
  for (const m of machines) if (m.origin) knownOrigins.set(m.name, m.origin)
}
const machineRefusal = (d: unknown): MachineRefusal | undefined => {
  const x = d as (Partial<MachineRefusal> & { refusal?: string }) | null
  return x?.refusal === 'human-on-machine' && typeof x.machine === 'string' && typeof x.origin === 'string' ? { machine: x.machine, origin: x.origin } : undefined
}
const originAllowed = (to: MachineRefusal): boolean => {
  let u: URL
  try { u = new URL(to.origin) } catch { return false }
  return knownOrigins.get(to.machine) === to.origin && u.origin === to.origin && (u.protocol === 'https:' || u.protocol === location.protocol)
}

// The page of a machine whose daemon refused a read as `human-on-machine` (strict mode), when this page may open it.
export function machinePage(d: unknown): { machine: string; origin?: string } | undefined {
  const to = machineRefusal(d)
  if (to) return { machine: to.machine, origin: originAllowed(to) ? to.origin : undefined }
  const x = d as { refusal?: string; machine?: unknown } | null
  return x?.refusal === 'human-on-machine' && typeof x.machine === 'string' ? { machine: x.machine } : undefined
}

// A terminal socket opens at a machine's origin only when it is the one this daemon listed for that machine.
export function terminalOriginFor(machine: string, origin: string | undefined): string | undefined {
  return origin && originAllowed({ machine, origin }) ? origin : undefined
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, {
    method,
    signal,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-stam-human': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  // A refused token on 127.0.0.1 (an expired local login, S-613) is dropped, and the page loads again to ask anew.
  if (r.status === 401 && token && onLoopback()) { dropToken(); location.reload() }
  // A human action refused on 127.0.0.1 while a local login is there (a `stam web` token link, S-2121): offer it.
  if (r.status === 403 && (d as { localLogin?: unknown }).localLogin === true && onLoopback()) offerLogin()
  if (r.status === 409 && method !== 'GET') {
    const to = machineRefusal(d)
    if (to) {
      if (!originAllowed(to)) throw new ApiError(`${to.machine} needs its own page for this; open mootr on ${to.machine}. Nothing was sent.`, 409)
      return machineApi<T>(to.origin, to.machine, method, path, body)
    }
    // A refusal that names no origin (the machine has no tailnet name): the human does it on that machine.
    const named = (d as { refusal?: string; machine?: unknown } | null)?.refusal === 'human-on-machine' ? (d as { machine?: unknown }).machine : undefined
    if (typeof named === 'string') throw new ApiError(`${named} needs its own page for this; open mootr on ${named}. Nothing was sent.`, 409)
  }
  // The error carries the HTTP status, for a caller that handles one (a 409 from a non-home daemon).
  if (!r.ok) throw new ApiError((d as { error?: string }).error || `HTTP ${r.status}`, r.status)
  return d as T
}

// A write from this page to another machine's own web origin, carrying no token (this page's token is its
// own daemon's); the machine's tailscale serve proves the human sent it (S-414, S-544).
export async function machineApi<T = unknown>(origin: string, machine: string, method: string, path: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(origin + path, {
      method,
      mode: 'cors',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-stam-human': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(`Couldn't reach ${machine}, or ${machine} refused this page; nothing was sent.`, 503)
  }
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError((d as { error?: string }).error || `HTTP ${r.status}`, r.status)
  return d as T
}

// A shared write from a peer's page goes straight to the settings home, at its own web origin (S-414): a
// home that can't be reached saves nothing.
export async function homeApi<T = unknown>(web: string, home: string, method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await machineApi<T>(web, home, method, path, body)
  } catch (e) {
    if (e instanceof ApiError && e.status === 503 && /is unreachable/.test(e.message)) throw Object.assign(new Error(`Can't reach ${home}; nothing was saved.`), { status: 0 })
    throw e
  }
}

// A write made as the page closes: the request outlives the page (keepalive), and nothing waits on it.
export function sendAsHuman(method: string, path: string, body: unknown): void {
  void fetch(path, {
    method,
    keepalive: true,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-stam-human': '1' },
    body: JSON.stringify(body),
  }).catch(() => {})
}

// A voice clip goes up as the raw body, with its own Content-Type; the reply is {text}.
export async function uploadClip(clip: Blob): Promise<{ text: string }> {
  const r = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': clip.type || 'audio/webm', 'x-stam-human': '1' },
    body: clip,
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as { error?: string }).error || `HTTP ${r.status}`)
  return d as { text: string }
}
