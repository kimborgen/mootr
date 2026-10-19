import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffFail, diffFileUrl, fetchDiffList, fetchSide, fetchWhole } from './diffApi'

const refs = { repo: 'stam2', pr: 7, head: 'a'.repeat(40), base: 'b'.repeat(40) }
const reply = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers })
const mock = (r: Response | (() => Response)) => vi.stubGlobal('fetch', vi.fn(async () => (typeof r === 'function' ? r() : r)))
afterEach(() => vi.unstubAllGlobals())

describe('the diff API client', () => {
  it('fetches a file with the head and base shas the list returned', async () => {
    mock(reply(200, 'hello', { 'content-type': 'text/plain; charset=utf-8' }))
    expect(await fetchSide(refs, 'src/a b.ts', 'head')).toEqual({ kind: 'text', text: 'hello' })
    const url = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][0]
    expect(url).toBe(`/api/diff/file?repo=stam2&pr=7&path=src%2Fa%20b.ts&side=head&head=${refs.head}&base=${refs.base}`)
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect((init.headers as Record<string, string>)['x-stam-human']).toBe('1')
  })
  it('the url asks for the whole file only when told to', () => {
    expect(diffFileUrl(refs, 'a.ts', 'base')).toContain('side=base')
    expect(diffFileUrl(refs, 'a.ts', 'base')).not.toContain('all=1')
    expect(diffFileUrl(refs, 'a.ts', 'head', true)).toContain('&all=1')
  })
  it('a 404 is an error, not a missing side', async () => {
    mock(reply(404, JSON.stringify({ error: 'the head or base asked for is not in the cache for PR 7 of stam2; reload the diff' })))
    await expect(fetchSide(refs, 'a.ts', 'base')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('reload the diff') })
  })
  it('a binary is reported with its size and its body is not read', async () => {
    mock(reply(200, new Uint8Array([1, 0, 2]), { 'content-type': 'application/octet-stream', 'x-stam-size': '4096' }))
    expect(await fetchSide(refs, 'a.bin', 'head')).toEqual({ kind: 'binary', size: 4096 })
  })
  it('an SVG is text, not a binary', async () => {
    mock(reply(200, '<svg/>', { 'content-type': 'image/svg+xml' }))
    expect(await fetchSide(refs, 'a.svg', 'head')).toEqual({ kind: 'text', text: '<svg/>' })
  })
  it('a file the server cut, or refused, is large', async () => {
    mock(reply(200, 'x', { 'content-type': 'text/plain', 'x-stam-truncated': '1', 'x-stam-size': String(9 * 1024 * 1024) }))
    expect(await fetchSide(refs, 'big.txt', 'head')).toEqual({ kind: 'large', size: 9 * 1024 * 1024 })
    mock(reply(413, JSON.stringify({ error: 'too big' })))
    expect((await fetchSide(refs, 'huge.bin', 'head')).kind).toBe('large')
  })
  it('other failures throw a DiffFail naming the status', async () => {
    mock(reply(500, JSON.stringify({ error: 'git blew up' })))
    await expect(fetchSide(refs, 'a.ts', 'head')).rejects.toMatchObject({ status: 500, message: 'git blew up' })
  })
  it('the list: unknown repo, no PR, a failed fetch and a timeout each say so', async () => {
    mock(reply(404, JSON.stringify({ error: 'unknown repo nope: it is not in settings.itsa.repos' })))
    await expect(fetchDiffList('nope', 1)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('unknown repo nope') })
    mock(reply(404, JSON.stringify({ error: 'no PR 9 in stam2' })))
    await expect(fetchDiffList('stam2', 9)).rejects.toMatchObject({ status: 404, message: 'no PR 9 in stam2' })
    mock(reply(502, JSON.stringify({ error: 'fetching PR 9 of stam2 failed: auth' })))
    await expect(fetchDiffList('stam2', 9)).rejects.toThrow(/Fetching the PR failed/)
    mock(reply(504, JSON.stringify({ error: 'fetching PR 9 of stam2 timed out after 60s' })))
    const e = await fetchDiffList('stam2', 9).catch((x) => x)
    expect(e).toBeInstanceOf(DiffFail)
    expect(e.status).toBe(504)
    expect(e.message).toMatch(/timed out/)
  })
  it('the whole file comes back as a blob with all=1', async () => {
    mock(reply(200, 'whole', { 'content-type': 'text/plain' }))
    expect(await (await fetchWhole(refs, 'a.ts', 'head')).text()).toBe('whole')
    expect((fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toContain('&all=1')
  })
})
