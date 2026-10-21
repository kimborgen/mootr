// Settings › Chief of staff: who the chief of staff is and its state, start and stop through
// /api/cos/*, the harness, model and effort of the `cos` agent type (saved through /api/types/cos,
// like Agent types), and a link to its instructions. A running agent can't switch harness or
// model, so a change applies to the next one started.
import { useState } from 'react'
import { api } from '../api'
import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { HARNESS, model, stateLabel } from '../format'
import { toast } from '../ui/menu'
import type { Agent } from '../types'
import { ModelPicker } from './ModelPicker'
import { Row, Seg, hico, type AgentType } from './TypesSettings'
import { typePayload } from './type-form'

interface Registry {
  harnesses: Record<string, { efforts?: string[] }>
  models: Record<string, { harnesses?: string[] }>
}
type Write = (method: string, path: string, body?: unknown) => Promise<unknown>

export function CosSettings({ cos, type, reg, write = api, readOnly = false, why, onChanged, openInstructions }: {
  cos?: Agent | null; type?: AgentType; reg: Registry; write?: Write; readOnly?: boolean; why?: string; onChanged: () => Promise<void>; openInstructions: () => void
}) {
  const [busy, setBusy] = useState(false)
  const t: AgentType = type ?? { harness: 'claude', model: null, effort: null, description: '' }
  const title = readOnly ? why : undefined
  const efforts = reg.harnesses[t.harness]?.efforts ?? []
  const live = !!cos && (cos.lifecycle === 'active' || cos.lifecycle === 'paused')
  const differs = !!cos && live && (cos.harness !== t.harness || (cos.model ?? null) !== (t.model ?? null) || (cos.effort ?? null) !== (t.effort ?? null))

  async function run(kind: 'start' | 'stop') {
    if (kind === 'stop' && !confirm(`Shut down ${cos?.name}? Mail to the chief of staff waits until one starts again.`)) return
    setBusy(true)
    try { await api('POST', `/api/cos/${kind}`); toast(kind === 'start' ? 'The chief of staff is starting.' : 'The chief of staff is shutting down.') } catch (e) { toast((e as Error).message, true) }
    await onChanged()
    setBusy(false)
  }
  async function save(patch: Partial<AgentType>) {
    try { await write('POST', '/api/types/cos', typePayload({ ...t, ...patch }, false)); toast('Saved the cos type') } catch (e) { toast((e as Error).message, true) }
    await onChanged()
  }
  const pickHarness = (h: string) => {
    const ok = Object.entries(reg.models).filter(([, m]) => !m.harnesses || m.harnesses.includes(h)).map(([id]) => id)
    void save({ harness: h, model: t.model && ok.includes(t.model) ? t.model : ok[0] ?? null, effort: t.effort && (reg.harnesses[h]?.efforts ?? []).includes(t.effort) ? t.effort : null })
  }
  const fs = (children: React.ReactNode) => readOnly ? <fieldset className="ro" disabled title={title}>{children}</fieldset> : <>{children}</>

  return (
    <>
      <p className="lede">The chief of staff schedules and manages the other agents. At most one runs. It starts from the <code>cos</code> agent type, so its harness, model and effort are set here.</p>
      <div className="set-card status-card" data-cos={cos?.name ?? ''}>
        {cos ? (
          <><Glyph agent={cos} /><div><b>{cos.name}</b><div className="muted">{stateLabel(cos)} · {model(cos).label}{cos.effort ? ' · ' + cos.effort : ''}</div></div></>
        ) : (
          <><span className="glyph plain"><Icon name="crown" size="xs" /></span><div><b>No chief of staff</b><div className="muted">Start one to have agents scheduled and managed.</div></div></>
        )}
        <span className="spacer" />
        {live ? <button className="btn" id="cos-stop" disabled={busy || readOnly} title={title} onClick={() => void run('stop')}><Icon name="square" />Stop</button> : null}
        {!live ? <button className="btn primary" id="cos-start" disabled={busy || readOnly} title={title} onClick={() => void run('start')}><Icon name="play" />Start</button> : null}
      </div>
      {differs ? <div className="set-note"><Icon name="info" size="xs" /><span>{cos!.name} runs {model(cos!).label}{cos!.effort ? ' · ' + cos!.effort : ''}. These settings apply to the next chief of staff you start.</span></div> : null}
      {fs(
        <div className="set-card">
          <Row label="Harness" help="The coding agent program it runs in.">
            <Seg value={t.harness} opts={Object.keys(reg.harnesses).map((h) => ({ v: h, html: <>{hico(h)}{HARNESS[h] ?? h}</> }))} onPick={pickHarness} />
          </Row>
          <Row label="Model"><ModelPicker kind="harness" harness={t.harness} value={t.model ?? ''} label="Model" onChange={(id) => void save({ model: id || null })} /></Row>
          <Row label="Effort" help="How hard the model thinks before it answers.">
            {efforts.length ? <Seg value={t.effort ?? null} opts={[{ v: null, label: 'Default' }, ...efforts.map((e) => ({ v: e as string | null, label: e }))]} onPick={(e) => void save({ effort: e })} /> : <span className="muted">This harness has no effort setting.</span>}
          </Row>
        </div>,
      )}
      <div className="set-card">
        <Row label="Instructions" help="What the chief of staff is told on top of the base prompt. Edit them with the other instructions.">
          <button type="button" className="btn" id="cos-instructions" onClick={openInstructions}><Icon name="file-text" />Edit instructions</button>
        </Row>
      </div>
    </>
  )
}
