// Settings › Prompt caching (S-2239): read-only facts about each harness's prompt cache, mootr's
// timers around it (live from settings), and the cache window detected for each Claude Code agent
// (S-2236, GET /api/cache/agents). A subscription agent that writes 5-minute caches has spilled into
// credits, and every mootr timer assumes the 1-hour window, so the page warns about it.
// With `edit` (Settings passes its own controls), mootr's timers and the harness settings it passes on
// at launch (settings.harness, S-2240) are edited by their paths and saved like any other setting.
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { Loading } from '../Loading'
import { HARNESS, ago } from '../format'
import { CACHE_FACTS, HARNESS_SETTINGS, cacheTimers, harnessValue, type CacheFacts, type HarnessSetting } from '../cache-facts'

export interface CacheAgent {
  id: string
  name: string
  machine: string
  harness: string
  model: string | null
  lifecycle: string
  account: string | null
  paid: boolean
  ttl: '1h' | '5m' | null
  ttl_at: string | null
}
type Obj = Record<string, unknown>

// Settings' own controls, each saving the setting at `path`.
export interface CacheEdit {
  choice: (path: string, options: { v: string | boolean | null; label: string }[]) => ReactNode
  num: (path: string, o: { unit: string; min: number; max?: number; dflt?: number; nullable?: boolean }) => ReactNode
}

// A subscription Claude agent writing 5-minute caches: it bills as credits now.
export const spilled = (a: CacheAgent) => a.harness === 'claude' && a.ttl === '5m' && !a.paid

function Row({ label, help, children }: { label: ReactNode; help?: ReactNode; children: ReactNode }) {
  return <div className="set-row"><div className="set-label"><b>{label}</b>{help ? <p>{help}</p> : null}</div><div className="set-ctl">{children}</div></div>
}

const hico = (h: string) => <span className="hico" style={{ color: `var(--h-${h})` }}><Icon name={h} /></span>

function Harness({ f }: { f: CacheFacts }) {
  return (
    <div className="set-card cache-harness" data-cache-harness={f.harness}>
      <h4>{hico(f.harness)}{HARNESS[f.harness] ?? f.harness}</h4>
      <Row label="Cache window, subscription"><span>{f.ttl.subscription}</span></Row>
      <Row label="Cache window, credits or API key"><span>{f.ttl.credits}</span></Row>
      <Row label="Writing the cache" help="Of the uncached input price."><span>{f.write}</span></Row>
      <Row label="Reading the cache" help="Of the uncached input price."><span>{f.read}</span></Row>
      <Row label="Compacts on its own when idle" help={f.idleCompaction.note}><span>{f.idleCompaction.own ? 'Yes' : 'No'}</span></Row>
      <p className="cache-sources muted">Sources: {f.sources.map((s, i) => <span key={s.url}>{i ? ', ' : ''}<a href={s.url} target="_blank" rel="noreferrer">{s.label}</a></span>)}</p>
    </div>
  )
}

function Window({ a }: { a: CacheAgent }) {
  if (spilled(a)) return <span className="badge warn" title="A subscription account writing 5-minute caches bills as credits">5 minutes, credits</span>
  if (a.ttl === '5m') return <span className="badge">5 minutes</span>
  if (a.ttl === '1h') return <span className="badge">1 hour</span>
  return <span className="muted">Not measured yet</span>
}

export interface CacheAgentsReply { agents: CacheAgent[]; offline: string[]; outdated?: string[] }

