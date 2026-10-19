// What finished issues cost (S-1012): closed work issues grouped by model, by agent type, or by both
// (the summary's configs). Each row: the name (a model with its harness mark), the issues, the cost as
// a range mark (a dot at the median, a tick at p75, scaled to the largest p75 shown) with the median
// in the page's Measure, then the working, lead time and review medians. At a phone width lead time
// and reviews move to a muted line under the name.
import { useState } from 'react'
import { measureText } from '../measure'
import { harnessColor, harnessLabel } from '../shared'
import type { UsageMeasure } from '../state'
import type { ActConfig, ActSummary } from '../types'
import { configParts, hours, leadText, rangeMark, spreadIn } from './format'

type By = 'model' | 'type' | 'both'
const BY: { id: By; label: string; head: string }[] = [
  { id: 'model', label: 'Model', head: 'Model' }, { id: 'type', label: 'Type', head: 'Type' }, { id: 'both', label: 'Both', head: 'Model · type' },
]
const rounds = (v: number | null) => (v == null ? '—' : String(Math.round(v * 10) / 10))

function Name({ r, by }: { r: ActConfig; by: By }) {
  if (by === 'type') return <>{r.type ?? 'unknown'}</>
  const { harness, model } = configParts(r.model)
  return (
    <>
      <i className="hdot" style={{ background: harnessColor(harness) }} title={harnessLabel(harness)} />{model}
      {by === 'both' ? <span className="muted"> · {r.type ?? 'unknown'}</span> : null}
    </>
  )
}

export function ConfigCosts({ configs, measure }: { configs: ActSummary['configs']; measure: UsageMeasure }) {
  const [by, setBy] = useState<By>('model')
  const rows = (by === 'model' ? configs?.by_model : by === 'type' ? configs?.by_type : configs?.by_model_type) ?? []
  const max = Math.max(0, ...rows.map((r) => { const s = spreadIn(r, measure); return s.p75 ?? s.median ?? 0 }))
  return (
    <section className="ax-card ax-configs">
      <div className="ax-head">
        <h3>What finished issues cost</h3>
        <div className="seg" role="group" aria-label="Group by">
          {BY.map((x) => <button key={x.id} type="button" className={by === x.id ? 'on' : ''} aria-pressed={by === x.id} onClick={() => setBy(x.id)}>{x.label}</button>)}
        </div>
      </div>
      <p className="muted ax-note">Work issues closed in the period · dot is the median, tick the 75th percentile</p>
      {!rows.length ? <p className="muted ax-none">No closed work issues in this window yet</p> : (
        <table className="data ax-cfg">
          <thead>
            <tr>
              <th>{BY.find((x) => x.id === by)!.head}</th><th className="num">Issues</th><th className="ax-cost-h">Cost</th>
              <th className="num">Working</th><th className="num wide">Lead time</th><th className="num wide">Reviews</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = spreadIn(r, measure)
              const mark = rangeMark(s, max)
              return (
                <tr key={`${r.model ?? ''}|${r.type ?? ''}`}>
                  <td className="ax-cfg-name">
                    <Name r={r} by={by} />
                    <div className="muted phone-only">Lead {leadText(r.lead_s.median)} · Reviews {rounds(r.review_rounds.median)}</div>
                  </td>
                  <td className="num">{r.n}</td>
                  <td className="ax-cost">
                    <span className="ax-range" aria-hidden>
                      {mark ? <><i className="ln" style={{ left: `${mark.dot}%`, width: `${mark.tick - mark.dot}%` }} /><i className="tk" style={{ left: `${mark.tick}%` }} /><i className="dt" style={{ left: `${mark.dot}%` }} /></> : null}
                    </span>
                    <span className="v" title={s.p75 != null ? `median ${measureText(s.median, measure)}, p75 ${measureText(s.p75, measure)}` : undefined}>{measureText(s.median, measure)}</span>
                  </td>
                  <td className="num">{hours(r.working_s.median)}</td>
                  <td className="num wide">{leadText(r.lead_s.median)}</td>
                  <td className="num wide">{rounds(r.review_rounds.median)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
