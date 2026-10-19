// The Issues section of the left sidebar, between the agent tree and the mail: root ITSAs
// as rows (status glyph, key, title, a roll-up bar when they have children), each
// expandable into its children, to any depth. Open ones first; closed roots fold into one
// row at the end. A separator above resizes the section, and its header folds it. A row
// opens the ITSA's world. On a phone the section is the Issues tab of the navigation.
import { useEffect, useRef, useState } from 'react'
import { openWorld } from '../actions'
import { Icon } from '../Icon'
import { Loading } from '../Loading'
import { isPhone, useShell } from '../shell/layout'
import { useData } from '../store'
import type { Itsa } from '../types'
import { getUi, setUi, useUi } from '../ui/state'
import { showWaiting, useWaiting } from './WaitingList'
import { createItsa, isClosed, openBoard, openedItsa, openItsa, RollupBar, rollupOf, rollupTotal, StatusGlyph, statusLabel, waitsOnHuman } from './itsa'

// A text box for a new ITSA's title: Enter creates it, Escape or leaving it empty cancels.
export function NewItsa({ parent, onDone, placeholder }: { parent: string | null; onDone: (it: Itsa | null) => void; placeholder: string }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const submit = async () => {
    const t = title.trim()
    if (!t) return onDone(null)
    setBusy(true)
    const it = await createItsa(parent, t)
    setBusy(false)
    if (it) { setTitle(''); onDone(it) }
  }
  return (
    <form className="new-itsa" onSubmit={(e) => { e.preventDefault(); submit() }}>
      <input ref={ref} value={title} disabled={busy} placeholder={placeholder} aria-label={placeholder} autoComplete="off" spellCheck={false}
        onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(null) } }}
        onBlur={() => { if (!title.trim() && !busy) onDone(null) }} />
      <button className="btn primary" type="submit" disabled={busy || !title.trim()} onMouseDown={(e) => e.preventDefault()}>Add</button>
    </form>
  )
}

