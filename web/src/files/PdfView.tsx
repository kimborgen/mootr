// The PDF viewer (S-1528, step 4 of the file viewer S-1017): a read-only EmbedPDF view of a PDF's bytes. This
// file is the small shell the main bundle holds: the too-big and failure states, and the lazy boundary. The engine
// (PDFium in WASM, in a worker) and EmbedPDF's code are in PdfSurface.tsx, loaded as their own chunks the first
// time a PDF opens, like CodeView's editor.
import { Component, lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import './PdfView.css'
import { Icon } from '../Icon'
import { PDF_MAX } from './filesApi'

const PdfSurface = lazy(() => import('./PdfSurface'))

export interface PdfViewProps {
  // A blob: URL of the bytes. Absent when the file was over the cap and was not loaded.
  src?: string
  name: string
  // The file's size in bytes (0 when unknown).
  size: number
  onDownload: () => void
  downloadNote?: string
}

function Download({ onDownload, note }: { onDownload: () => void; note?: string }) {
  return (
    <>
      <button className="btn primary fv-touch" onClick={onDownload}><Icon name="download" /> Download</button>
      {note && <p className="muted">{note}</p>}
    </>
  )
}

// A viewer chunk that fails to load (offline, a stale deploy) falls back to Download, never a blank pane.
class Boundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function PdfView({ src, name, size, onDownload, downloadNote }: PdfViewProps) {
  if (!src || size > PDF_MAX) {
    return (
      <div className="fv-note" data-testid="pdf-too-big">
        <p>{name} is {Math.max(1, Math.round(size / 1024 / 1024))} MB, too large to show here.</p>
        <Download onDownload={onDownload} note={downloadNote} />
      </div>
    )
  }
  return (
    <Boundary fallback={<div className="fv-note" role="alert"><p className="fv-err">The PDF viewer couldn't load.</p><Download onDownload={onDownload} note={downloadNote} /></div>}>
      <Suspense fallback={<div className="fv-note muted" role="status">Loading PDF viewer…</div>}>
        <PdfSurface src={src} name={name} onDownload={onDownload} downloadNote={downloadNote} />
      </Suspense>
    </Boundary>
  )
}
