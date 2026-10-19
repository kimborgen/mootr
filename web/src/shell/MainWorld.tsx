// Main: the current world's layout tree, rendered. Splits hold panes side by side or
// stacked with separators between them; a pane holds a tab strip and its views' elements.
// Tabs drag between panes, agents drag in from the tree, and a drop on a pane's edge
// splits it that way.
import { useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'
import { chooseView } from '../actions'
import { byId, useData } from '../store'
import { toast } from '../ui/menu'
import { useUi } from '../ui/state'
import { ThreadArchive } from '../views/ThreadView'
import { choiceOf, switchable } from '../views/agent-view-choice'
import { isRapid, setRapid } from '../views/rapid'
import { viewMeta } from '../views/registry'
import { ItsaChips, WaitBadges, WaitThinBar } from '../waits'
import { beside } from './beside'
import { Tab, TabBar } from './Tab'
import * as shell from './layout'
import { foreignImage, visibleActive } from '../image-tab'
import type { Leaf, Node, Side, World } from './layout'

type Zone = { strip?: boolean; before?: string | null; side?: Side }
type Drop = { pane: string; zone: Zone; rect?: { left: number; top: number; width: number; height: number } }

export function MainWorld() {
  const st = shell.useShell()
  const w = shell.mainWorld()
  const [drop, setDrop] = useState<Drop | null>(null)
  if (!shell.leafById(w, w.focused)) w.focused = shell.leaves(w.root)[0].id
  // On a phone, main shows only its focused pane.
  const root: Node = shell.isPhone() ? shell.focusedLeaf(w) : w.root
  // After each layout, the views on screen show (a terminal opens and claims its size).
  // An agent's terminal stays detached while its conversation is on screen (S-166): what's on
  // screen is the focused pane on a phone, so a terminal in another pane doesn't show.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      const { show, hide } = beside(shell.leaves(w.root), shell.leaves(root))
      for (const k of hide) shell.viewHandle(k)?.hide?.()
      for (const k of show) shell.viewHandle(k)?.show?.()
    })
    return () => cancelAnimationFrame(id)
  })
  return (
    <section className="world" id="w-main" aria-label="Main">
      <NodeView n={root} w={w} world={st.current} drop={drop} setDrop={setDrop} root />
      {drop?.rect ? <div className="drop-preview" style={{ position: 'fixed', ...drop.rect }} /> : null}
    </section>
  )
}

interface NodeProps { n: Node; w: World; world: string | null; drop: Drop | null; setDrop: (d: Drop | null) => void; root?: boolean; style?: React.CSSProperties }

function NodeView({ n, w, world, drop, setDrop, root, style }: NodeProps) {
  if (!n.split) return <Pane l={n} w={w} world={world} drop={drop} setDrop={setDrop} root={root} style={style} />
  const items: React.ReactNode[] = []
  n.children.forEach((c, i) => {
    items.push(<NodeView key={c.id} n={c} w={w} world={world} drop={drop} setDrop={setDrop} style={{ flex: `${n.sizes[i] ?? 1} 1 0` }} />)
    if (i < n.children.length - 1) items.push(<SplitSep key={c.id + '-sep'} node={n} i={i} />)
  })
  return <div className={`split ${n.split}${root ? ' world-root' : ''}`} style={style}>{items}</div>
}

function SplitSep({ node, i }: { node: shell.Split; i: number }) {
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const sep = e.currentTarget
    sep.setPointerCapture(e.pointerId)
    sep.classList.add('drag')
    const a = sep.previousElementSibling as HTMLElement, b = sep.nextElementSibling as HTMLElement
    const row = node.split === 'row'
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
    const total = row ? ra.width + rb.width : ra.height + rb.height
    const start = row ? ra.left : ra.top
    const sum = (node.sizes[i] ?? 1) + (node.sizes[i + 1] ?? 1)
    const move = (ev: PointerEvent) => {
      const pos = Math.min(Math.max((row ? ev.clientX : ev.clientY) - start, 60), total - 60)
      node.sizes[i] = (sum * pos) / total
      node.sizes[i + 1] = sum - node.sizes[i]
      a.style.flex = `${node.sizes[i]} 1 0`
      b.style.flex = `${node.sizes[i + 1]} 1 0`
    }
    const up = () => {
      sep.classList.remove('drag')
      sep.removeEventListener('pointermove', move)
      sep.removeEventListener('pointerup', up)
      shell.resized(node)
    }
    sep.addEventListener('pointermove', move)
    sep.addEventListener('pointerup', up)
  }
  return <div className={'sep ' + (node.split === 'row' ? 'v' : 'h')} onPointerDown={down} />
}

