// An ITSA's own world (`w:itsa:ID`, view key `itsa:ID`): the parent chain as a breadcrumb,
// a header with key, title, status (its category's glyph and tone), owner (harness mark
// and state ring), kind, and health; the summary; the body through the mail components;
// children with their status and roll-up; links; participants; and the thread, or the
// activity until the thread exists. Status and owner change from the header, as the human.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { ago, baseSubject, costShort, money } from '../format'
import { Icon } from '../Icon'
import { CATEGORY_LABEL, HEALTH, isClosed, openBoard, openItsa, ownerMenu, PersonGlyph, personName, RollupBar, rollupText, rollupTotal, StatusGlyph, statusInfo, statusLabel, statusMenu, toneVar, unsavedKids } from '../itsa/itsa'
import { NewItsa } from '../itsa/IssuesSide'
import { actItsa, ItsaActions } from '../itsa/ItsaActions'
import { AskBlockLine } from '../itsa/AskBlockLine'
import { Card, cardClick, MailAttachments, nameFor, resolveMailMedia, SupersededBy, VerdictMark } from '../mail/ThreadPanel'
import * as mb from '../mail/mailblocks'
import { ConvMailCard, MailKind, YouChip, youDir } from '../mail/ConvMailCard'
import { NoticeLine, TurnFrame } from '../mail/TurnFrame'
import { ViewDiff } from '../diff/ViewDiff'
import { LinkedMail } from '../mail/LinkedMail'
import { MailTools } from '../mail/MailTools'
import { Rendered } from '../mail/Rendered'
import { isPhone, refreshTabs, registerView } from '../shell/layout'
import { bottomHandle, setBottomSlot } from '../bottom-slot'
import { useData } from '../store'
import { showMenu } from '../ui/menu'
import type { AboutThread, LinkedThread, CostMode, CostModes, ItsaAction, ItsaEvent, ItsaThreadItem, ItsaView as View, RetroItem, RetrosView } from '../types'
import { Composer, type ComposerHandle, type SendPayload } from '../Composer'
import { assistantOpts, selectAgent, selectThread } from '../actions'
import { ItsaReqs } from '../req/ItsaReqs'
import { ReqBatch } from '../req/ReqBatch'
import { activityOf, fmtDuration, waitColor, type ItsaActivity, type ItsaActivityReport } from '../work/links'

export const itsaTitles = new Map<string, string>()


// The body: Markdown with every mail component (mail/Rendered.tsx).
const Body = ({ text }: { text: string }) => <Rendered text={text} className="itsa-body" />

// One line per event: who did what, and when.
function eventText(e: ItsaEvent): React.ReactNode {
  let d: { from?: unknown; to?: unknown; text?: unknown } = {}
  try { d = e.data ? JSON.parse(e.data) : {} } catch {}
  switch (e.type) {
    case 'created': return 'created this'
    case 'status': return <>set the status to <b>{statusLabel(String(d.to))}</b></>
    case 'owner': return d.to ? <>made <b>{nameFor(String(d.to))}</b> the owner</> : 'removed the owner'
    case 'title': return <>renamed this to <b>{String(d.to)}</b></>
    case 'summary': return 'edited the summary'
    case 'body': return 'edited the description'
    case 'kind': return d.to ? <>set the kind to <b>{String(d.to)}</b></> : 'cleared the kind'
    case 'parent': return d.to ? 'moved this under another ITSA' : 'made this a root'
    case 'participants': return 'changed the participants'
    case 'link.added': return 'added a link'
    case 'link.removed': return 'removed a link'
    case 'process-run': return String(d.text ?? 'ran a process step')
    default: return e.type
  }
}
// The human is "you", which starts a line as "You"; agents keep their names as written.
// A process-run line has no actor: the system wrote it, so it reads as stam, not as the human.
const who = (e: ItsaEvent) => e.actor ?? (e.type === 'process-run' ? 'mootr' : 'human')
const capital = (s: string) => (s === 'you' ? 'You' : s)
function Events({ events }: { events: ItsaEvent[] }) {
  if (!events.length) return <p className="muted">No activity yet.</p>
  return <ol className="itsa-events">{events.map((e) => (
    <li key={e.id}><PersonGlyph id={who(e)} /><span><b>{capital(nameFor(who(e)))}</b> {eventText(e)}</span><span className="t" title={new Date(e.ts).toLocaleString()}>{ago(e.ts)}</span></li>))}</ol>
}

