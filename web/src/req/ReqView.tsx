// A requirement's own world (`w:req:KEY`, view key `req:KEY`), shown while requirements are on:
// the parent chain, a header with key, title, status, severity, mode, and owner; the shall text,
// rationale, and source; verification methods and scope chips; the trace (parent, children,
// links, allocated ITSAs) as chips that open them; precision; and the recent verdicts with a
// probability bar each. Waive and Preview open a popover on the desktop and a bottom sheet on a
// phone. Every verdict is worded as an indication, never as fact.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { ago } from '../format'
import { Icon } from '../Icon'
import { openItsa, PersonGlyph, personName, StatusGlyph } from '../itsa/itsa'
import { refreshTabs, registerView } from '../shell/layout'
import { getData, useData } from '../store'
import { hideMenu, showPopover, toast } from '../ui/menu'
import { STATE_WORD, stateOf, STATUS_WORD, subjectLabel, verdictLabel, verdictWord, WAIVER_WORD, type PreviewResult, type ReqLink, type ReqVerdict, type RequirementView, type WaiverKind } from './model'
import { openReq, peekReqFocus, ProbBar, ReqGlyph, takeReqFocus, useReqFocus } from './parts'
import { selectThread } from '../actions'
import { refreshReq, useReq, useReqReader } from './store'

export const reqTitles = new Map<string, string>()

const SCOPE_LABEL: Record<string, string> = { subjects: 'subject', paths: 'path', repos: 'repo', roles: 'role', agents: 'agent', itsa: 'ITSA', tools: 'tool', sources: 'source' }

// The popover's or sheet's anchor: under the button on the desktop; a phone docks it at the bottom.
const anchor = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return [r.left, r.bottom + 4] as const }

// The waiver form: kind and reason, then POST /api/requirements/waivers. The verdict stays,
// marked; a refusal shows in the form.
function WaiveForm({ v, keyName, done }: { v: ReqVerdict; keyName: string; done: () => void }) {
  const [kind, setKind] = useState<WaiverKind>('false_positive')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const submit = async () => {
    if (!reason.trim()) return
    setBusy(true)
    try {
      await api('POST', '/api/requirements/waivers', { verdict_id: v.id, kind, reason: reason.trim() })
      hideMenu(true)
      toast(`Waived ${keyName} on ${verdictLabel(v)}`)
      done()
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return (
    <form className="rq-sheet" data-waive-form onSubmit={(e) => { e.preventDefault(); submit() }}>
      <h3>Waive {keyName}</h3>
      <p className="muted">On {verdictLabel(v)}: {verdictWord(v.verdict, v.p_violates)}. The verdict stays, marked.</p>
      <fieldset className="rq-kinds">
        <legend className="eyebrow">Kind</legend>
        {(['false_positive', 'accepted_deviation'] as const).map((k) => (
          <label key={k} className="rq-kind"><input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            <span><b>{k === 'false_positive' ? 'False positive' : 'Accepted deviation'}</b><span className="muted">{k === 'false_positive' ? 'The check is wrong: it conforms.' : 'It does violate, and that is accepted.'}</span></span></label>))}
      </fieldset>
      <label className="rq-reason"><span className="eyebrow">Reason</span>
        <textarea ref={ref} rows={3} value={reason} disabled={busy} placeholder="Why" onChange={(e) => setReason(e.target.value)} /></label>
      {error ? <p className="rq-error" role="alert">{error}</p> : null}
      <div className="rq-sheet-actions">
        <button type="button" className="btn" onClick={() => hideMenu(true)}>Cancel</button>
        <button type="submit" className="btn primary" data-waive-submit disabled={busy || !reason.trim()}>{busy ? 'Waiving…' : 'Waive'}</button>
      </div>
    </form>
  )
}

// The preview: the requirement on the last real subjects of its scope. It records nothing and
// tells nobody; the model is asked, so it runs only when pressed.
function PreviewSheet({ keyName, threshold }: { keyName: string; threshold: number }) {
  const [r, setR] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    api<PreviewResult>('POST', `/api/requirements/${encodeURIComponent(keyName)}/preview`, {}).then((x) => { if (on) setR(x) }, (e) => { if (on) setError((e as Error).message) })
    return () => { on = false }
  }, [keyName])
  return (
    <div className="rq-sheet" data-preview>
      <h3>Preview {keyName}</h3>
      <p className="muted">What it would say about recent subjects in its scope. Nothing is recorded and nobody is told.</p>
      {error ? <p className="rq-error" role="alert">{error}</p>
        : !r ? <p className="muted" aria-live="polite">Asking the model…</p>
        : <>
          {r.note ? <p className="muted">{r.note}.</p> : null}
          {r.rows.length ? <ul className="rq-verdicts">{r.rows.map((x, i) => (
            <li key={i} className="rq-verdict" data-preview-row>
              <span className="rq-subject" title={x.summary ?? subjectLabel(x.subject)}>{x.summary || subjectLabel(x.subject)}</span>
              {x.error ? <span className="rq-error">{x.error}</span>
                : !x.verdict ? <span className="rq-word na">no answer</span>
                : <><span className={`rq-word ${x.verdict}`}>{verdictWord(x.verdict)}{x.would_act ? ' · would act' : ''}</span><ProbBar p={x.p_violates} threshold={threshold} /></>}
            </li>))}</ul> : null}
        </>}
    </div>
  )
}