// Where a drop lands: on the tab strip, on one of the pane's four edges (a split that
// way), or in the middle (a new tab).
function dropZone(pane: HTMLElement, e: { clientX: number; clientY: number }): Zone {
  const r = pane.getBoundingClientRect()
  const tabbar = pane.querySelector('.tabbar')?.getBoundingClientRect()
  if (tabbar && e.clientY <= tabbar.bottom) {
    const tab = [...pane.querySelectorAll<HTMLElement>('.tab')].find((t) => { const b = t.getBoundingClientRect(); return e.clientX < b.left + b.width / 2 })
    return { strip: true, before: tab?.dataset.key ?? null }
  }
  if (shell.isPhone()) return {}
  const bx = Math.min(72, r.width * 0.24), by = Math.min(72, r.height * 0.24)
  const d: Record<Side, number> = { left: (e.clientX - r.left) / bx, right: (r.right - e.clientX) / bx, up: (e.clientY - r.top) / by, down: (r.bottom - e.clientY) / by }
  const [side, v] = (Object.entries(d) as [Side, number][]).sort((a, b) => a[1] - b[1])[0]
  return v < 1 ? { side } : {}
}
function previewRect(body: HTMLElement, z: Zone) {
  const r = body.getBoundingClientRect()
  const f = 0.42
  if (z.side === 'right') return { left: r.right - r.width * f, top: r.top + 8, width: r.width * f - 8, height: r.height - 16 }
  if (z.side === 'left') return { left: r.left + 8, top: r.top + 8, width: r.width * f, height: r.height - 16 }
  if (z.side === 'down') return { left: r.left + 8, top: r.bottom - r.height * f, width: r.width - 16, height: r.height * f - 8 }
  if (z.side === 'up') return { left: r.left + 8, top: r.top + 8, width: r.width - 16, height: r.height * f }
  return { left: r.left + 12, top: r.top + 12, width: r.width - 24, height: r.height - 24 }
}

const accepts = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes('text/stam-tab') || e.dataTransfer.types.includes('text/stam-agent'))

