// S-1532: the declaration API client against a mocked fetch: the query, polling while the index builds, errors, and the hover cache.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetKnown, declUrl, hasDecl, lookupDecl } from './declApi'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const READY = { state: 'ready', repo: 'stam2', sha: 'a'.repeat(40), name: 'run', matches: [{ path: 'src/a.ts', line: 3, col: 17, kind: 'function', text: 'export function run() {}' }], total: 1, root: { host: 'box', path: '/p/stam2' } }
let replies: Response[] = []
let urls: string[] = []
beforeEach(() => {
  urls = []
  _resetKnown()
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => { urls.push(u); expect((init.headers as Record<string, string>)['x-stam-human']).toBe('1'); return replies.shift() ?? json(500, { error: 'no reply' }) }))
})
afterEach(() => vi.unstubAllGlobals())

describe('lookupDecl', () => {
  it('asks by repo, sha, name and from, or by host and file', () => {
    expect(declUrl({ repo: 'stam2', sha: 'abc', name: 'run', from: 'src/a b.ts' })).toBe('/api/decl?repo=stam2&sha=abc&name=run&from=src%2Fa+b.ts')
    expect(declUrl({ host: 'box', file: '/p/x.ts', name: 'run' })).toBe('/api/decl?host=box&file=%2Fp%2Fx.ts&name=run')
  })
  it('polls while the index builds, telling the caller once', async () => {
    replies = [json(202, { state: 'building' }), json(202, { state: 'building' }), json(200, READY)]
    const building = vi.fn()
    const r = await lookupDecl({ repo: 'stam2', sha: 'a'.repeat(40), name: 'run' }, { pollMs: 1, onBuilding: building })
    expect(r).toEqual(READY)
    expect(building).toHaveBeenCalledTimes(1)
    expect(urls).toHaveLength(3)
  })
  it('gives up after maxPolls', async () => {
    replies = [json(202, {}), json(202, {})]
    await expect(lookupDecl({ repo: 'r', sha: 's', name: 'n' }, { pollMs: 1, maxPolls: 1 })).rejects.toMatchObject({ status: 202, message: expect.stringContaining('still building') })
  })
  it("an error carries the server's message and status", async () => {
    replies = [json(404, { error: 'unknown repo nope' })]
    await expect(lookupDecl({ repo: 'nope', sha: 's', name: 'n' })).rejects.toMatchObject({ status: 404, message: 'unknown repo nope' })
  })
  it('stops when aborted while it waits', async () => {
    replies = [json(202, {})]
    const ctl = new AbortController()
    const p = lookupDecl({ repo: 'r', sha: 's', name: 'n' }, { pollMs: 10_000, signal: ctl.signal })
    await vi.waitFor(() => expect(urls).toHaveLength(1))
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('hasDecl', () => {
  it('asks once per query; a building index says no and is asked again', async () => {
    replies = [json(200, READY)]
    expect(await hasDecl({ repo: 'stam2', sha: 's', name: 'run' })).toBe(true)
    expect(await hasDecl({ repo: 'stam2', sha: 's', name: 'run' })).toBe(true)
    expect(urls).toHaveLength(1)
    replies = [json(202, {}), json(200, { ...READY, matches: [], total: 0 })]
    expect(await hasDecl({ repo: 'stam2', sha: 's', name: 'gone' })).toBe(false)
    expect(await hasDecl({ repo: 'stam2', sha: 's', name: 'gone' })).toBe(false)
    expect(urls).toHaveLength(3)
  })
})
