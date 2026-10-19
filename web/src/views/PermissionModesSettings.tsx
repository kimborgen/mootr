// Settings › Permission modes (S-1967): the mode new agents start in, per harness and per agent
// type, and the running agents that follow the settings but still run another mode, which Apply
// switches. A harness offers only the modes its daemon lists (`offered`). Each change saves at
// once through the page's settings save; the list refetches after each save (`rev`).
import { useEffect, useState } from 'react'
import { api } from '../api'
import { HARNESS } from '../format'
import { Icon } from '../Icon'
import { BYPASS_WARNING, modeLabel, offeredModes, type ApplyReply, type PermissionModes, type StaleAgent } from '../permission-modes'
import { toast } from '../ui/menu'
import { Row, hico } from './TypesSettings'

type Setting = { harness?: Record<string, string>; types?: Record<string, string> }

export function PermissionModesSettings({ value, types, harnesses, set, rev, readOnly = false, why }: {
  value: Setting | undefined
  // The agent types and the harness each one runs in; a ring has none and is left out.
  types: Record<string, { harness: string }>
  harnesses: string[]
  set: (next: { harness: Record<string, string>; types: Record<string, string> }) => void
  rev: number
  readOnly?: boolean; why?: string
}) {
  const [info, setInfo] = useState<PermissionModes | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApplyReply | null>(null)
  useEffect(() => {
    let live = true
    api<PermissionModes>('GET', '/api/permission-modes').then((r) => { if (live) { setInfo(r); setError('') } }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [rev])

  if (!info) return error ? <p className="sp-error" role="alert">{error}</p> : <p className="muted">Loading…</p>

  const cur = { harness: { ...(value?.harness ?? info.settings.harness) }, types: { ...(value?.types ?? info.settings.types) } }
  const harnessMode = (h: string) => cur.harness[h] ?? 'auto'
  const typeMode = (t: string) => cur.types[t] ?? 'inherit'

  // A pick of bypass asks first: it turns off every check for the agents it reaches.
  const pick = (apply: (next: typeof cur) => void, mode: string, who: string) => {
    if (mode === 'bypass' && !confirm(`${who}: ${BYPASS_WARNING} New agents start that way, and Apply switches the running ones. Use bypass?`)) return false
    apply(cur)
    set(cur)
    return true
  }
  const bypassed = [
    ...harnesses.filter((h) => harnessMode(h) === 'bypass').map((h) => `${HARNESS[h] ?? h} agents`),
    ...Object.keys(types).filter((t) => typeMode(t) === 'bypass').map((t) => `${t} agents`),
  ]
  const wording = (h: string, mode: string) => info.harnesses[h]?.find((m) => m.mode === mode)?.harness

  async function run() {
    setBusy(true)
    try {
      const r = await api<ApplyReply>('POST', '/api/permission-modes/apply')
      setResult(r)
      setInfo((i) => (i ? { ...i, stale: r.stale } : i))
    } catch (e) {
      toast((e as Error).message, true)
      setError((e as Error).message)
    }
    setBusy(false)
  }

  const stale = info.stale
  const flow = (s: StaleAgent) => `${modeLabel(s.mode)} → ${modeLabel(s.want)}`

  return (
    <>
      <p className="lede">The mode a new agent starts in. A harness sets the default, and an agent type can override it. An agent you switched yourself keeps its own mode. A running agent that follows these settings is listed under Running agents until you apply the change.</p>
      {bypassed.length ? (
        <div className="set-note warn" role="alert" data-bypass-warning><Icon name="triangle-alert" size="xs" /><span><b>Bypass is on for {bypassed.join(', ')}.</b> {BYPASS_WARNING} Choose Auto to keep stam's checks.</span></div>
      ) : null}
      <h3>Harnesses</h3>
      <div className="set-card" data-section="harnesses">
        {harnesses.map((h) => {
          const mode = harnessMode(h)
          const opts = offeredModes(info.harnesses[h], mode)
          return (
            <Row key={h} label={<>{hico(h)}{HARNESS[h] ?? h}</>} help={wording(h, mode) ? <>Runs with <code>{wording(h, mode)}</code>.</> : undefined}>
              <select aria-label={`${HARNESS[h] ?? h} permission mode`} data-harness={h} value={mode} disabled={readOnly} title={readOnly ? why : undefined}
                onChange={(e) => { const to = e.target.value; if (!pick((n) => { n.harness[h] = to }, to, HARNESS[h] ?? h)) e.target.value = mode }}>
                {opts.map((m) => <option key={m.mode} value={m.mode} disabled={!m.pickable}>{m.label}{m.pickable ? '' : ' (not offered)'}</option>)}
              </select>
            </Row>
          )
        })}
      </div>
      <h3>Agent types</h3>
      <div className="set-card" data-section="types">
        {Object.entries(types).map(([t, def]) => {
          const mode = typeMode(t)
          const opts = offeredModes(info.harnesses[def.harness], mode)
          return (
            <Row key={t} label={<>{hico(def.harness)}{t}</>} help={mode === 'inherit' ? <>Follows {HARNESS[def.harness] ?? def.harness}: {modeLabel(harnessMode(def.harness))}.</> : undefined}>
              <select aria-label={`${t} permission mode`} data-type={t} value={mode} disabled={readOnly} title={readOnly ? why : undefined}
                onChange={(e) => { const to = e.target.value; if (!pick((n) => { n.types[t] = to }, to, `The ${t} type`)) e.target.value = mode }}>
                <option value="inherit">Follow the harness</option>
                {opts.map((m) => <option key={m.mode} value={m.mode} disabled={!m.pickable}>{m.label}{m.pickable ? '' : ' (not offered)'}</option>)}
              </select>
            </Row>
          )
        })}
        {Object.keys(types).length ? null : <p className="muted">No agent types.</p>}
      </div>
      <h3>Running agents</h3>
      <div className="set-card perm-stale" data-section="stale">
        {stale.length ? (
          <>
            <p className="muted">These agents follow the settings and run another mode. Apply switches each one in place after its current step, keeping its session.</p>
            <ul>
              {stale.map((s) => (
                <li key={s.id} data-agent={s.name}>
                  <span className="perm-who">{hico(s.harness)}<b>{s.name}</b><span className="muted">{HARNESS[s.harness] ?? s.harness}</span></span>
                  <span className="perm-flow">{flow(s)}</span>
                  {!s.inPlace ? <span className="muted perm-note">{HARNESS[s.harness] ?? s.harness} keeps a session's rules: it takes {modeLabel(s.want)} in its next new session, so Apply skips it.</span> : null}
                  {s.failed ? <span className="perm-note perm-failed">Its last switch failed: {s.failed}. Apply tries again.</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : <p className="muted">Every agent that follows the settings runs the mode they give.</p>}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || readOnly || !stale.length} title={readOnly ? why : undefined} onClick={() => void run()}>{busy ? 'Applying…' : stale.length ? `Apply to ${stale.length} agent${stale.length === 1 ? '' : 's'}` : 'Apply'}</button>
        </div>
        {result ? (
          <div className="perm-result" role="status" data-apply-result>
            <p><b>{result.applied.length ? `Switched ${result.applied.length} agent${result.applied.length === 1 ? '' : 's'}` : 'Switched no agents'}</b>{result.skipped.length ? `, skipped ${result.skipped.length}` : ''}.</p>
            {result.applied.length ? <ul className="perm-applied">{result.applied.map((a) => <li key={a.name}><b>{a.name}</b> <span className="muted">→ {modeLabel(a.mode)}</span></li>)}</ul> : null}
            {result.skipped.length ? <ul className="perm-skipped">{result.skipped.map((a) => <li key={a.name}><b>{a.name}</b> <span className="muted">{a.reason}</span></li>)}</ul> : null}
          </div>
        ) : null}
      </div>
      {error ? <p className="sp-error" role="alert">{error}</p> : null}
    </>
  )
}