function Agents({ agents, offline, outdated = [] }: CacheAgentsReply) {
  // Measured for Claude Code only: the other harnesses don't report their cache window.
  const rows = agents.filter((a) => a.harness === 'claude').sort((a, b) => Number(spilled(b)) - Number(spilled(a)) || a.name.localeCompare(b.name))
  return (
    <>
      {offline.length ? <p className="muted">Not reachable: {offline.join(', ')}.</p> : null}
      {outdated.length ? <p className="muted">{outdated.join(', ')} {outdated.length === 1 ? "doesn't" : "don't"} report cache windows yet: {outdated.length === 1 ? 'it runs' : 'they run'} an older mootr.</p> : null}
      {rows.length ? (
        <div className="cache-agents">
          <table className="data">
            <thead><tr><th>Agent</th><th>Cache window</th><th title="When the agent's cache window last changed">Since</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id} data-cache-agent={a.name}>
                <td><b>{a.name}</b> <span className="muted">{a.machine}{a.account ? ` · ${a.account}` : ''}</span></td>
                <td><Window a={a} /></td>
                <td className="muted">{a.ttl_at ? ago(a.ttl_at) : '–'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="muted">No Claude Code agents are running.</p>}
    </>
  )
}

function harnessControl(h: HarnessSetting, s: Obj, edit?: CacheEdit): ReactNode {
  if (!edit) return <span>{harnessValue(s, h)}</span>
  if (h.options) return edit.choice(h.path, h.options)
  return edit.num(h.path, { unit: 'tokens', min: h.tokens!.min, max: h.tokens!.max, nullable: true })
}

function HarnessSettings({ s, edit }: { s: Obj; edit?: CacheEdit }) {
  const harnesses = [...new Set(HARNESS_SETTINGS.map((h) => h.harness))]
  return (
    <>
      {harnesses.map((name) => (
        <div className="set-card cache-harness cache-pass" key={name} data-harness-settings={name}>
          <h4>{hico(name)}{HARNESS[name] ?? name}</h4>
          {HARNESS_SETTINGS.filter((h) => h.harness === name).map((h) => (
            <div key={h.path} data-harness-setting={h.path}><Row label={h.label} help={h.help}>{harnessControl(h, s, edit)}</Row></div>
          ))}
        </div>
      ))}
    </>
  )
}

export function CacheSettings({ s, edit }: { s: Obj; edit?: CacheEdit }) {
  const [data, setData] = useState<CacheAgentsReply | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api<CacheAgentsReply>('GET', '/api/cache/agents').then((d) => { if (live) setData(d) }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  const short = (data?.agents ?? []).filter(spilled)
  return (
    <>
      <p className="lede">A prompt cache makes a warm turn cheap: the conversation is read from the cache at a fraction of the price. Once the cache window passes, the next turn writes it all again. mootr's timers assume Claude Code's 1-hour window.</p>
      {short.length ? (
        <div className="set-note warn" role="alert" data-cache-spilled><Icon name="triangle-alert" size="xs" /><span><b>{short.length === 1 ? `${short[0].name} writes` : `${short.length} agents write`} 5-minute caches on a subscription.</b> The account has spilled into credits, so {short.length === 1 ? 'its' : 'their'} cache expires long before mootr's timers run.</span></div>
      ) : null}
      <h3>mootr's timers</h3>
      <div className="set-card" data-cache-timers>
        {cacheTimers(s).map((t) => <Row key={t.path} label={t.label} help={t.help}>{edit && t.on ? edit.num(t.path, { unit: 'minutes', min: 1, dflt: t.dflt }) : <span>{t.value}</span>}</Row>)}
      </div>
      <h3>Harness settings</h3>
      <div className="set-note" data-harness-next-launch><Icon name="rotate-ccw" size="xs" /><span>These apply at an agent's next launch: mootr writes them when it starts or restarts the harness, so a running agent keeps what it started with.</span></div>
      <HarnessSettings s={s} edit={edit} />
      <h3>Agents</h3>
      <p className="muted">The cache window each Claude Code agent's turns write, and since when.</p>
      {error ? <p className="muted">Couldn't read the agents: {error}</p> : data ? <Agents {...data} /> : <Loading className="muted" />}
      <h3>Per harness</h3>
      {CACHE_FACTS.map((f) => <Harness key={f.harness} f={f} />)}
    </>
  )
}
