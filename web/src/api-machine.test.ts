import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A human write for another machine's agent: the daemon answers 409 with {refusal, machine, origin}, and the
// page sends the write there itself, with no token, but only to an origin its own daemon listed (S-544).
vi.stubGlobal('__DEV_TOKEN__', 'dev-token')
const { api, ApiError, setKnownOrigins, terminalOriginFor } = await import('./api')

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response
const refusal = (origin: string, machine = 'storage') => ({ error: 'x', refusal: 'human-on-machine', machine, origin })
const err = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal') }, (x: unknown) => x as { status: number; message: string })
let calls: { url: string; init: RequestInit }[]
const answers: (() => Response | Promise<Response>)[] = []
beforeEach(() => {
  calls = []
  answers.length = 0
  setKnownOrigins([{ name: 'storage', origin: 'https://storage.example.com' }])
  vi.stubGlobal('location', { protocol: 'https:' })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = answers.shift()
    if (!next) throw new TypeError('network')
    return next()
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('a write the daemon refuses for another machine (S-544)', () => {
  it('goes straight to that machine\'s origin with no token, once', async () => {
    answers.push(() => reply(409, refusal('https://storage.example.com')))
    answers.push(() => reply(200, { id: 'p1', status: 'approved' }))
    const r = await api('POST', '/api/permissions/p1/answer', { approve: true })
    expect(r).toEqual({ id: 'p1', status: 'approved' })
    expect(calls.map((c) => c.url)).toEqual(['/api/permissions/p1/answer', 'https://storage.example.com/api/permissions/p1/answer'])
    const h = calls[1].init.headers as Record<string, string>
    expect(h.authorization).toBeUndefined()
    expect(h['x-stam-human']).toBe('1')
    expect(calls[1].init.credentials).toBe('omit')
    expect(calls[1].init.mode).toBe('cors')
  })

  it('fails with the machine named, as a 503 the outbox retries, when its origin is unreachable', async () => {
    answers.push(() => reply(409, refusal('https://storage.example.com')))
    const e = await err(api('POST', '/api/itsas/S-1/act', { action: 'approve' }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.status).toBe(503)
    expect(e.message).toBe("Couldn't reach storage, or storage refused this page; nothing was sent.")
    expect(calls).toHaveLength(2)
  })

  it('shows the other machine\'s own refusal, and does not retry through the first daemon', async () => {
    answers.push(() => reply(409, refusal('https://storage.example.com')))
    answers.push(() => reply(403, { error: 'only the human approves, from stam\'s web UI on storage (tailscale serve)' }))
    const e = await err(api('POST', '/api/permissions/p1/answer', { approve: true }))
    expect(e.status).toBe(403)
    expect(calls).toHaveLength(2)
  })

  it('sends nothing to an origin its own daemon didn\'t list, or that isn\'t https, or to an unknown machine', async () => {
    for (const [origin, machine] of [['https://evil.example', 'storage'], ['http://storage.example.com', 'storage'], ['https://storage.example.com', 'elsewhere']] as const) {
      answers.push(() => reply(409, refusal(origin, machine)))
      const e = await err(api('POST', '/api/permissions/p1/answer', { approve: true }))
      expect(e.status).toBe(409)
      expect(e.message).toContain(`open mootr on ${machine}`)
    }
    expect(calls).toHaveLength(3)
  })

  it('says to open mootr on the machine when the refusal names no origin', async () => {
    answers.push(() => reply(409, { error: 'x', refusal: 'human-on-machine', machine: 'storage' }))
    const e = await err(api('POST', '/api/agents/a1/kill', {}))
    expect(e.message).toBe('storage needs its own page for this; open mootr on storage. Nothing was sent.')
    expect(calls).toHaveLength(1)
  })

  it('leaves an ordinary 409, a 409 that only has a machine field, and a read alone', async () => {
    answers.push(() => reply(409, { error: 'already answered' }))
    expect((await err(api('POST', '/api/permissions/p2/answer', {}))).message).toBe('already answered')
    answers.push(() => reply(409, { error: 'approve from the web UI on storage', machine: 'storage' }))
    expect((await err(api('POST', '/api/permissions/p3/answer', {}))).message).toBe('approve from the web UI on storage')
    answers.push(() => reply(409, refusal('https://storage.example.com')))
    expect((await err(api('GET', '/api/agents'))).status).toBe(409)
    expect(calls).toHaveLength(3)
  })

  it('accepts a plain http origin only when the page is plain http (a dev or test daemon)', async () => {
    vi.stubGlobal('location', { protocol: 'http:' })
    setKnownOrigins([{ name: 'storage', origin: 'http://127.0.0.1:9' }])
    answers.push(() => reply(409, refusal('http://127.0.0.1:9')))
    answers.push(() => reply(200, {}))
    await api('POST', '/api/permissions/p1/answer', {})
    expect(calls[1].url).toBe('http://127.0.0.1:9/api/permissions/p1/answer')
  })
})

describe('a terminal socket opens only at an origin the daemon listed (S-544)', () => {
  it('accepts the listed origin and refuses any other, or a plain http one', () => {
    expect(terminalOriginFor('storage', 'https://storage.example.com')).toBe('https://storage.example.com')
    expect(terminalOriginFor('storage', 'https://evil.example')).toBeUndefined()
    expect(terminalOriginFor('storage', 'http://storage.example.com')).toBeUndefined()
    expect(terminalOriginFor('other', 'https://storage.example.com')).toBeUndefined()
    expect(terminalOriginFor('storage', undefined)).toBeUndefined()
  })
})

describe('a human action refused on 127.0.0.1 with a local login there (S-2121)', () => {
  it('shows the login offer in the one notice bar, only on loopback and only when the daemon says a login is there', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, createElement } = await import('react')
    const { MenuLayer, toast } = await import('./ui/menu')
    const { loginOffered } = await import('./local-login')
    const el = document.createElement('div')
    await act(async () => { createRoot(el).render(createElement(MenuLayer)) })
    const refuse = async (body: object) => {
      answers.push(() => reply(403, { error: 'only the human', ...body }))
      await act(async () => { await err(api('POST', '/api/permissions/p1/answer', { approve: true })) })
    }
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'box.example.com' })
    await refuse({ localLogin: true })
    vi.stubGlobal('location', { protocol: 'http:', hostname: '127.0.0.1' })
    await refuse({})
    expect(el.querySelector('#login-offer')).toBeNull()
    await refuse({ localLogin: true })
    expect(el.querySelector('#toasts #login-offer')?.textContent).toContain("isn't logged in as the human")
    expect(el.querySelector('#login-offer .btn.primary')?.textContent).toBe('Log in')
    // A transient notice takes the one bar while it shows (never stacked), then the offer comes back.
    vi.useFakeTimers()
    try {
      act(() => toast('Copied stam/fixture-branch.'))
      expect(el.querySelectorAll('#toasts > *').length).toBe(1)
      expect(el.querySelector('#toasts .toast')?.textContent).toBe('Copied stam/fixture-branch.')
      expect(el.querySelector('#login-offer')).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(el.querySelector('#toasts #login-offer')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
    // Dismissed, it comes back with the next refusal.
    await act(async () => { el.querySelector<HTMLButtonElement>('#login-offer .icon-btn')!.click() })
    expect(el.querySelector('#login-offer')).toBeNull()
    await refuse({ localLogin: true })
    expect(el.querySelector('#login-offer')).not.toBeNull()
    expect(loginOffered()).toBe(true)
  })
})
