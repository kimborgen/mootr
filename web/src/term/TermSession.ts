// One xterm per terminal view. All viewers of an agent share one size (one tmux window):
// this one claims it when it opens, resizes, is clicked, or types; otherwise it shows the
// shared size scaled to fit. The daemon tells every viewer the size with a NUL-prefixed
// message. Framework-free; TerminalView mounts it.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api, terminalOriginFor } from '../api'
import { live, stateLabel } from '../format'
import { byId, getData } from '../store'
import type { PlainShell } from '../types'
import { coarse } from '../ui/phone'

export const BASE_FONT = 13
// A pane that keeps changing size (a window or split being dragged) settles for this long
// before the terminal claims the new size, so tmux and the harness redraw once, not per frame.
const SETTLE_MS = 100
// The symbols TUIs draw (⏺ ⎿ ❯ …) come from the Stam Terminal Symbols faces (fonts-stam.css),
// which download only when a glyph needs them.
const FONT = "'Source Code Pro Variable', 'Stam Terminal Symbols', ui-monospace, Menlo, monospace"

export const sessions = new Set<TermSession>()
export type TermKey = 'esc' | 'tab' | 'backtab' | 'up' | 'down' | 'left' | 'right' | 'ctrl-c' | 'enter'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
export function termTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  // The 16 ANSI colours come from the tokens too, as in mail's terminal excerpts; xterm's
  // own defaults clash with the design system.
  const ansi = Object.fromEntries(ANSI.map((name, i) => [name, v(`--ansi-${i}`)]))
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--term-fg'), selectionBackground: v('--selection-bg'), ...ansi }
}
export function retheme() { for (const s of sessions) s.term.options.theme = termTheme() }

// The symbol faces load once, with the first terminal, and every terminal then repaints its
// glyphs: xterm measures its cells from the primary face, so the symbols change no metrics.
let symbolsLoading = false
function loadSymbols() {
  if (symbolsLoading) return
  symbolsLoading = true
  // One character from each of the three faces: ⏺ (symbols), ⎿ (23BF), ⣿ (braille).
  document.fonts?.load(`${BASE_FONT}px 'Stam Terminal Symbols'`, '\u23FA\u23BF\u28FF')
    .then(() => { for (const s of sessions) s.refreshGlyphs() }, () => {})
}

// The shared size (the last claim, tmux's) is another viewer's when it differs from the size
// this viewer claimed: that is the case the hint names.
export function sizedElsewhere(shared: [number, number] | null, mine: [number, number] | null) {
  return !!shared && !!mine && (shared[0] !== mine[0] || shared[1] !== mine[1])
}
// Where a terminal of `content` pixels sits in a pane of `pane` pixels, centred, never past
// the start edge: a shared size smaller than the pane sits in its middle.
export function centreOffset(pane: number, content: number) {
  return Math.max(0, Math.floor((pane - content) / 2))
}

// Input areas: the prompt input stands in for each harness's own input box, so every agent
// hides it by default; the pane menu shows it again per agent, per browser.
const inputPref: Record<string, 'show' | 'hide'> = (() => { try { return JSON.parse(localStorage.getItem('stam/input-areas') ?? 'null') ?? {} } catch { return {} } })()
export const hidesInput = (id: string) => (inputPref[id] ? inputPref[id] === 'hide' : true)
export function setHideInput(id: string, on: boolean) {
  inputPref[id] = on ? 'hide' : 'show'
  try { localStorage.setItem('stam/input-areas', JSON.stringify(inputPref)) } catch {}
  for (const s of sessions) if (s.id === id) s.crop()
}

export class TermSession {
  readonly el: HTMLDivElement
  readonly term: Terminal
  private fit: FitAddon
  private inner: HTMLDivElement
  private status: HTMLDivElement
  private ws: WebSocket | null = null
  private shared: [number, number] | null = null
  // The size this viewer last set; while the shared size is this, the size is this viewer's.
  private mine: [number, number] | null = null
  // The pane's size in pixels when this viewer last claimed.
  private claimedAt: [number, number] = [0, 0]
  private closed = false
  private opened = false
  // Set while stam's conversation view of this agent is on screen beside it (hide()): the
  // terminal stays disconnected until it shows again.
  private paused = false
  private typing = false
  private k = 0
  private cropTimer = 0
  private settleTimer = 0
  // The pane's size when it last set the terminal's, and how many pixels its height has
  // lost (or, below zero, gained) since while the human writes (see paneResized()).
  private rest: [number, number] = [0, 0]
  private held = 0
  private ro: ResizeObserver
  private hint: HTMLButtonElement
  ended = false
  readonly id: string
  readonly sh?: PlainShell

