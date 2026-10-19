// @vitest-environment jsdom
// S-1915: an image over IMAGE_MAX is not read (Download instead); Download over DOWNLOAD_MAX makes no fetch.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_MAX, IMAGE_MAX } from './filesApi'
import { FileView } from './FileView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const urlFns = { c: URL.createObjectURL, r: URL.revokeObjectURL }
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); URL.createObjectURL = urlFns.c; URL.revokeObjectURL = urlFns.r })
const stubUrls = (made: Blob[] = []) => {
  URL.createObjectURL = (b: Blob | MediaSource) => { made.push(b as Blob); return 'blob:x' }
  URL.revokeObjectURL = () => {}
}

const reply = (type: string, size: number, body = 'x') => {
  const cancel = vi.fn()
  const res = new Response(body, { headers: { 'content-type': type, 'x-stam-size': String(size) } })
  Object.defineProperty(res, 'body', { value: { cancel } })
  return { res, cancel }
}
async function mount(key: string) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<FileView viewKey={key} />) })
  return host
}

describe('FileView binary caps', () => {
  it('cancels an image over IMAGE_MAX and offers Download', async () => {
    const { res, cancel } = reply('image/png', IMAGE_MAX + 1)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const host = await mount('file:m:/a.png')
    await vi.waitFor(() => expect(host.querySelector('[data-testid=image-too-big]')).toBeTruthy())
    expect(cancel).toHaveBeenCalled()
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('Download')
  })
  it('shows an image under IMAGE_MAX', async () => {
    const { res } = reply('image/png', 1024)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    stubUrls()
    const host = await mount('file:m:/a.png')
    await vi.waitFor(() => expect(host.querySelector('img')).toBeTruthy())
    expect(host.querySelector('[data-testid=image-too-big]')).toBeNull()
  })
  it('Download over DOWNLOAD_MAX shows a note and fetches nothing more', async () => {
    const { res } = reply('application/zip', DOWNLOAD_MAX + 1)
    const f = vi.fn(async () => res)
    vi.stubGlobal('fetch', f)
    const host = await mount('file:m:/a.zip')
    await vi.waitFor(() => expect(host.querySelector('button.primary')).toBeTruthy())
    await act(async () => { host.querySelector<HTMLButtonElement>('button.primary')!.click() })
    expect(host.textContent).toContain('too large to download in the browser')
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('Download under the cap streams the blob, shows progress, and disables the button meanwhile', async () => {
    const enc = new TextEncoder()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const stream = new ReadableStream<Uint8Array>({ async pull(c) { if (n === 0) { n++; c.enqueue(enc.encode('ab')); await gate } else { c.enqueue(enc.encode('cd')); c.close(); n++ } } })
    const full = new Response(stream, { headers: { 'content-type': 'application/zip', 'x-stam-size': '4' } })
    const f = vi.fn().mockResolvedValueOnce(reply('application/zip', 4).res).mockResolvedValueOnce(full)
    vi.stubGlobal('fetch', f)
    const made: Blob[] = []
    stubUrls(made)
    const host = await mount('file:m:/a.zip')
    await vi.waitFor(() => expect(host.querySelector('button.primary')).toBeTruthy())
    const btn = host.querySelector<HTMLButtonElement>('button.primary')!
    await act(async () => { btn.click() })
    await vi.waitFor(() => expect(host.textContent).toContain('Preparing… 50%'))
    expect(btn.disabled).toBe(true)
    await act(async () => { btn.click() })
    expect(f).toHaveBeenCalledTimes(2)
    await act(async () => { release() })
    await vi.waitFor(() => expect(made.length).toBe(1))
    expect(await made[0].text()).toBe('abcd')
    expect(btn.disabled).toBe(false)
  })
  it('aborts a running download when the view unmounts', async () => {
    let sig: AbortSignal | undefined
    const never = new Promise<Response>(() => {})
    const f = vi.fn().mockResolvedValueOnce(reply('application/zip', 4).res).mockImplementationOnce((_u: string, init: RequestInit) => { sig = init.signal as AbortSignal; return never })
    vi.stubGlobal('fetch', f)
    const host = await mount('file:m:/a.zip')
    await vi.waitFor(() => expect(host.querySelector('button.primary')).toBeTruthy())
    await act(async () => { host.querySelector<HTMLButtonElement>('button.primary')!.click() })
    expect(sig?.aborted).toBe(false)
    act(() => root?.unmount())
    root = undefined
    expect(sig?.aborted).toBe(true)
  })
})
