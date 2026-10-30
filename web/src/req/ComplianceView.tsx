// The compliance matrix (world `w:compliance`, view key `compliance`), shown while requirements
// are on: requirements as rows, subjects as columns, the latest verdict per pair at the
// requirement's current version as a glyph, waived ones struck through and muted. Subjects are
// the branches in the merge queue, or an ITSA subtree picked from a selector. A cell opens the
// requirement's world at that verdict. On a phone each requirement is a card with a strip of
// verdict chips, one per subject, that wraps instead of scrolling sideways. Every verdict is
// worded as an indication, never as fact.
import { useState } from 'react'
import { Icon } from '../Icon'
import { openItsa } from '../itsa/itsa'
import { isPhone, useShell } from '../shell/layout'
import { useData, useQueueReader } from '../store'
import { buildMatrix, cellState, flaggedPerSubject, queueSubjects, subtreeSubjects, type MatrixCell, type MatrixSubject } from './matrix'
import { STATE_WORD, stateOf, STATUS_WORD, verdictWord, WAIVER_WORD, type Requirement } from './model'
import { openReq, openReqAt, ReqGlyph } from './parts'
import { useReq, useReqReader } from './store'

type Source = { kind: 'queue' } | { kind: 'itsa'; id: string }
const PICK_KEY = 'stam/compliance-subjects'
const loadPick = (): Source => {
  try {
    const v = JSON.parse(localStorage.getItem(PICK_KEY) ?? 'null')
    if (v?.kind === 'itsa' && typeof v.id === 'string') return v
  } catch {}
  return { kind: 'queue' }
}
const savePick = (s: Source) => { try { localStorage.setItem(PICK_KEY, JSON.stringify(s)) } catch {} }

// A cell said in words, for its title and its screen-reader label.
function cellWords(req: Requirement, s: MatrixSubject, c: MatrixCell | null): string {
  if (!c) return `${req.key} on ${s.label}: not checked at v${req.version}`
  const word = verdictWord(c.verdict, c.verdict === 'violates' || c.verdict === 'unsure' ? c.p_violates : null)
  return `${req.key} on ${s.label}: ${word}${c.waived ? `, waived as ${WAIVER_WORD[c.waived]}` : ''}${c.stale ? ', at an older commit' : ''}`
}

// A cell's mark: the requirement glyph for a verdict, a dash for not applicable, nothing unchecked.
function CellMark({ c }: { c: MatrixCell | null }) {
  const st = cellState(c)
  if (st === 'none') return <span className="rq-none" aria-hidden="true" />
  if (st === 'na') return <span className="rq-na" aria-hidden="true">n/a</span>
  return <ReqGlyph state={st} waived={!!c!.waived || c!.stale} title="" />
}