function Pane({ l, w, world, drop, setDrop, style }: { l: Leaf; w: World; world: string | null; drop: Drop | null; setDrop: (d: Drop | null) => void; root?: boolean; style?: React.CSSProperties }) {
  const paneRef = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  // Tabs name what each pane shows, so main hides them only when the world shows one thing.
  // "Show tab bar" overrides.
  // An image tab another device (or this page before a reload) opened has nothing to show here: hidden, not closed.
  const tabs = l.tabs.filter((k) => !foreignImage(k))
  const active = visibleActive(l)
  const alone = shell.leaves(w.root).length === 1 && tabs.length <= 1
  // An agent's world always shows its tab bar, even with one tab: the bar carries the agent's waits (S-1659).
  const agentWorld = !!byId(world)
  // A phone shows one pane, so its strip lists every tab in the world, always, with the
  // pane's menu and, for a terminal, its keyboard: there's no hover or right-click there.
  const phone = shell.isPhone()
  // An agent's terminal or conversation, where its harness has both: the switch between them
  // sits in the strip, so the strip shows.
  const shows = choiceOf(active)
  const sw = switchable(active, byId(shows?.id))
  const bar = phone || !alone || !!l.showTabs || sw || agentWorld
  const strip = phone ? shell.leaves(w.root).flatMap((x) => x.tabs.filter((k) => !foreignImage(k)).map((k) => ({ k, pane: x.id }))) : tabs.map((k) => ({ k, pane: l.id }))
  const term = phone && /^(agent|shell):/.test(active ?? '')
  // A phone's open mail thread keeps its Archive here, not in the thread's scrolling header.
  const thread = phone && active?.startsWith('thread:') ? active.slice(7) : null
  for (const k of tabs) shell.makeView(k)
  // The pane adopts its views' elements; the active one shows. Views leaving go back to the
  // store, alive.
  useLayoutEffect(() => {
    const b = body.current!
    for (const el of [...b.children] as HTMLElement[]) if (el.dataset.key && !tabs.includes(el.dataset.key)) shell.viewStore().append(el)
    for (const k of tabs) {
      const el = shell.viewElement(k)
      if (el.parentNode !== b) b.append(el)
      el.hidden = k !== active
    }
  }, [tabs.join('\n'), active])
  useLayoutEffect(() => {
    const b = body.current!
    return () => { for (const el of [...b.children] as HTMLElement[]) if (el.dataset.key) shell.viewStore().append(el) }
  }, [])
  // Wheel scrolls an overflowing tab strip sideways.
  useLayoutEffect(() => {
    const tabs = tabsRef.current
    if (!tabs) return
    const wheel = (e: WheelEvent) => {
      if (tabs.scrollWidth <= tabs.clientWidth) return
      e.preventDefault()
      tabs.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    }
    tabs.addEventListener('wheel', wheel, { passive: false })
    return () => tabs.removeEventListener('wheel', wheel)
  }, [bar])

  useData() // tab titles and badges follow the agents
  useUi() // and a conversation's rapid-fire mode
  const a = byId(world)
  const mine = drop?.pane === l.id ? drop.zone : null
  // Native listeners, not React props: a view's element is a portal, and React bubbles events
  // through the portal's React parents, not through the pane the element sits in.
  const on = useRef<{ over(e: DragEvent): void; leave(e: DragEvent): void; drop(e: DragEvent): void; focus(): void }>(null!)
  on.current = {
    over(e) {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      const zone = dropZone(paneRef.current!, e)
      const next: Drop = { pane: l.id, zone, rect: zone.strip ? undefined : previewRect(body.current!, zone) }
      if (JSON.stringify(next) !== JSON.stringify(drop)) setDrop(next)
    },
    leave(e) { if (!paneRef.current!.contains(e.relatedTarget as globalThis.Node)) setDrop(null) },
    drop(e) {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      const zone = dropZone(paneRef.current!, e)
      setDrop(null)
      const tab = e.dataTransfer!.getData('text/stam-tab')
      if (tab) {
        const { world: from, key } = JSON.parse(tab)
        if (from !== 'main') return toast('Tabs move only within their own area.')
        shell.move(key, 'main', l.id, zone.before ?? null, zone.side)
      } else {
        const key = 'agent:' + e.dataTransfer!.getData('text/stam-agent')
        if (shell.isOpen(key)) shell.close(key)
        shell.open('main', key, { pane: shell.leafById(shell.mainWorld(), l.id) ? l.id : undefined, split: zone.side })
      }
    },
    focus() { shell.setFocus('main', l.id) },
  }
  useLayoutEffect(() => {
    const el = paneRef.current!
    const over = (e: DragEvent) => on.current.over(e), leave = (e: DragEvent) => on.current.leave(e), drp = (e: DragEvent) => on.current.drop(e), focus = () => on.current.focus()
    el.addEventListener('dragover', over)
    el.addEventListener('dragleave', leave)
    el.addEventListener('drop', drp)
    el.addEventListener('pointerdown', focus, true)
    return () => { el.removeEventListener('dragover', over); el.removeEventListener('dragleave', leave); el.removeEventListener('drop', drp); el.removeEventListener('pointerdown', focus, true) }
  }, [])
  return (
    <div ref={paneRef} className={'pane' + (l.id === w.focused ? ' focused' : '') + (bar ? '' : ' bare')} data-world="main" data-id={l.id} style={style}>
      {bar ? <TabBar tabsRef={tabsRef} actions={<>{sw && shows ? <ViewSwitch id={shows.id} view={shows.view} phone={phone} /> : null}{phone ? <div className="tab-actions">
        {term ? <button className="icon-btn" data-keyboard title="Type into the terminal" aria-label="Type into the terminal" onClick={() => shell.viewHandle(active!)?.focus?.()}><Icon name="keyboard" /></button> : null}
        {thread ? <ThreadArchive tid={thread} /> : null}
        <button className="icon-btn" data-pane-menu title="Menu" aria-label="Menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom })) }}><Icon name="ellipsis" /></button>
      </div> : null}</>}>
        {strip.map(({ k, pane }) => {
          const m = viewMeta(k)
          return <Tab key={k} id={k} active={k === active} dropBefore={!!(mine?.strip && mine.before === k)} draggable={!phone} title={m.title} tooltip={m.tooltip} glyph={m.icon}
            chips={<>{k.startsWith('agent:') || k.startsWith('view:') ? <><WaitBadges id={k.slice(k.indexOf(':') + 1)} tabKey={k} /><ItsaChips id={k.slice(k.indexOf(':') + 1)} tabKey={k} /></> : null}{m.badge ? <span className={`badge ${m.badgeClass ?? ''}`}>{m.badge}</span> : null}</>}
            onSelect={() => { if (pane !== l.id) shell.setFocus('main', pane); shell.activate('main', pane, k) }}
            onClose={() => shell.close(k)}
            onDragStart={(e) => { e.dataTransfer.setData('text/stam-tab', JSON.stringify({ world: 'main', key: k })); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging') }}
            onDragEnd={(e) => { e.currentTarget.classList.remove('dragging'); setDrop(null) }} />
        })}
      </TabBar> : null}
      {bar ? <WaitThinBar k={active} /> : null}
      <div className="pane-body" ref={body}>
        {!tabs.length ? (a
          ? <div className="empty-pane"><p>Empty pane in {a.name}'s world. Right-click to add a terminal, an agent, or its inbox.</p></div>
          : <div className="empty-pane"><h3>No agent selected</h3><p>Pick an agent in the tree, or press <b>+</b> to add one.</p></div>) : null}
      </div>
    </div>
  )
}


// The switch between an agent's terminal and stam's view of its conversation: the other
// one takes the same place in the same pane, and the agent opens in it from then on. On a desktop, the choices as icons only, each named by its tooltip and aria-label; on a
// phone, whose strip has room for little, one button that shows the other view (what the
// pane shows says which one is on). The conversation has a rapid-fire mode (S-1004): a third
// choice on a desktop, and on a phone a toggle beside the switch while the conversation shows.
function ViewSwitch({ id, view, phone }: { id: string; view: 'terminal' | 'conversation'; phone: boolean }) {
  const rapid = isRapid(id)
  if (phone) {
    const to = view === 'terminal' ? 'conversation' : 'terminal'
    const label = to === 'terminal' ? 'Show the terminal' : 'Show the conversation'
    const rl = rapid ? 'Leave rapid-fire mode' : 'Rapid-fire mode: each send a new thread, or a follow-up in the card you pick'
    return <>
      {view === 'conversation' ? <button type="button" className={'icon-btn view-switch rapid-switch' + (rapid ? ' on' : '')} aria-pressed={rapid} title={rl} aria-label={rl}
        onClick={() => setRapid(id, !rapid)}><Icon name="zap" /></button> : null}
      <button type="button" className="icon-btn view-switch" data-to={to} title={label} aria-label={label} onClick={() => chooseView(id, to)}><Icon name={to === 'terminal' ? 'terminal' : 'message-square'} /></button>
    </>
  }
  const on = view === 'terminal' ? 'terminal' : rapid ? 'rapid' : 'conversation'
  const opt = (v: 'terminal' | 'conversation' | 'rapid', icon: string, label: string, title: string) => (
    <button type="button" role="radio" aria-checked={on === v} className={on === v ? 'on' : ''} title={title} aria-label={label} data-view={v}
      onClick={() => {
        if (on === v) return
        if (v !== 'terminal') setRapid(id, v === 'rapid')
        if (view !== (v === 'terminal' ? 'terminal' : 'conversation')) chooseView(id, v === 'terminal' ? 'terminal' : 'conversation')
      }}><Icon name={icon} size="xs" /></button>
  )
  return (
    <div className="seg view-switch" role="radiogroup" aria-label="Show the agent as">
      {opt('terminal', 'terminal', 'Terminal', 'Terminal')}{opt('conversation', 'message-square', 'Conversation', 'Conversation')}
      {opt('rapid', 'zap', 'Rapid-fire', 'Rapid-fire: each send starts a new thread; pick a card to follow up in it')}
    </div>
  )
}
