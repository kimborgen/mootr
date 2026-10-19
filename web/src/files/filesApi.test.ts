// @vitest-environment jsdom
// S-1528: readFile hands back a PDF's bytes up to the cap, and only its headers above it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDF_MAX, readFile } from './filesApi'

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
})