export function ComplianceView({ viewKey }: { viewKey?: string }) {
  const { enabled, reqs, loaded } = useReq()
  const { itsas, queue } = useData()
  useShell()
  useQueueReader(viewKey)
  useReqReader(viewKey)
  const [pick, setPick] = useState<Source>(loadPick)
  const choose = (s: Source) => { setPick(s); savePick(s) }
  if (!enabled) return <div className="itsa-view"><div className="empty-pane"><h3>Requirements are off</h3><p>Turn them on in Settings › Requirements to see the compliance matrix.</p></div></div>

  const open = itsas.filter((x) => !x.closed_at)
  const roots = open.filter((x) => !x.parent_id || !open.some((p) => p.id === x.parent_id))
  const root = pick.kind === 'itsa' ? itsas.find((x) => x.id === pick.id) ?? null : null
  const subjects = pick.kind === 'queue' ? queueSubjects(queue) : root ? subtreeSubjects(itsas, root.id) : []
  const m = buildMatrix(reqs, subjects)
  const flagged = flaggedPerSubject(m)
  const phone = isPhone()
  // The selector lists open ITSAs as a tree, two levels deep: a root and its children.
  const options = roots.flatMap((r) => [r, ...open.filter((c) => c.parent_id === r.id)])

  const picker = (
    <div className="rq-matrix-pick">
      <div className="seg" role="radiogroup" aria-label="Subjects">
        <button type="button" role="radio" aria-checked={pick.kind === 'queue'} className={pick.kind === 'queue' ? 'on' : ''} data-subjects="queue" onClick={() => choose({ kind: 'queue' })}><Icon name="git-pull-request" size="xs" />Merge queue</button>
        <button type="button" role="radio" aria-checked={pick.kind === 'itsa'} className={pick.kind === 'itsa' ? 'on' : ''} data-subjects="itsa" onClick={() => choose({ kind: 'itsa', id: root?.id ?? roots[0]?.id ?? '' })}><Icon name="list-checks" size="xs" />Issue tree</button>
      </div>
      {pick.kind === 'itsa' ? (
        <select aria-label="Issue tree" data-subject-root value={root?.id ?? ''} onChange={(e) => choose({ kind: 'itsa', id: e.target.value })}>
          {root ? null : <option value="">Pick an issue</option>}
          {options.map((x) => <option key={x.id} value={x.id}>{x.parent_id && options.some((p) => p.id === x.parent_id) ? ' ' : ''}{x.key} {x.title}</option>)}
        </select>
      ) : null}
    </div>
  )

  const empty = !loaded ? null
    : !m.rows.length ? <p className="muted">No requirements yet. Add one with <code>req_create</code>, or import them in Settings › Requirements.</p>
    : !subjects.length ? <p className="muted">{pick.kind === 'queue' ? 'Nothing is in the merge queue.' : 'Pick an issue to see its subtree.'}</p>
    : null

  return (
    <div className="itsa-view rq-matrix-view" data-compliance>
      <div className="itsa-inner wide">
        <header className="itsa-head"><h2><Icon name="grid-3x3" />Compliance</h2></header>
        <p className="lede">The latest check of each requirement on each subject, at the requirement's current version. A check is a model's indication, not proof. A struck-through mark was waived or checked at an older commit.</p>
        {picker}
        {empty ?? (phone ? (
          <ul className="rq-cards" aria-label="Requirements by subject">
            {m.rows.map((r) => {
              const st = stateOf(r.req.latest)
              return (
                <li key={r.req.id} className={'rq-card' + (r.req.status !== 'in_force' ? ' closed' : '')} data-matrix-row={r.req.key}>
                  <button type="button" className="rq-card-head" onClick={() => openReq(r.req.key)} title={`${r.req.key} · ${r.req.title} · ${STATUS_WORD[r.req.status]} · ${STATE_WORD[st]}`}>
                    <ReqGlyph state={st} status={r.req.status} /><span className="ikey">{r.req.key}</span><span className="ititle">{r.req.title}</span>
                  </button>
                  <div className="rq-mchips">{m.subjects.map((s, i) => {
                    const c = r.cells[i]
                    // The subject's title is a line under its chip, cut short when it doesn't fit.
                    return (
                      <div key={s.id} className="rq-mcol">
                        <button type="button" className={`rq-mchip ${cellState(c)}${c?.waived || c?.stale ? ' muted' : ''}`} data-cell={`${r.req.key}|${s.id}`} disabled={!c}
                          aria-label={cellWords(r.req, s, c)} title={cellWords(r.req, s, c)} onClick={() => c && openReqAt(r.req.key, c.id)}>
                          <CellMark c={c} /><span className="ct">{s.label}</span>
                        </button>
                        <span className="rq-msub" data-subject-title title={s.title}>{s.name}</span>
                      </div>)
                  })}</div>
                </li>)
            })}
          </ul>
        ) : (
          <div className="rq-matrix-scroll">
            <table className="data rq-matrix">
              <thead>
                <tr>
                  <th className="rq-mreq" scope="col">Requirement</th>
                  {m.subjects.map((s, i) => (
                    <th key={s.id} scope="col" className="rq-msubj">
                      <button type="button" className="rq-msubj-btn" title={s.title} onClick={() => openItsa(s.itsaId)}>{s.label}</button>
                      <span className="rq-msub" data-subject-title title={s.title}>{s.name}</span>
                      {flagged[i] ? <span className="rq-mflag" title={`${flagged[i]} likely violate${flagged[i] === 1 ? 's' : ''}`}>{flagged[i]} likely violate{flagged[i] === 1 ? 's' : ''}</span> : null}
                    </th>))}
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r) => {
                  const st = stateOf(r.req.latest)
                  return (
                    <tr key={r.req.id} className={r.req.status !== 'in_force' ? 'closed' : ''} data-matrix-row={r.req.key}>
                      <th scope="row" className="rq-mreq">
                        <button type="button" className="rq-mreq-btn" style={{ paddingLeft: `calc(${r.depth} * var(--space-3))` }} title={`${r.req.key} · ${r.req.title} · ${STATUS_WORD[r.req.status]} · ${STATE_WORD[st]}`} onClick={() => openReq(r.req.key)}>
                          <ReqGlyph state={st} status={r.req.status} /><span className="ikey">{r.req.key}</span><span className="ititle">{r.req.title}</span>
                        </button>
                      </th>
                      {m.subjects.map((s, i) => {
                        const c = r.cells[i]
                        return (
                          <td key={s.id} className="rq-mcell">
                            {c ? <button type="button" data-cell={`${r.req.key}|${s.id}`} aria-label={cellWords(r.req, s, c)} title={cellWords(r.req, s, c)} onClick={() => openReqAt(r.req.key, c.id)}><CellMark c={c} /></button>
                              : <span data-cell={`${r.req.key}|${s.id}`} title={cellWords(r.req, s, c)}><CellMark c={c} /></span>}
                          </td>)
                      })}
                    </tr>)
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}
