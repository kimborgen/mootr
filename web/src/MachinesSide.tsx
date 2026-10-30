// The Machines section of the left sidebar, above the footer: one line per computer, three
// small meters (CPU, RAM, swap), 0-100%, no numbers. Each meter carries its initial and a
// level colour — neutral, warning over 80%, error over 95% (the status tokens) — so colour
// is never the only signal. Hovering a line (desktop) or tapping it (phone) opens a popover
// with the percentages, the used and total GB, the load average, and each core's CPU. The
// header folds the section; on a phone it lives in the Agents tab.
import { memo } from 'react'
import { Icon } from './Icon'
import { isPhone, useShell } from './shell/layout'
import { useData, useMachinesShown } from './store'
import type { Machine } from './types'
import { hideMenu, menuOpen, menuTrigger, showPopover } from './ui/menu'
import { setUi, useUi } from './ui/state'

export const level = (pct: number) => (pct >= 95 ? 'err' : pct >= 80 ? 'warn' : 'ok')
export const pct0 = (n: number) => `${Math.round(n)}%`
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

const METERS: { key: 'cpu' | 'ram' | 'swap'; letter: string; label: string }[] = [
  { key: 'cpu', letter: 'C', label: 'CPU' },
  { key: 'ram', letter: 'R', label: 'RAM' },
  { key: 'swap', letter: 'S', label: 'Swap' },
]

export function Meter({ kind, letter, label, pct }: { kind: string; letter: string; label: string; pct: number }) {
  const lv = level(pct)
  return (
    <span className="mmeter" data-kind={kind} data-level={lv} role="img" aria-label={`${label} ${pct0(pct)}`}>
      <span className="ml" aria-hidden="true">{letter}</span>
      <span className="mtrack"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>
    </span>
  )
}

function Popover({ m, leave }: { m: Machine; leave: () => void }) {
  return (
    <div className="machines-pop" data-machine={m.name} data-online={m.online} onMouseLeave={leave}>
      <div className="mp-head">
        <span className="eyebrow"><Icon name="server" size="xs" />{m.name}</span>
        <span className={'mp-state' + (m.online ? '' : ' off')}>{m.online ? 'online' : 'offline'}</span>
      </div>
      {m.online ? <>
        <dl className="mp-grid">
          <div><dt>CPU</dt><dd>{pct0(m.cpu.pct)} · {m.cpu.count} cores</dd></div>
          <div><dt>RAM</dt><dd>{gb(m.ram.used)} / {gb(m.ram.total)} ({pct0(m.ram.pct)})</dd></div>
          <div><dt>Swap</dt><dd>{m.swap.total ? `${gb(m.swap.used)} / ${gb(m.swap.total)} (${pct0(m.swap.pct)})` : 'none'}</dd></div>
          <div><dt>Load</dt><dd>{m.load.length ? m.load.map((n) => n.toFixed(2)).join('  ') : '–'}</dd></div>
        </dl>
        <div className="eyebrow mp-core-head">Per core</div>
        <ul className="mp-cores">
          {m.cpu.cores.map((p, i) => (
            <li key={i}><span className="mp-c">core {i}</span><span className="mtrack" data-level={level(p)}><i style={{ width: `${Math.max(0, Math.min(100, p))}%` }} /></span><span className="mp-v">{pct0(p)}</span></li>
          ))}
        </ul>
      </> : <p className="muted">Not answering. Its daemon may be stopped.</p>}
    </div>
  )
}

// Closes the popover of the element the pointer left, once the pointer is off both it and the popover. A menu another
// element opened (Spawn, Columns, or the next machine's popover) is not this one's to close.
// A pointer that comes back to the machine (or its popover) before the timer runs cancels the close.
let leaveTimer = 0
const leaveMachine = (el: Element) => {
  clearTimeout(leaveTimer)
  leaveTimer = window.setTimeout(() => {
    if (menuTrigger() !== el || document.querySelector('.machines-pop')?.matches(':hover')) return
    if (hovered === el) hovered = null
    hideMenu()
  }, 200)
}

// The strip's item whose popover a pointer opened: leaving it closes the popover, and a click on it pins the popover.
let hovered: Element | null = null

// Opens a machine's details beside the element that asks for them: the sidebar's line and the Agents header's strip share it.
// `hover`: a pointer passing over opened it, so the popover doesn't take the focus (the search keeps it, S-3182).
export function openMachine(el: Element, m: Machine, hover = false) {
  const r = el.getBoundingClientRect()
  hovered = hover ? el : null
  showPopover(r.right + 4, r.bottom + 4, `${m.name} load`, <Popover m={m} leave={() => leaveMachine(el)} />, el, false, !hover)
}

// A click opens the item's popover with the focus in it, or closes it when it is open. A click on a hover-opened one pins it.
function clickMachine(el: Element, m: Machine) {
  if (menuTrigger() === el && hovered !== el) return hideMenu()
  if (menuTrigger() === el) hideMenu()
  openMachine(el, m)
}

