// What the system view shows, from the store's data (S-458): the tree's nodes, each card's ITSA
// and Work column badges, and the header's counts. Pure, so it tests without a browser.
import { STATE_COLOR, stateOf, treeAgents } from '../format'
import type { Field } from '../itsa/fields'
import { cardFields } from '../work/field-columns'
import { linkKind, reviewOf, testsOf } from '../work/links'
import type { Agent, Itsa, ItsaStatus } from '../types'
import type { TreeIn } from './layout'

// The human's card, at the top of the tree.
export const HUMAN = 'human'

// The tree's nodes: the human, then every agent the sidebar's tree shows, under its first parent
// that is shown (the human for a root). Chiefs of staff lead the roots; the rest keep the order
// they were made in, so a new agent joins at the end of its siblings. Each carries its own spend in
// API dollars, as the panel shows it, for the Stars mode's orbs.
export function systemNodes(agents: Agent[]): TreeIn[] {
  const shown = treeAgents(agents)
  const ids = new Set(shown.map((a) => a.id))
  const order = [...shown].sort((x, y) => (Number(y.chief_of_staff ?? 0) - Number(x.chief_of_staff ?? 0)) || x.created_at.localeCompare(y.created_at))
  return [{ id: HUMAN, parent: null }, ...order.map((a) => ({ id: a.id, parent: (a.parents ?? []).find((p) => ids.has(p)) ?? HUMAN, cost: a.cost?.own.api ?? a.cost_usd ?? 0 }))]
}

// The ITSA a card shows: of the open ones the agent owns, the one waiting on the human first,
// as the sidebar's tree picks it (Tree.tsx), with how many it owns.
// One just done (`recent`, S-463) stays first a moment, so its card stamps it done and sends
// it up the wire before the card moves on.
export function ownedItsa(id: string, itsas: Itsa[], category: (s: string) => string, human: (s: string) => boolean, recent: ReadonlySet<string> = new Set()): { it: Itsa; count: number } | null {
  const owns = itsas.filter((x) => x.owner === id && category(x.status) !== 'closed')
  const kept = itsas.find((x) => x.owner === id && recent.has(x.id) && category(x.status) === 'closed')
  const it = kept ?? owns.find((x) => human(x.status)) ?? owns[0]
  return it ? { it, count: owns.length + (kept ? 1 : 0) } : null
}

// The ITSAs whose status changed between two lists, each with its owner: what the cards stamp,
// and with `done`, what travels up the wire. An ITSA new to the list hasn't moved.
export interface Move { id: string; owner: string | null; parent: string | null; from: string; to: string; done: boolean }
export function statusMoves(prev: readonly Itsa[], next: readonly Itsa[], done: string): Move[] {
  const was = new Map(prev.map((x) => [x.id, x.status]))
  const out: Move[] = []
  for (const x of next) {
    const from = was.get(x.id)
    if (from !== undefined && from !== x.status) out.push({ id: x.id, owner: x.owner, parent: x.parent_id, from, to: x.status, done: x.status === done })
  }
  return out
}

// An ITSA's roll-up on its card: of its children, how many are done, leaving out those whose
// done sheet is still on its way here (`flying`, by child id), so the count advances when each
// sheet lands. Only a child still done and still under this ITSA is left out.
export function rollupOf(it: Pick<Itsa, 'id'>, itsas: readonly Itsa[], done: string, flying: ReadonlySet<string> = new Set()): { done: number; total: number } | null {
  const kids = itsas.filter((x) => x.parent_id === it.id)
  if (!kids.length) return null
  return { done: kids.filter((x) => x.status === done && !flying.has(x.id)).length, total: kids.length }
}

// A badge's tone, as the `.badge` classes draw it.
export type Tone = 'ok' | 'warn' | 'err' | 'progress' | ''
const toneOf = (cssVar?: string): Tone => (!cssVar ? '' : cssVar.includes('success') ? 'ok' : cssVar.includes('warning') ? 'warn' : cssVar.includes('error') ? 'err' : '')
export type Badge =
  | { kind: 'word'; id: string; word: string; tone: Tone; title: string }
  | { kind: 'field'; id: string; f: Field; v: unknown }

// The Work columns a card shows as badges, in the Work layout's order (`cols`, the column ids
// the human shows): health when it isn't on track, the branch's review and tests, and each field
// whose `card` setting is chip and that has a value. The other columns are the side panel's.
// With `anyField`, a field shows whatever its `card` setting, as the sidebar's picked columns do.
export function cardBadges(it: Itsa, cols: string[], fields: Field[], anyField = false): Badge[] {
  const branch = it.links?.find((l) => linkKind(l) === 'branch')
  const { chips, meta } = cardFields(it, fields)
  if (anyField) chips.push(...meta)
  const out: Badge[] = []
  for (const id of cols) {
    if (id === 'health' && it.health && it.health !== 'on_track') {
      const word = it.health.replace('_', ' ')
      out.push({ kind: 'word', id, word, tone: it.health === 'off_track' ? 'err' : 'warn', title: `Health: ${word}` })
    } else if (id === 'review') {
      const r = reviewOf(branch?.meta)
      if (r) out.push({ kind: 'word', id, word: r.word, tone: toneOf(r.tone), title: `Review: ${r.word}` })
    } else if (id === 'tests') {
      const t = testsOf(branch?.meta)
      if (t) out.push({ kind: 'word', id, word: t.word, tone: toneOf(t.tone), title: `Tests: ${t.word}` })
    } else if (id.startsWith('field:')) {
      const c = chips.find((x) => 'field:' + x.f.id === id)
      if (c) out.push({ kind: 'field', id, f: c.f, v: c.v })
    }
  }
  return out
}

// The agent states the header counts, in the legend's order, each with how many live agents are in it.
export const STATES = ['working', 'idle', 'blocked', 'errored', 'paused', 'resting'] as const
export function stateCounts(agents: Agent[]): { total: number; by: Record<string, number> } {
  const by: Record<string, number> = {}
  let total = 0
  for (const a of agents) {
    if (a.lifecycle !== 'active' && a.lifecycle !== 'paused') continue
    total++
    const s = STATE_COLOR[stateOf(a)] ?? 'paused'
    by[s] = (by[s] ?? 0) + 1
  }
  return { total, by }
}
// A subtree's states for a folded card's chip: one entry per state present, in STATES order.
export function statesOf(list: Agent[]): { state: string; n: number }[] {
  const { by } = stateCounts(list)
  return STATES.filter((s) => by[s]).map((s) => ({ state: s, n: by[s] }))
}

// The header's ITSA counts: active and in review now, and done since local midnight. Done is the
// closed category's first status, as the status tones read it.
export function itsaCounts(itsas: Itsa[], statuses: ItsaStatus[], now = new Date()): { active: number; review: number; doneToday: number } {
  const cat = new Map(statuses.map((s) => [s.name, s.category]))
  const done = statuses.find((s) => s.category === 'closed')?.name ?? 'done'
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  let active = 0, review = 0, doneToday = 0
  for (const it of itsas) {
    const c = cat.get(it.status)
    if (c === 'active') active++
    else if (c === 'review') review++
    else if (it.status === done && it.closed_at && new Date(it.closed_at).getTime() >= midnight) doneToday++
  }
  return { active, review, doneToday }
}

// How full an agent's context is, 0 to 1, against the tokens that force a compaction (the sidebar's bar).
export const contextShare = (a: Pick<Agent, 'context_tokens'>, enforceTokens: number) => Math.max(0, Math.min(1, (a.context_tokens ?? 0) / Math.max(1, enforceTokens)))