// --- The ITSA's thread --------------------------------------------------------------------
// GET /api/itsas/:id/thread: the thread's mails and the status and owner changes, merged by
// time. It shows once the ITSA has a thread; until then the activity from GET
// /api/itsas/:id does. Either way the human comments below, which starts the thread.
function useThread(v: View | null, tick: number) {
  const [items, setItems] = useState<ItsaThreadItem[] | null>(null)
  const reload = useCallback(() => {
    if (!v?.thread_id) { setItems(null); return }
    api<{ items: ItsaThreadItem[] }>('GET', `/api/itsas/${v.id}/thread`).then((r) => setItems(Array.isArray(r?.items) ? r.items : null), () => setItems(null))
  }, [v?.id, v?.thread_id])
  useEffect(() => { reload() }, [reload, tick, v?.updated_at])
  return { items, reload }
}
function HealthBadge({ health }: { health?: string | null }) {
  const h = health ? HEALTH[health] : null
  return h ? <span className="health" style={{ color: h.tone }}><i />{h.label}</span> : null
}
// --- Mail about the ITSA -----------------------------------------------------------------
// GET /api/itsas/:id/threads: the mail threads about this ITSA, without its own thread (the
// Thread section shows that). A tap opens the thread, as the mail list does.
function useMailThreads(id: string, deps: unknown[]) {
  const [rows, setRows] = useState<AboutThread[] | null>(null)
  useEffect(() => {
    api<AboutThread[]>('GET', `/api/itsas/${id}/threads`).then((r) => setRows(Array.isArray(r) ? r : null), () => setRows(null))
  }, [id, ...deps])
  return rows
}
// GET /api/mail/linked/:id: the threads linked to this ITSA (S-986), by what a sender named, keys in the text, or its thread.
function useLinkedMail(id: string, deps: unknown[]) {
  const [rows, setRows] = useState<LinkedThread[] | null>(null)
  useEffect(() => {
    api<LinkedThread[]>('GET', `/api/mail/linked/${id}`).then((r) => setRows(Array.isArray(r) ? r : null), () => setRows(null))
  }, [id, ...deps])
  return rows
}
function MailRow({ r }: { r: AboutThread }) {
  const people = r.participants.filter((p) => p !== 'human')
  const names = people.length > 3 ? `${people.slice(0, 2).map((p) => nameFor(p)).join(', ')} +${people.length - 2}` : people.map((p) => nameFor(p)).join(', ')
  return (
    <button type="button" className={'imail' + (r.unread ? ' unread' : '')} data-thread={r.thread_id} onClick={() => selectThread(r.thread_id)} title={baseSubject(r.subject)}>
      <span className="imail-subj">{baseSubject(r.subject)}</span>
      <span className="imail-people">{names || 'only you'}</span>
      <span className="imail-meta">{r.unread ? <span className="badge n" title="Unread">{r.unread}</span> : null}<span className="t" title={new Date(r.last_at).toLocaleString()}>{ago(r.last_at)}</span></span>
    </button>
  )
}
// The thread's mails are conversation turns (S-1508): each mail in full as a ConvMailCard, agent-to-agent mail too, with
// its sender and recipients. Status changes stay one-line events between them, and stam system mail a notice line. Mail to
// or from you wears a coloured rail and a chip, a different colour for each direction. Decisions show, but can't be answered here.
export function ThreadItems({ items, atEnd }: { items: ItsaThreadItem[]; atEnd?: boolean }) {
  const mails = items.flatMap((x) => (x.type === 'mail' ? [x.mail] : []))
  // The thread opens at its latest message (S-1500): once per thread, the page scrolls to its end.
  const box = useRef<HTMLDivElement>(null)
  const scrolled = useRef<string | null>(null)
  const tid = mails[0]?.thread_id ?? ''
  useLayoutEffect(() => {
    if (!atEnd || !tid || scrolled.current === tid) return
    scrolled.current = tid
    box.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  })
  if (!items.length) return <p className="muted">Nothing yet.</p>
  return <div className="ov-col itsa-msgs itsa-turns" ref={box} onClick={(e) => { cardClick(e, mails, mails[0]?.thread_id ?? '') }} onInput={(e) => mb.handleInput(e.nativeEvent)}>{items.map((x) => {
    if (x.type !== 'mail') return <div key={'e' + x.id} className="itsa-event"><PersonGlyph id={x.actor ?? 'human'} /><span>{x.text.charAt(0).toUpperCase() + x.text.slice(1)}</span><span className="t" title={new Date(x.ts).toLocaleString()}>{ago(x.ts)}</span></div>
    const m = x.mail
    if (m.from_id === 'stam') return <div key={'m' + m.id} className="ov-turn-root"><TurnFrame id={m.id} kind="notice" input={<div className="ov-msg ov-system"><NoticeLine text={m.body} line={'stam: ' + (m.subject ?? m.body.split('\n')[0])} /></div>} /></div>
    const dir = youDir(m)
    return (
      <div key={'m' + m.id} className="ov-turn-root">
        {m.from_id === 'human' ? null : <MailTools mail={m} />}
        <TurnFrame id={m.id} kind={dir === 'from' ? 'human-mail' : 'mail'} input={<>
          {m.permission
            ? <><MailKind m={m} /><YouChip dir={dir} /><Card m={m} first={m.id === mails[0].id} thread={mails} canAnswer={false} ask={null} flash={false} onFlashEnd={() => {}} onFold={() => {}} onMoreItsas={() => {}} /></>
            : <ConvMailCard m={m} full noThread resolve={(el) => resolveMailMedia(el, m)} before={m.superseded_by ? <SupersededBy m={m} thread={mails} /> : null} after={<MailAttachments m={m} />}
              chip={m.override || m.verdict ? <VerdictMark v={m.verdict} override={m.override} /> : null} />}
        </>} />
      </div>
    )
  })}</div>
}

