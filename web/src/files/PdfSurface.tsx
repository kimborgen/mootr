// The PDF viewer's engine side (S-1528): EmbedPDF, PDFium in WASM, without its annotations, highlights and text selection. This module
// and everything it imports load as their own chunks, only when the first PDF opens (PdfView.tsx lazy-imports it).
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPluginRegistration } from '@embedpdf/core'
import { EmbedPDF, useDocumentState } from '@embedpdf/core/react'
import { PdfErrorCode } from '@embedpdf/models'
import { DocumentContent, DocumentManagerPluginPackage } from '@embedpdf/plugin-document-manager/react'
import { RenderPluginPackage, useRenderCapability } from '@embedpdf/plugin-render/react'
import { Scroller, ScrollPluginPackage, useScrollCapability, useScrollPlugin } from '@embedpdf/plugin-scroll/react'
import { ViewportPluginPackage, useViewportCapability, useViewportRef } from '@embedpdf/plugin-viewport/react'
import { ZoomGestureWrapper, ZoomMode, ZoomPluginPackage, useZoomCapability } from '@embedpdf/plugin-zoom/react'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import { Icon } from '../Icon'
import { usePdfEngine } from './usePdfEngine'
import { PdfSheetError } from './PdfSheet'
import { MAX_PAGE_RASTER_PIXELS, MAX_ZOOM, MIN_ZOOM, pageLabel, rasterScaleFor, zoomLabel } from './pdfLimits'

export interface PdfSurfaceProps {
  // A blob: URL of the PDF's bytes.
  src: string
  name: string
  onDownload: () => void
  // The Download button's progress or failure text, shown beside the toolbar.
  downloadNote?: string
}

const DOC_ID = 'pdf'
// How long a committed zoom must hold still before pages are rastered again.
const RASTER_SETTLE_MS = 160

// The scroll container, which the lazy pages observe: a page far outside it is not drawn.
const ViewportElementContext = createContext<React.RefObject<HTMLDivElement | null> | null>(null)

function Viewport({ children }: { children: ReactNode }) {
  const ref = useViewportRef(DOC_ID)
  const { provides } = useViewportCapability()
  const [gap, setGap] = useState(0)
  useEffect(() => { if (provides) setGap(provides.getViewportGap()) }, [provides])
  return (
    <ViewportElementContext.Provider value={ref}>
      <div ref={ref} className="pdf-viewport" data-testid="pdf-viewport" style={{ padding: gap }}>{children}</div>
    </ViewportElementContext.Provider>
  )
}

// The page indicator and zoom controls, read from the plugins' own state.
function Toolbar({ onDownload, downloadNote }: Pick<PdfSurfaceProps, 'onDownload' | 'downloadNote'>) {
  const { provides: scroll } = useScrollCapability()
  const { provides: zoom } = useZoomCapability()
  const [page, setPage] = useState({ n: 1, total: 0 })
  const [level, setLevel] = useState<number | null>(null)
  useEffect(() => {
    if (!scroll) return
    const scope = scroll.forDocument(DOC_ID)
    // The page count is known once the layout is: a page change alone is not reported until the reader scrolls.
    const read = () => setPage({ n: scope.getCurrentPage(), total: scope.getTotalPages() })
    read()
    const offs = [scope.onPageChange(({ pageNumber, totalPages }) => setPage({ n: pageNumber, total: totalPages })), scroll.onLayoutReady(read), scope.onLayoutChange(read)]
    return () => offs.forEach((off) => off())
  }, [scroll])
  useEffect(() => {
    if (!zoom) return
    const scope = zoom.forDocument(DOC_ID)
    setLevel(scope.getState().currentZoomLevel)
    return scope.onStateChange((s) => setLevel(s.currentZoomLevel))
  }, [zoom])
  const z = zoom?.forDocument(DOC_ID)
  return (
    <div className="pdf-bar" role="toolbar" aria-label="PDF view">
      <span className="pdf-page" aria-live="polite" data-testid="pdf-page-indicator">{pageLabel(page.n, page.total)}</span>
      <span className="pdf-zoom">
        <button type="button" aria-label="Zoom out" disabled={!z || level === null || level <= MIN_ZOOM} onClick={() => z?.zoomOut()}>−</button>
        <span className="pdf-zoom-level" data-testid="pdf-zoom-level">{zoomLabel(level)}</span>
        <button type="button" aria-label="Zoom in" disabled={!z || level === null || level >= MAX_ZOOM} onClick={() => z?.zoomIn()}>+</button>
        <button type="button" onClick={() => z?.requestZoom(ZoomMode.FitWidth)} disabled={!z}>Fit</button>
      </span>
      <button type="button" className="pdf-download" aria-label="Download" title="Download" onClick={onDownload}><Icon name="download" /></button>
      {downloadNote && <span className="muted pdf-note">{downloadNote}</span>}
    </div>
  )
}

