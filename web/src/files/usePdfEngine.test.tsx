// @vitest-environment jsdom
// S-1528: the engine's worker is destroyed when the view unmounts before the engine arrives, and when it unmounts after.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const engine = () => {
  const destroy = vi.fn()
  return { destroy, closeAllDocuments: () => ({ wait: (ok: () => void) => ok() }) }
}

async function mountThenUnmount(arrive: 'after' | 'before') {
  vi.resetModules()
  const e = engine()
  let resolve!: (v: unknown) => void
  const made = new Promise((r) => { resolve = r })
  vi.doMock('@embedpdf/engines/pdfium-worker-engine', () => ({ createPdfiumEngine: () => made }))
  const { usePdfEngine } = await import('./usePdfEngine')
  let seen: unknown = null
  const C = () => { seen = usePdfEngine('http://x/pdfium.wasm').engine; return null }
  const root = createRoot(document.createElement('div'))
  await act(async () => { root.render(<C />) })
  if (arrive === 'before') { resolve(e); await act(async () => { await made }) }
  expect(e.destroy).not.toHaveBeenCalled()
  act(() => root.unmount())
  if (arrive === 'after') { resolve(e); await act(async () => { await made }) }
  return { e, seen }
}

describe('usePdfEngine', () => {
  it('destroys an engine that arrives after the unmount', async () => {
    const { e, seen } = await mountThenUnmount('after')
    expect(seen).toBeNull()
    expect(e.destroy).toHaveBeenCalledTimes(1)
  })
  it('destroys the engine it handed out when the view unmounts', async () => {
    const { e, seen } = await mountThenUnmount('before')
    expect(seen).toBe(e)
    expect(e.destroy).toHaveBeenCalledTimes(1)
  })
})
