// Small formatters and the agent vocabulary the tree, tabs, and mail share.
import type { Agent, AgentCost, CostMode, CostModes } from './types'

export const k = (n: number | null | undefined) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1000) + 'k' : String(Math.round(n)))
export const money = (v: number) => (v >= 10 ? '$' + v.toFixed(0) : v >= 1 ? '$' + v.toFixed(2) : v > 0 ? '$' + v.toFixed(3) : '$0')
export const ago = (t: string | number | Date) => {
  const s = (Date.now() - new Date(t).getTime()) / 1000
  return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'
}
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// The sidebar's two cost numbers per agent (S-318): its own cost and its tree's, in the unit the
// user chose. Dollars for api and subscription, percent of a window for five_hour and seven_day;
// real paid spend is in the tooltip. The daemon sums the tree; the browser only formats.
const COST_PCT = (m: CostMode) => m === 'five_hour' || m === 'seven_day'
const COST_NAME: Record<CostMode, string> = { api: 'API-equivalent', subscription: 'subscription', five_hour: 'of the 5h window', seven_day: 'of the 7d window' }
export function costShort(v: number | null | undefined, m: CostMode): string {
  if (v == null) return '–'
  if (COST_PCT(m)) return v > 0 && v < 1 ? '<1%' : Math.round(v) + '%'
  if (v === 0) return '$0'
  if (v < 0.1) return '<$0.1'
  return v >= 9.95 ? '$' + Math.round(v) : '$' + v.toFixed(1)
}
// The row's number. Real paid spend stays out of it (it's in costTitle): the sidebar's row is
// too narrow for it beside the model code on the desktop.
export function costCell(c: CostModes, m: CostMode): string {
  return costShort(c[m], m)
}
export function costTitle(c: AgentCost, parent: boolean): string {
  const part = (x: CostModes) => {
    const v = x[c.mode]
    const main = v == null ? 'not known yet' : COST_PCT(c.mode) ? (v > 0 && v < 1 ? '<1%' : Math.round(v) + '%') + ' ' + COST_NAME[c.mode] : '$' + v.toFixed(2) + ' ' + COST_NAME[c.mode]
    return x.paid_usd > 0 ? main + ' + $' + x.paid_usd.toFixed(2) + ' paid' : main
  }
  return parent ? `own: ${part(c.own)} · tree: ${part(c.tree)}` : `own: ${part(c.own)}`
}

export const live = (a: Agent) => a.lifecycle === 'active' || a.lifecycle === 'paused'
// The agents the sidebar's tree shows: the live ones, a shut-down agent that still has non-archived
// children (kept, dimmed, so they nest under it), and those children. Nothing else is in the tree.
export function treeAgents(agents: Agent[]): Agent[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const dimmed = (a: Agent) => a.lifecycle === 'shut_down' && agents.some((c) => c.lifecycle !== 'archived' && (c.parents ?? []).includes(a.id))
  return agents.filter((a) => live(a) || dimmed(a) || (a.lifecycle !== 'archived' && (a.parents ?? []).some((p) => { const parent = byId.get(p); return !!parent && dimmed(parent) })))
}
export const stateOf = (a: Agent) => (a.lifecycle === 'active' ? a.activity ?? 'idle' : a.lifecycle)
export const STATE_COLOR: Record<string, string> = { working: 'working', starting: 'working', idle: 'idle', waiting: 'idle', blocked: 'blocked', errored: 'errored', paused: 'paused' }
export const STATE_LABEL: Record<string, string> = { shut_down: 'shut down', archived: 'archived' }
export const stateLabel = (a: Agent) => STATE_LABEL[stateOf(a)] ?? stateOf(a)
export const HARNESS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

export function model(a: { model?: string | null; harness?: string }): { label: string; color: string } {
  const m = a.model ?? ''
  const c = m.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/)
  if (c) return { label: `${c[1]} ${c[2]}.${c[3]}`, color: `var(--m-${c[1]})` }
  const f = m.match(/claude-fable-(\d+)-(\d+)/)
  if (f) return { label: `fable ${f[1]}.${f[2]}`, color: 'var(--m-other)' }
  const g = m.match(/gpt-?([\d.]+)-?(\w+)?/)
  if (g) return { label: `gpt ${g[1]}${g[2] ? ' ' + g[2] : ''}`, color: 'var(--m-gpt)' }
  if (/deepseek/.test(m)) return { label: 'deepseek' + (/flash/.test(m) ? ' flash' : ''), color: 'var(--m-other)' }
  if (!m) return { label: 'default', color: 'var(--m-other)' }
  return { label: m.split('/').pop()!.slice(0, 16), color: 'var(--m-other)' }
}

// A model's short code for the sidebar: the model letter where the family has several (O Opus,
// S Sonnet, H Haiku, F Fable), then the version, then a variant letter (S sol, F flash, A astra,
// L luna). Claude and Codex (GPT) models drop the family letter, because the harness icon next
// to the code already tells them apart; OpenCode (DeepSeek and other providers) keeps its
// family letter, since its model list is too large for the icon alone. So claude-opus-5-5 is
// O5.5, gpt-6.1-sol 6.1S, and deepseek-v4.1-flash D4.1F. The tree draws every code in one
// fixed-width slot (style.css, .chip.mcode), so the column lines up; a model stam doesn't know
// gets a code built by the same rule from its own id.
const FAMILY_CODE: [RegExp, string][] = [[/^claude\b/, 'C'], [/^gpt\b/, 'G'], [/^deepseek\b/, 'D']]
const MODEL_CODE: Record<string, string> = { opus: 'O', sonnet: 'S', haiku: 'H', fable: 'F' }
const VARIANT_CODE: Record<string, string> = { sol: 'S', flash: 'F', astra: 'A', luna: 'L' }

export function modelCode(m: string | null | undefined): string {
  // The last path part, because the registry's ids carry an `openrouter/vendor/` prefix.
  const id = String(m ?? '').split('/').pop()!.trim().toLowerCase().replace(/^~/, '')
  if (!id) return '–'
  const family = FAMILY_CODE.find(([re]) => re.test(id))?.[1] ?? id.match(/[a-z]/)?.[0]?.toUpperCase() ?? ''
  // Claude names the model before the version and splits it `-5-5`; the others carry one
  // dotted version after the family and a variant word (sol, flash, …) after that.
  const c = id.match(/^claude[-.]([a-z]+)[-.](\d+)(?:[-.](\d+))?/)
  if (c) return (MODEL_CODE[c[1]] ?? '') + c[2] + (c[3] ? '.' + c[3] : '')
  const version = id.match(/\d+(?:\.\d+)*/)?.[0] ?? ''
  const variant = Object.keys(VARIANT_CODE).find((w) => new RegExp(`(?:^|[-.])${w}(?:$|[-.])`).test(id))
  const code = version + (variant ? VARIANT_CODE[variant] : '')
  return family === 'G' ? code : family + code
}

export const baseSubject = (s: string | null | undefined) => String(s ?? '').replace(/^(re:\s*)+/i, '')
export const plainSubject = (s: string | null | undefined) => baseSubject(s).replace(/`/g, '')
// A thread's title for the mail list: the newest message's 1-3 word title (S-297), or null.
export const threadTitle = (mails: { title?: string | null }[]) => mails.findLast((m) => m.title)?.title ?? null

// A file size as bytes, KB, MB or GB.
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}
