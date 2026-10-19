// The PDF viewer's limits and labels (S-1528), pure so they are tested alone.
// PDFium rasters a whole page into its WASM heap, which is capped at 2 GB, so zoom stops at 8x and a page is never rastered above 16 megapixels.
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 8
export const MAX_PAGE_RASTER_PIXELS = 16_000_000

// The scale to raster a page at: its layout scale times the display's pixel ratio, lowered until the bitmap fits
// the budget. The image fills the sheet the plugin sizes, so a raster below the layout size is upscaled, not drawn small.
export function rasterScaleFor(pageWidth: number, pageHeight: number, scale: number, pixelRatio: number, max = MAX_PAGE_RASTER_PIXELS): number {
  const wanted = scale * pixelRatio
  const pixels = pageWidth * pageHeight * wanted * wanted
  if (!(pixels > max)) return wanted
  return wanted * Math.sqrt(max / pixels)
}

export const pageLabel = (n: number, total: number): string => (total > 0 ? `${n} / ${total}` : '– / –')
export const zoomLabel = (level: number | null): string => (level === null ? '–' : `${Math.round(level * 100)}%`)
