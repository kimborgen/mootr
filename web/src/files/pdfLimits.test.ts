// S-1528: the PDF viewer's limits are fixed by PDFium's heap, and its labels read from the plugins' state.
import { describe, expect, it } from 'vitest'
import { MAX_PAGE_RASTER_PIXELS, MAX_ZOOM, MIN_ZOOM, pageLabel, rasterScaleFor, zoomLabel } from './pdfLimits'

describe('pdf limits', () => {
  it('zooms from 25% to 800%', () => {
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.25, 8])
  })
  it('rasters at scale times the pixel ratio when that fits the budget', () => {
    expect(rasterScaleFor(612, 792, 1, 2)).toBe(2)
    expect(rasterScaleFor(612, 792, 0.5, 1)).toBe(0.5)
  })
  it('lowers the raster so a page never exceeds 16 megapixels', () => {
    // 612x792 at 8x on a 2x display would be 124 MP.
    const s = rasterScaleFor(612, 792, 8, 2)
    expect(s).toBeLessThan(16)
    expect(612 * 792 * s * s).toBeCloseTo(MAX_PAGE_RASTER_PIXELS, -2)
  })
  it('labels the page and the zoom, with placeholders before the document loads', () => {
    expect(pageLabel(3, 12)).toBe('3 / 12')
    expect(pageLabel(1, 0)).toBe('– / –')
    expect(zoomLabel(0.5)).toBe('50%')
    expect(zoomLabel(7.999)).toBe('800%')
    expect(zoomLabel(null)).toBe('–')
  })
})
