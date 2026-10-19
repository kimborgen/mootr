// @vitest-environment jsdom
// S-1528: readFile hands back a PDF's bytes up to the cap, and only its headers above it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_MAX, downloadBlob, IMAGE_MAX, PDF_MAX, readFile } from './filesApi'

afterEach(() => vi.unstubAllGlobals())

const reply = (type: string, size: number, body = '%PDF') => {
  const cancel = vi.fn()
  const res = new Response(body, { headers: { 'content-type': type, 'x-stam-size': String(size) } })
  Object.defineProperty(res, 'body', { value: { cancel } })
  return { res, cancel }
}

describe('readFile', () => {
  it('returns a PDF within the cap as a blob', async () => {
    const { res } = reply('application/pdf', 2048)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const b = await readFile('m', '/a.pdf')
    expect(b.blob).toBeInstanceOf(Blob)
    expect(b.size).toBe(2048)
  })
  it('cancels the body of a PDF over the cap', async () => {
    const { res, cancel } = reply('application/pdf', PDF_MAX + 1)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const b = await readFile('m', '/a.pdf')
    expect(b.blob).toBeUndefined()
    expect(cancel).toHaveBeenCalled()
  })
  it('cancels an image over the cap, and reads one under it', async () => {
    const big = reply('image/png', IMAGE_MAX + 1)
    vi.stubGlobal('fetch', vi.fn(async () => big.res))
    expect((await readFile('m', '/a.png')).blob).toBeUndefined()
    expect(big.cancel).toHaveBeenCalled()
    const ok = reply('image/png', 10)
    vi.stubGlobal('fetch', vi.fn(async () => ok.res))
    expect((await readFile('m', '/a.png')).blob).toBeInstanceOf(Blob)
  })
})

const chunked = (parts: string[], headers: Record<string, string>) => {
  const enc = new TextEncoder()
  let n = 0
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (n < parts.length) c.enqueue(enc.encode(parts[n++])); else c.close() } })
  return new Response(body, { headers: { 'content-type': 'application/zip', ...headers } })
}
// A body whose chunks only claim a length, to pass a 500 MB cap without allocating it.
const bulky = (chunks: number, len: number) => {
  const cancel = vi.fn()
  let n = 0
  const body = { getReader: () => ({ read: async () => (n++ < chunks ? { done: false, value: { length: len } } : { done: true, value: undefined }), cancel }), cancel }
  const res = new Response('', { headers: { 'content-type': 'application/zip' } })
  Object.defineProperty(res, 'body', { value: body })
  return { res, cancel }
}

describe('downloadBlob', () => {
  it('reports progress for each chunk of a known size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chunked(['ab', 'cd'], { 'x-stam-size': '4' })))
    const seen: number[] = []
    const b = await downloadBlob('m', '/a.zip', (f) => seen.push(f))
    expect(await b.text()).toBe('abcd')
    expect(seen).toEqual([0.5, 1])
  })
  it('streams a body with no size, without progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chunked(['ab', 'cd'], {})))
    const seen: number[] = []
    expect(await (await downloadBlob('m', '/a.zip', (f) => seen.push(f))).text()).toBe('abcd')
    expect(seen).toEqual([])
  })
  it('refuses over the cap by the header', async () => {
    const { res, cancel } = reply('application/zip', DOWNLOAD_MAX + 1)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    await expect(downloadBlob('m', '/a.zip')).rejects.toThrow('too large to download')
    expect(cancel).toHaveBeenCalled()
  })
  it('cancels mid-stream once the bytes pass the cap, whatever the header says', async () => {
    const { res, cancel } = bulky(3, DOWNLOAD_MAX / 2)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    await expect(downloadBlob('m', '/a.zip')).rejects.toThrow('too large to download')
    expect(cancel).toHaveBeenCalled()
  })
  it('passes the abort signal to fetch', async () => {
    const f = vi.fn(async () => chunked(['a'], {}))
    vi.stubGlobal('fetch', f)
    const ctl = new AbortController()
    await downloadBlob('m', '/a.zip', undefined, ctl.signal)
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal)
  })
})

describe('readFile with a wrong size header', () => {
  it('stops an image that streams past the cap though it claims to be small', async () => {
    const { res, cancel } = bulky(3, IMAGE_MAX / 2)
    res.headers.set('content-type', 'image/png')
    res.headers.set('x-stam-size', '10')
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const b = await readFile('m', '/a.png')
    expect(b.blob).toBeUndefined()
    expect(b.size).toBeGreaterThan(IMAGE_MAX)
    expect(cancel).toHaveBeenCalled()
  })
})
