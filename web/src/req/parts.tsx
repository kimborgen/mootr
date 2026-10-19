// The pieces the requirement views share: the state glyph (its shape is the state, its colour the
// tone, so tone is never the only channel), the roll-up bar, the probability bar, and opening a
// requirement's world.
import { useSyncExternalStore, type CSSProperties } from 'react'
import * as shell from '../shell/layout'
import { rollupText, rollupTotal, STATE_WORD, STATES, STATUS_WORD, type ReqRollup, type ReqState, type ReqStatus } from './model'

export const reqWorld = (key: string) => 'w:req:' + key
export const openReq = (key: string) => shell.showAgentWorld(reqWorld(key))
export const openedReq = () => { const cw = shell.currentWorld(); return cw?.startsWith('w:req:') ? cw.slice(6) : null }

// Opening a requirement at one verdict (a matrix cell): the world loads with that verdict in its
// list, scrolls to it, and marks it once. The ask waits here until the world takes it.
let focus: { key: string; verdict: number } | null = null
const fls = new Set<() => void>()
export function openReqAt(key: string, verdict: number) {
  focus = { key, verdict }
  for (const fn of fls) fn()
  openReq(key)
}
export const useReqFocus = () => useSyncExternalStore((fn) => { fls.add(fn); return () => { fls.delete(fn) } }, () => focus)
export const takeReqFocus = (key: string) => { if (focus?.key !== key) return null; const f = focus; focus = null; return f.verdict }
export const peekReqFocus = (key: string) => (focus?.key === key ? focus.verdict : null)

// A ring with a tick (likely conforms), a bar and dot (likely violates), a question's dot
// (unsure), or a dashed ring (unverified). A draft or a suspended or obsolete requirement is
// drawn muted: it isn't checked as in force.
// A waived verdict keeps its shape, muted, with a stroke through it.
export function ReqGlyph({ state, status, title, waived }: { state: ReqState; status?: ReqStatus; title?: string; waived?: boolean }) {
  const live = (!status || status === 'in_force') && !waived
  const label = title ?? `${STATE_WORD[state]}${status && status !== 'in_force' ? ` · ${STATUS_WORD[status]}` : ''}${waived ? ' · waived' : ''}`
  return (
    <svg className={`rglyph ${state}${live ? '' : ' off'}`} viewBox="0 0 14 14" width="14" height="14" style={{ '--tc': live ? `var(--rq-${state})` : 'var(--text-muted)' } as CSSProperties} role="img" aria-label={label}>
      {waived ? <path d="M2.5 11.5 11.5 2.5" stroke="var(--tc)" strokeWidth="1.5" strokeLinecap="round" /> : null}
      <title>{label}</title>
      <circle cx="7" cy="7" r="5.75" fill="none" stroke="var(--tc)" strokeWidth="1.5" strokeDasharray={state === 'unverified' ? '2.2 2.3' : undefined} />
      {state === 'conforms' ? <path d="M4.6 7.2 6.3 8.9 9.5 5.4" fill="none" stroke="var(--tc)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {state === 'violates' ? <><path d="M7 4v3.6" stroke="var(--tc)" strokeWidth="1.5" strokeLinecap="round" /><circle cx="7" cy="9.9" r="0.9" fill="var(--tc)" /></> : null}
      {state === 'unsure' ? <circle cx="7" cy="7" r="1.6" fill="var(--tc)" /> : null}
    </svg>
  )
}

// Conforms, likely violates, unsure, and unverified, in that order; the title spells it out.
export function ReqRollupBar({ r, wide }: { r: ReqRollup; wide?: boolean }) {
  const total = rollupTotal(r)
  if (!total) return null
  return (
    <span className={'rollup rq' + (wide ? ' wide' : '')} title={rollupText(r)} aria-label={rollupText(r)} role="img">
      {STATES.map((s) => r[s] ? <i key={s} className={s} style={{ width: `${(r[s] / total) * 100}%` }} /> : null)}
    </span>
  )
}

// P(violates) as a bar with its number: the threshold is a tick on the track.
export function ProbBar({ p, threshold }: { p: number | null | undefined; threshold?: number }) {
  if (p == null) return <span className="pbar empty" aria-hidden="true" />
  const tone = threshold != null && p >= threshold ? 'violates' : p >= 0.5 ? 'unsure' : 'conforms'
  return (
    <span className="pbar" role="img" aria-label={`P(violates) ${Math.round(p * 100)}%`} title={`P(violates) ${Math.round(p * 100)}%${threshold != null ? `, acts at ${Math.round(threshold * 100)}%` : ''}`}>
      <span className="pbar-track"><i className={tone} style={{ width: `${p * 100}%` }} />{threshold != null ? <b style={{ left: `${threshold * 100}%` }} /> : null}</span>
      <span className="pbar-n">{Math.round(p * 100)}%</span>
    </span>
  )
}