// --- The Retros parent (S-162) -------------------------------------------------------------
// GET /api/retros: on the standing Retros ITSA (kind retros), the open retro items above its
// children, filtered by kind; the effort split per model and type; and the coverage line.
const RETRO_KINDS = ['all', 'went_well', 'improve', 'idea', 'instruction', 'stam_issue'] as const
const EFFORT_LABEL: Record<string, string> = { reading: 'reading', implementing: 'implementing', testing: 'testing', waiting: 'waiting', review_fixes: 'review fixes', coordination: 'coordination' }
function Retros() {
  const { mailTick } = useData()
  const [data, setData] = useState<RetrosView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<string>('all')
  useEffect(() => {
    api<RetrosView>('GET', '/api/retros').then((r) => { setData(r); setError(null) }, (e) => setError((e as Error).message))
  }, [mailTick])
  if (error && !data) return <section className="itsa-sec" aria-label="Retros"><p className="muted">Can't load the retros: {error}</p></section>
  if (!data) return <section className="itsa-sec" aria-label="Retros" />
  const items = data.items.filter((x) => kind === 'all' || x.kind === kind)
  const { archived, withRound, without } = data.coverage
  return (
    <section className="itsa-sec" aria-label="Retros" data-retros>
      <div className="itsa-sec-head"><span className="eyebrow">Retros</span>{data.items.length ? <span className="count">{data.items.length}</span> : null}</div>
      <div className="retro-filters" role="group" aria-label="Filter by kind">{RETRO_KINDS.map((k) => (
        <button type="button" key={k} className={'chip' + (kind === k ? ' on' : '')} aria-pressed={kind === k} data-retro-kind={k} onClick={() => setKind(k)}>{k.replace('_', ' ')}</button>))}</div>
      {items.length ? <div className="retro-items">{items.map((x: RetroItem) => (
        <button type="button" key={x.id} className="retro-row" data-itsa={x.id} onClick={() => openItsa(x.id)} title={`${x.key} · ${x.title}`}>
          <span className="ikey">{x.key}</span><span className="ititle">{x.title}</span>
          <span className="chip kind">{x.kind}</span>{x.target && x.target !== 'none' ? <code>{x.target}</code> : null}{x.plusOnes > 0 ? <span className="plus">+{x.plusOnes}</span> : null}
        </button>))}</div>
        : <p className="muted">{data.items.length ? 'No retro items of this kind.' : 'No open retro items in the last 30 days.'}</p>}
      <div className="itsa-sec-head retro-sub"><span className="eyebrow">Effort</span></div>
      {data.effort.length ? data.effort.map((e) => (
        <div className="retro-effort-wrap" key={`${e.model ?? ''}|${e.type ?? ''}`}>
          <p className="retro-effort-cap">{e.model ?? 'no model'} · {e.type ?? 'no type'}</p>
          <table className="retro-effort">
            <thead><tr><th scope="col">Rounds</th>{Object.keys(EFFORT_LABEL).map((k) => <th scope="col" key={k}>{EFFORT_LABEL[k]}</th>)}</tr></thead>
            <tbody><tr><td>{e.rounds}</td>{Object.keys(EFFORT_LABEL).map((k) => <td key={k}>{e.avg[k] ?? 0}%</td>)}</tr></tbody>
          </table>
          <dl className="retro-effort-list">
            <dt>Rounds</dt><dd>{e.rounds}</dd>
            {Object.keys(EFFORT_LABEL).map((k) => <Fragment key={k}><dt>{EFFORT_LABEL[k]}</dt><dd>{e.avg[k] ?? 0}%</dd></Fragment>)}
          </dl>
        </div>)) : <p className="muted">No final rounds yet.</p>}
      <p className="retro-coverage muted">{archived ? `${archived} archived, ${withRound} with a final round${without.length ? `; no round: ${without.join(', ')}` : ''}` : 'No agents archived in the last 30 days.'}</p>
    </section>
  )
}

