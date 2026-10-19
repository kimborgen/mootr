// @vitest-environment jsdom
// S-1528: the shell around the lazy PDF engine: the size cap, the lazy boundary, and the file view's dispatch. jsdom
// can't run WASM, so PdfSurface is stubbed; the real engine is exercised by web/check/phone.mjs.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDF_MAX } from './filesApi'
import { PdfView } from './PdfView'

vi.mock('./PdfSurface', () => ({ default: (p: { src: string; name: string }) => <div data-testid="surface" data-src={p.src}>{p.name}</div> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

async function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  return host
}

describe('PdfView', () => {
  it('loads the engine chunk and hands it the blob URL', async () => {
    const host = await mount(<PdfView src="blob:x" name="a.pdf" size={1024} onDownload={() => {}} />)
    await vi.waitFor(() => expect(host.querySelector('[data-testid=surface]')?.getAttribute('data-src')).toBe('blob:x'))
  })
  it('shows Download instead of the viewer over the cap', async () => {
    const onDownload = vi.fn()
    const host = await mount(<PdfView src="blob:x" name="big.pdf" size={PDF_MAX + 1} onDownload={onDownload} />)
    expect(host.querySelector('[data-testid=surface]')).toBeNull()
    expect(host.querySelector('[data-testid=pdf-too-big]')?.textContent).toContain('too large')
    act(() => { (host.querySelector('button') as HTMLButtonElement).click() })
    expect(onDownload).toHaveBeenCalled()
  })
  it('shows Download when the bytes were not loaded', async () => {
    const host = await mount(<PdfView name="big.pdf" size={0} onDownload={() => {}} />)
    expect(host.querySelector('[data-testid=pdf-too-big] button')?.textContent).toContain('Download')
  })
})