// In a sidebar pane (`pane`, S-1421) the pane sets the height and the tab says which list shows, so
// there is no resize separator and no fold.
export function IssuesSide({ leftRef, pane }: { leftRef: React.RefObject<HTMLElement | null>; pane?: boolean }) {
  const { itsas, itsaError, loaded } = useData()
  const ui = useUi()
  const onWork = useShell().current === 'w:work'
  const side = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)
  const [, setTick] = useState(0)
  const phone = isPhone()
  const folded = !phone && !pane && !!ui.issuesFolded
  // The tree keeps room: the section takes at most what the tree and the mail list leave.
  const height = () => Math.max(64, Math.min(getUi().issuesH ?? 200, (leftRef.current?.clientHeight ?? 800) - (getUi().mailH ?? 260) - 200))
  useEffect(() => {
    const on = () => setTick((n) => n + 1)
    addEventListener('resize', on)
    on()
    return () => removeEventListener('resize', on)
  }, [])
  const sel = openedItsa()
  const kids = new Map<string | null, Itsa[]>()
  for (const x of itsas) {
    const p = x.parent_id && itsas.some((y) => y.id === x.parent_id) ? x.parent_id : null
    kids.set(p, [...(kids.get(p) ?? []), x])
  }
  // Open ones first, each group oldest first.
  const ordered = (xs: Itsa[]) => [...xs.filter((x) => !isClosed(x)), ...xs.filter(isClosed)]
  const roots = kids.get(null) ?? []
  const openRoots = roots.filter((x) => !isClosed(x)), closedRoots = roots.filter(isClosed)
  const waiting = useWaiting().length
  // A folded row says when something below it waits on the human, so it can be found.
  const waitsBelow = new Set<string>()
  for (const x of itsas.filter(waitsOnHuman)) {
    const seen = new Set<string>()
    for (let p = itsas.find((y) => y.id === x.parent_id); p && !seen.has(p.id); p = itsas.find((y) => y.id === p!.parent_id)) { seen.add(p.id); waitsBelow.add(p.id) }
  }

  const rows: React.ReactNode[] = []
  const row = (x: Itsa, depth: number, seen: Set<string>) => {
    const children = kids.get(x.id) ?? []
    const open = !!ui.itsaOpen[x.id]
    const r = rollupOf(x.id, itsas)
    rows.push(
      <div key={x.id} className={`irow ${x.id === sel ? 'sel' : ''} ${isClosed(x) ? 'closed' : ''} ${x.pending ? 'pending' : ''}`} data-itsa={x.id} role="treeitem" aria-expanded={children.length ? open : undefined} tabIndex={-1}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` }} title={`${x.key} · ${x.title} · ${statusLabel(x.status)}${rollupTotal(r) ? ' · ' + rollupTotal(r) + ' children' : ''}`}
        onClick={() => openItsa(x.id)}>
        {children.length ? <button className={`chev ${open ? 'open' : ''}`} type="button" aria-label={open ? `Fold ${x.key}` : `Show ${x.key}'s children`}
          onClick={(e) => { e.stopPropagation(); setUi({ itsaOpen: { ...getUi().itsaOpen, [x.id]: !open } }) }}><Icon name="chevron-right" size="xs" /></button> : <span className="chev" />}
        <StatusGlyph status={x.status} />
        <span className="ikey">{x.key}</span>
        <span className="ititle">{x.title}</span>
        {waitsOnHuman(x) ? <span className="badge warn" title={`${statusLabel(x.status)}: waits on you`}><Icon name="user" size="xs" /></span>
          : !open && waitsBelow.has(x.id) ? <span className="badge warn" title="Something in here waits on you"><Icon name="user" size="xs" /></span> : null}
        <RollupBar r={r} />
      </div>)
    if (open && !seen.has(x.id)) { seen.add(x.id); for (const c of ordered(children)) row(c, depth + 1, seen) }
  }
  for (const x of openRoots) row(x, 0, new Set())
  if (closedRoots.length) {
    rows.push(<button key="closed" type="button" className="irow fold-row" aria-expanded={!!ui.closedItsasOpen} onClick={() => setUi({ closedItsasOpen: !getUi().closedItsasOpen })}>
      <span className={`chev ${ui.closedItsasOpen ? 'open' : ''}`}><Icon name="chevron-right" size="xs" /></span>Closed <span className="count">{closedRoots.length}</span></button>)
    if (ui.closedItsasOpen) for (const x of closedRoots) row(x, 0, new Set())
  }

  // The separator above the section resizes it; the height is remembered.
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (folded) return
    e.preventDefault()
    const sep = e.currentTarget
    sep.setPointerCapture(e.pointerId)
    const bottom = side.current!.getBoundingClientRect().bottom
    const move = (ev: PointerEvent) => { getUi().issuesH = bottom - ev.clientY; setTick((n) => n + 1) }
    const up = () => { sep.removeEventListener('pointermove', move); sep.removeEventListener('pointerup', up); setUi({ issuesH: getUi().issuesH }) }
    sep.addEventListener('pointermove', move)
    sep.addEventListener('pointerup', up)
  }
  return (
    <>
      {pane ? null : <div className={'sep h side-sep' + (folded ? ' still' : '')} id="sep-issues" title={folded ? undefined : 'Drag to resize the issues'} onPointerDown={drag} />}
      <div className={'issues-side' + (folded ? ' folded' : '') + (pane ? ' in-pane' : '')} id="issues-side" ref={side} style={{ height: pane || folded || (!itsas.length && !adding) ? undefined : height() }}>
        <div className="section eyebrow">
          <button className="fold" type="button" aria-expanded={!folded} disabled={phone || pane} title={folded ? 'Show the issues' : 'Fold the issues'} onClick={() => setUi({ issuesFolded: !folded })}>
            {phone || pane ? null : <span className={`chev ${folded ? '' : 'open'}`}><Icon name="chevron-right" size="xs" /></span>}<Icon name="list-checks" size="xs" />Issues list
            <span className="count">{waiting ? '' : openRoots.length || ''}</span>
          </button>
          {waiting ? <button className="asks-btn" id="issues-waiting" type="button" aria-haspopup="dialog" title="Everything waiting on you: ITSAs and agents" onClick={(e) => showWaiting(e.currentTarget)}>{waiting} waiting on you</button> : null}
          <span className="spacer" />
          <button className="icon-btn" id="issues-board" type="button" title="Board of every issue" aria-label="Board of every issue" onClick={() => openBoard(null)}><Icon name="kanban" size="xs" /></button>
          <button className="icon-btn" id="new-issue" type="button" title="New issue" aria-label="New issue" onClick={() => { setAdding(true); if (folded) setUi({ issuesFolded: false }) }}><Icon name="plus" size="xs" /></button>
        </div>
        {folded ? null : <div className="issues-list" role="tree" aria-label="Issues">
          {itsas.length ? <button type="button" className={'irow work-entry' + (onWork ? ' sel' : '')} id="issues-work" title="Every open issue in one table, grouped by issue tree" onClick={() => openWorld('work')}>
            <span className="chev" /><Icon name="layout-list" size="xs" /><span className="ititle">Work</span><span className="count">{itsas.filter((x) => !isClosed(x)).length}</span></button> : null}
          {adding ? <NewItsa parent={null} placeholder="New issue's title" onDone={(it) => { setAdding(false); if (it) openItsa(it.id) }} /> : null}
          {itsaError && !itsas.length ? <div className="mail-empty muted">{itsaError}</div>
            : rows.length ? rows : adding ? null : !loaded.itsas ? <Loading className="mail-empty" /> : <div className="mail-empty muted">Issues you and agents track show here.</div>}
        </div>}
      </div>
    </>
  )
}