// --- The cost line (S-155, S-319) --------------------------------------------------------
// GET /api/itsas/:id/cost: the ITSA's own spend and its total with children, its agents with
// their share of the own spend, its config, and its share of the week. Fetched once per ITSA;
// a failure shows nothing. `cost` is the same spend in the user's chosen unit (S-316): the line
// shows it in `cost.mode`; the fold's agent rows stay API-equivalent dollars, per agent.
interface ItsaCost {
  note: string
  own: { cost_usd: number }
  total: { cost_usd: number }
  agents: { agent: string; id: string; cost_usd: number; share: number }[]
  config: string | null
  weekly_percent: number | null
  // Absent from a daemon older than S-316: the line falls back to the dollars above.
  cost?: { mode: CostMode; own: CostModes; total: CostModes }
}
const NO_VALUE = 'no price set, or not calibrated yet'
// One value in the unit: '–' with the reason when it's null; real paid spend beside it.
function CostValue({ m, mode }: { m: CostModes; mode: CostMode }) {
  const v = m[mode]
  return <>
    {v == null ? <span title={NO_VALUE}>–</span> : costShort(v, mode)}
    {m.paid_usd > 0 ? <span className="muted"> + {money(m.paid_usd)} paid</span> : null}
  </>
}
export function CostLine({ id }: { id: string }) {
  const [cost, setCost] = useState<ItsaCost | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    setCost(null)
    api<ItsaCost>('GET', `/api/itsas/${id}/cost`).then((r) => { if (live) setCost(r) }, () => {})
    return () => { live = false }
  }, [id])
  if (!cost || !(cost.total.cost_usd > 0)) return null
  const withKids = cost.total.cost_usd !== cost.own.cost_usd
  // The week's share repeats the line in a window mode, so it shows in the dollar modes only.
  const dollars = cost.cost == null || cost.cost.mode === 'api' || cost.cost.mode === 'subscription'
  const week = dollars && cost.weekly_percent != null ? ` · ${cost.weekly_percent.toFixed(2)}% of week` : ''
  return (
    <>
      <button type="button" className="prop" data-prop="cost" aria-expanded={open} title={cost.note} onClick={() => setOpen(!open)}>
        <span>{cost.cost ? <CostValue m={cost.cost.own} mode={cost.cost.mode} /> : money(cost.own.cost_usd)}{withKids ? <> · {cost.cost ? <CostValue m={cost.cost.total} mode={cost.cost.mode} /> : money(cost.total.cost_usd)} with children</> : null}{week}</span><Icon name="chevron-down" size="xs" /></button>
      {open ? <div className="itsa-cost" data-itsa-cost>
        <ul className="itsa-cost-agents">{cost.agents.map((a) => (
          <li key={a.id}><button type="button" className="crumb-link" onClick={() => selectAgent(a.id)}>{capital(nameFor(a.id, a.agent))}</button>
            <span className="itsa-cost-val">{money(a.cost_usd)} · {Math.round(a.share * 100)}%</span></li>))}</ul>
        {cost.config ? <p className="itsa-cost-config muted">{cost.config}</p> : null}
      </div> : null}
    </>
  )
}