// A verdict's subject said readably; a mail opens its thread, an ITSA itself.
export function SubjectName({ v }: { v: Pick<ReqVerdict, 'subject' | 'label' | 'open'> }) {
  const label = verdictLabel(v)
  const o = v.open
  if (!o) return <span className="rq-subject" title={label}>{label}</span>
  return <button type="button" className="rq-subject link" data-subject-open={o.kind} title={`${label} · open the ${o.kind === 'thread' ? 'thread' : 'issue'}`}
    onClick={() => (o.kind === 'thread' ? selectThread(o.id) : openItsa(o.id))}>{label}</button>
}

function LinkChip({ l }: { l: ReqLink }) {
  useData()
  const role = l.role.replace(/_/g, ' ')
  if (l.target_kind === 'itsa') {
    const it = getData().itsas.find((x) => x.key === l.target || x.id === l.target)
    return <button type="button" className="rq-chip link" data-trace-itsa={l.target} disabled={!it} title={it ? `${role} ${it.key} · ${it.title}` : `${role} ${l.target}`} onClick={() => it && openItsa(it.id)}>
      {it ? <StatusGlyph status={it.status} /> : <Icon name="list-checks" size="xs" />}<span className="muted">{role}</span><span className="ikey">{it?.key ?? l.target}</span>{it ? <span className="ct">{it.title}</span> : null}</button>
  }
  if (l.target_kind === 'requirement')
    return <button type="button" className="rq-chip link" data-trace-req={l.target} onClick={() => openReq(l.target)}><Icon name="scale" size="xs" /><span className="muted">{role}</span><span className="ikey">{l.target}</span></button>
  if (l.target_kind === 'url')
    return <a className="rq-chip link" href={l.target} target="_blank" rel="noreferrer noopener"><Icon name="external-link" size="xs" /><span className="muted">{role}</span><span className="ct">{l.target}</span></a>
  return <span className="rq-chip"><Icon name={l.target_kind === 'test' ? 'flask-conical' : l.target_kind === 'mail' ? 'mail' : 'file-text'} size="xs" /><span className="muted">{role}</span><span className="ct">{l.target}</span></span>
}

