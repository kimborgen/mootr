// A tab in an agent's world: its state, actions, and facts. The "What stam gives this
// agent" fold loads its files the first time it opens, and again on each later open.
import { useEffect, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { agentAction, agentMenu, openAgent, openInbox, setChildNotices, setMode } from '../actions'
import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { HARNESS, ago, k, live, model, money, stateLabel } from '../format'
import { byId, useData } from '../store'
import { showMenu } from '../ui/menu'
import type { Agent } from '../types'
import { clock, left, RestBadge, WAIT_ICON, WaitLink, waitsOf } from '../waits'
import { Loading } from '../Loading'
import { followsSettings } from '../permission-modes'

interface AgentFile { name: string; text: string }
interface AgentEvent { type: string; ts: string; data?: string | null }
type Files = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; files: AgentFile[]; sent: string }

// One agent's own usage (`GET /api/agents/:id/usage`, S-95). A counter its harness doesn't
// report, or that the agent hasn't reported yet, is null and reads as missing.
interface UsageTotals {
  cost_usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}
interface AgentUsage { harness: string; model: string | null; lifetime: UsageTotals; today: UsageTotals }

const dash = (v: number | null | undefined, fmt: (n: number) => string) => (v == null ? '—' : fmt(v))

// An agent's tokens and cost, today and over its life. Header row names the two periods;
// a missing field is an em dash, never 0.
function UsageTable({ u }: { u: AgentUsage }) {
  const rows: [string, number | null, number | null, (n: number) => string][] = [
    ['Input', u.today.tokens_in, u.lifetime.tokens_in, k],
    ['Output', u.today.tokens_out, u.lifetime.tokens_out, k],
    ['Cache read', u.today.tokens_cache_read, u.lifetime.tokens_cache_read, k],
    ['Cache write', u.today.tokens_cache_write, u.lifetime.tokens_cache_write, k],
    ['Cost', u.today.cost_usd, u.lifetime.cost_usd, money],
  ]
  return (
    <>
      <div className="eyebrow">Tokens and cost</div>
      <table className="data usage-tokens">
        <thead><tr><th>Kind</th><th className="num">Today</th><th className="num">Lifetime</th></tr></thead>
        <tbody>
          {rows.map(([label, today, life, fmt]) => (
            <tr key={label}><td>{label}</td><td className="num">{dash(today, fmt)}</td><td className="num">{dash(life, fmt)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

const SENT = /^(pushed|mail:|notice:|compact|pending|banner|restart|resume|spawn|permission)/

function AgentLinks({ list }: { list: Agent[] }) {
  return list.map((x, i) => (
    <span key={x.id}>{i ? ', ' : ''}<a href="#" onClick={(e) => { e.preventDefault(); openAgent(x.id) }}>{x.name}</a></span>
  ))
}

function Fold({ id }: { id: string }) {
  const [files, setFiles] = useState<Files>({ state: 'loading' })
  const load = async () => {
    try {
      const [fs, events] = await Promise.all([api<AgentFile[]>('GET', `/api/agents/${id}/files`), api<AgentEvent[]>('GET', `/api/agents/${id}/events`)])
      const sent = events.filter((ev) => SENT.test(ev.type)).slice(-30).map((ev) => `${ev.ts.slice(11, 19)} ${ev.type} ${ev.data ?? ''}`).join('\n') || 'None yet.'
      setFiles({ state: 'ok', files: fs, sent })
    } catch (err) { setFiles({ state: 'error', message: (err as Error).message }) }
  }
  return (
    <details className="fold" onToggle={(e) => { if (e.currentTarget.open) void load() }}>
      <summary><Icon name="chevron-right" size="xs" /><span className="eyebrow">What mootr gives this agent</span></summary>
      <div className="files">
        {files.state === 'loading' ? <Loading className="muted" /> : files.state === 'error' ? files.message : (
          <>
            {files.files.map((f) => (
              <div key={f.name}><div className="eyebrow" style={{ marginTop: 8 }}>{f.name}</div><pre className="code">{f.text}</pre></div>
            ))}
            <div className="eyebrow" style={{ marginTop: 8 }}>Recent mootr actions</div><pre className="code">{files.sent}</pre>
          </>
        )}
      </div>
    </details>
  )
}

export function DetailsView({ id }: { id: string }) {
  const { agents, thresholds } = useData()
  const a = byId(id)
  const [busy, setBusy] = useState<string | null>(null)
  // The mode the human just picked, shown until the agent reports it (or a declined or
  // failed switch snaps the select back).
  const [picked, setPicked] = useState<string | null>(null)
  const [usage, setUsage] = useState<AgentUsage | null>(null)
  useEffect(() => {
    if (picked === null) return
    if (a?.permission_mode === picked) { setPicked(null); return }
    const t = setTimeout(() => setPicked(null), 4000)
    return () => clearTimeout(t)
  }, [picked, a?.permission_mode])
  // Its tokens and cost, today and for its life. A failure just leaves the table out.
  useEffect(() => {
    let live = true
    api<AgentUsage>('GET', `/api/agents/${id}/usage`).then((r) => { if (live) setUsage(r) }, () => {})
    return () => { live = false }
  }, [id])

  if (!a) return <div className="details pad"><div className="empty-pane"><p>This agent is gone.</p></div></div>

  const m = model(a)
  const parents = (a.parents ?? []).map((p) => byId(p)).filter((x): x is Agent => !!x)
  const kids = agents.filter((x) => (x.parents ?? []).includes(a.id))
  const ctx = a.context_tokens ?? 0
  const max = thresholds.enforceTokens
  const mode = picked ?? (followsSettings(a) ? 'settings' : a.permission_mode ?? 'auto')
  const act = async (name: string) => {
    setBusy(name)
    await agentAction(a, name)
    setBusy(null)
  }
  const changeMode = async (to: 'auto' | 'bypass' | 'default' | 'settings') => {
    setPicked(to)
    if (!(await setMode(a, to))) setPicked(null)
  }
  const meter = { width: `${Math.min(100, (ctx / max) * 100)}%`, background: `var(--st-${['working', 'blocked', 'errored', 'errored'][a.context_level ?? 0]})` }
  const mono12: CSSProperties = { fontSize: 12 }
  const waits = live(a) ? waitsOf(a) : []

  return (
    <div className="details pad">
      <h2>
        <Glyph agent={a} />{a.name}{' '}
        <span className="chip" style={{ '--mc': m.color } as CSSProperties}>{m.label}</span>
        <button className="icon-btn" title="More actions" style={{ marginLeft: 'auto' }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left - 160, r.bottom + 4, agentMenu(a), e.currentTarget) }}><Icon name="ellipsis" /></button>
      </h2>
      <div className="sub">{stateLabel(a)}{a.activity_detail ? ' · ' + a.activity_detail : ''}{a.role ? ' · ' + a.role : ''}</div>
      {a.resting ? <div className="sub"><RestBadge a={a} /></div> : null}
      <div className="actions-row">
        {live(a) ? (
          <>
            <button className="btn" disabled={busy !== null} onClick={() => act(a.lifecycle === 'paused' ? 'unpause' : 'pause')}><Icon name={a.lifecycle === 'paused' ? 'play' : 'pause'} />{a.lifecycle === 'paused' ? 'Unpause' : 'Pause'}</button>
            <button className="btn" disabled={busy !== null} onClick={() => act('restart')}><Icon name="rotate-ccw" />Restart</button>
            <button className="btn" disabled={busy !== null} onClick={() => act('compact')}><Icon name="minimize-2" />Compact</button>
          </>
        ) : (
          <button className="btn" disabled={busy !== null} onClick={() => act('resume')}><Icon name="play" />Resume</button>
        )}
        <button className="btn" onClick={() => openInbox(a.id)}><Icon name="inbox" />Inbox{a.unread ? <> <span className="badge">{a.unread}</span></> : null}</button>
      </div>
      <dl className="kv">
        {waits.length ? <><dt>Waiting for</dt><dd><ul className="wait-list">{waits.map((w) => (
          <li key={w.id}><Icon name={WAIT_ICON[w.kind] ?? 'clock'} size="xs" /><span><WaitLink w={w} />{' '}
            <span className="muted">{w.until && w.kind === 'timer' ? `(in ${left(w.until)}) ` : ''}· since {ago(w.since)}{w.until && w.kind !== 'timer' ? ` · until ${clock(w.until)} (in ${left(w.until)})` : ''} · {w.source}</span></span></li>))}
        </ul></dd></> : null}
        {a.type ? <><dt>Type</dt><dd>{a.type}</dd></> : null}
        <dt>Harness</dt><dd>{HARNESS[a.harness] ?? a.harness} · {a.model ?? 'default model'}{a.effort ? ' · ' + a.effort : ''}</dd>
        <dt>Context</dt>
        <dd>
          {k(ctx)} of {k(max)} <span className="muted">· window {k(a.context_window)}</span>
          <div className="meter"><i style={meter} />
            <b style={{ left: `${(thresholds.warnTokens / max) * 100}%` }} title="warning" />
            <b style={{ left: `${(thresholds.instructTokens / max) * 100}%` }} title="asked to compact" />
          </div>
        </dd>
        <dt>Permissions</dt>
        <dd>
          {live(a) ? (
            <select value={mode} onChange={(e) => void changeMode(e.target.value as 'auto' | 'bypass' | 'default' | 'settings')}>
              <option value="settings">Follow settings</option>
              {a.harness === 'claude' ? <option value="default">Ask</option> : null}
              <option value="auto">Auto mode</option>
              <option value="bypass">Bypass permissions</option>
            </select>
          ) : a.permission_mode}
          {followsSettings(a) ? <span className="muted"> · {a.permission_mode}, from Settings</span> : null}
          {mode === 'bypass' ? <div className="sp-warn" role="alert">Bypass runs every action without asking.</div> : null}
        </dd>
        <dt>Child notices</dt>
        <dd>
          <select value={a.child_notices ?? 'tree-idle'} onChange={(e) => void setChildNotices(a, e.target.value)}>
            <option value="turn">Every turn</option>
            <option value="tree-idle">When its subtree is idle</option>
            <option value="none">Never (blockers still reach me)</option>
          </select>
        </dd>
        <dt>Machine</dt><dd>{a.machine}</dd>
        <dt>Folder</dt><dd className="mono" style={mono12}>{a.cwd}</dd>
        {parents.length ? <><dt>Parent{parents.length > 1 ? 's' : ''}</dt><dd><AgentLinks list={parents} /></dd></> : null}
        {kids.length ? <><dt>Children</dt><dd><AgentLinks list={kids} /></dd></> : null}
        <dt>Started</dt><dd>{ago(a.created_at)}</dd>
        <dt>Id</dt><dd className="mono" style={mono12}>{a.id}</dd>
      </dl>
      {usage ? <UsageTable u={usage} /> : null}
      {a.last_message ? <><div className="eyebrow">Last message</div><div className="say">{a.last_message}</div></> : null}
      <Fold id={a.id} />
    </div>
  )
}
