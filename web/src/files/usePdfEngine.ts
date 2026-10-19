// The PDFium engine in a worker, made here rather than by EmbedPDF's usePdfiumEngine (S-1528): that hook ignores its
// `cancelled` flag on the success path, so a view that unmounts while the engine starts leaks the worker. This one
// destroys an engine that arrives after the unmount, and the one it made when the view goes away.
import { useEffect, useState } from 'react'
import { ignore, type PdfEngine } from '@embedpdf/models'

const release = (e: PdfEngine) => {
  const close = e.closeAllDocuments?.()
  if (close) close.wait(() => e.destroy?.(), ignore)
  else e.destroy?.()
}

export function usePdfEngine(wasmUrl: string): { engine: PdfEngine | null; error: Error | null } {
  const [state, setState] = useState<{ engine: PdfEngine | null; error: Error | null }>({ engine: null, error: null })
  useEffect(() => {
    let cancelled = false
    let made: PdfEngine | null = null
    void import('@embedpdf/engines/pdfium-worker-engine').then(({ createPdfiumEngine }) => createPdfiumEngine(wasmUrl)).then(
      (e) => {
        if (cancelled) { release(e); return }
        made = e
        setState({ engine: e, error: null })
      },
      (e) => { if (!cancelled) setState({ engine: null, error: e instanceof Error ? e : new Error(String(e)) }) })
    return () => { cancelled = true; if (made) release(made) }
  }, [wasmUrl])
  return state
}