export function ReqView({ keyName, viewKey }: { keyName: string; viewKey: string }) {
  const { enabled, reqs } = useReq()
  useReqReader(viewKey)
  const [v, setV] = useState<RequirementView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The list row's latest verdicts change when a check lands: that reloads the view.
  const sig = JSON.stringify(reqs.find((x) => x.key === keyName)?.latest?.map((x) => [x.id, x.waived]) ?? null) + JSON.stringify(reqs.find((x) => x.key === keyName)?.version)
  const loaded = useRef<string | null>(null)
  const focusAsk = useReqFocus()
  const [flash, setFlash] = useState<number | null>(null)
  const load = useCallback(async () => {
    loaded.current = keyName
    try {
      // Only a whole verdict id goes in the query; anything else would send `?verdict=NaN`.
      const at = peekReqFocus(keyName)
      const r = await api<RequirementView>('GET', `/api/requirements/${encodeURIComponent(keyName)}${Number.isInteger(at) ? `?verdict=${at}` : ''}`)
      setV(r)
      setError(null)
      const title = `${r.key} ${r.title}`
      if (reqTitles.get(keyName) !== title) { reqTitles.set(keyName, title); refreshTabs() }
    } catch (e) { loaded.current = null; setError((e as Error).message) }
  }, [keyName])
  useEffect(() => { if (enabled) load() }, [load, sig, enabled])
  useEffect(() => registerView(viewKey, { show: () => { if (loaded.current !== keyName) load() } }), [viewKey, keyName, load])
  // A matrix cell asked for one verdict: load with it, then scroll to it and mark it once.
  useEffect(() => { if (enabled && focusAsk?.key === keyName) load() }, [focusAsk, keyName, enabled, load])
  useEffect(() => {
    const at = peekReqFocus(keyName)
    if (at == null || !v?.verdicts.some((x) => x.id === at)) return
    takeReqFocus(keyName)
    setFlash(at)
    requestAnimationFrame(() => document.querySelector(`[data-req-view="${CSS.escape(keyName)}"] [data-verdict="${at}"]`)?.scrollIntoView({ block: 'center' }))
  }, [v, keyName])
  const reload = () => { load(); refreshReq() }

  if (!enabled) return <div className="itsa-view"><div className="empty-pane"><h3>Requirements are off</h3><p>Turn them on in Settings to see {keyName}.</p></div></div>
  if (error && !v) return <div className="itsa-view"><div className="empty-pane"><h3>Can't show this requirement</h3><p>{error}</p></div></div>
  if (!v) return <div className="itsa-view" />
  const st = stateOf(reqs.find((x) => x.key === v.key)?.latest)
  const parent = v.parent_chain.at(-1)
  const scope = Object.entries(v.scope ?? {}).flatMap(([k, xs]) => (xs ?? []).map((x) => [k, x] as const))
  const allocated = v.links.filter((l) => l.target_kind === 'itsa')
  const other = v.links.filter((l) => l.target_kind !== 'itsa')
  const p = v.precision
  const waive = (e: React.MouseEvent<HTMLButtonElement>, x: ReqVerdict) => { const [left, top] = anchor(e.currentTarget); showPopover(left, top, `Waive ${v.key}`, <WaiveForm v={x} keyName={v.key} done={reload} />, e.currentTarget) }
  const preview = (e: React.MouseEvent<HTMLButtonElement>) => { const [left, top] = anchor(e.currentTarget); showPopover(left, top, `Preview ${v.key}`, <PreviewSheet keyName={v.key} threshold={v.threshold} />, e.currentTarget) }
  return (
    <div className="itsa-view req-view" data-req-view={v.key}>
      <div className="itsa-inner">
        {v.parent_chain.length ? <nav className="crumbs" aria-label="Parents">{v.parent_chain.map((x) => (
          <span key={x.id} className="crumb"><button type="button" className="crumb-link" onClick={() => openReq(x.key)} title={`${x.key} · ${x.title} · ${STATUS_WORD[x.status]}`}>
            <span className="ikey">{x.key}</span><span className="ct">{x.title}</span></button><Icon name="chevron-right" size="xs" /></span>))}</nav> : null}
        <header className="itsa-head">
          <h2><span className="ikey">{v.key}</span>{v.title}</h2>
          <div className="itsa-props rq-props">
            <span className={`rq-state ${st}`} title="From the latest checks at this version, waived ones left out: an indication, not proof"><ReqGlyph state={st} status={v.status} />{STATE_WORD[st]}</span>
            <span className={`chip rq-status ${v.status}`} title="Status">{STATUS_WORD[v.status]}</span>
            <span className={`chip rq-sev ${v.severity}`} title="Severity">{v.severity}</span>
            <span className="chip" title={v.mode === 'observe' ? 'Observe: checks are recorded only' : v.mode === 'inform' ? 'Inform: the actor is told' : 'Enforce: a merge can be held, a tool call denied'}>{v.mode}</span>
            <span className="person" title="Owner: answers waivers and false-positive reports"><PersonGlyph id={v.owner} />{personName(v.owner)}</span>
            {v.level ? <span className="chip kind" title="Level">{v.level}</span> : null}
            <span className="muted rq-ver" title={`Acts at P(violates) ${Math.round(v.threshold * 100)}%`}>v{v.version} · acts at {Math.round(v.threshold * 100)}%</span>
          </div>
        </header>

        {v.text ? <blockquote className="rq-shall">{v.text}</blockquote> : <p className="muted">No shall text yet.</p>}
        {v.rationale || v.source ? <p className="rq-why">{v.rationale}{v.source ? <span className="muted"> Source: {v.source}</span> : null}</p> : null}

        <section className="itsa-sec" aria-label="Verification">
          <div className="itsa-sec-head"><span className="eyebrow">Verification</span><span className="spacer" />
            <button type="button" className="btn text" data-preview-open title="Run it on recent subjects in its scope; records nothing" onClick={preview}><Icon name="play" />Preview</button></div>
          <div className="rq-chips">
            {(v.verification ?? []).length ? (v.verification ?? []).map((m, i) => <span key={i} className="rq-chip"><b>{m.method}</b>{m.detail ? <span className="ct">{m.detail}</span> : null}</span>) : <span className="muted">No method</span>}
          </div>
          <div className="rq-chips" aria-label="Scope">
            {scope.length ? scope.map(([k, x]) => <span key={k + x} className="rq-chip scope"><span className="muted">{SCOPE_LABEL[k] ?? k}</span><span className="ct">{x}</span></span>) : <span className="muted">Scope: everything</span>}
          </div>
        </section>

        <section className="itsa-sec" aria-label="Trace">
          <div className="itsa-sec-head"><span className="eyebrow">Trace</span></div>
          <div className="rq-chips">
            {parent ? <button type="button" className="rq-chip link" data-trace-req={parent.key} onClick={() => openReq(parent.key)}><Icon name="corner-left-up" size="xs" /><span className="muted">parent</span><span className="ikey">{parent.key}</span><span className="ct">{parent.title}</span></button> : null}
            {v.children.map((c) => <button key={c.id} type="button" className="rq-chip link" data-trace-req={c.key} onClick={() => openReq(c.key)}><Icon name="arrow-down" size="xs" /><span className="muted">child</span><span className="ikey">{c.key}</span><span className="ct">{c.title}</span></button>)}
            {allocated.map((l) => <LinkChip key={l.id} l={l} />)}
            {other.map((l) => <LinkChip key={l.id} l={l} />)}
            {!parent && !v.children.length && !v.links.length ? <span className="muted">No parent, children, or links.</span> : null}
          </div>
        </section>

        <section className="itsa-sec" aria-label="Precision">
          <div className="itsa-sec-head"><span className="eyebrow">Precision</span>
            {p.rate != null ? <span className={'count' + (p.rate > p.max_rate ? ' rq-over' : '')} data-fp-rate>{Math.round(p.rate * 100)}% false positives</span> : null}</div>
          <p className="muted">{p.violates
            ? `${p.false_positives} of its last ${p.violates} likely violations at v${v.version} were waived as false positives${p.accepted_deviations ? `, ${p.accepted_deviations} as accepted deviations` : ''}. If more than ${Math.round(p.max_rate * 100)}% are waived, it switches to observe-only.`
            : `No likely violation at v${v.version} yet, so no rate. If more than ${Math.round(p.max_rate * 100)}% of its flags are waived as false positives, it switches to observe-only.`}</p>
        </section>

        <section className="itsa-sec" aria-label="Recent verdicts">
          <div className="itsa-sec-head"><span className="eyebrow">Recent verdicts</span>{v.verdicts.length ? <span className="count">{v.verdicts.length}</span> : null}</div>
          {v.verdicts.length ? <ul className="rq-verdicts">{v.verdicts.map((x) => (
            <li key={x.id} className={'rq-verdict' + (x.waiver ? ' waived' : '') + (x.req_version !== v.version ? ' old' : '') + (flash === x.id ? ' flash' : '')} data-verdict={x.id} onAnimationEnd={() => setFlash(null)}>
              <SubjectName v={x} />
              <span className={`rq-word ${x.verdict}`}>{verdictWord(x.verdict)}</span>
              <ProbBar p={x.p_violates} threshold={v.threshold} />
              <span className="rq-meta muted">{x.req_version !== v.version ? `v${x.req_version} · ` : ''}<time dateTime={x.ts} title={x.ts}>{ago(x.ts)}</time></span>
              {x.waiver ? <span className="rq-waived" data-waived title={x.waiver.reason ?? undefined}>{WAIVER_WORD[x.waiver.kind]}</span>
                : x.verdict === 'violates' || x.verdict === 'unsure'
                  ? <button type="button" className="btn rq-waive" data-waive={x.id} aria-haspopup="dialog" onClick={(e) => waive(e, x)}>Waive</button> : <span className="rq-waived" />}
            </li>))}</ul>
            : <p className="muted">Not checked yet. A check is an indication from a model, not proof.</p>}
        </section>
      </div>
    </div>
  )
}
