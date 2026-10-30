// The Requirements section of the left sidebar, under Issues, shown only while
// settings.requirements.enabled is on: the requirement tree as rows (state glyph, key, title,
// a roll-up bar of the subtree), each expandable into its children, to any depth, like the
// Issues tree. Obsolete roots fold into one row at the end. A row opens the requirement's world.
// On a phone the section follows the issues in the Issues tab, as full-width rows.
import { useEffect, useRef } from 'react'
import { Icon } from '../Icon'
import { Loading } from '../Loading'
import { isPhone, showAgentWorld, useShell } from '../shell/layout'
import { getUi, setUi, useUi } from '../ui/state'
import { childrenOf, rollups, rollupText, stateOf, STATE_WORD, STATUS_WORD, type Requirement } from './model'
import { openedReq, openReq, ReqGlyph, ReqRollupBar } from './parts'
import { useReq, watchReq } from './store'

export function ReqSide() {
  const { enabled, reqs, loaded, error } = useReq()
  const ui = useUi()
  const onMatrix = useShell().current === 'w:compliance'
  // Always rendered, so the poll can tell whether the pane is on screen even while requirements are off. It has
  // the same classes, so the phone and the folded rules hide it with the section, and an empty `.req-side` takes no room.
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => watchReq(() => anchor.current), [])
  if (!enabled) return <div ref={anchor} className="issues-side req-side" />
  const phone = isPhone()
  const folded = !phone && !!ui.reqFolded
  const open = ui.reqOpen ?? {}
  const sel = openedReq()
  const kids = childrenOf(reqs)
  const counts = rollups(reqs)
  const gone = (x: Requirement) => x.status === 'obsolete'
  const ordered = (xs: Requirement[]) => [...xs.filter((x) => !gone(x)), ...xs.filter(gone)]
  const roots = kids.get(null) ?? []
  const liveRoots = roots.filter((x) => !gone(x)), oldRoots = roots.filter(gone)
  const rows: React.ReactNode[] = []
  const row = (x: Requirement, depth: number, seen: Set<string>) => {
    const children = kids.get(x.id) ?? []
    const isOpen = !!open[x.id]
    const r = counts.get(x.id)!
    const st = stateOf(x.latest)
    rows.push(
      <div key={x.id} className={`irow rrow ${x.key === sel ? 'sel' : ''} ${x.status !== 'in_force' ? 'closed' : ''}`} data-req={x.key} role="treeitem" aria-expanded={children.length ? isOpen : undefined} tabIndex={-1}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` }} title={`${x.key} · ${x.title} · ${STATUS_WORD[x.status]} · ${STATE_WORD[st]}${children.length ? ' · below: ' + rollupText(r) : ''}`}
        onClick={() => openReq(x.key)}>
        {children.length ? <button className={`chev ${isOpen ? 'open' : ''}`} type="button" aria-label={isOpen ? `Fold ${x.key}` : `Show ${x.key}'s children`}
          onClick={(e) => { e.stopPropagation(); setUi({ reqOpen: { ...(getUi().reqOpen ?? {}), [x.id]: !isOpen } }) }}><Icon name="chevron-right" size="xs" /></button> : <span className="chev" />}
        <ReqGlyph state={st} status={x.status} />
        <span className="ikey">{x.key}</span>
        <span className="ititle">{x.title}</span>
        {x.status === 'draft' ? <span className="rq-tag">draft</span> : null}
        <ReqRollupBar r={r} />
      </div>)
    if (isOpen && !seen.has(x.id)) { seen.add(x.id); for (const c of ordered(children)) row(c, depth + 1, seen) }
  }
  for (const x of liveRoots) row(x, 0, new Set())
  if (oldRoots.length) {
    rows.push(<button key="obsolete" type="button" className="irow fold-row" aria-expanded={!!ui.obsoleteReqOpen} onClick={() => setUi({ obsoleteReqOpen: !getUi().obsoleteReqOpen })}>
      <span className={`chev ${ui.obsoleteReqOpen ? 'open' : ''}`}><Icon name="chevron-right" size="xs" /></span>Obsolete <span className="count">{oldRoots.length}</span></button>)
    if (ui.obsoleteReqOpen) for (const x of oldRoots) row(x, 0, new Set())
  }
  const flagged = liveRoots.reduce((n, x) => n + (counts.get(x.id)?.violates ?? 0), 0)
  return (
    <div ref={anchor} className={'issues-side req-side' + (folded ? ' folded' : '')} id="req-side">
      <div className="section eyebrow">
        <button className="fold" type="button" aria-expanded={!folded} disabled={phone} title={folded ? 'Show the requirements' : 'Fold the requirements'} onClick={() => setUi({ reqFolded: !folded })}>
          {phone ? null : <span className={`chev ${folded ? '' : 'open'}`}><Icon name="chevron-right" size="xs" /></span>}<Icon name="scale" size="xs" />Requirements
          <span className="count">{reqs.length || ''}</span>
        </button>
        {flagged ? <span className="rq-flagged" title={`${flagged} likely violate: a check is an indication, not proof`}>{flagged} likely violate{flagged === 1 ? 's' : ''}</span> : null}
        <button type="button" className={'icon-btn rq-matrix-open' + (onMatrix ? ' on' : '')} data-compliance-open aria-label="Compliance matrix" title="Compliance: each requirement's latest check on each subject" onClick={() => showAgentWorld('w:compliance')}><Icon name="grid-3x3" size="xs" /></button>
      </div>
      {folded ? null : <div className="issues-list req-list" role="tree" aria-label="Requirements">
        {error && !reqs.length ? <div className="mail-empty muted">{error}</div>
          : rows.length ? rows : !loaded ? <Loading className="mail-empty" /> : <div className="mail-empty muted">Requirements you and agents keep show here.</div>}
      </div>}
    </div>
  )
}
