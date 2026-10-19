// What a PDF sheet shows in place of a page that could not be drawn (S-1528, design system "Empty, loading, and error
// grammar"): the sheet keeps its exact geometry and a centred chrome-type message says so, with no broken-image glyph.
import './PdfView.css'

export function PdfSheetError({ index }: { index: number }) {
  return <div className="pdf-page-error" role="alert" data-testid={`pdf-page-error-${index}`}>Page {index + 1} couldn't be drawn.</div>
}