// --- Activity ----------------------------------------------------------------------------
// GET /api/activity?by=itsa (S-212, S-226): this ITSA's working and waiting time over its
// children, its cost, its review rounds, the time from creation to close, and who worked on it.
// Waiting lists its top-level kinds; each one opens to its leaf kinds on tap.
function ActivityBlock({ k, tick }: { k: string; tick: unknown }) {
  const [row, setRow] = useState<ItsaActivity | null>(null)
  useEffect(() => {
    let live = true
    api<ItsaActivityReport>('GET', `/api/activity?by=itsa&itsa=${encodeURIComponent(k)}`).then((r) => { if (live) setRow(activityOf(r, k)) }, () => {})
    return () => { live = false }
  }, [k, tick])
  if (!row) return null
  const { own: o, total: t } = row
  const leaves = (top: string) => Object.entries(t.waiting_by_kind).filter(([x]) => x === top || x.startsWith(top + '.')).sort((a, b) => b[1] - a[1])
  return (
    <section className="itsa-sec" aria-label="Time and cost" data-itsa-activity>
      <div className="itsa-sec-head"><span className="eyebrow">Time and cost</span></div>
      <dl className="itsa-activity">
        <dt>Working</dt><dd>{fmtDuration(o.working_s)} own · {fmtDuration(t.working_s)} with children</dd>
        <dt>Waiting</dt><dd>{fmtDuration(o.waiting_s)} own · {fmtDuration(t.waiting_s)} with children
          <ul className="itsa-activity-kinds">{Object.entries(t.waiting_by_top).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([top, v]) => (
            <li key={top}><details><summary><i className="itsa-activity-swatch" style={{ background: waitColor(top) }} aria-hidden="true" />{top} <span className="muted">{fmtDuration(v)}</span></summary>
              <ul>{leaves(top).map(([leaf, lv]) => <li key={leaf}>{leaf} <span className="muted">{fmtDuration(lv)}</span></li>)}</ul></details></li>))}</ul>
        </dd>
        <dt>Cost</dt><dd>{money(o.cost_usd)} own · {money(t.cost_usd)} with children</dd>
        <dt>Review</dt><dd>{row.review_rounds} {row.review_rounds === 1 ? 'round' : 'rounds'}</dd>
        <dt>Creation to close</dt><dd>{row.lead_s == null ? 'open' : fmtDuration(row.lead_s)}</dd>
      </dl>
      {row.agents.length ? <ul className="itsa-cost-agents itsa-activity-agents">{row.agents.map((a) => (
        <li key={a.id}><button type="button" className="crumb-link" onClick={() => selectAgent(a.id)}>{capital(nameFor(a.id, a.name))}</button>
          <span className="itsa-cost-val">{fmtDuration(a.working_s)}</span></li>))}</ul> : null}
    </section>
  )
}