  // `sh` makes it a plain terminal: { id, machine, cwd }.
  constructor(id: string, sh?: PlainShell) {
    this.id = id
    this.sh = sh
    this.el = document.createElement('div')
    this.el.className = 'term-view'
    this.term = new Terminal({ fontSize: BASE_FONT, fontFamily: FONT, theme: termTheme(), scrollback: 5000, allowProposedApi: true })
    this.fit = new FitAddon()
    this.term.loadAddon(this.fit)
    this.status = document.createElement('div')
    this.status.className = 'term-status'
    this.hint = document.createElement('button')
    this.hint.className = 'term-hint'
    this.hint.type = 'button'
    this.hint.textContent = 'Sized for another screen · click to fit'
    this.hint.hidden = true
    this.hint.addEventListener('click', () => this.claim())
    // The terminal lives in `inner`, which grows past the pane's bottom edge by the
    // harness's input area when that's hidden (see crop()).
    this.inner = document.createElement('div')
    this.inner.className = 'term-inner'
    this.el.append(this.inner, this.status, this.hint)
    this.el.addEventListener('focusin', () => { this.typing = true; this.crop() })
    this.el.addEventListener('focusout', () => { this.typing = false; setTimeout(() => this.crop(), 0) })
    // Typing claims the size; xterm's own answers to the harness's terminal queries come
    // through onData too, after every redraw, so they mustn't.
    this.term.onData((d) => { if (this.ws?.readyState === 1) this.ws.send(d) })
    this.el.addEventListener('keydown', () => this.claim(), true)
    this.el.addEventListener('paste', () => this.claim(), true)
    this.el.addEventListener('mousedown', () => this.claim())
    this.touch()
    loadSymbols()
    this.ro = new ResizeObserver(() => this.paneResized())
    this.ro.observe(this.el)
    sessions.add(this)
  }
  // Touch: a vertical drag scrolls as the wheel does (xterm turns it into mouse wheel input
  // when tmux or the harness tracks the mouse, and scrolls its own buffer otherwise), and a
  // tap doesn't raise the keyboard: the pane's keyboard button does, so reading never
  // covers half the screen. Listening in the capture phase keeps xterm's own touch handling,
  // which only scrolls its buffer, out of it.
  private touch() {
    let y: number | null = null, acc = 0
    this.el.addEventListener('touchstart', (e) => {
      this.claim()
      if (e.touches.length !== 1) { y = null; return }
      y = e.touches[0].clientY
      acc = 0
    }, { capture: true, passive: true })
    this.el.addEventListener('touchmove', (e) => {
      if (y === null || e.touches.length !== 1) return
      e.preventDefault()
      e.stopPropagation()
      const t = e.touches[0]
      acc += y - t.clientY
      y = t.clientY
      const step = this.cellHeight()
      const screen = this.term.element?.querySelector('.xterm-screen')
      while (screen && Math.abs(acc) >= step) {
        const dir = Math.sign(acc)
        acc -= dir * step
        screen.dispatchEvent(new WheelEvent('wheel', { deltaY: dir, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }))
      }
    }, { capture: true, passive: false })
    this.el.addEventListener('touchend', (e) => { if (y !== null) e.preventDefault(); y = null }, { capture: true, passive: false })
  }
  private cellHeight() {
    // xterm keeps its cell size private; this and crop() are the places stam reads it.
    const core = (this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core
    return core?._renderService?.dimensions?.css?.cell?.height || (this.term.options.fontSize ?? BASE_FONT) * 1.2
  }
  // A key a phone's keyboard lacks (the key row under a terminal), as if typed here.
  key(name: TermKey) {
    const arrow = (c: string) => (this.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c
    const seq = { esc: '\x1b', tab: '\t', backtab: '\x1b[Z', up: arrow('A'), down: arrow('B'), right: arrow('C'), left: arrow('D'), 'ctrl-c': '\x03', enter: '\r' }[name]
    if (this.ws?.readyState === 1) { this.claim(); this.ws.send(seq) }
  }
  blur() { this.term.blur() }
  // While the human writes in the prompt input below, its box grows a line at a time and
  // takes that height from the pane (and on a phone the keyboard takes more, while the
  // bottom navigation steps aside). Resizing tmux for each change makes the harness redraw
  // its whole screen every time, so the terminal keeps its size instead and its top rows
  // slide under the pane's top edge; the newest output at the bottom stays in view. Any
  // other change of the pane's size is claimed once it settles.
  private paneResized() {
    if (!this.visible()) return
    const w = this.el.clientWidth, h = this.el.clientHeight
    const composing = !!document.activeElement?.closest('#w-bottom')
    const held = composing && w === this.rest[0] ? this.rest[1] - h : 0
    if (held !== this.held) { this.held = held; this.place() }
    if (held) return
    this.rest = [w, h]
    this.resize()
  }
  // The terminal's box: `held` pixels taller than the pane (a growing prompt input) and
  // `k` rows more below its bottom edge (the harness's hidden input area, see crop()). The
  // held pixels come off the bottom while the screen ends in blank rows there (a short
  // conversation), and off the top past those.
  private place() {
    const cell = this.cellHeight()
    const extra = this.held + (this.k ? Math.ceil(this.k * cell) : 0)
    this.inner.style.height = extra ? `calc(100% ${extra < 0 ? '-' : '+'} ${Math.abs(extra)}px)` : ''
    const slide = this.held > 0 ? Math.max(0, this.held - Math.floor(this.blankRows() * cell)) : 0
    this.inner.style.marginTop = slide ? `-${slide}px` : ''
  }
  // Blank rows at the bottom of the screen, above the `k` hidden ones.
  private blankRows(k = this.k) {
    const b = this.term.buffer.active
    let n = 0
    for (let i = this.term.rows - k - 1; i >= 0 && !b.getLine(b.viewportY + i)?.translateToString(true).trim(); i--) n++
    return n
  }
  private agent() { return this.sh ? undefined : byId(this.id) }
  visible() { return this.el.isConnected && !this.el.closest('[hidden]') && this.el.offsetWidth > 0 }
  show() {
    this.paused = false
    if (!this.opened && this.visible()) { this.term.open(this.inner); this.opened = true }
    this.sync()
    // The layout shows every view on each change, a window drag's included.
    if (this.opened) this.resize()
  }
  // Disconnects the tmux attach and keeps it down until show(): the conversation view is what
  // the human sees, so nothing streams the terminal (S-166).
  hide() {
    this.paused = true
    this.pending = null
    const ws = this.ws
    if (!ws) return
    this.ws = null
    ws.close()
  }
  focus() { this.term.focus() }
  // The symbol faces have loaded. The DOM renderer measured letter spacing with the fallback
  // glyphs, and only a font change clears that cache (setFont). Setting the same stack again
  // fires nothing, so the stack is changed and restored, which re-measures without changing
  // the cell size or the tmux size.
  refreshGlyphs() {
    const stack = this.term.options.fontFamily
    this.term.options.fontFamily = `${stack}, monospace`
    this.term.options.fontFamily = stack
    this.term.refresh(0, Math.max(0, this.term.rows - 1))
  }
  // The pane's size may have changed: once it settles, claim it if it did. The layout
  // calls this on changes that leave the pane as it was, and those mustn't take the size
  // from another viewer.
  resize() {
    clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => {
      if (!this.visible()) return
      if (this.el.clientWidth !== this.claimedAt[0] || this.el.clientHeight !== this.claimedAt[1]) this.claim()
      this.showShared()
    }, SETTLE_MS)
  }
  // Connects while the agent runs; reconnects after a restart.
  sync() {
    if (this.sh) { if (!this.ws && !this.pending && this.opened && !this.closed && !this.ended && !this.paused) this.connect(); return }
    const a = this.agent()
    const running = a && live(a)
    this.status.textContent = !a ? 'This agent is gone.' : running ? '' : `${a.name} is ${stateLabel(a)}. Resume it from its menu.`
    if (running && !this.ws && !this.pending && this.opened && !this.closed && !this.paused) this.connect()
  }
  private connect() {
    const own = this.ownSize()
    const size = `cols=${own.cols}&rows=${own.rows}`
    // A terminal on another machine opens at that machine's serve origin when this daemon doesn't relay it
    // (auth.humanStrict, S-544): no token, the machine's tailscale serve proves the human opened it.
    const machine = this.sh ? this.sh.machine : byId(this.id)?.machine
    const remote = machine && machine !== getData().machine ? terminalOriginFor(machine, getData().machines.find((m) => m.name === machine)?.terminalOrigin) : undefined
    const tty = this.sh ? `/api/shells/${this.sh.id}/tty` : `/api/agents/${this.id}/tty`
    if (remote) return this.open(`${remote.replace(/^http/, 'ws')}${tty}?${size}`)
    // This daemon's socket opens with a one-time ticket, never the token (S-742).
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const query = `${this.sh ? `machine=${encodeURIComponent(this.sh.machine)}&` : ''}${size}`
    // Marks the attempt in flight so sync() doesn't start a second one while the ticket is fetched.
    const pending = (this.pending = {})
    api<{ ticket: string }>('POST', '/api/tickets', { kind: 'tty', path: tty }).then(
      ({ ticket }) => { if (this.pending === pending) { this.pending = null; this.open(`${proto}://${location.host}${tty}?ticket=${encodeURIComponent(ticket)}&${query}`) } },
      () => { if (this.pending === pending) { this.pending = null; if (!this.closed) setTimeout(() => this.sync(), 2000) } },
    )
  }
  private pending: object | null = null
  private open(url: string) {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.term.reset()
    this.shared = null
    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data[0] === '\x00') {
        try { const m = JSON.parse(e.data.slice(1)); if (m.size) { this.shared = m.size; this.showShared() } } catch {}
        return
      }
      this.term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
      if (this.hiding() || this.held > 0) { clearTimeout(this.cropTimer); this.cropTimer = window.setTimeout(() => { this.crop(); this.place() }, 300) }
    }
    // A newly opened view takes over the size, measured now that it's laid out.
    ws.onopen = () => setTimeout(() => this.claim(), 50)
    ws.onclose = async () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.sh) {
        // The shell exited: its tab says so.
        const list = await api<PlainShell[]>('GET', '/api/shells').catch(() => null)
        if (list && this.sh.machine === getData().machine && !list.some((x) => x.id === this.sh!.id)) { this.ended = true; this.status.textContent = 'This terminal ended.'; return }
      }
      if (!this.closed) setTimeout(() => this.sync(), 2000)
    }
  }
  private ownSize() {
    if (this.term.options.fontSize !== BASE_FONT) this.term.options.fontSize = BASE_FONT
    const p = this.opened ? this.proposed() : null
    return p && p.cols > 0 ? { cols: p.cols, rows: p.rows } : { cols: 100, rows: 30 }
  }
  // addon-fit's proposeDimensions reads xterm's private render dimensions without a guard,
  // so it throws while a terminal is opening or hidden and the renderer isn't ready. Only
  // call it once those exist, and never let it break the terminal.
  private proposed(): { cols: number; rows: number } | undefined {
    const core = (this.term as unknown as { _core?: { _renderService?: { dimensions?: unknown } } })._core
    if (!core?._renderService?.dimensions || !this.term.element?.parentElement) return undefined
    try { return this.fit.proposeDimensions() } catch { return undefined }
  }
  // Hiding the input area: the harness draws its input box at the bottom of the screen;
  // the terminal runs that many rows taller than the pane, so the box falls below the
  // edge. It shows again while the terminal has focus, for typing.
  private hiding() { return !this.sh && hidesInput(this.id) && !this.typing }
  private inputTop() {
    const b = this.term.buffer.active, rows = this.term.rows
    const lines = Array.from({ length: rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
    const h = this.agent()?.harness
    let at = -1
    if (h === 'claude') {
      const rules = lines.map((l, i) => (/^─{8,}\s*$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0)
      at = rules.length >= 2 ? rules[rules.length - 2] : rules[0] ?? -1
    } else if (h === 'codex') {
      for (let i = rows - 1; i >= 0; i--) if (lines[i].trimStart().startsWith('›')) { at = i; break }
    } else if (h === 'opencode') {
      for (let i = rows - 1; i >= 0; i--) if (/^\s*┃/.test(lines[i])) { at = i; while (at > 0 && /^\s*┃/.test(lines[at - 1])) at--; break }
    }
    return at
  }
  // Only the viewer whose size the window has crops, and only it claims the size its crop
  // changes: another viewer cropping on each redraw took the size back and forth with it.
  // The crop is the input area's rows, from its top to the screen's last text, not to the
  // screen's bottom: blank rows under a short conversation would grow it with every resize.
  crop() {
    if (!this.opened || this.closed) return
    let k = 0
    const owner = this.owner()
    if (this.hiding() && owner && this.term.options.fontSize === BASE_FONT) {
      const top = this.inputTop()
      k = top >= 0 ? Math.min(14, Math.max(0, this.term.rows - this.blankRows(0) - top)) : this.k
    }
    if (k === this.k) return
    this.k = k
    this.place()
    if (owner) this.claim()
  }
  private owner() { return !!this.shared && !!this.mine && this.shared[0] === this.mine[0] && this.shared[1] === this.mine[1] }
  private claim() {
    if (this.ws?.readyState !== 1 || !this.visible()) return
    const own = this.ownSize()
    this.mine = [own.cols, own.rows]
    this.claimedAt = [this.el.clientWidth, this.el.clientHeight]
    if (!this.shared || own.cols !== this.shared[0] || own.rows !== this.shared[1]) this.ws.send('\x00' + JSON.stringify(own))
    else this.showShared()
    this.showHint()
  }
  private showShared() {
    if (!this.shared || !this.visible()) return
    const [cols, rows] = this.shared, own = this.ownSize()
    let font = BASE_FONT
    if (own.cols < cols || own.rows < rows) {
      font = Math.max(5, Math.floor(BASE_FONT * Math.min(own.cols / cols, own.rows / rows) * 2) / 2)
      this.term.options.fontSize = font
      for (let p = this.proposed(); font > 5 && p && (p.cols < cols || p.rows < rows); p = this.proposed()) this.term.options.fontSize = font -= 0.5
    }
    // xterm rewraps old lines on a resize and tmux's redraw doesn't overwrite their
    // tails, so clear first; tmux's redraw arrives after the size message.
    if (this.term.cols !== cols || this.term.rows !== rows) { this.term.resize(cols, rows); this.term.write('\x1b[H\x1b[2J') }
    this.centre()
    this.showHint()
  }
  // A shared size smaller than the pane sits in its middle, on the desktop. A phone keeps it
  // at the top left, as its layout has always had it.
  private centre() {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) return
    const desk = !coarse()
    screen.style.left = desk ? `${centreOffset(this.inner.clientWidth, screen.offsetWidth)}px` : ''
    screen.style.top = desk ? `${centreOffset(this.inner.clientHeight, screen.offsetHeight)}px` : ''
  }
  // The hint says the screen is sized for another, and a click claims this viewer's size. The
  // desktop only: a phone's layout has none. It compares with the size claimed, not ownSize(),
  // which would reset a font scaled to fit the shared size. It shows only where a row is free
  // above the screen, so it never covers terminal text; otherwise a click in the pane claims.
  private showHint() {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen')
    const top = this.inner.offsetTop + (parseFloat(screen?.style.top ?? '') || 0)
    this.hint.hidden = coarse() || !sizedElsewhere(this.shared, this.mine) || top < this.cellHeight()
  }
  // A plain terminal's shell ends with its tab.
  kill() { if (this.sh) api('POST', `/api/shells/${this.sh.id}/kill`, { machine: this.sh.machine }).catch(() => {}) }
  destroy() {
    this.closed = true
    clearTimeout(this.cropTimer)
    clearTimeout(this.settleTimer)
    this.ro.disconnect()
    this.pending = null
    this.ws?.close()
    sessions.delete(this)
    this.el.remove()
    // xterm's viewport schedules a 0 ms sync when it opens; disposing before that fires
    // makes the callback read a render service that is already gone and throw. Let it run
    // first — it was scheduled earlier, so a 0 ms defer orders it ahead of the dispose.
    const term = this.term
    setTimeout(() => term.dispose(), 0)
  }
}
