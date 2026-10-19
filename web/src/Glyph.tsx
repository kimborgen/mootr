// An agent's mark: the harness icon in its hue inside a state ring. State owns colour, and a
// pip at the ring's corner gives the states that need telling apart a shape too, so colour is
// never the only signal: a dot for working, a hollow dot for waiting, ! for blocked, × for
// errored, bars for paused. Idle and starting have no pip; stopped agents fade to disabled.
import type { CSSProperties } from 'react'
import { HARNESS, STATE_COLOR, stateOf } from './format'
import { Icon } from './Icon'
import { icon } from './icons'
import type { Agent } from './types'
import { liveState, useLive } from './views/ownview-live'

// The pip's inner mark, drawn on an 8-unit grid so it stays crisp at the pip's size.
const PIP: Record<string, string> = {
  working: '',
  waiting: '',
  blocked: '<path d="M4 1.5v3.2"/><path d="M4 6.6v.01"/>',
  errored: '<path d="m2 2 4 4"/><path d="m6 2-4 4"/>',
  paused: '<path d="M2.8 2v4"/><path d="M5.2 2v4"/>',
}
const pipSvg = (s: string) => PIP[s] ? `<svg viewBox="0 0 8 8" aria-hidden="true">${PIP[s]}</svg>` : ''
const pipHtml = (s: string) => s in PIP ? `<span class="pip">${pipSvg(s)}</span>` : ''
const off = (s: string) => !(s in STATE_COLOR)

const style = (a: Agent, s: string) => ({ '--hc': off(s) ? 'var(--st-off)' : `var(--h-${a.harness}, var(--text-secondary))`, '--sc': `var(--st-${STATE_COLOR[s] ?? 'off'})` }) as CSSProperties

// While stam's own view of the agent is open, its live word on the turn wins (ownview-live.ts).
export function Glyph({ agent: a }: { agent: Agent }) {
  const s = liveState(stateOf(a), useLive(a.id))
  return <StateGlyph state={s} name={a.harness in HARNESS ? a.harness : 'bot'} style={style(a, s)} />
}

// A mark for a state alone, for the legend: the harness mark is a neutral bot.
export function StateGlyph({ state: s, name = 'bot', style: st }: { state: string; name?: string; style?: CSSProperties }) {
  return <span className={`glyph ${s}${off(s) ? ' off' : ''}`} data-state={s} style={st ?? { '--sc': `var(--st-${STATE_COLOR[s] ?? 'off'})` } as CSSProperties}>
    <Icon name={name} /><span className="ring" />{s in PIP ? <span className="pip" dangerouslySetInnerHTML={{ __html: pipSvg(s) }} /> : null}</span>
}

// The same mark as HTML, for mail components' agent mentions.
export function glyphHtml(a: Agent) {
  const s = stateOf(a)
  return `<span class="glyph ${s}${off(s) ? ' off' : ''}" style="--hc:${off(s) ? 'var(--st-off)' : `var(--h-${a.harness}, var(--text-secondary))`};--sc:var(--st-${STATE_COLOR[s] ?? 'off'})">${icon(a.harness in HARNESS ? a.harness : 'bot')}<span class="ring"></span>${pipHtml(s)}</span>`
}

export function PlainGlyph({ name }: { name: string }) {
  return <span className="glyph plain"><Icon name={name} size="xs" /></span>
}
