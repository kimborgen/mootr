// The PDF viewer's stories (S-1528). Routes are stubs; the PDF is made on the spot (pdfFixture.ts), and its pages are
// drawn by the real engine (PDFium in WASM), so a state takes a moment to show its page.
import type { ReactNode } from 'react'
import { ds, pending, raw, type Story } from '../stories/types'
import { FileView } from './FileView'
import { makePdf } from './pdfFixture'
import { PdfSheetError } from './PdfSheet'
import { PdfView } from './PdfView'

const read = (host: string, path: string) => `GET /api/files/read?host=${host}&path=${encodeURIComponent(path)}`
const key = (path: string) => `file:fixture-machine:${path}`
const frame = (children: ReactNode) => <div style={{ height: 520, display: 'flex', flexDirection: 'column' }}>{children}</div>
const pdf = (pages: number, size?: number) => raw(makePdf(pages), 'application/pdf', size ? { 'x-stam-size': String(size) } : {})

export const stories: Story[] = [{
  name: 'PDF view',
  group: 'Tree and shell',
  what: 'A read-only PDF in the file view: EmbedPDF (PDFium in WASM, in a worker), without annotations or text selection. Pages are square-cut sheets on a recessed deck and are drawn only as they scroll near the view. A toolbar holds the page indicator, zoom out and in (25% to 800%), Fit width and Download; two fingers pinch-zoom on a touch screen. A page that fails keeps its sheet and says so in the centre. A PDF over 50 MB is not loaded: the view offers Download. The engine and its WASM load as their own chunks the first time a PDF opens.',
  when: 'The file view (`file:HOST:PATH`) for a file the Files API reports as `application/pdf`. It reads the bytes once on open.',
  code: ['web/src/files/PdfView.tsx#PdfView', 'web/src/files/PdfSurface.tsx#PdfSurface', 'web/src/files/PdfSheet.tsx#PdfSheetError', 'web/src/files/pdfLimits.ts#rasterScaleFor'],
  rules: [
    'The deck is `--pdf-viewport-bg` (`--surface-sunken`); a page is a square-cut sheet (`--radius-none`) on `--pdf-sheet-bg` with `--shadow-page`, dropped when the pane is narrower than 600 px (' + ds('Writing surface and PDF') + ').',
    'In dark mode the sheet stays light and is dimmed, never inverted: the page raster is multiplied onto `--pdf-sheet-bg`.',
    'On a phone the sheet fits the width; toolbar buttons are `--size-hit-touch` (44 px) there (' + ds('Density') + '). Zoom is 0.25x to 8x and a page is never rastered above 16 megapixels.',
    'A failed page keeps its exact geometry with a centred chrome-type message and no broken-image glyph (' + ds('Empty, loading, and error grammar') + ').',
  ],
  states: [
    { name: 'Several pages', routes: { [read('fixture-machine', '/p/a.pdf')]: pdf(5) }, render: () => frame(<FileView viewKey={key('/p/a.pdf')} />) },
    { name: 'One page', routes: { [read('fixture-machine', '/p/one.pdf')]: pdf(1) }, render: () => frame(<FileView viewKey={key('/p/one.pdf')} />) },
    { name: 'Loading', routes: { [read('fixture-machine', '/p/a.pdf')]: pending() }, render: () => frame(<FileView viewKey={key('/p/a.pdf')} />) },
    { name: 'Failed page', render: () => frame(<div className="pdf"><div className="pdf-viewport" style={{ display: 'grid', placeItems: 'center' }}><div className="pdf-sheet" style={{ width: 306, height: 396 }}><PdfSheetError index={1} /></div></div></div>) },
    { name: 'Too big', routes: { [read('fixture-machine', '/p/huge.pdf')]: pdf(1, 90 * 1024 * 1024) }, render: () => frame(<FileView viewKey={key('/p/huge.pdf')} />) },
    { name: 'Not loaded', render: () => frame(<PdfView name="scan.pdf" size={120 * 1024 * 1024} onDownload={() => {}} />) },
  ],
}]