function MachineRow({ m, phone }: { m: Machine; phone: boolean }) {
  // On a desktop the line shows its details on approach; leaving the line or the popover
  // closes them. The popover opens to the line's right, clear of the sidebar, so it never
  // sits under the pointer. On a phone a tap opens the sheet.
  return (
    <button type="button" className={'machine-row' + (m.online ? '' : ' off')} data-machine={m.name} data-online={m.online}
      aria-label={`${m.name}${m.online ? '' : ' offline'}`}
      onMouseEnter={phone ? undefined : (e) => { clearTimeout(leaveTimer); if (menuTrigger() !== e.currentTarget) openMachine(e.currentTarget, m) }}
      onMouseLeave={phone ? undefined : (e) => leaveMachine(e.currentTarget)}
      onClick={phone ? (e) => openMachine(e.currentTarget, m) : undefined}>
      <span className="mname">{m.name}</span>
      {m.online ? METERS.map((x) => <Meter key={x.key} kind={x.key} letter={x.letter} label={x.label} pct={m[x.key].pct} />) : <span className="muted moff">offline</span>}
    </button>
  )
}

// The Agents header's machines (S-3182): one item per machine with its CPU and RAM meters, and the sidebar's details
// popover on hover or keyboard focus. Memoised on the machines list, which the store sets only when it changes, so the
// agents poll doesn't draw it again. Below the header's width it is one Machines button (MachinesCollapsed).
export const MachinesStrip = memo(function MachinesStrip({ machines, collapsed }: { machines: Machine[]; collapsed: boolean }) {
  if (!machines.length) return null
  if (collapsed) return <MachinesCollapsed machines={machines} />
  // A pointer passing over opens the popover without the focus, unless another menu is open (a hover may replace the popover
  // a hover opened, so moving from one machine to the next shows the next); leaving closes it only when a hover opened it.
  // Focus and blur open and close nothing: Enter on the item is a click, which opens it and closes it again.
  return <div className="mstrip" data-machines-strip>
    {machines.map((m) => <button key={m.name} type="button" className={'mstrip-item' + (m.online ? '' : ' off')} data-machine={m.name} data-online={m.online}
      onMouseEnter={(e) => { clearTimeout(leaveTimer); if ((!menuOpen() || menuTrigger() === hovered) && menuTrigger() !== e.currentTarget) openMachine(e.currentTarget, m, true) }}
      onMouseLeave={(e) => { if (hovered === e.currentTarget) leaveMachine(e.currentTarget) }}
      onClick={(e) => clickMachine(e.currentTarget, m)}>
      <span className="mname">{m.name}</span>
      {m.online ? <>
        <Meter kind="cpu" letter="C" label="CPU" pct={m.cpu.pct} />
        <Meter kind="ram" letter="R" label="RAM" pct={m.ram.pct} />
      </> : <span className="muted moff">off</span>}
    </button>)}
  </div>
})

// The narrow header's one button: its dot carries the worst level of the online machines, and a click lists every machine.
function MachinesCollapsed({ machines }: { machines: Machine[] }) {
  const pcts = machines.filter((m) => m.online).flatMap((m) => [m.cpu.pct, m.ram.pct])
  const worst = pcts.length ? Math.max(...pcts) : 0
  const offline = machines.filter((m) => !m.online).length
  const label = `Machines, ${pcts.length ? `most used ${pct0(worst)}` : 'none online'}${offline ? `, ${offline} offline` : ''}`
  return <button type="button" className="icon-btn mstrip-collapsed" data-machines-collapsed title={label} aria-label={label} aria-haspopup="dialog"
    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); showPopover(r.left, r.bottom + 4, 'Machines', <MachinesAll machines={machines} />, e.currentTarget) }}>
    <Icon name="server" size="xs" /><span className="mdot" data-level={level(worst)} aria-hidden="true" /></button>
}

// Every machine, one line each, with its meters or its offline word.
function MachinesAll({ machines }: { machines: Machine[] }) {
  return <div className="machines-pop machines-all" data-machines-all>
    <div className="mp-head"><span className="eyebrow"><Icon name="server" size="xs" />Machines</span></div>
    {machines.map((m) => <div key={m.name} className={'mall-line' + (m.online ? '' : ' off')} data-machine={m.name} data-online={m.online}>
      <span className="mname">{m.name}</span>
      {m.online ? <>
        <Meter kind="cpu" letter="C" label="CPU" pct={m.cpu.pct} />
        <Meter kind="ram" letter="R" label="RAM" pct={m.ram.pct} />
      </> : <span className="muted moff">offline</span>}
    </div>)}
  </div>
}

// In a sidebar pane (`pane`, S-1421) the tab says which list shows, so there is no fold. `shown`: the list is
// on screen; the machines poll runs at 5 s only while it is (store.ts).
export function MachinesSide({ pane, shown = true }: { pane?: boolean; shown?: boolean } = {}) {
  const { machines } = useData()
  const ui = useUi()
  useShell()
  useMachinesShown(shown)
  const phone = isPhone()
  const folded = !pane && !!ui.machinesFolded
  if (!machines.length) return null
  const offline = machines.filter((m) => !m.online).length
  return (
    <div className={'machines-side' + (folded ? ' folded' : '')} id="machines-side">
      <div className="section eyebrow">
        <button className="fold" type="button" aria-expanded={!folded} disabled={pane} title={folded ? 'Show the machines' : 'Fold the machines'} onClick={() => setUi({ machinesFolded: !folded })}>
          {pane ? null : <span className={`chev ${folded ? '' : 'open'}`}><Icon name="chevron-right" size="xs" /></span>}<Icon name="server" size="xs" />Machines
          <span className="count">{offline ? `${offline} offline` : ''}</span>
        </button>
      </div>
      {folded ? null : <div className="machines-list">
        {machines.map((m) => <MachineRow key={m.name} m={m} phone={phone} />)}
      </div>}
    </div>
  )
}
