// The Machines section of the left sidebar, above the footer: one line per computer, three
// small meters (CPU, RAM, swap), 0-100%, no numbers. Each meter carries its initial and a
// level colour — neutral, warning over 80%, error over 95% (the status tokens) — so colour
// is never the only signal. Hovering a line (desktop) or tapping it (phone) opens a popover
// with the percentages, the used and total GB, the load average, and each core's CPU. The
// header folds the section; on a phone it lives in the Agents tab.
import { Icon } from './Icon'
import { isPhone, useShell } from './shell/layout'
import { useData } from './store'
import type { Machine } from './types'
import { hideMenu, showPopover } from './ui/menu'
import { setUi, useUi } from './ui/state'

const level = (pct: number) => (pct >= 95 ? 'err' : pct >= 80 ? 'warn' : 'ok')
const pct0 = (n: number) => `${Math.round(n)}%`
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

const METERS: { key: 'cpu' | 'ram' | 'swap'; letter: string; label: string }[] = [
  { key: 'cpu', letter: 'C', label: 'CPU' },
  { key: 'ram', letter: 'R', label: 'RAM' },
  { key: 'swap', letter: 'S', label: 'Swap' },
]

function Meter({ kind, letter, label, pct }: { kind: string; letter: string; label: string; pct: number }) {
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

function MachineRow({ m, phone }: { m: Machine; phone: boolean }) {
  // On a desktop the line shows its details on approach; leaving the line or the popover
  // closes them. The popover opens to the line's right, clear of the sidebar, so it never
  // sits under the pointer. On a phone a tap opens the sheet.
  const leave = () => {
    window.setTimeout(() => {
      if (!document.querySelector('.machines-pop')?.matches(':hover')) hideMenu()
    }, 200)
  }
  const open = (el: Element) => {
    const r = el.getBoundingClientRect()
    showPopover(r.right + 4, r.bottom + 4, `${m.name} load`, <Popover m={m} leave={leave} />, el)
  }
  return (
    <button type="button" className={'machine-row' + (m.online ? '' : ' off')} data-machine={m.name} data-online={m.online}
      aria-label={`${m.name}${m.online ? '' : ' offline'}`}
      onMouseEnter={phone ? undefined : (e) => open(e.currentTarget)}
      onMouseLeave={phone ? undefined : leave}
      onClick={phone ? (e) => open(e.currentTarget) : undefined}>
      <span className="mname">{m.name}</span>
      {m.online ? METERS.map((x) => <Meter key={x.key} kind={x.key} letter={x.letter} label={x.label} pct={m[x.key].pct} />) : <span className="muted moff">offline</span>}
    </button>
  )
}

// In a sidebar pane (`pane`, S-1421) the tab says which list shows, so there is no fold.
export function MachinesSide({ pane }: { pane?: boolean } = {}) {
  const { machines } = useData()
  const ui = useUi()
  useShell()
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