// A page's contents, drawn only while the page is within one container height of the viewport. The page's
// box is always full size, so the scroll height and layout don't depend on what is drawn.
function Lazy({ children }: { children: ReactNode }) {
  const [near, setNear] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const viewport = useContext(ViewportElementContext)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // The scroll container is the root: with the default root a margin does nothing about an overflow ancestor's clipping.
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { root: viewport?.current ?? null, rootMargin: '100% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [viewport])
  return <div ref={ref} className="pdf-lazy">{near ? children : null}</div>
}

// One page's raster. A failed page keeps the sheet and says so in the centre; there is no broken-image glyph.
function PageImage({ index, scale, width, height }: { index: number; scale: number; width: number; height: number }) {
  const { provides: render } = useRenderCapability()
  const docState = useDocumentState(DOC_ID)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const version = docState?.pageRefreshVersions[index] ?? 0
  // The scale the raster was made at, which follows the live scale once it has held still.
  const [renderScale, setRenderScale] = useState(scale)
  useEffect(() => {
    if (renderScale === scale) return
    const t = window.setTimeout(() => setRenderScale(scale), RASTER_SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [renderScale, scale])

  useEffect(() => {
    if (!render) return
    let made: string | null = null
    let cancelled = false
    const task = render.forDocument(DOC_ID).renderPage({ pageIndex: index, options: { scaleFactor: rasterScaleFor(width, height, renderScale, window.devicePixelRatio || 1, MAX_PAGE_RASTER_PIXELS), dpr: 1 } })
    task.wait((blob) => {
      if (cancelled) return
      made = URL.createObjectURL(blob)
      setUrl(made)
      setFailed(false)
    }, () => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (!made) task.abort({ code: PdfErrorCode.Cancelled, message: 'canceled render task' })
    }
  }, [render, index, width, height, renderScale, version])

  // Release a raster one commit after the one that replaced it, never while it is still on screen.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    const old = shown.current
    shown.current = url
    if (old && old !== url) URL.revokeObjectURL(old)
  }, [url])
  useEffect(() => () => { if (shown.current) URL.revokeObjectURL(shown.current); shown.current = null }, [])

  if (failed && !url) return <PdfSheetError index={index} />
  if (!url) return null
  return <img className="pdf-page-img" data-testid={`pdf-page-image-${index}`} src={url} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} />
}

function Pages() {
  const docState = useDocumentState(DOC_ID)
  const pageScale = docState?.scale ?? 1
  return (
    <ZoomGestureWrapper documentId={DOC_ID}>
      <Scroller
        documentId={DOC_ID}
        renderPage={(layout) => {
          const { pageIndex, width, height } = layout
          const scale = 'scale' in layout && typeof layout.scale === 'number' ? layout.scale : pageScale
          return (
            <div key={pageIndex} className="pdf-sheet" data-testid={`pdf-page-${pageIndex}`} style={{ width, height }}>
              <Lazy><PageImage index={pageIndex} scale={scale} width={width / scale} height={height / scale} /></Lazy>
            </div>
          )
        }}
      />
    </ZoomGestureWrapper>
  )
}

// Asks the scroller to lay out once the viewport has a size: pages measured before it does come out empty.
function LayoutBootstrap({ loaded }: { loaded: boolean }) {
  const { plugin } = useScrollPlugin()
  const { provides: viewport } = useViewportCapability()
  useEffect(() => {
    if (!plugin || !viewport || !loaded) return
    const refresh = () => {
      const m = viewport.forDocument(DOC_ID).getMetrics()
      if (m.clientWidth === 0 || m.clientHeight === 0) return
      ;(plugin as unknown as { refreshDocumentLayout?: (id: string) => void }).refreshDocumentLayout?.(DOC_ID)
    }
    const raf = window.requestAnimationFrame(refresh)
    const off = viewport.forDocument(DOC_ID).onViewportChange(refresh)
    return () => { window.cancelAnimationFrame(raf); off() }
  }, [plugin, viewport, loaded])
  return null
}

function Document({ onDownload, downloadNote }: Pick<PdfSurfaceProps, 'onDownload' | 'downloadNote'>) {
  const state = useDocumentState(DOC_ID)
  return (
    <div className="pdf" data-testid="pdf-view" data-status={state?.status === 'error' ? 'error' : state?.status === 'loaded' ? 'ready' : 'loading'}>
      <Toolbar onDownload={onDownload} downloadNote={downloadNote} />
      <Viewport>
        <DocumentContent documentId={DOC_ID}>
          {({ isLoaded, isError }) => {
            if (isError) return <div className="pdf-state" role="alert">This PDF couldn't be opened: it may be password-protected or broken.</div>
            if (!isLoaded) return <div className="pdf-state muted" role="status">Opening PDF…</div>
            return <><LayoutBootstrap loaded={isLoaded} /><Pages /></>
          }}
        </DocumentContent>
      </Viewport>
    </div>
  )
}

export default function PdfSurface({ src, name, onDownload, downloadNote }: PdfSurfaceProps) {
  // The engine runs in a worker (EmbedPDF's own), the WASM fetched from this app's /web/assets. The worker has a blob:
  // base, so the URL is made absolute.
  const { engine, error } = usePdfEngine(new URL(wasmUrl, location.href).href)
  const plugins = useMemo(() => [
    createPluginRegistration(DocumentManagerPluginPackage, { initialDocuments: [{ url: src, documentId: DOC_ID, name, mode: 'full-fetch', autoActivate: true }] }),
    createPluginRegistration(ViewportPluginPackage),
    createPluginRegistration(ScrollPluginPackage),
    createPluginRegistration(RenderPluginPackage),
    // Automatic fits the sheet to the width when the pane is narrower than the page (a phone), and is 100% otherwise.
    createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.Automatic, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }),
  ], [src, name])
  if (error) return <div className="pdf-state" role="alert">The PDF engine couldn't start: {error.message}</div>
  if (!engine) return <div className="pdf-state muted" role="status">Loading PDF viewer…</div>
  return (
    <EmbedPDF engine={engine} plugins={plugins} key={src}>
      <Document onDownload={onDownload} downloadNote={downloadNote} />
    </EmbedPDF>
  )
}

