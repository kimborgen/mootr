// The stories page: the sidebar of stories by group (a drawer on a phone), and the open story
// as documentation (What, When, Code, Rules), then each of its states in frames at 360 and
// 1280 px wide, light and dark: one of the four, or all four.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import { usePhone } from '../ui/phone'
import { STORIES, storyById, type Entry } from './registry'
import { GROUPS, type Fit } from './types'

const REPO = 'https://github.com/kimborgen/mootr/blob/main/'
const WIDTHS = [360, 1280] as const
const THEMES = ['light', 'dark'] as const
type Width = (typeof WIDTHS)[number]
type Theme = (typeof THEMES)[number]
interface View { all: boolean; width: Width; theme: Theme; zoom: 1 | 2 }

const KEY = 'stam/stories'
const pageTheme = (): Theme => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) as Theme
function loadView(phone: boolean): View {
  const v: View = { all: false, width: phone ? 360 : 1280, theme: pageTheme(), zoom: 1 }
  try { return { ...v, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return v }
}
const saveView = (v: View) => { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch {} }

const storyInHash = () => new URLSearchParams(location.hash.slice(1)).get('story')

// A rule's text: `code` and [links](url), nothing more.
export function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>
    const m = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
    if (m) return <a key={i} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function Viewer() {
  const phone = usePhone()
  const [id, setId] = useState(() => storyById(storyInHash())?.id ?? STORIES[0]?.id)
  const [drawer, setDrawer] = useState(false)
  const [view, setView] = useState(() => loadView(phone))
  useEffect(() => {
    const on = () => { const s = storyById(storyInHash()); if (s) setId(s.id) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  useEffect(() => { if (!phone) setDrawer(false) }, [phone])
  const story = storyById(id ?? null)
  const open = (s: Entry) => { history.replaceState(null, '', '#story=' + s.id); setId(s.id); setDrawer(false); document.querySelector('.sb-main')?.scrollTo(0, 0) }
  const change = (p: Partial<View>) => { const v = { ...view, ...p }; setView(v); saveView(v) }

  return (
    <div className={'sb' + (drawer ? ' drawer-open' : '')}>
      <header className="sb-bar">
        <button className="icon-btn sb-menu" aria-label="Stories" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}><Icon name="menu" /></button>
        <span className="sb-bar-title">{story?.name ?? 'Stories'}</span>
      </header>
      {drawer ? <div className="sb-scrim" onClick={() => setDrawer(false)} /> : null}
      <nav className="sb-nav" aria-label="Stories">
        <div className="sb-title">Stories</div>
        {GROUPS.map((g) => {
          const items = STORIES.filter((s) => s.group === g)
          return items.length ? <Fragment key={g}>
            <div className="eyebrow sb-group">{g}</div>
            {items.map((s) => <button key={s.id} className={'sb-item' + (s.id === id ? ' sel' : '')} aria-current={s.id === id ? 'page' : undefined} onClick={() => open(s)}>{s.name}</button>)}
          </Fragment> : null
        })}
      </nav>
      <main className="sb-main">{story ? <StoryPage key={story.id} s={story} view={view} change={change} /> : <div className="story-pad"><p className="muted">No stories yet.</p></div>}</main>
    </div>
  )
}

function StoryPage({ s, view, change }: { s: Entry; view: View; change: (p: Partial<View>) => void }) {
  const frames = view.all ? WIDTHS.flatMap((w) => THEMES.map((t) => ({ w, t }))) : [{ w: view.width, t: view.theme }]
  return (
    <article className="sb-doc">
      <div className="eyebrow">{s.group}</div>
      <h1>{s.name}</h1>
      <section><h2>What</h2><p>{inline(s.what)}</p></section>
      <section><h2>When</h2><p>{inline(s.when)}</p></section>
      <section><h2>Code</h2><ul className="sb-code">{s.code.map((c) => <li key={c}><a className="mono" href={REPO + c.split('#')[0]} target="_blank" rel="noreferrer">{c}</a></li>)}</ul></section>
      <section><h2>Rules</h2><ul className="sb-rules">{s.rules.map((r, i) => <li key={i}>{inline(r)}</li>)}</ul></section>
      <section>
        <h2>States</h2>
        <div className="sb-controls" role="group" aria-label="Frames">
          <Seg label="Show" options={[['one', 'One'], ['all', 'All four']]} value={view.all ? 'all' : 'one'} set={(v) => change({ all: v === 'all' })} />
          {view.all ? null : <>
            <Seg label="Width" options={WIDTHS.map((w) => [String(w), `${w} px`])} value={String(view.width)} set={(v) => change({ width: Number(v) as Width })} />
            <Seg label="Theme" options={THEMES.map((t) => [t, t === 'light' ? 'Light' : 'Dark'])} value={view.theme} set={(v) => change({ theme: v as Theme })} />
          </>}
          <Seg label="Zoom" options={[['1', '1×'], ['2', '2×']]} value={String(view.zoom)} set={(v) => change({ zoom: Number(v) as 1 | 2 })} />
        </div>
        {s.states.map((st, i) => (
          <div key={st.name} className="sb-state">
            <h3>{st.name}</h3>
            <div className={'sb-frames' + (view.all ? ' all' : '')}>
              {frames.map((f) => <Frame key={f.w + f.t} id={s.id} state={i} width={f.w} theme={f.t} height={st.height} fit={st.fit ?? s.fit ?? 'actual'} zoom={view.zoom} />)}
            </div>
          </div>
        ))}
      </section>
    </article>
  )
}

function Seg({ label, options, value, set }: { label: string; options: string[][]; value: string; set: (v: string) => void }) {
  return <div className="sb-seg" role="group" aria-label={label}><span className="muted">{label}</span>
    {options.map(([v, text]) => <button key={v} className={'btn' + (v === value ? ' on' : '')} aria-pressed={v === value} onClick={() => set(v)}>{text}</button>)}</div>
}

// One state in an iframe at its real width. 'actual' shows it at its real size (or the 2× zoom)
// and scrolls sideways inside its box when wider than the column; 'page' shrinks it to fit.
function Frame({ id, state, width, theme, height, fit, zoom }: { id: string; state: number; width: Width; theme: Theme; height?: number; fit: Fit; zoom: 1 | 2 }) {
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [avail, setAvail] = useState<number>(width)
  const [h, setH] = useState(height ?? 120)
  useLayoutEffect(() => {
    const el = box.current!
    const ro = new ResizeObserver(() => setAvail(el.clientWidth))
    ro.observe(el)
    setAvail(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // Its content sizes the frame, unless the state gives a height (an overlay has none of its own).
  const measure = () => {
    if (height) return
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    // The body, not the document: the document is never shorter than the frame itself.
    const fit = () => setH(Math.max(48, Math.ceil(doc.body.getBoundingClientRect().height)))
    fit()
    new ResizeObserver(fit).observe(doc.body)
  }
  const scale = fit === 'page' ? Math.min(1, avail / width) : zoom
  const src = `${location.pathname}?frame=${encodeURIComponent(id)}&state=${state}&theme=${theme}`
  return (
    <figure className={`sb-frame w${width}`} style={width === 360 ? { flexBasis: Math.ceil(width * scale) } : undefined}>
      <figcaption className="muted">{width} px · {theme}{scale !== 1 ? ` · shown at ${Math.round(scale * 100)}%` : ''}</figcaption>
      <div className={'sb-frame-box ' + fit} ref={box}>
        <div className="sb-frame-size" style={{ width: Math.ceil(width * scale), height: Math.ceil(h * scale) }}>
          <iframe ref={frame} title={`${id} ${state} at ${width} px, ${theme}`} src={src} loading="lazy" onLoad={measure}
            style={{ width, height: h, transform: scale !== 1 ? `scale(${scale})` : undefined }} />
        </div>
      </div>
    </figure>
  )
}