export function ItsaView({ id, viewKey }: { id: string; viewKey: string }) {
  const { itsas, mailTick, attention } = useData()
  const [v, setV] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // The action (Approve, Request changes, Answer) the human clicked; the comment box's Send applies it.
  const [staged, setStaged] = useState<string | null>(null)
  // A batch approval lists its drafts in ReqBatch, so its body (the same list) isn't shown again.
  const [batchAsk, setBatchAsk] = useState(false)
  const composer = useRef<ComposerHandle>(null)
  // A change anywhere in the list (this ITSA, its children, their children) reloads it.
  const sig = JSON.stringify(itsas.filter((x) => x.id === id || x.parent_id === id).map((x) => [x.id, x.updated_at]))
  // The last ID loaded. The shell shows every view after each layout render, so a show
  // reloads only when this view hasn't loaded its ITSA yet.
  const loaded = useRef<string | null>(null)
  const load = useCallback(async () => {
    // Taken before the fetch, so a show while it is in flight doesn't fetch again.
    loaded.current = id
    try {
      const r = await api<View>('GET', `/api/itsas/${id}`)
      setV(r)
      setError(null)
      // Tab titles re-render the shell, which shows this view again: only a new title does that.
      const title = `${r.key} ${r.title}`
      if (itsaTitles.get(id) !== title) { itsaTitles.set(id, title); refreshTabs() }
    } catch (e) { loaded.current = null; setError((e as Error).message) }
  }, [id])
  useEffect(() => { load() }, [load, sig, mailTick])
  // The staged action ends when the ITSA no longer offers it (the owner moved it on).
  useEffect(() => { if (staged && v && !v.actions?.some((a) => a.id === staged)) setStaged(null) }, [v, staged])
  useEffect(() => registerView(viewKey, { show: () => { if (loaded.current !== id) load() } }), [viewKey, id, load])
  const { items: thread, reload: reloadThread } = useThread(v, mailTick)
  const mails = useMailThreads(id, [mailTick, v?.updated_at])
  const linkedMail = useLinkedMail(id, [mailTick, v?.updated_at])
  // Linked mail adds what the Mail section above doesn't already list: threads that name the ITSA without being about it.
  const linkedOnly = mails && linkedMail ? linkedMail.filter((r) => !mails.some((x) => x.thread_id === r.thread_id)) : []
  // A comment from the human goes to the participants; the first one starts the thread.
  const comment = async ({ text, files, client_id }: SendPayload) => {
    const act = v?.actions?.find((a) => a.id === staged)
    if (act) {
      // A refusal leaves the action staged and the text in the strip, to put back in the box.
      await actItsa(id, act.id, text, act.to, `${client_id}:act`)
      load(); reloadThread()
      return
    }
    await api('POST', `/api/itsas/${id}/post`, { body: text, attachments: files.map((f) => ({ name: f.name, content_b64: f.content_b64 })), client_id })
    await load()
    reloadThread()
    return 'Posted'
  }

  // On a desktop the bottom world's prompt input writes to this ITSA; the view publishes what it needs.
  const phone = isPhone()
  // Published as this render's own closures: the input takes them at submit, so a retry of that comment
  // keeps the staged action it was sent with, whatever is staged by then (the outbox calls the same send).
  const takeStaged = () => { const taken = staged; setStaged(null); return () => setStaged((cur) => cur ?? taken) }
  useEffect(() => {
    if (phone || !v) return setBottomSlot('itsa:' + id, null)
    const pend = v.actions?.find((a) => a.id === staged)
    setBottomSlot('itsa:' + id, {
      target: { key: 'itsa:' + id, name: `${v.key} ${v.title}`, enabled: true,
        label: <><Icon name="message-square" size="xs" />Comment to {v.participants.filter((p) => p !== 'human').map((p) => nameFor(p)).join(', ') || 'the thread'}</>,
        placeholder: pend ? (pend.text === 'required' ? `${pend.label}: write it here` : `${pend.label}: add a comment (optional), then send`) : thread ? 'Comment in this thread' : 'Comment; this starts the thread' },
      onSend: comment, staged: !!pend && pend.text !== 'required', onSubmit: takeStaged,
    })
  })
  useEffect(() => () => setBottomSlot('itsa:' + id, null), [id])

  if (error && !v) return <div className="itsa-view"><div className="empty-pane"><h3>Can't show this ITSA</h3><p>{error}</p></div></div>
  if (!v) return <div className="itsa-view" />
  // A status or owner change in flight (setItsa) shows over the fetched ITSA at once.
  const row = itsas.find((x) => x.id === id)
  const cur = row?.pending ? { ...v, status: row.status, owner: row.owner } : v
  const st = statusInfo(cur.status)
  const pick = (e: React.MouseEvent<HTMLButtonElement>, items: ReturnType<typeof statusMenu>) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, items, e.currentTarget) }
  // Health: the latest update's, from the thread (or the ITSA, if it carries one).
  const updates = (thread ?? []).flatMap((x) => (x.type === 'mail' && x.mail.kind === 'update' ? [x.mail] : []))
  const latest = updates.at(-1)
  const health = HEALTH[latest?.health ?? v.health ?? ''] ?? null
  const actions: ItsaAction[] = v.actions ?? []
  const pending = actions.find((a) => a.id === staged)
  const kids = [...v.children.filter((c) => !isClosed(c)), ...v.children.filter(isClosed)]
  // A child being added (createItsa) shows under the list until the daemon has it.
  const adds = unsavedKids(itsas.filter((x) => x.parent_id === id && x.pending), v.children)
  return (
    <div className="itsa-view" data-itsa={v.id}>
      <div className="itsa-inner">
        {v.parent_chain.length ? <nav className="crumbs" aria-label="Parents">{v.parent_chain.map((p) => (
          <span key={p.id} className="crumb"><button type="button" className="crumb-link" onClick={() => openItsa(p.id)} title={`${p.key} · ${p.title} · ${statusLabel(p.status)}`}>
            <StatusGlyph status={p.status} /><span className="ikey">{p.key}</span><span className="ct">{p.title}</span></button><Icon name="chevron-right" size="xs" /></span>))}</nav> : null}
        <header className="itsa-head">
          <h2><span className="ikey">{v.key}</span>{v.title}</h2>
          <div className={'itsa-props' + (row?.pending ? ' pending' : '')} aria-busy={row?.pending || undefined}>
            <button type="button" className="prop" data-prop="status" aria-haspopup="menu" title={`${CATEGORY_LABEL[st.category]}${st.human ? ', waits on you' : ''}. Change the status`}
              style={{ color: toneVar(cur.status) }} onClick={(e) => pick(e, statusMenu(cur, load))}>
              <StatusGlyph status={cur.status} /><span>{statusLabel(cur.status)}</span><Icon name="chevron-down" size="xs" /></button>
            <button type="button" className="prop" data-prop="owner" aria-haspopup="menu" title="Change the owner" onClick={(e) => pick(e, ownerMenu(cur, load))}>
              <PersonGlyph id={cur.owner} /><span className={cur.owner ? '' : 'muted'}>{personName(cur.owner)}</span><Icon name="chevron-down" size="xs" /></button>
            {v.kind ? <span className="chip kind" title="Kind">{v.kind}</span> : null}
            {row?.pending ? <span className="pending-mark muted" aria-live="polite">saving…</span> : null}
            {health ? <span className="health" style={{ color: health.tone }} title="Health, from the owner's latest update"><i />{health.label}</span> : null}
            <CostLine id={v.id} />
          </div>
        </header>
        {actions.length ? <div className="itsa-ask" role="group" aria-label="Waiting on you" data-itsa-ask>
          <span className="ask-label"><Icon name="user" size="xs" />Waiting on you</span><span className="spacer" />
          <AskBlockLine thread={attention.find((x) => x.id === id)?.ask_thread_id} />
          <ItsaActions itsa={v} staged={staged} onPick={(a) => { setStaged(staged === a.id ? null : a.id); (phone ? composer.current : bottomHandle())?.focus() }} />
          {pending ? <span className="ask-hint muted">{pending.text === 'required' ? `Write what you want below, then send. It moves to ${statusLabel(pending.to)}.` : `Send applies it${pending.text === 'optional' ? ', with a comment if you add one' : ''}. It moves to ${statusLabel(pending.to)}.`}</span> : null}
        </div> : null}
        <ReqBatch it={v} onBatch={setBatchAsk} />
        {v.summary && !batchAsk ? <p className="itsa-summary">{v.summary}</p> : null}
        {v.body && !batchAsk ? <Body text={v.body} /> : null}
        {latest ? <section className="itsa-sec itsa-update" aria-label="Latest update">
          <div className="itsa-sec-head"><span className="eyebrow">Latest update</span><HealthBadge health={latest.health} /></div>
          <ThreadItems items={[{ type: 'mail', ts: latest.created_at, mail: latest }]} /></section> : null}

        {v.kind === 'retros' ? <Retros /> : null}
        <section className="itsa-sec" aria-label="Children">
          <div className="itsa-sec-head"><span className="eyebrow">Children</span>
            {rollupTotal(v.rollup) ? <span className="count" title={rollupText(v.rollup)}>{v.rollup.closed}/{rollupTotal(v.rollup)}</span> : null}
            <RollupBar r={v.rollup} wide /><span className="spacer" />
            {v.children.length ? <button type="button" className="btn text" data-open-board onClick={() => openBoard(v.id)}><Icon name="kanban" />Board</button> : null}
            <button type="button" className="btn text" data-new-child onClick={() => setAdding(true)}><Icon name="plus" />New child</button></div>
          {adding ? <NewItsa parent={v.id} placeholder="Child's title" onDone={(it) => { setAdding(false); if (it) load() }} /> : null}
          {kids.length || adds.length ? <div className="itsa-kids">{adds.map((c) => (
            <div key={c.id} className="ikid pending" data-pending-child aria-busy="true" title={`${c.title}: adding`}>
              <StatusGlyph status={c.status} /><span className="ititle">{c.title}</span><span className="ikid-meta"><span className="st muted">adding</span></span>
            </div>))}{kids.map((c) => (
            <button type="button" key={c.id} className={'ikid' + (isClosed(c) ? ' closed' : '')} data-itsa={c.id} onClick={() => openItsa(c.id)} title={`${c.key} · ${c.title}`}>
              <StatusGlyph status={c.status} /><span className="ikey">{c.key}</span><span className="ititle">{c.title}</span>
              <span className="ikid-meta"><RollupBar r={c.rollup} /><span className="st" style={{ color: toneVar(c.status) }}>{statusLabel(c.status)}</span>
                {c.owner ? <span title={`Owner: ${personName(c.owner)}`}><PersonGlyph id={c.owner} /></span> : null}</span>
            </button>))}</div>
            : adding ? null : <p className="muted">No children. Break the work down with <b>New child</b>.</p>}
        </section>

        <ItsaReqs it={v} />

        {v.links.length ? <section className="itsa-sec" aria-label="Links">
          <div className="itsa-sec-head"><span className="eyebrow">Links</span></div>
          <ul className="itsa-links">{v.links.map((l) => (
            <li key={l.n}><a href={l.url} target="_blank" rel="noreferrer noopener"><Icon name={l.system === 'github' ? 'git-branch' : 'link'} size="xs" /><span>{l.external_id ?? l.url}</span><Icon name="external-link" size="xs" /></a>
              {l.system !== 'url' ? <span className="muted">{l.system}</span> : null}
              <ViewDiff link={l} links={v.links} /></li>))}</ul>
        </section> : null}

        <section className="itsa-sec" aria-label="Participants">
          <div className="itsa-sec-head"><span className="eyebrow">Participants</span></div>
          {v.participants.length ? <div className="itsa-people">{v.participants.map((p) => <span key={p} className="person"><PersonGlyph id={p} />{capital(nameFor(p))}{p === v.owner ? <span className="muted">owner</span> : null}</span>)}</div>
            : <p className="muted">Nobody yet. The owner joins when one is set.</p>}
        </section>

        <ActivityBlock k={v.key} tick={v.updated_at} />
        <section className="itsa-sec" aria-label="Mail">
          <div className="itsa-sec-head"><span className="eyebrow">Mail</span>{mails?.length ? <span className="count">{mails.length}</span> : null}</div>
          {mails?.length ? <div className="itsa-mails">{mails.map((r) => <MailRow key={r.thread_id} r={r} />)}</div>
            : mails ? <p className="muted">No mail about this yet.</p> : null}
        </section>

        {linkedOnly.length ? <section className="itsa-sec" aria-label="Linked mail">
          <div className="itsa-sec-head"><span className="eyebrow">Linked mail</span><span className="count">{linkedOnly.length}</span></div>
          <LinkedMail rows={linkedOnly} />
        </section> : null}

        {/* The thread once it exists (a comment or update starts it); until then, the activity. */}
        <section className="itsa-sec" aria-label={thread ? 'Thread' : 'Activity'} data-itsa-thread={thread ? 'thread' : 'events'}>
          <div className="itsa-sec-head"><span className="eyebrow">{thread ? 'Thread' : 'Activity'}</span></div>
          {thread ? <ThreadItems items={thread} atEnd /> : <Events events={v.events ?? []} />}
          {phone ? <div className="itsa-reply">
            <Composer ref={composer} className="inline" assistant={assistantOpts} onSend={comment} staged={!!pending && pending.text !== 'required'}
              // The staged action goes with this submit; a failed send puts it back.
              onSubmit={() => { const taken = staged; setStaged(null); return () => setStaged((cur) => cur ?? taken) }}
              target={{ key: 'itsa:' + id, name: `${v.key} ${v.title}`, enabled: true, label: <><Icon name="message-square" size="xs" />Comment to {v.participants.filter((p) => p !== 'human').map((p) => nameFor(p)).join(', ') || 'the thread'}</>,
                placeholder: pending ? (pending.text === 'required' ? `${pending.label}: write it here` : `${pending.label}: add a comment (optional), then send`) : thread ? 'Comment in this thread' : 'Comment; this starts the thread' }} />
          </div> : null}
        </section>
      </div>
    </div>
  )
}
