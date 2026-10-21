import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Local human login (S-613): the page asks for a code only on 127.0.0.1, only when its token is refused,
// and only with auth.localHuman on; a refused token is dropped.
const { needsLocalLogin, isLocalSession, nameOf, newSecret, commandFor } = await import('./local-login')

const reply = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body }) as Response
let answers: Response[]
let urls: string[]
beforeEach(() => {
  answers = []
  urls = []
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    const next = answers.shift()
    if (!next) throw new TypeError('network')
    return next
  }))
})
afterEach(() => vi.unstubAllGlobals())
const at = (hostname: string) => vi.stubGlobal('location', { hostname })

describe('needsLocalLogin', () => {
  it('asks for a code on 127.0.0.1 when the token is refused and the setting is on, and drops the token', async () => {
    at('127.0.0.1')
    localStorage.setItem('stamToken', 'old')
    localStorage.setItem('stamTokenKind', 'local-human')
    answers.push(reply(401), reply(200, { enabled: true, dir: '/run/stam-human/1000' }))
    expect(await needsLocalLogin('old')).toEqual({ dir: '/run/stam-human/1000', passwordlessSudo: false })
    expect(urls).toEqual(['/api/health', '/api/human/login'])
    expect(localStorage.getItem('stamToken')).toBeNull()
    expect(isLocalSession()).toBe(false)
  })
  it('keeps the app when the token is accepted, or the setting is off', async () => {
    at('127.0.0.1')
    answers.push(reply(200))
    expect(await needsLocalLogin('good')).toBeNull()
    answers.push(reply(401), reply(200, { enabled: false }))
    expect(await needsLocalLogin('')).toBeNull()
  })
  it('asks for a code when the human asked to log in (LoginOffer), keeping the token until the login replaces it', async () => {
    at('127.0.0.1')
    localStorage.setItem('stamToken', 'shared')
    sessionStorage.setItem('stamLoginWanted', '1')
    answers.push(reply(200, { enabled: true, dir: '/run/stam-human/1000', passwordlessSudo: true }))
    expect(await needsLocalLogin('shared')).toEqual({ dir: '/run/stam-human/1000', passwordlessSudo: true })
    expect(urls).toEqual(['/api/human/login'])
    expect(localStorage.getItem('stamToken')).toBe('shared')
    // Asked once: the next load is the app again.
    answers.push(reply(200))
    expect(await needsLocalLogin('shared')).toBeNull()
  })
  it('never asks on a non-loopback host (tailscale serve)', async () => {
    at('box.example.com')
    expect(await needsLocalLogin('')).toBeNull()
    expect(urls).toEqual([])
  })
})

describe('the secret and its name', () => {
  it('names a secret as the daemon does (src/local-human.ts nameOf)', async () => {
    expect(await nameOf('AAAAAAAAAAAAAAAAAAAAAA')).toBe('rjn5wtgbkfsbe3do6jti32o5eq')
  })
  it('draws a fresh 128-bit secret each time', async () => {
    const a = await newSecret()
    const b = await newSecret()
    expect(a.secret).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.name).toMatch(/^[a-z2-7]{26}$/)
    expect(a.secret).not.toBe(b.secret)
    expect(await nameOf(a.secret)).toBe(a.name)
  })
})

describe('the command the human runs as root', () => {
  it('runs coreutils by absolute path, never stam or a PATH the agents can edit', () => {
    const c = commandFor('/run/stam-human/1000', 'rjn5wtgbkfsbe3do6jti32o5eq')
    expect(c).toBe('sudo /usr/bin/install -d -m 755 /run/stam-human /run/stam-human/1000 && sudo /usr/bin/install -m 644 /dev/null /run/stam-human/1000/rjn5wtgbkfsbe3do6jti32o5eq')
    expect(c).not.toContain(' -D ')
    expect(c).not.toMatch(/(^|\s)stam(\s|$)/)
    expect(c).not.toContain('PATH=')
    expect(c).not.toMatch(/\benv\b|node/)
  })
})
